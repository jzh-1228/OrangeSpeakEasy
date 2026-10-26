import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TimeoutError } from "../../src/control.mjs";
import { createTranslator, LocalizedError, msg } from "../../src/i18n/index.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";
import { createHomes } from "../../src/update/home.mjs";
import { createUpdates } from "../../src/update/index.mjs";
import { createRelease, parseChannel } from "../../src/update/release.mjs";
import { acquireLock, readProgress } from "../../src/update/state.mjs";
import { publishTrees } from "../helpers/release.mjs";

// 内核里的版本检查和更新（src/update/index.mjs）：下载地址、App、安装脚本、正在运行的那个都换成假的，
// 记下按什么顺序做了什么。命令行那边的说法另在 test/cli/main.test.mjs 里测（它也走这里，用的是同一套假的）。

const zh = createTranslator("zh-CN");
const NOW = new Date("2026-10-19T08:00:00.000Z");
const DEAD_PID = 2 ** 22 + 12345;

let dir;
let paths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-updates-"));
  paths = resolvePaths({ ORANGESPEAKEASY_HOME: dir });
  // 像是用安装脚本装的：程序在家目录的 app 里
  mkdirSync(paths.appDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * 一套假的：steps 按先后记下做了什么，phases 记下每一步时 update.json 里写的阶段。
 * running：正在运行的那个（null 没在运行、"hung" 卡住了）；app：装着的 App（null 没装）
 */
function setup({
  latest = "v0.2.0",
  running = null,
  app = null,
  home = { version: "0.1.0" },
  stageApp = () => {},
  commitApp = () => {},
  stageHome = () => {},
  installCode = 0,
  openApp = () => {},
  startCode = 0,
  packageDir = paths.appDir,
  now = () => NOW,
  progress = false,
} = {}) {
  const steps = [];
  const phases = [];
  /** 拼新版本时交下去的：种子、块缓存放哪、报进度的 */
  const stagings = [];
  /** update.json 里现在记的 state；读不了（测试里故意弄坏的）是 unreadable */
  const stateNow = () => {
    try {
      return readProgress(paths)?.state;
    } catch {
      return "unreadable";
    }
  };
  const phase = () => {
    try {
      phases.push(readProgress(paths)?.phase ?? null);
    } catch {
      phases.push("unreadable");
    }
  };
  let current = running;
  const instance = {
    async status() {
      if (current === "hung") throw new TimeoutError("status", 5_000);
      return current;
    },
    async stop() {
      steps.push("stop");
      phase();
      current = null;
      return "quit";
    },
  };
  const updates = createUpdates({
    paths,
    env: {},
    packageDir,
    version: "0.1.0",
    instance,
    platform: "darwin",
    now,
    pid: 999_999,
    progress,
    release: {
      async channel() {
        steps.push("channel");
        if (latest instanceof Error) throw latest;
        return parseChannel(JSON.stringify({ format: 1, version: latest, electron: "44.0.0", targets: {} }));
      },
    },
    bundles: {
      async find({ pid }) {
        steps.push(`find-app:${pid}`);
        return app;
      },
      clean: () => null,
      async stage(channel, _path, staging) {
        steps.push(`stage-app:${channel.version}`);
        stagings.push(staging);
        phase();
        stageApp();
        return {
          downloadedBytes: 1_200_000,
          reusedBytes: 300_000_000,
          commit() {
            steps.push("commit-app");
            commitApp();
          },
          discard() {
            steps.push("discard-app");
          },
        };
      },
      async open(path) {
        steps.push(`open-app:${path}`);
        // 重新打开的那一刻结果已经记下了：打开的那个一启动就照它说
        phases.push(`reopen:${stateNow()}`);
        openApp();
      },
    },
    homes: {
      find: () => home,
      clean: () => null,
      seeds: () => [paths.appDir, paths.runtimeDir],
      async stage(channel, staging) {
        steps.push(`stage-home:${channel.version}`);
        stagings.push(staging);
        stageHome();
        return {
          dir: "staged",
          downloadedBytes: 100_000,
          reusedBytes: 400_000_000,
          discard() {
            steps.push("discard-home");
          },
        };
      },
      async install(staged) {
        steps.push(`install-home:${staged.dir}`);
        phase();
        return installCode;
      },
      async start() {
        steps.push("start-home");
        phases.push(`reopen:${stateNow()}`);
        return startCode;
      },
    },
  });
  return {
    updates,
    steps,
    phases,
    stagings,
    /** 改成另一个在跑（模拟下载期间用户打开、退出了 OrangeSpeakEasy） */
    setRunning: (value) => {
      current = value;
    },
  };
}

const APP = { path: "/Applications/OrangeSpeakEasy.app", version: "0.1.0" };
const APP_RUNNING = { pid: 4242, packaged: true };
const HOME_RUNNING = { pid: 4343, packaged: false };

test("检查：一天最多问一次下载地址，结果记在家目录里两边共用；点了检查（force）就再问", async () => {
  const { updates, steps } = setup();
  const first = await updates.check();
  assert.equal(first.latest, "0.2.0");
  assert.equal(first.available, true);
  assert.deepEqual(first.behind, [{ kind: "home", version: "0.1.0" }]);
  assert.equal(first.checkedAt, NOW.toISOString());
  assert.deepEqual(JSON.parse(readFileSync(paths.updateCheckFile, "utf8")), {
    checkedAt: NOW.toISOString(),
    latest: "0.2.0",
  });
  await updates.check();
  assert.equal(steps.filter((step) => step === "channel").length, 1, "一天之内不再问");
  await updates.check({ force: true });
  assert.equal(steps.filter((step) => step === "channel").length, 2);

  // 过了一天：顺带的检查也再问
  const later = setup({ now: () => new Date(NOW.getTime() + 24 * 60 * 60 * 1000) });
  await later.updates.check();
  assert.deepEqual(
    later.steps.filter((step) => step === "channel"),
    ["channel"],
  );
});

test("检查：问不到不抛，说原因；之前知道的最新版本留着（不因为这次没网就当没有新版本）", async () => {
  await setup().updates.check();
  const offline = setup({
    latest: new LocalizedError(msg("update.unreachable", { url: "https://x/channel.json", reason: "curl: (6)" })),
  });
  const result = await offline.updates.check({ force: true });
  assert.match(zh.text(result.problem), /无法连接 https:\/\/x\/channel\.json：curl: \(6\)/);
  assert.equal(result.latest, "0.2.0");
  assert.equal(result.available, true);
  assert.equal(JSON.parse(readFileSync(paths.updateCheckFile, "utf8")).latest, "0.2.0");

  // 问到的不像版本号：同样当没问到
  const garbled = setup({ latest: "<html>" });
  const bad = await garbled.updates.check({ force: true });
  assert.match(zh.text(bad.problem), /版本号无效/);
});

test("检查：两份都看，App 旧了也算有更新；正在跑的 App 按进程号找", async () => {
  const { updates, steps } = setup({ latest: "0.1.0", app: { ...APP, version: "0.0.9" } });
  const result = await updates.check({ runningApp: 4242 });
  assert.deepEqual(result.behind, [{ kind: "bundle", version: "0.0.9", path: APP.path }]);
  assert.ok(steps.includes("find-app:4242"));
});

test("检查：从源码跑的不问下载地址，说是从源码跑的", async () => {
  const outside = mkdtempSync(join(tmpdir(), "sm-src-"));
  try {
    const { updates, steps } = setup({ packageDir: outside });
    assert.equal(updates.self, null);
    const result = await updates.check({ force: true });
    assert.equal(result.fromSource, true);
    assert.equal(result.available, false);
    assert.deepEqual(steps, []);
    await assert.rejects(updates.run({ by: "app" }), (error) => /git pull/.test(zh.text(error.problem)));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("更新：先把两份都下好（这时 App 还在跑），再停、换、重新打开；每一步写进 update.json", async () => {
  const { updates, steps, phases } = setup({ running: APP_RUNNING, app: APP });
  const result = await updates.run({ by: "app" });
  assert.deepEqual(result, { updated: true, latest: "0.2.0", restarted: "bundle", running: true });
  assert.deepEqual(steps, [
    "channel",
    "find-app:4242",
    "stage-app:0.2.0",
    "stage-home:0.2.0",
    "find-app:4242",
    "stop",
    "commit-app",
    "install-home:staged",
    `open-app:${APP.path}`,
  ]);
  assert.deepEqual(phases, ["downloading", "installing", "installing", "reopen:done"]);
  const record = readProgress(paths);
  assert.equal(record.state, "done");
  assert.equal(record.by, "app");
  assert.equal(record.version, "0.2.0");
  assert.deepEqual(record.from, { home: "0.1.0", bundle: "0.1.0" });
  assert.equal(record.stopped, "bundle", "记下停掉的是谁：被停掉又打开的 App 一启动就说结果");
  assert.equal(existsSync(paths.updateLock), false, "锁放掉了");
});

test("更新：已经是最新的什么都不做，记成 current（App 不会当成刚更新过）", async () => {
  const { updates, steps } = setup({ latest: "0.1.0", running: HOME_RUNNING });
  assert.deepEqual(await updates.run({ by: "cli" }), {
    updated: false,
    latest: "0.1.0",
    restarted: null,
    running: true,
  });
  assert.ok(!steps.includes("stop"));
  assert.equal(readProgress(paths).state, "current");
});

test("更新：拼的时候下载、核对失败：什么都不停，记下原因，拼好的删掉，锁放掉", async () => {
  const broken = new LocalizedError(msg("update.checksum", { object: "0123456789ab" }));
  const { updates, steps } = setup({
    running: APP_RUNNING,
    app: APP,
    stageHome: () => {
      throw broken;
    },
  });
  await assert.rejects(updates.run({ by: "app" }), (error) => error === broken);
  assert.ok(!steps.includes("stop"));
  assert.ok(steps.includes("discard-app"), "已经拼好的 App 删掉");
  const record = readProgress(paths);
  assert.equal(record.state, "failed");
  assert.match(zh.text(record.problem), /下载的更新数据（0123456789ab）与发布的不符/);
  assert.equal(existsSync(paths.updateLock), false);
});

test("更新：安装脚本没装成：原来在跑的照样重新打开，记下没装成", async () => {
  const { updates, steps, phases } = setup({ running: HOME_RUNNING, installCode: 2 });
  await assert.rejects(updates.run({ by: "cli" }), (error) => /退出码是 2/.test(zh.text(error.problem)));
  assert.equal(phases.at(-1), "reopen:failed");
  assert.deepEqual(steps.slice(-2), ["install-home:staged", "start-home"]);
  assert.ok(!steps.includes("discard-home"), "交给安装脚本以后归它管，这里不删");
  assert.equal(readProgress(paths).state, "failed");
});

test("更新：换上了但没重新打开：照实说，记成没完成", async () => {
  const reopen = setup({
    running: APP_RUNNING,
    app: APP,
    home: null,
    openApp: () => {
      throw Object.assign(new Error("open failed"), { said: "LSOpenURLsWithRole() failed" });
    },
  });
  await assert.rejects(reopen.updates.run({ by: "app" }), (error) =>
    /已换上新版本，但未能重新打开 OrangeSpeakEasy\.app（LSOpenURLsWithRole\(\) failed）/.test(zh.text(error.problem)),
  );
  assert.equal(readProgress(paths).state, "failed");

  const restart = setup({ running: HOME_RUNNING, startCode: 1 });
  await assert.rejects(restart.updates.run({ by: "cli" }), (error) =>
    /未能重新启动（退出码 1）/.test(zh.text(error.problem)),
  );
});

test("更新：只换 App、在跑的是家目录那一份：不停它；卡住的不知道是哪一份：停掉，换完不打开", async () => {
  const other = setup({ latest: "0.1.0", running: HOME_RUNNING, app: { ...APP, version: "0.0.9" } });
  assert.deepEqual(await other.updates.run({ by: "cli" }), {
    updated: true,
    latest: "0.1.0",
    restarted: null,
    running: true,
  });
  assert.ok(!other.steps.includes("stop"));

  const hung = setup({ running: "hung", app: APP });
  assert.deepEqual(await hung.updates.run({ by: "cli" }), {
    updated: true,
    latest: "0.2.0",
    restarted: null,
    running: false,
  });
  assert.ok(hung.steps.includes("stop"));
  assert.ok(hung.steps.includes("find-app:null"));
  assert.ok(!hung.steps.some((step) => step.startsWith("open-app") || step === "start-home"));
});

test("锁：两边不能同时更新；拿着锁的进程已经不在了的当没人拿着；只放自己的", () => {
  mkdirSync(paths.runDir, { recursive: true });
  const release = acquireLock(paths, { pid: 111, alive: () => true });
  assert.throws(
    () => acquireLock(paths, { pid: 222, alive: () => true }),
    (error) => /另一个更新正在进行（进程 111）/.test(zh.text(error.problem)),
  );
  // 拿着锁的不在了
  assert.doesNotThrow(() => acquireLock(paths, { pid: 222, alive: (pid) => pid !== 111 }));
  // 111 再放锁：已经不是它的了，不动
  release();
  assert.equal(readFileSync(paths.updateLock, "utf8"), "222");
  // 刚建好、还没写进进程号的：算有人拿着
  writeFileSync(paths.updateLock, "");
  assert.throws(
    () => acquireLock(paths, { pid: 333 }),
    (error) => /另一个更新正在进行（进程 \?）/.test(zh.text(error.problem)),
  );
});

test("进行到哪：标着正在更新、可那个进程不在了（或者过了两小时）的算中断，说去看日志", () => {
  const { updates } = setup();
  mkdirSync(paths.runDir, { recursive: true });
  const running = { state: "running", phase: "installing", version: "0.2.0", by: "app", startedAt: NOW.toISOString() };
  writeFileSync(paths.updateFile, JSON.stringify({ ...running, pid: process.pid }));
  assert.equal(updates.progress().state, "running");
  writeFileSync(paths.updateFile, JSON.stringify({ ...running, pid: DEAD_PID }));
  const interrupted = updates.progress();
  assert.equal(interrupted.state, "failed");
  assert.match(zh.text(interrupted.problem), /上一次更新未完成就中断了，经过见日志 .*main\.log/);
  writeFileSync(
    paths.updateFile,
    JSON.stringify({
      ...running,
      pid: process.pid,
      startedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    }),
  );
  assert.equal(updates.progress().state, "failed");
});

test("更新好了告诉过用户之后记一笔，下次启动不再说；写到一半的记录当没有", () => {
  const { updates } = setup();
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.updateFile, JSON.stringify({ state: "done", version: "0.2.0", by: "app", pid: 1 }));
  updates.markShown();
  assert.equal(readProgress(paths).shown, true);
  writeFileSync(paths.updateFile, '{"state": "do');
  assert.equal(updates.progress(), null);
});

test("更新：换成了、下到的块却删不掉：照样算换成、照样重新打开，说一声留在了哪", async () => {
  // 缓存目录里有个删不掉的东西
  const lines = [];
  const kit = setup({ running: HOME_RUNNING });
  const locked = join(paths.updateCacheDir, "locked");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "x"), "占着");
  chmodSync(locked, 0o555);
  try {
    const result = await kit.updates.run({ by: "cli", report: (message) => lines.push(zh.text(message)) });
    assert.equal(result.updated, true);
    assert.equal(kit.steps.at(-1), "start-home", "删缓存放在重新打开之后");
    assert.equal(readProgress(paths).state, "done");
    if (process.platform !== "win32") {
      assert.ok(
        lines.some((line) => line.startsWith(`临时文件未能删除：${paths.updateCacheDir}`)),
        lines.join("\n"),
      );
    }
  } finally {
    // Windows 上只读挡不住删目录，那边已经删掉了
    if (existsSync(locked)) chmodSync(locked, 0o755);
  }
});

test("更新：下载期间用户打开了 App（之前什么都没在跑）：换之前看出来，停掉它、换上、重新打开", async () => {
  let setRunning;
  const kit = setup({
    running: null,
    app: APP,
    home: null,
    stageApp: () => setRunning(APP_RUNNING),
  });
  setRunning = kit.setRunning;
  const result = await kit.updates.run({ by: "cli" });
  assert.equal(result.restarted, "bundle");
  assert.deepEqual(kit.steps.slice(-4), ["find-app:4242", "stop", "commit-app", `open-app:${APP.path}`]);
});

test("更新：下载期间用户自己退出了 App：不停、换完也不替他打开", async () => {
  let setRunning;
  const kit = setup({ running: APP_RUNNING, app: APP, stageHome: () => setRunning(null) });
  setRunning = kit.setRunning;
  const result = await kit.updates.run({ by: "cli" });
  assert.deepEqual([result.restarted, result.running], [null, false]);
  assert.ok(!kit.steps.includes("stop"));
  assert.ok(!kit.steps.some((step) => step.startsWith("open-app")));
});

test("更新：在跑的是打包的 App、可找不到它的应用包：照样换家目录那一份，最后照实说不知道该打开哪个", async () => {
  const { updates, steps } = setup({ running: APP_RUNNING, app: null });
  await assert.rejects(updates.run({ by: "cli" }), (error) =>
    /不知道 OrangeSpeakEasy\.app 在哪/.test(zh.text(error.problem)),
  );
  assert.ok(steps.includes("install-home:staged"));
  assert.equal(readProgress(paths).state, "failed");
});

test("更新：记录写不进去（被占着、磁盘满）不耽误换程序和重新打开，最后说一声", async () => {
  const said = [];
  const { updates, steps } = setup({ running: HOME_RUNNING });
  // update.json 的位置上是一个目录：写不进去
  mkdirSync(paths.updateFile, { recursive: true });
  const result = await updates.run({ by: "cli", report: (message) => said.push(zh.text(message)) });
  assert.equal(result.updated, true);
  assert.deepEqual(steps.slice(-2), ["install-home:staged", "start-home"]);
  assert.ok(!steps.includes("discard-home"), "交给安装脚本以后归它管，这里不删");
  assert.ok(
    said.some((line) => line.startsWith("更新记录写不进")),
    said.join("\n"),
  );
});

test("检查：上一次没问到的，一小时后就再问，不等一天", async () => {
  const offline = setup({ latest: new Error("没网") });
  await offline.updates.check();
  assert.equal(JSON.parse(readFileSync(paths.updateCheckFile, "utf8")).failed, true);
  const soon = setup({ now: () => new Date(NOW.getTime() + 30 * 60 * 1000) });
  await soon.updates.check();
  assert.deepEqual(soon.steps, [], "半小时内不再问");
  const later = setup({ now: () => new Date(NOW.getTime() + 61 * 60 * 1000) });
  await later.updates.check();
  assert.ok(later.steps.includes("channel"));
  assert.equal(JSON.parse(readFileSync(paths.updateCheckFile, "utf8")).failed, undefined, "问到了就不再标没问到");
});

test("中断的更新：告诉过用户之后记成没完成、已说过，不再每次启动都当成新的", () => {
  const { updates } = setup();
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.updateFile,
    JSON.stringify({
      state: "running",
      phase: "installing",
      by: "app",
      pid: DEAD_PID,
      startedAt: NOW.toISOString(),
      stopped: "bundle",
    }),
  );
  assert.equal(updates.progress().finishedAt, NOW.toISOString());
  updates.markShown();
  const record = readProgress(paths);
  assert.deepEqual([record.state, record.shown], ["failed", true]);
});

