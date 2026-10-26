import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { startControlServer } from "../../src/control.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { openHistory } from "../../src/storage/history.mjs";
import { migrateLegacyData, migrateLegacySettings, moveItem } from "../../src/storage/legacy.mjs";
import { keyFile, resolvePaths } from "../../src/storage/paths.mjs";
import { resolveSettings } from "../../src/storage/settings.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

let dir;
let legacyDir;
let paths;
let logged;
const log = {
  info: (event, fields) => logged.push({ event, ...fields }),
  warn: (event, fields) => logged.push({ event, ...fields }),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-"));
  legacyDir = join(dir, "old");
  paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "new") });
  logged = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 摆出 0.1 版用过之后的样子：一条历史和它的录音、设置、key，外加运行环境自己的缓存 */
function seedLegacy() {
  mkdirSync(join(legacyDir, "Recordings"), { recursive: true });
  mkdirSync(join(legacyDir, "GPUCache"));
  const audio = join(legacyDir, "Recordings", "a.webm");
  writeFileSync(audio, "录音");
  writeFileSync(join(legacyDir, "settings.json"), '{"hotkey":"fn"}\n');
  writeFileSync(join(legacyDir, "gemini-key.bin"), "密文");
  const history = openHistory(join(legacyDir, "history.db"));
  history.add({
    id: "a",
    status: "completed",
    refinedText: "以前说的话",
    error: null,
    duration: 3,
    // 0.1 版记的是录音的完整路径
    audioFile: audio,
    createdAt: "2026-10-12T01:00:00.000Z",
  });
  history.close();
}

// 0.1 只有 macOS 版；旧版本的后台在旧目录里听的是 Unix 套接字，Windows 上没法摆出这个样子，也不会遇到
const macOnly = { skip: process.platform !== "darwin" && "0.1 只有 macOS 版，别的系统上没有要搬的旧数据" };

test("不是 macOS：没有旧目录可找，什么都不做", async () => {
  assert.deepEqual(await migrateLegacyData({ paths, legacyDir: null, log }), []);
  assert.equal(existsSync(paths.home), false);
});

const migrate = (overrides = {}) => migrateLegacyData({ paths, legacyDir, log, ...overrides });

test("没有旧目录：什么都不做", macOnly, async () => {
  assert.deepEqual(await migrate(), []);
  assert.equal(existsSync(paths.home), false);
});

test("旧目录里的历史、录音、设置、key 搬进新的家目录；历史里记的录音位置跟着改；旧目录清掉", macOnly, async () => {
  seedLegacy();
  assert.deepEqual(await migrate(), ["history.db", "Recordings", "settings.json", "gemini-key.bin"]);

  assert.equal(readFileSync(paths.settingsFile, "utf8"), '{"hotkey":"fn"}\n');
  assert.equal(readFileSync(keyFile(paths, "gemini"), "utf8"), "密文");
  const history = openHistory(paths.historyDb, { readOnly: true });
  const [row] = history.list();
  history.close();
  assert.equal(row.refinedText, "以前说的话");
  assert.equal(row.audioFile, "a.webm");
  assert.equal(readFileSync(join(paths.recordingsDir, row.audioFile), "utf8"), "录音");

  // 剩下的只有运行环境的缓存，整个删掉，不留一个没人管的目录
  assert.equal(existsSync(legacyDir), false);
  assert.ok(logged.some((entry) => entry.event === "legacy_data_migrated"));
  // 再来一次什么都不做
  assert.deepEqual(await migrate(), []);
});

test("新目录里已经有的不覆盖：那一样留在旧目录里，旧目录也不删，并记一笔", macOnly, async () => {
  seedLegacy();
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.settingsFile, '{"hotkey":"right_command"}\n');
  assert.deepEqual(await migrate(), ["history.db", "Recordings", "gemini-key.bin"]);
  assert.equal(readFileSync(paths.settingsFile, "utf8"), '{"hotkey":"right_command"}\n');
  assert.equal(existsSync(join(legacyDir, "settings.json")), true);
  assert.deepEqual(logged.find((entry) => entry.event === "legacy_data_kept")?.kept, ["settings.json"]);
});

test("旧版本的后台应用还在运行：先请它退出，退了再搬", macOnly, async () => {
  seedLegacy();
  let app;
  app = await startControlServer({
    socketPath: join(legacyDir, "control.sock"),
    log: { warn() {} },
    handlers: { status: () => ({}), quit: () => void setTimeout(() => app.close(), 20) },
  });
  assert.equal((await migrate()).length, 4);
  assert.equal(existsSync(paths.historyDb), true);
});

test("旧版本的后台应用请不走：不搬（它还开着那个库），把话说清楚", macOnly, async () => {
  seedLegacy();
  const app = await startControlServer({
    socketPath: join(legacyDir, "control.sock"),
    log: { warn() {} },
    handlers: { status: () => ({}), quit: () => {} },
  });
  try {
    await assert.rejects(migrate({ quitTimeoutMs: 100 }), said(/旧版本.*还在运行/));
    assert.equal(existsSync(paths.historyDb), false);
    assert.equal(existsSync(join(legacyDir, "history.db")), true);
  } finally {
    await app.close();
  }
});

