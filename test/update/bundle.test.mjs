import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTranslator, LocalizedError } from "../../src/i18n/index.mjs";
import { bundleOfPackage, createBundles } from "../../src/update/bundle.mjs";
import { appTarget } from "../../src/update/layout.mjs";
import { packObject } from "../../src/update/objects.mjs";
import { createRelease } from "../../src/update/release.mjs";
import { publishTrees } from "../helpers/release.mjs";

const zh = createTranslator("zh-CN");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-up-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// OrangeSpeakEasy.app 只有 macOS 上有：要用系统的 codesign、PlistBuddy
const macOnly = { skip: process.platform !== "darwin" && "macOS 的 OrangeSpeakEasy.app" };

/** 照这个下载地址找 App、换 App 的那一套 */
const bundlesFrom = (env) => createBundles({ env, release: createRelease({ env }) });

const ARCH = process.arch === "arm64" ? "arm64" : "x64";

/**
 * 在 parent 里做一个假的 OrangeSpeakEasy.app：程序是系统的 sleep 换了个名字。sign 为 true 时做临时签名（没有开发者），
 * 和装着的、下载的两边一样，开发者都是"没有"，比得上
 */
function fakeApp(parent, version, { sign = true, bundleId = "com.juzihai.orangespeakeasy" } = {}) {
  const app = join(parent, "OrangeSpeakEasy.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync("/bin/sleep", join(app, "Contents", "MacOS", "OrangeSpeakEasy"));
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>OrangeSpeakEasy</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  if (sign) execFileSync("codesign", ["--sign", "-", "--force", "--deep", app], { stdio: "ignore" });
  return app;
}

/** 照发布的样子把一个 App 切块放到下载地址上（channel.json 只写这一种装法） */
const publishApp = (release, version, app) => publishTrees(release, version, { [appTarget(ARCH)]: app });

const versionOf = (app) =>
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")],
    {
      encoding: "utf8",
    },
  ).trim();

test(
  "找 App：ORANGESPEAKEASY_APP 指的那个；不是 OrangeSpeakEasy（应用标识不对）、不存在的都当没装",
  macOnly,
  async () => {
    const mine = fakeApp(mkdtempSync(join(dir, "a-")), "0.3.0", { sign: false });
    const other = fakeApp(mkdtempSync(join(dir, "b-")), "1.0.0", { sign: false, bundleId: "com.example.other" });
    const find = (path) => bundlesFrom({ ...process.env, ORANGESPEAKEASY_APP: path }).find();
    assert.deepEqual(await find(mine), { path: mine, version: "0.3.0" });
    assert.equal(await find(other), null);
    assert.equal(await find(join(dir, "nowhere", "OrangeSpeakEasy.app")), null);
  },
);

test("找 App：正在跑的那个在哪就是哪（按进程号找到它的应用包）", macOnly, async () => {
  // 要签上名：没签名的程序一运行就被系统以签名无效杀掉，还会留下一份崩溃报告
  const app = fakeApp(mkdtempSync(join(dir, "run-")), "0.4.0");
  const child = spawn(join(app, "Contents", "MacOS", "OrangeSpeakEasy"), ["30"], { stdio: "ignore" });
  try {
    const { ORANGESPEAKEASY_APP: _ignored, ...env } = process.env;
    const found = await bundlesFrom(env).find({ pid: child.pid });
    assert.deepEqual(found, { path: app, version: "0.4.0" });
  } finally {
    child.kill();
  }
});

test("换 App：照清单拼好、核对签名，放在旁边（装着的这时不动）；没变的块从本机拷，换上之后不留下半截的东西", {
  ...macOnly,
  timeout: 60_000,
}, async () => {
  const release = join(dir, "release");
  const applications = mkdtempSync(join(dir, "Applications-"));
  const installed = fakeApp(applications, "0.1.0");
  const cacheDir = join(dir, "cache");
  const bundles = bundlesFrom({ ...process.env, ORANGESPEAKEASY_INSTALL_BASE: release });

  const channel = await publishApp(release, "0.2.0", fakeApp(mkdtempSync(join(dir, "new-")), "0.2.0"));
  const staged = await bundles.stage(channel, installed, { seeds: [], cacheDir });
  // 拼好了还没换：装着的照旧，新的藏在旁边（名字带点开头，访达里看不见）
  assert.equal(versionOf(installed), "0.1.0");
  assert.deepEqual(readdirSync(applications).sort(), [".OrangeSpeakEasy.app.new", "OrangeSpeakEasy.app"]);
  // 程序没变的那几块是从装着的那个里拷的
  assert.ok(staged.reusedBytes > 0, `reused ${staged.reusedBytes}`);
  assert.ok(staged.downloadedBytes > 0, `downloaded ${staged.downloadedBytes}`);
  staged.commit();
  assert.equal(versionOf(installed), "0.2.0");
  execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
  assert.deepEqual(readdirSync(applications), ["OrangeSpeakEasy.app"]);

  // 不换了：待换的删掉，装着的不动
  const newer = await publishApp(release, "0.2.1", fakeApp(mkdtempSync(join(dir, "newer-")), "0.2.1"));
  (await bundles.stage(newer, installed, { seeds: [], cacheDir })).discard();
  assert.equal(versionOf(installed), "0.2.0");
  assert.deepEqual(readdirSync(applications), ["OrangeSpeakEasy.app"]);

  // 拼出来的版本和 channel.json 说的对不上：不装
  await assert.rejects(bundles.stage({ ...channel, version: "0.3.0" }, installed, { seeds: [], cacheDir }), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(zh.text(error.problem), /不是 0\.3\.0 版的 OrangeSpeakEasy\.app/);
    return true;
  });
  assert.equal(versionOf(installed), "0.2.0");
  assert.deepEqual(readdirSync(applications), ["OrangeSpeakEasy.app"]);
});

