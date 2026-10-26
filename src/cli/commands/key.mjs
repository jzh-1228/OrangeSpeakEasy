import { existsSync, rmSync } from "node:fs";
import { LocalizedError, msg } from "../../i18n/index.mjs";
import { keyVendorOf } from "../../server/modes.mjs";
import { apiKeyProblem, findProvider } from "../../server/providers/index.mjs";
import { findVendor, VENDORS } from "../../server/vendors.mjs";
import { keyFile, oldAppKeyFile } from "../../storage/paths.mjs";
import { routeOf } from "../../storage/settings.mjs";
import { Cancelled } from "../ask-secret.mjs";
import { currentSettings, ensureRunning, PACKAGED_RELAUNCH, parse, UsageError } from "../common.mjs";

// orangespeakeasy key：问 key、交给后台应用验证并保存、删掉。每家模型一把，不写厂商就是设置里正在用的那家
// （native 模式是收音频的那家，local 模式是润色的那家）。
// 启动时（orangespeakeasy start）、切模式和换模型时（mode、model、polish）缺 key 也从这里问。

const MAX_KEY_ATTEMPTS = 3;

/** 存 key 时后台应用要拿它去问一次那一家，那边的超时是 30 秒 */
const SAVE_KEY_TIMEOUT_MS = 45_000;

/**
 * 问 key 之前的那几句说明。它不单独打印，而是和提示一起交给 askSecret：
 * 那一步会先关掉终端的回显再显示文字。否则手快的人看到"要 key 了"就粘贴，
 * 而回显还没关，key 会被终端原样显示出来（在伪终端里实测到过）。
 */
const keyPreamble = (t, provider, skippable) =>
  [
    "",
    // 收音频的那家拿到的是录音，润色的那家只拿到本机转出来的文字
    t(findProvider(provider.id) ? "cli.key.need" : "cli.key.needText", { provider: provider.name }),
    // 自定义服务没有申请的页面
    ...(provider.keyPage ? [t("cli.key.getOne", { url: provider.keyPage })] : []),
    t("cli.key.storage"),
    ...(skippable ? [t("cli.key.skip")] : []),
    t("cli.key.prompt"),
  ].join("\n");

/**
 * 在终端里一把一把地问某一家的 key：每调一次给出一把样子没问题的，样子不对的当场说、当场再问。
 * 前后一共最多问 MAX_KEY_ATTEMPTS 次。
 * @returns {() => Promise<string | null>} null：没填、按了 Ctrl-C，或者已经问够了次数
 */
export function keyPrompter(io, provider) {
  let asked = 0;
  return async function nextKey() {
    while (asked < MAX_KEY_ATTEMPTS) {
      let value;
      try {
        value = await io.askSecret(asked++ === 0 ? keyPreamble(io.t, provider, true) : io.t("cli.key.prompt"));
      } catch (error) {
        if (error instanceof Cancelled) return null;
        throw error;
      }
      if (value === "") return null;
      const problem = apiKeyProblem(value);
      if (problem === null) return value;
      io.err(io.t("common.sentence", { text: problem }));
    }
    return null;
  };
}

/** 0.6 及以前的后台应用认得 key 的几家：那时只有收音频的这两家 */
const BEFORE_MODES_VENDORS = ["gemini", "openai"];

/**
 * 升级之前启动的后台应用不认得的那家，先拦下，说要重启：
 * - 0.3 的不认按厂商区分的 set-key、forget-key：它会忽略 provider，把别家的 key 拿去问 Gemini、
 *   删 key 时删掉的是 Gemini 那把。它的状态里没有 provider 这一项。Gemini 的 key 它本来就会存、会删，不拦。
 * - 0.6 及以前的没有模式这一层，不认得润色的那几家（DeepSeek、自定义服务），存 key 会被它拒掉、说不认识。
 *   它的状态里没有 mode 这一项。
 */
export async function refuseLegacyDaemon(io, provider) {
  if (provider.id === "gemini") return;
  const status = await io.daemon.status();
  if (status === null) return;
  const unknown = !("provider" in status) || (!("mode" in status) && !BEFORE_MODES_VENDORS.includes(provider.id));
  if (!unknown) return;
  const restart = status.packaged ? PACKAGED_RELAUNCH : msg("cli.runRestart");
  throw new LocalizedError(msg("cli.key.legacyDaemon", { provider: provider.name, restart }));
}

/**
 * 把某一家的一把 key 交给后台应用验证并保存。
 * @param {Record<string, string>} [changes] 要一起换成的设置（切模式、换模型前先存 key 时给），拿它们验证
 * @returns {Promise<boolean>} 通过了没有
 */
export async function submitKey(io, value, provider, changes) {
  await refuseLegacyDaemon(io, provider);
  io.out(io.t("cli.key.verifying"));
  const result = await io.daemon.request(
    "set-key",
    changes ? { key: value, provider: provider.id, changes } : { key: value, provider: provider.id },
    { timeoutMs: SAVE_KEY_TIMEOUT_MS },
  );
  if (result.ok) io.out(io.t("cli.key.saved"));
  else io.err(io.t("cli.key.rejected", { problem: result.problem }));
  return result.ok;
}

