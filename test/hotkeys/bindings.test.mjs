import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, actionOf } from "../../src/hotkeys/actions.mjs";
import {
  actionOfBinding,
  bindingTable,
  boundProblems,
  describeHotkeyProblem,
  resolveHotkeys,
} from "../../src/hotkeys/bindings.mjs";
import { parseChord } from "../../src/hotkeys/chord.mjs";
import { hotkeySettings } from "../../src/hotkeys/settings.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const chords = (map) => Object.fromEntries(Object.entries(map).map(([id, list]) => [id, list.map(parseChord)]));

test("下发的绑定表：Mac 发 kVK；修饰键和普通键分两栏，没有普通键就不带 key", () => {
  const table = bindingTable(chords({ dictate: ["AltRight", "AltRight+Space", "F13"], cancel: ["Escape"] }), "darwin");
  assert.deepEqual(table, [
    { id: "dictate#0", mods: [0x3d], when: "always" },
    { id: "dictate#1", mods: [0x3d], key: 0x31, when: "always" },
    { id: "dictate#2", mods: [], key: 0x69, when: "always" },
    { id: "cancel#0", mods: [], key: 0x35, when: "capturing" },
  ]);
});

test("下发的绑定表：Windows 上修饰键发 vk，别的键发扫描码，扩展键的 0xE0 前缀在高字节", () => {
  const table = bindingTable(
    chords({ dictate: ["ControlRight", "ContextMenu", "ShiftRight+F13"], cancel: ["Escape"] }),
    "win32",
  );
  assert.deepEqual(table, [
    { id: "dictate#0", mods: [0xa3], when: "always" },
    { id: "dictate#1", mods: [], key: 0xe05d, when: "always" },
    { id: "dictate#2", mods: [0xa1], key: 0x64, when: "always" },
    { id: "cancel#0", mods: [], key: 0x01, when: "capturing" },
  ]);
});

test("两个修饰键的组合：mods 按显示的先后排，和写的先后无关", () => {
  const [row] = bindingTable(chords({ dictate: ["ShiftRight+ControlRight"] }), "darwin");
  assert.deepEqual(row.mods, [0x3e, 0x3c]);
});

test("按动作目录的先后出表；目录里有、这里没写的动作不出；不认识的动作不出", () => {
  const table = bindingTable({ cancel: [["Escape"]], dictate: [["AltRight"]], nope: [["F13"]] }, "darwin");
  assert.deepEqual(
    table.map((row) => row.id),
    ["dictate#0", "cancel#0"],
  );
  assert.deepEqual(bindingTable({ dictate: [] }, "darwin"), []);
});

test("这个系统上没有的键：不是静默跳过，是报错（校验该在前面拦下）", () => {
  assert.throws(() => bindingTable(chords({ dictate: ["Fn"] }), "win32"), /Fn/);
});

test("绑定 id 认回动作：每个动作的每个组合都认得回来；不认识的是 null", () => {
  const all = Object.fromEntries(ACTIONS.map((action) => [action.id, [["F13"], ["F14"]]]));
  for (const row of bindingTable(all, "darwin")) {
    assert.equal(actionOfBinding(row.id), actionOf(row.id.split("#")[0]), row.id);
  }
  for (const id of ["", "nope#0", "dictate", "#0", undefined, 7]) assert.equal(actionOfBinding(id), null, String(id));
});

// ---------- 下发前的校验和退回（5.2 的第三道） ----------

/** 照 resolveSettings 的样子拼热键那几项：给了的算用户自己设的（file），没给的是默认值 */
function settingsOn(platform, values = {}) {
  return Object.fromEntries(
    Object.entries(hotkeySettings(platform)).map(([name, setting]) => [
      name,
      name in values
        ? { value: setting.parse(values[name]), source: "file" }
        : { value: setting.default, source: "default" },
    ]),
  );
}
const zhWin = createTranslator("zh-CN", "win32");
/** 两个系统的默认组合一样 */
const DEFAULTS = {
  dictate: [["AltRight"]],
  translate: [["AltRight", "Space"]],
  lookup: [["AltRight", "Enter"]],
  cancel: [["Escape"]],
};
const zhMac = createTranslator("zh-CN", "darwin");
const texts = (problems, t) => problems.map((problem) => t.text(describeHotkeyProblem(problem)));

test("都是默认的：照装，没有问题；Windows 的右 Alt 带 AltGr 的提醒，Mac 的右⌥空格、右⌥回车各带一条提醒", () => {
  for (const platform of ["darwin", "win32"]) {
    const resolved = resolveHotkeys(settingsOn(platform), platform);
    assert.deepEqual(resolved.chords, DEFAULTS);
    assert.deepEqual(resolved.problems, []);
    // 语音输入的键是语音翻译、划词翻译的前缀，不提醒：按翻译时直接升级过去，按划词时主进程把这一下压住
    assert.deepEqual(
      resolved.warnings.map(({ action, chord }) => [action, chord]),
      platform === "win32"
        ? [
            ["dictate", ["AltRight"]],
            ["translate", ["AltRight", "Space"]],
            ["lookup", ["AltRight", "Enter"]],
          ]
        : [
            ["translate", ["AltRight", "Space"]],
            ["lookup", ["AltRight", "Enter"]],
          ],
    );
  }
});

