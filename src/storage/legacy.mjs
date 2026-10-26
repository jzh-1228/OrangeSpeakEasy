import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NotRunningError, requestControl } from "../control.mjs";
import { legacyChord } from "../hotkeys/legacy.mjs";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { ensureHome, keyFile, legacyDataDir, oldAppKeyFile } from "./paths.mjs";

// 旧版本留下的东西，第一次运行新版时换成现在的样子：
//   0.1 版把数据放在 ~/Library/Application Support/OrangeSpeakEasy。那里还有东西的话，搬进现在的家目录（migrateLegacyData）。
//     想退回 0.1：把这几样搬回原处即可。历史里的录音只按文件名认（history.mjs），不用跟着改。
//   0.13 以前热键的设置叫 hotkey、存一个旧 id（migrateLegacySettings）。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 旧目录里属于我们的那几样，以及各自现在该在哪。其余的是运行环境的缓存，不搬 */
const moves = (paths) => [
  ["history.db", paths.historyDb],
  ["Recordings", paths.recordingsDir],
  ["settings.json", paths.settingsFile],
  // 0.1 版只有 Gemini
  ["gemini-key.bin", keyFile(paths, "gemini")],
  // 装成应用的那份照旧名字搬，之后由 app-keys.mjs 并进共用的文件
  ["gemini-key.app.bin", oldAppKeyFile(paths, "gemini")],
];

/**
 * 搬一样东西：同一块盘上改名；家目录装在别的盘上时改名做不到（EXDEV），拷过去再删掉原来的。
 * 拷到一半出错就删掉拷了一半的，原来的不动
 */
export function moveItem(from, to, rename = renameSync) {
  try {
    rename(from, to);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  // 那边已经有的不碰（下面拷坏了要删的只能是这里拷过去的）
  if (existsSync(to)) throw Object.assign(new Error(`${to} already exists`), { code: "EEXIST" });
  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  rmSync(from, { recursive: true, force: true });
}

/** 旧版本的后台应用还在不在：它在旧目录里听着同一种控制通道 */
async function isRunning(socket) {
  try {
    await requestControl(socket, "status", {}, { timeoutMs: 1_000 });
  } catch (error) {
    if (error instanceof NotRunningError) return false;
  }
  // 答了话，或者占着不答，都算在
  return true;
}

/** 请旧版本的后台应用退出。@returns {Promise<boolean>} 限时内它退了没有 */
async function quitOldDaemon(socket, timeoutMs) {
  if (!(await isRunning(socket))) return true;
  // 它不认这条命令、或者正好在退出，都由下面的等待来判断结果
  await requestControl(socket, "quit", {}, { timeoutMs: 1_000 }).catch(() => {});
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
    if (!(await isRunning(socket))) return true;
  }
  return false;
}

/**
 * @param {object} options
 * @param {ReturnType<import("./paths.mjs").resolvePaths>} options.paths
 * @param {string | null} [options.legacyDir] 不给是 legacyDataDir()；是 null（不是 macOS）时什么都不做
 * @param {{ info: Function, warn: Function }} options.log
 * @param {number} [options.quitTimeoutMs] 等旧版本的后台应用退出，最多等多久
 * @returns {Promise<string[]>} 搬了哪几样；没有旧目录时是空的
 */
export async function migrateLegacyData({ paths, legacyDir = legacyDataDir(), log, quitTimeoutMs = 5_000 }) {
  if (legacyDir === null || !existsSync(legacyDir)) return [];
  // 它还开着那个库的话不能搬：搬走之后它会接着往旧位置写，两边各有一半
  if (!(await quitOldDaemon(join(legacyDir, "control.sock"), quitTimeoutMs))) {
    throw new LocalizedError(msg("storage.legacyRunning"));
  }

  ensureHome(paths);
  const moved = [];
  const kept = [];
  for (const [name, to] of moves(paths)) {
    const from = join(legacyDir, name);
    if (!existsSync(from)) continue;
    // 新目录里已经有的不覆盖：那是这一版用出来的
    if (existsSync(to)) {
      kept.push(name);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    moveItem(from, to);
    moved.push(name);
  }

  if (kept.length > 0) {
    log.warn("legacy_data_kept", { from: legacyDir, kept });
  } else {
    // 剩下的只有运行环境的缓存和旧日志：整个删掉，不留一个没人管的目录
    rmSync(legacyDir, { recursive: true, force: true });
  }
  if (moved.length > 0) log.info("legacy_data_migrated", { from: legacyDir, to: paths.home, moved });
  return moved;
}

/** 旧的热键设置换成哪一项 */
const LEGACY_HOTKEY = { from: "hotkey", to: "hotkey.dictate" };

/**
 * 0.13 以前设置文件里的 "hotkey"（一个旧 id）换成 "hotkey.dictate"（组合列表，docs/hotkey-research.md 5.9）。
 * 要在第一次读设置之前跑：App 和命令行的入口都调它。同步的，再跑一遍什么都不变。
 * 已经有 hotkey.dictate 也覆盖：新版从不写 hotkey，有它就是还没换过，或者退回旧版后在旧版里改过，两种都该以它为准。
 * 不是旧 id 的值照原样搬过去，由读设置的地方照实报错；本系统绑不了的（Mac 的 fn 到了 Windows 上）由下发前那道退回默认键。
 * 没有文件、文件坏了（读设置时会报）、没有 hotkey 时不动文件。写不进去时报错
 * @param {string} file 设置文件
 * @returns {{ from: string, to: string, value: unknown, stored: unknown } | null} 换了什么，交给调用方记日志；没换是 null
 */
export function migrateLegacySettings(file) {
  let settings;
  try {
    // 开头的 BOM 去掉再读，同 settings.mjs 的 readFile
    settings = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
  if (!Object.hasOwn(settings, LEGACY_HOTKEY.from)) return null;
  const { [LEGACY_HOTKEY.from]: value, ...rest } = settings;
  const chord = typeof value === "string" ? legacyChord(value) : null;
  const stored = chord === null ? value : [chord];
  try {
    writeFileSync(file, `${JSON.stringify({ ...rest, [LEGACY_HOTKEY.to]: stored }, null, 2)}\n`);
  } catch (error) {
    throw new LocalizedError(msg("storage.settingsMigrateFailed", { file, reason: error.message }), { cause: error });
  }
  return { ...LEGACY_HOTKEY, value, stored };
}
