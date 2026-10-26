import { TimeoutError } from "../../control.mjs";
import { problemOf } from "../../i18n/index.mjs";
import {
  currentSettings,
  noPositionals,
  PACKAGED_RELAUNCH,
  parse,
  permissionMissing,
  progressOf,
  readStats,
  showStatus,
} from "../common.mjs";
import { INDENT } from "../render/text.mjs";
import { currentProvider, hasKeyAlready, keyPrompter, keySource, needsNewKey, submitKey } from "./key.mjs";
import { offerDownload } from "./local-models.mjs";
import { chooseProvider } from "./mode.mjs";
import { updateNotes } from "./update.mjs";

// 起停和看状态：orangespeakeasy（start）、stop、restart、status。

export async function start(args, io) {
  noPositionals(parse(args).positionals, "start");
  // 先读一遍：设置文件坏了的话，在问任何问题之前就说清楚
  currentSettings(io);
  let provider = currentProvider(io);

  let started = await io.daemon.status();
  // 第一次用：用哪家、key 都在启动之前问。启动要等一阵（第一次还要下载、点授权框），那段时间终端是照常回显的，
  // 到那时才问的话，提前粘贴的人会看到 key 显示在屏幕上
  const firstRun = started === null && io.interactive && !hasKeyAlready(io);
  /** 选哪家时按了 Ctrl-C：后面的 key 也不问了 */
  let declined = false;
  // 设置里（或者环境变量）已经定了用哪种模式、哪家的，就是那家，不再问
  const settings = currentSettings(io);
  if (firstRun && settings.mode.source === "default" && settings.model.source === "default") {
    const chosen = await chooseProvider(io);
    if (chosen === null) declined = true;
    else provider = chosen.vendor;
  }
  // 数据隐私模式不用 key（provider 是 undefined 或 null）：下面一把都不问
  const nextKey = provider ? keyPrompter(io, provider) : async () => null;
  /** 问到的第一把 key。undefined：还没问过；null：问了，没填 */
  let firstKey;
  if (started === null) {
    if (firstRun && !declined && provider && keySource(io, provider) === null) firstKey = await nextKey();
    io.out(io.t("cli.starting"));
    started = await io.daemon.start({ onProgress: progressOf(io) });
  }
  if (firstKey === undefined && !declined && io.interactive && needsNewKey(started.key)) firstKey = await nextKey();
  // 不填或取消都不纠缠，面板里会说还差它
  for (let value = firstKey ?? null; value !== null; value = await nextKey()) {
    if (await submitKey(io, value, provider)) break;
  }
  // local、private 模式要的本机模型还没下载（第一次就选了它、或者删掉了）：问一句要不要现在下，不下也照常启动
  const local = (await io.daemon.status())?.localModel;
  if (io.interactive && !declined && local?.state === "missing" && !local.total) await offerDownload(io, local.model);
  // 重新查一遍系统权限：用户可能刚去系统设置里改过
  const status = (await io.daemon.status({ recheck: true })) ?? started;

  const openSettings = io.interactive && !status.starting && permissionMissing(status);
  // 第一次用的人走一遍首次引导（看功能、查快捷键、开权限）；用过的人只是缺了权限，打开设置就够了。
  // 请求名沿用 show-settings：老版本的后台不认识 onboarding 这个参数，照样打开设置
  if (openSettings) await io.daemon.request("show-settings", firstRun ? { onboarding: true } : {});
  io.out("");
  // 刚才可能选了别家，设置变了
  showStatus(io, status, currentSettings(io));
  if (openSettings) io.out(io.t(firstRun ? "cli.lifecycle.openedOnboarding" : "cli.lifecycle.openedSettings"));
  return 0;
}

/** 停的结果各说什么（文案里的名字） */
const STOPPED = {
  "not-running": "cli.lifecycle.notRunning",
  quit: "cli.lifecycle.stopped",
  killed: "cli.lifecycle.killed",
};

export async function stop(args, io) {
  noPositionals(parse(args).positionals, "stop");
  io.out(io.t(STOPPED[await io.daemon.stop()]));
  return 0;
}

export async function restart(args, io) {
  noPositionals(parse(args).positionals, "restart");
  currentSettings(io);
  let current = null;
  try {
    current = await io.daemon.status();
  } catch (error) {
    // 卡住不答话：正是要重启的时候，下面的 stop 会把它强行结束
    if (!(error instanceof TimeoutError)) throw error;
  }
  if (current?.packaged) {
    io.err(io.t("cli.lifecycle.packagedRestart"));
    io.err(io.t("cli.lifecycle.howToRestart", { relaunch: PACKAGED_RELAUNCH }));
    return 1;
  }
  await io.daemon.stop();
  return start([], io);
}

export async function status(args, io) {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } });
  noPositionals(positionals, "status");
  const settings = currentSettings(io);
  const current = await io.daemon.status({ recheck: true });
  // 顺带看有没有新版本（一天最多问一次下载地址，App 问过的这边也认）和更新进行得怎样：和 App 设置里显示的是同一份。
  // 这是顺带的：家目录里的记录读不了也不能让看状态失败，照实提一句
  let check = { available: false, behind: [], latest: null };
  let progress = null;
  try {
    check = await io.updates.check({ runningApp: current?.packaged ? current.pid : null });
    progress = io.updates.progress();
  } catch (error) {
    io.err(io.t.text(problemOf(error)));
  }
  if (values.json) {
    const newVersion = check.available ? check.latest : null;
    io.out(
      JSON.stringify({
        running: current !== null,
        status: current,
        settings,
        stats: readStats(io),
        newVersion,
      }),
    );
  } else {
    showStatus(io, current, settings);
    for (const note of updateNotes(io, check, progress)) io.out(`\n${INDENT}${note}`);
  }
  return current?.summary.ready ? 0 : 1;
}