/** 设置里那种模式要用谁家的 key：native 是收音频的那家，local 是润色的那家；private 不用 key，是 undefined */
export const currentProvider = (io) => keyVendorOf(routeOf(currentSettings(io)));

/**
 * 要换成用某一家，在哪一层换：收音频的在 native（orangespeakeasy model），润色的在 local 第二跳（orangespeakeasy polish）。
 * 不在那一层的模式里时，换的命令只在那种模式里能用，要连模式一起切
 * @param {string} current 现在是哪种模式
 */
function switchCommand(provider, current) {
  if (findProvider(provider.id)) {
    return current === "native"
      ? `orangespeakeasy model ${provider.id}`
      : `orangespeakeasy mode native --model ${provider.id}`;
  }
  const polish = provider.defaultModel ? provider.id : `${provider.id}/<model> --url <url>`;
  return current === "local" ? `orangespeakeasy polish ${polish}` : `orangespeakeasy mode local --polish ${polish}`;
}

/**
 * 不用启动后台就看得出某一家的 key 在哪：stored（存过）、env（环境变量给了），都没有是 null。
 * 看的是命令启动的那一份：装成应用的那个各存各的，从这里读不到它的状态
 */
export function keySource(io, provider) {
  if (io.env[provider.keyEnv]?.trim()) return "env";
  if (existsSync(keyFile(io.paths, provider.id))) return "stored";
  return null;
}

/**
 * 某一家有没有 key，以会用到它的那个后台为准：在运行的话照它报的算（它启动时的环境变量命令行这边看不到；
 * 0.7.0 及以前的 App 还另存一份 <厂商>-key.app.bin）；否则看命令行这边（重启后台时用的就是这边的环境变量和文件）。
 * @param {object | null} status 正在运行的后台报的状态；没在运行时是 null
 */
export function keySourceFor(io, provider, status) {
  if (status?.keys) return status.keys[provider.id] ?? null;
  return keySource(io, provider);
}

/** 启动之前就看得出有 key 可用：存过、环境变量给了，或者 key 归单独启动的服务端管；不用 key 的模式也算 */
export function hasKeyAlready(io) {
  const provider = currentProvider(io);
  return provider === undefined || keySource(io, provider) !== null || Boolean(io.env.ORANGESPEAKEASY_SERVER_URL);
}

/**
 * 这种状态是不是填一把新的 key 就能解决。有两种不是：Gemini 拒绝了请求（多半是模型名或档位写错），
 * 和环境变量里的那把不对（存一把新的也没用，下次启动用的还是环境变量）。
 */
export const needsNewKey = (key) =>
  key.state === "missing" ||
  key.state === "unreadable" ||
  (key.state === "rejected" && key.cause !== "other" && key.source !== "env");

export async function key(args, io) {
  const { values, positionals } = parse(args, { forget: { type: "boolean", default: false } });
  // 后面可以写一个厂商名。别的东西多半就是一把 key：不照做，也不把它再打一遍
  const named = positionals.length === 1 ? findVendor(positionals[0]) : null;
  if (positionals.length > 0 && named === null) {
    throw new UsageError(msg("cli.key.notInline", { providers: VENDORS.map(({ id }) => id).join(" / ") }));
  }
  const provider = named ?? currentProvider(io);
  // 数据隐私模式不用 key，没有"正在用的那家"：要写明是哪一家
  if (provider === undefined) {
    throw new UsageError(msg("cli.key.whichVendor", { providers: VENDORS.map(({ id }) => id).join(" / ") }));
  }
  // 在问 key 之前拦：不让人粘贴了一把 key 才听说存不了
  await refuseLegacyDaemon(io, provider);

  if (values.forget) {
    // 在运行的话让它把手里的那把也放下；没在运行时不必为了删文件把它启动起来
    if ((await io.daemon.status()) !== null) await io.daemon.request("forget-key", { provider: provider.id });
    // 共用的那份，和 0.7.0 及以前 App 另存的那份，都删
    for (const file of [keyFile(io.paths, provider.id), oldAppKeyFile(io.paths, provider.id)])
      rmSync(file, { force: true });
    io.out(io.t("cli.key.forgotten", { provider: provider.name }));
    return 0;
  }

  // 自定义服务没有默认模型，单给一把 key 验证不了：跟着模型名和地址一起填
  if (provider.id === "custom" && provider.id !== currentProvider(io)?.id) {
    io.err(io.t("cli.key.customWithModel"));
    return 1;
  }
  let value;
  try {
    value = await io.askSecret(keyPreamble(io.t, provider, false));
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.err(io.t("cli.key.cancelled"));
    return 1;
  }
  if (value === "") {
    io.err(io.t("cli.key.nothingRead"));
    return 1;
  }
  const problem = apiKeyProblem(value);
  if (problem !== null) {
    io.err(io.t("cli.key.badShapeUnchanged", { problem }));
    return 1;
  }
  await ensureRunning(io);
  if (!(await submitKey(io, value, provider))) return 1;
  if (provider.id !== currentProvider(io)?.id) {
    // 在运行就以它报的模式为准（0.6 及以前的不报，那时只有 native）
    const status = await io.daemon.status();
    const current = status ? (status.mode ?? "native") : currentSettings(io).mode.value;
    io.out(io.t("cli.key.switchHint", { command: switchCommand(provider, current) }));
  }
  return 0;
}
