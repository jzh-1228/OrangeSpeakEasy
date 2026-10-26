import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { compareVersions } from "../update/versions.mjs";

// App 这边的版本检查和更新：设置 › 通用里"软件更新"那一行、菜单栏的提醒。查和换都是内核的事（src/update），
// 命令行的 status、update 用的是同一套、同一份记录。
// 检查在这个进程里做。更新另起一个进程去做（src/update/background.mjs）：做到一半要让这个 App 退出、换掉、再打开。
// 它进行到哪一步写在 update.json 里，这边隔一会儿看一眼，有变化就让窗口重画。

/** 顺带的检查多久看一次。真去问下载地址的一天最多一次（内核按共用的记录管），这里只是让开着好几天的 App 也知道 */
const QUIET_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** 更新进行中隔多久看一眼 update.json */
const WATCH_MS = 500;
/** 没说是哪个版本的失败（问版本那一步就没成）过了这么久就不提了 */
const FAILURE_SHOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 一次没成的更新还值不值得提：它要换的版本比现在的新（后来换成了，不管用的哪种办法，就不提）；
 * 不知道要换哪个版本的，一天之内提
 */
export function relevantFailure(progress, current, now = new Date()) {
  if (progress?.state !== "failed") return false;
  if (progress.version) return compareVersions(progress.version, current) > 0;
  return now - Date.parse(progress.finishedAt ?? 0) < FAILURE_SHOWN_MS;
}

/**
 * @param {object} options
 * @param {ReturnType<import("../update/index.mjs").createUpdates>} options.updates
 * @param {string} options.version 这个 App 的版本
 * @param {() => { on: (event: string, listener: (code: number | null) => void) => void }} options.launch
 *   起更新进程（交回子进程，退出时报一声）。起不来就抛
 * @param {() => void} options.onChange 要显示的东西变了：让窗口、菜单栏重画
 * @param {string} options.logFile 更新进程说的话记在哪：它没留下记录就退出时，告诉用户去哪看
 */
