// 0.13 以前热键存的是一个 id，只能是单独一个修饰键。全仓只有这里认这些 id：读设置文件、环境变量 ORANGESPEAKEASY_HOTKEY、
// 命令行 config set hotkey 的时候换成组合，存下来的、报出去的、显示的都是新写法（docs/hotkey-research.md 5.9）。
// Mac 的右 Control 和 Windows 的右 Ctrl 是同一个位置的键，两个 id 换成同一个组合。

/** 旧 id → 组合 */
export const LEGACY_HOTKEYS = Object.freeze({
  right_option: "AltRight",
  right_command: "MetaRight",
  right_control: "ControlRight",
  fn: "Fn",
  right_alt: "AltRight",
  right_ctrl: "ControlRight",
});

/** 旧 id 对应的组合；不是旧 id 就是 null */
export const legacyChord = (id) => (Object.hasOwn(LEGACY_HOTKEYS, id) ? LEGACY_HOTKEYS[id] : null);
