import { LocalizedError } from "../i18n/index.mjs";
import { DEFAULT_SOURCE, DEFAULT_TRANSCRIBER, findModel, findSource, MODELS, SOURCES } from "../models/catalog.mjs";
import { cloudTranscriberOf } from "./asr/cloud/vendors.mjs";
import { normalizeBaseUrl, parseChatChoice, parseCustomParams } from "./chat/vendors.mjs";
import { DEFAULT_MODE, DEFAULT_POLISH, keyVendorOf, keyVendorsOf, parseMode } from "./modes.mjs";
import {
  apiKeyProblem,
  DEFAULT_MODEL_CHOICE,
  DEFAULT_THINKING_LEVEL,
  findProvider,
  parseModelChoice,
} from "./providers/index.mjs";

// 单独启动服务端时（node src/server/main.mjs）从环境变量读配置。平时服务跑在后台应用里，设置走 src/storage/settings.mjs。

const THINKING_LEVELS = findProvider("gemini").thinkingLevels;

/** 环境变量里的这一项：空的当作没设（0.3 单独启动服务端时就是这样） */
const given = (env, name) => (env[name]?.trim() ? env[name].trim() : null);

/** 按 parse 读一项，写错了报错时说清是哪个环境变量 */
function read(env, name, parse) {
  try {
    return parse(env[name]);
  } catch (error) {
    throw new Error(`${name} 写的是 ${JSON.stringify(env[name])}，${error.message}`, { cause: error });
  }
}

/** 原生链路选哪家哪个模型。ORANGESPEAKEASY_MODEL 优先；GEMINI_MODEL 是 0.3 以前的写法，只能写 Gemini 的模型名，照样认 */
function modelFrom(env) {
  for (const name of ["ORANGESPEAKEASY_MODEL", "GEMINI_MODEL"]) {
    if (given(env, name)) return read(env, name, parseModelChoice);
  }
  return DEFAULT_MODEL_CHOICE;
}

function thinkingFrom(env) {
  const thinkingLevel = (env.GEMINI_THINKING_LEVEL ?? DEFAULT_THINKING_LEVEL).toUpperCase();
  if (!THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error(
      `GEMINI_THINKING_LEVEL 要是 ${THINKING_LEVELS.join(" / ")} 之一，现在是 ${JSON.stringify(env.GEMINI_THINKING_LEVEL)}`,
    );
  }
  return thinkingLevel;
}

/** 本地转写链路：第一跳用哪个本地模型（或云端的 厂商/模型）、润色交给谁、自定义服务的地址和额外参数 */
function localRouteFrom(env) {
  const written = given(env, "ORANGESPEAKEASY_TRANSCRIBER") ?? DEFAULT_TRANSCRIBER;
  const cloud = cloudTranscriberOf(written);
  const transcriber = cloud ? `${cloud.vendor}/${cloud.model}` : written;
  if (!cloud && !findModel(transcriber)) {
    throw new Error(
      `ORANGESPEAKEASY_TRANSCRIBER 写的是 ${JSON.stringify(transcriber)}，能填的有 ${MODELS.map(({ id }) => id).join(" / ")}`,
    );
  }
  const polish = given(env, "ORANGESPEAKEASY_POLISH")
    ? read(env, "ORANGESPEAKEASY_POLISH", parseChatChoice)
    : parseChatChoice(DEFAULT_POLISH);
  const customUrl = given(env, "ORANGESPEAKEASY_CUSTOM_URL")
    ? read(env, "ORANGESPEAKEASY_CUSTOM_URL", normalizeBaseUrl)
    : null;
  if (polish.vendor === "custom" && customUrl === null) {
    throw new Error("润色交给自定义服务时要给它的地址：ORANGESPEAKEASY_CUSTOM_URL");
  }
  const params = given(env, "ORANGESPEAKEASY_CUSTOM_PARAMS")
    ? read(env, "ORANGESPEAKEASY_CUSTOM_PARAMS", parseCustomParams)
    : {};
  const customParams = Object.keys(params).length > 0 ? params : null;
  return { mode: "local", transcriber, polish, customUrl, customParams };
}

/** 本地模型没下载过时先从哪个源下（models/catalog.mjs 的 SOURCES） */
function modelSourceFrom(env) {
  const source = given(env, "ORANGESPEAKEASY_MODEL_SOURCE") ?? DEFAULT_SOURCE;
  if (!findSource(source)) {
    throw new Error(
      `ORANGESPEAKEASY_MODEL_SOURCE 写的是 ${JSON.stringify(source)}，能填的有 ${SOURCES.map(({ id }) => id).join(" / ")}`,
    );
  }
  return source;
}

/** 从环境变量读配置。写错了就报错退出，不悄悄换成默认值。 */
export function loadConfig(env) {
  const mode = given(env, "ORANGESPEAKEASY_MODE") ? read(env, "ORANGESPEAKEASY_MODE", parseMode) : DEFAULT_MODE;
  const thinkingLevel = thinkingFrom(env);
  const route = mode === "local" ? localRouteFrom(env) : { mode: "native", model: modelFrom(env), thinkingLevel };
  const modelSource = modelSourceFrom(env);

  // 路线要的每一家都要有 key（第一跳交给云端、润色交给另一家时是两家）
  const keys = {};
  for (const { id, keyEnv } of keyVendorsOf(route)) {
    const key = env[keyEnv]?.trim();
    if (!key) throw new Error(`缺少环境变量 ${keyEnv}`);
    const keyProblem = apiKeyProblem(key);
    // 单独启动服务端是调试用的，报错照日志的习惯用英文
    if (keyProblem) throw new Error(`${keyEnv}: ${new LocalizedError(keyProblem).message}`);
    keys[id] = key;
  }
  const apiKey = keys[keyVendorOf(route).id];

  const port = env.PORT === undefined ? 8790 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 要是 1–65535 的整数，现在是 ${JSON.stringify(env.PORT)}`);
  }

  // 只监听本机：这个服务没有登录，不该被局域网里的其他机器连到
  return { host: "127.0.0.1", port, route, apiKey, keys, modelSource };
}
