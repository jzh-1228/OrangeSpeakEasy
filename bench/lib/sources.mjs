import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DECODERS } from "../../src/server/audio/transcode.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";
import { languageOf } from "./text.mjs";

// 样本从哪来。每个来源一项：
//   list()   它有哪些录音，统一成 { sourceId, path, durationSec, text, lang }（text 是来源自带的成品，用来定语言）
//   plan     怎么抽（dataset.mjs 的 stratify），null 是全要
//   audioTo  录音可以发给哪几家云端模型（参照要把录音发给 Gemini）
// 录音是什么格式不由来源说，清洗时按文件头认（transcode.mjs 的 audioTypeOf），统一解成 16 kHz 单声道。
// 加一个来源（比如公开数据集）= 在这里加一项。

/** 评测能解的格式：程序自己的那份（WebM）加上原版的 Ogg。拆 Ogg 的库是 LGPL，只在开发时用，不随程序分发 */
export const BENCH_DECODERS = new Map([...DECODERS, ["audio/ogg", () => import("@audio/decode-opus")]]);

/** 打上语言、丢掉认不出语言的（只有数字和标点） */
const withLanguage = (items) =>
  items.map((item) => ({ ...item, lang: languageOf(item.text) })).filter((item) => item.lang !== null);

/** 中文、中英夹杂各按时长分四层；纯英文太少（2916 条里 8 条），有多少要多少 */
const BY_DURATION = [
  [0, 5, 6],
  [5, 15, 12],
  [15, 40, 14],
  [40, Number.POSITIVE_INFINITY, 8],
];
const TYPELESS_PLAN = [
  ...["zh", "mixed"].flatMap((lang) => BY_DURATION.map(([minSec, maxSec, count]) => ({ lang, minSec, maxSec, count }))),
  { lang: "en", minSec: 0, maxSec: Number.POSITIVE_INFINITY, count: 20 },
];

export const SOURCES = Object.freeze([
  Object.freeze({
    id: "typeless",
    /** 清单里样本 id 的前缀 */
    prefix: "tl",
    plan: TYPELESS_PLAN,
    // 作者 2026-10-13 定的：原版的录音只发给 Gemini
    audioTo: ["gemini"],
    list() {
      const path = join(homedir(), "Library/Application Support/Typeless/typeless.db");
      if (!existsSync(path)) return [];
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT id AS sourceId, audio_local_path AS path, duration AS durationSec, refined_text AS text
               FROM history_v2
              WHERE status = 'completed' AND mode = 'voice_transcript' AND refined_text <> ''
                AND audio_local_path IS NOT NULL`,
          )
          .all();
        return withLanguage(rows.filter((row) => existsSync(row.path)));
      } finally {
        db.close();
      }
    },
  }),
  Object.freeze({
    id: "orangespeakeasy",
    prefix: "sm",
    plan: null,
    audioTo: ["gemini", "openai"],
    list() {
      const { historyDb } = resolvePaths();
      if (!existsSync(historyDb)) return [];
      const db = new DatabaseSync(historyDb, { readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT id AS sourceId, audio_local_path AS path, duration AS durationSec, refined_text AS text
               FROM history
              WHERE status = 'completed' AND refined_text <> '' AND audio_local_path IS NOT NULL`,
          )
          .all();
        return withLanguage(rows.filter((row) => existsSync(row.path)));
      } finally {
        db.close();
      }
    },
  }),
]);

/** @returns {(typeof SOURCES)[number] | null} */
export function findSource(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}