test("换 App：下到的块不对、没签名的、发布里没有这种芯片的，都不装，装着的原样留着", {
  ...macOnly,
  timeout: 60_000,
}, async () => {
  const release = join(dir, "release");
  const applications = mkdtempSync(join(dir, "Applications-"));
  const installed = fakeApp(applications, "0.1.0");
  const cacheDir = join(dir, "cache");
  const bundles = bundlesFrom({ ...process.env, ORANGESPEAKEASY_INSTALL_BASE: release });

  // 下载地址上的块全换成别的内容（压法照旧，解得开，但 sha256 对不上）
  const channel = await publishApp(release, "0.2.0", fakeApp(mkdtempSync(join(dir, "new-")), "0.2.0"));
  const manifestSha = channel.targets[appTarget(ARCH)];
  for (const name of readdirSync(join(release, "store"))) {
    if (name !== manifestSha) writeFileSync(join(release, "store", name), packObject(Buffer.from(`被换掉的 ${name}`)));
  }
  await assert.rejects(bundles.stage(channel, installed, { seeds: [], cacheDir }), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(zh.text(error.problem), /下载的更新数据（[0-9a-f]{12}）与发布的不符/);
    return true;
  });

  const unsigned = await publishApp(
    join(dir, "release-unsigned"),
    "0.2.1",
    fakeApp(mkdtempSync(join(dir, "unsigned-")), "0.2.1", { sign: false }),
  );
  const fromUnsigned = bundlesFrom({ ...process.env, ORANGESPEAKEASY_INSTALL_BASE: join(dir, "release-unsigned") });
  await assert.rejects(fromUnsigned.stage(unsigned, installed, { seeds: [], cacheDir }), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(zh.text(error.problem), /签名/);
    return true;
  });

  await assert.rejects(bundles.stage({ ...channel, targets: {} }, installed, { seeds: [], cacheDir }), (error) => {
    assert.match(zh.text(error.problem), new RegExp(`0\\.2\\.0 的发布中没有这台电脑用的更新（darwin-${ARCH}-app）`));
    return true;
  });

  assert.equal(versionOf(installed), "0.1.0");
  assert.deepEqual(readdirSync(applications), ["OrangeSpeakEasy.app"]);
});

test("打开 App：不把命令行自己的 ELECTRON_RUN_AS_NODE 带过去（带过去 App 会当成 Node 跑、一启动就退出）", {
  ...macOnly,
  timeout: 30_000,
}, async () => {
  // 假 App 的程序是一段脚本：把拿到的环境变量写进文件。应用标识另起一个，不和真的 OrangeSpeakEasy 混在一起
  const app = join(mkdtempSync(join(dir, "open-")), "OrangeSpeakEasyOpenTest.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const record = join(dir, "env");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.juzihai.orangespeakeasy.open-test</string>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  writeFileSync(
    join(app, "Contents", "MacOS", "run"),
    `#!/bin/sh\nenv > ${JSON.stringify(`${record}.tmp`)}\nmv ${JSON.stringify(`${record}.tmp`)} ${JSON.stringify(record)}\n`,
    {
      mode: 0o755,
    },
  );
  const bundles = bundlesFrom({
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ORANGESPEAKEASY_OPEN_TEST: "passed-through",
  });
  await bundles.open(app);
  for (let waited = 0; !existsSync(record) && waited < 20_000; waited += 200) await delay(200);
  const seen = readFileSync(record, "utf8");
  assert.match(
    seen,
    /^ORANGESPEAKEASY_OPEN_TEST=passed-through$/m,
    "别的环境变量照样带过去（ORANGESPEAKEASY_HOME 这些）",
  );
  assert.doesNotMatch(seen, /^ELECTRON_RUN_AS_NODE=/m);
});

test("这份程序在哪个应用包里：…/X.app/Contents/Resources/app 才算，别的（源码目录、家目录里的）不算", () => {
  assert.equal(
    bundleOfPackage("/Applications/OrangeSpeakEasy.app/Contents/Resources/app"),
    "/Applications/OrangeSpeakEasy.app",
  );
  assert.equal(
    bundleOfPackage("/Users/a/My Apps/OrangeSpeakEasy.app/Contents/Resources/app/"),
    "/Users/a/My Apps/OrangeSpeakEasy.app",
  );
  assert.equal(bundleOfPackage("/Users/a/.orangespeakeasy/app"), null);
  assert.equal(bundleOfPackage("/Users/a/code/orangespeakeasy"), null);
});

test("不是 macOS 就没有应用包", async () => {
  const bundles = createBundles({ env: {}, release: createRelease({ env: {} }), platform: "win32" });
  assert.equal(await bundles.find({ pid: 1 }), null);
});
