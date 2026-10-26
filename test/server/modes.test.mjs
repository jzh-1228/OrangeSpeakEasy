import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, findModel } from "../../src/models/catalog.mjs";
import {
  createModeRefiner,
  describeRoute,
  findMode,
  keyVendorOf,
  keyVendorsOf,
  MODES,
  parseMode,
  supportsTask,
  usesLocalModel,
} from "../../src/server/modes.mjs";
import { findTask } from "../../src/server/tasks/index.mjs";

const DICTATION = findTask("dictate").bind({});

const zh = createTranslator("zh-CN");
const quiet = { info() {}, warn() {}, error() {} };
const NATIVE = { mode: "native", model: { provider: "openai", model: "gpt-audio-mini" }, thinkingLevel: "MINIMAL" };
const LOCAL = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "deepseek", model: "deepseek-flash" },
  customUrl: null,
};

test("三种模式平级登记，默认的转写模型在清单里", () => {
  assert.deepEqual(
    MODES.map(({ id }) => id),
    ["native", "local", "private"],
  );
  assert.ok(findModel(DEFAULT_TRANSCRIBER));
  assert.equal(findMode("LOCAL").id, "local");
  assert.equal(findMode("nope"), null);
});

test("链路的写法：认 native / local，大小写不论；写错了说能填什么", () => {
  assert.equal(parseMode(" Local "), "local");
  assert.throws(
    () => parseMode("cloud"),
    (error) => /native/.test(zh.text(error.problem)) && /local/.test(zh.text(error.problem)),
  );
});

test("要用谁家的 key：原生链路是收音频的那家，本地转写链路是润色的那家", () => {
  assert.equal(keyVendorOf(NATIVE).id, "openai");
  assert.equal(keyVendorOf(LOCAL).id, "deepseek");
  assert.equal(keyVendorOf(LOCAL).keyEnv, "DEEPSEEK_API_KEY");
  assert.equal(
    keyVendorOf({ ...LOCAL, polish: { vendor: "custom", model: "m" } }).keyEnv,
    "ORANGESPEAKEASY_CUSTOM_API_KEY",
  );
});

test("一句话说清这条路线（日志和状态里用）", () => {
  assert.equal(describeRoute(NATIVE), "native: openai/gpt-audio-mini");
  assert.equal(describeRoute(LOCAL), "local: qwen3-asr-0.6b-q8 → deepseek/deepseek-flash");
});

