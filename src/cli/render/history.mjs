import { INDENT, paint } from "./text.mjs";

// 历史（orangespeakeasy history）：按天分组，新的在前。
// 翻译的那几条正文是译文，下面淡色写功能、目标语言和原文（和主窗口的历史一样）。

/** 按给定时区拆出年月日和"时:分"（日期怎么写、星期几由 dayHeading 按界面语言写） */
function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    time: `${parts.hour}:${parts.minute}`,
  };
}

function dayHeading(date, parts, { now, timeZone, t }) {
  const format = (options) => new Intl.DateTimeFormat(t.locale, { timeZone, ...options }).format(date);
  const day = format({ month: "long", day: "numeric" });
  const today = localParts(now, timeZone);
  if (parts.dayKey === today.dayKey) return t("cli.history.today", { date: day });
  if (parts.dayKey === localParts(new Date(now.getTime() - 86_400_000), timeZone).dayKey) {
    return t("cli.history.yesterday", { date: day });
  }
  // 不是今年的要带上年份，否则分不清是哪一年的 10 月 8 日
  const year = parts.year === today.year ? {} : { year: "numeric" };
  return format({ ...year, month: "long", day: "numeric", weekday: "short" });
}

/** 翻译的那条（有目标语言）：功能 · 语言，后面跟原文；原文没有（失败了）就只写功能和语言。不是翻译的没有这几行 */
function sourceLines({ kind, outputLanguage, sourceText }, t) {
  if (!outputLanguage) return [];
  const label = `${t(`actions.${kind}.name`)} · ${t(`languages.${outputLanguage}`)}`;
  if (!sourceText) return [label];
  const [first, ...rest] = sourceText.split("\n");
  return [t("cli.history.source", { label, text: first }), ...rest];
}

/**
 * @param {object} view
 * @param {Array<object>} view.rows 新的在前（历史库 list() 给的顺序）
 * @param {number} view.total 库里一共多少条
 * @param {{ color: boolean, now: Date, timeZone?: string, t: Function }} options timeZone 不给就用系统的；t 是界面语言的翻译函数
 */
export function renderHistory({ rows, total }, { color, now, timeZone, t }) {
  const c = paint(color);
  if (rows.length === 0) return `${t("cli.history.empty", { command: c.bold("orangespeakeasy") })}\n`;

  // "  14:32  " 之后才是文字，续行缩进到同一列
  const continuation = " ".repeat(INDENT.length + 5 + 2);
  const lines = [];
  let currentDay = null;
  for (const entry of rows) {
    const date = new Date(entry.createdAt);
    const parts = localParts(date, timeZone);
    if (parts.dayKey !== currentDay) {
      if (currentDay !== null) lines.push("");
      lines.push(c.bold(dayHeading(date, parts, { now, timeZone, t })));
      currentDay = parts.dayKey;
    }
    const body =
      entry.status === "completed"
        ? entry.refinedText.split("\n")
        : [
            c.red(t("cli.history.failed", { reason: entry.error ?? t("common.unknownReason") })),
            c.dim(
              t("cli.history.recording", {
                seconds: entry.duration.toFixed(1),
                path: entry.audioLocalPath ?? t("cli.history.notSaved"),
              }),
            ),
          ];
    body.forEach((line, index) => {
      if (index === 0) lines.push(`${INDENT}${c.dim(parts.time)}  ${line}`);
      // 段落之间的空行不带缩进，免得行尾留一串空格
      else lines.push(line === "" ? "" : `${continuation}${line}`);
    });
    for (const line of sourceLines(entry, t)) lines.push(line === "" ? "" : `${continuation}${c.dim(line)}`);
  }

  if (rows.length < total) {
    lines.push("", c.dim(t("cli.history.more", { shown: rows.length, total })));
  }
  lines.push("");
  return lines.join("\n");
}
