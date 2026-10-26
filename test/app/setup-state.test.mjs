import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSetup, summaryAsText } from "../../src/app/setup-state.mjs";
import { createTranslator, msg } from "../../src/i18n/index.mjs";

// 按 macOS 的说法查；Windows 那几句的说法在 i18n 的测试里查
const zh = createTranslator("zh-CN", "darwin");
const en = createTranslator("en", "darwin");
/** 结论里的话按中文翻出来再比：说法和以前一样，只是改由显示的那一端翻 */
const summarize = (setup, t = zh) => summaryAsText(summarizeSetup(setup), t);

const allGood = {
  key: { state: "ready", source: "stored", problem: null },
  permissions: { microphone: "granted", listen: true, trusted: true },
};
const withKey = (key) => ({ ...allGood, key: { source: null, problem: null, ...key } });
const withPermissions = (permissions) => ({ ...allGood, permissions: { ...allGood.permissions, ...permissions } });

test("都齐了：可以用，没有要补的", () => {
  assert.deepEqual(summarize(allGood), { ready: true, missing: [], blocker: null, degraded: null });
});

test("没有 key、key 解不开：不能用，提示去设置里填", () => {
  for (const state of ["missing", "unreadable"]) {
    const summary = summarize(withKey({ state }));
    assert.equal(summary.ready, false);
    assert.deepEqual(summary.missing, ["Gemini API key"]);
    assert.match(summary.blocker, /设置/);
  }
});

test("key 验证没通过：把原因带给用户", () => {
  const summary = summarize(withKey({ state: "rejected", problem: "这把 key 无效" }));
  assert.equal(summary.ready, false);
  assert.match(summary.blocker, /这把 key 无效/);
});

test("Gemini 拒绝了请求（模型名或档位写错）：不说成是 key 的问题", () => {
  const summary = summarize(
    withKey({ state: "rejected", cause: "other", problem: "Gemini 拒绝了请求：models/x is not found" }),
  );
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["Gemini 验证"]);
  assert.match(summary.blocker, /^Gemini 验证没通过：.*models\/x is not found/);
});

test("启动时没连上网、先用着的 key：算可以用", () => {
  assert.equal(summarize(withKey({ state: "ready", source: "stored", verified: false })).ready, true);
});

test("key 还在验证：不能用，但不算缺东西", () => {
  const summary = summarize(withKey({ state: "checking" }));
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, []);
  assert.match(summary.blocker, /稍等/);
});

test("麦克风或输入监控没授权：列进要补的", () => {
  assert.deepEqual(summarize(withPermissions({ microphone: "denied" })).missing, ["麦克风权限"]);
  assert.deepEqual(summarize(withPermissions({ listen: false })).missing, ["输入监控权限"]);
  assert.deepEqual(
    summarize(withKey({ state: "missing" })).missing.concat(
      summarize(withPermissions({ microphone: "denied", listen: false })).missing,
    ),
    ["Gemini API key", "麦克风权限", "输入监控权限"],
  );
});

test("按键监听还没启动好：暂时不能用，但不算缺权限", () => {
  const summary = summarize(withPermissions({ listen: null, trusted: null }));
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, []);
});

test("只缺辅助功能：照样能用，只是要自己按粘贴", () => {
  const summary = summarize(withPermissions({ trusted: false }));
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.missing, []);
  assert.match(summary.degraded, /剪贴板/);
});

test("按键监听的小程序停了：不再说成“正在准备”，明说缺它", () => {
  const summary = summarize({ ...withPermissions({ listen: null, trusted: null }), helper: "stopped" });
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["按键监听"]);
});

test("用的是别家模型时，缺的 key、没通过的验证都点名是哪一家", () => {
  const missing = summarize({ ...withKey({ state: "missing" }), providerName: "OpenAI" });
  assert.deepEqual(missing.missing, ["OpenAI API key"]);
  assert.match(missing.blocker, /^缺 OpenAI API key/);
  const rejected = summarize({
    ...withKey({ state: "rejected", cause: "other", problem: "OpenAI 没有这个模型" }),
    providerName: "OpenAI",
  });
  assert.deepEqual(rejected.missing, ["OpenAI 验证"]);
  assert.match(rejected.blocker, /^OpenAI 验证没通过/);
});

