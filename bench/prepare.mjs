#!/usr/bin/env node
// 清洗：把各来源的录音抽样、统一成 16 kHz 单声道 16 位 WAV，写进 _work/datasets/<名字>/。
// 之后每个候选（云端的参照、本地的各个模型）读的都是这同一份，输入一致，比出来的差别才只是模型的差别。
//
// 用法：node bench/prepare.mjs [--dataset default] [--sources typeless,orangespeakeasy]
//
// 洗的时候丢掉的样本都会按原因数出来，不悄悄少几条：解不出来、解出来的时长和来源记的对不上、太短、没有声音。
// 重跑时已经洗好的直接用，只补新抽到的。终端上只打印统计数字，不打印说的话。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isSilent } from "../src/server/asr/segment.mjs";
import { encodeWav, SPEECH_SAMPLE_RATE } from "../src/server/audio/pcm.mjs";
import { audioTypeOf, toSpeech } from "../src/server/audio/transcode.mjs";
import { datasetDir, durationBucket, readManifest, stratify, writeManifest } from "./lib/dataset.mjs";
import { BENCH_DECODERS, findSource, SOURCES } from "./lib/sources.mjs";

/** 解出来的时长和来源记的差多少算对不上：链式 Ogg 只解出第一段这类问题会在这里露出来 */
const DURATION_TOLERANCE = (seconds) => Math.max(0.5, seconds * 0.03);
const MIN_SECONDS = 0.5;

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: "default" },
    sources: { type: "string", default: SOURCES.map((source) => source.id).join(",") },
  },
});
const sources = args.sources.split(",").map((id) => findSource(id) ?? fail(`不认识的来源：${id}`));
const dir = datasetDir(args.dataset);
mkdirSync(join(dir, "clips"), { recursive: true });
const previous = new Map(
  existsSync(join(dir, "manifest.jsonl")) ? readManifest(args.dataset).map((clip) => [clip.id, clip]) : [],
);

const clips = [];
const dropped = new Map();
const drop = (reason) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);

for (const source of sources) {
  const picked = stratify(source.list(), source.plan);
  console.log(`${source.id}：抽到 ${picked.length} 条`);
  for (const item of picked) {
    const id = `${source.prefix}-${item.sourceId.replaceAll("-", "").slice(0, 12)}`;
    const file = `clips/${id}.wav`;
    const known = previous.get(id);
    if (known && existsSync(join(dir, file))) {
      clips.push(known);
      continue;
    }
    const clip = await clean(item);
    if (typeof clip === "string") {
      drop(clip);
      continue;
    }
    writeFileSync(join(dir, file), clip.wav);
    clips.push({
      id,
      source: source.id,
      sourceId: item.sourceId,
      lang: item.lang,
      durationSec: clip.durationSec,
      sha256: createHash("sha256").update(clip.wav).digest("hex"),
      file,
      sourceText: item.text,
    });
  }
}

writeManifest(args.dataset, clips);
summarize(clips, dropped);

/** 一条录音 → 统一格式；不能用的返回丢掉的原因 */
async function clean(item) {
  const audio = readFileSync(item.path);
  const mimeType = audioTypeOf(audio);
  if (!mimeType) return "认不出格式";
  let samples;
  try {
    samples = await toSpeech(audio, mimeType, BENCH_DECODERS);
  } catch (error) {
    console.error(`解不出来：${item.sourceId}（${mimeType}）：${error.message}`);
    return "解不出来";
  }
  const durationSec = samples.length / SPEECH_SAMPLE_RATE;
  if (Math.abs(durationSec - item.durationSec) > DURATION_TOLERANCE(item.durationSec)) {
    console.error(
      `时长对不上：${item.sourceId} 解出 ${durationSec.toFixed(1)} 秒，记的是 ${item.durationSec.toFixed(1)} 秒`,
    );
    return "时长对不上";
  }
  if (durationSec < MIN_SECONDS) return "太短";
  if (isSilent(samples)) return "没有声音";
  return { wav: encodeWav(samples, SPEECH_SAMPLE_RATE), durationSec: Math.round(durationSec * 100) / 100 };
}

function summarize(clips, dropped) {
  const count = (key) => {
    const table = new Map();
    for (const clip of clips) table.set(key(clip), (table.get(key(clip)) ?? 0) + 1);
    return [...table].map(([name, n]) => `${name} ${n}`).join("、");
  };
  const minutes = clips.reduce((sum, clip) => sum + clip.durationSec, 0) / 60;
  console.log(`数据集 ${args.dataset}：${clips.length} 条，共 ${minutes.toFixed(1)} 分钟（${dir}）`);
  console.log(`  来源：${count((clip) => clip.source)}`);
  console.log(`  语言：${count((clip) => clip.lang)}`);
  console.log(`  时长：${count((clip) => durationBucket(clip.durationSec))}`);
  if (dropped.size > 0) console.log(`  丢掉：${[...dropped].map(([reason, n]) => `${reason} ${n}`).join("、")}`);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
