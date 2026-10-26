import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalizedError } from "../../src/i18n/index.mjs";
import { createMove, settleMove } from "../../src/move/index.mjs";
import { moverAlive, readMoveRecord, writeMoveRecord } from "../../src/move/state.mjs";
import { readLocationRecord, writeLocation } from "../../src/storage/location.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

// 搬家的整个流程（move/index.mjs）：在 /tmp 下摆一个假的用户目录（定位文件、默认位置都在里面，不碰这台机器真的），
// 正在运行的那个、安装脚本换家、打开 App 都换成假的，看成了、各步失败时磁盘和定位文件是什么样子。
// 符号链接、套接字、权限位是 macOS 的事，Windows 上的走法在真机上验。

const posixOnly = { skip: process.platform === "win32" && "搬家流程的单元测试按 macOS 的摆法写" };

function put(file, content = "x") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** 假的用户目录：默认位置有一份用过的 OrangeSpeakEasy，旁边一块"盘"等着搬过去 */
function setup(t, { installer = false, located = false } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/sm-m-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = located ? join(root, "elsewhere", ".orangespeakeasy") : join(root, ".orangespeakeasy");
  put(join(from, "settings.json"), '{"hotkey":"fn"}');
  put(join(from, "data", "history.db"), "历史");
  put(join(from, "models", "m", "model.bin"), "模型");
  put(join(from, "logs", "main.log"), "日志");
  put(join(from, "run", "daemon.pid"), "123");
  put(join(from, "notes.txt"), "用户自己的");
  if (installer) put(join(from, "app", "install.sh"), "# 认得 ORANGESPEAKEASY_PREVIOUS_HOME\n");
  const paths = resolvePaths({ ORANGESPEAKEASY_HOME: from }, root, "darwin");
  if (located) writeLocation(paths.locationFile, { home: from });
  const disk = join(root, "disk");
  mkdirSync(disk);
  return { root, from, paths, disk, to: join(disk, ".orangespeakeasy") };
}

/** "应用程序"里的 App：0.12.0 起的认得定位文件 */
function fakeApp(root) {
  const path = join(root, "OrangeSpeakEasy.app");
  put(join(path, "Contents", "Resources", "app", "src", "storage", "location.mjs"));
  return { find: async () => ({ path, version: "0.12.0" }) };
}

/** 正在运行的那个：status 交回 running，stop 之后就不在了 */
function fakeInstance(running = null) {
  const calls = [];
  return {
    calls,
    async status() {
      return running;
    },
    async stop() {
      calls.push("stop");
      running = null;
      return "quit";
    },
  };
}

/** 安装脚本换家：和 install.sh 一样把定位文件改成新家（默认位置就删掉）；code 不是 0 时什么都不做 */
function fakeRehome({ paths, root, codes = [] }) {
  const calls = [];
  const run = async ({ home, previous }) => {
    calls.push({ home, previous });
    const code = codes.shift() ?? 0;
    if (code !== 0) return code;
    if (home === join(root, ".orangespeakeasy")) rmSync(paths.locationFile, { force: true });
    else writeLocation(paths.locationFile, { home });
    return 0;
  };
  return { calls, run };
}

