import { join } from "node:path";
import { noPositionals, parse, positiveInteger, renderOptions } from "../common.mjs";
import { renderHistory } from "../render/history.mjs";

// orangespeakeasy history：按天分组看说过的话。历史库直接只读打开，不经过后台应用。

export const DEFAULT_HISTORY_LIMIT = 20;

export async function history(args, io) {
  const { values, positionals } = parse(args, {
    limit: { type: "string", short: "n" },
    json: { type: "boolean", default: false },
  });
  noPositionals(positionals, "history");
  const limit = values.limit === undefined ? DEFAULT_HISTORY_LIMIT : positiveInteger(values.limit, "-n");

  let rows = [];
  let total = 0;
  const db = io.openHistory(io.paths.historyDb, { readOnly: true });
  if (db !== null) {
    try {
      // 历史里只记录音的文件名，给人看、给程序读的都是完整路径：按现在的录音目录拼
      rows = db.list({ limit }).map(({ audioFile, ...row }) => ({
        ...row,
        audioLocalPath: audioFile === null ? null : join(io.paths.recordingsDir, audioFile),
      }));
      total = db.stats().entries;
    } finally {
      db.close();
    }
  }
  io.out(values.json ? JSON.stringify(rows) : renderHistory({ rows, total }, renderOptions(io)));
  return 0;
}