export function createAppUpdates({
  updates,
  version,
  launch,
  onChange,
  log,
  logFile,
  now = () => new Date(),
  every = setInterval,
  stopEvery = clearInterval,
}) {
  /** 最近一次检查的结果 */
  let check = null;
  let checking = false;
  /** 用户点了检查却没问到的原因。顺带的检查问不到不说 */
  let checkProblem = null;
  /** 更新进程没起来的原因 */
  let launchProblem = null;
  /** 刚起了更新进程、它还没写下"正在更新" */
  let launching = false;
  /** 这次启动前刚由 App 更新好的版本：设置里说一句"已更新到" */
  let justUpdated = null;
  let watcher = null;

  /**
   * update.json 里现在记着的（中断的算没完成）。读不了（权限、被占着）不能拖垮 App：
   * 记一笔，当没有记录，更新照样能从设置里点
   */
  function recordedProgress() {
    try {
      return updates.progress();
    } catch (error) {
      log.warn("update_record_unreadable", { error: String(error?.message ?? error) });
      return null;
    }
  }

  /** 设置页、菜单栏要的：现在是哪个版本、有没有新的、更新进行到哪了 */
  function describe() {
    const recorded = recordedProgress();
    // 命令行那边正在更新、这边才打开设置：接着盯，进行到哪跟着变
    if (recorded?.state === "running") watch();
    let progress = null;
    if (recorded?.state === "running") progress = recorded;
    else if (launching) progress = { state: "running", phase: "starting", by: "app" };
    else if (relevantFailure(recorded, version, now())) progress = recorded;
    return {
      fromSource: updates.self === null,
      current: version,
      latest: check?.latest ?? null,
      checkedAt: check?.checkedAt ?? null,
      available: Boolean(check?.available),
      // 旧了的不是这个 App 自己、是另一份（终端安装的，或者 OrangeSpeakEasy.app）时是那一份：设置里说是哪一份旧了
      other: check?.available && !check.behind.some((copy) => copy.kind === updates.self) ? check.behind[0] : null,
      checking,
      checkProblem,
      launchProblem,
      progress,
      justUpdated,
    };
  }

  /** 有没有新版本。force：用户点了检查，真去问；不然按共用的记录，一天最多问一次 */
  async function refresh({ force = false } = {}) {
    if (updates.self === null) return;
    checking = force;
    if (force) onChange();
    try {
      check = await updates.check({ force });
      checkProblem = force ? check.problem : null;
    } catch (error) {
      // 读不了家目录里的记录这类：顺带的检查不打扰人，记下来；用户点的照实说
      log.warn("update_check_failed", { error: String(error?.message ?? error) });
      if (force) checkProblem = problemOf(error);
    } finally {
      checking = false;
      onChange();
    }
  }

  /** 更新进行中盯着 update.json：有变化就重画；做完了（没把这个 App 换掉的情形）停下、按新的记录再看一次有没有新版本 */
  function watch() {
    if (watcher !== null) return;
    let last = JSON.stringify(recordedProgress());
    watcher = every(() => {
      const seen = recordedProgress();
      const text = JSON.stringify(seen);
      if (text !== last) {
        last = text;
        onChange();
      }
      if (seen?.state !== "running" && !launching) {
        stopEvery(watcher);
        watcher = null;
        // 这个 App 还开着就看到了结果（没被这次更新停掉）：已经告诉过用户了，下次启动不再说
        if (seen?.by === "app" && ["done", "failed"].includes(seen.state)) markShown();
        refresh().catch(() => {});
      }
    }, WATCH_MS);
  }

  function markShown() {
    try {
      updates.markShown();
    } catch (error) {
      log.warn("update_record_unwritable", { error: String(error?.message ?? error) });
    }
  }

  return {
    describe,
    check: () => refresh({ force: true }).then(describe),

    /** 启动之后：上一次是 App 自己点的更新，说结果（交回 true 让主进程把设置打开）；顺带看看有没有新版本，之后隔一阵看一次 */
    afterLaunch() {
      const recorded = recordedProgress();
      // 这里点的更新做完了（换成了、没换成，或者半路断了）、这个 App 是被它停掉的：把设置亮出来说结果，只说一次。
      // 没被停掉的 App 当场就看到了结果（watch 里记过），不再说
      const announce =
        ["done", "failed"].includes(recorded?.state) &&
        recorded.by === "app" &&
        Boolean(recorded.stopped) &&
        !recorded.shown;
      if (announce) {
        if (recorded.state === "done") justUpdated = recorded.version;
        markShown();
      }
      if (recorded?.state === "running") watch();
      refresh().catch(() => {});
      every(() => refresh().catch(() => {}), QUIET_CHECK_EVERY_MS);
      return announce;
    },

    /** 开始更新：另起一个进程去做。已经在更新了（命令行或者刚才点过）就不再起 */
    start() {
      if (updates.self === null) throw new LocalizedError(msg("preferences.update.fromSource"));
      const before = recordedProgress();
      if (before?.state === "running" || launching) return describe();
      launchProblem = null;
      launching = true;
      try {
        const child = launch();
        child.on("exit", (code) => {
          launching = false;
          // 没留下这一次的记录就退出了（家目录读不了、锁被占着、一启动就出错）：不能让按钮转一下就没了下文
          const after = recordedProgress();
          if (code !== 0 && after?.startedAt === before?.startedAt && after?.state !== "running") {
            launchProblem = msg("update.exitedEarly", { code, log: logFile });
          }
          if (code !== 0) log.warn("update_process_exited", { code });
          onChange();
        });
        // 可执行文件找不到这类：起不来的原因是事后才报的
        child.on("error", (error) => {
          launching = false;
          launchProblem = problemOf(error);
          log.error("update_launch_failed", { error: String(error?.stack ?? error) });
          onChange();
        });
      } catch (error) {
        launching = false;
        launchProblem = problemOf(error);
        log.error("update_launch_failed", { error: String(error?.stack ?? error) });
      }
      onChange();
      watch();
      return describe();
    },
  };
}
