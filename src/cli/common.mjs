import { parseArgs } from "node:util";
import { SPOKEN_ACTIONS } from "../hotkeys/actions.mjs";
import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { renderStatus } from "./render/status.mjs";

// 各个子命令共用的：参数解析、两种"用错了"的错误、读设置和统计、确保后台应用在运行。
// 给人看的话都按 io.t（这一次命令行用的语言）翻。

/** 命令敲错了：以 2 退出，并提示去看 help。problem 是一句 msg 或现成的字 */
export class UsageError extends LocalizedError {}

/** 设置写错了：以 2 退出 */
export class ConfigError extends LocalizedError {}

export function parse(args, options = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(msg("cli.badArgs", { reason: error.message }), { cause: error });
  }
}

/** @param {string} usage 文案里这条命令的用法（cli.syntax.*） */
export function noPositionals(positionals, usage) {
  if (positionals.length > 0) {
    throw new UsageError(msg("cli.extraArgs", { args: positionals.join(" "), usage: msg(`cli.syntax.${usage}`) }));
  }
}

export function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UsageError(msg("cli.positiveInteger", { flag }));
  return number;
}

export function currentSettings(io) {
  try {
    return resolveSettings({ file: io.paths.settingsFile, env: io.env });
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
}

/** 一句话（msg 或现成的字）按这一次的语言写出来 */
export const say = (io, message) => io.out(io.t.text(message));

/** 后台应用启动途中要说的话（msg），按这一次的语言写出来 */
export const progressOf = (io) => (message) => say(io, message);

/** 今天和累计的统计，只数说话的功能（划词翻译不算听写）。一次都没用过（库还不存在）时两项都是 null */
export function readStats(io) {
  try {
    const history = io.openHistory(io.paths.historyDb, { readOnly: true });
    if (history === null) return { today: null, total: null };
    try {
      const midnight = io.now();
      midnight.setHours(0, 0, 0, 0);
      return {
        today: history.stats({ since: midnight.toISOString(), kinds: SPOKEN_ACTIONS }),
        total: history.stats({ kinds: SPOKEN_ACTIONS }),
      };
    } finally {
      history.close();
    }
  } catch {
    // 统计是顺带看的：库坏了、版本比程序新时只少这两行，status 照常报运行状态（面板本来就有 total 为空的分支）
    return { today: null, total: null };
  }
}

export const renderOptions = (io) => ({
  color: io.color,
  truecolor: io.truecolor,
  now: io.now(),
  timeZone: io.timeZone,
  t: io.t,
  platform: io.platform,
});

export function showStatus(io, status, settings) {
  io.out(renderStatus({ status, version: io.version, settings, stats: readStats(io) }, renderOptions(io)));
}

export function permissionMissing({ permissions }) {
  return permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;
}

export async function ensureRunning(io) {
  const status = await io.daemon.status();
  if (status !== null) return status;
  io.out(io.t("cli.starting"));
  return io.daemon.start({ onProgress: progressOf(io) });
}

/**
 * 是不是"后台不认识这条命令"的失败：正在运行的是升级之前启动的那一个时会遇到。
 * 它的回话是中文的，0.5 以前一直这么说（"不认识的命令：…"）；新版后台的错误回复还会带上结构化
 * code。两种都认：先看 code，旧后台不回 code，再按那句中文原话兜底——服务端将来改了措辞（含做
 * i18n），认法靠 code 这条不断，降级分支不会退化成向用户抛原始错误。
 * @param {unknown} error requestControl 拒绝时抛的错
 * @returns {boolean}
 */
export function isUnknownCommand(error) {
  return error?.code === "unknown_command" || /^不认识的命令/.test(error?.message ?? "");
}

/** 装成应用的那个怎么重启：从命令行重启会换成终端启动的那一个 */
export const PACKAGED_RELAUNCH = msg("cli.packagedRelaunch");
