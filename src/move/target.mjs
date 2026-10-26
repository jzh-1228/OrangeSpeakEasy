import { readdirSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { canonicalDir, isFullPath } from "../storage/location.mjs";

// 搬到哪：用户选一个文件夹，OrangeSpeakEasy 搬进它里面的 .orangespeakeasy（选的本身就叫 .orangespeakeasy 时就是它）。
// 只管这个子目录：搬失败了删、以后卸载删，都不会删到所选文件夹里别的东西。这里只做检查，不动磁盘。

/** macOS 上控制通道是 <家目录>/run/control.sock，Unix 套接字的路径最长 103 个字节（和 install.sh 的 MAX_HOME_BYTES 一样） */
const MAX_MAC_HOME_BYTES = 86;
/** Windows 上和 install.ps1 的 $MaxHomeChars 一样：PowerShell 5.1 解包、拷贝和快捷方式受 260 个字符的限制 */
const MAX_WINDOWS_HOME_CHARS = 120;

const pathModule = (platform) => (platform === "win32" ? win32 : posix);

/** 选了这个文件夹，家目录就是它里面的 .orangespeakeasy；它本身就叫 .orangespeakeasy（Windows 上不分大小写）时就是它 */
export function homeIn(folder, platform = process.platform) {
  const path = pathModule(platform);
  const full = path.resolve(folder);
  const named = platform === "win32" ? path.basename(full).toLowerCase() : path.basename(full);
  return named === ".orangespeakeasy" ? full : path.join(full, ".orangespeakeasy");
}

/** 路径长度合不合格：macOS 按字节（套接字路径的上限），Windows 按字符 */
export function checkLength(home, platform = process.platform) {
  const tooLong =
    platform === "win32" ? home.length > MAX_WINDOWS_HOME_CHARS : Buffer.byteLength(home) > MAX_MAC_HOME_BYTES;
  if (!tooLong) return;
  throw new LocalizedError(
    platform === "win32"
      ? msg("move.tooLongChars", { home, max: MAX_WINDOWS_HOME_CHARS })
      : msg("move.tooLongBytes", { home, max: MAX_MAC_HOME_BYTES }),
  );
}

/** 磁盘上的身份：同一个目录不管怎么写（大小写、经过符号链接、映射的盘符）都是同一个 */
function identity(path) {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    // 有的文件系统给不出编号（全是 0）：认不出就当不是同一个，再按真实路径比一次
    return ino === 0n ? null : `${dev}:${ino}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** 真实路径（Windows 上不分大小写），比不出身份时用 */
function realKey(path, platform) {
  try {
    const real = realpathSync.native(path);
    return platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/** dir 是不是 home 本身，或者在它里面：从 dir 一级级往上，按身份和真实路径比 */
function within(dir, home, platform) {
  const path = pathModule(platform);
  const homeId = identity(home);
  const homeReal = realKey(home, platform);
  let current = realpathSync.native(dir);
  for (;;) {
    if (homeId !== null && identity(current) === homeId) return true;
    const key = platform === "win32" ? current.toLowerCase() : current;
    if (homeReal !== null && key === homeReal) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * 看看能不能搬到所选的文件夹：完整路径、文件夹已经在、不就是现在这个、不在现在这个里面、新家目录不存在或是空的、路径不太长。
 * 不合格就抛 LocalizedError 说清楚。只检查，不动磁盘
 * @param {{ paths: ReturnType<import("../storage/paths.mjs").resolvePaths>, folder: string, platform?: NodeJS.Platform }} options
 * @returns {{ home: string }} 新家目录
 */
export function checkTarget({ paths, folder, platform = process.platform }) {
  const text = String(folder ?? "").trim();
  if (!isFullPath(text, platform)) {
    const example = platform === "win32" ? "D:\\Apps" : "/Volumes/Data";
    throw new LocalizedError(msg("move.notFull", { folder: JSON.stringify(text), example }));
  }
  let isFolder = false;
  try {
    isFolder = statSync(text).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  if (!isFolder) throw new LocalizedError(msg("move.noFolder", { folder: text }));

  const home = homeIn(text, platform);
  const current = paths.home;
  // 新家目录就是现在这个（选了它本身、或者它所在的文件夹）
  const homeId = identity(current);
  if ((homeId !== null && identity(home) === homeId) || within(text, current, platform)) {
    const same = identity(home) === homeId || realKey(home, platform) === realKey(current, platform);
    throw new LocalizedError(msg(same ? "move.sameHome" : "move.insideHome", { home: current }));
  }
  let entries = null;
  try {
    entries = readdirSync(home);
  } catch (error) {
    if (error.code === "ENOTDIR") entries = [error.code];
    else if (error.code !== "ENOENT") throw error;
  }
  if (entries !== null && entries.length > 0) throw new LocalizedError(msg("move.notEmpty", { home }));
  const canonical = canonicalDir(home, platform);
  checkLength(canonical, platform);
  return { home: canonical };
}
