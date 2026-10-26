import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { locationFileOf, writeLocation } from "../../src/storage/location.mjs";
import {
  ensureHome,
  installedHomeOf,
  keyFile,
  legacyDataDir,
  oldAppKeyFile,
  resolvePaths,
} from "../../src/storage/paths.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));
// 按 macOS 的写法拼的路径，在 Windows 的临时目录里拼不出来
const posixOnly = { skip: process.platform === "win32" && "按 macOS 的路径写" };

/** 家目录里的那些：除了定位文件，都在家目录里 */
const inside = (paths) => Object.entries(paths).filter(([name]) => name !== "locationFile");

test("所有东西都在家目录下的 .orangespeakeasy 这一个目录里；目录以外只有一个定位文件", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  assert.equal(paths.home, "/Users/someone/.orangespeakeasy");
  for (const [name, path] of inside(paths)) {
    assert.ok(path === paths.home || path.startsWith("/Users/someone/.orangespeakeasy/"), `${name}: ${path}`);
  }
  assert.equal(
    paths.locationFile,
    "/Users/someone/Library/Application Support/com.juzihai.orangespeakeasy/location.json",
  );
});

test("程序、你的东西、运行时产生的，各在各的位置", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  const inHome = Object.fromEntries(inside(paths).map(([name, path]) => [name, path.slice(paths.home.length + 1)]));
  assert.deepEqual(inHome, {
    home: "",
    // 程序本身：安装时放进去，升级时整个换掉
    binDir: "bin",
    linksFile: "bin/links",
    appDir: "app",
    runtimeDir: "runtime",
    // Windows 上每个版本一个目录，current 记着现在用哪个
    versionsDir: "versions",
    currentFile: "current",
    // 你的东西
    settingsFile: "settings.json",
    vocabularyFile: "vocabulary.json",
    historyDb: "data/history.db",
    recordingsDir: "data/Recordings",
    // 用到时自动下载的本地模型
    modelsDir: "models",
    // 运行时产生的，删了会自己再建
    logFile: "logs/main.log",
    runDir: "run",
    controlSocket: "run/control.sock",
    pidFile: "run/daemon.pid",
    updateCheckFile: "run/update-check.json",
    updateFile: "run/update.json",
    updateLock: "run/update.lock",
    moveFile: "run/move.json",
    updateCacheDir: "run/update-cache",
    cacheDir: "cache",
  });
});

test("每家模型一把 key，App 和命令行共用一个文件；Gemini 的文件名和 0.3 以前一样；0.7.0 及以前 App 那一份另有名字", () => {
  const paths = resolvePaths({}, "/Users/someone", "darwin");
  assert.equal(keyFile(paths, "gemini"), "/Users/someone/.orangespeakeasy/gemini-key.bin");
  assert.equal(oldAppKeyFile(paths, "gemini"), "/Users/someone/.orangespeakeasy/gemini-key.app.bin");
  assert.equal(keyFile(paths, "openai"), "/Users/someone/.orangespeakeasy/openai-key.bin");
  // 润色那一跳的厂商也一样，自定义服务一把
  assert.equal(keyFile(paths, "deepseek"), "/Users/someone/.orangespeakeasy/deepseek-key.bin");
  assert.equal(keyFile(paths, "custom"), "/Users/someone/.orangespeakeasy/custom-key.bin");
  assert.throws(() => keyFile(paths, "../x"), /id/);
  assert.throws(() => oldAppKeyFile(paths, "../x"), /id/);
});

test("ORANGESPEAKEASY_HOME 把整个目录换到别处", () => {
  const paths = resolvePaths({ ORANGESPEAKEASY_HOME: "/tmp/elsewhere" }, "/Users/someone", "darwin");
  for (const [, path] of inside(paths)) assert.ok(path.startsWith("/tmp/elsewhere"), path);
});

test("家目录装在别处时照定位文件找；ORANGESPEAKEASY_HOME 优先于定位文件，都没有才是默认位置", posixOnly, (t) => {
  const user = mkdtempSync(join(tmpdir(), "sm-user-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  assert.equal(resolvePaths({}, user, "darwin").home, join(user, ".orangespeakeasy"));
  const custom = join(user, "Data", ".orangespeakeasy");
  mkdirSync(custom, { recursive: true });
  const file = join(user, "Library", "Application Support", "com.juzihai.orangespeakeasy", "location.json");
  writeLocation(file, custom);
  const paths = resolvePaths({}, user, "darwin");
  assert.equal(paths.home, custom);
  assert.equal(paths.historyDb, join(custom, "data", "history.db"));
  assert.equal(paths.locationFile, file);
  assert.equal(resolvePaths({ ORANGESPEAKEASY_HOME: "/tmp/sm" }, user, "darwin").home, "/tmp/sm");
});

// 要真的读一个 Windows 路径上的文件，只在 Windows 上跑
const windowsOnly = { skip: process.platform !== "win32" && "只在 Windows 上跑" };

test("Windows 上的定位文件在 LOCALAPPDATA 下；照它找到的家目录，控制通道也跟着换", windowsOnly, (t) => {
  const local = mkdtempSync(join(tmpdir(), "sm-local-"));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: local };
  const defaults = resolvePaths(env, "C:\\Users\\someone", "win32");
  assert.equal(defaults.home, "C:\\Users\\someone\\.orangespeakeasy");
  mkdirSync(join(local, "OrangeSpeakEasy"));
  // 定位文件说的家目录要真的在
  const custom = join(local, "Apps", ".orangespeakeasy");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(local, "OrangeSpeakEasy", "location.json"), JSON.stringify({ home: custom }));
  const moved = resolvePaths(env, "C:\\Users\\someone", "win32");
  assert.equal(moved.home, custom);
  assert.equal(moved.versionsDir, join(custom, "versions"));
  assert.notEqual(moved.controlSocket, defaults.controlSocket);
});

