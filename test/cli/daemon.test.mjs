import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDaemon } from "../../src/cli/daemon.mjs";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer, TimeoutError } from "../../src/control.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { ensureHome, resolvePaths } from "../../src/storage/paths.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

const zh = createTranslator("zh-CN", "darwin");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

const quietLog = { info() {}, warn() {}, error() {} };
const RUNNING = { pid: 4321, starting: false, permissions: { microphone: "granted" }, key: { state: "ready" } };

let dir;
let paths;
let app;
let spawned;
let progress;
let processes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-"));
  paths = resolvePaths({ ORANGESPEAKEASY_HOME: dir });
  // 后台应用启动时自己会建；这里的假应用没有这一步
  ensureHome(paths);
  app = null;
  spawned = [];
  progress = [];
  processes = fakeProcesses();
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 假的后台应用：一个真的控制通道，状态由测试给 */
async function startFakeApp(statusOf, extraHandlers = {}) {
  app = await startControlServer({
    socketPath: paths.controlSocket,
    log: quietLog,
    handlers: { status: () => statusOf(), ...extraHandlers },
  });
}

/** 假的"启动一个进程"：记下怎么启动的，再按测试的安排让应用出现或者退出 */
function fakeSpawn(behave) {
  return (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref() {} });
    spawned.push({ command, args, options });
    behave(child, options);
    return child;
  };
}

/**
 * 假的进程表：alive 里有的进程号算活着；发过的信号记在 signals 里，onSignal 决定进程怎么反应。
 * 信号 0 和真的一样只是问"还在不在"。
 */
function fakeProcesses() {
  const table = {
    alive: new Set(),
    signals: [],
    onSignal: () => {},
    kill(pid, signal) {
      if (!table.alive.has(pid)) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      if (signal === 0) return;
      table.signals.push([pid, signal]);
      table.onSignal(pid, signal);
    },
  };
  return table;
}

function daemonWith(overrides = {}) {
  return createDaemon({
    paths,
    packageDir: "/pkg",
    env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
    resolveElectron: () => "/pkg/node_modules/electron/dist/Electron",
    ensureHelper: () => false,
    kill: processes.kill,
    commandOf: () => "/pkg/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /pkg",
    pollMs: 10,
    ...overrides,
  });
}

test("没有在运行时状态是 null", async () => {
  assert.equal(await daemonWith().status(), null);
});

test("每条命令都带上命令行用的语言：后台按它把话翻好回来（0.5 以前的后台不认这一项，照旧回中文）", async () => {
  const seen = [];
  await startFakeApp(() => RUNNING, {
    status: (params) => {
      seen.push(["status", params]);
      return RUNNING;
    },
    "set-key": (params) => {
      seen.push(["set-key", params]);
      return { ok: true };
    },
  });
  const daemon = daemonWith({ locale: "zh-CN" });
  await daemon.status({ recheck: true });
  await daemon.request("set-key", { key: "k", provider: "gemini" });
  assert.deepEqual(seen, [
    ["status", { recheck: true, locale: "zh-CN" }],
    ["set-key", { key: "k", provider: "gemini", locale: "zh-CN" }],
  ]);
});

test("启动：用 Electron 跑这个包，脱离终端，输出接到日志文件，等它答话了才算启动好", async () => {
  const spawn = fakeSpawn((_child, options) => {
    // 应用自己的输出应当落进日志文件
    writeFileSync(options.stdio[1], '{"event":"started"}\n');
    setTimeout(() => startFakeApp(() => RUNNING), 30);
  });
  const status = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(zh.text(message)) });

  assert.equal(status.pid, 4321);
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, "/pkg/node_modules/electron/dist/Electron");
  assert.deepEqual(args, ["/pkg"]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.env.ORANGESPEAKEASY_CLI, "1");
  assert.equal(options.env.PATH, "/usr/bin");
  // 带着这个变量 Electron 会把自己当成普通的 Node，窗口和热键都不会有
  assert.equal("ELECTRON_RUN_AS_NODE" in options.env, false);
  assert.match(readFileSync(paths.logFile, "utf8"), /"started"/);
});

test("启动时把家目录建出来，只有自己进得去（里面会有录音和 key）", async () => {
  rmSync(dir, { recursive: true });
  const spawn = fakeSpawn(() => startFakeApp(() => RUNNING));
  await daemonWith({ spawn }).start({ onProgress() {} });
  assertOwnerOnlyDir(paths.home);
});

test("启动前先确保小帮手编好了；编了的话说一声", async () => {
  const order = [];
  const spawn = fakeSpawn(() => {
    order.push("spawn");
    startFakeApp(() => RUNNING);
  });
  const ensureHelper = (packageDir, { onBuild }) => {
    order.push(`helper:${packageDir}`);
    onBuild();
    return true;
  };
  await daemonWith({ spawn, ensureHelper }).start({ onProgress: (message) => progress.push(zh.text(message)) });
  assert.deepEqual(order, ["helper:/pkg", "spawn"]);
  assert.ok(progress.some((text) => /小程序/.test(text)));
});

test("应用还在等麦克风授权时说明在等什么，等它准备好再返回", async () => {
  let status = { ...RUNNING, starting: true, permissions: { microphone: "not-determined" } };
  const spawn = fakeSpawn(() => {
    startFakeApp(() => status);
    setTimeout(() => {
      status = RUNNING;
    }, 60);
  });
  const result = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(zh.text(message)) });
  assert.equal(result.starting, false);
  assert.equal(progress.filter((text) => /麦克风/.test(text)).length, 1);
});

