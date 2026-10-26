import { openHistory } from "../storage/history.mjs";

// 历史库是附属数据：文件坏了、版本比程序新时，App 照样得起来（听写、快捷键、密钥、服务都不靠它），
// `orangespeakeasy status` 也不能整体失败。这里把"打不开"变成：读的地方看到空的，写的地方记一条警告后跳过。
// 用户的库文件一律不删、不改写：打不开就原样留着，等修好，或者换回旧版本再打开。

/** 空的统计，和 history.stats() 同形（src/storage/history.mjs 的 summarize） */
const emptyStats = () => ({
  entries: 0,
  dictations: 0,
  characters: 0,
  seconds: 0,
  failed: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

/** 空的用量汇总，和 history.usage() 同形（src/storage/history.mjs 的 USAGE_COLUMNS） */
const emptyUsage = () => ({
  calls: 0,
  checks: 0,
  dictations: 0,
  lookups: 0,
  inputTokens: 0,
  audioTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
  cacheCostUsd: 0,
  unpricedCalls: 0,
  latenciesMs: [],
  models: [],
});

/**
 * 打不开时的替身：与 openHistory 返回的对象同形，但什么都存不进去。
 * 读的返回空（界面按"没有记录"画）；写的只记一条警告，不抛——划词是直接 history.add 的（src/app/main.mjs），
 * 抛出去会把那条路带崩。坏库期间丢掉的记录，由历史页上带着原因的那条提示告知用户。
 */
function unavailableHistory({ log }) {
  const skipped = (op, audioId = null) => log.warn("history_write_skipped", { op, audio_id: audioId ?? null });
  return {
    add({ id } = {}) {
      skipped("add", id);
    },
    addCall({ audioId } = {}) {
      skipped("addCall", audioId);
    },
    list() {
      return [];
    },
    stats() {
      return emptyStats();
    },
    dictations() {
      return [];
    },
    usage() {
      return emptyUsage();
    },
    usageOverTime() {
      return [];
    },
    close() {
      skipped("close");
    },
  };
}

/**
 * 打开 App 用的历史库：打不开也不抛，返回替身和原因。
 * @param {string} dbPath
 * @param {{ log: { error: Function, warn: Function } }} options
 * @returns {{ history: object, problem: Error | null }} problem 是打开失败的原因，正常时是 null
 */
export function openHistoryForApp(dbPath, { log }) {
  try {
    return { history: openHistory(dbPath), problem: null };
  } catch (error) {
    log.error("history_open_failed", { file: dbPath, error: error?.message ?? String(error) });
    return { history: unavailableHistory({ log }), problem: error };
  }
}