function mover({ paths, root, instance = fakeInstance(), rehome, ...rest }) {
  return createMove({
    paths,
    env: {},
    instance,
    platform: "darwin",
    userHome: root,
    bundles: { find: async () => null },
    moverAlive: () => false,
    runRehome: rehome?.run ?? (async () => assert.fail("不该换家")),
    openApp: async () => assert.fail("不该打开 App"),
    ...rest,
  });
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

/** 搬到一半断了：定位文件记着 moving，旧目录的 run/move.json 记着正在搬，新位置拷了一些、带着这次搬家的记号 */
function interrupted({ paths, from, to, pid = 4242, startedAt = new Date().toISOString() }) {
  writeLocation(paths.locationFile, { home: from, moving: { to, pid, startedAt } });
  const record = { state: "running", by: "cli", pid, from, to, startedAt };
  writeMoveRecord(paths, record);
  put(join(to, "settings.json"), "拷了一半");
  put(join(to, "run", "move.json"), JSON.stringify(record));
}

test("搬过去：我们的拷过去、旧目录里只删我们的，用户自己的留着；定位文件记下新位置", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t);
  const reports = [];
  const progress = [];
  const result = await mover({ paths, root }).run({
    folder: disk,
    by: "cli",
    report: (message) => reports.push(message.key),
    onProgress: (done) => progress.push(done),
  });
  assert.equal(result.to, to);
  assert.equal(result.files, 4);
  assert.deepEqual(result.left, ["notes.txt"]);
  assert.equal(readFileSync(join(to, "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(readFileSync(join(to, "models", "m", "model.bin"), "utf8"), "模型");
  assert.equal(existsSync(join(to, "run", "daemon.pid")), false);
  assert.equal(existsSync(join(to, "notes.txt")), false);
  // 新家只让自己进
  assert.equal(statSync(to).mode & 0o777, 0o700);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: to, moving: null });
  // 旧目录：用户自己的那个文件留着，旁边是说搬去了哪的记号
  assert.deepEqual(readdirSync(from).sort(), ["MOVED.json", "notes.txt"]);
  assert.deepEqual(JSON.parse(readFileSync(join(from, "MOVED.json"), "utf8")), { to });
  assert.equal(readMoveRecord(resolvePaths({ ORANGESPEAKEASY_HOME: to }, root, "darwin")).state, "done");
  assert.deepEqual(reports, ["move.copying", "move.switching"]);
  assert.deepEqual(progress[0], { files: 0, bytes: 0, total: { files: 4, bytes: progress.at(-1).bytes } });
  assert.equal(progress.at(-1).files, 4);
});

test("旧目录里只有我们的（和访达放的 .DS_Store）：搬完整个删掉，连记号一起", posixOnly, async (t) => {
  const { root, from, paths, disk } = setup(t);
  rmSync(join(from, "notes.txt"));
  put(join(from, ".DS_Store"));
  const result = await mover({ paths, root }).run({ folder: disk, by: "cli" });
  assert.deepEqual(result.left, []);
  assert.equal(existsSync(from), false);
});

test("装着程序的：由新位置的安装脚本换家，它改定位文件", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t, { installer: true });
  const rehome = fakeRehome({ paths, root });
  await mover({ paths, root, rehome }).run({ folder: disk, by: "cli" });
  assert.deepEqual(rehome.calls, [{ home: to, previous: from }]);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: to, moving: null });
});

test("搬回默认位置：定位文件删掉", posixOnly, async (t) => {
  const { root, paths } = setup(t, { located: true });
  await mover({ paths, root }).run({ folder: root, by: "cli" });
  assert.equal(existsSync(paths.locationFile), false);
  assert.equal(readFileSync(join(root, ".orangespeakeasy", "settings.json"), "utf8"), '{"hotkey":"fn"}');
});

test("正在运行的：先停掉，搬完从新位置用它的启动命令重新打开", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t, { installer: true });
  // 启动命令记下自己是从哪个家目录起的
  const marker = join(root, "started-in");
  put(join(from, "bin", "orangespeakeasy"), `#!/bin/sh\nprintf '%s %s' "$ORANGESPEAKEASY_HOME" "$1" > '${marker}'\n`);
  const { chmodSync } = await import("node:fs");
  chmodSync(join(from, "bin", "orangespeakeasy"), 0o755);
  const instance = fakeInstance({ pid: 1, packaged: false });
  const rehome = fakeRehome({ paths, root });
  await mover({ paths, root, instance, rehome, stdio: "forward" }).run({ folder: disk, by: "cli" });
  assert.deepEqual(instance.calls, ["stop"]);
  assert.equal(readFileSync(marker, "utf8"), `${to} start`);
});

test("Mac 的 App 在运行：搬完用 open 从新位置打开它", posixOnly, async (t) => {
  const { root, paths, disk, to } = setup(t);
  const opened = [];
  const instance = fakeInstance({ pid: 1, packaged: true });
  await mover({
    paths,
    root,
    instance,
    bundles: fakeApp(root),
    openApp: async (app, home) => opened.push([app, home]),
  }).run({ folder: disk, by: "app" });
  assert.deepEqual(opened, [[join(root, "OrangeSpeakEasy.app"), to]]);
});

