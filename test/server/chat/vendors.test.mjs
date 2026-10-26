import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import {
  CHAT_VENDORS,
  chatEndpoint,
  findChatVendor,
  formatChatChoice,
  formatCustomParams,
  normalizeBaseUrl,
  PROTOCOLS,
  parseChatChoice,
  parseCustomParams,
  requestFor,
} from "../../../src/server/chat/vendors.mjs";

const zh = createTranslator("zh-CN");
const problem = (fn) => {
  try {
    fn();
  } catch (error) {
    return zh.text(error.problem);
  }
  assert.fail("应该抛错");
};
/** 写错时报的那句话里说到了什么 */
const says = (fn, pattern) => assert.match(problem(fn), pattern);

test("每一家说的协议都登记了；登记了地址的是 https", () => {
  for (const vendor of CHAT_VENDORS) {
    assert.ok(PROTOCOLS[vendor.protocol], `${vendor.id} 的协议 ${vendor.protocol} 没有登记`);
    if (vendor.baseUrl !== null) assert.match(vendor.baseUrl, /^https:\/\//);
    assert.match(vendor.id, /^[a-z0-9]+$/, "id 要能当 key 文件名");
  }
});

test("只写厂商：用它的默认模型；写了模型照写的来，模型名里可以有斜杠和冒号", () => {
  assert.deepEqual(parseChatChoice("deepseek"), { vendor: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(parseChatChoice(" DeepSeek/deepseek-v4-pro "), { vendor: "deepseek", model: "deepseek-v4-pro" });
  // OpenRouter、SiliconFlow 的模型名带斜杠，Ollama 的带冒号
  assert.deepEqual(parseChatChoice("custom/Qwen/Qwen3-8B"), { vendor: "custom", model: "Qwen/Qwen3-8B" });
  assert.deepEqual(parseChatChoice("custom/qwen3:8b"), { vendor: "custom", model: "qwen3:8b" });
  assert.equal(formatChatChoice({ vendor: "custom", model: "Qwen/Qwen3-8B" }), "custom/Qwen/Qwen3-8B");
});

test("清单里没有的模型名也照样认：由那一家判断有没有", () => {
  assert.deepEqual(parseChatChoice("deepseek/deepseek-v5"), { vendor: "deepseek", model: "deepseek-v5" });
});

test("写错时说清哪里不对", () => {
  says(() => parseChatChoice(""), /空/);
  says(() => parseChatChoice("nobody/x"), /nobody/);
  says(() => parseChatChoice("nobody/x"), /deepseek/);
  // 自定义的没有默认模型
  says(() => parseChatChoice("custom"), /模型/);
  says(() => parseChatChoice("deepseek/has space"), /has space/);
});

test("地址：去掉结尾的斜杠和多贴的 /chat/completions；只认 http(s)，不许带账号密码、查询串", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl(" https://api.example.com/v1/chat/completions "), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  says(() => normalizeBaseUrl(""), /空/);
  says(() => normalizeBaseUrl("api.example.com"), /http/);
  says(() => normalizeBaseUrl("ftp://api.example.com"), /http/);
  says(() => normalizeBaseUrl("https://user:pass@api.example.com"), /账号/);
  says(() => normalizeBaseUrl("https://api.example.com/v1?key=1"), /\?/);
});

test("接口地址：登记了的用登记的；自定义的用用户填的，名字是它的主机名（报错时说是哪一家）", () => {
  assert.deepEqual(chatEndpoint(findChatVendor("deepseek"), {}), {
    baseUrl: "https://api.deepseek.com",
    name: "DeepSeek",
  });
  assert.deepEqual(chatEndpoint(findChatVendor("custom"), { customUrl: "https://api.siliconflow.cn/v1" }), {
    baseUrl: "https://api.siliconflow.cn/v1",
    name: "api.siliconflow.cn",
  });
  says(() => chatEndpoint(findChatVendor("custom"), {}), /地址/);
});

test("额外参数：一段 JSON 对象；空的、{} 都是没填；不是对象、写坏了、改了不许改的几项都说清哪里不对", () => {
  assert.deepEqual(parseCustomParams(""), {});
  assert.deepEqual(parseCustomParams("  "), {});
  assert.deepEqual(parseCustomParams("{}"), {});
  assert.deepEqual(parseCustomParams(' { "max_completion_tokens": 1024, "thinking": { "type": "disabled" } } '), {
    max_completion_tokens: 1024,
    thinking: { type: "disabled" },
  });
  says(() => parseCustomParams("{max_completion_tokens: 1024}"), /JSON/);
  says(() => parseCustomParams("[1, 2]"), /对象/);
  says(() => parseCustomParams("1024"), /对象/);
  says(() => parseCustomParams("null"), /对象/);
  // 模型名、提示词、整段回话的读法由 OrangeSpeakEasy 管，改了会把成品弄乱
  says(() => parseCustomParams('{"model": "x"}'), /model/);
  says(() => parseCustomParams('{"messages": []}'), /messages/);
  says(() => parseCustomParams('{"stream": true}'), /stream/);
});

test("额外参数存下来的样子：去掉空白、没填是空字符串，读回来还是同一个对象", () => {
  assert.equal(formatCustomParams({}), "");
  const text = formatCustomParams({ reasoning_effort: "minimal", max_completion_tokens: 1024 });
  assert.equal(text, '{"reasoning_effort":"minimal","max_completion_tokens":1024}');
  assert.deepEqual(parseCustomParams(text), { reasoning_effort: "minimal", max_completion_tokens: 1024 });
});

test("额外参数只给自定义服务，盖过它默认带的；清单里的厂商不带（它们的参数按实测调过）", () => {
  const params = { max_completion_tokens: 1024, enable_thinking: true };
  assert.deepEqual(requestFor(findChatVendor("custom"), "gpt-5-mini", { customParams: params }), params);
  assert.deepEqual(requestFor(findChatVendor("custom"), "gpt-5-mini"), {});
  assert.deepEqual(requestFor(findChatVendor("bailian"), "qwen3.8-flash", { customParams: params }), {
    enable_thinking: false,
  });
});

test("清单里的模型一项一个：id 不重复，有名字和出自哪家；默认模型在清单里", () => {
  for (const vendor of CHAT_VENDORS) {
    const ids = vendor.models.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, `${vendor.id} 的模型有重复`);
    for (const model of vendor.models) {
      assert.ok(model.name && model.maker, `${vendor.id}/${model.id} 缺名字或出处`);
      assert.ok(Object.isFrozen(model), `${vendor.id}/${model.id} 没冻上`);
    }
    if (vendor.defaultModel !== null) assert.ok(ids.includes(vendor.defaultModel), `${vendor.id} 的默认模型不在清单里`);
  }
});

test("每个模型要带的参数：这一家都带的加上模型自己的；清单外的模型只带这一家的", () => {
  const vendor = {
    request: { enable_thinking: false, temperature: 1 },
    models: [{ id: "a", request: { temperature: 0.7 } }, { id: "b" }],
  };
  assert.deepEqual(requestFor(vendor, "a"), { enable_thinking: false, temperature: 0.7 });
  assert.deepEqual(requestFor(vendor, "b"), { enable_thinking: false, temperature: 1 });
  assert.deepEqual(requestFor(vendor, "elsewhere"), { enable_thinking: false, temperature: 1 });
});

test("百炼润色的模型都关思考，用的是国内站的兼容地址", () => {
  const bailian = findChatVendor("bailian");
  assert.equal(bailian.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  for (const { id } of bailian.models) assert.equal(requestFor(bailian, id).enable_thinking, false, id);
  assert.ok(!bailian.models.some(({ id }) => id === "kimi-k3"), "K3 关不掉思考，以 Kimi 的文档为准");
  assert.deepEqual(parseChatChoice("bailian"), { vendor: "bailian", model: "qwen3.8-flash" });
});

test("Kimi 官方：国内站地址，每个模型都关思考；只能开着思考的代码模型和 K3（文档说始终推理）不在清单里", () => {
  const moonshot = findChatVendor("moonshot");
  assert.equal(moonshot.baseUrl, "https://api.moonshot.cn/v1");
  for (const { id } of moonshot.models) {
    assert.deepEqual(requestFor(moonshot, id), { thinking: { type: "disabled" } }, id);
  }
  assert.ok(!moonshot.models.some(({ id }) => id.startsWith("kimi-k2.7-code") || id === "kimi-k3"));
  assert.deepEqual(parseChatChoice("moonshot"), { vendor: "moonshot", model: "kimi-k2.6" });
});

/**
 * 按清单装出这一家的协议客户端（同 refine/polisher.mjs 的 createChatPolisher），交给假的 fetch 润色一次。
 * 回发出去的请求和拆出来的结果：没拿真 key 的几家靠它对照官方文档查请求形状和回话怎么拆
 */
async function polishOnce(id, model, reply) {
  const vendor = findChatVendor(id);
  const { baseUrl, name } = chatEndpoint(vendor);
  const protocol = await PROTOCOLS[vendor.protocol].load();
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  const client = protocol.createClient({
    baseUrl,
    apiKey: "k",
    model,
    name,
    request: requestFor(vendor, model),
    costOf: (await vendor.prices()).costOf,
    fetch,
  });
  const result = await client.complete({ system: "s", user: "u" });
  return { request: requests[0], result };
}

test("智谱：国内站地址，每个模型都关思考；强制思考的 GLM-5.3 系列、跑不通的 GLM-4.7-Flash 不在清单里", () => {
  const zhipu = findChatVendor("zhipu");
  assert.equal(zhipu.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  for (const { id, unverified } of zhipu.models) {
    assert.deepEqual(requestFor(zhipu, id), { thinking: { type: "disabled" } }, id);
    assert.equal(unverified, undefined, id);
  }
  assert.ok(!zhipu.models.some(({ id }) => id.startsWith("glm-5.3") || id === "glm-4.7-flash"));
  assert.deepEqual(parseChatChoice("zhipu"), { vendor: "zhipu", model: "glm-4.7-flashx" });
});

test("智谱：请求照官方文档发到 /chat/completions、带上关思考；成品在 message.content，用量照 OpenAI 的写法记", async () => {
  // 回话照智谱对话补全的接口文档写（https://docs.bigmodel.cn/api-reference/模型-api/对话补全）
  const { request, result } = await polishOnce("zhipu", "glm-4.7-flashx", {
    id: "2025",
    request_id: "r1",
    model: "glm-4.7-flashx",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "周一上午十点开会" } }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 12,
      total_tokens: 1212,
      prompt_tokens_details: { cached_tokens: 1000 },
    },
  });
  assert.equal(request.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(request.body.model, "glm-4.7-flashx");
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(result.text, "周一上午十点开会");
  assert.equal(result.usage.cachedTokens, 1000);
  assert.ok(result.usage.costUsd > 0);
});

test("MiniMax：国内站地址，只收能关思考的 M3，请求带上关思考、思考另放一处；拿真 key 验过", () => {
  const minimax = findChatVendor("minimax");
  assert.equal(minimax.baseUrl, "https://api.minimax.cn/v1");
  assert.deepEqual(
    minimax.models.map(({ id }) => id),
    ["MiniMax-M3"],
  );
  assert.deepEqual(requestFor(minimax, "MiniMax-M3"), { thinking: { type: "disabled" }, reasoning_split: true });
  assert.equal(minimax.models[0].unverified, undefined);
});

test("MiniMax：请求照官方文档发到 /chat/completions；万一带回了思考，也不当成品", async () => {
  // 回话照 MiniMax Chat Completions 的接口文档写（https://platform.minimax.cn/docs/api-reference/text-chat-openai）
  const { request, result } = await polishOnce("minimax", "MiniMax-M3", {
    id: "066a2a568140d42ba2020cec72d592c0",
    model: "MiniMax-M3",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", name: "MiniMax AI", content: "周一上午十点开会", reasoning_content: "想了想" },
      },
    ],
    usage: {
      total_tokens: 473,
      prompt_tokens: 170,
      completion_tokens: 303,
      prompt_tokens_details: { cached_tokens: 157 },
    },
    base_resp: { status_code: 0, status_msg: "" },
  });
  assert.equal(request.url, "https://api.minimax.cn/v1/chat/completions");
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.body.reasoning_split, true);
  assert.equal(result.text, "周一上午十点开会");
  assert.equal(result.usage.cachedTokens, 157);
  assert.ok(result.usage.costUsd > 0);
});