test("锁：拿了两小时还没放的不算（进程号可能被别的程序用上了）", async () => {
  const { utimesSync } = await import("node:fs");
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.updateLock, String(process.pid));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(paths.updateLock, old, old);
  assert.doesNotThrow(() => acquireLock(paths, { pid: 444, alive: () => true }));
  assert.equal(readFileSync(paths.updateLock, "utf8"), "444");
});

test("更新：拼新版本时本机装着的几份都当种子，下到的块放在家目录的缓存里；换成了删掉缓存，没换成的留着下次接着用", async () => {
  const said = [];
  const { updates, stagings } = setup({ running: null, app: APP });
  mkdirSync(paths.updateCacheDir, { recursive: true });
  writeFileSync(join(paths.updateCacheDir, "a".repeat(64)), "上次下到的块");
  await updates.run({ by: "cli", report: (message) => said.push(zh.text(message)) });
  assert.equal(stagings.length, 2);
  for (const staging of stagings) {
    assert.deepEqual(staging.seeds, [paths.appDir, paths.runtimeDir, APP.path]);
    assert.equal(staging.cacheDir, paths.updateCacheDir);
    assert.equal(staging.onProgress, undefined, "不在终端里时不报进度");
  }
  // 两份加起来：下 1.2 + 0.1 MB，拷 300 + 400 MB
  assert.ok(said.includes("已下载 1.3 MB，其余 700 MB 取自本机已有的文件。"), said.join("\n"));
  assert.equal(existsSync(paths.updateCacheDir), false, "换成了，缓存删掉");

  const failing = setup({ running: null, home: { version: "0.1.0" }, installCode: 1 });
  mkdirSync(paths.updateCacheDir, { recursive: true });
  writeFileSync(join(paths.updateCacheDir, "b".repeat(64)), "这次下到的块");
  await assert.rejects(failing.updates.run({ by: "cli" }));
  assert.ok(existsSync(join(paths.updateCacheDir, "b".repeat(64))), "没换成，缓存留着");
});

