#!/usr/bin/env node
// 拿 Typeless 历史里的真实录音评估提示词：同一批录音用当前的提示词跑一遍，
// 和原版当时给出的成品比排版（分没分段、用没用列表、长短、文字出入），并数出明显的异常。
// 改提示词前后各跑一次，用 --label 区分，两次的数字就能直接对比。
//
// 用法：评哪条链路、用哪个模型和服务端一样由环境变量定（src/server/config.mjs），key 经 with-key.sh 喂进来：
//   scripts/dev/with-key.sh gemini node scripts/dev/eval-prompt.mjs --label <名字> [--out <目录>] [--concurrency 4]
//   ORANGESPEAKEASY_MODE=local scripts/dev/with-key.sh deepseek node scripts/dev/eval-prompt.mjs --label <名字>
// 原生链路只评估 Gemini：Typeless 的录音是 Ogg，服务端不把 Ogg 转给 OpenAI（见 src/server/audio/transcode.mjs），
// 作者也只同意这些录音发给 Gemini。OpenAI 的提示词边用边调。
// 本地转写链路评的是润色的提示词：录音只在本机转写，发给润色那一家的是转出来的文字（2026-10-16 作者同意）。
// 第一次运行会抽样，把清单写进 <目录>/samples.json，之后每次都用这同一批。
// 加 --report-only 时不调模型，只拿这个标签上次的结果重新出一遍统计。
// 本地转写链路可以加 --polish-prompt <文件>：用文件里的候选提示词润色，不用改源码，几个候选能同时跑。
//
// 清单和结果文件里有说话的原文，所以输出目录必须在 git 之外，
// 默认是 targets/typeless/_work/prompt-eval。终端上只打印统计数字，不打印文字。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { BENCH_DECODERS } from "../../bench/lib/sources.mjs";
import { startTranscriber } from "../../src/server/asr/start.mjs";
import { toSpeech } from "../../src/server/audio/transcode.mjs";
import { loadConfig } from "../../src/server/config.mjs";
import { describeRoute } from "../../src/server/modes.mjs";
import { createChatPolisher } from "../../src/server/refine/polisher.mjs";
import { createModelRefiner } from "../../src/server/refine/refiner.mjs";
import { polishPromptWith } from "../../src/server/tasks/dictate/polish-prompt.mjs";
import { findTask } from "../../src/server/tasks/index.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

/** 语音输入这件事（src/server/tasks）：评测、量时间都是拿它跑 */
const DICTATION = findTask("dictate").bind({});

const TYPELESS_DB = join(homedir(), "Library/Application Support/Typeless/typeless.db");
const QUIET = { info() {}, warn() {}, error() {} };
/** 按录音时长分层抽样：[下限秒, 上限秒, 抽几条]。长录音才会分段分点，所以往长的那头多抽 */
const SAMPLE_PLAN = [
  [0, 5, 4],
  [5, 10, 6],
  [10, 20, 12],
  [20, 40, 16],
  [40, 80, 14],
  [80, Number.POSITIVE_INFINITY, 8],
];
/** 原版的排版习惯按月在变（分段的比例从 46% 涨到 84%），只拿近期的当参照 */
const SAMPLE_SINCE = "2026-08";

const LIST_ITEM = /^\s*(\d+[.、)]|[-•*])\s/;
const END_MARK = /[。！？!?.…]$/;
/** 开头的一个外文词，后面紧跟中文或换行。模型偶尔会在成品前面多吐一个这样的词 */
const LEADING_FOREIGN_WORD = /^([A-Za-z_Ѐ-ӿ]+)[.\s]*(?=[一-鿿\n])/;
/** 只在繁体里出现的常用字，用来发现"简体的话被写成了繁体" */
const TRADITIONAL_ONLY =
  /[個這們來說為時會對過還進後開關當點體學實現經發問題種樣讓給從產業務員變萬與應該麼難聽寫話語買賣錢邊裡]/;

const quantile = (numbers, q) =>
  [...numbers].sort((a, b) => a - b)[Math.min(numbers.length - 1, Math.floor(numbers.length * q))];
const median = (numbers) => quantile(numbers, 0.5);
const fixed = (number, digits = 2) => number.toFixed(digits);

await main();

