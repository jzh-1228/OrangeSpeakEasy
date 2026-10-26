import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ALREADY_RUNNING_EXIT_CODE } from "../control.mjs";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { createInstance } from "../instance.mjs";
import { rotateIfLarge } from "../log.mjs";
import { settleMove } from "../move/index.mjs";
import { ensureHome } from "../storage/paths.mjs";
import { ensureHelper as defaultEnsureHelper } from "./native-helper.mjs";

// 后台应用（src/app，跑在 Electron 里）的起停。它脱离终端运行：关掉终端窗口它还在，
// 要靠控制通道才知道它在不在、状态如何。途中要说的话和出错的原因都是还没定语言的（msg），由命令行按它的语言翻。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 后台应用用哪个 Electron 来跑。
 * 装好的 OrangeSpeakEasy 自带一份，这条命令本身就是拿它当 Node 跑起来的，所以正在跑我们的这个可执行文件就是它。
 * 从源码仓库跑（开发时）用的是系统的 Node，这时去依赖里找：electron 这个包导出的就是可执行文件的路径，
 * 没下载过的话它会在这一步自己去下载。
 */
function resolveElectronBinary(packageDir, onProgress) {
  if (process.versions.electron) return process.execPath;
  const require = createRequire(join(packageDir, "package.json"));
  let electronDir;
  try {
    electronDir = dirname(require.resolve("electron/package.json"));
  } catch {
    throw new LocalizedError(msg("cli.daemon.noElectron", { dir: packageDir }));
  }
  if (!existsSync(join(electronDir, "dist"))) onProgress(msg("cli.daemon.downloading"));
  try {
    return require("electron");
  } catch (error) {
    throw new LocalizedError(msg("cli.daemon.downloadFailed", { reason: error.message }), { cause: error });
  }
}

/** 日志的最后几行；还没有日志时是一句话（msg） */
function logTail(file, lines = 8) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return msg("cli.daemon.emptyLog");
    throw error;
  }
}

/** 启动途中在等什么（文案里的名字）。只说用户看得见、需要他动手或等一下的那两种 */
function startingHint(status) {
  if (status.permissions?.microphone === "not-determined") return "cli.daemon.micPrompt";
  if (status.key?.state === "checking") return "cli.daemon.verifying";
  return null;
}

/**
 * @param {object} options
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} options.paths
 * @param {string} options.packageDir 这个包装在哪：Electron 以它为应用目录启动
 * @param {Record<string, string | undefined>} options.env 传给后台应用的环境
 * @param {string} [options.locale] 命令行用的语言。每条命令都带上它，后台按它把要给人看的话翻好再回
 *   （0.5 及以前的命令行不带，后台就按自己的语言翻：它们和 status --json 的读者都只认字）
 */
export function createDaemon({
  paths,
  packageDir,
  env,
  locale,
  spawn = nodeSpawn,
  resolveElectron = (onProgress) => resolveElectronBinary(packageDir, onProgress),
  ensureHelper = defaultEnsureHelper,
  // 这两样没给就用 instance.mjs 里真的那一套
  kill,
  commandOf,
  pollMs = 150,
  statusTimeoutMs = 5_000,
  connectTimeoutMs = 30_000,
  // 第一次启动要等用户点麦克风的授权框，所以给得宽
  readyTimeoutMs = 90_000,
  quitTimeoutMs = 5_000,
  // 起之前看一眼有没有搬到一半的（src/move）：正在搬就不起，上次断在半路的先收拾好
  settle = (report) => settleMove({ paths, env, report, atStartup: true }),
}) {
  // 问状态、请它退出是这个家目录里正在运行的那个的事，命令行和更新共用（src/instance.mjs）
  const instance = createInstance({ paths, locale, kill, commandOf, pollMs, statusTimeoutMs, quitTimeoutMs });
  const { status } = instance;

  return {
    status,
    request: instance.request,
    stop: instance.stop,

    /**
     * 启动后台应用，等它准备好（key 验证完、麦克风的授权框有了回应）。调用前要确认它没有在运行。
     * @param {{ onProgress: (message: object) => void }} options 途中要让用户知道的事（msg）
     * @returns {Promise<object>} 启动后的状态；等得太久时 starting 仍是 true
     */
    async start({ onProgress }) {
      await settle(onProgress);
      ensureHelper(packageDir, { onBuild: () => onProgress(msg("cli.daemon.building")) });
      const electron = resolveElectron(onProgress);

      // 日志要写进家目录。先按规矩把它建出来：顺着日志的路径一路建的话，目录的权限会是默认的那种
      ensureHome(paths);
      rotateIfLarge(paths.logFile);
      const logFd = openSync(paths.logFile, "a");
      // 带着 ELECTRON_RUN_AS_NODE 的话 Electron 会把自己当成普通的 Node，窗口和热键都不会有
      const { ELECTRON_RUN_AS_NODE: _dropped, ...childEnv } = env;
      /** 我们启动的那个进程是怎么结束的；还在运行时是 null */
      let ended = null;
      // 在家目录里起：Windows 上工作目录是哪个文件夹，那个文件夹就删不掉。起它的命令可能正跑在
      // 要删的旧目录里（搬家后重新打开）、或者用户随便哪个目录，都不该被 App 占着
      const child = spawn(electron, [packageDir], {
        detached: true,
        cwd: paths.home,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...childEnv, ORANGESPEAKEASY_CLI: "1" },
      });
      child.on("exit", (code, signal) => {
        ended = { code, reason: signal ? msg("cli.daemon.signal", { signal }) : msg("cli.daemon.exitCode", { code }) };
      });
      child.on("error", (error) => {
        ended = { code: null, reason: String(error.message) };
      });
      child.unref();
      closeSync(logFd);

      // 另一条 orangespeakeasy 命令抢先启动了一个，我们这个发现后自己退出：不算失败，接着等抢先的那个
      const lostRace = () => ended?.code === ALREADY_RUNNING_EXIT_CODE;
      const failed = () =>
        new LocalizedError(
          msg("cli.daemon.failed", {
            reason: ended && !lostRace() ? ended.reason : msg("cli.daemon.exitedEarly"),
            file: paths.logFile,
            tail: logTail(paths.logFile),
          }),
        );

      let current = null;
      for (const deadline = Date.now() + connectTimeoutMs; current === null; await sleep(pollMs)) {
        current = await status();
        if (current !== null) break;
        if (ended && !lostRace()) throw failed();
        if (Date.now() > deadline) {
          throw new LocalizedError(
            msg("cli.daemon.noAnswer", { seconds: connectTimeoutMs / 1000, file: paths.logFile }),
          );
        }
      }

      const said = new Set();
      for (const deadline = Date.now() + readyTimeoutMs; current.starting && Date.now() < deadline; ) {
        const hint = startingHint(current);
        if (hint && !said.has(hint)) {
          said.add(hint);
          onProgress(msg(hint));
        }
        await sleep(pollMs);
        current = await status();
        if (current === null) throw failed();
      }
      return current;
    },
  };
}
