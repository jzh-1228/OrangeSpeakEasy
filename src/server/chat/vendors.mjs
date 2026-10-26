import { LocalizedError, msg } from "../../i18n/index.mjs";

// 润色这一跳（本地转写出的原文 → 成品文字）用的纯文字大模型，一家一项。每家写清：走哪种接口协议、默认地址、
// 默认模型、为了快要多带哪些参数、怎么算钱。
//
// 协议是策略（PROTOCOLS）。现在只有 OpenAI 的 Chat Completions 一种：DeepSeek、通义、Kimi、智谱、OpenRouter、
// Ollama、LM Studio 都支持它。要接只支持别的协议的服务（比如 Anthropic Messages），就写一个协议适配器、在 PROTOCOLS 登记。
//
// 每一家的 models 是给人挑的清单，一项一个模型：id 是发请求用的名字，name 是给人看的，maker 是谁做的（界面按它配图标，
// 同一个平台上可能有好几家的模型，比如百炼上有通义、DeepSeek、Kimi），request 是这个模型在 vendor.request 之外
// 还要多带、或者要改掉的参数（同一家的模型关思考的写法不一定一样）。清单外的模型名照样发，只带 vendor.request。
// tested 是跑过成批真实录音的评测，issue 是已知的问题（文案在 models.issues.<issue>）：模型广场按它们打标签。
// 不同平台上的同一个模型 name 写成一样的，模型广场按 maker 加 name 把它们并成一行、各平台是这一行的渠道。
// 清单里没有的服务不用等我们登记：选 custom，自己填地址、模型和 key（GitHub issue #2 要的就是这个）。
//
// key 按厂商存，和原生链路共用一套存放处（storage/paths.mjs 的 keyFile）。以后这里加上 openai、gemini，
// 用的就是用户已经存好的那把。
// 这个文件只放说明，不加载协议的代码：命令行列模型时也要读这份清单。加一家 = 在 CHAT_VENDORS 里登记一项。

export const PROTOCOLS = Object.freeze({
  "openai-chat": Object.freeze({ name: "OpenAI Chat Completions", load: () => import("./openai-chat.mjs") }),
});

/** 清单里的模型逐项冻上：模块之外谁也改不了 */
const models = (entries) => Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));

