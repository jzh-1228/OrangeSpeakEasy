import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 洗好的数据集：<评测目录>/_work/datasets/<名字>/ 下一个 manifest.jsonl 和 clips/*.wav。
// 每条样本都已经是统一格式（16 kHz 单声道 16 位 WAV，src/server/audio/pcm.mjs），各个候选读的是同一份。
// 清单一行一条：{ id, source, sourceId, lang, durationSec, sha256, file, sourceText }。
// sourceText 是来源自带的成品（原版或 OrangeSpeakEasy 当时整理出的字），只用来定语言；评测的参照另外现跑。

export const WORK_DIR = join(import.meta.dirname, "..", "_work");
export const datasetDir = (name) => join(WORK_DIR, "datasets", name);

export function readManifest(name) {
  const text = readFileSync(join(datasetDir(name), "manifest.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function writeManifest(name, clips) {
  mkdirSync(datasetDir(name), { recursive: true });
  writeFileSync(join(datasetDir(name), "manifest.jsonl"), clips.map((clip) => `${JSON.stringify(clip)}\n`).join(""));
}

/**
 * 分层抽样：plan 的每一层是 { lang, minSec, maxSec, count }，在这一层里按 sourceId 排序取前 count 条。
 * 来源的 id 是随机的（UUID），排序取前几条就是一份固定的随机样本，重跑抽到同一批。plan 是 null 时全要。
 */
export function stratify(items, plan) {
  if (plan === null) return items;
  const ordered = [...items].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return plan.flatMap(({ lang, minSec, maxSec, count }) =>
    ordered
      .filter((item) => item.lang === lang && item.durationSec >= minSec && item.durationSec < maxSec)
      .slice(0, count),
  );
}

/** 这次评测哪些样本：ids 指名的、langs 里的语言、前 limit 条。都不给就是全部 */
export function select(clips, { ids, langs, limit } = {}) {
  let chosen = clips;
  if (ids) chosen = chosen.filter((clip) => ids.includes(clip.id));
  if (langs) chosen = chosen.filter((clip) => langs.includes(clip.lang));
  return limit === undefined ? chosen : chosen.slice(0, limit);
}

/** 报告里按时长分段看耗时：长录音的耗时才是本地模型的难处 */
export function durationBucket(seconds) {
  if (seconds < 5) return "0-5s";
  if (seconds < 15) return "5-15s";
  if (seconds < 40) return "15-40s";
  return "40s+";
}
