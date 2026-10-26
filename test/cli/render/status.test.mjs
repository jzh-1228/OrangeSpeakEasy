import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStatus } from "../../../src/cli/render/status.mjs";
import { hotkeyZh, namesZh, noStats, plain, ready, settings } from "./fixtures.mjs";

test("没有在运行时只说一句怎么启动", () => {
  const text = renderStatus({ status: null, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /OrangeSpeakEasy 0\.1\.0 · 没有运行/);
  assert.match(text, /orangespeakeasy/);
  assert.doesNotMatch(text, /权限/);
});

test("一切就绪时说怎么用，并列出 key、权限、热键、模型", () => {
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /OrangeSpeakEasy 0\.1\.0 · 运行中/);
  assert.match(text, new RegExp(`按一下${hotkeyZh}开始说话`));
  assert.match(text, /key\s+已保存，验证通过/);
  assert.match(text, /麦克风 ✓\s+输入监控 ✓\s+辅助功能 ✓/);
  assert.match(text, new RegExp(`热键\\s+${hotkeyZh}`));
  assert.match(text, /模型\s+Gemini 的 gemini-3\.6-flash（MINIMAL）/);
});

test("后台是 0.13 以前的版本（只报旧 id）：照样叫得出名字；更新的版本报了认不出的，用它自己的说法", () => {
  const { "hotkey.dictate": _dictate, "hotkey.cancel": _cancel, ...old } = ready;
  const before = renderStatus(
    { status: { ...old, hotkey: "right_command" }, version: "0.1.0", settings, stats: noStats },
    plain,
  );
  assert.match(before, new RegExp(`热键\\s+${namesZh("MetaRight")}`));
  const newer = renderStatus(
    {
      status: { ...old, "hotkey.dictate": "MouseX", hotkey: null, hotkeyLabel: "鼠标侧键" },
      version: "0.1.0",
      settings,
      stats: noStats,
    },
    plain,
  );
  assert.match(newer, /热键\s+鼠标侧键/);
});

test("绑了几个组合：任一个都行，并列着说", () => {
  const status = { ...ready, "hotkey.dictate": '["Fn","MetaRight"]' };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, new RegExp(`按一下${namesZh("Fn", "MetaRight").replace(/[()（）]/g, ".")}开始说话`));
});

test("设置里写的装不上、退回了默认键：说的是实际装上的那个（hotkeysInEffect），不是设置里写的", () => {
  const status = { ...ready, "hotkey.dictate": '["Fn"]', hotkeysInEffect: { dictate: '["AltRight"]' } };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, new RegExp(`按一下${hotkeyZh}开始说话`));
  assert.match(text, new RegExp(`热键\\s+${hotkeyZh}`));
  assert.doesNotMatch(text, /地球仪/);
});

test("能用、但有个热键组合装不上：照样说怎么用，再说还差什么", () => {
  const status = {
    ...ready,
    summary: { ...ready.summary, missing: ["「语音输入」的 fn 用不了：这个系统上没有地球仪（fn）键"] },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /运行中/);
  assert.match(text, /开始说话/);
  assert.match(text, /「语音输入」的 fn 用不了/);
});

test("缺东西时标题说还差几样，逐项标出，并说权限记在终端名下", () => {
  const status = {
    ...ready,
    key: { state: "missing", source: null, problem: null },
    permissions: { microphone: "denied", listen: false, trusted: false },
    summary: {
      ready: false,
      missing: ["Gemini API key", "麦克风权限", "输入监控权限"],
      blocker: "还没有填 Gemini API key",
      degraded: "没有辅助功能权限：文字会放进剪贴板，要自己按 ⌘V",
    },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /运行中，还差 3 样/);
  assert.match(text, /key\s+还没有填：运行 orangespeakeasy key/);
  assert.match(text, /麦克风 ✗\s+输入监控 ✗\s+辅助功能 ✗/);
  assert.match(text, /没有辅助功能权限：文字会放进剪贴板/);
  assert.match(text, /orangespeakeasy settings/);
  assert.match(text, /终端/);
});

test("Windows 上只有麦克风这一项权限：不列输入监控、辅助功能，也不说权限记在终端名下", () => {
  const windows = { ...plain, platform: "win32" };
  assert.match(
    renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, windows),
    /权限\s+麦克风 ✓\n/,
  );
  const denied = {
    ...ready,
    permissions: { microphone: "denied", listen: true, trusted: true },
    summary: { ready: false, missing: ["麦克风权限"], blocker: "缺麦克风权限", degraded: null },
  };
  const text = renderStatus({ status: denied, version: "0.1.0", settings, stats: noStats }, windows);
  assert.match(text, /权限\s+麦克风 ✗\n/);
  assert.match(text, /orangespeakeasy settings/);
  assert.doesNotMatch(text, /输入监控|辅助功能|终端/);
});

