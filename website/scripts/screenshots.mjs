// 给官网截 App 的图：用真页面、真样式和造的数据，在 Electron 里离屏渲染，存成 WebP。
// 主窗口的首页（三套主题 × 浅色深色）、历史记录、悬浮条（三套主题），中英文各一份。
//
//   ../node_modules/.bin/electron scripts/screenshots.mjs -- <输出目录>     （在 website/ 下，用仓库根上装的 Electron）
//
// 造的数据只活在一个临时目录里，跑完删掉；不读也不碰 ~/.orangespeakeasy。截完用 scripts/upload-media.mjs 传到 COS。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const { openHistory } = await import(join(ROOT, "src/storage/history.mjs"));
const { themeCss } = await import(join(ROOT, "src/themes/contract.mjs"));
const { findTheme, THEMES } = await import(join(ROOT, "src/themes/index.mjs"));
const { usageReport } = await import(join(ROOT, "src/usage/report.mjs"));
const { insights } = await import(join(ROOT, "src/usage/insights.mjs"));
const { describePlaza, loadPriceBook } = await import(join(ROOT, "src/app/model-plaza.mjs"));
const { resolveSettings, routeOf } = await import(join(ROOT, "src/storage/settings.mjs"));
const { MODE_ORDER } = await import(join(ROOT, "src/renderer/hub/engine/plaza-view.mjs"));
const { ACTIONS, MAX_CHORDS } = await import(join(ROOT, "src/hotkeys/actions.mjs"));

const out = resolve(process.argv[process.argv.indexOf("--") + 1] ?? "media-out");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const LOCALES = ["en", "zh-CN"];
const SCHEMES = ["light", "dark"];
const HUB = { width: 1080, height: 750 };

// 历史里的话：像平时工作里说的，长短混着
const TEXTS = {
  en: [
    "Let's meet the day after tomorrow, and bring last month's numbers.",
    "Sounds good. I'll send the draft tonight.",
    "Can you move the standup to ten? The design review runs long on Thursdays.",
    "Three things for tomorrow:\n1. Fix the README\n2. Ship 0.6.2\n3. Update the website",
    "Thanks, that fixed it.",
    "Let's keep this plan as it is until she's back.",
  ],
  "zh-CN": [
    "我们后天开会，记得把上个月的数据带上。",
    "好的，我今晚把初稿发你。",
    "明天的 standup 改到十点吧，周四的设计评审总是拖。",
    "明天要做三件事：\n1. 改 README\n2. 发 0.6.2\n3. 更新官网",
    "谢谢，已经好了。",
    "这个方案先不动，等她回来再说。",
  ],
};