export const CHAT_VENDORS = Object.freeze([
  Object.freeze({
    id: "deepseek",
    name: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    keyPage: "https://platform.deepseek.com/api_keys",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    // deepseek-flash 就是 DeepSeek-V4.1-Flash（官方 GET /models 和价目页，2026-10-16）
    defaultModel: "deepseek-flash",
    /** 官方 GET /models 列出的（2026-10-16） */
    models: models([
      // 两个都跑过润色提示词的评测（scripts/dev/eval-prompt.mjs，60 条真实录音，docs/implementation-notes.md）
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", maker: "deepseek", tested: true },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", maker: "deepseek", tested: true },
    ]),
    // 它默认开着思考（档位 high）。2026-10-16 实测同一句话：开着要 1.5 秒、多出 185 个 token，关掉 0.7 秒，
    // 成品一样。润色用不着思考，所以关掉
    request: Object.freeze({ thinking: Object.freeze({ type: "disabled" }) }),
    prices: () => import("./prices/deepseek.mjs"),
  }),
  Object.freeze({
    id: "bailian",
    // 界面上按语言写成"阿里云百炼"或"Alibaba Cloud Bailian"（文案 providers.bailian.name），这里的名字给日志和报错用
    name: "Bailian",
    keyEnv: "BAILIAN_API_KEY",
    keyPage: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    protocol: "openai-chat",
    // 国内站的 OpenAI 兼容地址。不用带业务空间 id：2026-10-16 拿业务空间级的 key 实测，GET /models 和对话都通
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.8-flash",
    // 百炼上的模型关思考都认 enable_thinking: false（2026-10-16 逐个实测，回话里没有推理内容）。
    // 只认 true 的（glm-5.3、glm-5.3-prime、MiniMax-M2.5 回 400 "restricted to True"）关不掉思考，润色不上它们
    request: Object.freeze({ enable_thinking: false }),
    // 2026-10-16 拿这把 key 逐个调通的。原厂经百炼代理的（kimi/…、ZHIPU/…、MiniMax/… 这类带前缀的）要先在控制台开通，
    // 没开通时回 400 "The product is not activated"，开通了再验、再加进来
    models: models([
      { id: "qwen3.8-max", name: "Qwen3.8 Max", maker: "qwen" },
      { id: "qwen3.8-flash", name: "Qwen3.8 Flash", maker: "qwen" },
      { id: "qwen3.7-plus", name: "Qwen3.7 Plus", maker: "qwen" },
      { id: "qwen3.8-27b", name: "Qwen3.8 27B", maker: "qwen" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", maker: "deepseek" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", maker: "deepseek" },
      // kimi-k3 不收：传 enable_thinking: false 回话里没有推理内容，可 Kimi 官方文档说 K3 始终推理、关不掉，
      // 可能只是不把思考吐出来，以文档为准（同 moonshot 那一家）
    ]),
    prices: () => import("./prices/bailian.mjs"),
  }),
  Object.freeze({
    id: "moonshot",
    name: "Kimi",
    keyEnv: "MOONSHOT_API_KEY",
    // 国内站 platform.moonshot.cn 已经整站跳到 platform.kimi.com（2026-10-16）
    keyPage: "https://platform.kimi.com/console/api-keys",
    protocol: "openai-chat",
    // 官方文档的示例用的还是这个地址（https://platform.kimi.com/docs/guide/use-thinking-models）
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    // kimi-k2.6 默认开着思考，thinking: { type: "disabled" } 关掉（https://platform.kimi.com/docs/api/models-overview）。
    // 2026-10-16 拿真 key 实测同一段原文：开着 9.6 秒、681 个推理 token；关掉 0.8–1.8 秒，推理内容是空的
    request: Object.freeze({ thinking: Object.freeze({ type: "disabled" }) }),
    // 官方 GET /models 列出四个（2026-10-16）。kimi-k2.7-code 和它的高速版不收：代码专用，而且只能开着思考
    // （关掉回 400 "only type=enabled is allowed for this model"，实测）
    models: models([
      { id: "kimi-k2.6", name: "Kimi K2.6", maker: "kimi" },
      // kimi-k3 不收：文档说 K3 始终推理、不该传 thinking，只能拿 reasoning_effort 在 low/high/max 里调
      // （https://platform.kimi.com/docs/guide/use-reasoning-effort）。2026-10-16 实测带上 thinking: disabled 回话里
      // 没有推理内容，但那是文档外的行为，也可能只是不把思考吐出来，以文档为准
    ]),
    prices: () => import("./prices/moonshot.mjs"),
  }),
  Object.freeze({
    id: "zhipu",
    // 界面上按语言写成"智谱"或"Zhipu GLM"（文案 providers.zhipu.name），这里的名字给日志和报错用
    name: "Zhipu",
    keyEnv: "ZHIPU_API_KEY",
    keyPage: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    protocol: "openai-chat",
    // 国内站开放平台的地址（https://docs.bigmodel.cn/cn/api/introduction）
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.7-flashx",
    // GLM-5.x、4.7 系列默认开着思考，thinking: { type: "disabled" } 关掉（https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode）。
    // GLM-5.3、GLM-5.3-Flash、GLM-5.3-FlashX 强制思考、传 disabled 报错（同一页和
    // https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash），所以不收
    request: Object.freeze({ thinking: Object.freeze({ type: "disabled" }) }),
    // 每个档位收能关思考的最新一个（模型概览 https://docs.bigmodel.cn/cn/guide/start/model-overview，2026-10-16）。
    // 不收：GLM-5.1、GLM-5、GLM-4.7（旗舰这一档有更新的 5.2）、GLM-5-Turbo（专为龙虾类智能体任务调的）、
    // GLM-4-Long（超长文本专用）、GLM-4.5-AirX（价目页上连历史价都没有它，拿不准国内站还卖不卖）、GLM-Z1 系列（只能推理）、
    // 视觉理解模型（润色用不上看图）、GLM-4 那几个带日期的快照。
    // 2026-10-16 拿真 key 逐个调通：关思考时推理 token 是 0（开着是 108–164 个）。GLM-4.5-Air 开着思考时 usage 不报
    // reasoning_tokens，记账认不出，好在关得掉。免费的 GLM-4.7-Flash 跑不通、先不上架：当天连试五次都回
    // 429 业务码 1305"该模型当前访问量过大"，回头再试
    models: models(
      [
        { id: "glm-5.2", name: "GLM-5.2" },
        { id: "glm-4.7-flashx", name: "GLM-4.7-FlashX" },
        { id: "glm-4.5-air", name: "GLM-4.5-Air" },
      ].map((model) => ({ ...model, maker: "zhipu" })),
    ),
    prices: () => import("./prices/zhipu.mjs"),
  }),
  Object.freeze({
    id: "minimax",
    name: "MiniMax",
    keyEnv: "MINIMAX_API_KEY",
    // 国内站的文档和控制台已经从 platform.minimaxi.com 搬到 platform.minimax.cn（2026-10-16 旧地址跳过去）。
    // 这是按量付费的 key；M Plan 套餐的订阅 key 在另一页（https://platform.minimax.cn/docs/guides/quickstart-preparation）
    keyPage: "https://platform.minimax.cn/user-center/basic-information/interface-key",
    protocol: "openai-chat",
    // 国内站的 OpenAI 兼容地址（https://platform.minimax.cn/docs/guides/text-generation）
    baseUrl: "https://api.minimax.cn/v1",
    defaultModel: "MiniMax-M3",
    // MiniMax-M3 默认开着思考，thinking: { type: "disabled" } 让它跳过思考直接回答
    // （https://platform.minimax.cn/docs/api-reference/text-openai-api 的"Thinking 控制"）。
    // reasoning_split: true 只管思考放哪：万一还有思考，单独放进 reasoning_content；不拆的话它带着 <think> 标签
    // 写在 content 里，会被当成品贴出去
    request: Object.freeze({ thinking: Object.freeze({ type: "disabled" }), reasoning_split: true }),
    // 2026-10-16 拿真 key 实测：关思考回话里没有推理 token（不关时 usage 报 reasoning_tokens），错的 key 回 401。
    // 只有 M3 能关思考：M2.x 传 disabled 不生效（同一页），而且 M2.5、M2.7 系列
    // 2026-10-19 起不对新用户开放、11-18 下线（https://platform.minimax.cn/docs/guides/models-intro）；
    // MiniMax-M3.1-Flash-Preview 是预览版、只给套餐用户，关思考回 400；M2-her 是角色扮演专用
    models: models([{ id: "MiniMax-M3", name: "MiniMax M3", maker: "minimax" }]),
    prices: () => import("./prices/minimax.mjs"),
  }),
  Object.freeze({
    id: "custom",
    // 报错时说的是用户填的那个地址的主机名（chatEndpoint），这里的名字只在列清单时用
    name: "Custom",
    keyEnv: "ORANGESPEAKEASY_CUSTOM_API_KEY",
    keyPage: null,
    protocol: "openai-chat",
    /** 用户填（设置里的 customUrl） */
    baseUrl: null,
    /** 用户填，没有默认的 */
    defaultModel: null,
    models: models([]),
    // 不知道对面是谁，不多带任何参数：多带了不认识的参数，有的服务会回 400。
    // 对面要什么参数由用户自己填（设置里的 customParams，GitHub issue #8），见 requestFor
    request: Object.freeze({}),
    // 不知道价，花费记成空
    prices: null,
  }),
]);

