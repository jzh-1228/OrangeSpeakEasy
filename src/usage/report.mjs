// 用量报表：今天、本月、累计各调了几次模型、多少 token、花了多少钱、模型一般多久回话，每一段再按型号分开。
// 命令行（orangespeakeasy usage）和主窗口首页用的是同一份。数据是历史库里的账（src/storage/history.mjs 的 usage），
// 钱是按官方标准价估算的美元（src/server/providers/prices）。本机转写那一跳也有一笔（provider 是 local），不花钱。
// 每一段还带着花费随时间怎么走（series，src/usage/series.mjs）：首页画成柱子，命令行用不上。

import { findModel, makerOf } from "../models/catalog.mjs";
import { findVendor } from "../server/vendors.mjs";
import { modelKey, spanSeries, timeSeries } from "./series.mjs";

/** 从快到慢排好的一串数里取第 p 分位（最近秩法：至少 p 那么多的数不比它大）。空的是 null */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * 一段时间的汇总 → 报表里的一项：加上 token 合计；每次听写等了多久，换成一般多久（中位数）、慢的时候多久
 * （九成都比它快）。还没听写过的是 null，不是 0 秒
 */
function summarize({ latenciesMs, models: _models, ...totals }) {
  return {
    ...totals,
    tokens: totals.inputTokens + totals.outputTokens,
    latency:
      latenciesMs.length === 0 ? null : { medianMs: percentile(latenciesMs, 0.5), p90Ms: percentile(latenciesMs, 0.9) },
  };
}

/**
 * 一个型号是谁：name 给人看的名字（云上的是那一家的名字，型号另在 model 里；本机的是模型的名字），
 * icon 按哪家取图标（renderer/shared/provider-icons.mjs），local 是不是本机转写的那一跳。
 * 清单里已经没有的本机模型、不认识的那家，照 id 说
 */
function whoIs({ provider, model }) {
  if (provider === "local") {
    const found = findModel(model);
    return { name: found?.name ?? model, icon: found ? makerOf(found) : null, local: true };
  }
  return { name: findVendor(provider)?.name ?? provider, icon: provider, local: false };
}

/** 一段时间 → 报表里的一项，连同按型号分开的几行（花得多的在前）；key 对得上 series 每一格里按型号分开的钱 */
function period(usage, series) {
  return {
    ...summarize(usage),
    models: usage.models.map((row) => ({ ...summarize(row), ...whoIs(row), key: modelKey(row) })),
    series,
  };
}

/**
 * @param {{ usage(range?: { since?: string }): object }} history 打开着的历史库
 * @param {{ now: Date }} options 今天、本月按本机的时区算
 * @returns {{ today: object, month: object, total: object, models: object[] }} models 是累计的按型号分开（同 total.models）；
 *   series：今天按钟头（0 点到 23 点），本月按天（1 号到月底），累计按用了多久（spanSeries）
 */
export function usageReport(history, { now }) {
  // 按年月日现拼，和柱子的格子（series.mjs 的 startOf）同一个算法：
  // 当天零点因夏令时不存在、顺延到 01:00 时，不能再拿它推 1 号，不然 1 号也从 01:00 算起
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfMonth = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0);
  const lastHour = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 23);
  // 按天分的一份本月、累计共用：series 只取落在自己范围里的
  const days = history.usageOverTime({ unit: "day" });
  const hours = history.usageOverTime({ since: midnight.toISOString(), unit: "hour" });
  const total = period(history.usage(), spanSeries(days, { now }));
  return {
    today: period(
      history.usage({ since: midnight.toISOString() }),
      timeSeries(hours, { unit: "hour", from: midnight, to: lastHour, now }),
    ),
    month: period(
      history.usage({ since: firstOfMonth.toISOString() }),
      timeSeries(days, { unit: "day", from: firstOfMonth, to: lastOfMonth, now }),
    ),
    total,
    models: total.models,
  };
}
