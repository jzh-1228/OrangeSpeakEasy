import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { openVocabulary, readImportFile, replaceFile } from "../../src/storage/vocabulary.mjs";
import { MAX_IMPORT_BYTES, MAX_TERM_LENGTH, MAX_TERMS } from "../../src/vocabulary/terms.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-vocabulary-"));
  file = join(dir, "vocabulary.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stored = () => JSON.parse(readFileSync(file, "utf8"));

test("没有文件就是空词典，不建文件", () => {
  assert.deepEqual(openVocabulary(file).terms(), []);
});

test("加词：规整后加在最前面，存成 { terms: [...] }；新开的一份读到的一样", () => {
  const vocabulary = openVocabulary(file);
  assert.equal(vocabulary.add("  Runzo "), "Runzo");
  vocabulary.add("Claude   Code");
  assert.deepEqual(vocabulary.terms(), ["Claude Code", "Runzo"]);
  assert.deepEqual(stored(), { terms: ["Claude Code", "Runzo"] });
  assert.deepEqual(openVocabulary(file).terms(), ["Claude Code", "Runzo"]);
});

test("加词：空的、太长的、已经有的（大小写不论）说清楚，不改文件", () => {
  const vocabulary = openVocabulary(file);
  vocabulary.add("GitHub");
  assert.throws(() => vocabulary.add("   "), said(/请输入/));
  assert.throws(() => vocabulary.add("x".repeat(MAX_TERM_LENGTH + 1)), said(new RegExp(`${MAX_TERM_LENGTH}`)));
  assert.throws(() => vocabulary.add("github"), said(/GitHub.*已在词典中/));
  assert.deepEqual(stored(), { terms: ["GitHub"] });
});

test("加词：满了就不加，说清上限", () => {
  writeFileSync(file, JSON.stringify({ terms: Array.from({ length: MAX_TERMS }, (_, i) => `t${i}`) }));
  assert.throws(() => openVocabulary(file).add("one more"), said(new RegExp(`${MAX_TERMS}`)));
});

test("改词：位置不变；改成别的已有词算重复；只改大小写可以；原来的词不在了说清楚", () => {
  const vocabulary = openVocabulary(file);
  for (const term of ["c", "b", "a"]) vocabulary.add(term);
  assert.equal(vocabulary.update("b", "Bee"), "Bee");
  assert.deepEqual(vocabulary.terms(), ["a", "Bee", "c"]);
  assert.throws(() => vocabulary.update("Bee", "A"), said(/已在词典中/));
  assert.equal(vocabulary.update("Bee", "BEE"), "BEE");
  assert.throws(() => vocabulary.update("zzz", "y"), said(/zzz/));
});

test("删词：一次删几个，按大小写不论认，回删了几个、哪些本来就不在（原样）", () => {
  const vocabulary = openVocabulary(file);
  for (const term of ["c", "b", "a"]) vocabulary.add(term);
  assert.deepEqual(vocabulary.remove(["A", "c", "nope"]), { removed: 2, missing: ["nope"] });
  assert.deepEqual(vocabulary.terms(), ["b"]);
});

test("导入：先预览（去掉词典里已有的），再按文件里的先后加在最前面", () => {
  const vocabulary = openVocabulary(file);
  vocabulary.add("multica");
  const preview = vocabulary.preview("Runzo\nMultica\nAE-PM\nRunzo\n");
  assert.deepEqual(preview.terms, ["Runzo", "AE-PM"]);
  // 已在词典里的、文件里自己重复的分开数
  assert.equal(preview.existing, 1);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.room, MAX_TERMS - 1);
  assert.equal(vocabulary.importTerms(preview.terms), 2);
  assert.deepEqual(vocabulary.terms(), ["Runzo", "AE-PM", "multica"]);
});

test("导入：超出上限的整批不导，说清还能加几个；导入时又有重复的（两次导入之间加过）跳过", () => {
  const vocabulary = openVocabulary(file);
  writeFileSync(file, JSON.stringify({ terms: Array.from({ length: MAX_TERMS - 1 }, (_, i) => `t${i}`) }));
  assert.throws(() => vocabulary.importTerms(["x", "y"]), said(/还能添加 1 个/));
  assert.equal(vocabulary.importTerms(["t0", "x"]), 1);
});

test("别处改了文件（命令行、手改）下一次读就是新的；手改的词照样规整、去重，空的丢掉", () => {
  const vocabulary = openVocabulary(file);
  vocabulary.add("a");
  writeFileSync(file, JSON.stringify({ terms: ["  Runzo ", "runzo", "", "埋点"] }));
  assert.deepEqual(vocabulary.terms(), ["Runzo", "埋点"]);
});

test("文件坏了照实报错，说是哪个文件；不当成空词典、也不覆盖它", () => {
  writeFileSync(file, "{ not json");
  const vocabulary = openVocabulary(file);
  assert.throws(() => vocabulary.terms(), said(/vocabulary\.json/));
  assert.throws(() => vocabulary.add("a"), said(/vocabulary\.json/));
  assert.equal(readFileSync(file, "utf8"), "{ not json");
  writeFileSync(file, JSON.stringify({ terms: "a,b" }));
  assert.throws(() => openVocabulary(file).terms(), said(/vocabulary\.json/));
});

