import { LocalizedError, msg } from "../i18n/index.mjs";
import { ACTIONS, actionName, defaultChords } from "./actions.mjs";
import { chordString, chordsText, chordText, parseChord } from "./chord.mjs";
import { legacyChord } from "./legacy.mjs";
import { checkBindings } from "./validate.mjs";

// 热键的设置项：动作目录里每个动作一项，名字是 hotkey.<动作>（docs/hotkey-research.md 5.2）。
// 设置框架（src/storage/settings.mjs）把这几项并进它的表；这里不反过来引用它，check 拿到的整份设置是框架传进来的。
// 值在框架里是字符串：规整过的组合列表写成 JSON（["Fn","MetaRight"]），文件里存成数组（store、json）。

/** 动作的设置项叫什么 */
export const settingNameOf = (action) => `hotkey.${action.id}`;
/** 动作的环境变量：只管这一次运行，写法同设置文件 */
export const envOf = (action) => `ORANGESPEAKEASY_HOTKEY_${action.id.toUpperCase()}`;

/** 设置里的值 → 组合列表，每个组合是 code 数组。值是 parse 规整过的，code 名里不会有加号 */
export const chordsOf = (value) => JSON.parse(value).map((text) => text.split("+"));
/** 组合列表 → 设置里的值 */
export const chordsValue = (chords) => JSON.stringify(chords.map(chordString));

const notList = () => new LocalizedError(msg("hotkeySetting.notList"));

/**
 * 写法：一个组合（"ControlRight+Space"），或者一组（'["Fn","MetaRight"]'）。0.13 以前的旧 id 在这里换成组合，
 * 之后存的、报的都是新写法（5.9）。规整后一样的只留一个。这个系统上绑不绑得上不在这里查（check、下发前）
 */
function parseChords(text) {
  const trimmed = text.trim();
  let items = [trimmed];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      items = JSON.parse(trimmed);
    } catch {
      // PowerShell 调 orangespeakeasy.cmd 时会去掉参数里的双引号（[Fn,MetaRight]）。code 名里没有逗号和引号，照样拆得开
      if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw notList();
      items = trimmed.slice(1, -1).split(",");
    }
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) throw notList();
  }
  const chords = items.map((item) => chordString(parseChord(legacyChord(item.trim()) ?? item)));
  return JSON.stringify([...new Set(chords)]);
}

/** 一个组合的问题，前面带上是哪个组合（右⌘ C：……）；整个动作的问题（一个都没有）不带 */
const problemOf = (chords, { index, reason }) =>
  chords[index] === undefined ? reason : msg("hotkeySetting.problem", { chord: chordText(chords[index]), reason });

/**
 * 这个动作的设置项。check：写入前和别的动作的设置一起查（validate.mjs），要改的这个放在最后，撞了就是它不能存；
 * 拒绝的抛出原因，只有提醒时照存，返回提醒（一句一条）
 */
function settingOf(action, platform) {
  return {
    env: envOf(action),
    ...(action.legacyEnv ? { legacyEnv: action.legacyEnv } : {}),
    ...(action.legacyName ? { legacyName: action.legacyName } : {}),
    default: chordsValue(defaultChords(action, platform)),
    choices: null,
    json: true,
    parse: parseChords,
    store: (value) => JSON.parse(value),
    label: (value) => chordsText(chordsOf(value)),
    describe: msg("hotkeySetting.describe", { action: actionName(action) }),
    check(value, settings) {
      const bindings = {};
      for (const other of ACTIONS) {
        if (other !== action) bindings[other.id] = chordsOf(settings[settingNameOf(other)].value);
      }
      const chords = chordsOf(value);
      bindings[action.id] = chords;
      const problems = checkBindings(bindings, platform).filter((problem) => problem.action === action.id);
      const rejected = problems.find((problem) => problem.level === "reject");
      if (rejected) throw new LocalizedError(problemOf(chords, rejected));
      return problems.map((problem) => problemOf(chords, problem));
    },
  };
}

/**
 * 这个系统上热键的几项设置，按动作目录的先后
 * @param {string} platform
 */
export const hotkeySettings = (platform) =>
  Object.fromEntries(ACTIONS.map((action) => [settingNameOf(action), settingOf(action, platform)]));
