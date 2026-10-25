import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlError, TimeoutError } from "../control.mjs";
import {
  createTranslator,
  LocalizedError,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
  terminalLocales,
} from "../i18n/index.mjs";
import { log, logToFile } from "../log.mjs";
import { readMoveRecord, stillMoving } from "../move/state.mjs";
import { CHAT_VENDORS } from "../server/chat/vendors.mjs";
import { PROVIDERS } from "../server/providers/index.mjs";
import { adoptAppKeys } from "../storage/app-keys.mjs";
import { migrateLegacyData, migrateLegacySettings } from "../storage/legacy.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { THEMES } from "../themes/index.mjs";
import { ConfigError, UsageError } from "./common.mjs";

// speakmore 命令：把"装好依赖、编小帮手、起后台应用、填 key、看历史、改设置"收成几个子命令。
// 真正干活的是后台应用（src/app），这里通过控制通道指挥它；历史和设置文件则直接读写。
// 每个子命令在 commands/ 里一个文件，这里只管分发、收拾错误。命令模块和真实运行时的 io（io.mjs：
// 后台、更新、本机模型、搬家、历史库）都等到真要跑某条命令时才加载，只问帮助、版本时不必读进来。
// 说什么语言：设置里的 language，跟随系统时照命令行的惯例看 LC_ALL、LC_MESSAGES、LANG（src/i18n）。

/** help 里 history 的默认条数：和 commands/history.mjs 的 DEFAULT_HISTORY_LIMIT 一样。那个模块要真跑 history 时才加载 */
const HISTORY_LIMIT = 20;

/** speakmore help 的那段说明，按这一次的语言写 */
const help = (t) =>
  t("cli.help", {
    limit: HISTORY_LIMIT,
    providers: PROVIDERS.map(({ id }) => id).join(" / "),
    polishers: CHAT_VENDORS.map(({ id }) => id).join(" / "),
    themes: THEMES.map(({ id }) => `${id} ${t(`themes.${id}.name`)}`).join(" / "),
  });

/** 命令名 → 加载那一条命令的模块。第一次用到时才读进来，没跑到的命令（连同它背后的依赖）不加载 */
const COMMANDS = {
  start: () => import("./commands/lifecycle.mjs").then((m) => m.start),
  stop: () => import("./commands/lifecycle.mjs").then((m) => m.stop),
  restart: () => import("./commands/lifecycle.mjs").then((m) => m.restart),
  status: () => import("./commands/lifecycle.mjs").then((m) => m.status),
  update: () => import("./commands/update.mjs").then((m) => m.update),
  key: () => import("./commands/key.mjs").then((m) => m.key),
  mode: () => import("./commands/mode.mjs").then((m) => m.mode),
  model: () => import("./commands/model.mjs").then((m) => m.model),
  transcriber: () => import("./commands/local.mjs").then((m) => m.transcriber),
  polish: () => import("./commands/local.mjs").then((m) => m.polish),
  config: () => import("./commands/config.mjs").then((m) => m.config),
  theme: () => import("./commands/config.mjs").then((m) => m.theme),
  history: () => import("./commands/history.mjs").then((m) => m.history),
  dict: () => import("./commands/dict.mjs").then((m) => m.dict),
  usage: () => import("./commands/usage.mjs").then((m) => m.usage),
  logs: () => import("./commands/logs.mjs").then((m) => m.logs),
  settings: () => import("./commands/config.mjs").then((m) => m.settings),
  move: () => import("./commands/move.mjs").then((m) => m.move),
  uninstall: () => import("./commands/uninstall.mjs").then((m) => m.uninstall),
};

/**
 * 直接改家目录里文件的命令（设置、词典、key、历史、模型、卸载）：正在搬家时不做。后台没在跑时它们直接写文件，
 * 写进的是正在被拷走的旧目录，拷完就跟着旧目录一起删了。stop、status 这些不挡：换家时安装脚本自己要用 stop
 */
const WRITES_HOME = new Set([
  "key",
  "mode",
  "model",
  "transcriber",
  "polish",
  "config",
  "theme",
  "dict",
  "history",
  "uninstall",
]);

function refuseWhileMoving(io) {
  let record = null;
  try {
    record = readMoveRecord(io.paths);
  } catch {
    // 记录读不出来（权限这类）：不因为它挡住命令
    return;
  }
  if (stillMoving(record, io.moverAlive ? { alive: io.moverAlive } : {})) {
    throw new LocalizedError(msg("move.inProgress", { home: io.paths.home, to: record.to ?? "?" }));
  }
}

/**
 * 执行一条命令。
 * @param {string[]} argv 命令名和它的参数（不含 node 和脚本路径）
 * @param {object} io 和外界打交道的全部途径，测试时整个换掉。真实的见 io.mjs 的 createIo
 * @returns {Promise<number>} 退出码：0 成功，1 没成，2 命令或设置写错了
 */
