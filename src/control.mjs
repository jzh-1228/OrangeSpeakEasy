import { chmodSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { LocalizedError, msg } from "./i18n/index.mjs";

// 命令行和后台应用之间的控制通道：数据目录里的一个 Unix 套接字，只有这台机器上的同一个用户连得上。
// Windows 上是一个 named pipe（名字见 storage/paths.mjs）：Node 的 net 两种都认，下面只有"清掉旧文件、收紧权限"
// 两步是套接字文件才有的。pipe 不在磁盘上，进程一退就没了；它的默认权限给创建者、SYSTEM 和管理员完全控制，
// 别的账户最多只能读，发不了命令。
// 一次连接一问一答，各是一行 JSON：
//   {"cmd": "status", "params": {…}}  →  {"ok": true, "result": …}  或
//                                        {"ok": false, "error": "…", "problem": …, "code": "…"}
// 出错时 error 是一句话（英文，0.5 以前是中文），problem 是给人看的那句（msg），由命令行按它的语言翻；
// code 是给程序认的稳定标记（如 unknown_command）：文案翻不翻译、将来改不改措辞，认它的分支都不受影响。
// 命令行在 params 里带上自己用的语言（locale），回答里给人看的话后台按它翻成字（0.5 以前的命令行不带，按后台的语言）

/** 一条请求最长多少字节。正常的请求只有几十个字节，带 key 的那条也不到两百 */
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** 控制通道这一层说得清原因的失败。调用方照着 problem 告诉用户就行，不需要调用栈 */
export class ControlError extends LocalizedError {}

/** 后台应用没有在运行 */
export class NotRunningError extends ControlError {
  constructor() {
    super(msg("control.notRunning"));
    this.name = "NotRunningError";
  }
}

/** 有人在听，但限时内没有回话：多半是卡住了 */
export class TimeoutError extends ControlError {
  constructor(cmd, timeoutMs) {
    super(msg("control.timeout", { seconds: timeoutMs / 1000, command: cmd }));
    this.name = "TimeoutError";
  }
}

/** 后台应用启动时发现已经有一个在运行，用这个退出码告诉启动它的命令："不是我坏了，是有别人在了" */
export const ALREADY_RUNNING_EXIT_CODE = 3;

// 前三个是根本没人在听；后两个是连上了又被掐断，只在它正在退出的那一瞬间会遇到
const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ECONNRESET", "EPIPE"]);

/**
 * 发一条命令，等它的回答。
 * @returns {Promise<unknown>} 对方处理函数的返回值
 * @throws {NotRunningError} 没有人在听
 */
export function requestControl(socketPath, cmd, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = "";
    /** 已经判定完回话并结算过：之后自己 destroy 引起的 end/error 不再重复 settle */
    let finished = false;
    const finish = (action) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new TimeoutError(cmd, timeoutMs)));
    }, timeoutMs);
    const fail = (error) => {
      finish(() => reject(NOT_RUNNING_CODES.has(error.code) ? new NotRunningError() : error));
    };
    /** 一行回话的解析与结算：正常收到换行时走这里，对端没发换行就断开时也把剩下的半行交给它 */
    const handleReply = (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish(() => reject(new ControlError(msg("control.unreadable", { command: cmd }))));
        return;
      }
      if (reply.ok) finish(() => resolve(reply.result));
      // 后台说得清的（带着 problem）按命令行的语言翻；别的照它的原话
      else {
        const failure = reply.problem ? new LocalizedError(reply.problem) : new Error(reply.error);
        // 新版后台的错误回复带着结构化 code（如 unknown_command），原样带给调用方认
        if (reply.code) failure.code = reply.code;
        finish(() => reject(failure));
      }
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ cmd, params })}\n`));
    // 协议是一行一条回话：收到换行就说明回话完整，不必再等对端关连接
    // （Windows 的 named pipe 上等到 FIN 要 60ms 上下）
    socket.on("data", (chunk) => {
      if (finished) return;
      received += chunk;
      const end = received.indexOf("\n");
      if (end !== -1) handleReply(received.slice(0, end));
    });
    socket.on("error", fail);
    // 兜底：对端没发换行就断开（本来就是这样收尾，或者半路被掐断）
    socket.on("end", () => {
      if (finished) return;
      // 接了连接却一句没回就断开：它正在退出，这次没来得及答
      if (received === "") {
        finish(() => reject(new NotRunningError()));
        return;
      }
      handleReply(received);
    });
  });
}

/** 是 Windows 的 named pipe，不是磁盘上的套接字文件 */
const isNamedPipe = (socketPath) => socketPath.startsWith("\\\\.\\pipe\\");

/** 这个套接字上现在有没有人在听 */
async function isAlive(socketPath) {
  try {
    await requestControl(socketPath, "", {}, { timeoutMs: 1_000 });
  } catch (error) {
    if (error instanceof NotRunningError) return false;
  }
  // 有人答了话（哪怕答的是"不认识的命令"）或者占着不答，都算有人在
  return true;
}

/**
 * 开始在套接字上听命令。
 * @param {object} options
 * @param {string} options.socketPath
 * @param {Record<string, (params: object) => unknown>} options.handlers 命令名 → 处理函数，返回值就是回答
 * @param {{ warn: Function }} options.log
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function startControlServer({ socketPath, handlers, log }) {
  if (await isAlive(socketPath)) throw new Error("已经有一个在运行了");
  // 走到这里说明文件即使在也没人听：是上次没能正常退出留下的
  if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    let received = "";
    let answered = false;
    /** 已经收下一条命令、正在处理。一条连接只办一件事，之后再来的数据不看 */
    let handling = false;
    const answer = (reply) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(reply)}\n`);
    };

    socket.setEncoding("utf8");
    // 对方中途断开时这里会报错，没什么可做的，但不处理的话整个进程会被带崩
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (answered || handling) return;
      received += chunk;
      if (Buffer.byteLength(received) > MAX_REQUEST_BYTES) {
        answer({ ok: false, code: "request_too_long", error: "请求太长" });
        return;
      }
      const end = received.indexOf("\n");
      if (end === -1) return;
      handling = true;

      let request;
      try {
        request = JSON.parse(received.slice(0, end));
      } catch {
        answer({ ok: false, code: "bad_request", error: "请求不是一行 JSON" });
        return;
      }
      const handler = Object.hasOwn(handlers, request?.cmd) ? handlers[request.cmd] : null;
      if (!handler) {
        // code 是给命令行认这句话用的（isUnknownCommand）：error 那句文案将来变了、翻了，认法的这条不断
        answer({ ok: false, code: "unknown_command", error: `不认识的命令：${JSON.stringify(request?.cmd)}` });
        return;
      }
      try {
        answer({ ok: true, result: (await handler(request.params ?? {})) ?? null });
      } catch (error) {
        // 只记命令名：参数里可能有 key
        log.warn("control_failed", { cmd: request.cmd, error: String(error?.message ?? error).slice(0, 300) });
        answer({
          ok: false,
          error: String(error?.message ?? error),
          ...(error?.problem ? { problem: error.problem } : {}),
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isNamedPipe(socketPath)) chmodSync(socketPath, 0o600);

  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