async function main() {
  const { values: args } = parseArgs({
    options: {
      label: { type: "string" },
      out: { type: "string", default: resolve(import.meta.dirname, "../../targets/typeless/_work/prompt-eval") },
      concurrency: { type: "string", default: "4" },
      "report-only": { type: "boolean", default: false },
      "polish-prompt": { type: "string" },
    },
  });
  const concurrency = Number(args.concurrency);
  if (!args.label || !/^[\w.-]+$/.test(args.label) || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error(
      "用法：node scripts/dev/eval-prompt.mjs --label <名字，只用字母数字和 . _ -> [--out <目录>] [--concurrency 4] [--report-only]",
    );
    process.exit(2);
  }

  mkdirSync(args.out, { recursive: true });
  const samples = loadOrPickSamples(join(args.out, "samples.json"));
  const resultsPath = join(args.out, `${args.label}.json`);

  let results;
  if (args["report-only"]) {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
    console.log(`样本 ${samples.length} 条，标签 ${args.label}（用上次的结果，没有调模型）`);
  } else {
    const config = loadConfig(process.env);
    const { route } = config;
    const thinking = route.mode === "native" && route.model.provider === "gemini" ? ` / ${route.thinkingLevel}` : "";
    console.log(`样本 ${samples.length} 条，${describeRoute(route)}${thinking}，标签 ${args.label}`);
    const promptFile = args["polish-prompt"];
    if (promptFile && route.mode !== "local") {
      console.error("--polish-prompt 只用在本地转写链路（ORANGESPEAKEASY_MODE=local）");
      process.exit(2);
    }
    const prompt = promptFile ? readFileSync(promptFile, "utf8").trim() : undefined;
    const runner =
      route.mode === "local" ? await localRunner(config, samples, args.out, prompt) : await nativeRunner(config);
    // 进程里的第一次请求要多花一两秒建连接，先发掉，免得算进第一条样本的耗时
    await runner.warmUp();
    results = await mapWithLimit(samples, concurrency, (sample) => runOne(runner, sample));
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    runner.summarize();
    writeFileSync(join(args.out, `${args.label}.compare.md`), sideBySide(samples, results));
  }

  report(samples, results);
  if (results.some((result) => result.error)) process.exitCode = 1;
}

// ---------- 抽样 ----------

function loadOrPickSamples(manifestPath) {
  if (existsSync(manifestPath)) return JSON.parse(readFileSync(manifestPath, "utf8"));

  const db = new DatabaseSync(TYPELESS_DB, { readOnly: true });
  // id 是随机的 UUID，按 id 排序取前几条就是一份固定的随机样本，重跑也抽到同一批
  const pick = db.prepare(
    `SELECT id, duration, audio_local_path AS audioPath, refined_text AS reference
       FROM history_v2
      WHERE status = 'completed' AND mode = 'voice_transcript' AND refined_text <> ''
        AND created_at >= ? AND duration >= ? AND duration < ?
      ORDER BY id LIMIT ?`,
  );
  const picked = SAMPLE_PLAN.flatMap(([from, to, count]) =>
    // SQLite 没有无穷大，上限用一个比任何录音都长的数
    pick.all(SAMPLE_SINCE, from, Number.isFinite(to) ? to : 1e9, count),
  ).filter((sample) => existsSync(sample.audioPath));
  db.close();

  writeFileSync(manifestPath, JSON.stringify(picked, null, 2));
  return picked;
}

// ---------- 跑模型 ----------

/** 原生链路：录音整个交给模型，识别和整理一次做完 */
async function nativeRunner({ route, apiKey }) {
  let retries = 0;
  const refiner = await createModelRefiner({
    choice: route.model,
    apiKey,
    thinkingLevel: route.thinkingLevel,
    log: { ...QUIET, warn: () => retries++ },
  });
  return {
    warmUp: () => refiner.warmUp(),
    run: async (sample) => ({
      text: (await refiner.refine(readFileSync(sample.audioPath), { task: DICTATION, mimeType: "audio/ogg" })).text,
    }),
    summarize: () => console.log(`因为成品写坏而重试：${retries} 次`),
  };
}

/**
 * 本地转写链路：每条录音只在本机转写一次，原文存进 <目录>/transcripts.<模型>.json，之后只调润色那一跳。
 * 这样改润色的提示词前后，比的是同一份原文，差别全在提示词上。耗时只算润色。prompt 不给就用源码里的
 */