export async function run(argv, io) {
  try {
    if (argv.some((arg) => arg === "--help" || arg === "-h") || argv[0] === "help") {
      io.out(help(io.t));
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      io.out(io.version);
      return 0;
    }
    const [name = "start", ...rest] = argv;
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(msg("cli.unknownCommand", { name }));
    if (WRITES_HOME.has(name)) refuseWhileMoving(io);
    const load = COMMANDS[name];
    return await (await load())(rest, io);
  } catch (error) {
    const said = () => io.err(io.t.text(problemOf(error)));
    if (error instanceof UsageError) {
      said();
      io.err(io.t("cli.seeHelp"));
      return 2;
    }
    if (error instanceof ConfigError) {
      said();
      return 2;
    }
    if (error instanceof ControlError) {
      said();
      if (error instanceof TimeoutError) io.err(io.t("cli.stuck"));
      return 1;
    }
    // 自己抛出来的、带着一句人话的错误照直说；其余的是程序本身的毛病，连调用栈一起留给排查的人
    if (!(error instanceof LocalizedError) && error?.constructor !== Error) throw error;
    said();
    return 1;
  }
}

/** 往终端写一行：没带换行就补上（createIo 里也有同样的一行，那边要等真跑命令时才加载） */
const write = (stream) => (text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);

/**
 * 这一次命令行说什么语言：设置里写了就用它，跟随系统时看终端的语言。
 * 设置文件坏了的话先按终端的语言说：要读设置的命令接着会把坏在哪照实报出来
 * （io.mjs 里有一份一样的：那边不能在只问帮助、版本时加载，所以各留一份）
 */
function cliLocale(paths, env) {
  let setting = SYSTEM_LOCALE;
  try {
    setting = resolveSettings({ file: paths.settingsFile, env }).language.value;
  } catch {
    setting = SYSTEM_LOCALE;
  }
  return resolveLocale(setting, terminalLocales(env));
}

/**
 * 只问帮助或版本时的 io：读一下 package.json 里的版本号、定位文件里的家目录、设置里的语言，别的都不碰。
 * 后台、更新、本机模型、搬家、历史库都不在这条路上——那些是 createIo（io.mjs）的事
 */
function createHelpIo({ packageDir, env = process.env }) {
  const paths = resolvePaths(env);
  const t = createTranslator(cliLocale(paths, env));
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return {
    out: write(process.stdout),
    err: write(process.stderr),
    env,
    // NO_COLOR 是通行的约定：设了就不上色
    color: Boolean(process.stdout.isTTY) && !env.NO_COLOR,
    // 终端说自己支持 24 位色时，才画得出主题本来的颜色
    truecolor: Boolean(process.stdout.isTTY) && !env.NO_COLOR && /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""),
    version: manifest.version,
    t,
  };
}

/** 提到帮助、版本的参数：这样的调用不读也不动数据目录（0.1 版的数据、旧 key、旧设置都不搬） */
const mentionsHelpOrVersion = (argv) => argv.some((arg) => ["--help", "-h", "help", "--version", "-v"].includes(arg));

/**
 * run() 真的只会答帮助、版本的情形：--help/-h 写在哪都算，help 和 --version/-v 要当第一个参数。
 * 只有这时才能用轻量的 createHelpIo；别的写法后面还要跑命令，得用带后台、更新、历史库的 createIo
 */
const asksHelpOrVersion = (argv) =>
  argv.some((arg) => arg === "--help" || arg === "-h") || ["help", "--version", "-v"].includes(argv[0]);

/** bin/speakmore.mjs 调的入口 */
export async function main(argv) {
  let io;
  try {
    const packageDir = resolve(import.meta.dirname, "../..");
    if (asksHelpOrVersion(argv)) {
      io = createHelpIo({ packageDir });
    } else {
      const { createIo } = await import("./io.mjs");
      io = createIo({ packageDir });
    }
  } catch (error) {
    // 数据目录的路径不合用：还没有 io 可用，按终端的语言直接说
    const t = createTranslator(resolveLocale(SYSTEM_LOCALE, terminalLocales(process.env)));
    console.error(t.text(problemOf(error)));
    return 2;
  }
  // 0.1 版的数据在别处，有的话先搬过来。只是问版本和帮助时不动
  if (!mentionsHelpOrVersion(argv)) {
    try {
      const moved = await migrateLegacyData({ paths: io.paths, log: { info() {}, warn: log.warn } });
      // 0.7.0 及以前 App 另存的那份 key 搬进共用的文件：没启动后台时命令行也看得到
      adoptAppKeys({ paths: io.paths, log: { info() {}, warn: log.warn } });
      // 0.13 以前的热键设置换成新写法：要赶在第一次读设置之前（docs/hotkey-research.md 5.9）
      const migrated = migrateLegacySettings(io.paths.settingsFile);
      // App 起来时文件已经换好了，它记不到这一条：命令行自己记进日志文件
      if (migrated) logToFile(io.paths.logFile, "info", "settings_migrated", { ...migrated, by: "cli" });
      if (moved.length > 0) io.out(io.t("cli.migrated", { home: io.paths.home, items: moved.join(", ") }));
    } catch (error) {
      io.err(io.t.text(problemOf(error)));
      return 1;
    }
  }
  return run(argv, io);
}
