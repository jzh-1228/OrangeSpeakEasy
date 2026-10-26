import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "../../src/hotkeys/actions.mjs";
import { chordsOf, chordsValue, envOf, hotkeySettings, settingNameOf } from "../../src/hotkeys/settings.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const mac = hotkeySettings("darwin");
const win = hotkeySettings("win32");
const enMac = createTranslator("en", "darwin");
const zhMac = createTranslator("zh-CN", "darwin");
const zhWin = createTranslator("zh-CN", "win32");
const said = (translator, pattern) => (error) => pattern.test(translator.text(error.problem));

/** 整份设置里热键那几项（check 要的），没写的是默认值 */
const settingsWith = (settings, values = {}) =>
  Object.fromEntries(
    Object.entries(settings).map(([name, setting]) => [
      name,
      { value: values[name] ?? setting.default, source: name in values ? "file" : "default" },
    ]),
  );

test("动作目录里每个动作一项 hotkey.<动作>，环境变量 ORANGESPEAKEASY_HOTKEY_<动作>；听写另认旧名字和旧环境变量", () => {
  assert.deepEqual(Object.keys(mac), ["hotkey.dictate", "hotkey.translate", "hotkey.lookup", "hotkey.cancel"]);
  assert.deepEqual(
    ACTIONS.map((action) => [settingNameOf(action), envOf(action)]),
    [
      ["hotkey.dictate", "ORANGESPEAKEASY_HOTKEY_DICTATE"],
      ["hotkey.translate", "ORANGESPEAKEASY_HOTKEY_TRANSLATE"],
      ["hotkey.lookup", "ORANGESPEAKEASY_HOTKEY_LOOKUP"],
      ["hotkey.cancel", "ORANGESPEAKEASY_HOTKEY_CANCEL"],
    ],
  );
  assert.equal(mac["hotkey.dictate"].env, "ORANGESPEAKEASY_HOTKEY_DICTATE");
  assert.equal(mac["hotkey.dictate"].legacyEnv, "ORANGESPEAKEASY_HOTKEY");
  assert.equal(mac["hotkey.dictate"].legacyName, "hotkey");
  assert.equal(mac["hotkey.cancel"].legacyEnv, undefined);
  assert.equal(mac["hotkey.cancel"].legacyName, undefined);
  // 不列可选值：任意组合
  assert.equal(mac["hotkey.dictate"].choices, null);
});

test("默认值按系统取动作目录里的默认组合，写成规整过的列表", () => {
  assert.equal(mac["hotkey.dictate"].default, '["AltRight"]');
  assert.equal(win["hotkey.dictate"].default, '["AltRight"]');
  assert.equal(mac["hotkey.cancel"].default, '["Escape"]');
});

test("写法：一个组合、列表、旧 id 都认，存成规整过的列表；文件里存成数组", () => {
  const parse = mac["hotkey.dictate"].parse;
  assert.equal(parse("Fn"), '["Fn"]');
  assert.equal(parse(" Space + ControlRight "), '["ControlRight+Space"]');
  assert.equal(parse('["Fn", "MetaRight"]'), '["Fn","MetaRight"]');
  assert.equal(parse('["Space+AltRight","AltRight+Space"]'), '["AltRight+Space"]', "规整后一样的只留一个");
  assert.equal(parse("[]"), "[]", "空列表是关掉，能不能存由 check 管");
  // PowerShell 调 orangespeakeasy.cmd 时会去掉参数里的双引号：不带引号的列表也认（code 名里没有逗号和引号）
  assert.equal(parse("[Fn, MetaRight]"), '["Fn","MetaRight"]');
  // 旧 id 只在入口认（5.9）：设置文件、环境变量、命令行写的都是它
  assert.equal(parse("right_command"), '["MetaRight"]');
  assert.equal(parse('["fn","right_option"]'), '["Fn","AltRight"]');
  // 写法和这个系统无关：Windows 上也认 Fn，绑不绑得上是下发前的事（5.2）
  assert.equal(win["hotkey.dictate"].parse("Fn"), '["Fn"]');
  assert.deepEqual(mac["hotkey.dictate"].store('["Fn","MetaRight"]'), ["Fn", "MetaRight"]);
  assert.equal(mac["hotkey.dictate"].json, true);
});

