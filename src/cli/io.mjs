import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createTranslator, resolveLocale, SYSTEM_LOCALE, terminalLocales } from "../i18n/index.mjs";
import { log } from "../log.mjs";
import { createLocalModels } from "../models/library.mjs";
import { createMove } from "../move/index.mjs";
import { openHistory } from "../storage/history.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { createUpdates } from "../update/index.mjs";
import {
  clearUserHome,
  isOurShortcut,
  removeAfterExit,
  removeHomeAfterExit,
  removeLoginItem,
  removePathEntry,
} from "../windows-system.mjs";
import { askSecret, Cancelled } from "./ask-secret.mjs";
import { createDaemon } from "./daemon.mjs";
import { tailFile } from "./tail.mjs";

// 真实运行时的 io：标准输入输出、真的后台应用、真的历史库。
// 这里连着的都是真跑命令才用得上的东西（后台、更新、本机模型、搬家，以及带着 node:sqlite 的历史库），
// 所以只问帮助、版本时不加载这个文件：main.mjs 自己拼一个轻量的 io（createHelpIo）就够了。

/**
 * 删掉钥匙串里加密 key 用的那一条。@returns {boolean} 本来有没有。
 * Windows 上加密 key 的那把钥匙由系统按用户保管（DPAPI），加密后的那份放在运行环境的缓存里，随家目录一起删掉，这里没有要删的
 */
function removeKeychainKey(productName) {
  if (process.platform === "win32") return false;
  try {
    execFileSync("security", ["delete-generic-password", "-s", `${productName} Safe Storage`], { stdio: "pipe" });
    return true;
  } catch (error) {
    // 44：没有这一条
    if (error.status === 44) return false;
    throw new Error(String(error.stderr ?? "").trim() || error.message);
  }
}

/** 问一句普通的话（会回显，比如选用哪一家）。按 Ctrl-C 和问 key 时一样抛 Cancelled */
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve, reject) => {
      // ^C 之后光标还停在提问那一行，换个行，后面的话不接在它后面
      prompt.once("SIGINT", () => {
        process.stderr.write("\n");
        reject(new Cancelled());
      });
      prompt.question(question).then(resolve, reject);
    });
  } finally {
    prompt.close();
  }
}

async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * 这一次命令行说什么语言：设置里写了就用它，跟随系统时看终端的语言。
 * 设置文件坏了的话先按终端的语言说：要读设置的命令接着会把坏在哪照实报出来
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

/** 真实运行时的 io：标准输入输出、真的后台应用、真的历史库 */
export function createIo({ packageDir, env = process.env }) {
  const paths = resolvePaths(env);
  const t = createTranslator(cliLocale(paths, env));
  const write = (stream) => (text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const daemon = createDaemon({ paths, packageDir, env, locale: t.locale });
  return {
    out: write(process.stdout),
    err: write(process.stderr),
    env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // NO_COLOR 是通行的约定：设了就不上色
    color: Boolean(process.stdout.isTTY) && !env.NO_COLOR,
    // 终端说自己支持 24 位色时，才画得出主题本来的颜色
    truecolor: Boolean(process.stdout.isTTY) && !env.NO_COLOR && /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""),
    version: manifest.version,
    t,
    packageDir,
    paths,
    daemon,
    // 版本检查和更新（src/update）：和 App 的"设置 › 通用"共用一套。下载的进度条、安装脚本说的话都接在终端上
    updates: createUpdates({
      paths,
      env,
      packageDir,
      version: manifest.version,
      instance: daemon,
      progress: Boolean(process.stderr.isTTY),
      stdio: "inherit",
    }),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // 后台没在运行时在这个进程里下载、删除本机模型
    localModels: ({ source, onChange }) =>
      createLocalModels({
        dir: paths.modelsDir,
        source,
        log: { info() {}, warn: log.warn, error: log.error },
        onChange,
      }),
    timeZone: undefined,
    openHistory,
    askSecret,
    ask,
    confirm,
    platform: process.platform,
    cwd: () => process.cwd(),
    // 搬家（src/move）：和 App 设置里的"存储位置"共用一套。安装脚本说的话接在终端上
    mover: () =>
      createMove({
        paths,
        env,
        instance: daemon,
        stdio: "inherit",
        system: process.platform === "win32" ? { clearUserHome, removeHomeAfterExit } : null,
      }),
    // Windows 上卸载、搬家时要动的几处（windows-system.mjs）
    system: { removePathEntry, isOurShortcut, removeLoginItem, removeAfterExit },
    // 钥匙串里那一条的名字是 Electron 按应用名起的
    removeKeychainKey: () => removeKeychainKey(manifest.productName),
    // 自带的是原版 Electron，macOS 按它的应用标识在这里记了一份偏好。卸载时只提一句，不删：别的程序也在用。Windows 上没有
    sharedPreferencesFile:
      process.platform === "darwin" ? join(homedir(), "Library", "Preferences", "com.github.Electron.plist") : null,
    // Windows 没有 tail，用自己写的（tail.mjs）
    tail: ({ file, lines, follow }) =>
      process.platform === "win32"
        ? tailFile(file, { lines, follow, write: (text) => process.stdout.write(text) })
        : new Promise((resolveExit, reject) => {
            const child = spawn("tail", ["-n", String(lines), ...(follow ? ["-f"] : []), file], { stdio: "inherit" });
            child.on("error", reject);
            child.on("exit", (code) => resolveExit(code ?? 0));
          }),
  };
}