/** 过去 140 天的听写记录：有空档，最近两周天天在用 */
function seed(history, locale) {
  const texts = TEXTS[locale];
  const now = Date.now();
  let n = 0;
  for (let day = 140; day >= 0; day--) {
    if (day > 14 && (day % 3 === 0 || day % 7 === 1)) continue;
    const count = day === 0 ? 6 : 4 + ((day * 7) % 19);
    for (let i = 0; i < count; i++) {
      const at = new Date(now - day * 86_400_000 - i * 37 * 60_000).toISOString();
      const id = `demo-${n++}`;
      history.addCall({
        purpose: "dictation",
        audioId: id,
        provider: "gemini",
        model: "gemini-3.6-flash",
        inputTokens: 1500,
        audioTokens: 135,
        cachedTokens: 1350,
        outputTokens: 18,
        thinkingTokens: 0,
        costUsd: 0.00028,
        latencyMs: 1400 + (i % 4) * 210,
        createdAt: at,
      });
      history.add({
        id,
        status: "completed",
        refinedText: texts[(day + i) % texts.length],
        error: null,
        duration: 3 + (i % 5) * 4.5,
        audioFile: null,
        createdAt: at,
      });
    }
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// 页面向主进程要的东西：每截一种语言换一份
let current = { theme: findTheme("ink"), locale: "en", history: null };
const gemini = { id: "gemini", name: "Gemini", keyEnv: "GEMINI_API_KEY", key: "stored" };
const openai = { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY", key: null };
const deepseek = {
  id: "deepseek",
  name: "DeepSeek",
  keyEnv: "DEEPSEEK_API_KEY",
  key: null,
  hasKeyPage: true,
  defaultModel: "deepseek-flash",
  models: ["deepseek-flash", "deepseek-v4-pro"],
};
ipcMain.on("theme:get", (event) => {
  event.returnValue = themeCss(current.theme);
});
ipcMain.on("locale:get", (event) => {
  event.returnValue = current.locale;
});
ipcMain.handle("history:list", () => current.history.list());
ipcMain.handle("usage:report", () => usageReport(current.history, { now: new Date() }));
ipcMain.handle("insights:get", () => insights(current.history.dictations(), { now: new Date() }));
/** 默认的热键，拼法同 app/main.mjs 的 hotkeys.chords：Mac 上听写是右 Option，取消是 esc */
const HOTKEYS = { dictate: [["AltRight"]], cancel: [["Escape"]] };
ipcMain.handle("app:info", () => ({ version: VERSION, hotkeys: HOTKEYS }));
/** 首页标题右边的识别方式、引擎页按它画：出厂设置、原生识别、配了 Gemini 的密钥，拼法同 app/main.mjs 的 describePlazaNow */
const settings = resolveSettings({ file: join(tmpdir(), "orangespeakeasy-shots-none", "settings.json"), env: {} });
const plaza = describePlaza({
  mode: "native",
  chosen: {
    native: settings.model.value,
    transcriber: settings.transcriber.value,
    privateTranscriber: settings.privateTranscriber.value,
    polish: settings.polish.value,
    customUrl: settings.customUrl.value,
    customParams: settings.customParams.value,
  },
  keys: { gemini: "stored" },
  status: {},
  chip: "apple-silicon",
  freeBytes: 1e11,
  prices: await loadPriceBook(),
  routes: Object.fromEntries(MODE_ORDER.map((id) => [id, routeOf(settings, id)])),
  presets: [],
  at: new Date(),
});
ipcMain.handle("setup:get", () => ({
  providerName: "Gemini",
  helper: "running",
  key: { state: "ready", source: "stored" },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
  // 设置页、引导页每个动作一行，拼法同 app/main.mjs 的 describeHotkeyActions
  hotkeyActions: ACTIONS.map((action) => ({
    id: action.id,
    when: action.when,
    clearable: action.clearable,
    max: MAX_CHORDS,
    chords: HOTKEYS[action.id],
    inEffect: HOTKEYS[action.id],
    defaults: HOTKEYS[action.id],
    problems: [],
    env: null,
  })),
  theme: { value: current.theme.id, choices: THEMES.map(({ id }) => id) },
  language: { value: "system", locale: current.locale },
  openAtLogin: { supported: true, enabled: true },
  home: "~/.orangespeakeasy",
  version: VERSION,
  provider: gemini,
  // 设置里"模型"那一页按识别模式画（src/app/main.mjs 的 describeModes）。截图用不到本地转写，给个空的模型列表
  mode: { value: "native", choices: ["native", "local"] },
  native: { model: "gemini/gemini-3.6-flash", providers: [gemini, openai] },
  local: {
    transcriber: "qwen3-asr-0.6b-q8",
    transcribers: [],
    chip: "apple-silicon",
    source: { value: "cn", choices: ["cn", "original"] },
    acceleration: { value: "auto", choices: ["auto", "cpu"] },
    polish: "deepseek/deepseek-flash",
    customUrl: "",
    vendors: [deepseek],
  },
  localModel: null,
  switchable: true,
  plaza,
}));
ipcMain.handle("config:get", () => ({ serverUrl: "ws://127.0.0.1:9/none", hotkeys: HOTKEYS, barControls: true }));
ipcMain.on("bar:set-visible", () => {});
ipcMain.on("bar:capture", () => {});

const preload = join(ROOT, "src/preload/preload.cjs");
const page = (name) => join(ROOT, "src/renderer", name, `${name}.html`);
const manifest = {};

/** PNG 换成 WebP：Chromium 的画布能直接编码，不用另装工具 */
let encoder;
async function toWebp(png) {
  if (!encoder) {
    encoder = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await encoder.loadURL("data:text/html,<canvas></canvas>");
  }
  const dataUrl = await encoder.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${png.toString("base64")}";
    await image.decode();
    const canvas = document.querySelector("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", 0.86);
  })()`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function save(name, image) {
  const { width, height } = image.getSize();
  const file = `${name}.webp`;
  writeFileSync(join(out, file), await toWebp(image.toPNG()));
  // 记下按 CSS 像素算的大小（截的是两倍图），页面拿它占位，图出来前不跳
  manifest[name] = { file, width: width / 2, height: height / 2 };
  console.log(file, `${width}×${height}`);
}

/** 透明图里不全透明的那一块，四边再留一点 */
function cropToContent(image, margin) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let [minX, minY, maxX, maxY] = [width, height, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  // 宽高取偶数，除以二还是整数
  const x = Math.max(0, minX - margin) & ~1;
  const y = Math.max(0, minY - margin) & ~1;
  const right = Math.min(width, maxX + margin + 1);
  const bottom = Math.min(height, maxY + margin + 1);
  return image.crop({ x, y, width: (right - x) & ~1, height: (bottom - y) & ~1 });
}

async function shootHub(locale) {
  // 真窗口没有标题栏（titleBarStyle: hidden），内容就是整个 1080×750
  const win = new BrowserWindow({
    ...HUB,
    useContentSize: true,
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true },
  });
  const problems = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") problems.push(event.message);
  });
  for (const theme of THEMES) {
    current.theme = theme;
    for (const scheme of SCHEMES) {
      nativeTheme.themeSource = scheme;
      await win.loadFile(page("hub"));
      await wait(900);
      await save(`home-${scheme}-${theme.id}.${locale}`, await win.webContents.capturePage());
    }
  }
  current.theme = findTheme("cinnabar");
  nativeTheme.themeSource = "light";
  await win.loadFile(page("hub"));
  await wait(700);
  await win.webContents.executeJavaScript(`document.querySelector('[data-route="history"].nav-item').click()`);
  await wait(700);
  await save(`history-light-cinnabar.${locale}`, await win.webContents.capturePage());
  if (problems.length) console.log("主窗口的报错：", problems);
  win.destroy();
}

// 说话时的声波高度：中间高、两头低，一组固定值，每次截出来一样
const WAVE = [0.18, 0.26, 0.34, 0.46, 0.58, 0.72, 0.86, 1, 0.84, 0.7, 0.55, 0.44, 0.32, 0.24, 0.16];

async function shootBar(locale) {
  const win = new BrowserWindow({
    width: 560,
    height: 320,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, preload, sandbox: true, contextIsolation: true },
  });
  for (const theme of THEMES) {
    current.theme = theme;
    await win.loadFile(page("bar"));
    // 离屏窗口不认 force-device-scale-factor，放大两倍画，截出来和别的图一样是两倍图
    win.webContents.setZoomFactor(2);
    // 留够地方让阴影淡完
    await win.webContents.insertCSS("body { padding-bottom: 40px !important; }");
    await wait(500);
    await win.webContents.executeJavaScript(`(async () => {
      // 提示照真的那一套算：bar-view 的 hintFor 加上这种语言的翻译
      const { hintFor } = await import("./bar-view.mjs");
      const { createTranslator } = await import("../../i18n/index.mjs");
      const t = createTranslator(${JSON.stringify(locale)});
      const b = document.body;
      b.dataset.view = "recording";
      b.dataset.shown = "true";
      b.dataset.controls = "true";
      // 键帽一组一组的，画法同 bar-ui.mjs 的 drawHint
      const group = (keys) => {
        const span = Object.assign(document.createElement("span"), { className: "keys" });
        span.append(...keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
        return span;
      };
      // 键帽的字照 bar.mjs 的 keycapsOf 算：默认的听写（右 Option）和取消（esc）
      const { chordKeycaps } = await import("../../hotkeys/chord.mjs");
      const keycapsOf = (codes) => chordKeycaps(codes).map((cap) => t.text(cap));
      const keys = keycapsOf(${JSON.stringify(HOTKEYS.dictate[0])});
      const escKeys = keycapsOf(${JSON.stringify(HOTKEYS.cancel[0])});
      const parts = hintFor("recording", { keys, escKeys, cancellable: true }, t);
      document.getElementById("hint").replaceChildren(...parts.map((p) => (typeof p === "string" ? p : group(p.keys))));
      [...document.querySelectorAll("#wave i")].forEach((i, n) => i.style.setProperty("--h", ${JSON.stringify(WAVE)}[n]));
    })()`);
    await wait(1200);
    await save(`bar-${theme.id}.${locale}`, cropToContent(await win.webContents.capturePage(), 8));
  }
  win.destroy();
}

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.dock?.hide();
app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  for (const locale of LOCALES) {
    const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-shots-"));
    current = { theme: findTheme("ink"), locale, history: openHistory(join(dir, "history.db")) };
    try {
      seed(current.history, locale);
      await shootHub(locale);
      await shootBar(locale);
    } finally {
      current.history.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`截好了 ${Object.keys(manifest).length} 张：${out}`);
  app.quit();
});
