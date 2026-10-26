#!/usr/bin/env node
// 拿真实录音试语音翻译的提示词：和 eval-prompt.mjs 用同一批录音（清单 targets/typeless/_work/prompt-eval/samples.json），
// 按现在的翻译任务（src/server/tasks/translate）跑一遍，看格式守不守得住、译文排得对不对、等多久。
// 没有现成的参照译文（Typeless 的翻译只用过几次），好坏由人看 compare.md 判断；终端上只打印统计数字，不打印文字。
//
// 用法：走哪条链路、用哪个模型和服务端一样由环境变量定（src/server/config.mjs），key 经 with-key.sh 喂进来：
//   scripts/dev/with-key.sh gemini node scripts/dev/eval-translate.mjs --label <名字> --to en [--limit 20]
//   ORANGESPEAKEASY_MODE=local scripts/dev/with-key.sh deepseek node scripts/dev/eval-translate.mjs --label <名字> --to ja
// 混合方式用 eval-prompt.mjs 存下的本机转写（transcripts.<模型>.json），没有的先跑一遍 eval-prompt.mjs 的混合方式。
// --limit 只跑一部分：按录音时长从短到长等距挑，长短都有。
// 结果和对照表里有说话的原文，放在 git 之外：targets/typeless/_work/translate-eval/。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { mapWithLimit } from "../../bench/lib/concurrency.mjs";
import { findLanguage } from "../../src/languages.mjs";
import { loadConfig } from "../../src/server/config.mjs";
import { describeRoute } from "../../src/server/modes.mjs";
import { createChatPolisher } from "../../src/server/refine/polisher.mjs";
import { createModelRefiner } from "../../src/server/refine/refiner.mjs";
import { findTask } from "../../src/server/tasks/index.mjs";

const WORK = resolve(import.meta.dirname, "../../targets/typeless/_work");
const QUIET = { info() {}, warn() {}, error() {} };
const LIST_ITEM = /^\s*\d+\.\s/;
const HAN = /[一-鿿]/g;

