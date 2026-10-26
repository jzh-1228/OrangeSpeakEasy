import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHistory } from "../../../src/cli/render/history.mjs";
import { english, plain } from "./fixtures.mjs";

const row = (overrides) => ({
  id: "a",
  status: "completed",
  refinedText: "一句话",
  error: null,
  duration: 3,
  audioLocalPath: "/data/Recordings/a.webm",
  createdAt: "2026-10-13T06:32:00.000Z",
  ...overrides,
});

test("历史按天分组，新的在前，今天和昨天有名字，每条是时间加文字", () => {
  const rows = [
    row({ id: "c", createdAt: "2026-10-13T06:32:00.000Z", refinedText: "今天下午说的" }),
    row({ id: "b", createdAt: "2026-10-12T01:05:00.000Z", refinedText: "昨天早上说的" }),
    row({ id: "a", createdAt: "2026-10-08T12:00:00.000Z", refinedText: "上周说的" }),
  ];
  const text = renderHistory({ rows, total: 3 }, plain);
  assert.deepEqual(
    text.split("\n").filter((line) => line.trim() !== ""),
    [
      "今天 · 10月13日",
      "  14:32  今天下午说的",
      "昨天 · 10月12日",
      "  09:05  昨天早上说的",
      "10月8日周四",
      "  20:00  上周说的",
    ],
  );
  // 英文：日期和星期照英文的写法
  assert.deepEqual(
    renderHistory({ rows, total: 3 }, english)
      .split("\n")
      .filter((line) => /^\S/.test(line)),
    ["Today · October 13", "Yesterday · October 12", "Thu, October 8"],
  );
});

test("不是今年的带上年份", () => {
  const rows = [row({ createdAt: "2025-10-08T12:00:00.000Z" })];
  assert.match(renderHistory({ rows, total: 1 }, plain), /^2025年10月8日周三$/m);
  assert.match(renderHistory({ rows, total: 1 }, english), /^Wed, October 8, 2025$/m);
});

test("按本地日期分组：UTC 还在前一天、本地已经过了零点的，算本地那一天", () => {
  const rows = [row({ createdAt: "2026-10-12T16:30:00.000Z" })];
  assert.match(renderHistory({ rows, total: 1 }, plain), /今天 · 10月13日\n {2}00:30/);
});

test("多段的文字后面几行缩进对齐，段落之间的空行留着", () => {
  const rows = [row({ refinedText: "第一段\n\n第二段\n1. 一\n2. 二" })];
  const lines = renderHistory({ rows, total: 1 }, plain).split("\n");
  assert.deepEqual(lines.slice(1, 6), ["  14:32  第一段", "", "         第二段", "         1. 一", "         2. 二"]);
});

test("翻译的那条正文是译文，下面一行淡色写功能、目标语言和原文，多行的原文续行对齐", () => {
  const rows = [
    row({
      kind: "translate",
      refinedText: "Let's meet the day after tomorrow.",
      sourceText: "我们后天下午开会。\n\n别迟到。",
      outputLanguage: "en",
    }),
  ];
  assert.deepEqual(renderHistory({ rows, total: 1 }, plain).split("\n").slice(1, 5), [
    "  14:32  Let's meet the day after tomorrow.",
    "         语音翻译 · 英文：我们后天下午开会。",
    "",
    "         别迟到。",
  ]);
  assert.match(renderHistory({ rows, total: 1 }, english), /^ {9}Voice translation · English: 我们后天下午开会。$/m);
  // 语音输入的那条（没有目标语言）只有正文
  assert.equal(
    renderHistory({ rows: [row({ kind: "dictate", sourceText: null })], total: 1 }, plain).split("\n")[2],
    "",
  );
});

test("翻译失败的那条也写上是译成哪种的，原文没有就不写", () => {
  const rows = [
    row({
      kind: "translate",
      status: "failed",
      refinedText: "",
      error: "超时",
      sourceText: null,
      outputLanguage: "ja",
    }),
  ];
  const text = renderHistory({ rows, total: 1 }, plain);
  assert.match(text, /✗ 没有成功：超时/);
  assert.match(text, /^ {9}语音翻译 · 日文$/m);
});

test("失败的那条说明原因，并指出录音还留着", () => {
  const rows = [row({ status: "failed", refinedText: "", error: "连不上 Gemini", duration: 7.2 })];
  const text = renderHistory({ rows, total: 1 }, plain);
  assert.match(text, /14:32 {2}✗ 没有成功：连不上 Gemini/);
  assert.match(text, /录音 7\.2 秒，留在 \/data\/Recordings\/a\.webm/);
});

test("没显示完时在最后说共有多少条、怎么看更多", () => {
  const text = renderHistory({ rows: [row()], total: 57 }, plain);
  assert.match(text, /显示最近 1 条，共 57 条/);
  assert.match(text, /orangespeakeasy history -n 57/);
  assert.doesNotMatch(renderHistory({ rows: [row()], total: 1 }, plain), /共 1 条/);
});

test("一条都没有时说一句怎么开始", () => {
  assert.match(renderHistory({ rows: [], total: 0 }, plain), /还没有听写记录/);
});
