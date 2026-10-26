import { constants, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { cp } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// 搬家时拷什么、怎么拷。只认 OrangeSpeakEasy 自己的东西（照 storage/paths.mjs 的摆法算出来的那几样，加上每家的 key）：
//   move       要搬的：程序、你的设置和数据、模型、日志、缓存
//   leftovers  我们的、但不搬的：run/（进程号、锁、套接字，都是运行时的）、更新和安装被打断留下的半截，
//              还有系统在文件夹里自己放的（访达的 .DS_Store 这些）。搬完跟旧目录一起删
//   unknown    不认识的（0.11.0 时 ORANGESPEAKEASY_HOME 可能指到了一个本来就有别的东西的目录）：不搬，也不删，搬完说出来
// 拷的时候符号链接原样拷（Electron 框架里是相对链接；Node 默认会改写成指向旧目录的绝对路径，旧目录一删程序就起不来），
// APFS 上用克隆（不多占空间），修改时间原样；目标已经有同名的就报错，不覆盖。
// 拷是异步的（App 里的进度窗口要能一边拷一边更新），一个文件一个文件地报进度。

/** 更新、安装被打断留下的半截（update/home.mjs 的 .update-、install.sh 的 .install.、换下来的 app.old 这些） */
const LEFTOVER = /^\.update-|^\.install\.|^(app|runtime)\.old(\..+)?$/;
/**
 * 在 Electron 里（命令行跑在自带的 Electron 上，App 的搬家窗口也是）fs 把名字以 .asar 结尾的文件当成压缩包、当目录读：
 * 运行环境里的 default_app.asar 拷不过去（"Invalid package"），量大小时也会钻进去数。拷、量、核对时关掉，按普通文件处理。
 * 只在这几步里关，做完放回原样（Node 里没有这个开关，设了也不碍事）
 */
function asPlainFiles(work) {
  const before = process.noAsar;
  process.noAsar = true;
  let result;
  try {
    result = work();
  } catch (error) {
    process.noAsar = before;
    throw error;
  }
  if (!(result instanceof Promise)) {
    process.noAsar = before;
    return result;
  }
  return result.finally(() => {
    process.noAsar = before;
  });
}

/** 系统在文件夹里自己放的：打开过就有。不删的话旧目录删不掉，搬家的记号 MOVED.json 一直留着 */
const SYSTEM_LITTER = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
/** 每家一把 key（storage/paths.mjs 的 keyFile、oldAppKeyFile） */
const KEY_FILE = /^[a-z0-9]+-key(\.app)?\.bin$/;
/** Chromium 在缓存目录里的单实例锁（SingletonLock、SingletonSocket、SingletonCookie）：属于正在运行的那一个，不拷 */
const CHROMIUM_SINGLETON = /^Singleton/;

/** 家目录里我们的顶层名字：照 paths 里的每一项算出来，摆法改了这里跟着变 */
function ourNames(paths) {
  const names = new Set();
  for (const [name, value] of Object.entries(paths)) {
    if (name === "home" || typeof value !== "string") continue;
    const inside = relative(paths.home, value);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) continue;
    names.add(inside.split(sep)[0]);
  }
  return names;
}

/** current 指着的那个版本（Windows 的摆法）；没有、读不出是 null */
function currentVersion(paths) {
  try {
    const name = readFileSync(paths.currentFile, "utf8").trim();
    return name && !/[\\/]/.test(name) && name !== "." && name !== ".." ? name : null;
  } catch {
    return null;
  }
}

/**
 * 把家目录里的东西分成三类
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} paths
 * @returns {{ move: string[], leftovers: string[], unknown: string[], current: string | null }}
 */
export function classifyHome(paths) {
  const ours = ourNames(paths);
  const run = relative(paths.home, paths.runDir);
  const plan = { move: [], leftovers: [], unknown: [], current: currentVersion(paths) };
  for (const name of readdirSync(paths.home)) {
    if (name === run || LEFTOVER.test(name) || SYSTEM_LITTER.test(name)) plan.leftovers.push(name);
    else if (ours.has(name) || KEY_FILE.test(name)) plan.move.push(name);
    else plan.unknown.push(name);
  }
  return plan;
}

/** 拷不拷这一项：缓存里 Chromium 的单实例锁不拷；versions 下只拷 current 指着的那个（别的是换下来、还没删掉的旧版本） */
function keeper(from, plan) {
  const cache = join(from, "cache");
  const versions = join(from, "versions");
  return (source) => {
    const parent = dirname(source);
    const name = basename(source);
    if (parent === cache && CHROMIUM_SINGLETON.test(name)) return false;
    if (parent === versions && name !== plan.current) return false;
    return true;
  };
}

/**
 * 要拷的有多少：给"要拷多少、盘够不够"和进度用，和 copyHome 拷的是同一些（不顺着符号链接）
 * @returns {{ files: number, bytes: number }}
 */
export function measureHome({ from, plan }) {
  return asPlainFiles(() => measure(from, plan));
}

function measure(from, plan) {
  const keep = keeper(from, plan);
  const total = { files: 0, bytes: 0 };
  const walk = (path) => {
    if (!keep(path)) return;
    const info = lstatSync(path);
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (info.isFile()) {
      total.files++;
      total.bytes += info.size;
    }
  };
  for (const name of plan.move) walk(join(from, name));
  return total;
}

/**
 * 把要搬的拷到新家目录
 * @param {{ from: string, to: string, plan: ReturnType<typeof classifyHome>,
 *   onProgress?: (done: { files: number, bytes: number }) => void }} options onProgress：每开始拷一个文件报一次拷到哪了
 * @returns {Promise<{ files: number, bytes: number }>} 拷了多少个文件、多少字节
 */
export function copyHome({ from, to, plan, onProgress = () => {} }) {
  return asPlainFiles(() => copy(from, to, plan, onProgress));
}

async function copy(from, to, plan, onProgress) {
  mkdirSync(to, { recursive: true });
  const stats = { files: 0, bytes: 0 };
  const keep = keeper(from, plan);
  const filter = (source) => {
    if (!keep(source)) return false;
    const info = lstatSync(source);
    if (info.isFile()) {
      stats.files++;
      stats.bytes += info.size;
      onProgress({ ...stats });
    }
    return true;
  };
  for (const name of plan.move) {
    await cp(join(from, name), join(to, name), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      // APFS、ReFS 上克隆，不多占空间；不支持的盘照常拷
      mode: constants.COPYFILE_FICLONE,
      filter,
    });
  }
  return stats;
}

/**
 * 核对拷好的：每个符号链接都要是相对的、落在新家目录里面。不然旧目录一删就断了（Node 默认拷链接会改写成绝对路径）
 * @throws {Error} 说哪个链接不对
 */
export function verifyCopy({ to }) {
  asPlainFiles(() => verify(to));
}

function verify(to) {
  const root = resolve(to);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) throw new Error(`absolute symlink: ${path} -> ${target}`);
        const resolved = resolve(dirname(path), target);
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          throw new Error(`symlink would escape the folder: ${path} -> ${target}`);
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
}
