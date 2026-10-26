import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NotRunningError, requestControl, TimeoutError } from "./control.mjs";
import { LocalizedError, msg } from "./i18n/index.mjs";

// 这个家目录里正在运行的那个 OrangeSpeakEasy（App 或者命令行起的后台）：问它的状态、请它退出。
// 命令行（start、stop、update）和更新（src/update）都用这一份。它的停法只有这里一处：先请它自己退出，不退再结束进程。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 这个进程号现在跑的是什么命令；没有这个进程（或者查不了）时是 null。
 * Windows 没有 ps：问 PowerShell 它的可执行文件在哪（一次几百毫秒，只在它卡住不答话、要强行结束时才用得上）
 */
export function commandOfProcess(pid) {
  try {
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`;
      const path = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
      });
      return path.trim() || null;
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    // 没有这个进程时 ps 以 1 退出。查不了就当不认识：宁可让用户自己去结束，也不结束一个说不清是谁的进程
    return null;
  }
}

/** 后台应用的主进程跑的是哪个可执行文件（见 recordedPid） */
const OUR_EXECUTABLE = /\/MacOS\/(Electron|OrangeSpeakEasy)( |$)|\\electron\.exe$/i;

/**
 * @param {object} options
 * @param {ReturnType<import("./storage/paths.mjs").resolvePaths>} options.paths
 * @param {string} [options.locale] 问话的这一方用的语言。每条命令都带上它，后台按它把要给人看的话翻好再回
 *   （0.5 及以前的命令行不带，后台就按自己的语言翻：它们和 status --json 的读者都只认字）
 */
export function createInstance({
  paths,
  locale,
  kill = (pid, signal) => process.kill(pid, signal),
  commandOf = commandOfProcess,
  pollMs = 150,
  statusTimeoutMs = 5_000,
  quitTimeoutMs = 5_000,
}) {
  const request = (cmd, params, options) =>
    requestControl(paths.controlSocket, cmd, locale ? { ...params, locale } : params, options);

  /**
   * @returns {Promise<object | null>} 没有在运行时是 null
   * @throws {TimeoutError} 在运行，但卡住了不答话
   */
  async function status(params = {}) {
    try {
      return await request("status", params, { timeoutMs: statusTimeoutMs });
    } catch (error) {
      if (error instanceof NotRunningError) return null;
      throw error;
    }
  }

  function isAlive(pid) {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      // 进程在，只是不归我们管
      if (error.code === "EPERM") return true;
      throw error;
    }
  }

  /**
   * 等到这个进程真的不在了为止。只看控制通道关没关是不够的：它先关通道、过一会儿才退干净，
   * 这段时间里单实例的锁还占着，紧接着起新的会被挡回来。
   * @returns {Promise<boolean>} 限时内有没有等到
   */
  async function exited(pid, timeoutMs) {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(pollMs)) {
      if (!isAlive(pid)) return true;
    }
    return !isAlive(pid);
  }

  /** 后台应用启动时记在数据目录里的进程号。没记、记的不是数字、那个号现在不像是它，都是 null */
  function recordedPid() {
    let text;
    try {
      text = readFileSync(paths.pidFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    // 进程号会被系统分给别的程序，所以还要看它跑的是不是我们：命令启动的主进程是 …/MacOS/Electron，
    // 装成应用的是 …/MacOS/OrangeSpeakEasy，Windows 上是 …\\electron.exe。只看有没有 "Electron" 字样不够，别的应用的辅助进程路径里也有
    return OUR_EXECUTABLE.test(commandOf(pid) ?? "") ? pid : null;
  }

  return {
    status,
    request,

    /**
     * 停掉正在运行的那个，等它的进程真的不在了才返回。先请它自己退出，不退再结束进程；
     * 它卡住不答话时，照它启动时记下的进程号结束。
     * @returns {Promise<"not-running" | "quit" | "killed">} 本来就没在运行 / 它自己退出了 / 是被结束掉的
     */
    async stop() {
      let pid = null;
      let answering = true;
      try {
        const current = await status();
        if (current === null) return "not-running";
        pid = current.pid;
        await request("quit");
      } catch (error) {
        if (error instanceof TimeoutError) {
          answering = false;
          pid ??= recordedPid();
          if (pid === null) {
            throw new LocalizedError(msg("instance.stuckNoPid"));
          }
          // 答了"在运行"之后、收到退出命令之前它自己没了，不算错
        } else if (!(error instanceof NotRunningError)) throw error;
      }

      if (answering && (await exited(pid, quitTimeoutMs))) return "quit";
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        try {
          kill(pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (await exited(pid, quitTimeoutMs)) return "killed";
      }
      throw new LocalizedError(msg("instance.cantStop", { pid }));
    },
  };
}