test("换家失败：系统入口换回旧目录，定位文件放回原样，拷过去的删掉，旧目录原样在用", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t, { installer: true, located: true });
  const rehome = fakeRehome({ paths, root, codes: [3, 0] });
  const reports = [];
  await assert.rejects(
    mover({ paths, root, rehome }).run({ folder: disk, by: "cli", report: (message) => reports.push(message.key) }),
    (error) => error instanceof LocalizedError && error.problem.key === "move.rehomeFailed",
  );
  assert.deepEqual(rehome.calls, [
    { home: to, previous: from },
    { home: from, previous: to },
  ]);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
  assert.equal(existsSync(to), false);
  assert.deepEqual(readdirSync(disk), []);
  assert.equal(readFileSync(join(from, "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(existsSync(join(from, "MOVED.json")), false);
  const record = readMoveRecord(paths);
  assert.equal(record.state, "failed");
  assert.equal(record.problem.key, "move.rehomeFailed");
  assert.deepEqual(reports, ["move.copying", "move.switching"]);
});

test("盘不行（exFAT 这类）：在停掉正在运行的之前就说，App 不用白退出一次，什么都没动", posixOnly, async (t) => {
  const { root, paths, disk } = setup(t);
  const instance = fakeInstance({ pid: 1, packaged: true });
  await assert.rejects(
    mover({
      paths,
      root,
      instance,
      bundles: fakeApp(root),
      probe: async () => {
        throw new Error("exFAT");
      },
    }).run({ folder: disk, by: "app" }),
    /exFAT/,
  );
  assert.deepEqual(instance.calls, []);
  assert.equal(existsSync(paths.locationFile), false);
  assert.deepEqual(readdirSync(disk), []);
});

test(
  "停掉之后才出错（拷坏了）：定位文件回到搬之前（默认位置就是没有），停掉的那个从旧位置重新打开",
  posixOnly,
  async (t) => {
    const { root, from, paths, disk } = setup(t);
    symlinkSync(join(from, "models"), join(from, "data", "absolute"));
    const opened = [];
    const instance = fakeInstance({ pid: 1, packaged: true });
    await assert.rejects(
      mover({
        paths,
        root,
        instance,
        bundles: fakeApp(root),
        openApp: async (app, home) => opened.push([app, home]),
      }).run({ folder: disk, by: "app" }),
      (error) => error.problem?.key === "move.copyBroken",
    );
    assert.deepEqual(instance.calls, ["stop"]);
    assert.equal(existsSync(paths.locationFile), false);
    assert.deepEqual(opened, [[join(root, "OrangeSpeakEasy.app"), from]]);
    assert.deepEqual(readdirSync(disk), []);
  },
);

test("拷过去的符号链接不对（指向旧目录的绝对路径）：不提交，删掉拷过去的", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t);
  symlinkSync(join(from, "models"), join(from, "data", "absolute"));
  await assert.rejects(
    mover({ paths, root }).run({ folder: disk, by: "cli" }),
    (error) => error.problem?.key === "move.copyBroken",
  );
  assert.equal(existsSync(to), false);
  assert.equal(existsSync(paths.locationFile), false);
});

test("选的就是一个空的 .orangespeakeasy：搬不成时只清空它，目录留着", posixOnly, async (t) => {
  const { root, paths, disk, to } = setup(t, { installer: true });
  mkdirSync(to);
  await assert.rejects(
    mover({ paths, root, rehome: fakeRehome({ paths, root, codes: [1, 0] }) }).run({ folder: to, by: "cli" }),
  );
  assert.deepEqual(readdirSync(disk), [".orangespeakeasy"]);
  assert.deepEqual(readdirSync(to), []);
});

test("先问一句：要拷多少、搬去哪；除了试一下盘不动磁盘", posixOnly, async (t) => {
  const { root, from, paths, disk, to } = setup(t);
  const plan = await mover({ paths, root }).plan(disk);
  assert.equal(plan.from, from);
  assert.equal(plan.to, to);
  assert.equal(plan.files, 4);
  assert.equal(plan.bytes, Buffer.byteLength('{"hotkey":"fn"}历史模型日志'));
  assert.deepEqual(plan.unknown, ["notes.txt"]);
  // 试过盘，试完删掉
  assert.deepEqual(readdirSync(disk), []);
  assert.equal(existsSync(paths.locationFile), false);
});