test("key 的各种状态各有一句话", () => {
  const withKey = (key) =>
    renderStatus({ status: { ...ready, key }, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(withKey({ state: "ready", source: "env", problem: null, verified: true }), /环境变量 GEMINI_API_KEY/);
  assert.match(withKey({ state: "checking", source: "stored", problem: null }), /正在验证/);
  assert.match(withKey({ state: "unreadable", source: "stored", problem: "读不出来了" }), /读不出来了/);
  // 启动时没连上网：先用着，如实说还没验证
  assert.match(withKey({ state: "ready", source: "stored", problem: null, verified: false }), /已保存.*还没验证/);
});

test("key 不能用时，按原因说该怎么办：换 key、改环境变量、还是去看模型设置", () => {
  const rejected = (key) =>
    renderStatus(
      { status: { ...ready, key: { state: "rejected", ...key } }, version: "0.1.0", settings, stats: noStats },
      plain,
    );
  const revoked = rejected({ source: "stored", cause: "key", problem: "这把 key 无效" });
  assert.match(revoked, /不能用：这把 key 无效。运行 orangespeakeasy key 换一把/);

  // 环境变量里的那把不对：存一把新的没用，下次启动用的还是环境变量
  const badEnv = rejected({ source: "env", cause: "key", problem: "这把 key 无效" });
  assert.match(badEnv, /环境变量 GEMINI_API_KEY 里的 key 不能用：这把 key 无效/);
  assert.doesNotMatch(badEnv, /换一把/);

  // Gemini 拒绝了请求：多半是模型名或档位，不该让人去换 key
  const wrongModel = rejected({
    source: "stored",
    cause: "other",
    problem: "Gemini 拒绝了请求：models/x is not found",
  });
  assert.match(wrongModel, /验证没通过：Gemini 拒绝了请求：models\/x is not found/);
  assert.match(wrongModel, /orangespeakeasy config/);
  assert.doesNotMatch(wrongModel, /换一把/);
});

test("模型和热键写的是后台应用正在用的；设置改过还没生效时提醒重启", () => {
  // 后台应用是带着别的设置启动的（比如启动它的那条命令上有环境变量），和现在的设置不一样
  const status = { ...ready, model: "gemini/gemini-3.8-flash", thinking: "LOW" };
  const stale = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(stale, /模型\s+Gemini 的 gemini-3\.8-flash（LOW）/);
  assert.match(stale, /model \/ thinking.*orangespeakeasy restart/);

  const same = renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain);
  assert.doesNotMatch(same, /orangespeakeasy restart/);

  const external = {
    ...ready,
    model: null,
    thinking: null,
    key: { state: "ready", source: "external", problem: null },
  };
  assert.match(
    renderStatus({ status: external, version: "0.1.0", settings, stats: noStats }, plain),
    /模型\s+由单独启动的服务端决定/,
  );
});

test("按键监听的小程序停了：明说热键不会生效，以及怎么办", () => {
  const status = {
    ...ready,
    helper: "stopped",
    permissions: { microphone: "granted", listen: null, trusted: null },
    summary: { ready: false, missing: ["按键监听"], blocker: null, degraded: null },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /还差 1 样/);
  assert.match(text, /热键不会生效/);
  assert.match(text, /orangespeakeasy restart/);
});

test("装成应用运行时，权限记在 OrangeSpeakEasy 自己名下，不说成终端", () => {
  const status = {
    ...ready,
    packaged: true,
    permissions: { microphone: "granted", listen: false, trusted: true },
    summary: { ready: false, missing: ["输入监控权限"], blocker: null, degraded: null },
  };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /在系统设置的列表里找“OrangeSpeakEasy”/);
  assert.doesNotMatch(text, /终端/);
});