async function localRunner({ route, apiKey }, samples, out, prompt) {
  const cachePath = join(out, `transcripts.${route.transcriber}.json`);
  const transcripts = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const missing = samples.filter((sample) => !(sample.id in transcripts));
  if (missing.length > 0) {
    const { modelsDir } = resolvePaths(process.env);
    const transcriber = await startTranscriber({ modelId: route.transcriber, modelsDir, log: QUIET });
    try {
      for (const sample of missing) {
        const speech = await toSpeech(readFileSync(sample.audioPath), "audio/ogg", BENCH_DECODERS);
        transcripts[sample.id] = (await transcriber.transcribe(speech)).text;
      }
    } finally {
      transcriber.dispose();
    }
    writeFileSync(cachePath, JSON.stringify(transcripts, null, 2));
    console.log(`本机转写了 ${missing.length} 条，原文存在 ${cachePath}，下次不再转`);
  }
  const polisher = await createChatPolisher({
    choice: route.polish,
    customUrl: route.customUrl,
    apiKey,
    log: QUIET,
  });
  // 候选的提示词换掉语音输入整理那一步的系统提示词，别的照旧
  const task = prompt
    ? { ...DICTATION, polish: { ...DICTATION.polish, system: (terms) => polishPromptWith(terms, prompt) } }
    : DICTATION;
  return {
    warmUp: () => polisher.warmUp(),
    run: async ({ id }) => ({
      transcript: transcripts[id],
      text: (await polisher.polish(transcripts[id], { task })).text,
    }),
    summarize: () => console.log("耗时只算润色那一跳"),
  };
}

async function runOne(runner, sample) {
  const startedAt = performance.now();
  try {
    const out = await runner.run(sample);
    return { id: sample.id, ms: Math.round(performance.now() - startedAt), ...out };
  } catch (error) {
    return { id: sample.id, ms: Math.round(performance.now() - startedAt), error: String(error?.message ?? error) };
  }
}

async function mapWithLimit(items, limit, task) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- 比较 ----------

/** 一段成品的排版特征 */
function layoutOf(text) {
  return {
    paragraphs: text.split(/\n\s*\n/).filter((part) => part.trim()).length,
    items: text.split("\n").filter((line) => LIST_ITEM.test(line)).length,
    chars: text.replace(/\s/g, "").length,
    endsWithMark: END_MARK.test(text.trim()),
  };
}

/** 去掉标点和空白之后的文字有多像：1 是一字不差，0 是完全不同 */
function similarity(a, b) {
  const strip = (text) => text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
  const [x, y] = [strip(a), strip(b)];
  if (x.length === 0 && y.length === 0) return 1;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}

/** 一眼就能看出不对的成品：这些不是"写得不够好"，是坏了 */
function defectsOf(ours, reference) {
  const defects = [];
  const [oursChars, referenceChars] = [layoutOf(ours).chars, layoutOf(reference).chars];
  if (referenceChars >= 20 && oursChars < referenceChars / 2) defects.push("只出了一小截");
  const leading = ours.match(LEADING_FOREIGN_WORD)?.[1];
  // 原版里也有这个词就是他真说了（比如以"UI"开头的话），不算多出来的
  if (leading && !new RegExp(`\\b${leading}\\b`, "i").test(reference)) defects.push("开头多出外文词");
  if (/_{3,}/.test(ours)) defects.push("一串下划线");
  // 模型听音频时自带"几分几秒"的定位，偶尔会把它写进成品。他真说了几个钟点的话原版里也会有
  const timestamps = (text) => text.match(/\b\d{1,2}:\d{2}\b/g)?.length ?? 0;
  if (timestamps(ours) >= 3 && timestamps(reference) === 0) defects.push("夹着时间戳");
  if (TRADITIONAL_ONLY.test(ours) && !TRADITIONAL_ONLY.test(reference)) defects.push("写成了繁体");
  // 口吃没删掉：同一个字或词紧挨着重复三遍以上，或者虚词、代词这类几乎不会叠着用的单字重复两遍（"要要做""这里的的"）。
  // 原版里也这样的（"重做，重做，重做"）不算。"的的确确""是是非非"是正经叠词，不算
  const bareReference = reference.replace(/[\p{P}\s]/gu, "");
  const stutters = [
    ...ours.matchAll(/([一-鿿]{1,3})\1{2,}/gu),
    ...ours.matchAll(/([我你他她它这那要是的了就把被和也都还又会能有不没去给到很再才跟从])\1(?![确非])/gu),
  ];
  if (stutters.some(([repeated]) => !bareReference.includes(repeated))) defects.push("口吃没删");
  return defects;
}

