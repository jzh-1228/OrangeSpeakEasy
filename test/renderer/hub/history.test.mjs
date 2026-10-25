import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePage } from "../../../src/renderer/hub/history.mjs";

// 历史页"加载更多"只做数据合并（画在页面上的样子在真窗口里看）：新一页接在已经有的后面。

const row = (id) => ({ id, refinedText: id });

test("翻页合并：接在已经有的后面，total 按这一页一起取回的；不改传进来的那个数组", () => {
  const latest = [row("e"), row("d")];
  const merged = mergePage(latest, { rows: [row("c"), row("b")], total: 4 });
  assert.deepEqual(
    merged.rows.map(({ id }) => id),
    ["e", "d", "c", "b"],
  );
  assert.equal(merged.total, 4);
  assert.deepEqual(
    latest.map(({ id }) => id),
    ["e", "d"],
  );
});

test("翻页合并：两次翻页之间来了新记录、又出现在返回的一页里，按 id 去掉重复的", () => {
  const merged = mergePage([row("e"), row("d")], { rows: [row("d"), row("c")], total: 5 });
  assert.deepEqual(
    merged.rows.map(({ id }) => id),
    ["e", "d", "c"],
  );
  assert.equal(merged.total, 5);
});

test("翻页合并：到底了再取一页（空的），已有的记录一条不少", () => {
  const latest = [row("b"), row("a")];
  const merged = mergePage(latest, { rows: [], total: 2 });
  assert.deepEqual(
    merged.rows.map(({ id }) => id),
    ["b", "a"],
  );
  assert.equal(merged.total, 2);
});
