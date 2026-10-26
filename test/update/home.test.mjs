import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createTranslator, LocalizedError } from "../../src/i18n/index.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";
import { createHomes, homeArch, isHomeCopy } from "../../src/update/home.mjs";
import { packObject } from "../../src/update/objects.mjs";
import { createRelease } from "../../src/update/release.mjs";
import { publishTrees } from "../helpers/release.mjs";

const zh = createTranslator("zh-CN");
// 安装脚本按系统分：macOS 是 install.sh，Windows 是 install.ps1
const macOnly = { skip: process.platform === "win32" && "macOS 的 install.sh" };
const windowsOnly = { skip: process.platform !== "win32" && "Windows 的 install.ps1" };

let dir;
let paths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-home-"));
  paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "home") }, undefined, process.platform);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * 在 release 下摆一个假的发布：一棵家目录的树（app 里带着安装脚本和 package.json，runtime 里一个大一点的文件），
 * 切块放到下载地址上
 */
async function publish(release, version, { script, scriptName, target }) {
  const tree = mkdtempSync(join(dir, "tree-"));
  mkdirSync(join(tree, "app"));
  mkdirSync(join(tree, "runtime"));
  writeFileSync(join(tree, "app", scriptName), script);
  writeFileSync(join(tree, "app", "package.json"), JSON.stringify({ version }));
  writeFileSync(join(tree, "runtime", "electron"), RUNTIME);
  return publishTrees(release, version, { [target]: tree });
}

/** 运行环境：几块大小，各版本一样（更新时从本机拷） */
const RUNTIME = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251));

const homesFor = (release, options = {}) => {
  const env = { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: release, ...options.env };
  return createHomes({
    paths,
    env,
    release: createRelease({ env }),
    stdio: ["ignore", "ignore", "ignore"],
    arch: "arm64",
    ...options,
  });
};

test("家目录里装的是哪个版本：Mac 看 app/package.json，Windows 看 current 指着的那个版本；没装、读不出的是 null", () => {
  const mac = createHomes({ paths, env: {}, release: null, stdio: "ignore", platform: "darwin" });
  assert.equal(mac.find(), null);
  mkdirSync(paths.appDir, { recursive: true });
  writeFileSync(join(paths.appDir, "package.json"), JSON.stringify({ version: "0.10.0" }));
  assert.deepEqual(mac.find(), { version: "0.10.0" });
  writeFileSync(join(paths.appDir, "package.json"), "{坏的");
  assert.equal(mac.find(), null);

  const win = createHomes({ paths, env: {}, release: null, stdio: "ignore", platform: "win32" });
  assert.equal(win.find(), null);
  mkdirSync(join(paths.versionsDir, "0.10.0-1a2b3c4d", "app"), { recursive: true });
  writeFileSync(
    join(paths.versionsDir, "0.10.0-1a2b3c4d", "app", "package.json"),
    JSON.stringify({ version: "0.10.0" }),
  );
  writeFileSync(paths.currentFile, "0.10.0-1a2b3c4d");
  assert.deepEqual(win.find(), { version: "0.10.0" });
});

test("这份程序是不是家目录里装的那一份：经过符号链接也认得出；Windows 上要在 versions 下某个版本的 app 里", () => {
  mkdirSync(paths.appDir, { recursive: true });
  assert.equal(isHomeCopy(paths.appDir, paths, "darwin"), true);
  const link = join(dir, "link");
  symlinkSync(paths.home, link);
  assert.equal(isHomeCopy(join(link, "app"), paths, "darwin"), true);
  assert.equal(isHomeCopy(dir, paths, "darwin"), false);
  assert.equal(isHomeCopy(join(dir, "nowhere"), paths, "darwin"), false);

  const version = join(paths.versionsDir, "0.1.0-1a2b3c4d", "app");
  mkdirSync(version, { recursive: true });
  assert.equal(isHomeCopy(version, paths, "win32"), true);
  assert.equal(isHomeCopy(paths.appDir, paths, "win32"), false, "0.9.2 那样直接放在 app 里的不算");
});

test("按什么芯片取清单：和 install.sh 一样，Apple 芯片上转译跑的也取 arm64；Windows 只有 x64", () => {
  assert.equal(homeArch("darwin", "arm64"), "arm64");
  assert.equal(
    homeArch("darwin", "x64", () => true),
    "arm64",
  );
  assert.equal(
    homeArch("darwin", "x64", () => false),
    "x64",
  );
  assert.equal(homeArch("win32", "x64"), "x64");
});