test("不搬：家目录里的程序太旧、应用程序里的 App 太旧、这一次的目录不是记着的那一个", posixOnly, async (t) => {
  const { root, from, paths, disk } = setup(t);
  const key = (name) => (error) => error.problem?.key === name;

  put(join(from, "app", "install.sh"), "# 0.11.0\n");
  await assert.rejects(mover({ paths, root }).plan(disk), key("move.homeTooOld"));
  rmSync(join(from, "app"), { recursive: true });

  const oldApp = join(root, "OrangeSpeakEasy.app");
  mkdirSync(oldApp);
  const bundles = { find: async () => ({ path: oldApp, version: "0.11.0" }) };
  await assert.rejects(mover({ paths, root, bundles }).plan(disk), key("move.appTooOld"));
  put(join(oldApp, "Contents", "Resources", "app", "src", "storage", "location.mjs"));
  await mover({ paths, root, bundles }).plan(disk);

  // ORANGESPEAKEASY_HOME 临时指到别处（开发、测试）：定位文件不能被改指到它
  const other = resolvePaths({ ORANGESPEAKEASY_HOME: join(root, "dev-home") }, root, "darwin");
  mkdirSync(other.home);
  await assert.rejects(mover({ paths: other, root }).plan(disk), key("move.notRecorded"));

  // 装着程序、却没有能换家的安装脚本（Mac 上 0.10.x 的终端安装，app 里不带 install.sh）：不能当成只装了 dmg 的来搬
  put(join(from, "app", "package.json"), "{}");
  put(join(from, "bin", "orangespeakeasy"), "#!/bin/sh\n");
  await assert.rejects(mover({ paths, root, bundles }).plan(disk), key("move.homeTooOld"));
});

test(
  "0.11.0 及以前用 ORANGESPEAKEASY_HOME 装到别处的（从没记进定位文件）：默认位置没装过时认它，搬完记下新位置",
  posixOnly,
  async (t) => {
    const root = realpathSync(mkdtempSync("/tmp/sm-m-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const from = join(root, "custom");
    put(join(from, "settings.json"), "{}");
    put(join(from, "app", "install.sh"), "# 认得 ORANGESPEAKEASY_PREVIOUS_HOME\n");
    const paths = resolvePaths({ ORANGESPEAKEASY_HOME: from }, root, "darwin");
    const disk = join(root, "disk");
    mkdirSync(disk);
    const to = join(disk, ".orangespeakeasy");
    const rehome = fakeRehome({ paths, root });
    const plan = await mover({ paths, root, rehome }).plan(disk);
    assert.equal(plan.to, to);
    // 默认位置也装过（这一份多半是开发、测试临时指的）：不认
    put(join(root, ".orangespeakeasy", "settings.json"), "{}");
    await assert.rejects(
      mover({ paths, root, rehome }).plan(disk),
      (error) => error.problem?.key === "move.notRecorded",
    );
    rmSync(join(root, ".orangespeakeasy"), { recursive: true });
    await mover({ paths, root, rehome }).run({ folder: disk, by: "cli" });
    assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: to, moving: null });
  },
);

test("同时只有一个在搬（和更新共用一把锁）", posixOnly, async (t) => {
  const { root, paths, disk } = setup(t);
  put(paths.updateLock, "1");
  await assert.rejects(
    mover({ paths, root, alive: () => true }).run({ folder: disk, by: "cli" }),
    (error) => error.problem?.key === "update.busy",
  );
});

test("搬到一半进程没了：从旧目录启动时换回入口、删掉拷了一半的、定位文件去掉 moving", posixOnly, async (t) => {
  const { root, from, paths, to } = setup(t, { installer: true, located: true });
  interrupted({ paths, from, to });
  const rehome = fakeRehome({ paths, root });
  const reports = [];
  await settleMove({
    paths,
    env: {},
    platform: "darwin",
    userHome: root,
    runRehome: rehome.run,
    alive: () => false,
    report: (message) => reports.push(message.key),
  });
  assert.deepEqual(rehome.calls, [{ home: from, previous: to }]);
  assert.equal(existsSync(to), false);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
  assert.equal(readMoveRecord(paths).state, "failed");
  assert.deepEqual(reports, ["move.recovered"]);
});