test("定位文件坏了：明确报错，不退回默认位置", (t) => {
  const user = mkdtempSync(join(tmpdir(), "sm-user-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  const dir = join(user, "Library", "Application Support", "com.juzihai.orangespeakeasy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "location.json"), "{ 坏了");
  assert.throws(() => resolvePaths({}, user, "darwin"), said(/定位文件/));
  // 设了 ORANGESPEAKEASY_HOME 的不看定位文件（测试、开发用的不受它影响）
  assert.equal(resolvePaths({ ORANGESPEAKEASY_HOME: "/tmp/sm" }, user, "darwin").home, "/tmp/sm");
});

test("ORANGESPEAKEASY_HOME 是空字符串时当作没设，不把文件写到当前目录", () => {
  assert.equal(
    resolvePaths({ ORANGESPEAKEASY_HOME: "" }, "/Users/someone", "darwin").home,
    "/Users/someone/.orangespeakeasy",
  );
});

test("控制通道的路径太长时报错并说明怎么办，不等到监听时才失败", () => {
  const long = `/tmp/${"x".repeat(100)}`;
  assert.throws(
    () => resolvePaths({ ORANGESPEAKEASY_HOME: long }, "/Users/someone", "darwin"),
    said(/太长.*\n.*挪到路径短一些的地方/),
  );
});

test("ORANGESPEAKEASY_HOME 要是绝对路径：相对路径会随着在哪个目录运行命令而变，找不到同一个后台应用", () => {
  for (const relative of ["data", "./data", "../data"]) {
    assert.throws(() => resolvePaths({ ORANGESPEAKEASY_HOME: relative }, "/Users/someone", "darwin"), said(/绝对路径/));
    assert.throws(
      () => resolvePaths({ ORANGESPEAKEASY_HOME: relative }, "C:\\Users\\someone", "win32"),
      said(/绝对路径/),
    );
  }
  // Windows 上 \ 开头的指的是当前那个盘的根，也随在哪运行而变
  assert.throws(
    () => resolvePaths({ ORANGESPEAKEASY_HOME: "\\data" }, "C:\\Users\\someone", "win32"),
    said(/绝对路径/),
  );
  assert.doesNotThrow(() =>
    resolvePaths({ ORANGESPEAKEASY_HOME: "\\\\server\\share\\sm" }, "C:\\Users\\someone", "win32"),
  );
});

test("ensureHome：把目录建出来，只有自己进得去（里面有录音和 key）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "home") });
  ensureHome(paths);
  assertOwnerOnlyDir(paths.home);
  assert.ok(statSync(join(paths.home, "run")).isDirectory());
  // 再来一次不出错，结果一样
  ensureHome(paths);
  assertOwnerOnlyDir(paths.home);
});

test("定位文件说的家目录不在（移动硬盘没接、盘符被别的盘占了）：报找不到，不新建一个空的", posixOnly, (t) => {
  const user = mkdtempSync(join(tmpdir(), "sm-user-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  // 上一级在（比如 D:\ 现在是另一块盘），家目录本身不在
  const missing = join(user, "Data", ".orangespeakeasy");
  mkdirSync(join(user, "Data"));
  writeLocation(join(user, "Library", "Application Support", "com.juzihai.orangespeakeasy", "location.json"), missing);
  assert.throws(() => resolvePaths({}, user, "darwin"), said(/找不到 OrangeSpeakEasy 的目录/));
  assert.equal(statSync(join(user, "Data")).isDirectory(), true);
  assert.throws(() => statSync(missing));
});

test("搬走了的旧目录（里面有 MOVED.json，OrangeSpeakEasy 记着的正是它说的新位置）：说搬去了哪，不在半个旧目录上跑起来", (t) => {
  const user = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  const old = join(user, "old");
  const moved = join(user, "Data", ".orangespeakeasy");
  mkdirSync(old);
  mkdirSync(moved, { recursive: true });
  const env = { ORANGESPEAKEASY_HOME: old };
  writeLocation(locationFileOf(env, user, process.platform), { home: moved });
  writeFileSync(join(old, "MOVED.json"), JSON.stringify({ to: moved }));
  assert.throws(() => resolvePaths(env, user), said(/已经搬到 .*Data/));
  writeFileSync(join(old, "MOVED.json"), "{ 坏了");
  assert.throws(() => resolvePaths(env, user), said(/已经搬到 \?/));
});

test("过期的 MOVED.json（新位置后来卸载了、定位文件没了）：不理它，默认位置照常能用、能重装", (t) => {
  const user = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(user, { recursive: true, force: true }));
  const home = join(user, ".orangespeakeasy");
  mkdirSync(home);
  writeFileSync(join(home, ".DS_Store"), "");
  writeFileSync(join(home, "MOVED.json"), JSON.stringify({ to: join(user, "gone", ".orangespeakeasy") }));
  assert.equal(resolvePaths({}, user).home, home);
  assert.equal(resolvePaths({ ORANGESPEAKEASY_HOME: home }, user).home, home);
  // 从别处搬回了默认位置：旧目录的记号说的就是默认位置，还算数
  const elsewhere = join(user, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "MOVED.json"), JSON.stringify({ to: home }));
  assert.throws(() => resolvePaths({ ORANGESPEAKEASY_HOME: elsewhere }, user), said(/已经搬到/));
});