test(
  "先拼好：照清单拼进家目录里一个 .update- 开头的目录，本机有的块拷、缺的才下；上次留下的先清掉，坏了的不留下",
  macOnly,
  async () => {
    const release = join(dir, "release");
    const channel = await publish(release, "9.9.9", {
      script: "exit 0\n",
      scriptName: "install.sh",
      target: "darwin-arm64",
    });
    const homes = homesFor(release);
    const cacheDir = paths.updateCacheDir;
    // 装着的那一份：运行环境一样
    mkdirSync(paths.runtimeDir, { recursive: true });
    writeFileSync(join(paths.runtimeDir, "electron"), RUNTIME);
    // 上次被杀掉留下的
    mkdirSync(join(paths.home, ".update-9.9.8-deadbeef"), { recursive: true });

    // 更新那一层拿到锁以后先清上次留下的
    assert.equal(homes.clean(), null);
    assert.equal(existsSync(join(paths.home, ".update-9.9.8-deadbeef")), false);
    const staged = await homes.stage(channel, { seeds: homes.seeds(), cacheDir });
    assert.match(staged.dir, /\.update-9\.9\.9-[0-9a-f]{8}$/);
    assert.equal(join(staged.dir, ".."), paths.home);
    assert.deepEqual(readdirSync(staged.dir).sort(), ["app", "runtime"]);
    assert.deepEqual(readFileSync(join(staged.dir, "runtime", "electron")), RUNTIME);
    assert.equal(staged.reusedBytes, RUNTIME.length);
    // 下了多少：缺的块（在缓存里）加上清单本身
    const fetched = readdirSync(cacheDir).reduce((sum, name) => sum + statSync(join(cacheDir, name)).size, 0);
    const manifestBytes = statSync(join(release, "store", channel.targets["darwin-arm64"])).size;
    assert.equal(staged.downloadedBytes, fetched + manifestBytes);
    assert.equal(existsSync(join(paths.home, ".update-9.9.8-deadbeef")), false);
    staged.discard();
    assert.equal(existsSync(staged.dir), false);

    // 下载地址上的块坏了：报哪个对象坏了，拼了一半的不留下
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(paths.runtimeDir, { recursive: true });
    const manifestSha = channel.targets["darwin-arm64"];
    for (const name of readdirSync(join(release, "store"))) {
      if (name !== manifestSha) writeFileSync(join(release, "store", name), packObject(Buffer.from(`坏的 ${name}`)));
    }
    await assert.rejects(homes.stage(channel, { seeds: homes.seeds(), cacheDir }), (error) => {
      assert.ok(error instanceof LocalizedError);
      assert.match(zh.text(error.problem), /下载的更新数据（[0-9a-f]{12}）与发布的不符/);
      return true;
    });
    assert.deepEqual(
      readdirSync(paths.home).filter((name) => name.startsWith(".update-")),
      [],
      "拼了一半的删掉了",
    );

    // 发布里没有这种芯片的
    await assert.rejects(homes.stage({ ...channel, targets: {} }, { seeds: [], cacheDir }), (error) => {
      assert.match(zh.text(error.problem), /9\.9\.9 的发布中没有这台电脑用的更新（darwin-arm64）/);
      return true;
    });
  },
);

test(
  "装：让拼好的那一份自带的安装脚本从它装（不再联网），指定装到哪、只装不启动，不带版本和下载地址",
  macOnly,
  async () => {
    const release = join(dir, "release");
    const record = join(dir, "record");
    // 假的安装脚本：记下拿到的参数和几个环境变量，按要求的退出码退出
    const channel = await publish(release, "9.9.9", {
      script: `printf '%s|%s|%s|%s|%s|%s|%s|%s\\n' "$*" "$ORANGESPEAKEASY_HOME" "\${ORANGESPEAKEASY_VERSION:-}" "\${ORANGESPEAKEASY_INSTALL_BASE:-}" "\${ELECTRON_RUN_AS_NODE:-}" "$ORANGESPEAKEASY_INSTALL_FROM" "\${ORANGESPEAKEASY_INSTALL_DIR:-}" "\${ORANGESPEAKEASY_PREVIOUS_HOME:-}" > ${JSON.stringify(record)}\nexit "\${FAKE_EXIT:-0}"\n`,
      scriptName: "install.sh",
      target: "darwin-arm64",
    });
    // 第一次安装时设的 ORANGESPEAKEASY_INSTALL_DIR 会一路带进命令行和 App：不带给更新，不然安装脚本说它和 ORANGESPEAKEASY_HOME 不能同时设
    const env = {
      ELECTRON_RUN_AS_NODE: "1",
      ORANGESPEAKEASY_VERSION: "v1.0.0",
      ORANGESPEAKEASY_INSTALL_DIR: "/Volumes/Data",
      ORANGESPEAKEASY_PREVIOUS_HOME: "/old/.orangespeakeasy",
    };
    const homes = homesFor(release, { env });
    const staged = await homes.stage(channel, { seeds: [], cacheDir: paths.updateCacheDir });
    assert.equal(await homes.install(staged), 0);
    assert.equal(readFileSync(record, "utf8"), `--no-start|${paths.home}||||${staged.dir}||\n`);

    const failing = homesFor(release, { env: { FAKE_EXIT: "3" } });
    assert.equal(await failing.install(staged), 3);
    staged.discard();
  },
);

