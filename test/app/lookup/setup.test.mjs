import assert from "node:assert/strict";
import { test } from "node:test";
import { createLookupSetup } from "../../../src/app/lookup/setup.mjs";
import { msg } from "../../../src/i18n/index.mjs";
import { patchSettings, resolveSettings } from "../../../src/storage/settings.mjs";

const quiet = { info() {}, warn() {}, error() {} };

/**
 * 假的周边：设置存在内存里（照 saveSetting 的规矩规整、报错），key 存成一个字符串，检查按 checks 里排好的回
 * @param {{ env?: object, stored?: string | null, checks?: object[] }} [options]
 */
function setupWith({ env = {}, stored = null, checks = [] } = {}) {
  let settings = resolveSettings({ file: "/nonexistent/settings.json", env });
  const calls = { saved: [], checked: [], keys: [] };
  let key = stored;
  const lookupSetup = createLookupSetup({
    engine: {
      async check(changes, options = {}) {
        calls.checked.push({ changes, apiKey: options.apiKey ?? null });
        return checks.shift() ?? { ok: true, ms: 5 };
      },
    },
    readSettings: () => settings,
    save: (name, value) => {
      settings = patchSettings(settings, { [name]: value });
      calls.saved.push([name, settings[name].value]);
      return settings[name];
    },
    customKeys: {
      exists: () => key !== null,
      save: (value) => {
        if (value === "boom") throw new Error("钥匙串不可用");
        key = value;
        calls.keys.push(value);
      },
      clear: () => {
        key = null;
        calls.keys.push(null);
      },
    },
    customKeyEnv: "ORANGESPEAKEASY_LOOKUP_CUSTOM_API_KEY",
    env,
    log: quiet,
  });
  return { lookupSetup, calls, settings: () => settings };
}

const CUSTOM = { url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", params: '{"keep_alive":"5m"}' };

test("说给引擎页的：译成哪种、交给谁、自定义服务的地址参数，key 在哪（环境变量、存着的、没有）", () => {
  const { lookupSetup } = setupWith();
  assert.deepEqual(lookupSetup.describe(), {
    to: "zh-CN",
    model: "deepseek/deepseek-flash",
    customUrl: "",
    customParams: "",
    customKey: null,
  });
  assert.equal(setupWith({ stored: "sk-local" }).lookupSetup.describe().customKey, "stored");
  const fromEnv = setupWith({ stored: "sk-local", env: { ORANGESPEAKEASY_LOOKUP_CUSTOM_API_KEY: "sk-env" } });
  assert.equal(fromEnv.lookupSetup.describe().customKey, "env");
});

test("换译成的语言、换模型：存进划词自己的那一项；写错了照实说，不存", () => {
  const { lookupSetup, calls } = setupWith();
  assert.deepEqual(lookupSetup.setTo("ja"), { ok: true });
  assert.deepEqual(lookupSetup.use("bailian/qwen3.8-flash"), { ok: true });
  assert.deepEqual(calls.saved, [
    ["lookup.to", "ja"],
    ["lookup.model", "bailian/qwen3.8-flash"],
  ]);
  const wrong = lookupSetup.use("nobody/x");
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problem);
  assert.equal(calls.saved.length, 2);
});

test("被环境变量盖着：照存，再说一句要去掉哪个环境变量才生效", () => {
  const { lookupSetup } = setupWith({ env: { ORANGESPEAKEASY_LOOKUP_MODEL: "moonshot" } });
  assert.deepEqual(lookupSetup.use("deepseek/deepseek-flash"), {
    ok: true,
    note: msg("notes.envRemove", { variable: "ORANGESPEAKEASY_LOOKUP_MODEL" }),
  });
});

test("自定义服务：拿填的 key 先验，通过了再存 key、地址、模型名、参数，并换成它", async () => {
  const { lookupSetup, calls, settings } = setupWith();
  const result = await lookupSetup.saveCustom({ ...CUSTOM, apiKey: "  sk-local " });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.checked, [
    {
      changes: {
        "lookup.model": "custom/qwen3:8b",
        "lookup.customUrl": CUSTOM.url,
        "lookup.customParams": CUSTOM.params,
      },
      apiKey: "sk-local",
    },
  ]);
  assert.deepEqual(calls.keys, ["sk-local"]);
  assert.equal(settings()["lookup.model"].value, "custom/qwen3:8b");
  assert.equal(settings()["lookup.customUrl"].value, CUSTOM.url);
  assert.equal(lookupSetup.describe().customKey, "stored");
});

test("自定义服务已经存过 key：这次不填 key 就用存着的验，key 不动", async () => {
  const { lookupSetup, calls } = setupWith({ stored: "sk-old" });
  assert.deepEqual(await lookupSetup.saveCustom({ ...CUSTOM, apiKey: "" }), { ok: true });
  assert.equal(calls.checked[0].apiKey, null);
  assert.deepEqual(calls.keys, []);
});

test("自定义服务没通过：原因照检查说的，什么都不存；缺模型名、缺 key、key 样子不对的不去验", async () => {
  const failed = setupWith({ checks: [{ ok: false, cause: "key", problem: "这把 key 无效" }] });
  assert.deepEqual(await failed.lookupSetup.saveCustom({ ...CUSTOM, apiKey: "sk-bad" }), {
    ok: false,
    problem: "这把 key 无效",
  });
  assert.deepEqual([failed.calls.keys, failed.calls.saved], [[], []]);

  const { lookupSetup, calls } = setupWith();
  assert.deepEqual(await lookupSetup.saveCustom({ ...CUSTOM, model: " ", apiKey: "sk" }), {
    ok: false,
    problem: msg("plaza.custom.modelMissing"),
  });
  assert.deepEqual(await lookupSetup.saveCustom({ ...CUSTOM, apiKey: "" }), { ok: false, problem: msg("key.empty") });
  assert.deepEqual(await lookupSetup.saveCustom({ ...CUSTOM, apiKey: "sk with space" }), {
    ok: false,
    problem: msg("key.whitespace"),
  });
  assert.deepEqual(calls.checked, []);
});

test("验过了但 key 存不下：说存不下，设置也不换", async () => {
  const { lookupSetup, calls } = setupWith();
  const result = await lookupSetup.saveCustom({ ...CUSTOM, apiKey: "boom" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problem, msg("key.notSaved", { reason: "钥匙串不可用" }));
  assert.deepEqual(calls.saved, []);
});

test("删掉划词自定义服务的 key", () => {
  const { lookupSetup } = setupWith({ stored: "sk-old" });
  assert.deepEqual(lookupSetup.forgetCustomKey(), { ok: true });
  assert.equal(lookupSetup.describe().customKey, null);
});
