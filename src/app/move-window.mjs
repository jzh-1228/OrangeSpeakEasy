import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { createTranslator, msg, problemOf, resolveLocale } from "../i18n/index.mjs";
import { createInstance } from "../instance.mjs";
import { alsoLogTo, log } from "../log.mjs";
import { sizeText } from "../models/describe.mjs";
import { createMove } from "../move/index.mjs";
import { homeIn } from "../move/target.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { resolveSettings } from "../storage/settings.mjs";
import { toHex } from "../themes/color.mjs";
import { themeCss } from "../themes/contract.mjs";
import { findTheme } from "../themes/index.mjs";
import { bundleOfPackage, createBundles } from "../update/bundle.mjs";
import { clearUserHome, removeHomeAfterExit } from "../windows-system.mjs";

// App 设置里点了"存储位置 › 更改"之后，App 用自己的程序另起一个进程（环境变量 ORANGESPEAKEASY_MOVE_TO 是搬去的文件夹），
// 走到这里：开一个小窗口显示进度，照命令行的 orangespeakeasy move 一样搬（src/move）——请 App 退出、拷、换家、从新位置把它打开、
// 删旧目录。搬完、没搬成都在窗口里说清楚，点"完成"才关。
// 它不是 App 本身：不拿单实例锁，Chromium 的缓存放在临时目录（家目录正被拷、马上要删），不碰家目录里的缓存。

/** 只给这一次搬家用的环境变量：交给安装脚本、重新打开的 App 之前去掉，不然 App 一打开又当成要搬家 */
const MOVE_ONLY = ["ORANGESPEAKEASY_MOVE_TO", "ORANGESPEAKEASY_CLI", "ELECTRON_RUN_AS_NODE"];

/** 搬去的文件夹：App 起这个进程时给的。不是搬家时是 null */
export const MOVE_TO = process.env.ORANGESPEAKEASY_MOVE_TO || null;

/** 在 ready 之前调：缓存放进临时目录。之后的事在 ready 后做 */
export function startMoveWindow({ folder, sourceDir, webPreferences, windowIcon }) {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "orangespeakeasy-move-")));
  app.dock?.hide();
  app
    .whenReady()
    .then(() => run({ folder, sourceDir, webPreferences, windowIcon }))
    .catch((error) => {
      log.error("move_window_failed", { error: String(error?.stack ?? error) });
      app.exit(1);
    });
}

async function run({ folder, sourceDir, webPreferences, windowIcon }) {
  const paths = resolvePaths(process.env);
  // 记进旧目录的日志：搬成了它跟着旧目录删掉（不要紧），没搬成留着排查
  alsoLogTo(paths.logFile);
  let settings = null;
  try {
    settings = resolveSettings({ file: paths.settingsFile, env: process.env });
  } catch (error) {
    // 设置读不出不挡搬家：窗口按默认的主题、系统的语言
    log.warn("move_settings_unreadable", { error: problemOf(error) });
  }
  const locale = resolveLocale(settings?.language.value ?? "system", app.getPreferredSystemLanguages());
  const t = createTranslator(locale);
  const theme = findTheme(settings?.theme.value);
  ipcMain.on("locale:get", (event) => {
    event.returnValue = locale;
  });
  ipcMain.on("theme:get", (event) => {
    event.returnValue = themeCss(theme);
  });

  const env = { ...process.env };
  for (const name of MOVE_ONLY) delete env[name];

  /** 窗口上显示的：phase 是 preparing / copying / switching / done / failed */
  const state = {
    phase: "preparing",
    from: paths.home,
    to: homeIn(folder),
    done: 0,
    total: 0,
    notes: [],
    problem: null,
  };
  const finished = () => state.phase === "done" || state.phase === "failed";
  // 搬的时候 Cmd+Q 之类也不让退
  app.on("before-quit", (event) => {
    if (!finished()) event.preventDefault();
  });
  const window = new BrowserWindow({
    // 内容区的大小：说明最多三四行，按钮在底下，不出滚动条
    width: 480,
    height: 360,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 搬的时候不让关：搬到一半停下来才是最糟的
    closable: false,
    show: false,
    title: "OrangeSpeakEasy",
    backgroundColor: toHex(theme.window[nativeTheme.shouldUseDarkColors ? "dark" : "light"].bg),
    ...(process.platform === "win32" ? { autoHideMenuBar: true, icon: windowIcon } : {}),
    webPreferences,
  });
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send("move:state", { ...state, notes: state.notes.map(t.text) });
  };
  ipcMain.handle("move:state", () => ({ ...state, notes: state.notes.map(t.text) }));
  ipcMain.handle("move:close", () => {
    if (finished()) app.quit();
  });
  window.loadFile(join(sourceDir, "renderer", "move", "move.html"));
  window.once("ready-to-show", () => {
    window.show();
    app.focus({ steal: true });
  });

  /** 进度一秒最多发十次：小文件多的时候每个文件都报一次 */
  let lastSent = 0;
  const onProgress = ({ bytes, total }) => {
    state.done = bytes;
    state.total = total.bytes;
    state.phase = "copying";
    const now = Date.now();
    if (now - lastSent >= 100 || bytes === total.bytes) {
      lastSent = now;
      send();
    }
  };
  const report = (message) => {
    log.info("move_step", { step: message.key, ...message.params });
    if (message.key === "move.copying") state.phase = "copying";
    else if (message.key === "move.switching") state.phase = "switching";
    else state.notes.push(message);
    send();
  };

  const self = process.platform === "darwin" ? bundleOfPackage(app.getAppPath()) : null;
  const mover = createMove({
    paths,
    env,
    instance: createInstance({ paths }),
    selfBundle: self,
    // 安装脚本、启动命令说的话转进日志
    stdio: "forward",
    // 这个进程和要重新打开的 App 是同一个应用包：不加 -n 的话 open 只会把这个窗口叫到前面
    openApp: (bundle, home) =>
      createBundles({ env: { ...env, ORANGESPEAKEASY_HOME: home }, release: null }).open(bundle, { fresh: true }),
    system: process.platform === "win32" ? { clearUserHome, removeHomeAfterExit } : null,
  });
  log.info("move_started", { from: paths.home, folder });
  try {
    const result = await mover.run({ folder, by: "app", report, onProgress });
    state.to = result.to;
    state.done = result.bytes;
    state.total = result.bytes;
    state.phase = "done";
    if (result.left.length > 0) state.notes.push(msg("moveWindow.left", { items: result.left.join(", ") }));
    else state.notes.push(msg(result.later ? "moveWindow.later" : "moveWindow.removed"));
    log.info("move_finished", { ...result, size: sizeText(result.bytes) });
  } catch (error) {
    state.phase = "failed";
    state.problem = t.text(problemOf(error));
    state.notes.unshift(msg("moveWindow.unchanged"));
    log.error("move_failed", { error: String(error?.stack ?? error) });
  }
  window.setClosable(true);
  window.on("close", () => app.quit());
  send();
  if (!window.isDestroyed()) {
    window.show();
    app.focus({ steal: true });
  }
}