test("还在启动时如实说，不提前报就绪", () => {
  const status = { ...ready, starting: true, summary: { ...ready.summary, ready: false } };
  const text = renderStatus({ status, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /正在启动/);
  assert.doesNotMatch(text, /开始说话/);
});

test("有历史时给出今天和累计的数：次数、字数、时长、每分钟多少字", () => {
  const stats = {
    today: { dictations: 3, characters: 420, seconds: 95, failed: 0 },
    total: { dictations: 132, characters: 12480, seconds: 2880, failed: 2 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.match(text, /今天\s+3 次 · 420 字 · 1 分 35 秒/);
  assert.match(text, /累计\s+132 次 · 12,480 字 · 48 分钟 · 每分钟 260 字/);
});

test("有账时带上花了多少钱；有几笔不知道价时说至少多少，不拿一半当全部", () => {
  const stats = {
    today: { dictations: 3, characters: 420, seconds: 95, failed: 0, costUsd: 0.0036, unpricedCalls: 0 },
    total: { dictations: 132, characters: 12480, seconds: 2880, failed: 2, costUsd: 0.16, unpricedCalls: 4 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.match(text, /今天\s+3 次 · 420 字 · 1 分 35 秒 · \$0\.0036\n/);
  assert.match(text, /累计\s+.* · 至少 \$0\.16\n/);
});

test("一次都没说过时不列统计", () => {
  const stats = {
    today: { dictations: 0, characters: 0, seconds: 0, failed: 0 },
    total: { dictations: 0, characters: 0, seconds: 0, failed: 0 },
  };
  const text = renderStatus({ status: ready, version: "0.1.0", settings, stats }, plain);
  assert.doesNotMatch(text, /累计/);
});

test("面板：后台应用报了主题就写上，叫得出名字的写名字；旧版本不报就不写", () => {
  const withTheme = (theme) =>
    renderStatus({ status: { ...ready, theme }, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(withTheme("indigo"), /主题\s+靛青（indigo）/);
  assert.match(withTheme("neon"), /主题\s+neon\n/);
  assert.doesNotMatch(renderStatus({ status: ready, version: "0.1.0", settings, stats: noStats }, plain), /主题/);
  // 设置里写的和正在用的不一样（手改了文件，或者启动它的环境里带着环境变量）
  const pending = renderStatus(
    {
      status: { ...ready, theme: "ink" },
      version: "0.1.0",
      settings: { ...settings, theme: { value: "indigo", source: "file" } },
      stats: noStats,
    },
    plain,
  );
  assert.match(pending, /设置里的 theme 和正在用的不一样/);
});

test("开了颜色时对勾和叉带颜色，关了就是纯文字", () => {
  const view = { status: ready, version: "0.1.0", settings, stats: noStats };
  assert.ok(renderStatus(view, { ...plain, color: true }).includes("\x1b[32m✓\x1b[0m"));
  assert.ok(!renderStatus(view, plain).includes("\x1b["));
});

test("用的是 OpenAI：模型写清是哪一家，没有思考档位就不写；key 来自哪个环境变量也照实写", () => {
  const status = {
    ...ready,
    provider: "openai",
    model: "openai/gpt-audio-mini",
    thinking: null,
    key: { state: "ready", source: "env", problem: null, verified: true },
  };
  const openaiSettings = { ...settings, model: { value: "openai/gpt-audio-mini", source: "file" } };
  const text = renderStatus({ status, version: "0.1.0", settings: openaiSettings, stats: noStats }, plain);
  assert.match(text, /模型\s+OpenAI 的 gpt-audio-mini\n/);
  assert.match(text, /环境变量 OPENAI_API_KEY/);
  // 设置里的思考档位它用不上，不能因此说"还没生效"
  assert.doesNotMatch(text, /orangespeakeasy restart/);

  const offline = renderStatus(
    {
      status: { ...status, key: { ...status.key, verified: false } },
      version: "0.1.0",
      settings: openaiSettings,
      stats: noStats,
    },
    plain,
  );
  assert.match(offline, /启动时没连上 OpenAI/);
});

test("0.3 的后台应用报的模型名不带厂商：照样认成 Gemini 的，不误报设置没生效", () => {
  const legacy = { ...ready, provider: undefined, model: "gemini-3.6-flash" };
  const text = renderStatus({ status: legacy, version: "0.1.0", settings, stats: noStats }, plain);
  assert.match(text, /模型\s+Gemini 的 gemini-3\.6-flash（MINIMAL）/);
  assert.doesNotMatch(text, /orangespeakeasy restart/);
});

test("local 模式：写模式、两跳各用什么（key 说的是润色那家），本地模型下到哪了", () => {
  const status = {
    ...ready,
    provider: "deepseek",
    mode: "local",
    model: null,
    thinking: null,
    transcriber: "qwen3-asr-0.6b-q8",
    polish: "deepseek/deepseek-flash",
    key: { state: "ready", source: "env", problem: null, verified: true },
    localModel: { state: "downloading", model: "qwen3-asr-0.6b-q8", received: 425_000_000, total: 850_000_000 },
  };
  const localSettings = { ...settings, mode: { value: "local", source: "file" } };
  const text = renderStatus({ status, version: "0.1.0", settings: localSettings, stats: noStats }, plain);
  assert.match(text, /模式\s+混合：先转文字，再交给模型整理/);
  assert.match(text, /模型\s+qwen3-asr-0\.6b-q8 → DeepSeek 的 deepseek-flash/);
  assert.match(text, /本地模型\s+下载中 50%（425 \/ 850 MB）/);
  assert.match(text, /环境变量 DEEPSEEK_API_KEY/);
  assert.doesNotMatch(text, /orangespeakeasy restart/);

  const readyText = renderStatus(
    {
      status: { ...status, localModel: { state: "ready", model: "qwen3-asr-0.6b-q8", backend: "MTL0" } },
      version: "0.1.0",
      settings: localSettings,
      stats: noStats,
    },
    plain,
  );
  assert.match(readyText, /本地模型\s+就绪 · Metal/);

  // 0.7.1 起不自己下：还没下载的说怎么下；用户正在下它时说下到哪了
  const missing = (localModel) =>
    renderStatus(
      { status: { ...status, localModel }, version: "0.1.0", settings: localSettings, stats: noStats },
      plain,
    );
  assert.match(
    missing({ state: "missing", model: "qwen3-asr-0.6b-q8" }),
    /本地模型\s+还没下载：orangespeakeasy transcriber download qwen3-asr-0\.6b-q8/,
  );
  assert.match(
    missing({ state: "missing", model: "qwen3-asr-0.6b-q8", received: 425_000_000, total: 850_000_000 }),
    /本地模型\s+下载中 50%（425 \/ 850 MB）/,
  );
});
