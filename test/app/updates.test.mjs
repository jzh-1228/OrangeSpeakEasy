import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createAppUpdates, relevantFailure } from "../../src/app/updates.mjs";
import { createTranslator, msg } from "../../src/i18n/index.mjs";

// App 这边的版本检查和更新（src/app/updates.mjs）：内核（src/update）换成假的，记下被叫了什么

const zh = createTranslator("zh-CN");
const NOW = new Date("2026-10-19T08:00:00.000Z");
const quietLog = { info() {}, warn() {}, error() {} };

/** 假的内核：check 的结果、update.json 里现在记着的，都可以在测试里改 */
function fakeKernel({ self = "bundle", check = null, progress = null } = {}) {
  const kernel = {
    self,
    checks: [],
    record: progress,
    shown: 0,
    async check({ force }) {
      kernel.checks.push(force);
      if (check instanceof Error) throw check;
      return check;
    },
    progress: () => kernel.record,
    markShown() {
      kernel.shown++;
      kernel.record = { ...kernel.record, shown: true };
    },
  };
  return kernel;
}

/** 手动推进的定时器：ticks() 把登记的都跑一遍 */
function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    every: (fn, ms) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    stopEvery: (id) => timers.delete(id),
    tick: (ms) => {
      for (const { fn, ms: every } of [...timers.values()]) if (every === ms) fn();
    },
    count: () => timers.size,
  };
}

const AVAILABLE = {
  fromSource: false,
  current: "0.10.0",
  latest: "0.10.1",
  checkedAt: NOW.toISOString(),
  available: true,
  behind: [{ kind: "bundle", version: "0.10.0", path: "/Applications/OrangeSpeakEasy.app" }],
  problem: null,
};

function setup(kernelOptions, { launch } = {}) {
  const kernel = fakeKernel(kernelOptions);
  const timers = fakeTimers();
  const children = [];
  let changes = 0;
  const appUpdates = createAppUpdates({
    updates: kernel,
    version: "0.10.0",
    launch:
      launch ??
      (() => {
        const child = new EventEmitter();
        children.push(child);
        return child;
      }),
    onChange: () => changes++,
    log: quietLog,
    logFile: "/tmp/main.log",
    now: () => NOW,
    every: timers.every,
    stopEvery: timers.stopEvery,
  });
  return { appUpdates, kernel, timers, children, changes: () => changes };
}

test("启动后顺带查一次（按共用的记录，一天最多真问一次），之后每 6 小时再看；有新版本就说", async () => {
  const { appUpdates, kernel, timers } = setup({ check: AVAILABLE });
  assert.equal(appUpdates.afterLaunch(), false);
  await new Promise(setImmediate);
  assert.deepEqual(kernel.checks, [false]);
  const view = appUpdates.describe();
  assert.equal(view.available, true);
  assert.equal(view.latest, "0.10.1");
  assert.equal(view.other, null, "旧了的是这个 App 自己");
  timers.tick(6 * 60 * 60 * 1000);
  await new Promise(setImmediate);
  assert.deepEqual(kernel.checks, [false, false]);
});

test("用户点检查：真去问；没问到说原因。顺带的检查没问到不说", async () => {
  const offline = {
    ...AVAILABLE,
    available: false,
    behind: [],
    latest: null,
    problem: msg("update.unreachable", { url: "u", reason: "r" }),
  };
  const { appUpdates, kernel } = setup({ check: offline });
  const view = await appUpdates.check();
  assert.deepEqual(kernel.checks, [true]);
  assert.match(zh.text(view.checkProblem), /无法连接 u：r/);
  appUpdates.afterLaunch();
  await new Promise(setImmediate);
  assert.equal(appUpdates.describe().checkProblem, null);
});

test("只是另一份旧了（App 是新的，终端安装的那份还是旧的）：说是哪一份", async () => {
  const { appUpdates } = setup({
    check: { ...AVAILABLE, current: "0.10.1", behind: [{ kind: "home", version: "0.10.0" }] },
  });
  await appUpdates.check();
  assert.deepEqual(appUpdates.describe().other, { kind: "home", version: "0.10.0" });
});

test("开始更新：另起进程；它写下正在更新之前就显示在准备；它退出了再按记录看一次", async () => {
  const { appUpdates, kernel, timers, children } = setup({ check: AVAILABLE });
  const view = appUpdates.start();
  assert.equal(children.length, 1);
  assert.deepEqual(view.progress, { state: "running", phase: "starting", by: "app" });
  // 再点一次不再起
  appUpdates.start();
  assert.equal(children.length, 1);

  kernel.record = { state: "running", phase: "downloading", version: "0.10.1", by: "app", pid: 1 };
  timers.tick(500);
  assert.equal(appUpdates.describe().progress.phase, "downloading");

  // 已经是最新的（没让 App 退出）：进程退出、记录不再是进行中，停下不再看，再查一次
  kernel.record = { state: "current", version: "0.10.0", by: "app", pid: 1 };
  children[0].emit("exit", 0);
  timers.tick(500);
  assert.equal(timers.count(), 0);
  await new Promise(setImmediate);
  assert.ok(kernel.checks.length >= 1);
  assert.equal(appUpdates.describe().progress, null);
});