test("本地转写链路：拿交进来的转写器和按路线装的润色器接起来，润色发到选的那一家", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "好的。" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  const transcriber = { transcribe: async () => ({ text: "好的" }) };
  const refiner = await createModeRefiner({
    route: LOCAL,
    apiKey: "sk-test",
    transcriber,
    log: quiet,
    decode: async () => new Float32Array(16_000),
    fetch,
  });
  assert.equal((await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" })).text, "好的");
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
});

test("本地转写链路没有转写器时直接报错（调用方要先装好模型）", async () => {
  await assert.rejects(createModeRefiner({ route: LOCAL, apiKey: "k", log: quiet }), /转写器/);
});

const CLOUD = { ...LOCAL, transcriber: "bailian/qwen3-asr-flash" };
const PRIVATE = { mode: "private", transcriber: "qwen3-asr-0.6b-q8" };

test("数据隐私模式：一跳，本机模型转写完直接交出原文；不要任何一家的 key，也不往外发请求", async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return Response.json({});
  };
  const refiner = await createModeRefiner({
    route: PRIVATE,
    transcriber: { transcribe: async () => ({ text: "  嗯，我现在有几个事要做  " }) },
    log: quiet,
    decode: async () => new Float32Array(16_000),
    fetch,
  });
  await refiner.warmUp();
  assert.equal(
    (await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" })).text,
    "嗯，我现在有几个事要做",
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(keyVendorsOf(PRIVATE), []);
  assert.equal(keyVendorOf(PRIVATE), undefined);
  assert.equal(usesLocalModel(PRIVATE), true);
  assert.equal(describeRoute(PRIVATE), "private: qwen3-asr-0.6b-q8");
});

test("数据隐私模式只认本机模型：写成云端的、没交转写器的都直接报错", async () => {
  await assert.rejects(
    createModeRefiner({ route: { ...PRIVATE, transcriber: "bailian/qwen3-asr-flash" }, log: quiet }),
    /本机模型/,
  );
  await assert.rejects(createModeRefiner({ route: PRIVATE, log: quiet }), /转写器/);
});

test("每种方式做得了哪些任务看成品出在哪一步：任务在那一步上没有做法就做不了，不按任务的名字判断", async () => {
  const dictate = findTask("dictate");
  for (const route of [NATIVE, LOCAL, PRIVATE]) assert.equal(supportsTask(route, dictate), true);
  // 只在直出、整理两步上有做法的任务（翻译就是这样）：离线做不了
  const textOnly = { id: "dictate", steps: ["native", "polish"] };
  assert.equal(supportsTask(NATIVE, textOnly), true);
  assert.equal(supportsTask(LOCAL, textOnly), true);
  assert.equal(supportsTask(PRIVATE, textOnly), false);

  // 服务端自己也挡一道：交进来的任务没有离线这一步的做法时，不转文字、不准备，直接说清哪种方式不支持什么
  const transcribed = [];
  const refiner = await createModeRefiner({
    route: PRIVATE,
    transcriber: { transcribe: async (samples) => transcribed.push(samples) && { text: "好的" } },
    log: quiet,
    decode: async () => new Float32Array(16_000),
  });
  const task = { id: "dictate", native: DICTATION.native, polish: DICTATION.polish };
  await refiner.prepare({ task });
  const error = await refiner.refine(Buffer.from("x"), { task, mimeType: "audio/webm" }).catch((thrown) => thrown);
  assert.equal(zh.text(error.problem), "离线方式不支持语音输入");
  assert.deepEqual(transcribed, []);
});

test("第一跳交给云端时要两家的 key，主的那家（润色）在最后；同一家只要一把", () => {
  assert.deepEqual(
    keyVendorsOf(CLOUD).map(({ id }) => id),
    ["bailian", "deepseek"],
  );
  assert.equal(keyVendorOf(CLOUD).id, "deepseek");
  const allBailian = { ...CLOUD, polish: { vendor: "bailian", model: "qwen3.8-flash" } };
  assert.deepEqual(
    keyVendorsOf(allBailian).map(({ id }) => id),
    ["bailian"],
  );
  assert.equal(usesLocalModel(CLOUD), false);
  assert.equal(usesLocalModel(LOCAL), true);
  assert.equal(usesLocalModel(NATIVE), false);
});

test("第一跳交给云端：不用交转写器，按路线装；两家各用各的 key，验证时两跳都验", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization });
    if (url.includes("dashscope")) {
      return Response.json({
        model: "qwen3-asr-flash",
        choices: [{ finish_reason: "stop", message: { content: "好的" } }],
        usage: { prompt_tokens: 25, completion_tokens: 2, seconds: 1 },
      });
    }
    return Response.json({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "好的。" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  const refiner = await createModeRefiner({
    route: CLOUD,
    keys: { bailian: "sk-ws-b", deepseek: "sk-d" },
    log: quiet,
    // 有声音的一段：全是静音的段云端转写不发（asr/segment.mjs）
    decode: async () => new Float32Array(16_000).fill(0.1),
    fetch,
  });
  assert.equal((await refiner.refine(Buffer.from("x"), { task: DICTATION, mimeType: "audio/webm" })).text, "好的");
  assert.deepEqual(
    requests.map(({ url, auth }) => [new URL(url).host, auth]),
    [
      ["dashscope.aliyuncs.com", "Bearer sk-ws-b"],
      ["api.deepseek.com", "Bearer sk-d"],
    ],
  );
  requests.length = 0;
  await refiner.warmUp();
  assert.deepEqual(
    new Set(requests.map(({ url }) => new URL(url).host)),
    new Set(["dashscope.aliyuncs.com", "api.deepseek.com"]),
  );
});