test(
  "装：命令的链接原来建在哪，这次还建在那里（从 App 起时 PATH 是精简的，安装脚本自己挑会挑到别处）",
  macOnly,
  async () => {
    const release = join(dir, "release");
    const record = join(dir, "bin-record");
    const channel = await publish(release, "9.9.9", {
      script: `printf '%s' "\${ORANGESPEAKEASY_BIN_DIR:-}" > ${JSON.stringify(record)}\n`,
      scriptName: "install.sh",
      target: "darwin-arm64",
    });
    const linkDir = join(dir, "usr-local-bin");
    mkdirSync(linkDir);
    mkdirSync(paths.binDir, { recursive: true });
    symlinkSync(join(paths.binDir, "orangespeakeasy"), join(linkDir, "orangespeakeasy"));
    writeFileSync(paths.linksFile, `${join(dir, "gone", "orangespeakeasy")}\n${join(linkDir, "orangespeakeasy")}\n`);
    const { ORANGESPEAKEASY_BIN_DIR: _unset, ...env } = process.env;
    const homes = createHomes({
      paths,
      env: { ...env, ORANGESPEAKEASY_INSTALL_BASE: release },
      release: createRelease({ env: { ...env, ORANGESPEAKEASY_INSTALL_BASE: release } }),
      stdio: ["ignore", "ignore", "ignore"],
      arch: "arm64",
    });
    const staged = await homes.stage(channel, { seeds: [], cacheDir: paths.updateCacheDir });
    assert.equal(await homes.install(staged), 0);
    assert.equal(readFileSync(record, "utf8"), linkDir);
    staged.discard();
  },
);

test("启动：跑家目录里装好的 orangespeakeasy start，带上家目录，不带 ELECTRON_RUN_AS_NODE", macOnly, async () => {
  const record = join(dir, "start-record");
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(
    join(paths.binDir, "orangespeakeasy"),
    `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$ORANGESPEAKEASY_HOME" "\${ELECTRON_RUN_AS_NODE:-}" > ${JSON.stringify(record)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const homes = homesFor(join(dir, "release"), { env: { ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(await homes.start(), 0);
  assert.equal(readFileSync(record, "utf8"), `start|${paths.home}|\n`);
});

test(
  "Windows：install.ps1 按 UTF-8 读进来再跑，装哪、装哪个版本、只装不启动都走环境变量；启动走 orangespeakeasy.cmd",
  windowsOnly,
  async () => {
    const release = join(dir, "release");
    const record = join(dir, "record");
    // 假的安装脚本：记下拿到的几个环境变量（带一句中文：要按 UTF-8 读才对得上），按要求的结果收尾
    const channel = await publish(release, "9.9.9", {
      script: `& { Set-Content -Encoding UTF8 -Path $env:RECORD -Value "装好了|$($env:ORANGESPEAKEASY_HOME)|$($env:ORANGESPEAKEASY_VERSION)|$($env:ORANGESPEAKEASY_NO_START)|$($env:ORANGESPEAKEASY_INSTALL_BASE)|$($env:ORANGESPEAKEASY_INSTALL_FROM)"; $global:LASTEXITCODE = [int]$env:FAKE_EXIT }\n`,
      scriptName: "install.ps1",
      target: "win32-x64",
    });
    const homes = homesFor(release, { platform: "win32", arch: "x64", env: { RECORD: record, FAKE_EXIT: "0" } });
    const staged = await homes.stage(channel, { seeds: [], cacheDir: paths.updateCacheDir });
    // 直接拼进 versions 下一个新目录，名字和 install.ps1 起的同一种
    assert.equal(join(staged.dir, ".."), paths.versionsDir);
    assert.match(staged.dir, /9\.9\.9-[0-9a-f]{8}$/);
    assert.equal(await homes.install(staged), 0);
    const said = readFileSync(record, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    assert.equal(said, `装好了|${paths.home}||1||${staged.dir}`);
    const failing = homesFor(release, { platform: "win32", arch: "x64", env: { RECORD: record, FAKE_EXIT: "1" } });
    assert.equal(await failing.install(staged), 1);
    staged.discard();

    // 启动：家目录的路径里带空格也跑得起来；说的话经管道转出来（App 起的更新进程用的那种）
    const spaced = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "my home") }, undefined, "win32");
    const startRecord = join(dir, "start record");
    mkdirSync(spaced.binDir, { recursive: true });
    writeFileSync(
      join(spaced.binDir, "orangespeakeasy.cmd"),
      `@echo off\r\necho %*^|%ORANGESPEAKEASY_HOME%> "${startRecord}"\r\n`,
    );
    const spacedHomes = createHomes({
      paths: spaced,
      env: process.env,
      release: null,
      stdio: "forward",
      platform: "win32",
    });
    assert.equal(await spacedHomes.start(), 0);
    assert.equal(readFileSync(startRecord, "utf8").trim(), `start|${spaced.home}`);
  },
);
