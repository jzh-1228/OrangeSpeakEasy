import assert from "node:assert/strict";
import { test } from "node:test";
import { renderModels } from "../../../src/cli/render/models.mjs";
import { PROVIDERS } from "../../../src/server/providers/index.mjs";
import { plain } from "./fixtures.mjs";

test("一行一家：现在用的那家打一个点、写正在用的模型，别家写默认模型；各家的 key 有没有照实写", () => {
  const text = renderModels(
    {
      providers: PROVIDERS,
      setting: { value: "gemini/gemini-3.8-flash", source: "file" },
      keys: { gemini: "stored", openai: null },
    },
    plain,
  );
  assert.match(text, /^模型\n/);
  assert.match(text, /\n {2}● gemini\s+Gemini\s+gemini-3\.8-flash\s+key 存着\n/);
  assert.match(text, /\n {4}openai\s+OpenAI\s+gpt-audio-mini（默认）\s+还没有 key\n/);
  assert.match(text, /现在用的是 Gemini 的 gemini-3\.8-flash · 存在设置文件里/);
  // 举的例子是另一家
  assert.match(text, /orangespeakeasy model openai\b/);
  assert.match(text, /orangespeakeasy model openai\/gpt-audio-mini/);
  assert.match(text, /orangespeakeasy model check/);
  assert.ok(!text.includes("\x1b["));
});

test("key 来自环境变量时写出是哪一个；设置被环境变量盖着时也照实写", () => {
  const text = renderModels(
    {
      providers: PROVIDERS,
      setting: { value: "openai/gpt-audio-mini", source: "env" },
      keys: { gemini: null, openai: "env" },
    },
    plain,
  );
  assert.match(text, /● openai\s+OpenAI\s+gpt-audio-mini\s+key 来自环境变量 OPENAI_API_KEY/);
  assert.match(text, /现在用的是 OpenAI 的 gpt-audio-mini · 这次运行来自环境变量 ORANGESPEAKEASY_MODEL/);
  assert.match(text, /orangespeakeasy model gemini\b/);
});