test("应用一直没准备好时不无限等，把当时的状态交回去", async () => {
  const spawn = fakeSpawn(() => startFakeApp(() => ({ ...RUNNING, starting: true })));
  const result = await daemonWith({ spawn, readyTimeoutMs: 80 }).start({ onProgress() {} });
  assert.equal(result.starting, true);
});

test("应用刚启动就退出时报错，并带上日志最后几行", async () => {
  const spawn = fakeSpawn((child, options) => {
    writeFileSync(options.stdio[1], "第一行\n设置文件写错了：hotkey\n");
    setTimeout(() => child.emit("exit", 2, null), 20);
  });
  await assert.rejects(
    daemonWith({ spawn }).start({ onProgress() {} }),
    (error) => /没能启动/.test(zh.text(error.problem)) && /设置文件写错了：hotkey/.test(zh.text(error.problem)),
  );
});

test("应用一直不答话时按时放弃，并说去哪看日志", async () => {
  const spawn = fakeSpawn(() => {});
  await assert.rejects(
    daemonWith({ spawn, connectTimeoutMs: 60 }).start({ onProgress() {} }),
    said(/logs[\\/]main\.log/),
  );
});

test("同时启动了两个：后到的发现已经有一个就退出，这不算失败，接着等先到的那个答话", async () => {
  const spawn = fakeSpawn((child) => {
    setTimeout(() => child.emit("exit", ALREADY_RUNNING_EXIT_CODE, null), 10);
    setTimeout(() => startFakeApp(() => RUNNING), 50);
  });
  const status = await daemonWith({ spawn }).start({ onProgress() {} });
  assert.equal(status.pid, 4321);
});

test("停止：让它自己退出，等到进程真的不在了才算停掉", async () => {
  processes.alive.add(4321);
  await startFakeApp(() => RUNNING, {
    quit: () => {
      // 控制通道先关，进程晚一些才退干净：这段时间里新的还起不来
      setTimeout(() => app.close(), 20);
      setTimeout(() => processes.alive.delete(4321), 90);
    },
  });
  assert.equal(await daemonWith().stop(), "quit");
  assert.equal(processes.alive.has(4321), false);
  assert.deepEqual(processes.signals, []);
});

test("本来就没有在运行时，停止什么都不做", async () => {
  assert.equal(await daemonWith().stop(), "not-running");
});

test("说了退出却一直不退：先请它结束，再不行就强行结束", async () => {
  processes.alive.add(4321);
  await startFakeApp(() => RUNNING, { quit: () => {} });
  processes.onSignal = (pid, signal) => {
    if (signal === "SIGKILL") processes.alive.delete(pid);
  };
  assert.equal(await daemonWith({ quitTimeoutMs: 40 }).stop(), "killed");
  assert.deepEqual(processes.signals, [
    [4321, "SIGTERM"],
    [4321, "SIGKILL"],
  ]);
});

/** 一个卡住的后台应用：连得上，但问什么都不答 */
const startHungApp = () => startFakeApp(() => new Promise(() => {}));

test("卡住不答话时也停得掉：照它启动时记下的进程号结束它；命令启动的和装成应用的都认", async () => {
  for (const command of [
    "/pkg/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /pkg",
    "/Applications/OrangeSpeakEasy.app/Contents/MacOS/OrangeSpeakEasy",
    // Windows：装好的那份和从源码跑的都是 electron.exe
    "C:\\Users\\someone\\.orangespeakeasy\\runtime\\electron.exe",
    "C:\\dev\\orangespeakeasy\\node_modules\\electron\\dist\\electron.exe",
  ]) {
    processes = fakeProcesses();
    processes.alive.add(4321);
    processes.onSignal = (pid) => processes.alive.delete(pid);
    writeFileSync(paths.pidFile, "4321\n");
    await startHungApp();
    assert.equal(await daemonWith({ statusTimeoutMs: 60, commandOf: () => command }).stop(), "killed");
    assert.deepEqual(processes.signals, [[4321, "SIGTERM"]]);
    await app.close();
  }
});

test("卡住不答话，进程号又对不上（没记下来，或者那个号现在是别的程序）：不乱结束别人的进程，说清楚怎么办", async () => {
  processes.alive.add(4321);
  await startHungApp();
  const stuck = (overrides) => daemonWith({ statusTimeoutMs: 60, ...overrides }).stop();

  await assert.rejects(stuck(), said(/活动监视器/));
  writeFileSync(paths.pidFile, "4321\n");
  await assert.rejects(stuck({ commandOf: () => "/usr/bin/vim notes.txt" }), said(/活动监视器/));
  // 别的 Electron 应用的辅助进程，路径里也带着 Electron 字样
  const otherApp =
    "/Applications/Other.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler";
  await assert.rejects(stuck({ commandOf: () => otherApp }), said(/活动监视器/));
  // Windows 上别的 Electron 应用（名字不叫 electron.exe）也不认
  await assert.rejects(stuck({ commandOf: () => "C:\\Program Files\\Slack\\slack.exe" }), said(/活动监视器/));
  await assert.rejects(stuck({ commandOf: () => null }), said(/活动监视器/));
  writeFileSync(paths.pidFile, "不是数字");
  await assert.rejects(stuck(), said(/活动监视器/));
  assert.deepEqual(processes.signals, []);
});

test("卡住不答话时查状态：报的是“不答话”，不当成没在运行", async () => {
  await startHungApp();
  await assert.rejects(daemonWith({ statusTimeoutMs: 60 }).status(), TimeoutError);
});