function report(samples, results) {
  const failed = results.filter((result) => result.error);
  for (const failure of failed) console.log(`  失败 ${failure.id.slice(0, 8)}：${failure.error}`);

  const rows = samples
    .map((sample, index) => ({ sample, result: results[index] }))
    .filter(({ result }) => !result.error)
    .map(({ sample, result }) => ({
      id: sample.id,
      duration: sample.duration,
      ms: result.ms,
      ref: layoutOf(sample.reference),
      ours: layoutOf(result.text),
      similarity: similarity(sample.reference, result.text),
      defects: defectsOf(result.text, sample.reference),
    }));
  if (rows.length === 0) return;

  const count = (predicate) => rows.filter(predicate).length;
  const ms = rows.map((row) => row.ms);
  console.log(`成功 ${rows.length} 条，失败 ${failed.length} 条`);
  console.log(`耗时：中位 ${fixed(median(ms) / 1000, 1)} 秒，P90 ${fixed(quantile(ms, 0.9) / 1000, 1)} 秒`);

  const broken = rows.filter((row) => row.defects.length > 0);
  const byKind = Map.groupBy(
    broken.flatMap((row) => row.defects.map((defect) => ({ defect, id: row.id.slice(0, 8) }))),
    ({ defect }) => defect,
  );
  console.log(`坏掉的成品：${broken.length} 条`);
  for (const [kind, hits] of byKind) console.log(`  ${kind} ${hits.length} 条：${hits.map((hit) => hit.id).join(" ")}`);

  const refBroke = (row) => row.ref.paragraphs > 1;
  const oursBroke = (row) => row.ours.paragraphs > 1;
  console.log(
    `分段：原版分了 ${count(refBroke)} 条，其中我们也分了 ${count((row) => refBroke(row) && oursBroke(row))} 条；` +
      `原版没分 ${count((row) => !refBroke(row))} 条，其中我们分了 ${count((row) => !refBroke(row) && oursBroke(row))} 条`,
  );
  const refListed = (row) => row.ref.items > 0;
  const oursListed = (row) => row.ours.items > 0;
  console.log(
    `列表：原版用了 ${count(refListed)} 条，其中我们也用了 ${count((row) => refListed(row) && oursListed(row))} 条；` +
      `原版没用 ${count((row) => !refListed(row))} 条，其中我们用了 ${count((row) => !refListed(row) && oursListed(row))} 条`,
  );
  const refParagraphs = rows.map((row) => row.ref.paragraphs);
  const oursParagraphs = rows.map((row) => row.ours.paragraphs);
  const paragraphGap = rows.reduce((sum, row) => sum + Math.abs(row.ours.paragraphs - row.ref.paragraphs), 0);
  console.log(
    `段落数：原版中位 ${median(refParagraphs)}，我们中位 ${median(oursParagraphs)}，平均相差 ${fixed(paragraphGap / rows.length)}`,
  );
  const ratio = rows.filter((row) => row.ref.chars > 0).map((row) => row.ours.chars / row.ref.chars);
  console.log(
    `字数比（我们 ÷ 原版）：P10 ${fixed(quantile(ratio, 0.1))}，中位 ${fixed(median(ratio))}，P90 ${fixed(quantile(ratio, 0.9))}`,
  );
  const alike = rows.map((row) => row.similarity);
  console.log(`文字相似度（不算标点空白）：P10 ${fixed(quantile(alike, 0.1))}，中位 ${fixed(median(alike))}`);
  console.log(
    `结尾有标点：原版 ${count((row) => row.ref.endsWithMark)} 条，我们 ${count((row) => row.ours.endsWithMark)} 条；` +
      `输出为空 ${count((row) => row.ours.chars === 0)} 条`,
  );

  console.log("按时长（条数 | 原版分段 / 我们分段 | 原版列表 / 我们列表 | 相似度中位）");
  for (const [from, to] of SAMPLE_PLAN) {
    const bucket = rows.filter((row) => row.duration >= from && row.duration < to);
    if (bucket.length === 0) continue;
    const n = (predicate) => String(bucket.filter(predicate).length).padStart(2);
    const range = `${String(from).padStart(2)}–${Number.isFinite(to) ? String(to).padEnd(2) : "∞ "}`;
    console.log(
      `  ${range} 秒：${n(() => true)} | ${n(refBroke)} / ${n(oursBroke)} | ${n(refListed)} / ${n(oursListed)} | ` +
        fixed(median(bucket.map((row) => row.similarity))),
    );
  }
}

/** 逐条把原版和我们的成品排在一起，人工看差别用 */
function sideBySide(samples, results) {
  return samples
    .map((sample, index) => {
      const result = results[index];
      const ours = result.error ? `（失败：${result.error}）` : result.text || "（空）";
      // 本地转写链路把本机转出的原文也列上：成品哪里不对时，先分清是转写错了还是润色错了
      const transcript = result.transcript === undefined ? "" : `### 本机转写\n\n${result.transcript || "（空）"}\n\n`;
      return (
        `## ${sample.id.slice(0, 8)}  ${sample.duration.toFixed(1)} 秒  ${result.ms} ms\n\n` +
        `### 原版\n\n${sample.reference}\n\n${transcript}### 我们\n\n${ours}\n`
      );
    })
    .join("\n---\n\n");
}
