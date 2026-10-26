import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ControlError, NotRunningError, requestControl, startControlServer, TimeoutError } from "../src/control.mjs";
import { createTranslator } from "../src/i18n/index.mjs";
import { resolvePaths } from "../src/storage/paths.mjs";

const zh = createTranslator("zh-CN");

let dir;
let socketPath;
let server;
let logged;
const log = {
  info: (event, fields) => logged.push({ level: "info", event, ...fields }),
  warn: (event, fields) => logged.push({ level: "warn", event, ...fields }),
  error: (event, fields) => logged.push({ level: "error", event, ...fields }),
};

beforeEach(() => {
  // 套接字路径有长度上限，临时目录用短名字。地址照家目录的约定取：macOS 是套接字文件，Windows 是 named pipe
  dir = mkdtempSync(join(tmpdir(), "sm-"));
  const paths = resolvePaths({ ORANGESPEAKEASY_HOME: dir });
  mkdirSync(paths.runDir);
  socketPath = paths.controlSocket;
  server = null;
  logged = [];
});
afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("问一句答一句，参数原样交给处理函数", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: { greet: async ({ name }) => ({ text: `你好，${name}` }), ping: () => "pong" },
  });
  assert.deepEqual(await requestControl(socketPath, "greet", { name: "世界" }), { text: "你好，世界" });
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("处理函数抛错时，对方收到那句错误说明", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      fail: () => {
        throw new Error("这把 key 无效");
      },
    },
  });
  await assert.rejects(requestControl(socketPath, "fail"), /这把 key 无效/);
});

test("不认识的命令被拒绝", async () => {
  server = await startControlServer({ socketPath, log, handlers: {} });
  await assert.rejects(requestControl(socketPath, "dance"), /dance/);
});

test("不认识的命令：错误带结构化 code，说明仍是那句中文（新旧两种认法都钉住）", async () => {
  server = await startControlServer({ socketPath, log, handlers: {} });
  await assert.rejects(requestControl(socketPath, "dance"), (error) => {
    assert.equal(error.code, "unknown_command");
    assert.ok(error.message.startsWith("不认识的命令"));
    return true;
  });
});

test("出错时日志里只记命令名，不记参数（参数里可能是 key）", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      "set-key": () => {
        throw new Error("不行");
      },
    },
  });
  await assert.rejects(requestControl(socketPath, "set-key", { key: "SECRET-VALUE" }));
  assert.ok(logged.some((entry) => entry.cmd === "set-key"));
  assert.ok(!JSON.stringify(logged).includes("SECRET-VALUE"));
});

/** 套接字文件才有的事：Windows 的 named pipe 不在磁盘上，进程一退就没了，权限是 pipe 自己的默认权限 */
const socketFileOnly = { skip: process.platform === "win32" && "Windows 上是 named pipe，没有套接字文件" };

test("没有在运行时抛 NotRunningError：没有人在听", async () => {
  await assert.rejects(requestControl(socketPath, "ping"), NotRunningError);
});

test("没有在运行时抛 NotRunningError：只剩一个没人听的套接字文件", socketFileOnly, async () => {
  writeFileSync(socketPath, "");
  await assert.rejects(requestControl(socketPath, "ping"), NotRunningError);
});

test("启动时遇到上次没清掉的套接字文件，清掉重建", socketFileOnly, async () => {
  // 先起一个再粗暴地关掉监听但留下文件，模拟进程被杀
  const stale = createServer();
  await new Promise((resolve) => stale.listen(socketPath, resolve));
  stale.unref();
  await new Promise((resolve) => {
    // close 会顺手删文件，所以关掉后再补一个同名的普通文件
    stale.close(() => resolve());
  });
  writeFileSync(socketPath, "");
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "pong" } });
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("已经有一个在听时拒绝再启动，也不去动它的套接字", async () => {
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "first" } });
  await assert.rejects(startControlServer({ socketPath, log, handlers: { ping: () => "second" } }), /已经有一个在运行/);
  assert.equal(await requestControl(socketPath, "ping"), "first");
});

test("套接字只有自己能读写；关闭后文件被删掉", socketFileOnly, async () => {
  server = await startControlServer({ socketPath, log, handlers: {} });
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  await server.close();
  server = null;
  assert.equal(existsSync(socketPath), false);
});

test("对方一直不回话时按时放弃", async () => {
  server = await startControlServer({ socketPath, log, handlers: { hang: () => new Promise(() => {}) } });
  await assert.rejects(
    requestControl(socketPath, "hang", {}, { timeoutMs: 100 }),
    (error) => error instanceof TimeoutError && /没有在 0\.1 秒内回话/.test(zh.text(error.problem)),
  );
});

test("没在运行和不答话都是 ControlError，调用方可以一并当成说得清的失败来处理", () => {
  assert.ok(new NotRunningError() instanceof ControlError);
  assert.ok(new TimeoutError("status", 5000) instanceof ControlError);
});

test("一条连接只处理一条命令：处理途中又来数据，不会把同一条命令再执行一遍", async () => {
  let calls = 0;
  let finish;
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      slow: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const { connect } = await import("node:net");
  const socket = connect(socketPath);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.on("data", () => {});
  socket.write('{"cmd":"slow"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.write("\n");
  socket.write("\n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish("done");
  await closed;
  assert.equal(calls, 1);
});

test("收到的不是一行 JSON 时回一句错误，不让服务挂掉", async () => {
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "pong" } });
  const { connect } = await import("node:net");
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write("这不是 JSON\n");
  });
  const parsed = JSON.parse(reply);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "bad_request");
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("请求超过上限时回一句错误带 code，不让服务挂掉", async () => {
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "pong" } });
  const { connect } = await import("node:net");
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    // 64KB 是上限，多一个字节就该被拒
    socket.write("x".repeat(64 * 1024 + 1));
  });
  const parsed = JSON.parse(reply);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "request_too_long");
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("对方接了连接却一句没回就断开（正在退出），算作没有在运行", async () => {
  // 两种断法都会遇到：客气地收尾，或者直接掐掉
  const ways = [(socket) => socket.resume().end(), (socket) => socket.destroy()];
  for (const hangUp of ways) {
    const quitting = createServer(hangUp);
    await new Promise((resolve) => quitting.listen(socketPath, resolve));
    try {
      await assert.rejects(requestControl(socketPath, "status"), NotRunningError);
    } finally {
      await new Promise((resolve) => quitting.close(resolve));
    }
  }
});
