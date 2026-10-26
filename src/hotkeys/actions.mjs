import { msg } from "../i18n/index.mjs";
import { parseChord } from "./chord.mjs";

// 动作目录：有哪些能按快捷键做的事，只有这一张表（docs/hotkey-research.md 5.4）。
// 设置项（hotkey.<动作>）、环境变量、命令行、设置页、状态、下发给小帮手的绑定表，都按它生成。
// 加一个动作只改三处：这里加一行（两个系统都必须有默认组合，D10）；两份文案里加 actions.<动作>.name；
// 写它自己的处理代码。有测试按这张表逐个动作查，漏了哪一处会红。
//
// 每行：
//   defaults     默认组合，按系统分，每个组合是 "AltRight+Space" 这样的写法
//   when         always 任何时候；capturing 只在说话时（悬浮条截着 esc 的那段时间）。capturing 的动作只按自己那一个键认，
//                不按集合精确匹配：说话时它一按下就算，不管还按着别的什么（5.3 的"esc 与取消"）
//   clearable    能不能一个组合都不留
//   longPressMs  按住超过这么久算"按住"、这次作废；null 是不管按多久
//   handler      交给谁：session 悬浮条的录音会话（按下、松开、被打断），cancel 正截着键的那个窗口（悬浮条、划词卡片）的取消，
//                lookup 划词翻译（app/lookup.mjs，只看按下）。
//                session 的动作各对应服务端的一个任务（id 一样，src/server/tasks）：说完让模型做成什么由任务定
//   legacyName、legacyEnv  0.13 以前这一项设置叫什么、环境变量叫什么，入口照样认（5.9）

export const ACTIONS = Object.freeze([
  Object.freeze({
    id: "dictate",
    defaults: Object.freeze({ darwin: Object.freeze(["AltRight"]), win32: Object.freeze(["AltRight"]) }),
    when: "always",
    clearable: false,
    longPressMs: 600,
    handler: "session",
    legacyName: "hotkey",
    legacyEnv: "ORANGESPEAKEASY_HOTKEY",
  }),
  Object.freeze({
    id: "translate",
    // 语音输入的键再加空格：按下右⌥时先开始语音输入，空格到了升级成翻译（docs/hotkey-research.md D2），录音不断
    defaults: Object.freeze({ darwin: Object.freeze(["AltRight+Space"]), win32: Object.freeze(["AltRight+Space"]) }),
    when: "always",
    clearable: false,
    longPressMs: 600,
    handler: "session",
  }),
  Object.freeze({
    id: "lookup",
    // 选中文字后按：取选区、弹卡片、译成设置里的那种语言（app/lookup.mjs）。按下就算，不管按多久
    defaults: Object.freeze({ darwin: Object.freeze(["AltRight+Enter"]), win32: Object.freeze(["AltRight+Enter"]) }),
    when: "always",
    clearable: true,
    longPressMs: null,
    handler: "lookup",
  }),
  Object.freeze({
    id: "cancel",
    defaults: Object.freeze({ darwin: Object.freeze(["Escape"]), win32: Object.freeze(["Escape"]) }),
    when: "capturing",
    clearable: false,
    longPressMs: null,
    handler: "cancel",
  }),
]);

/** 说话的功能（录音会话的动作：语音输入、语音翻译）：首页、命令行的口述统计只数它们，划词翻译不算 */
export const SPOKEN_ACTIONS = Object.freeze(ACTIONS.filter(({ handler }) => handler === "session").map(({ id }) => id));

/** 一个动作最多几个组合（D4，同 Typeless） */
export const MAX_CHORDS = 4;

/** 这个 id 的动作；不认识的是 null */
export const actionOf = (id) => ACTIONS.find((action) => action.id === id) ?? null;

/** 动作的名字：一句还没定语言的话 */
export const actionName = (action) => msg(`actions.${action.id}.name`);

/** 这个系统上的默认组合，每个是规整过的 code 数组 */
export const defaultChords = (action, platform) =>
  (action.defaults[platform === "win32" ? "win32" : "darwin"] ?? []).map(parseChord);
