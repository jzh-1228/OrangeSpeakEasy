import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createModeSwitch } from "../../src/app/modes.mjs";
import { createTranslator, msg } from "../../src/i18n/index.mjs";
import { resolveSettings, routeOf, saveSetting } from "../../src/storage/settings.mjs";

const zh = createTranslator("zh-CN");

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-modes-"));
  file = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saved = (name) => resolveSettings({ file, env: {} })[name].value;

/**
 * 假的服务和 key 管理：keys.switchRoute 当场换上那条路线（和真的一样不验证）；verdict 只用来模拟换不了的时候
 * （连着单独启动的服务端）。calls 记下内核对它们做了什么
 */
function setup({
  verdict = () => ({ ok: true }),
  env = {},
  installed = ["qwen3-asr-0.6b-q8", "sensevoice-small-q8"],
  transcribe = async () => ({ text: "今天下午三点开会。", transcribeMs: 300, loadMs: null, backend: "metal" }),
  speech = async (locale) => ({ samples: new Float32Array(16), said: `念的是 ${locale}` }),
} = {}) {
  const calls = [];
  const models = {
    installed: new Set(installed),
    isInstalled: (id) => models.installed.has(id),
    remove(id) {
      calls.push({ remove: id });
      models.installed.delete(id);
      return { ok: true };
    },
  };
  const service = {
    route: routeOf(resolveSettings({ file, env })),
    switchTranscriber(model) {
      calls.push({ switchTranscriber: model });
      service.route = { ...service.route, transcriber: model };
    },
  };
  service.checkTranscriber = async (model, samples) => {
    calls.push({ checkTranscriber: model, samples: samples.length });
    return transcribe(model, samples);
  };
  const keys = {
    switchRoute(route) {
      calls.push({ switchRoute: route });
      const result = verdict(route);
      if (!result.ok) return result;
      service.route = route;
      return { ok: true, settled: keys.settled };
    },
    /** 找 key、验 key 的结论什么时候有：默认马上有 */
    settled: Promise.resolve(),
    async check(route) {
      calls.push({ check: route });
      return { ok: true, source: "stored", ms: 5 };
    },
  };
  const log = { info() {}, warn() {} };
  const modes = createModeSwitch({ service, keys, models, settingsFile: file, env, log, speech });
  return { modes, service, calls, models, keys };
}

// ---------- 模式这一层 ----------

test("切模式：按设置里那种模式自己的几项拼出路线，当场换上、记进设置", async () => {
  saveSetting(file, "polish", "deepseek/deepseek-v4-pro");
  const { modes, service, calls } = setup();
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.deepEqual(calls, [
    {
      switchRoute: {
        mode: "local",
        transcriber: "qwen3-asr-0.6b-q8",
        polish: { vendor: "deepseek", model: "deepseek-v4-pro" },
        customUrl: null,
        customParams: null,
      },
    },
  ]);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("mode"), "local");
});

test("换上了就先存设置，不等找 key、验 key 的结论：这期间界面来问，模式和设置是一致的", async () => {
  const { modes, service, keys } = setup();
  let release;
  keys.settled = new Promise((resolve) => {
    release = resolve;
  });
  const switching = modes.switchMode("private");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.route.mode, "private");
  assert.equal(saved("mode"), "private");
  let done = false;
  switching.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "等到 key 有了结论才回话");
  release();
  assert.deepEqual(await switching, { ok: true });
});

test("key 管理换不了（连着单独启动的服务端）：什么都不变，原因照实带回", async () => {
  const problem = msg("key.externalModel");
  const { modes, service } = setup({ verdict: () => ({ ok: false, problem }) });
  const result = await modes.switchMode("local");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /单独启动的服务端/);
  assert.equal(service.route.mode, "native");
  assert.equal(saved("mode"), "native");
});

test("切到正在用的模式：不用再验证；写错的模式名说能填什么", async () => {
  const { modes, calls } = setup();
  assert.deepEqual(await modes.switchMode("native"), { ok: true });
  assert.deepEqual(calls, []);
  const wrong = await modes.switchMode("cloud");
  assert.equal(wrong.ok, false);
  assert.match(zh.text(wrong.problem), /native \/ local/);
});