/** @returns {(typeof CHAT_VENDORS)[number] | null} 大小写不论；不认识的是 null */
export function findChatVendor(id) {
  const wanted = String(id).toLowerCase();
  return CHAT_VENDORS.find((vendor) => vendor.id === wanted) ?? null;
}

/**
 * 发给这一家的这个模型要多带的参数：这一家都带的，加上清单里这个模型自己的（同名的以模型的为准）。
 * 自定义服务再加上用户填的额外参数（同名的以用户的为准）。清单里的厂商不加：它们的参数逐个实测调过
 * @param {{ customParams?: Record<string, unknown> | null }} [settings]
 */
export function requestFor(vendor, model, { customParams = null } = {}) {
  const entry = vendor.models.find(({ id }) => id === model);
  const extra = vendor.id === "custom" ? customParams : null;
  return { ...vendor.request, ...entry?.request, ...extra };
}

/**
 * 额外参数里不许写的几项：模型名、提示词由 OrangeSpeakEasy 发，回话按整段 JSON 读（openai-chat.mjs），
 * 改了它们成品就乱了，不如当场说清
 */
const RESERVED_PARAMS = Object.freeze(["model", "messages", "stream"]);

/**
 * 用户写的额外参数（一段 JSON 对象）→ 对象。空的当作没填，是 {}。写错了就抛 LocalizedError，说清哪里不对
 * @returns {Record<string, unknown>}
 */