test("Mac 的设置搬到 Windows 上：fn 写法没错、绑不了，听写退回右 Alt 并说明；App 照样起得来（3.4 第 9 条）", () => {
  const resolved = resolveHotkeys(settingsOn("win32", { "hotkey.dictate": "Fn" }), "win32");
  assert.deepEqual(resolved.chords, DEFAULTS);
  assert.deepEqual(texts(resolved.problems, zhWin), [
    "「语音输入」的 fn 用不了：这个系统上没有地球仪（fn）键",
    "「语音输入」先用默认的 右 Alt",
  ]);
  // 能装的照装：只有装不上的那个不装，不退回
  const partly = resolveHotkeys(settingsOn("win32", { "hotkey.dictate": '["Fn","ControlRight"]' }), "win32");
  assert.deepEqual(partly.chords.dictate, [["ControlRight"]]);
  assert.deepEqual(texts(partly.problems, zhWin), ["「语音输入」的 fn 用不了：这个系统上没有地球仪（fn）键"]);
});

test('默认组合也装不上：不说"先用默认的"，只说为什么，同一条不说两遍', () => {
  // 现在的两个动作碰不到（写法上 esc 不能和别的键组合），以后加动作时默认组合可能撞上用户自己的：绕过写法检查造一个
  const settings = settingsOn("darwin");
  settings["hotkey.dictate"] = { value: '["AltRight+Escape"]', source: "file" };
  const resolved = resolveHotkeys(settings, "darwin");
  assert.deepEqual(resolved.chords, { ...DEFAULTS, dictate: [["AltRight", "Escape"]], cancel: [] });
  const said = texts(resolved.problems, zhMac);
  assert.equal(said.length, 1, said.join(" | "));
  assert.match(said[0], /^「取消」的 esc 用不了/);
});

test("手改文件写了系统保留的、取消写成了修饰键、清空了不能清空的：那个不装，必须有键的退回默认", () => {
  const reserved = resolveHotkeys(settingsOn("darwin", { "hotkey.dictate": "MetaRight+KeyC" }), "darwin");
  assert.deepEqual(reserved.chords.dictate, [["AltRight"]]);
  assert.match(texts(reserved.problems, zhMac)[0], /^「语音输入」的 右⌘ C 用不了：⌘ 加打字的键/);
  const cancel = resolveHotkeys(settingsOn("darwin", { "hotkey.cancel": "AltRight+Space" }), "darwin");
  assert.deepEqual(cancel.chords.cancel, [["Escape"]]);
  const cleared = resolveHotkeys(settingsOn("darwin", { "hotkey.cancel": "[]" }), "darwin");
  assert.deepEqual(cleared.chords.cancel, [["Escape"]]);
  assert.deepEqual(texts(cleared.problems, zhMac), ["「取消」先用默认的 esc"]);
});

test("两个都是自己设的、撞了：按动作目录的先后，后面的让位", () => {
  const resolved = resolveHotkeys(
    settingsOn("darwin", { "hotkey.dictate": "ControlRight+F13", "hotkey.cancel": "F13" }),
    "darwin",
  );
  assert.deepEqual(resolved.chords, { ...DEFAULTS, dictate: [["ControlRight", "F13"]] });
  assert.match(texts(resolved.problems, zhMac)[0], /^「取消」的 F13 用不了：F13 键在「语音输入」的组合里/);
});

test("能绑但要提醒的照装，提醒单独交出来写日志，不算问题", () => {
  const resolved = resolveHotkeys(settingsOn("darwin", { "hotkey.dictate": "Fn" }), "darwin");
  assert.deepEqual(resolved.chords.dictate, [["Fn"]]);
  assert.deepEqual(resolved.problems, []);
  const own = resolved.warnings.filter(({ action }) => action === "dictate");
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].chord, ["Fn"]);
  assert.match(zhMac.text(own[0].reason), /^地球仪键在系统设置里/);
});

test("小帮手的 bound 回执：按绑定 id 认回是哪个组合，原因换成人话；没有输入监控权限的不重复报（那一项另有一条）", () => {
  const chords = { dictate: [["AltRight"], ["AltRight", "Space"]], cancel: [["Escape"]] };
  const problems = boundProblems(
    [
      { id: "dictate#1", reason: "needs_trusted" },
      { id: "cancel#0", reason: "needs_listen" },
      // 说话时才生效的（取消）没有辅助功能权限时本来就截不住，悬浮条那时也不画取消按钮：不算缺
      { id: "cancel#0", reason: "needs_trusted" },
      { id: "dictate#9", reason: "invalid" },
      { id: "nope#0", reason: "invalid" },
    ],
    chords,
  );
  assert.deepEqual(texts(problems, zhMac), [
    "「语音输入」的 右⌥ 空格 用不了：要先在系统设置里给 OrangeSpeakEasy 辅助功能权限",
  ]);
  assert.match(
    zhMac.text(describeHotkeyProblem(boundProblems([{ id: "dictate#0", reason: "register_failed" }], chords)[0])),
    /系统没让注册/,
  );
  assert.match(
    zhMac.text(describeHotkeyProblem(boundProblems([{ id: "dictate#0", reason: "invalid" }], chords)[0])),
    /小帮手认不出/,
  );
});