test("搬家的进程号过了六小时还在（断电重启后分给了别的程序）：不算在搬，照常收拾", posixOnly, async (t) => {
  const { root, from, paths, to } = setup(t, { installer: true, located: true });
  interrupted({ paths, from, to, startedAt: hoursAgo(36) });
  const rehome = fakeRehome({ paths, root });
  await settleMove({ paths, env: {}, platform: "darwin", userHome: root, runRehome: rehome.run, alive: () => true });
  assert.equal(existsSync(to), false);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
});

test("进程号在、跑的却不是 OrangeSpeakEasy：不算在搬", () => {
  const running = (command) => moverAlive(4242, { alive: () => true, commandOf: () => command });
  assert.equal(running("/usr/sbin/syslogd"), false);
  assert.equal(running(null), false);
  assert.equal(running("/Applications/OrangeSpeakEasy.app/Contents/MacOS/OrangeSpeakEasy"), true);
  assert.equal(
    running(
      "/Users/u/.orangespeakeasy/runtime/Electron.app/Contents/MacOS/Electron /Users/u/.orangespeakeasy/app/bin/orangespeakeasy.mjs move /x",
    ),
    true,
  );
  assert.equal(running("C:\\Users\\u\\.orangespeakeasy\\versions\\0.12.0-1\\runtime\\electron.exe"), true);
  assert.equal(running("node bin/orangespeakeasy.mjs move /tmp/x"), true);
  assert.equal(moverAlive(4242, { alive: () => false, commandOf: () => assert.fail("进程不在就不用问") }), false);
});

test(
  "从拷了一半的那一份启动、搬家的进程已经没了：入口换回旧目录，说再打开一次；从旧目录启动时删掉这一份",
  posixOnly,
  async (t) => {
    const { root, from, paths, to } = setup(t, { installer: true, located: true });
    interrupted({ paths, from, to });
    const rehome = fakeRehome({ paths, root });
    const settle = (where) =>
      settleMove({
        paths: where,
        env: {},
        platform: "darwin",
        userHome: root,
        runRehome: rehome.run,
        alive: () => false,
      });
    const half = resolvePaths({ ORANGESPEAKEASY_HOME: to }, root, "darwin");
    await assert.rejects(settle(half), (error) => error.problem?.key === "move.putBack");
    assert.deepEqual(rehome.calls, [{ home: from, previous: to }]);
    assert.equal(existsSync(to), true, "正跑在它上面，不删");
    assert.equal(readLocationRecord(paths.locationFile, "darwin").moving.to, to, "从旧目录启动时照它删掉这一份");
    await settle(paths);
    assert.equal(existsSync(to), false);
    assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
  },
);

test(
  "从旧目录启动、入口换不回来：启动照常（旧目录完好）、记下原因，下次再收拾；搬家时不往下搬",
  posixOnly,
  async (t) => {
    const { root, from, paths, to, disk } = setup(t, { installer: true, located: true });
    interrupted({ paths, from, to });
    const rehome = fakeRehome({ paths, root, codes: [1, 1] });
    const reports = [];
    await settleMove({
      paths,
      env: {},
      platform: "darwin",
      userHome: root,
      runRehome: rehome.run,
      alive: () => false,
      atStartup: true,
      report: (message) => reports.push(message.key),
    });
    assert.deepEqual(reports, ["move.restoreFailed"]);
    assert.equal(existsSync(join(to, "settings.json")), true, "入口可能还指着它，不删");
    assert.equal(readLocationRecord(paths.locationFile, "darwin").moving.to, to);
    await assert.rejects(
      mover({ paths, root, rehome }).run({ folder: disk, by: "cli" }),
      (error) => error.problem?.key === "move.restoreFailed",
    );
  },
);

