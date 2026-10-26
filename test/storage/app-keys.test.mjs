import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { adoptAppKeys } from "../../src/storage/app-keys.mjs";
import { keyFile, oldAppKeyFile, resolvePaths } from "../../src/storage/paths.mjs";

let dir;
let paths;
const logged = [];
const log = { info: (event, fields) => logged.push({ event, ...fields }), warn() {} };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-app-keys-"));
  paths = resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "home") });
  mkdirSync(paths.home, { recursive: true });
  logged.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 把文件的修改时间往前拨几秒，好分出谁新谁旧 */
const age = (file, seconds) => {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(file, when, when);
};

test("只有 App 那一份：抄一份成共用的文件（只有自己能读写），原来那份留着，退回 0.7.0 时还能用", () => {
  writeFileSync(oldAppKeyFile(paths, "gemini"), "App 的密文");
  writeFileSync(oldAppKeyFile(paths, "deepseek"), "DeepSeek 的密文");
  adoptAppKeys({ paths, log });
  assert.equal(readFileSync(keyFile(paths, "gemini"), "utf8"), "App 的密文");
  assert.equal(readFileSync(keyFile(paths, "deepseek"), "utf8"), "DeepSeek 的密文");
  // Windows 上权限位没有意义，只有自己能读靠的是家目录的访问控制（storage/owner-only.mjs，paths 的测试查）
  if (process.platform !== "win32") assert.equal(statSync(keyFile(paths, "gemini")).mode & 0o777, 0o600);
  assert.ok(existsSync(oldAppKeyFile(paths, "gemini")));
  assert.deepEqual(logged.map(({ event, provider }) => [event, provider]).sort(), [
    ["key_adopted", "deepseek"],
    ["key_adopted", "gemini"],
  ]);
});

test("两份一样、或者只有共用的那份：什么都不动", () => {
  writeFileSync(keyFile(paths, "gemini"), "同一份");
  writeFileSync(oldAppKeyFile(paths, "gemini"), "同一份");
  writeFileSync(keyFile(paths, "openai"), "只有命令行的");
  adoptAppKeys({ paths, log });
  assert.equal(readFileSync(keyFile(paths, "gemini"), "utf8"), "同一份");
  assert.equal(readFileSync(keyFile(paths, "openai"), "utf8"), "只有命令行的");
  assert.deepEqual(logged, []);
});

test("两份不一样：留新的那份（App 那份是后存的就用它，共用的是后存的就不动）", () => {
  writeFileSync(keyFile(paths, "gemini"), "命令行旧的");
  age(keyFile(paths, "gemini"), 60);
  writeFileSync(oldAppKeyFile(paths, "gemini"), "App 新的");
  writeFileSync(oldAppKeyFile(paths, "openai"), "App 旧的");
  age(oldAppKeyFile(paths, "openai"), 60);
  writeFileSync(keyFile(paths, "openai"), "命令行新的");
  adoptAppKeys({ paths, log });
  assert.equal(readFileSync(keyFile(paths, "gemini"), "utf8"), "App 新的");
  assert.equal(readFileSync(keyFile(paths, "openai"), "utf8"), "命令行新的");
  assert.deepEqual(logged.map(({ event, provider, kept }) => [event, provider, kept]).sort(), [
    ["key_conflict", "gemini", "app"],
    ["key_conflict", "openai", "shared"],
  ]);
});

test("目录里别的文件不管；家目录还没建也不报错", () => {
  writeFileSync(join(paths.home, "settings.json"), "{}");
  writeFileSync(join(paths.home, "Gemini-key.app.bin"), "名字不对");
  adoptAppKeys({ paths, log });
  assert.deepEqual(logged, []);
  adoptAppKeys({ paths: resolvePaths({ ORANGESPEAKEASY_HOME: join(dir, "nowhere") }), log });
});