test("本地模型还没下载：算缺东西，说去哪下；用户正在下时说下到哪了；装载中暂时不能用、不算缺", () => {
  const missing = summarize({ ...allGood, localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" } });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ["本地模型"]);
  assert.match(
    missing.blocker,
    /Qwen3-ASR 0\.6B \(Q8_0\) 还没下载.*orangespeakeasy transcriber download qwen3-asr-0\.6b-q8/,
  );

  const downloading = summarize({
    ...allGood,
    localModel: { state: "missing", model: "qwen3-asr-0.6b-q8", received: 425, total: 850 },
  });
  assert.equal(downloading.ready, false);
  assert.deepEqual(downloading.missing, ["本地模型（下载中 50%）"]);
  assert.match(downloading.blocker, /下载.*50%/);
  const loading = summarize({ ...allGood, localModel: { state: "loading", model: "m" } });
  assert.match(loading.blocker, /装载/);
  assert.deepEqual(loading.missing, []);
});

test("本地模型没装上：列进要补的，把原因带给用户", () => {
  const summary = summarize({
    ...allGood,
    localModel: { state: "failed", model: "m", problem: msg("local.modelFailed", { reason: "磁盘满了" }) },
  });
  assert.equal(summary.ready, false);
  assert.deepEqual(summary.missing, ["本地模型"]);
  assert.match(summary.blocker, /磁盘满了/);
});

test("本地模型就绪或没走本地转写：不影响结论；key 的问题排在它前面说", () => {
  for (const localModel of [{ state: "ready", model: "m" }, { state: "off" }, null]) {
    assert.equal(summarize({ ...allGood, localModel }).ready, true);
  }
  const both = summarize({
    ...withKey({ state: "missing" }),
    localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" },
  });
  assert.match(both.blocker, /key/);
});

test("热键装不上的、退回默认的：列进要补的，照样能用（还有别的键能按）", () => {
  const hotkeys = [
    { action: "dictate", chord: ["Fn"], reason: msg("binding.notAvailable", { key: msg("keys.Fn.name") }) },
    { action: "dictate", fallback: [["AltRight"]] },
  ];
  const summary = summarize({ ...allGood, hotkeys });
  assert.equal(summary.ready, true);
  assert.equal(summary.blocker, null);
  assert.deepEqual(summary.missing, [
    "「语音输入」的 fn 用不了：这个系统上没有地球仪（fn）键",
    "「语音输入」先用默认的 右⌥",
  ]);
  assert.deepEqual(summarize({ ...allGood, hotkeys: [] }).missing, []);
});

test("听写的组合一个都没装上（小帮手全退回了）：不算能用，原因列在要补的里", () => {
  const hotkeys = [
    { action: "dictate", chord: ["AltRight", "Space"], reason: msg("binding.notAvailable", { key: "x" }) },
  ];
  const summary = summarize({ ...allGood, hotkeys, dictateUsable: false });
  assert.equal(summary.ready, false);
  assert.equal(summary.missing.length, 1);
  assert.equal(summarize({ ...allGood, hotkeys, dictateUsable: true }).ready, true);
});

test("同一个结论换成英文说：缺的东西、按热键时的那句、打了折扣的说明", () => {
  const setup = {
    ...withKey({ state: "missing" }),
    permissions: { microphone: "denied", listen: false, trusted: false },
    providerName: "OpenAI",
  };
  assert.deepEqual(summarize(setup, en), {
    ready: false,
    missing: ["OpenAI API key", "microphone access", "Input Monitoring access"],
    blocker: "No OpenAI API key: menu bar icon › Settings",
    degraded: "No Accessibility access: text goes to the clipboard, press ⌘V",
  });
  // 原因是模型回的原话时照原样带上
  const rejected = summarize(withKey({ state: "rejected", cause: "other", problem: "models/x is not found" }), en);
  assert.equal(rejected.blocker, "Gemini check failed: models/x is not found");
});

test("交给命令行的结论：每句都按它的语言翻成字（0.5 的命令行和 status --json 的读者只认字）", () => {
  const summary = summarizeSetup(withPermissions({ microphone: "denied", listen: false, trusted: false }));
  assert.deepEqual(summaryAsText(summary, en), {
    ready: false,
    missing: ["microphone access", "Input Monitoring access"],
    blocker: en.text(summary.blocker),
    degraded: en.text(summary.degraded),
  });
  assert.equal(typeof summaryAsText(summary, zh).blocker, "string");
  assert.deepEqual(summaryAsText(summarizeSetup(allGood), zh), {
    ready: true,
    missing: [],
    blocker: null,
    degraded: null,
  });
});

test("按需装载的本机模型不拦着按热键：等着开口、装载中、上次没装上（下次开口再装）；常驻的装载中、没装上照旧拦着", () => {
  assert.equal(summarize({ ...allGood, localModel: { state: "idle", model: "qwen3-asr-0.6b-q8" } }).blocker, null);
  for (const state of ["loading", "failed"]) {
    const onDemand = summarize({
      ...allGood,
      localModel: {
        state,
        model: "qwen3-asr-0.6b-q8",
        onDemand: true,
        problem: msg("local.modelFailed", { reason: "坏了" }),
      },
    });
    assert.equal(onDemand.blocker, null, state);
  }
  // 没装上的还是算缺，主窗口照样提醒
  assert.equal(
    summarize({ ...allGood, localModel: { state: "failed", onDemand: true, problem: msg("local.modelLoading") } })
      .missing.length,
    1,
  );
  assert.notEqual(summarize({ ...allGood, localModel: { state: "loading" } }).blocker, null);
  assert.notEqual(
    summarize({ ...allGood, localModel: { state: "failed", problem: msg("local.modelLoading") } }).blocker,
    null,
  );
});
