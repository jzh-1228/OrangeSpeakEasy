import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";

// 定位文件：OrangeSpeakEasy 的目录（家目录）装在了默认位置以外的哪里。它是 OrangeSpeakEasy 在家目录以外唯一留下的文件，
// 位置固定，所以从哪儿启动的都找得到：Mac 上"应用程序"里的 App、安装脚本、Windows 的安装程序、从源码跑的。
//   macOS    ~/Library/Application Support/com.juzihai.orangespeakeasy/location.json
//   Windows  %LOCALAPPDATA%\OrangeSpeakEasy\location.json
// 内容是 UTF-8（不带 BOM）的 JSON：{ "home": "<家目录的完整路径>" }；正在搬家时多一项 moving（见 move/）。
// 只有明确选了位置才写：orangespeakeasy move 搬到别处、安装时指定了目录（ORANGESPEAKEASY_INSTALL_DIR）。搬回默认位置、完整卸载时删掉。
// 没有它就是默认位置：0.11.0 及以前装的、一直用默认位置的，磁盘上不会多出这个文件。
// 环境变量 ORANGESPEAKEASY_HOME 只管"这一次用哪个目录"（开发、测试、更新时传递），从来不写它。
// 读它的不止这里：install.sh、install.ps1、native/windows-setup 各有一份，位置和格式以这里为准，
// test/storage/location-everywhere.test.mjs 核对几处写的是同一个。

/**
 * macOS 上放在按应用标识取名的 Application Support 目录里：不放 ~/.config（常被 dotfiles 工具同步到别的电脑，那里不一定有这块盘），
 * 也不放 ~/Library/Application Support/OrangeSpeakEasy（0.1 版的数据目录，legacy.mjs 会把它当旧数据搬走）
 */
const MAC_DIR = ["Library", "Application Support", "com.juzihai.orangespeakeasy"];
/** Windows 上放在本机的 AppData\Local（不随漫游配置同步到别的电脑：那里不一定有这个盘） */
const WINDOWS_DIR = "OrangeSpeakEasy";
const FILE_NAME = "location.json";

const pathModule = (platform) => (platform === "win32" ? win32 : posix);
const pathModuleOfFile = (file) => (/^([A-Za-z]:|\\\\)/.test(file) ? win32 : posix);

/**
 * 定位文件在哪
 * @param {Record<string, string | undefined>} env 用它的 LOCALAPPDATA（Windows）
 * @param {string} userHome 用户的家目录
 * @param {NodeJS.Platform} platform
 */
export function locationFileOf(env, userHome, platform) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || win32.join(userHome, "AppData", "Local");
    return win32.join(local, WINDOWS_DIR, FILE_NAME);
  }
  return posix.join(userHome, ...MAC_DIR, FILE_NAME);
}

/** 规范成完整写法（去掉 .、..、末尾的分隔符），和安装脚本算出来的是同一个字符串 */
export function normalizedHome(home, platform) {
  return pathModule(platform).resolve(home);
}

/** 两个家目录是不是同一个（字面上）：Windows 上不分大小写 */
export function sameHome(a, b, platform) {
  const [x, y] = [normalizedHome(a, platform), normalizedHome(b, platform)];
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * 一个目录的正式写法，比较、写进定位文件都用它。macOS 上解开符号链接、按磁盘上的大小写（/tmp → /private/tmp、
 * 经过链接的用户目录），和安装脚本（pwd -P）、启动脚本交给程序的是同一个字符串；还不存在的那几层照原样接在后面。
 * Windows 上只规整写法（和 install.ps1 的 GetFullPath 一样）
 */
export function canonicalDir(dir, platform = process.platform) {
  const path = pathModule(platform);
  const full = path.resolve(dir);
  if (platform === "win32") return full;
  const missing = [];
  for (let head = full; ; ) {
    try {
      return path.join(realpathSync.native(head), ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(head);
    if (parent === head) return full;
    missing.push(path.basename(head));
    head = parent;
  }
}

/**
 * 是不是一个完整的路径：不随"在哪个目录、哪个盘上运行"而变。Windows 上要带盘符（D:\）或者是网络路径（\\server\share），
 * 只是 \ 开头的指的是当前那个盘的根
 */
export function isFullPath(home, platform) {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(home) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(home);
  return posix.isAbsolute(home);
}

/** 控制字符（换行这些）不会出现在正经的路径里，安装脚本也读写不对它 */
const hasControlCharacters = (text) => [...text].some((char) => char.charCodeAt(0) < 0x20);

const validHome = (home, platform) =>
  typeof home === "string" && isFullPath(home, platform) && !hasControlCharacters(home);

/**
 * 读整份定位文件。没有这个文件是 null。读不了、内容不对都抛 LocalizedError：
 * 不能悄悄退回默认位置，那样会在默认位置新建一个空目录，用户看着像数据丢了
 * @param {string} file
 * @param {NodeJS.Platform} platform 按哪个系统认完整路径
 * @returns {{ home: string, moving: { to: string, startedAt?: string } | null } | null}
 */
export function readLocationRecord(file, platform) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new LocalizedError(msg("location.unreadable", { file, reason: error.code ?? error.message }), {
      cause: error,
    });
  }
  let record;
  try {
    // PowerShell 5.1 写 UTF-8 时常带 BOM：容忍它
    record = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    record = null;
  }
  if (record === null || typeof record !== "object" || !validHome(record.home, platform)) {
    throw new LocalizedError(msg("location.invalid", { file }));
  }
  // moving 只给搬家的那一层看（move/），读坏了不该挡住启动：认不出就当没有
  const moving = record.moving && validHome(record.moving.to, platform) ? record.moving : null;
  return {
    home: normalizedHome(record.home, platform),
    moving: moving && { ...moving, to: normalizedHome(moving.to, platform) },
  };
}

/** 定位文件说的家目录；没有定位文件是 null */
export function readLocation(file, platform) {
  return readLocationRecord(file, platform)?.home ?? null;
}

/**
 * 写定位文件。先写到旁边、落了盘再改名换上：写到一半断电，留下的也是旧的那份
 * @param {string} file
 * @param {{ home: string, moving?: { to: string, startedAt?: string } }} record
 */
export function writeLocation(file, record) {
  if (typeof record === "string") record = { home: record };
  mkdirSync(pathModuleOfFile(file).dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** 删掉定位文件（搬回默认位置、卸载时）。本来就没有不算错 */
export function removeLocation(file) {
  rmSync(file, { force: true });
  // 它所在的目录只放它一个：空了也删掉，不留空目录。删不掉（不空、没权限）只是多一个空目录，不影响什么，不报
  try {
    rmdirSync(pathModuleOfFile(file).dirname(file));
  } catch (error) {
    if (!error.code) throw error;
  }
}

/**
 * 卸载时删掉定位文件：只删指着这个家目录的那份（Windows 上不分大小写）。坏了的不删，照实报
 * @returns {boolean} 删了没有
 */
export function forgetLocation(file, home, platform) {
  const recorded = readLocation(file, platform);
  if (recorded === null || !sameHome(recorded, home, platform)) return false;
  removeLocation(file);
  return true;
}