test(
  "定位文件说搬去的地方不是这次拷的（另一份 OrangeSpeakEasy、别的文件夹）：不碰它，只去掉 moving",
  posixOnly,
  async (t) => {
    const { root, from, paths, to } = setup(t, { installer: true, located: true });
    writeLocation(paths.locationFile, { home: from, moving: { to, pid: 4242, startedAt: new Date().toISOString() } });
    put(join(to, "settings.json"), "另一份");
    put(join(to, "run", "move.json"), JSON.stringify({ state: "done", from: "/elsewhere", startedAt: hoursAgo(100) }));
    const reports = [];
    await settleMove({
      paths,
      env: {},
      platform: "darwin",
      userHome: root,
      runRehome: fakeRehome({ paths, root }).run,
      alive: () => false,
      report: (message) => reports.push(message.key),
    });
    assert.equal(readFileSync(join(to, "settings.json"), "utf8"), "另一份");
    assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
    assert.deepEqual(reports, ["move.notOurCopy", "move.recovered"]);
  },
);

test("搬到一半断了以后再搬到同一个地方：先收拾上次的，不让用户自己去清空", posixOnly, async (t) => {
  const { root, from, paths, to, disk } = setup(t, { installer: true, located: true });
  interrupted({ paths, from, to });
  const plan = await mover({ paths, root, rehome: fakeRehome({ paths, root }) }).plan(disk);
  assert.equal(plan.to, to);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
});

test("搬家的那个还在：不启动；从拷了一半的那一份启动：不在它上面启动，说回旧目录", posixOnly, async (t) => {
  const { root, from, paths, to } = setup(t, { located: true });
  const settle = (where, alive) =>
    settleMove({ paths: where, env: {}, platform: "darwin", userHome: root, alive: () => alive });
  writeLocation(paths.locationFile, { home: from, moving: { to, pid: 4242, startedAt: new Date().toISOString() } });
  await assert.rejects(settle(paths, true), (error) => error.problem?.key === "move.inProgress");
  mkdirSync(to);
  const half = resolvePaths({ ORANGESPEAKEASY_HOME: to }, root, "darwin");
  await assert.rejects(settle(half, false), (error) => error.problem?.key === "move.unfinishedCopy");
  // 没在搬：什么都不做
  writeLocation(paths.locationFile, { home: from });
  await settle(paths, false);
  assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), { home: from, moving: null });
});

test(
  "用户目录经过符号链接（/tmp 其实是 /private/tmp）：启动脚本报的真实路径和用户目录算出来的默认位置认作同一个",
  posixOnly,
  async (t) => {
    // 不解开链接的写法当用户目录，启动脚本（pwd -P）交给程序的是解开后的
    const linked = mkdtempSync("/tmp/sm-l-");
    t.after(() => rmSync(linked, { recursive: true, force: true }));
    const real = realpathSync(linked);
    assert.notEqual(linked, real);
    put(join(real, ".orangespeakeasy", "settings.json"), "{}");
    const paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(real, ".orangespeakeasy") }, linked, "darwin");
    const disk = join(real, "disk");
    mkdirSync(disk);
    const move = createMove({
      paths,
      env: {},
      instance: fakeInstance(),
      platform: "darwin",
      userHome: linked,
      bundles: { find: async () => null },
    });
    const plan = await move.plan(join(linked, "disk"));
    assert.equal(plan.to, join(real, "disk", ".orangespeakeasy"));
    await move.run({ folder: join(linked, "disk"), by: "cli" });
    assert.deepEqual(readLocationRecord(paths.locationFile, "darwin"), {
      home: join(real, "disk", ".orangespeakeasy"),
      moving: null,
    });
    // 搬回默认位置（用不解开的写法给）：定位文件删掉
    const back = createMove({
      paths: resolvePaths({ ORANGESPEAKEASY_HOME: join(real, "disk", ".orangespeakeasy") }, linked, "darwin"),
      env: {},
      instance: fakeInstance(),
      platform: "darwin",
      userHome: linked,
      bundles: { find: async () => null },
    });
    await back.run({ folder: linked, by: "cli" });
    assert.equal(existsSync(paths.locationFile), false);
    assert.equal(existsSync(join(real, ".orangespeakeasy", "settings.json")), true);
  },
);
