import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { buildHelper, ensureHelper, helperNeedsBuild, helperPaths } from "../../src/cli/native-helper.mjs";

// 这些按 macOS 的写法查（路径也按 POSIX 拼）；Windows 的那份在后面单独查
const paths = helperPaths("/pkg", "darwin");
const SWIFT_FILES = { "main.swift": "print(1)", "Matcher.swift": "struct Matcher {}" };
/** 假的文件系统：路径 → 内容，没有的文件读出来是 null */
const filesOf = (files) => (file) => (file in files ? Buffer.from(files[file]) : null);
const stampOf = (source) => createHash("sha256").update(source).digest("hex");
/** 源码目录里的文件按名字排好、带着名字拼起来算指纹（native-helper.mjs 的 sourceContent） */
const fingerprintOf = (files) =>
  stampOf(
    Buffer.concat(
      Object.keys(files)
        .sort()
        .flatMap((name) => [Buffer.from(`${name}\0`), Buffer.from(files[name]), Buffer.from("\0")]),
    ),
  );
/** 假的 native/mac 目录：几个 Swift 文件，加一个测试目录（不算进指纹、不编进去） */
const swiftSource = (files = SWIFT_FILES) =>
  Object.fromEntries(Object.entries(files).map(([name, content]) => [join(paths.source, name), content]));
const swiftDir =
  (files = SWIFT_FILES) =>
  (dir) =>
    dir === paths.source ? [...Object.keys(files), "tests"] : null;
const SOURCE_FILES = Object.keys(SWIFT_FILES)
  .sort()
  .map((name) => join(paths.source, name));

/** 编译用到的外部动作全换成记录 */
function fakeBuild(run) {
  const build = {
    written: {},
    removed: [],
    options: {
      run,
      mkdir: () => {},
      read: filesOf(swiftSource()),
      list: swiftDir(),
      platform: "darwin",
      write: (file, content) => {
        build.written[file] = content;
      },
      remove: (file) => build.removed.push(file),
    },
  };
  return build;
}

test("可执行文件、源码、指纹文件的位置", () => {
  assert.deepEqual(paths, {
    source: join("/pkg", "native", "mac"),
    binary: join("/pkg", "build", "key-helper"),
    stamp: join("/pkg", "build", "key-helper.source-sha256"),
  });
});

test("没有可执行文件就要编译", () => {
  assert.equal(helperNeedsBuild(paths, filesOf(swiftSource()), swiftDir()), true);
});

test("可执行文件是从现在这份源码编出来的，就不用再编；测试目录里的改动不算", () => {
  const files = { ...swiftSource(), [paths.binary]: "x", [paths.stamp]: `${fingerprintOf(SWIFT_FILES)}\n` };
  assert.equal(helperNeedsBuild(paths, filesOf(files), swiftDir()), false);
});

test("任何一个源码文件改过、多了一个，或者说不清可执行文件是从哪份源码来的，就要重新编", () => {
  const built = { [paths.binary]: "x", [paths.stamp]: fingerprintOf(SWIFT_FILES) };
  const changed = { ...SWIFT_FILES, "main.swift": "print(2)" };
  assert.equal(helperNeedsBuild(paths, filesOf({ ...built, ...swiftSource(changed) }), swiftDir(changed)), true);
  const added = { ...SWIFT_FILES, "Taps.swift": "" };
  assert.equal(helperNeedsBuild(paths, filesOf({ ...built, ...swiftSource(added) }), swiftDir(added)), true);
  assert.equal(helperNeedsBuild(paths, filesOf({ ...swiftSource(), [paths.binary]: "x" }), swiftDir()), true);
});

test("只有可执行文件、没有源码时照用不误", () => {
  assert.equal(
    helperNeedsBuild(paths, filesOf({ [paths.binary]: "x" }), () => null),
    false,
  );
});

test("平时只编本机的架构，编完记下是从哪份源码来的", () => {
  const calls = [];
  const build = fakeBuild((command, args) => calls.push([command, ...args]));
  buildHelper("/pkg", build.options);
  assert.deepEqual(calls, [["swiftc", "-O", "-o", paths.binary, ...SOURCE_FILES]]);
  assert.deepEqual(build.written, { [paths.stamp]: `${fingerprintOf(SWIFT_FILES)}\n` });
});

test("发布时两种芯片各编一份再合成一个文件，中间文件删掉", () => {
  const calls = [];
  const build = fakeBuild((command, args) => calls.push([command, ...args]));
  buildHelper("/pkg", { ...build.options, universal: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call[call.indexOf("-target") + 1]),
    ["arm64-apple-macos12.0", "x86_64-apple-macos12.0"],
  );
  for (const call of calls.slice(0, 2)) assert.deepEqual(call.slice(-SOURCE_FILES.length), SOURCE_FILES);
  assert.deepEqual(calls[2], [
    "lipo",
    "-create",
    "-output",
    paths.binary,
    `${paths.binary}-arm64`,
    `${paths.binary}-x86_64`,
  ]);
  assert.deepEqual(build.removed, [`${paths.binary}-arm64`, `${paths.binary}-x86_64`]);
  assert.deepEqual(Object.keys(build.written), [paths.stamp]);
});

