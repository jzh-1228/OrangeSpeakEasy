import assert from "node:assert/strict";
import { test } from "node:test";
import { createRevivePolicy } from "../../src/app/helper-revive.mjs";

test("第一次意外退出就重拉：等 1 秒", () => {
  const revive = createRevivePolicy();
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 1, delayMs: 1000 });
});

test("连续退出逐次翻倍：2、4、8、16 秒；超过 5 次不再重拉", () => {
  const revive = createRevivePolicy();
  revive.noteExit();
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 2, delayMs: 2000 });
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 3, delayMs: 4000 });
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 4, delayMs: 8000 });
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 5, delayMs: 16000 });
  assert.deepEqual(revive.noteExit(), { revive: false });
  // 超限之后又退了一次也不复活：等人工从设置里恢复
  assert.deepEqual(revive.noteExit(), { revive: false });
});

test("等待时长封顶在 30 秒，不再翻倍", () => {
  const revive = createRevivePolicy({ maxAttempts: 6 });
  for (let i = 0; i < 5; i += 1) revive.noteExit();
  // 不封顶会是 32000，压到上限 30000
  assert.deepEqual(revive.noteExit(), { revive: true, attempt: 6, delayMs: 30000 });
});

test("稳定运行过一阵再崩：算新故障，从 1 秒重新起算", () => {
  const revive = createRevivePolicy();
  for (let i = 0; i < 5; i += 1) revive.noteExit();
  assert.deepEqual(revive.noteExit(60_000), { revive: true, attempt: 1, delayMs: 1000 });
});

test("刚 ready 就崩不算跑稳：接着连崩计数翻倍，避免 1 秒一轮无限重拉", () => {
  const revive = createRevivePolicy();
  revive.noteExit();
  revive.noteExit();
  // 活了 3 秒就崩（不到 60 秒的稳定线）：不重置，按第 3 次算
  assert.deepEqual(revive.noteExit(3_000), { revive: true, attempt: 3, delayMs: 4000 });
});