const { values: args } = parseArgs({
  options: {
    label: { type: "string" },
    to: { type: "string", default: "en" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "report-only": { type: "boolean", default: false },
  },
});
const language = findLanguage(args.to);
if (!args.label || !/^[\w.-]+$/.test(args.label) || language === null) {
  console.error("用法：node scripts/dev/eval-translate.mjs --label <名字> --to <语言，en / ja / …> [--limit 20]");
  process.exit(2);
}

const all = JSON.parse(readFileSync(join(WORK, "prompt-eval/samples.json"), "utf8"));
const samples = pick(all, args.limit ? Number(args.limit) : all.length);
const out = join(WORK, "translate-eval");
if (args["report-only"]) {
  // 不调模型，拿这个标签上次的结果重新出一遍统计
  report(samples, JSON.parse(readFileSync(join(out, `${args.label}.json`), "utf8")));
  process.exit(0);
}
const task = findTask("translate").bind({ output_language: language.id });
const config = loadConfig(process.env);
const runner = config.route.mode === "local" ? await localRunner(config) : await nativeRunner(config);
console.log(`样本 ${samples.length} 条，${describeRoute(config.route)}，译成 ${language.id}，标签 ${args.label}`);

await runner.warmUp();
const results = await mapWithLimit(samples, Number(args.concurrency), async (sample) => {
  const startedAt = performance.now();
  const calls = [];
  try {
    const out = await runner.run(sample, (call) => calls.push(call));
    return { id: sample.id, ms: Math.round(performance.now() - startedAt), calls, ...out };
  } catch (error) {
    return { id: sample.id, ms: Math.round(performance.now() - startedAt), error: String(error?.message ?? error) };
  }
});

mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${args.label}.json`), JSON.stringify(results, null, 2));
writeFileSync(join(out, `${args.label}.compare.md`), sideBySide(samples, results));
report(samples, results);
console.log(`对照表：${join(out, `${args.label}.compare.md`)}`);

/** 按时长排好，等距挑 count 条 */
function pick(list, count) {
  const sorted = [...list].sort((a, b) => a.duration - b.duration);
  if (count >= sorted.length) return sorted;
  return Array.from({ length: count }, (_, i) => sorted[Math.floor((i * sorted.length) / count)]);
}

async function nativeRunner({ route, apiKey }) {
  let onCall = () => {};
  const refiner = await createModelRefiner({
    choice: route.model,
    apiKey,
    thinkingLevel: route.thinkingLevel,
    log: QUIET,
    onCall: (call) => onCall(call),
  });
  return {
    warmUp: () => refiner.warmUp(),
    async run(sample, record) {
      onCall = record;
      return refiner.refine(readFileSync(sample.audioPath), { task, mimeType: "audio/ogg" });
    },
  };
}

async function localRunner({ route, apiKey }) {
  const cachePath = join(WORK, `prompt-eval/transcripts.${route.transcriber}.json`);
  if (!existsSync(cachePath)) {
    console.error(`没有 ${cachePath}：先用 ORANGESPEAKEASY_MODE=local 跑一遍 eval-prompt.mjs，把本机转写存下来`);
    process.exit(2);
  }
  const transcripts = JSON.parse(readFileSync(cachePath, "utf8"));
  let onCall = () => {};
  const polisher = await createChatPolisher({
    choice: route.polish,
    customUrl: route.customUrl,
    apiKey,
    log: QUIET,
    onCall: (call) => onCall(call),
  });
  return {
    warmUp: () => polisher.warmUp(),
    async run(sample, record) {
      onCall = record;
      const transcript = transcripts[sample.id] ?? "";
      return { transcript, ...(await polisher.polish(transcript, { task })) };
    },
  };
}

/** 一段字的排版：几段、几个列表项 */
function layoutOf(text) {
  return {
    paragraphs: text.split(/\n\s*\n/).filter((part) => part.trim()).length,
    items: text.split("\n").filter((line) => LIST_ITEM.test(line)).length,
  };
}

function report(list, results) {
  const done = results.filter((result) => !result.error);
  const failed = results.length - done.length;
  const noSource = done.filter((result) => result.source === null && result.text !== "").length;
  const empty = done.filter((result) => result.text === "").length;
  // 译成不是中文的语言时，译文里还留着汉字的（专有名词照留的除外，数一下比例）
  const leftHan =
    language.id.startsWith("zh") || language.id === "ja"
      ? null
      : done.filter((result) => (result.text.match(HAN) ?? []).length > 3).length;
  // 原版成品分了段、分了点的，译文有没有跟着分
  let listsKept = 0;
  let listsTotal = 0;
  let paragraphsKept = 0;
  let paragraphsTotal = 0;
  for (const result of done) {
    const reference = layoutOf(list.find((sample) => sample.id === result.id).reference);
    const translated = layoutOf(result.text);
    if (reference.items >= 2) {
      listsTotal++;
      if (translated.items >= 2) listsKept++;
    }
    if (reference.paragraphs >= 2) {
      paragraphsTotal++;
      if (translated.paragraphs >= 2) paragraphsKept++;
    }
  }
  const ms = done.map((result) => result.ms).sort((a, b) => a - b);
  const output = done.map((result) => result.calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0));
  const cost = done.reduce((sum, result) => sum + result.calls.reduce((s, call) => s + (call.costUsd ?? 0), 0), 0);
  console.log(`失败 ${failed} 条；空的 ${empty} 条；没写出原文 ${noSource} 条`);
  if (leftHan !== null) console.log(`译文里还留着成段汉字的 ${leftHan} 条`);
  console.log(
    `原版分了点的 ${listsTotal} 条里译文也分点 ${listsKept} 条；分了段的 ${paragraphsTotal} 条里也分段 ${paragraphsKept} 条`,
  );
  console.log(
    `耗时中位 ${ms[Math.floor(ms.length / 2)]} ms，最慢 ${ms.at(-1)} ms；输出 token 中位 ${output.sort((a, b) => a - b)[Math.floor(output.length / 2)]}；共 $${cost.toFixed(4)}`,
  );
}

function sideBySide(list, results) {
  const blocks = results.map((result) => {
    const sample = list.find((each) => each.id === result.id);
    const head = `## ${result.id.slice(0, 8)} · ${sample.duration.toFixed(1)} 秒 · ${result.ms} ms`;
    if (result.error) return `${head}\n\n出错：${result.error}`;
    return [
      head,
      ...(result.transcript === undefined ? [] : ["**识别结果**", result.transcript]),
      "**原版的听写成品**",
      sample.reference,
      "**原文**",
      result.source ?? "（没有）",
      "**译文**",
      result.text,
    ].join("\n\n");
  });
  return `${blocks.join("\n\n---\n\n")}\n`;
}
