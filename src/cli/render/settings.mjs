import { msg } from "../../i18n/index.mjs";
import { SETTINGS } from "../../storage/settings.mjs";
import { toRgb } from "../../themes/color.mjs";
import { findTheme } from "../../themes/index.mjs";
import { displayWidth, INDENT, padEnd, paint, rows } from "./text.mjs";

// 设置和主题（orangespeakeasy config、orangespeakeasy theme）。

/** "朱砂（cinnabar）" / "Cinnabar (cinnabar)"。叫不出名字的（比这个命令新的版本里才有的主题）照原样写 */
export function themeTitle(t, id) {
  const theme = findTheme(id);
  return theme ? t("cli.themeTitle", { name: t(`themes.${theme.id}.name`), id: theme.id }) : id;
}

/** 一项设置是从哪来的：一句 msg。来自改名前的环境变量（GEMINI_MODEL）时，entry.env 写着是哪一个 */
export const sourceOf = (setting, entry) =>
  entry.source === "env"
    ? msg("cli.source.env", { variable: entry.env ?? setting.env })
    : msg(`cli.source.${entry.source}`);

/**
 * @param {object} view
 * @param {Record<string, { value: string, source: "env" | "file" | "default" }>} view.settings
 * @param {{ home: string, settingsFile: string, logFile: string }} view.paths
 * @param {{ color: boolean, t: Function }} options
 */
export function renderConfig({ settings, paths }, { color, t }) {
  const c = paint(color);
  const valueWidth = Math.max(...Object.values(settings).map(({ value }) => displayWidth(value))) + 2;
  const entries = [];
  for (const [name, setting] of Object.entries(SETTINGS)) {
    const { value } = settings[name];
    const meaning = setting.label ? `${t.text(setting.label(value))} · ` : "";
    // 设置项自带说明的（按动作目录生成的热键）用它的，别的查文案
    const describe = setting.describe ? t.text(setting.describe) : t(`settings.describe.${name}`);
    entries.push(
      [
        name,
        `${c.bold(value)}${" ".repeat(valueWidth - displayWidth(value))}${meaning}${t.text(sourceOf(setting, settings[name]))}`,
      ],
      [
        "",
        c.dim(setting.choices ? t("cli.config.choices", { describe, choices: setting.choices.join(" / ") }) : describe),
      ],
    );
  }
  return [
    t("cli.config.title"),
    "",
    ...rows(entries),
    "",
    `${INDENT}${t("cli.config.hintSet")}`,
    `${INDENT}${t("cli.config.hintUnset")}`,
    `${INDENT}${t("cli.config.hintKey")}`,
    `${INDENT}${t("cli.config.hintTheme")}`,
    "",
    ...rows([
      [t("cli.config.folder"), paths.home],
      [t("cli.config.settingsFile"), paths.settingsFile],
      [t("cli.config.log"), paths.logFile],
    ]),
    "",
    c.dim(`${INDENT}${t("cli.config.oneFolder")}`),
    c.dim(`${INDENT}${t("cli.config.uninstallHint")}`),
    "",
  ].join("\n");
}

/** 用一套主题的颜色在终端里画一小段悬浮条：取消、声波、完成。要终端支持 24 位色 */
function barPreview({ bar }) {
  const ink = (value) => `\x1b[38;2;${toRgb(value).join(";")}m`;
  const on = (value) => `\x1b[48;2;${toRgb(value).join(";")}m`;
  const gap = `${on(bar.surface)} `;
  return [
    gap,
    `${on(bar.ghost)}${ink(bar.ink)} ✕ `,
    gap,
    `${ink(bar.live)}▂▄▆█▅▃▂▄▆▃`,
    gap,
    `${on(bar.go)}${ink(bar.onGo)} ✓ `,
    gap,
    "\x1b[0m",
  ].join("");
}

/**
 * @param {object} view
 * @param {Array<{ id: string, bar: object }>} view.themes 名字和介绍在文案里（themes.<id>.*）
 * @param {{ value: string, source: "env" | "file" | "default" }} view.setting 现在的主题设置
 * @param {{ color: boolean, truecolor?: boolean, t: Function }} options truecolor：终端支持 24 位色，可以画出颜色
 */
export function renderThemes({ themes, setting }, { color, truecolor = false, t }) {
  const c = paint(color);
  const name = (theme) => t(`themes.${theme.id}.name`);
  const idWidth = Math.max(...themes.map((theme) => theme.id.length)) + 3;
  const nameWidth = Math.max(...themes.map((theme) => displayWidth(name(theme)))) + 3;
  const lines = [t("cli.themes.title"), ""];
  for (const theme of themes) {
    const mark = theme.id === setting.value ? c.green("●") : " ";
    const preview = truecolor ? `${barPreview(theme)}   ` : "";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(theme.id, idWidth))}${padEnd(name(theme), nameWidth)}${preview}${c.dim(t(`themes.${theme.id}.describe`))}`,
    );
  }
  const other = themes.find((theme) => theme.id !== setting.value) ?? themes[0];
  lines.push(
    "",
    `${INDENT}${t("cli.themes.current", { theme: themeTitle(t, setting.value), source: sourceOf(SETTINGS.theme, setting) })}`,
    `${INDENT}${t("cli.themes.switch", { id: other.id })}`,
    "",
  );
  return lines.join("\n");
}