test("家目录在别的盘上（改名做不到，EXDEV）：拷过去再删原来的；拷到一半出错就删掉拷了一半的，原来的不动", () => {
  const crossDisk = () => {
    throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  };
  const from = join(dir, "Recordings");
  mkdirSync(from);
  writeFileSync(join(from, "a.webm"), "录音");
  const to = join(dir, "moved");
  moveItem(from, to, crossDisk);
  assert.equal(readFileSync(join(to, "a.webm"), "utf8"), "录音");
  assert.equal(existsSync(from), false);

  // 目标已经有同名的：不拷，两边都不动
  mkdirSync(from);
  writeFileSync(join(from, "a.webm"), "录音");
  assert.throws(() => moveItem(from, join(to, "a.webm"), crossDisk), { code: "EEXIST" });
  assert.equal(readFileSync(join(from, "a.webm"), "utf8"), "录音");
  assert.equal(readFileSync(join(to, "a.webm"), "utf8"), "录音");
  // 别的错误照原样报
  assert.throws(
    () =>
      moveItem(from, join(dir, "x"), () => {
        throw Object.assign(new Error("no"), { code: "EACCES" });
      }),
    { code: "EACCES" },
  );
});

// ---------- 0.13 以前的热键设置（docs/hotkey-research.md 5.9） ----------

const settingsIn = () => join(dir, "settings.json");
const stored = () => JSON.parse(readFileSync(settingsIn(), "utf8"));

test("旧设置换算：hotkey 的旧 id 换成 hotkey.dictate 的组合、删掉 hotkey，别的设置不动；再跑一遍什么都不变", () => {
  writeFileSync(settingsIn(), '{"theme":"indigo","hotkey":"right_command"}\n');
  assert.deepEqual(migrateLegacySettings(settingsIn()), {
    from: "hotkey",
    to: "hotkey.dictate",
    value: "right_command",
    stored: ["MetaRight"],
  });
  assert.deepEqual(stored(), { theme: "indigo", "hotkey.dictate": ["MetaRight"] });
  assert.deepEqual(resolveSettings({ file: settingsIn(), env: {} })["hotkey.dictate"], {
    value: '["MetaRight"]',
    source: "file",
  });
  const after = readFileSync(settingsIn(), "utf8");
  assert.equal(migrateLegacySettings(settingsIn()), null);
  assert.equal(readFileSync(settingsIn(), "utf8"), after);
});

test("旧设置文件开头带 BOM（Windows 上手改过的）：照样换算", () => {
  writeFileSync(settingsIn(), '\uFEFF{"theme":"indigo","hotkey":"right_alt"}\n');
  assert.equal(migrateLegacySettings(settingsIn())?.to, "hotkey.dictate");
  assert.deepEqual(stored(), { theme: "indigo", "hotkey.dictate": ["AltRight"] });
});

test("六个旧 id 都换：两个系统的写在一起，Mac 的设置搬到 Windows 上照样换（绑不绑得上由下发前那道查）", () => {
  const cases = {
    right_option: "AltRight",
    right_command: "MetaRight",
    right_control: "ControlRight",
    fn: "Fn",
    right_alt: "AltRight",
    right_ctrl: "ControlRight",
  };
  for (const [id, chord] of Object.entries(cases)) {
    writeFileSync(settingsIn(), JSON.stringify({ hotkey: id }));
    migrateLegacySettings(settingsIn());
    assert.deepEqual(stored(), { "hotkey.dictate": [chord] }, id);
  }
});

test("新旧两项都有：以旧的为准。新版从不写 hotkey，有它就是还没换过，或者退回旧版后在旧版里改过", () => {
  writeFileSync(settingsIn(), JSON.stringify({ "hotkey.dictate": ["Fn", "AltRight+Space"], hotkey: "right_control" }));
  migrateLegacySettings(settingsIn());
  assert.deepEqual(stored(), { "hotkey.dictate": ["ControlRight"] });
});

test("用默认键的人（文件里没有 hotkey）：文件一个字节都不动；没有文件、文件坏了也不动，坏在哪由读设置的地方照实报", () => {
  assert.equal(migrateLegacySettings(settingsIn()), null);
  assert.equal(existsSync(settingsIn()), false, "没有文件时不新建");
  for (const content of ['{"theme":"ink"}\n', "{ 不是 JSON", "[1,2]", "null"]) {
    writeFileSync(settingsIn(), content);
    assert.equal(migrateLegacySettings(settingsIn()), null, content);
    assert.equal(readFileSync(settingsIn(), "utf8"), content);
  }
});

test("不是旧 id 的值照原样搬过去：读设置时照实报错，不悄悄丢掉；手写的新写法照样能用", () => {
  writeFileSync(settingsIn(), JSON.stringify({ hotkey: "caps_lock" }));
  migrateLegacySettings(settingsIn());
  assert.deepEqual(stored(), { "hotkey.dictate": "caps_lock" });
  assert.throws(
    () => resolveSettings({ file: settingsIn(), env: {} }),
    said(/settings\.json 里的 hotkey\.dictate.*不认识的键 "caps_lock"/),
  );
  writeFileSync(settingsIn(), JSON.stringify({ hotkey: "ControlRight+Space" }));
  migrateLegacySettings(settingsIn());
  assert.equal(resolveSettings({ file: settingsIn(), env: {} })["hotkey.dictate"].value, '["ControlRight+Space"]');
});

test("写不进去（文件只读）：照实报错，不静默", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  writeFileSync(settingsIn(), JSON.stringify({ hotkey: "fn" }));
  chmodSync(settingsIn(), 0o444);
  assert.throws(() => migrateLegacySettings(settingsIn()), said(/设置文件 .*settings\.json 里的旧热键换不过来/));
  chmodSync(settingsIn(), 0o644);
  assert.deepEqual(stored(), { hotkey: "fn" });
});
