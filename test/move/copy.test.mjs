import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { classifyHome, copyHome, measureHome, verifyCopy } from "../../src/move/copy.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

const posixOnly = { skip: process.platform === "win32" && "符号链接、权限位是 macOS 的事" };

function setup(t) {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = realpathSync(mkdtempSync(join(base, "sm-c-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "old");
  return { root, home, paths: resolvePaths({ ORANGESPEAKEASY_HOME: home }) };
}

function put(file, content = "x") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

test("分清哪些是 OrangeSpeakEasy 的、要搬；哪些是半截的、不搬但删；不认识的不搬也不删", (t) => {
  const { home, paths } = setup(t);
  for (const name of [
    "bin/orangespeakeasy",
    "app/package.json",
    "runtime/x",
    "settings.json",
    "vocabulary.json",
    "gemini-key.bin",
    "openai-key.app.bin",
    "data/history.db",
    "models/m/model.bin",
    "logs/main.log",
    "cache/Local State",
    "run/daemon.pid",
    ".update-0.12.0-1a2b3c4d/x",
    ".install.AbCd12/x",
    "app.old/x",
    "runtime.old.3/x",
    "notes.txt",
    "Backups/a",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
  ]) {
    put(join(home, name));
  }
  const { move, leftovers, unknown } = classifyHome(paths);
  assert.deepEqual(move.sort(), [
    "app",
    "bin",
    "cache",
    "data",
    "gemini-key.bin",
    "logs",
    "models",
    "openai-key.app.bin",
    "runtime",
    "settings.json",
    "vocabulary.json",
  ]);
  // 系统在文件夹里自己放的（访达的 .DS_Store、资源管理器的 Thumbs.db、desktop.ini）也不搬、跟旧目录一起删：
  // 不然旧目录删不掉，MOVED.json 一直留着
  assert.deepEqual(leftovers.sort(), [
    ".DS_Store",
    ".install.AbCd12",
    ".update-0.12.0-1a2b3c4d",
    "Thumbs.db",
    "app.old",
    "desktop.ini",
    "run",
    "runtime.old.3",
  ]);
  assert.deepEqual(unknown.sort(), ["Backups", "notes.txt"]);
});

test("Windows 的摆法：versions、current 要搬，versions 里只搬 current 指着的那一个", async (t) => {
  const { root, home, paths } = setup(t);
  put(join(home, "current"), "0.12.0-1a2b3c4d");
  put(join(home, "versions", "0.12.0-1a2b3c4d", "app", "package.json"));
  put(join(home, "versions", "0.11.0-99999999", "app", "package.json"));
  put(join(home, "settings.json"));
  const plan = classifyHome(paths);
  assert.deepEqual(plan.move.sort(), ["current", "settings.json", "versions"]);
  const to = join(root, "new", ".orangespeakeasy");
  assert.deepEqual(measureHome({ from: home, plan }), { files: 3, bytes: Buffer.byteLength("0.12.0-1a2b3c4d") + 2 });
  await copyHome({ from: home, to, plan });
  assert.equal(existsSync(join(to, "versions", "0.12.0-1a2b3c4d", "app", "package.json")), true);
  assert.equal(existsSync(join(to, "versions", "0.11.0-99999999")), false);
  assert.equal(readFileSync(join(to, "current"), "utf8"), "0.12.0-1a2b3c4d");
});

test("拷过去：内容、修改时间原样；不认识的、半截的、run 都不拷；缓存里 Chromium 的单实例锁不拷；一个文件报一次进度", async (t) => {
  const { root, home, paths } = setup(t);
  put(join(home, "settings.json"), '{"hotkey":"fn"}');
  put(join(home, "data", "Recordings", "a.webm"), "录音");
  put(join(home, "cache", "Local State"), "钥匙");
  put(join(home, "cache", "SingletonCookie"), "x");
  put(join(home, "run", "update.lock"), "123");
  put(join(home, "notes.txt"));
  const to = join(root, "new", ".orangespeakeasy");
  const plan = classifyHome(paths);
  const progress = [];
  const stats = await copyHome({ from: home, to, plan, onProgress: (done) => progress.push(done) });
  assert.equal(readFileSync(join(to, "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(readFileSync(join(to, "data", "Recordings", "a.webm"), "utf8"), "录音");
  assert.equal(readFileSync(join(to, "cache", "Local State"), "utf8"), "钥匙");
  assert.equal(existsSync(join(to, "cache", "SingletonCookie")), false);
  assert.equal(existsSync(join(to, "run")), false);
  assert.equal(existsSync(join(to, "notes.txt")), false);
  // 修改时间原样（utimes 只精确到毫秒，取整可能差 1）
  const drift = statSync(join(to, "settings.json")).mtimeMs - statSync(join(home, "settings.json")).mtimeMs;
  assert.ok(Math.abs(drift) < 2, `差了 ${drift} 毫秒`);
  assert.deepEqual(stats, { files: 3, bytes: Buffer.byteLength('{"hotkey":"fn"}录音钥匙') });
  assert.deepEqual(measureHome({ from: home, plan }), stats);
  assert.deepEqual(
    progress.map((done) => done.files),
    [1, 2, 3],
  );
  assert.deepEqual(progress.at(-1), stats);
});

test(
  "符号链接原样拷（Electron 框架里的相对链接拷成指向旧目录的绝对路径的话，旧目录一删程序就起不来）；可执行的还是可执行",
  posixOnly,
  async (t) => {
    const { root, home, paths } = setup(t);
    const versions = join(home, "runtime", "Electron.app", "Contents", "Frameworks", "E.framework", "Versions");
    put(join(versions, "A", "E"), "库");
    symlinkSync("A", join(versions, "Current"));
    symlinkSync("Versions/Current/E", join(versions, "..", "E"));
    const electron = join(home, "runtime", "Electron.app", "Contents", "MacOS", "Electron");
    put(electron, "#!/bin/sh\n");
    chmodSync(electron, 0o755);
    // Chromium 的单实例锁是个指向"主机名-进程号"的链接
    mkdirSync(join(home, "cache"));
    symlinkSync("host-123", join(home, "cache", "SingletonLock"));

    const to = join(root, "new", ".orangespeakeasy");
    await copyHome({ from: home, to, plan: classifyHome(paths) });
    const copied = join(to, "runtime", "Electron.app", "Contents", "Frameworks", "E.framework");
    assert.equal(readlinkSync(join(copied, "Versions", "Current")), "A");
    assert.equal(readlinkSync(join(copied, "E")), "Versions/Current/E");
    assert.equal(readFileSync(join(copied, "E"), "utf8"), "库");
    assert.equal(statSync(join(to, "runtime", "Electron.app", "Contents", "MacOS", "Electron")).mode & 0o777, 0o755);
    assert.throws(() => lstatSync(join(to, "cache", "SingletonLock")), { code: "ENOENT" });
    assert.doesNotThrow(() => verifyCopy({ from: home, to }));
  },
);

test("核对拷好的：有绝对路径的链接、指出新目录的链接都不行（删了旧目录就断）", posixOnly, (t) => {
  const { root } = setup(t);
  const to = join(root, "new");
  put(join(to, "a", "file"));
  symlinkSync("file", join(to, "a", "ok"));
  assert.doesNotThrow(() => verifyCopy({ from: root, to }));
  symlinkSync(join(root, "elsewhere"), join(to, "a", "absolute"));
  assert.throws(() => verifyCopy({ from: root, to }), /absolute/);
  rmSync(join(to, "a", "absolute"));
  symlinkSync("../../outside", join(to, "a", "escape"));
  assert.throws(() => verifyCopy({ from: root, to }), /escape/);
});

test("拷的时候目标已经有同名的：报错，不覆盖", async (t) => {
  const { root, home, paths } = setup(t);
  put(join(home, "settings.json"), "旧");
  const to = join(root, "new", ".orangespeakeasy");
  put(join(to, "settings.json"), "别人的");
  await assert.rejects(copyHome({ from: home, to, plan: classifyHome(paths) }), { code: "ERR_FS_CP_EEXIST" });
  assert.equal(readFileSync(join(to, "settings.json"), "utf8"), "别人的");
});

/** 开发依赖里的 Electron（npm 的 electron 包交出的是可执行文件的路径） */
const ELECTRON = createRequire(import.meta.url)("electron");

test("在 Electron 里拷、量、核对：.asar 按普通文件（运行环境里有 default_app.asar；命令行就跑在自带的 Electron 上）", {
  skip: !existsSync(ELECTRON) && "没装 Electron",
}, (t) => {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = realpathSync(mkdtempSync(join(base, "sm-a-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, "old");
  const to = join(root, "new");
  // 随便什么内容：Electron 只看名字，以 .asar 结尾就当压缩包去读
  mkdirSync(join(from, "runtime"), { recursive: true });
  writeFileSync(join(from, "runtime", "default_app.asar"), "不是压缩包，照原样拷");
  const script = join(root, "copy.mjs");
  const module = pathToFileURL(resolve(import.meta.dirname, "../../src/move/copy.mjs")).href;
  writeFileSync(
    script,
    `import { copyHome, measureHome, verifyCopy } from ${JSON.stringify(module)};
const plan = { move: ["runtime"], leftovers: [], unknown: [], current: null };
const measured = measureHome({ from: process.argv[2], plan });
const copied = await copyHome({ from: process.argv[2], to: process.argv[3], plan });
verifyCopy({ to: process.argv[3] });
console.log(JSON.stringify({ measured, copied }));
`,
  );
  const run = spawnSync(ELECTRON, [script, from, to], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  const { measured, copied } = JSON.parse(run.stdout);
  assert.equal(measured.files, 1);
  assert.equal(copied.files, 1);
  // 这里自己读也要按普通文件读：发版前的检查用 Electron 自带的 Node 跑这些测试，它同样会把 .asar 当压缩包
  const before = process.noAsar;
  process.noAsar = true;
  try {
    assert.equal(readFileSync(join(to, "runtime", "default_app.asar"), "utf8"), "不是压缩包，照原样拷");
  } finally {
    process.noAsar = before;
  }
});