test("没装编译工具时说清楚要装什么；没编成就不留指纹，免得下次以为已经编好了", () => {
  const build = fakeBuild(() => {
    throw Object.assign(new Error("spawnSync swiftc ENOENT"), { code: "ENOENT" });
  });
  assert.throws(() => buildHelper("/pkg", build.options), /xcode-select --install/);
  assert.deepEqual(build.written, {});
});

test("编译出错时把编译器的话带出来", () => {
  const build = fakeBuild(() => {
    throw Object.assign(new Error("Command failed"), {
      status: 1,
      stderr: Buffer.from("main.swift:3: error: 不认识的名字"),
    });
  });
  assert.throws(() => buildHelper("/pkg", build.options), /不认识的名字/);
});

test("ensureHelper：要编才编，动手之前先说一声，并说明这次编没编", () => {
  const calls = [];
  const said = [];
  const build = fakeBuild((command) => calls.push(command));
  const onBuild = () => said.push("要编了");
  const upToDate = filesOf({ ...swiftSource(), [paths.binary]: "x", [paths.stamp]: fingerprintOf(SWIFT_FILES) });

  assert.equal(ensureHelper("/pkg", { ...build.options, read: upToDate, onBuild }), false);
  assert.deepEqual([calls, said], [[], []]);
  assert.equal(ensureHelper("/pkg", { ...build.options, onBuild }), true);
  assert.deepEqual([calls, said], [["swiftc"], ["要编了"]]);
});

// ---------- Windows：native/windows/ 是一个 Go 模块，在 Mac 上交叉编译 ----------

const win = helperPaths("C:/pkg", "win32");
const GO_FILES = {
  "go.mod": "module orangespeakeasy/keyhelper\n",
  "main_windows.go": "package main",
  "keys.go": "package main",
};
/** 假的 native/windows 目录：几个 Go 文件加一个测试文件（测试文件不算进指纹） */
const goModule = (files = GO_FILES) => ({
  read: filesOf(Object.fromEntries(Object.entries(files).map(([name, content]) => [join(win.source, name), content]))),
  list: (dir) => (dir === win.source ? [...Object.keys(files), "keys_test.go"] : null),
});

test("Windows：可执行文件是 build/key-helper.exe，源码是 native/windows 这个 Go 模块", () => {
  assert.deepEqual(win, {
    source: join("C:/pkg", "native", "windows"),
    binary: join("C:/pkg", "build", "key-helper.exe"),
    stamp: join("C:/pkg", "build", "key-helper.exe.source-sha256"),
  });
});

test("Windows：在 Mac 上用项目自带的 Go 交叉编译成不弹黑窗口的 exe，记下源码的指纹", () => {
  const calls = [];
  const written = {};
  const { read, list } = goModule();
  buildHelper("C:/pkg", {
    platform: "win32",
    host: "darwin",
    run: (command, args, options) => calls.push({ command, args, cwd: options.cwd, env: options.env }),
    mkdir: () => {},
    read,
    list,
    write: (file, content) => {
      written[file] = content;
    },
  });
  assert.equal(calls.length, 1);
  const [{ command, args, cwd, env }] = calls;
  assert.equal(command, join("C:/pkg", "scripts", "build", "go.sh"));
  assert.deepEqual(args, ["build", "-trimpath", "-ldflags", "-s -w -H windowsgui", "-o", win.binary, "."]);
  assert.equal(cwd, win.source);
  assert.deepEqual([env.GOOS, env.GOARCH, env.CGO_ENABLED], ["windows", "amd64", "0"]);
  assert.deepEqual(Object.keys(written), [win.stamp]);
  // 编好之后就不用再编；改了任何一个 Go 文件要重编，改测试文件不用
  const built = (files) => {
    const module = goModule(files);
    return (file) =>
      file === win.binary
        ? Buffer.from("exe")
        : file === win.stamp
          ? Buffer.from(written[win.stamp])
          : module.read(file);
  };
  assert.equal(helperNeedsBuild(win, built(GO_FILES), list), false);
  assert.equal(helperNeedsBuild(win, built({ ...GO_FILES, "keys.go": "package main // 改过" }), list), true);
});

test("Windows：在 Windows 上从源码跑时用装着的 go；没装就说要装 Go", () => {
  const { read, list } = goModule();
  const calls = [];
  const options = { platform: "win32", host: "win32", mkdir: () => {}, read, list, write: () => {} };
  buildHelper("C:/pkg", { ...options, run: (command) => calls.push(command) });
  assert.deepEqual(calls, ["go"]);
  const missing = () => {
    throw Object.assign(new Error("spawnSync go ENOENT"), { code: "ENOENT" });
  };
  assert.throws(() => buildHelper("C:/pkg", { ...options, run: missing }), /Go 1\.27/);
});
