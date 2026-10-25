import { msg, problemOf } from "../../i18n/index.mjs";
import { findChatVendor } from "../../server/chat/vendors.mjs";
import { findProvider, formatModelChoice, PROVIDERS, parseModelChoice } from "../../server/providers/index.mjs";
import {
  ConfigError,
  currentSettings,
  ensureRunning,
  isUnknownCommand,
  parse,
  renderOptions,
  UsageError,
} from "../common.mjs";
import { renderModels } from "../render/models.mjs";
import { keySourceFor } from "./key.mjs";
import { applyChange, ensureKey, inMode, modeNow } from "./route.mjs";

// speakmore model：native 模式这一层，录音直接交给收音频的模型（Gemini、OpenAI）。
// 看有哪几家、换用哪一家的哪个模型、检查某个模型现在能不能用。换只在 native 模式里能换：
// local 模式用的是本机转写和润色两跳，在 speakmore transcriber、speakmore polish 里换。
// 换之前先确认那一家有 key（没有就问），在运行的话交给它当场换，不重启。

/** 检查要等后台应用问一次那一家，那边的超时是 30 秒 */
const CHECK_TIMEOUT_MS = 45_000;

/** 用户写的模型 → { provider, model }；写错了以 2 退出，说能填什么 */
function choiceFrom(value) {
  // 写的是润色的那家（只收文字）：它在 local 模式的第二跳，指过去
  const chat = findChatVendor(value.split("/")[0]);
  if (chat && findProvider(chat.id) === null) {
    throw new ConfigError(msg("cli.model.textOnly", { provider: chat.name, id: chat.id }));
  }
  // 只写一个词时必须是厂商名。设置文件里"只写 Gemini 的模型名"那种旧写法这里不认：
  // 否则 speakmore model nope 会被当成一个叫 nope 的 Gemini 模型
  if (!value.includes("/") && findProvider(value) === null) {
    throw new ConfigError(
      msg("cli.model.unknownProvider", { name: value, providers: PROVIDERS.map(({ id }) => id).join(" / ") }),
    );
  }
  try {
    return parseModelChoice(value);
  } catch (error) {
    throw new ConfigError(msg("cli.model.invalid", { value: JSON.stringify(value), reason: problemOf(error) }), {
      cause: error,
    });
  }
}

/** "Gemini 的 gemini-3.6-flash"：一句 msg */
const describe = ({ provider, model }) => msg("cli.model.describe", { provider: findProvider(provider).name, model });

async function list(io) {
  // 正在用的那家的 key 可能是启动后台应用时从环境变量给的，命令行这边看不到：问一下在运行的那个
  const running = await io.daemon.status();
  const fromDaemon = (provider) =>
    running?.provider === provider.id && running.key.state === "ready" && running.key.source === "env" ? "env" : null;
  const keys = Object.fromEntries(
    PROVIDERS.map((provider) => [provider.id, keySourceFor(io, provider, running) ?? fromDaemon(provider)]),
  );
  io.out(renderModels({ providers: PROVIDERS, setting: currentSettings(io).model, keys }, renderOptions(io)));
  // 不在 native 模式：这里的模型现在用不上
  if (modeNow(io, running) !== "native")
    io.out(`  ${io.t("cli.model.notInNative", { current: modeNow(io, running) })}\n`);
  return 0;
}

/**
 * 换成某一家的某个模型（只在 native 模式里）。那一家还没有 key 的话先问一把、拿这个模型验证过存好再换：
 * 不然换了才发现用不了，用户还得回头去填。
 */
async function switchTo(io, value) {
  const choice = choiceFrom(value);
  if (!inMode(io, await io.daemon.status(), "native", "model")) return 1;
  const model = formatModelChoice(choice);
  if (!(await ensureKey(io, findProvider(choice.provider), { model }))) return 1;
  return applyChange(io, {
    command: "set-model",
    params: { model },
    changes: { model },
    done: msg("cli.model.switched", { model: describe(choice) }),
  });
}

/** 某个模型现在能不能用：交给后台应用，用那一家的 key 发一个最小的请求 */
async function check(io, value) {
  const choice = value === undefined ? parseModelChoice(currentSettings(io).model.value) : choiceFrom(value);
  await ensureRunning(io);
  io.out(io.t("cli.model.checking", { model: describe(choice) }));
  let result;
  try {
    result = await io.daemon.request(
      "check-model",
      { model: formatModelChoice(choice) },
      { timeoutMs: CHECK_TIMEOUT_MS },
    );
  } catch (error) {
    // 正在运行的是升级之前启动的那一个，还不认识这条命令
    if (!isUnknownCommand(error)) throw error;
    io.err(io.t("cli.model.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("cli.model.unusable", { problem: result.problem }));
    return 1;
  }
  const provider = findProvider(choice.provider);
  const from =
    result.source === "env" ? msg("cli.model.fromEnv", { variable: provider.keyEnv }) : msg("cli.model.fromStored");
  io.out(io.t("cli.model.usable", { model: describe(choice), from, seconds: (result.ms / 1000).toFixed(1) }));
  return 0;
}

export async function model(args, io) {
  const [first, second, ...extra] = parse(args).positionals;
  if (first === undefined) return list(io);
  if (first === "check" && extra.length === 0) return check(io, second);
  if (second === undefined) return switchTo(io, first);
  throw new UsageError(msg("cli.syntax.model"));
}