// ---------- native 这一层 ----------

test("native 换模型：在 native 模式时当场换上；只写 model，不碰 local 的设置", async () => {
  const { modes, service } = setup();
  assert.deepEqual(await modes.setModel("openai"), { ok: true });
  assert.deepEqual(service.route.model, { provider: "openai", model: "gpt-audio-mini" });
  assert.equal(saved("model"), "openai/gpt-audio-mini");
  assert.equal(saved("polish"), "deepseek/deepseek-flash");
});

test("native 换模型时正在 local 模式：不换也不存，说要先切到 native", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service, calls } = setup();
  const result = await modes.setModel("openai/gpt-audio-1.5");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /现在是 local 模式.*native 模式/);
  assert.deepEqual(calls, []);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("model"), "gemini/gemini-3.6-flash");
});

test("native 只认收音频的那几家：写润色的厂商、写错的名字都不收", async () => {
  const { modes, calls } = setup();
  const result = await modes.setModel("deepseek/deepseek-flash");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /gemini \/ openai/);
  assert.deepEqual(calls, []);
  assert.equal(saved("model"), "gemini/gemini-3.6-flash");
});

// ---------- local 的两跳 ----------

test("local 第一跳换本地模型：不验证 key，只让服务换模型（后台装载）", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup();
  assert.deepEqual(await modes.setTranscriber("sensevoice-small-q8"), { ok: true });
  assert.deepEqual(calls, [{ switchTranscriber: "sensevoice-small-q8" }]);
  assert.equal(saved("transcriber"), "sensevoice-small-q8");
});

test("local 第二跳换润色：当场换上；自定义服务连地址一起换、一起存", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service } = setup();
  const result = await modes.setPolish("custom/qwen3:8b", { customUrl: "http://127.0.0.1:11434/v1/chat/completions" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(service.route.polish, { vendor: "custom", model: "qwen3:8b" });
  assert.equal(service.route.customUrl, "http://127.0.0.1:11434/v1");
  assert.equal(saved("polish"), "custom/qwen3:8b");
  assert.equal(saved("customUrl"), "http://127.0.0.1:11434/v1");
});

test("local 第二跳换成自定义服务：额外参数和地址一起换、一起存；写错了不换不存，说哪里不对", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service } = setup();
  const result = await modes.setPolish("custom/gpt-5-mini", {
    customUrl: "https://router.example/v1",
    customParams: '{ "max_completion_tokens": 1024 }',
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(service.route.customParams, { max_completion_tokens: 1024 });
  assert.equal(saved("customParams"), '{"max_completion_tokens":1024}');

  const wrong = await modes.setPolish("custom/gpt-5-mini", { customParams: '{"stream": true}' });
  assert.equal(wrong.ok, false);
  assert.match(zh.text(wrong.problem), /stream/);
  assert.deepEqual(service.route.customParams, { max_completion_tokens: 1024 });
  assert.equal(saved("customParams"), '{"max_completion_tokens":1024}');
});

test("local 第二跳换不了（连着单独启动的服务端）：润色和地址都不存", async () => {
  saveSetting(file, "mode", "local");
  const { modes } = setup({ verdict: () => ({ ok: false, problem: msg("key.externalModel") }) });
  const result = await modes.setPolish("custom/m", { customUrl: "http://x.example/v1" });
  assert.equal(result.ok, false);
  assert.equal(saved("polish"), "deepseek/deepseek-flash");
  assert.equal(saved("customUrl"), "");
});

test("local 的两跳在 native 模式时：不能换（没法选），不验证、不存，说要先切到 local", async () => {
  const { modes, calls } = setup();
  const first = await modes.setTranscriber("sensevoice-small-q8");
  assert.equal(first.ok, false);
  assert.match(zh.text(first.problem), /转文字的模型.*local 模式/);
  const second = await modes.setPolish("deepseek/deepseek-v4-pro");
  assert.match(zh.text(second.problem), /整理的模型.*local 模式/);
  assert.deepEqual(calls, []);
  assert.equal(saved("transcriber"), "qwen3-asr-0.6b-q8");
  assert.equal(saved("polish"), "deepseek/deepseek-flash");
});

