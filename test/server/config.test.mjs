import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/server/config.mjs";

test("只给 Gemini 的密钥时，其余用默认值，只监听本机", () => {
  assert.deepEqual(loadConfig({ GEMINI_API_KEY: "k" }), {
    host: "127.0.0.1",
    port: 8790,
    route: { mode: "native", model: { provider: "gemini", model: "gemini-3.6-flash" }, thinkingLevel: "MINIMAL" },
    apiKey: "k",
    keys: { gemini: "k" },
    modelSource: "cn",
  });
});

test("第一跳交给云端、润色交给另一家：两家的 key 都要有，缺哪个说哪个", () => {
  const env = {
    ORANGESPEAKEASY_MODE: "local",
    ORANGESPEAKEASY_TRANSCRIBER: "bailian/qwen3-asr-flash",
    DEEPSEEK_API_KEY: "sk-d",
  };
  assert.throws(() => loadConfig(env), /BAILIAN_API_KEY/);
  const config = loadConfig({ ...env, BAILIAN_API_KEY: "sk-ws-b" });
  assert.equal(config.route.transcriber, "bailian/qwen3-asr-flash");
  assert.deepEqual(config.keys, { bailian: "sk-ws-b", deepseek: "sk-d" });
  assert.equal(config.apiKey, "sk-d");
});

test("ORANGESPEAKEASY_MODEL 选厂商和模型，key 从那一家的环境变量来", () => {
  const config = loadConfig({ ORANGESPEAKEASY_MODEL: "openai/gpt-audio-1.5", OPENAI_API_KEY: "sk-test" });
  assert.deepEqual(config.route.model, { provider: "openai", model: "gpt-audio-1.5" });
  assert.equal(config.apiKey, "sk-test");
  // 选了 OpenAI 却只给了 Gemini 的 key：说清缺的是哪一个
  assert.throws(() => loadConfig({ ORANGESPEAKEASY_MODEL: "openai", GEMINI_API_KEY: "k" }), /OPENAI_API_KEY/);
});

test("环境变量可以换端口和思考档位；旧的 GEMINI_MODEL 照样认，ORANGESPEAKEASY_MODEL 优先", () => {
  const config = loadConfig({
    GEMINI_API_KEY: "k",
    PORT: "9001",
    GEMINI_MODEL: "gemini-3.8-flash",
    GEMINI_THINKING_LEVEL: "low",
  });
  assert.equal(config.port, 9001);
  assert.deepEqual(config.route.model, { provider: "gemini", model: "gemini-3.8-flash" });
  assert.equal(config.route.thinkingLevel, "LOW");
  const both = loadConfig({ ORANGESPEAKEASY_MODEL: "openai", GEMINI_MODEL: "gemini-3.8-flash", OPENAI_API_KEY: "k" });
  assert.equal(both.route.model.provider, "openai");
});

test("没有密钥时报错，并说明怎么给", () => {
  assert.throws(() => loadConfig({}), /GEMINI_API_KEY/);
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "  " }), /GEMINI_API_KEY/);
});

test("端口、模型和思考档位写错时报错，说清是哪个环境变量，不悄悄用默认值", () => {
  for (const PORT of ["abc", "0", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ GEMINI_API_KEY: "k", PORT }), /PORT/);
  }
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "k", GEMINI_THINKING_LEVEL: "none" }), /GEMINI_THINKING_LEVEL/);
  assert.throws(
    () => loadConfig({ GEMINI_API_KEY: "k", ORANGESPEAKEASY_MODEL: "deepseek/x" }),
    /ORANGESPEAKEASY_MODEL.*deepseek/,
  );
});

test("样子不对的 key 直接拒绝，不交给 SDK：它报错时会把整段输入带出来", () => {
  assert.throws(
    () => loadConfig({ GEMINI_API_KEY: "line-one-SECRET\nline-two-SECRET" }),
    (error) => /GEMINI_API_KEY/.test(error.message) && !/SECRET/.test(error.message),
  );
});

test("模型的环境变量是空的：当作没设，用默认的（0.3 单独启动服务端时就是这样）", () => {
  assert.deepEqual(loadConfig({ GEMINI_API_KEY: "k", GEMINI_MODEL: "" }).route.model, {
    provider: "gemini",
    model: "gemini-3.6-flash",
  });
  assert.equal(loadConfig({ GEMINI_API_KEY: "k", ORANGESPEAKEASY_MODEL: " " }).route.model.provider, "gemini");
});

