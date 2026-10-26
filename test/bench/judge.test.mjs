import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openResults } from "../../bench/lib/results.mjs";
import { judgeKey, KINDS, pendingJudgements, recordEmpty, recordJudgements } from "../../bench/lib/stages/judge.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempResults() {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-judge-"));
  dirs.push(dir);
  return openResults(join(dir, "results.db"));
}

const clip = (id) => ({ id, lang: "zh", durationSec: 3 });
const cell = (clipId, subject, reference, text) => ({
  clip: clip(clipId),
  subject,
  reference: { text: reference },
  text,
});

test("待判：按样本分组，一份参照下面列各个候选；转得一模一样的并成一项，只判一次", () => {
  const results = tempResults();
  const { groups, empty } = pendingJudgements(
    [
      cell("c1", "a", "我们后天开会", "我们后天开会"),
      cell("c1", "b", "我们后天开会", "我们后天开会"),
      cell("c1", "c", "我们后天开会", "我们明天开会"),
      cell("c2", "a", "好的", "好的"),
    ],
    results,
  );
  assert.deepEqual(empty, []);
  assert.deepEqual(
    groups.map((group) => [group.clip, group.reference, group.items.map((item) => [item.candidates, item.text])]),
    [
      [
        "c1",
        "我们后天开会",
        [
          [["a", "b"], "我们后天开会"],
          [["c"], "我们明天开会"],
        ],
      ],
      ["c2", "好的", [[["a"], "好的"]]],
    ],
  );
  assert.equal(groups[0].items[0].id, judgeKey("我们后天开会", "我们后天开会").slice(0, 12));
  results.close();
});

test("待判：判过的不再导出（--force 才重判）；空的转写不给判官看，直接记 0 分", () => {
  const results = tempResults();
  const cells = [cell("c1", "a", "好的", "好的"), cell("c1", "b", "好的", " ")];
  const first = pendingJudgements(cells, results);
  assert.equal(first.empty.length, 1);
  recordEmpty(results, first.empty);
  assert.deepEqual(results.get("judge", judgeKey("好的", " ")), {
    kind: "transcript",
    score: 0,
    problems: ["认不出"],
    note: "转写是空的",
    by: "rule",
  });
  recordJudgements(results, [{ id: first.groups[0].items[0].id, score: 5, problems: [], note: "无" }], first.groups);
  assert.deepEqual(pendingJudgements(cells, results), { groups: [], empty: [] });
  assert.equal(pendingJudgements(cells, results, { force: true }).groups.length, 1);
  results.close();
});

test("记分：存进库里，记着是谁判的；一批里有一处不对就整批不存，并逐条说清", () => {
  const results = tempResults();
  const { groups } = pendingJudgements([cell("c1", "a", "参照", "转写一"), cell("c1", "b", "参照", "转写二")], results);
  const [one, two] = groups[0].items.map((item) => item.id);
  assert.throws(
    () =>
      recordJudgements(
        results,
        [
          { id: one, score: 4, problems: ["字词错"], note: "一个同音字" },
          { id: two, score: 6, problems: ["错别字"], note: "" },
          { id: "nope", score: 3, problems: [], note: "?" },
        ],
        groups,
      ),
    (error) =>
      /有 4 处不对/.test(error.message) &&
      /0–5 的整数/.test(error.message) &&
      /只能从/.test(error.message) &&
      /note 不能是空的/.test(error.message) &&
      /没有这个编号/.test(error.message),
  );
  assert.equal(results.get("judge", judgeKey("参照", "转写一")), null, "整批都没存");
  assert.equal(
    recordJudgements(
      results,
      [
        { id: one, score: 4, problems: ["字词错"], note: "一个同音字" },
        { id: two, score: 2, problems: ["漏内容"], note: "后半段没了" },
      ],
      groups,
    ),
    2,
  );
  assert.deepEqual(results.get("judge", judgeKey("参照", "转写二")), {
    kind: "transcript",
    score: 2,
    problems: ["漏内容"],
    note: "后半段没了",
    by: "claude-opus-5-5",
  });
  results.close();
});

test("成品另有一套标准：指纹和判转写的分开，能挑的问题不一样，空的成品记 0 分", () => {
  const results = tempResults();
  assert.notEqual(KINDS.final.key("参照", "成品"), judgeKey("参照", "成品"));
  const cells = [cell("c1", "q8 → deepseek", "参照", "成品"), cell("c1", "sv → deepseek", "参照", "")];
  const { groups, empty } = pendingJudgements(cells, results, { kind: "final" });
  assert.equal(groups[0].items[0].id, KINDS.final.key("参照", "成品").slice(0, 12));
  recordEmpty(results, empty, "final");
  assert.equal(results.get("judge", KINDS.final.key("参照", "")).note, "成品是空的");
  const [{ id }] = groups[0].items;
  // 转写那套里没有"答非所问"，成品这套有；反过来"语言不对"只在转写那套里
  assert.throws(() =>
    recordJudgements(results, [{ id, score: 1, problems: ["语言不对"], note: "x" }], groups, "final"),
  );
  recordJudgements(results, [{ id, score: 0, problems: ["答非所问"], note: "回答了问题" }], groups, "final");
  assert.equal(results.get("judge", KINDS.final.key("参照", "成品")).kind, "final");
  results.close();
});