test("写法不对的照实说", () => {
  const parse = mac["hotkey.dictate"].parse;
  assert.throws(() => parse("caps_lock"), said(zhMac, /不认识的键 "caps_lock"/));
  assert.throws(() => parse(""), said(zhMac, /没写键/));
  assert.throws(() => parse("KeyA"), said(zhMac, /单按会打出字/));
  assert.throws(() => parse("ControlRight+AltRight+Space"), said(zhMac, /最多两个键/));
  assert.throws(() => parse('["Fn", 1]'), said(zhMac, /一组组合/));
  assert.throws(() => parse("[Fn"), said(zhMac, /一组组合/));
  assert.throws(() => parse('{"a":1}'), said(zhMac, /一组组合/));
});

test("组合列表和设置里的值互换", () => {
  assert.deepEqual(chordsOf('["Fn","AltRight+Space"]'), [["Fn"], ["AltRight", "Space"]]);
  assert.deepEqual(chordsOf("[]"), []);
  assert.equal(chordsValue([["Space", "AltRight"], ["Fn"]]), '["AltRight+Space","Fn"]');
});

test("它叫什么：几个组合的键帽按“或”并列；说明按动作名写", () => {
  assert.equal(zhMac.text(mac["hotkey.dictate"].label('["Fn","MetaRight"]')), "fn、右⌘");
  assert.equal(enMac.text(mac["hotkey.dictate"].label('["Fn","AltRight+Space"]')), "fn or Right ⌥ Space");
  assert.equal(zhWin.text(win["hotkey.dictate"].label('["ControlRight"]')), "右 Ctrl");
  assert.match(zhMac.text(mac["hotkey.dictate"].describe), /「语音输入」的快捷键/);
  assert.match(zhMac.text(mac["hotkey.cancel"].describe), /「取消」的快捷键/);
});

test("写入前的检查：系统保留、这个系统没有、和别的动作撞了都不让存；只有提醒时照存并带回提醒", () => {
  const check = (settings, name, value) => settings[name].check(settings[name].parse(value), settingsWith(settings));
  assert.throws(() => check(mac, "hotkey.dictate", "MetaRight+KeyC"), said(zhMac, /右⌘ C：⌘ 加打字的键/));
  assert.throws(() => check(win, "hotkey.dictate", "Fn"), said(zhWin, /这个系统上没有地球仪（fn）键/));
  assert.throws(() => check(mac, "hotkey.dictate", "[]"), said(zhMac, /「语音输入」至少要有一个组合/));
  assert.throws(() => check(mac, "hotkey.cancel", "AltRight"), said(zhMac, /只能绑一个非修饰键/));
  // 要改的那个让位：取消占着 esc 时听写不能再要，反过来也一样
  assert.throws(() => check(mac, "hotkey.dictate", '["AltRight","Escape"]'), said(zhMac, /esc/));
  const cancelF13 = settingsWith(mac, { "hotkey.cancel": '["F13"]' });
  assert.throws(() => mac["hotkey.dictate"].check('["F13"]', cancelF13), said(zhMac, /F13：已经给了「取消」/));
  const dictateWithF13 = settingsWith(mac, { "hotkey.dictate": '["ControlRight+F13"]' });
  assert.throws(
    () => mac["hotkey.cancel"].check('["F13"]', dictateWithF13),
    said(zhMac, /F13 键在「语音输入」的组合里/),
  );

  assert.deepEqual(check(mac, "hotkey.dictate", '["MetaRight","AltRight"]'), []);
  const warnings = check(mac, "hotkey.dictate", "Fn");
  assert.equal(warnings.length, 1);
  assert.match(zhMac.text(warnings[0]), /^fn：地球仪键在系统设置里/);
});
