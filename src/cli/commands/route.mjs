import { msg, problemOf } from "../../i18n/index.mjs";
import { patchSettings, routeOf } from "../../storage/settings.mjs";
import { ConfigError, currentSettings, ensureRunning, isUnknownCommand } from "../common.mjs";
import { applySettings, storeSetting, warnIfEnvOverrides } from "./config.mjs";
import { keyPrompter, keySourceFor, refuseLegacyDaemon, submitKey } from "./key.mjs";

// 切模式、换各模式里的模型，几个命令（mode、model、transcriber、polish）共用的几步：
// 现在是哪种模式、不在那种模式时拦下、缺 key 时先问、交给正在运行的那个当场换。
// 换的规矩（哪种模式里能换什么）在内核里（src/app/modes.mjs），这里先按同样的规矩拦一遍，
// 免得问了 key 才被拒；没在运行时没有内核可问，就按设置文件里的模式算。
// 内核选了就换上、不先验证：换上以后那家的 key 没通过（模型名写错、key 失效），照实说、退出码是 1。

/** 切模式、换模型要等后台应用问一次那一家，那边的超时是 30 秒 */
const SWITCH_TIMEOUT_MS = 45_000;

/** 现在是哪种模式：在运行就以它报的为准（0.6 及以前的不报，那时只有 native），没在运行看设置 */
export function modeNow(io, status) {
  if (status) return status.mode ?? "native";
  return currentSettings(io).mode.value;
}

/**
 * 某种模式里的东西只能在那种模式里换：不在就说先切过去
 * @param {string} what 换的是什么（modes.what.*）
 * @returns {boolean} 在不在
 */
export function inMode(io, status, mode, what) {
  const current = modeNow(io, status);
  if (current === mode) return true;
  io.err(io.t("cli.modes.notIn", { current, mode, what: msg(`modes.what.${what}`) }));
  return false;
}

/**
 * 几项设置写得对不对，按存设置时的规矩查，返回规整后的值。写错了以 2 退出，说能填什么
 * @param {Record<string, string>} changes
 */
export function checked(io, changes) {
  let patched;
  try {
    patched = patchSettings(currentSettings(io), changes);
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
  return Object.fromEntries(Object.keys(changes).map((name) => [name, patched[name].value]));
}

/** 某种模式按现在的设置、换上 changes 之后走哪条路线（changes 先用 checked 查过） */
export const routeWith = (io, mode, changes = {}) => routeOf(patchSettings(currentSettings(io), changes), mode);

/**
 * 要用的那家还没有 key 时先问一把，拿要换成的设置（changes）验证过存好
 * @returns {Promise<boolean>} 有 key 了没有
 */
export async function ensureKey(io, vendor, changes) {
  if (keySourceFor(io, vendor, await io.daemon.status()) !== null) return true;
  await refuseLegacyDaemon(io, vendor);
  if (!io.interactive) {
    io.err(io.t("cli.model.noKeyNonInteractive", { provider: vendor.name, id: vendor.id }));
    return false;
  }
  // 先问再启动：启动的那段时间终端照常回显，提前粘贴的 key 会显示出来（同 orangespeakeasy start）
  const nextKey = keyPrompter(io, vendor);
  for (let key = await nextKey(); key !== null; key = await nextKey()) {
    await ensureRunning(io);
    if (await submitKey(io, key, vendor, changes)) return true;
  }
  io.err(io.t("cli.model.notSwitched", { provider: vendor.name }));
  return false;
}

/**
 * 换上：在运行就交给内核当场换（不重启，装成应用的也一样），没在运行就存进设置、下次启动生效。
 * 正在运行的是旧版本、不认识这条命令：存进设置，重启让它生效（以前改设置的老路）。
 * @param {object} change
 * @param {string} change.command 内核的哪条命令（set-mode、set-model、set-transcriber、set-polish）
 * @param {object} change.params
 * @param {Record<string, string>} change.changes 要写进设置的几项（没在运行、旧版本时用）
 * @param {object} change.done 换好了说什么（msg）
 * @returns {Promise<number>} 退出码
 */
export async function applyChange(io, { command, params, changes, done }) {
  const store = () => {
    for (const [name, value] of Object.entries(changes)) {
      storeSetting(io, name, value);
      warnIfEnvOverrides(io, name);
    }
  };
  if ((await io.daemon.status()) === null) {
    store();
    io.out(io.t.text(done));
    io.out(io.t("cli.config.nextLaunch"));
    return 0;
  }
  let result;
  try {
    result = await io.daemon.request(command, params, { timeoutMs: SWITCH_TIMEOUT_MS });
  } catch (error) {
    // 升级之前启动的那一个还不认识这条命令（怎么认见 isUnknownCommand）
    if (!isUnknownCommand(error)) throw error;
    store();
    io.out(io.t.text(done));
    return applySettings(io, null);
  }
  if (!result.ok) {
    io.err(io.t("cli.modes.notSwitched", { problem: result.problem }));
    return 1;
  }
  io.out(io.t.text(done));
  io.out(io.t("cli.modes.applied"));
  if (result.note) io.out(io.t("common.sentence", { text: result.note }));
  const status = await io.daemon.status();
  reportLocalModel(io, status?.localModel);
  // 内核等找 key、验 key 有了结论才回话：没通过就是还不能用
  if (status?.key?.state === "rejected" || status?.key?.state === "unreadable") {
    io.err(io.t("cli.modes.notUsable", { problem: status.key.problem }));
    return 1;
  }
  return 0;
}

/** 换到 local、换了本地模型之后：模型还在下载、装载、没装上时说一声 */
function reportLocalModel(io, localModel) {
  if (localModel?.state === "downloading") {
    const percent = Math.floor((localModel.received / localModel.total) * 100);
    io.out(io.t("cli.modes.downloading", { percent }));
  } else if (localModel?.state === "loading") io.out(io.t("cli.modes.loading"));
  else if (localModel?.state === "failed") io.err(io.t("common.sentence", { text: localModel.problem }));
}