test("ensureHome：家目录所在的那一层不存在（移动硬盘没接、盘符没了）就报错，不在别处新建", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "unplugged", ".orangespeakeasy") });
  assert.throws(() => ensureHome(paths), said(/先把那块盘接上/));
  assert.throws(() => statSync(join(dir, "unplugged")));
});

test("Windows 上同样是用户目录下的 .orangespeakeasy 一个目录；控制通道是按家目录取名的 named pipe，不在磁盘上", () => {
  const paths = resolvePaths({}, "C:\\Users\\someone", "win32");
  assert.equal(paths.home, "C:\\Users\\someone\\.orangespeakeasy");
  for (const [name, path] of inside(paths)) {
    if (name === "controlSocket") continue;
    assert.ok(path === paths.home || path.startsWith("C:\\Users\\someone\\.orangespeakeasy\\"), `${name}: ${path}`);
  }
  assert.equal(paths.historyDb, "C:\\Users\\someone\\.orangespeakeasy\\data\\history.db");
  assert.match(paths.controlSocket, /^\\\\\.\\pipe\\orangespeakeasy-[0-9a-f]{16}$/);
  // 同一个家目录（大小写不同也是同一个）是同一个；换个家目录就是另一个
  assert.equal(resolvePaths({}, "c:\\users\\SOMEONE", "win32").controlSocket, paths.controlSocket);
  assert.notEqual(
    resolvePaths({ ORANGESPEAKEASY_HOME: "D:\\orangespeakeasy" }, "C:\\Users\\someone", "win32").controlSocket,
    paths.controlSocket,
  );
  // 套接字路径的长度上限是 macOS 的事，pipe 的名字和家目录多长无关
  assert.doesNotThrow(() =>
    resolvePaths({ ORANGESPEAKEASY_HOME: `D:\\${"x".repeat(100)}` }, "C:\\Users\\someone", "win32"),
  );
});

test("0.1 版放数据的地方：家目录的 Application Support/OrangeSpeakEasy；0.1 只有 macOS 版，别的系统上没有", () => {
  assert.equal(legacyDataDir("/Users/someone", "darwin"), "/Users/someone/Library/Application Support/OrangeSpeakEasy");
  assert.equal(legacyDataDir("C:\\Users\\someone", "win32"), null);
});

test("Windows 上装好的那一份：从程序的位置（<家目录>\\versions\\<版本>\\runtime\\electron.exe、旁边有 app）找回家目录；别的摆法是 null", () => {
  // Windows 的路径不分大小写
  const exists = (path) => path.toLowerCase() === "d:\\orangespeakeasy\\versions\\0.9.3-1a2b3c4d\\app\\package.json";
  assert.equal(
    installedHomeOf("D:\\OrangeSpeakEasy\\versions\\0.9.3-1a2b3c4d\\runtime\\electron.exe", exists),
    "D:\\OrangeSpeakEasy",
  );
  assert.equal(
    installedHomeOf("D:\\OrangeSpeakEasy\\Versions\\0.9.3-1a2b3c4d\\Runtime\\Electron.EXE", exists),
    "D:\\OrangeSpeakEasy",
  );
  // 0.9.2 及以前的摆法（家目录里直接是 runtime、app）：新版本的程序不会从那里跑
  assert.equal(
    installedHomeOf("D:\\OrangeSpeakEasy\\runtime\\electron.exe", () => true),
    null,
  );
  // 从源码跑的：node_modules 里的 electron.exe
  assert.equal(installedHomeOf("C:\\dev\\orangespeakeasy\\node_modules\\electron\\dist\\electron.exe", exists), null);
  // 旁边没有 app
  assert.equal(installedHomeOf("E:\\other\\versions\\0.9.3-1a2b3c4d\\runtime\\electron.exe", exists), null);
  assert.equal(
    installedHomeOf("/Users/someone/.orangespeakeasy/runtime/Electron.app/Contents/MacOS/Electron", exists),
    null,
  );
});
