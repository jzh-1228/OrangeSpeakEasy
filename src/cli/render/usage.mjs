import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { displayWidth, INDENT, paint } from "./text.mjs";

// 用量（orangespeakeasy usage）：今天、本月、累计花了多少钱、多少 token、模型多久回话，再按型号分开列累计。
// 本机转写那一跳单列一行（不花钱、没有 token），听写的时间花在哪一跳、钱花在谁身上一眼看得出。

const GAP = "   ";

/**
 * 几行几列排整齐：每列按最宽的那格补空格，align 里写 "right" 的列靠右（数字），其余靠左。
 * 行尾不留空格
 */
function columns(rows, align) {
  const widths = align.map((_, i) => Math.max(...rows.map((cells) => displayWidth(cells[i]))));
  return rows.map((cells) =>
    cells
      .map((cell, i) => {
        const pad = " ".repeat(widths[i] - displayWidth(cell));
        return align[i] === "right" ? pad + cell : cell + pad;
      })
      .join(GAP)
      .trimEnd(),
  );
}

const waiting = (latency, t) =>
  latency
    ? t("cli.usage.waiting", { median: formatSeconds(latency.medianMs, t), slow: formatSeconds(latency.p90Ms, t) })
    : "—";

/** 一个型号的钱：全都不在价目表里时说不明 */
const costOf = ({ costUsd, calls, unpricedCalls }, t) =>
  unpricedCalls === calls ? t("cli.usage.unpriced") : formatUsd(costUsd);

/**
 * @param {{ today: object, month: object, total: object, models: object[] } | null} report src/usage/report.mjs 给的；
 *   还没有历史库时是 null
 * @param {{ color: boolean, t: Function }} options
 */
export function renderUsage(report, { color, t }) {
  const c = paint(color);
  if (report === null || report.total.calls === 0) return `${t("cli.usage.empty")}\n`;
  const { total } = report;

  const periods = columns(
    [
      ["", t("cli.usage.cost"), t("cli.usage.tokens"), t("cli.usage.dictations"), t("cli.usage.latency")],
      ...[
        [t("periods.today"), report.today],
        [t("periods.month"), report.month],
        [t("periods.total"), total],
      ].map(([label, it]) => [
        label,
        formatUsd(it.costUsd),
        formatTokens(it.tokens),
        String(it.dictations),
        waiting(it.latency, t),
      ]),
    ],
    ["left", "right", "right", "right", "left"],
  );
  const models = columns(
    report.models.map((it) => [
      it.local ? t("cli.usage.localModel", { name: it.name }) : `${it.name} ${it.model}`,
      it.local ? t("cli.usage.free") : costOf(it, t),
      it.local ? "—" : formatTokens(it.tokens),
      t("cli.usage.times", { count: it.dictations + it.lookups }),
      it.latency ? t("cli.usage.usually", { median: formatSeconds(it.latency.medianMs, t) }) : "",
    ]),
    ["left", "right", "right", "right", "left"],
  );

  const notes = [
    t("cli.usage.tokensNote", {
      input: formatTokens(total.inputTokens),
      audio: formatTokens(total.audioTokens),
      cached: formatTokens(total.cachedTokens),
      output: formatTokens(total.outputTokens),
      thinking: formatTokens(total.thinkingTokens),
    }),
  ];
  if (total.lookups > 0) notes.push(t("cli.usage.lookupsNote", { count: total.lookups }));
  if (total.checks > 0) notes.push(t("cli.usage.checksNote", { count: total.checks }));
  if (total.cacheCostUsd > 0) notes.push(t("cli.usage.cacheNote", { cost: formatUsd(total.cacheCostUsd) }));
  const unpriced = report.models.filter(({ unpricedCalls }) => unpricedCalls > 0);
  if (unpriced.length > 0) {
    notes.push(
      t("cli.usage.unpricedNote", { models: t.list(unpriced.map(({ model }) => model)), count: total.unpricedCalls }),
    );
  }
  notes.push(t("cli.usage.estimateNote"));

  return [
    c.bold(t("cli.usage.title")),
    "",
    `${INDENT}${c.dim(periods[0])}`,
    ...periods.slice(1).map((line) => `${INDENT}${line}`),
    "",
    `${INDENT}${c.bold(t("cli.usage.byModel"))}`,
    ...models.map((line) => `${INDENT}${line}`),
    "",
    ...notes.map((note) => c.dim(`${INDENT}${note}`)),
    "",
  ].join("\n");
}