test("local 的两跳只认各自的东西：第一跳不收云端模型，第二跳不收收音频的厂商", async () => {
  saveSetting(file, "mode", "local");
  const { modes } = setup();
  assert.match(zh.text((await modes.setTranscriber("gemini")).problem), /qwen3-asr-0\.6b-q8/);
  assert.match(zh.text((await modes.setPolish("openai/gpt-audio-mini")).problem), /deepseek/);
});

test("切模式时可以连带那种模式自己的设置：一起换上、一起存（没有 DeepSeek 的 key、直接用自定义服务）", async () => {
  const { modes, service } = setup();
  const result = await modes.switchMode("local", { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(service.route.polish, { vendor: "custom", model: "qwen3:8b" });
  assert.deepEqual(
    [saved("mode"), saved("polish"), saved("customUrl")],
    ["local", "custom/qwen3:8b", "http://127.0.0.1:11434/v1"],
  );
});

test("切模式时带的设置不是那种模式的：不切，说清楚", async () => {
  const { modes, calls } = setup();
  const result = await modes.switchMode("local", { model: "openai" });
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /model 不是 local 模式的设置.*transcriber/);
  assert.deepEqual(calls, []);
});

test("连带着设置却换不了（连着单独启动的服务端）：模式和那几项都不存", async () => {
  const { modes, service } = setup({ verdict: () => ({ ok: false, problem: msg("key.externalModel") }) });
  const result = await modes.switchMode("local", { polish: "custom/m", customUrl: "http://x.example/v1" });
  assert.equal(result.ok, false);
  assert.equal(service.route.mode, "native");
  assert.deepEqual([saved("mode"), saved("polish")], ["native", "deepseek/deepseek-flash"]);
});

test("已经在 local 时再切 local 并带上第一跳：照样换上（同一条路线就什么都不做）", async () => {
  saveSetting(file, "mode", "local");
  const { modes, service, calls } = setup();
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(await modes.switchMode("local", { transcriber: "sensevoice-small-q8" }), { ok: true });
  assert.equal(service.route.transcriber, "sensevoice-small-q8");
});

// ---------- 本机模型下没下载：不拦着 ----------

test("切到 local 时要用的本机模型还没下载：照样切过去、存进设置，下载是用户的事（服务停在没下载，下好了自己装上）", async () => {
  const { modes, service, calls } = setup({ installed: [] });
  assert.deepEqual(await modes.switchMode("local"), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(service.route.mode, "local");
  assert.equal(saved("mode"), "local");
});

test("在 local 里换成没下载的本机模型：照样换、存进设置，只让服务换模型", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup({ installed: ["qwen3-asr-0.6b-q8"] });
  assert.deepEqual(await modes.setTranscriber("sensevoice-small-q8"), { ok: true });
  assert.deepEqual(calls, [{ switchTranscriber: "sensevoice-small-q8" }]);
  assert.equal(saved("transcriber"), "sensevoice-small-q8");
});

test("删本机模型：正在用的不让删，说先换一个；没在用的照删（native 模式里设置记着的也算没在用）", async () => {
  saveSetting(file, "mode", "local");
  const { modes, calls } = setup();
  const refused = await modes.removeModel("qwen3-asr-0.6b-q8");
  assert.equal(refused.ok, false);
  assert.match(zh.text(refused.problem), /Qwen3-ASR 0\.6B \(Q8_0\) 正在用，删不了/);
  assert.deepEqual(await modes.removeModel("sensevoice-small-q8"), { ok: true });
  assert.deepEqual(calls, [{ remove: "sensevoice-small-q8" }]);

  saveSetting(file, "mode", "native");
  const native = setup();
  assert.deepEqual(await native.modes.removeModel("qwen3-asr-0.6b-q8"), { ok: true });
  assert.equal((await native.modes.removeModel("nope")).ok, false);
});

// ---------- 存设置 ----------

test("存下来的那项正被环境变量盖着：照样换，附一句下次启动会被盖掉", async () => {
  const { modes } = setup({ env: { ORANGESPEAKEASY_MODEL: "gemini" } });
  const result = await modes.setModel("openai");
  assert.equal(result.ok, true);
  assert.match(zh.text(result.note), /ORANGESPEAKEASY_MODEL/);
});

// ---------- 验证用的路线 ----------

test("给某一家存 key 前拿哪条路线验证：收音频的走 native，润色的走 local；要换成的模型可以一起给", () => {
  saveSetting(file, "model", "openai/gpt-audio-1.5");
  const { modes } = setup();
  assert.deepEqual(modes.routeForVendor("openai").model, { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(modes.routeForVendor("gemini").model, { provider: "gemini", model: "gemini-3.6-flash" });
  assert.deepEqual(modes.routeForVendor("deepseek").polish, { vendor: "deepseek", model: "deepseek-flash" });
  const custom = modes.routeForVendor("custom", { polish: "custom/m", customUrl: "http://x.example/v1" });
  assert.deepEqual([custom.mode, custom.polish.model, custom.customUrl], ["local", "m", "http://x.example/v1"]);
  // 自定义服务没有默认模型
  assert.throws(
    () => modes.routeForVendor("custom"),
    (error) => /custom\/模型名/.test(zh.text(error.problem)),
  );
});

test("检查：按那一层拼出路线交给 key 管理去试，不换掉正在用的", async () => {
  const { modes, calls } = setup();
  assert.equal((await modes.check("local", { polish: "deepseek/deepseek-v4-pro" })).ok, true);
  assert.deepEqual(calls[0].check.polish, { vendor: "deepseek", model: "deepseek-v4-pro" });
  assert.equal((await modes.check("native", {})).ok, true);
  assert.deepEqual(calls[1].check.model, { provider: "gemini", model: "gemini-3.6-flash" });
  const wrong = await modes.check("native", { model: "nobody/x" });
  assert.deepEqual([wrong.ok, wrong.cause], [false, "other"]);
});

// ---------- 检查本机模型 ----------

test("检查本机模型：按界面语言念一句交给它转，说念的是什么、转出了什么；哪种模式里都能查", async () => {
  const { modes, calls } = setup();
  const result = await modes.checkTranscriber("sensevoice-small-q8", { locale: "en" });
  assert.deepEqual(result, {
    ok: true,
    said: "念的是 en",
    text: "今天下午三点开会。",
    transcribeMs: 300,
    loadMs: null,
    backend: "metal",
  });
  assert.deepEqual(calls, [{ checkTranscriber: "sensevoice-small-q8", samples: 16 }]);
});

test("检查本机模型：不认识的、没下载的不去转，说先下载", async () => {
  const { modes, calls } = setup({ installed: ["qwen3-asr-0.6b-q8"] });
  assert.match(zh.text((await modes.checkTranscriber("nope", { locale: "zh-CN" })).problem), /没有 nope/);
  const missing = await modes.checkTranscriber("sensevoice-small-q8", { locale: "zh-CN" });
  assert.equal(missing.ok, false);
  assert.match(zh.text(missing.problem), /SenseVoice Small \(Q8_0\) 还没下载/);
  assert.deepEqual(calls, []);
});

test("检查本机模型：念不出来、转写出错、一个字都没转出来，各说各的", async () => {
  const noVoice = setup({
    speech: async () => {
      throw new Error("say: command not found");
    },
  });
  const spoken = await noVoice.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "zh-CN" });
  assert.equal(spoken.ok, false);
  assert.match(zh.text(spoken.problem), /念不出.*say: command not found/);

  const broken = setup({
    transcribe: async () => {
      throw new Error("转写进程退出了");
    },
  });
  const failed = await broken.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "zh-CN" });
  assert.match(zh.text(failed.problem), /Qwen3-ASR 0\.6B \(Q8_0\) 转文字出错：转写进程退出了/);

  const silent = setup({ transcribe: async () => ({ text: "  ", transcribeMs: 1, loadMs: 9, backend: "cpu" }) });
  const empty = await silent.modes.checkTranscriber("qwen3-asr-0.6b-q8", { locale: "zh-CN" });
  assert.match(zh.text(empty.problem), /一个字都没转出来/);
});