export function parseCustomParams(value) {
  const text = String(value ?? "").trim();
  if (text === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocalizedError(msg("chat.paramsNotJson"));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalizedError(msg("chat.paramsNotObject"));
  }
  const reserved = RESERVED_PARAMS.find((name) => Object.hasOwn(parsed, name));
  if (reserved) {
    throw new LocalizedError(msg("chat.paramsReserved", { name: reserved, names: RESERVED_PARAMS.join(" / ") }));
  }
  return parsed;
}

/** 存进设置里的样子：去掉空白的一行 JSON；没有参数时是空字符串（和没填一样） */
export const formatCustomParams = (params) => (Object.keys(params).length === 0 ? "" : JSON.stringify(params));

/**
 * 模型名。比原生链路的宽：别家的模型名常带斜杠（OpenRouter 的 deepseek/deepseek-chat、
 * SiliconFlow 的 Qwen/Qwen3-8B）、冒号（Ollama 的 qwen3:8b）、@（Workers AI 的 @cf/…）
 */
const MODEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * 用户写的润色模型 → { vendor, model }。写法：
 *   deepseek                  只写厂商，用它的默认模型
 *   deepseek/deepseek-v4-pro  厂商/模型。只按第一个斜杠分，后面整段都是模型名
 *   custom/Qwen/Qwen3-8B      自定义的必须写模型名
 * 写错了就抛 LocalizedError，说清哪里不对。
 */
export function parseChatChoice(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("models.empty"));
  const slash = text.indexOf("/");
  const name = slash === -1 ? text : text.slice(0, slash);
  const vendor = findChatVendor(name);
  if (!vendor) {
    throw new LocalizedError(
      msg("models.unknownProvider", { name, providers: CHAT_VENDORS.map(({ id }) => id).join(" / ") }),
    );
  }
  const model = slash === -1 ? vendor.defaultModel : text.slice(slash + 1);
  if (model === null) throw new LocalizedError(msg("chat.modelRequired", { vendor: vendor.id }));
  if (!MODEL_NAME.test(model)) throw new LocalizedError(msg("chat.badModelName", { model: JSON.stringify(model) }));
  return { vendor: vendor.id, model };
}

export const formatChatChoice = ({ vendor, model }) => `${vendor}/${model}`;

/**
 * 用户填的接口地址 → 规整后的样子（不带结尾的斜杠）。贴的是完整的 …/chat/completions 也认，去掉那一截。
 * 不许在地址里带账号密码：地址会进日志和设置文件。
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("chat.urlEmpty"));
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.username || url.password) throw new LocalizedError(msg("chat.urlCredentials"));
  if (url.search || url.hash) throw new LocalizedError(msg("chat.urlQuery"));
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * 这一家实际要连的地址，和报错时怎么称呼它。自定义的用用户填的地址，称呼是它的主机名：
 * 报"api.siliconflow.cn 拒绝了请求"比报"Custom 拒绝了请求"有用
 * @param {{ customUrl?: string | null }} settings
 * @returns {{ baseUrl: string, name: string }}
 */
export function chatEndpoint(vendor, { customUrl = null } = {}) {
  if (vendor.baseUrl !== null) return { baseUrl: vendor.baseUrl, name: vendor.name };
  if (!customUrl) throw new LocalizedError(msg("chat.urlMissing"));
  const baseUrl = normalizeBaseUrl(customUrl);
  return { baseUrl, name: new URL(baseUrl).host };
}