test("开始更新：进程没起来，说原因；命令行正在更新时不再起", () => {
  const broken = setup(
    { check: AVAILABLE },
    {
      launch: () => {
        throw new Error("spawn ENOENT");
      },
    },
  );
  const view = broken.appUpdates.start();
  assert.match(view.launchProblem, /spawn ENOENT/);
  assert.equal(view.progress, null);

  const busy = setup({ progress: { state: "running", phase: "downloading", by: "cli", version: "0.10.1", pid: 1 } });
  assert.equal(busy.appUpdates.start().progress.by, "cli");
  assert.equal(busy.children.length, 0);

  // 起来以后才报错（可执行文件找不到）：同样说原因
  const late = setup({ check: AVAILABLE });
  late.appUpdates.start();
  late.children[0].emit("error", new Error("spawn EACCES"));
  assert.match(late.appUpdates.describe().launchProblem, /spawn EACCES/);
});

test("从源码跑的：不查、不让更新", async () => {
  const { appUpdates, kernel } = setup({ self: null });
  await appUpdates.check();
  assert.deepEqual(kernel.checks, []);
  assert.equal(appUpdates.describe().fromSource, true);
  assert.throws(
    () => appUpdates.start(),
    (error) => error.problem.key === "preferences.update.fromSource",
  );
});

test("上一次是这里点的更新、刚换好重新打开：说一句已更新到哪个版本，只说一次；命令行更新的不说", () => {
  const done = { state: "done", version: "0.10.1", by: "app", pid: 1, stopped: "bundle" };
  const fresh = setup({ progress: done });
  assert.equal(fresh.appUpdates.afterLaunch(), true);
  assert.equal(fresh.appUpdates.describe().justUpdated, "0.10.1");
  assert.equal(fresh.kernel.shown, 1);
  assert.equal(setup({ progress: { ...done, shown: true } }).appUpdates.afterLaunch(), false);
  assert.equal(setup({ progress: { ...done, by: "cli" } }).appUpdates.afterLaunch(), false);
  // 这个 App 没被停掉（下载就没成，或者换的是另一份）：当场就看到了，不再说
  assert.equal(setup({ progress: { ...done, stopped: null } }).appUpdates.afterLaunch(), false);
  // 没换成、被重新打开的也说（设置里照记录说原因）
  const failed = setup({
    progress: { state: "failed", version: "0.10.1", by: "app", pid: 1, problem: "x", stopped: "home" },
  });
  assert.equal(failed.appUpdates.afterLaunch(), true);
  assert.equal(failed.appUpdates.describe().justUpdated, null);
  assert.equal(failed.appUpdates.describe().progress.state, "failed");
});

test("没成的更新提不提：要换的版本还没装上才提；不知道版本的一天之内提", () => {
  const failed = { state: "failed", problem: "x", finishedAt: NOW.toISOString() };
  assert.equal(relevantFailure({ ...failed, version: "0.10.1" }, "0.10.0", NOW), true);
  assert.equal(relevantFailure({ ...failed, version: "0.10.1" }, "0.10.1", NOW), false);
  assert.equal(relevantFailure(failed, "0.10.0", NOW), true);
  assert.equal(relevantFailure(failed, "0.10.0", new Date(NOW.getTime() + 25 * 60 * 60 * 1000)), false);
  assert.equal(relevantFailure({ state: "done" }, "0.10.0", NOW), false);
  // 设置里照它显示
  const { appUpdates } = setup({ progress: { ...failed, version: "0.10.1" } });
  assert.equal(appUpdates.describe().progress.state, "failed");
  assert.equal(setup({ progress: { ...failed, version: "0.9.0" } }).appUpdates.describe().progress, null);
});

test("更新进程没留下这一次的记录就退出了：说它意外退出、去哪看日志；有记录（拿不到锁时是命令行那条）就照记录", () => {
  const { appUpdates, children } = setup({ check: AVAILABLE });
  appUpdates.start();
  children[0].emit("exit", 1);
  assert.match(
    zh.text(appUpdates.describe().launchProblem),
    /更新进程意外退出（退出码 1），经过见日志 \/tmp\/main\.log/,
  );

  const busy = setup({ check: AVAILABLE });
  busy.appUpdates.start();
  busy.kernel.record = {
    state: "running",
    phase: "downloading",
    by: "cli",
    version: "0.10.1",
    pid: process.pid,
    startedAt: "x",
  };
  busy.children[0].emit("exit", 1);
  assert.equal(busy.appUpdates.describe().launchProblem, null);
  assert.equal(busy.appUpdates.describe().progress.by, "cli");
});

test("这个 App 开着就看到了结果：记下已经说过，下次启动不再说；命令行正在更新时打开设置也接着盯", () => {
  const { appUpdates, kernel, timers, children } = setup({ check: AVAILABLE });
  appUpdates.start();
  kernel.record = { state: "failed", version: "0.10.1", by: "app", pid: 1, problem: "x", stopped: null };
  children[0].emit("exit", 1);
  timers.tick(500);
  assert.equal(kernel.shown, 1);

  const cli = setup({ progress: { state: "running", phase: "downloading", by: "cli", version: "0.10.1", pid: 1 } });
  cli.appUpdates.describe();
  assert.equal(cli.timers.count(), 1, "开始盯 update.json");
});

test("update.json 读不了（权限、被占着）：App 照常起来，当没有记录", () => {
  const { appUpdates, kernel } = setup({ check: AVAILABLE });
  kernel.progress = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  assert.equal(appUpdates.describe().progress, null);
  assert.equal(appUpdates.afterLaunch(), false);
});