// ---------- 2026-10-19 对抗审查后补的 ----------

test("写是原子的：先写临时文件再换上去，不留临时文件；只有自己读得了", () => {
  const vocabulary = openVocabulary(file);
  vocabulary.add("Runzo");
  assert.deepEqual(readdirSync(dir), ["vocabulary.json"]);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("手改的文件开头带 BOM 也认；写坏了的报格式不对，报错里不带文件内容（这句话会进日志）", () => {
  writeFileSync(file, `\uFEFF${JSON.stringify({ terms: ["埋点"] })}`);
  assert.deepEqual(openVocabulary(file).terms(), ["埋点"]);
  writeFileSync(file, '{"terms": ["张三的秘密项目",]}');
  assert.throws(
    () => openVocabulary(file).terms(),
    (error) =>
      said(/格式不对/)(error) && !JSON.stringify(error.problem).includes("秘密") && !error.message.includes("秘密"),
  );
});

test("改词典之前重新读文件，不看缓存：别处在同一时刻改了（修改时间、大小都一样）也不会被冲掉", () => {
  const app = openVocabulary(file);
  app.add("abc");
  assert.deepEqual(app.terms(), ["abc"]);
  const when = statSync(file).mtime;
  openVocabulary(file).update("abc", "abd");
  utimesSync(file, when, when);
  app.add("xyz");
  assert.deepEqual(openVocabulary(file).terms(), ["xyz", "abd"]);
});

test("手改到超过上限：还能加的是 0，不是负数；加词照实说满了", () => {
  writeFileSync(file, JSON.stringify({ terms: Array.from({ length: MAX_TERMS + 5 }, (_, i) => `t${i}`) }));
  const vocabulary = openVocabulary(file);
  assert.equal(vocabulary.preview("new").room, 0);
  assert.throws(() => vocabulary.add("new"), said(/已满/));
  assert.throws(() => vocabulary.importTerms(["new"]), said(/还能添加 0 个/));
});

test("写不进去（没有权限）报成一句人话，说是哪个文件", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  const vocabulary = openVocabulary(file);
  vocabulary.add("a");
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => vocabulary.add("b"), said(/写不进词典文件 .*vocabulary\.json：没有权限/));
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("换上新文件：Windows 上目标正被别的程序开着（EPERM、EACCES、EBUSY）隔一会儿再试；别的错误、别的系统不重试", () => {
  /** 按给的错误代码依次失败，用完了就成功 */
  const failing = (...codes) => {
    const calls = [];
    const rename = (from, to) => {
      calls.push([from, to]);
      const code = codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { calls, rename };
  };
  const waits = [0, 0, 0];

  let attempt = failing("EPERM", "EBUSY");
  replaceFile("tmp", "target", { rename: attempt.rename, platform: "win32", waits });
  assert.deepEqual(attempt.calls, [
    ["tmp", "target"],
    ["tmp", "target"],
    ["tmp", "target"],
  ]);

  // 一直被拒：等完了照原样抛出，交给上面报成"写不进去"
  attempt = failing("EACCES", "EACCES", "EACCES", "EACCES", "EACCES");
  assert.throws(() => replaceFile("tmp", "target", { rename: attempt.rename, platform: "win32", waits }), {
    code: "EACCES",
  });
  assert.equal(attempt.calls.length, waits.length + 1);

  attempt = failing("ENOENT");
  assert.throws(() => replaceFile("tmp", "target", { rename: attempt.rename, platform: "win32", waits }), {
    code: "ENOENT",
  });
  assert.equal(attempt.calls.length, 1);

  // macOS、Linux 上的 EPERM 就是没有权限，等也没用
  attempt = failing("EPERM");
  assert.throws(() => replaceFile("tmp", "target", { rename: attempt.rename, platform: "darwin", waits }), {
    code: "EPERM",
  });
  assert.equal(attempt.calls.length, 1);
});

test("读要导入的文件：UTF-8、带 BOM 的 UTF-16、GBK 都认；不是文本、太大、读不出都说清是哪个文件", async () => {
  const at = (name, bytes) => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  assert.equal(await readImportFile(at("u8.csv", "埋点\n")), "埋点\n");
  assert.equal(
    await readImportFile(at("le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("埋点", "utf16le")]))),
    "埋点",
  );
  // "埋点" 的 GBK：C2F1 B5E3
  assert.equal(await readImportFile(at("gbk.csv", Buffer.from([0xc2, 0xf1, 0xb5, 0xe3]))), "埋点");
  await assert.rejects(
    readImportFile(at("bin.csv", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]))),
    said(/不是文本文件/),
  );
  await assert.rejects(readImportFile(at("big.csv", Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x61))), said(/文件过大/));
  await assert.rejects(readImportFile(join(dir, "nope.csv")), said(/读不出 .*nope\.csv：文件不存在/));
});