test("ORANGESPEAKEASY_MODE=local：本地模型和润色那家用默认的，key 从润色那家的环境变量来", () => {
  assert.deepEqual(loadConfig({ ORANGESPEAKEASY_MODE: "local", DEEPSEEK_API_KEY: "sk-d" }), {
    host: "127.0.0.1",
    port: 8790,
    route: {
      mode: "local",
      transcriber: "qwen3-asr-0.6b-q8",
      polish: { vendor: "deepseek", model: "deepseek-flash" },
      customUrl: null,
      customParams: null,
    },
    apiKey: "sk-d",
    keys: { deepseek: "sk-d" },
    modelSource: "cn",
  });
  assert.throws(() => loadConfig({ ORANGESPEAKEASY_MODE: "local", GEMINI_API_KEY: "k" }), /DEEPSEEK_API_KEY/);
});

test("本地转写链路：换模型、换润色的那家；自定义服务要给地址，可以带额外参数", () => {
  const config = loadConfig({
    ORANGESPEAKEASY_MODE: "local",
    ORANGESPEAKEASY_TRANSCRIBER: "sensevoice-small-q8",
    ORANGESPEAKEASY_POLISH: "custom/qwen3:8b",
    ORANGESPEAKEASY_CUSTOM_URL: "http://127.0.0.1:11434/v1/",
    ORANGESPEAKEASY_CUSTOM_PARAMS: '{"think": false}',
    ORANGESPEAKEASY_CUSTOM_API_KEY: "ollama",
  });
  assert.deepEqual(config.route, {
    mode: "local",
    transcriber: "sensevoice-small-q8",
    polish: { vendor: "custom", model: "qwen3:8b" },
    customUrl: "http://127.0.0.1:11434/v1",
    customParams: { think: false },
  });
  assert.equal(config.apiKey, "ollama");
  assert.throws(
    () =>
      loadConfig({
        ORANGESPEAKEASY_MODE: "local",
        ORANGESPEAKEASY_POLISH: "custom/m",
        ORANGESPEAKEASY_CUSTOM_API_KEY: "k",
      }),
    /ORANGESPEAKEASY_CUSTOM_URL/,
  );
  assert.throws(
    () =>
      loadConfig({
        ORANGESPEAKEASY_MODE: "local",
        ORANGESPEAKEASY_POLISH: "custom/m",
        ORANGESPEAKEASY_CUSTOM_URL: "https://x.example/v1",
        ORANGESPEAKEASY_CUSTOM_PARAMS: "{think: false}",
        ORANGESPEAKEASY_CUSTOM_API_KEY: "k",
      }),
    /ORANGESPEAKEASY_CUSTOM_PARAMS/,
  );
});

test("链路、本地模型、润色写错时说清是哪个环境变量", () => {
  assert.throws(
    () => loadConfig({ ORANGESPEAKEASY_MODE: "cloud", GEMINI_API_KEY: "k" }),
    /ORANGESPEAKEASY_MODE.*native/,
  );
  assert.throws(
    () =>
      loadConfig({ ORANGESPEAKEASY_MODE: "local", ORANGESPEAKEASY_TRANSCRIBER: "whisper-9", DEEPSEEK_API_KEY: "k" }),
    /ORANGESPEAKEASY_TRANSCRIBER.*qwen3-asr-0\.6b-q8/,
  );
  assert.throws(
    () => loadConfig({ ORANGESPEAKEASY_MODE: "local", ORANGESPEAKEASY_POLISH: "nobody/x", DEEPSEEK_API_KEY: "k" }),
    /ORANGESPEAKEASY_POLISH/,
  );
});

test("下载源：ORANGESPEAKEASY_MODEL_SOURCE 选先从哪下，写错了说能填什么", () => {
  const env = { ORANGESPEAKEASY_MODE: "local", DEEPSEEK_API_KEY: "k" };
  assert.equal(loadConfig({ ...env, ORANGESPEAKEASY_MODEL_SOURCE: "original" }).modelSource, "original");
  assert.throws(
    () => loadConfig({ ...env, ORANGESPEAKEASY_MODEL_SOURCE: "s3" }),
    /ORANGESPEAKEASY_MODEL_SOURCE.*cn \/ original/,
  );
});
