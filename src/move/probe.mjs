import { existsSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { restrictToOwner } from "../storage/owner-only.mjs";

// 拷之前先在新位置试一遍 OrangeSpeakEasy 要用到的：建目录、收紧权限（里面有 key 和录音，只让自己进得去）；
// macOS 上还要建得了符号链接（Electron 框架里有）、绑得上 Unix 套接字（控制通道）。
// exFAT、FAT32 这类盘（U 盘、移动硬盘常见的格式）做不到其中几样：拷完、旧目录删了才发现 App 起不来就晚了，所以先试。

/** 在 dir 里绑一个 Unix 套接字再关掉 */
function bindSocket(dir) {
  const file = join(dir, ".probe.sock");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(file, () => server.close(() => resolve()));
  }).finally(() => rmSync(file, { force: true }));
}

/**
 * @param {string} home 新家目录（不存在，或者是空的）
 * @returns {Promise<{ created: boolean }>} created：目录是不是这里建的（搬不成时要删的就是它）
 * @throws {LocalizedError} 这块盘不行：说清楚是哪一样做不到
 */
export async function probeTarget(home, { platform = process.platform, restrict = restrictToOwner } = {}) {
  const created = !existsSync(home);
  let step = "create";
  try {
    if (created) mkdirSync(home, { mode: 0o700 });
    step = "restrict";
    restrict(home, { platform });
    if (platform !== "win32") {
      // exFAT 上 chmod 不报错，只是不起作用
      if ((statSync(home).mode & 0o777) !== 0o700)
        throw new Error(`mode is ${(statSync(home).mode & 0o777).toString(8)}`);
      step = "symlink";
      const link = join(home, ".probe-link");
      symlinkSync("target", link);
      try {
        if (readlinkSync(link) !== "target") throw new Error("the link reads back differently");
      } finally {
        rmSync(link, { force: true });
      }
      step = "socket";
      await bindSocket(home);
    }
  } catch (error) {
    if (created) rmSync(home, { recursive: true, force: true });
    throw new LocalizedError(
      msg("move.unsupportedDrive", { home, what: msg(`move.probe.${step}`), reason: error.code ?? error.message }),
      { cause: error },
    );
  }
  return { created };
}
