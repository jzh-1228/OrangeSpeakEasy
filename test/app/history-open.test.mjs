import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { openHistoryForApp } from "../../src/app/history-open.mjs";
import { usageReport } from "../../src/usage/report.mjs";

// App 打开历史库的那一层：文件坏了、版本比程序新时不能把整个 App 带下去。
// 读的地方看到空的，写的地方不抛、每次记一条警告，原因交给历史页显示。

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-history-open-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 假 log：记下主进程会写的那几行（src/log.mjs 的形状：event 加当时的上下文） */
function fakeLog() {
  const lines = [];
  return {
    lines,
    error: (event, fields = {}) => lines.push({ level: "error", event, ...fields }),
    warn: (event, fields = {}) => lines.push({ level: "warn", event, ...fields }),
  };
}

/** 跳过写入的那几条警告，只看是哪一次、哪个录音 */
const skippedWrites = (log) =>
  log.lines
    .filter((line) => line.event === "history_write_skipped")
    .map(({ level, op, audio_id }) => ({ level, op, audio_id }));

const entry = {
  id: "a1",
  status: "completed",
  refinedText: "我们后天开会。",
  error: null,
  duration: 4.2,
  audioFile: null,
  createdAt: "2026-10-25T08:00:00.000Z",
};

test("正常的库：照常返回历史对象，没有 problem，也不写日志", () => {
  const log = fakeLog();
  const { history, problem } = openHistoryForApp(join(dir, "history.db"), { log });
  assert.equal(problem, null);
  history.add(entry);
  assert.deepEqual(
    history.list().map(({ id }) => id),
    ["a1"],
  );
  history.close();
  assert.deepEqual(log.lines, []);
});

test("版本比程序新的库：返回替身和原因，读的是空的，写只记警告不抛", () => {
  const path = join(dir, "history.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();

  const log = fakeLog();
  const { history, problem } = openHistoryForApp(path, { log });
  assert.ok(problem instanceof Error);
  assert.match(problem.message, /version 99, newer/);
  assert.deepEqual(
    log.lines.find(({ event }) => event === "history_open_failed"),
    { level: "error", event: "history_open_failed", file: path, error: problem.message },
  );

  // 读的都是空的，形状和真的对象一样（src/storage/history.mjs）
  assert.deepEqual(history.list(), []);
  assert.deepEqual(history.stats(), {
    entries: 0,
    dictations: 0,
    characters: 0,
    seconds: 0,
    failed: 0,
    costUsd: 0,
    unpricedCalls: 0,
  });
  assert.deepEqual(history.dictations(), []);
  assert.deepEqual(history.usage(), {
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
  assert.deepEqual(history.usageOverTime({ unit: "day" }), []);

  // 写的不抛：划词那条路（src/app/main.mjs）直接 history.add，抛出去会把划词带崩
  assert.doesNotThrow(() => history.add(entry));
  assert.doesNotThrow(() =>
    history.addCall({
      purpose: "dictation",
      audioId: "a1",
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 100,
      audioTokens: 0,
      cachedTokens: 0,
      outputTokens: 20,
      thinkingTokens: 0,
      costUsd: 0.01,
      latencyMs: 800,
      createdAt: "2026-10-25T08:00:01.000Z",
    }),
  );
  assert.deepEqual(skippedWrites(log), [
    { level: "warn", op: "add", audio_id: "a1" },
    { level: "warn", op: "addCall", audio_id: "a1" },
  ]);
  assert.doesNotThrow(() => history.close());
});

test("坏掉的库（随机字节）：同样返回原因，写入不抛、每次记一条警告", () => {
  const path = join(dir, "history.db");
  writeFileSync(path, "这不是一个 SQLite 文件");

  const log = fakeLog();
  const { history, problem } = openHistoryForApp(path, { log });
  assert.ok(problem instanceof Error);
  assert.match(problem.message, /file is not a database/);
  assert.equal(log.lines.filter(({ event }) => event === "history_open_failed").length, 1);
  // 文件原样留着：绝不自动删除或改写用户的库
  assert.deepEqual(history.list(), []);
  assert.doesNotThrow(() => history.add(entry));
  assert.doesNotThrow(() =>
    history.addCall({
      purpose: "dictation",
      audioId: "a1",
      provider: "gemini",
      model: "gemini-2.5-flash",
      inputTokens: 100,
      audioTokens: 0,
      cachedTokens: 0,
      outputTokens: 20,
      thinkingTokens: 0,
      costUsd: 0.01,
      latencyMs: 800,
      createdAt: "2026-10-25T08:00:01.000Z",
    }),
  );
  assert.deepEqual(skippedWrites(log), [
    { level: "warn", op: "add", audio_id: "a1" },
    { level: "warn", op: "addCall", audio_id: "a1" },
  ]);
});

test("打不开时的替身能跑完用量报表：today/month/total 都是 0，不抛", () => {
  const path = join(dir, "history.db");
  writeFileSync(path, "坏掉的库");
  const { history } = openHistoryForApp(path, { log: fakeLog() });

  const report = usageReport(history, { now: new Date("2026-10-25T08:00:00.000Z") });
  for (const period of [report.today, report.month, report.total]) {
    assert.equal(period.calls, 0);
    assert.equal(period.dictations, 0);
    assert.equal(period.costUsd, 0);
    assert.equal(period.tokens, 0);
    assert.equal(period.latency, null);
    assert.deepEqual(period.models, []);
    assert.ok(Array.isArray(period.series.buckets));
  }
  assert.deepEqual(report.models, []);
});
