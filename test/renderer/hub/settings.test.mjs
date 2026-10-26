import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { describeUpdate, fixTarget, updateFlagged } from "../../../src/renderer/hub/settings.mjs";

const setup = (key, permissions = {}, helper = "running") => ({
  key: { state: key },
  helper,
  permissions: { microphone: "granted", listen: true, trusted: true, ...permissions },
});

test("还差 key：去侧栏模型一页的密钥表", () => {
  const keys = { route: "models", tab: "keys" };
  assert.deepEqual(fixTarget(setup("missing")), keys);
  assert.deepEqual(fixTarget(setup("rejected", { listen: false })), keys);
  assert.deepEqual(fixTarget(setup("unreadable")), keys);
});

test("key 没问题、正在验证时，差的是权限就去权限那一页", () => {
  assert.deepEqual(fixTarget(setup("ready", { microphone: "denied" })), { pane: "permissions" });
  assert.deepEqual(fixTarget(setup("checking", { listen: false })), { pane: "permissions" });
  // 只缺辅助功能也算：能用但打了折扣，补上它的地方也在权限页
  assert.deepEqual(fixTarget(setup("ready", { trusted: false })), { pane: "permissions" });
});

test("什么都不缺、权限还没报上来：去设置的第一页", () => {
  assert.deepEqual(fixTarget(setup("ready")), { pane: "general" });
  assert.deepEqual(fixTarget(setup("ready", { listen: null, trusted: null })), { pane: "general" });
});

test("按键监听的小程序停了：去权限那一页，重新检查在那里", () => {
  assert.deepEqual(fixTarget(setup("ready", { listen: null, trusted: null }, "stopped")), { pane: "permissions" });
});

test("有动作的组合装不上：去快捷键那一页；权限也缺时先补权限", () => {
  const troubled = {
    ...setup("ready"),
    hotkeyActions: [
      { id: "dictate", problems: [{ fallback: true }] },
      { id: "cancel", problems: [] },
    ],
  };
  assert.deepEqual(fixTarget(troubled), { pane: "hotkeys" });
  assert.deepEqual(fixTarget({ ...troubled, permissions: { ...troubled.permissions, listen: false } }), {
    pane: "permissions",
  });
  const fine = { ...setup("ready"), hotkeyActions: [{ id: "dictate", problems: [] }] };
  assert.deepEqual(fixTarget(fine), { pane: "general" });
});

// ---------- 软件更新那一行 ----------

const zh = createTranslator("zh-CN");
const IDLE = {
  fromSource: false,
  current: "0.10.0",
  latest: "0.10.0",
  available: false,
  other: null,
  checking: false,
  checkProblem: null,
  launchProblem: null,
  progress: null,
  justUpdated: null,
};

test("软件更新：已是最新、从没问到过、刚更新好，按钮都是检查更新", () => {
  const latest = describeUpdate(IDLE, zh);
  assert.deepEqual(
    [latest.text, latest.tone, latest.icon, latest.action, latest.label],
    ["v0.10.0 · 已是最新版本", "ok", "i-check", "check", "检查更新"],
  );
  assert.equal(describeUpdate({ ...IDLE, latest: null }, zh).text, "v0.10.0");
  assert.equal(describeUpdate({ ...IDLE, justUpdated: "0.10.0" }, zh).text, "已更新到 v0.10.0");
});

test("软件更新：有新版本，按钮是醒目的“更新到 v…”；只是另一份旧了说是哪一份", () => {
  const view = describeUpdate({ ...IDLE, latest: "0.10.1", available: true }, zh);
  assert.deepEqual(
    [view.text, view.tone, view.action, view.label, view.primary],
    ["新版本 v0.10.1 可用 · 当前 v0.10.0", "new", "start", "更新到 v0.10.1", true],
  );
  const other = describeUpdate(
    { ...IDLE, current: "0.10.1", latest: "0.10.1", available: true, other: { kind: "home", version: "0.10.0" } },
    zh,
  );
  assert.equal(other.text, "终端安装的 OrangeSpeakEasy 仍是 v0.10.0，可一并更新到 v0.10.1");
});

test("软件更新：进行中不给按，说到了哪一步；命令行在更新也说", () => {
  const running = (progress) => describeUpdate({ ...IDLE, progress: { state: "running", by: "app", ...progress } }, zh);
  assert.equal(running({ phase: "starting" }).text, "正在检查…");
  assert.equal(running({ phase: "downloading", version: "0.10.1" }).text, "正在下载 v0.10.1…");
  assert.equal(running({ phase: "installing", version: "0.10.1" }).text, "正在安装，OrangeSpeakEasy 将自动重新打开…");
  assert.equal(running({ by: "cli", version: "0.10.1" }).text, "命令行正在更新到 v0.10.1…");
  assert.equal(running({ phase: "downloading" }).action, null);
  assert.equal(running({ phase: "downloading" }).icon, "i-loader-circle");
  const checking = describeUpdate({ ...IDLE, checking: true }, zh);
  assert.equal(checking.busy, true);
});

test("软件更新：没成、没起来、检查失败都照实说；没成和没起来的按钮是重试", () => {
  const failed = describeUpdate(
    { ...IDLE, progress: { state: "failed", problem: msg("update.checksum", { object: "0123456789ab" }) } },
    zh,
  );
  assert.equal(failed.text, "更新未完成：下载的更新数据（0123456789ab）与发布的不符，可能在传输中损坏，请重新更新。");
  assert.deepEqual([failed.tone, failed.action, failed.label], ["problem", "start", "重试"]);
  assert.equal(describeUpdate({ ...IDLE, launchProblem: "spawn ENOENT" }, zh).text, "未能开始更新：spawn ENOENT");
  const check = describeUpdate({ ...IDLE, checkProblem: msg("update.unreachable", { url: "u", reason: "r" }) }, zh);
  assert.deepEqual([check.text, check.action], ["检查失败：无法连接 u：r", "check"]);
  const source = describeUpdate({ ...IDLE, fromSource: true }, zh);
  assert.deepEqual([source.text, source.action], ["从源码运行 · 请用 git pull 更新", null]);
});

test("设置图标上标点：有新版本、上一次没成；正在更新时不标", () => {
  assert.equal(updateFlagged({ ...IDLE, available: true }), true);
  assert.equal(updateFlagged({ ...IDLE, progress: { state: "failed" } }), true);
  assert.equal(updateFlagged({ ...IDLE, available: true, progress: { state: "running" } }), false);
  assert.equal(updateFlagged(IDLE), false);
  assert.equal(updateFlagged(undefined), false);
});