test("更新：在终端里时按两成一档说下载进度，每档只说一次；没有要下的不说", async () => {
  const said = [];
  const { updates, stagings } = setup({
    running: null,
    progress: true,
    stageHome: () => {
      const { onProgress } = stagings.at(-1);
      onProgress({ downloadedChunks: 0, totalChunks: 0 });
      for (const done of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) onProgress({ downloadedChunks: done, totalChunks: 10 });
    },
  });
  await updates.run({ by: "cli", report: (message) => said.push(zh.text(message)) });
  assert.deepEqual(
    said.filter((line) => line.startsWith("下载更新")),
    ["下载更新：0%", "下载更新：20%", "下载更新：40%", "下载更新：60%", "下载更新：80%", "下载更新：100%"],
  );
});

test("更新（Windows）：install.ps1 原地切到拼好的那个版本以后，它就是装好的那一份，不能当成没换上的删掉", async () => {
  // 路径用这台机器的写法（在 Mac 上跑时用 Windows 的写法会写出带反斜杠的文件名），装法照 Windows 的走
  const winPaths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "win") }, undefined, process.platform);
  const oldDir = join(winPaths.versionsDir, "0.1.0-aaaaaaaa");
  mkdirSync(join(oldDir, "app"), { recursive: true });
  writeFileSync(join(oldDir, "app", "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(winPaths.currentFile, "0.1.0-aaaaaaaa");
  const tree = mkdtempSync(join(dir, "tree-"));
  mkdirSync(join(tree, "app"));
  mkdirSync(join(tree, "runtime"));
  writeFileSync(join(tree, "app", "package.json"), JSON.stringify({ version: "0.2.0" }));
  writeFileSync(join(tree, "runtime", "electron.exe"), "exe");
  const base = join(dir, "release");
  await publishTrees(base, "0.2.0", { "win32-x64": tree });
  const env = { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: base };
  const release = createRelease({ env });
  const real = createHomes({ paths: winPaths, env, release, stdio: "ignore", platform: "win32", arch: "x64" });
  const homes = {
    ...real,
    // 像 install.ps1 那样：versions 下拼好的原地用，current 指过去
    install: async (staged) => {
      writeFileSync(winPaths.currentFile, basename(staged.dir));
      return 0;
    },
  };
  const updates = createUpdates({
    paths: winPaths,
    env,
    packageDir: join(oldDir, "app"),
    version: "0.1.0",
    instance: { status: async () => null, stop: async () => "not-running" },
    platform: "win32",
    arch: "x64",
    now: () => NOW,
    pid: 999_999,
    release,
    homes,
  });
  assert.equal((await updates.run({ by: "cli" })).updated, true);
  const current = readFileSync(winPaths.currentFile, "utf8");
  assert.match(current, /^0\.2\.0-[0-9a-f]{8}$/);
  assert.equal(
    JSON.parse(readFileSync(join(winPaths.versionsDir, current, "app", "package.json"), "utf8")).version,
    "0.2.0",
    "current 指着的新版本还在",
  );
});
