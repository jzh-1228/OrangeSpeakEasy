import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDelivery } from "../../src/app/delivery.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

// 按 macOS 的说法查（⌘V）；Windows 的说法在 i18n 的测试里查
const zh = createTranslator("zh-CN", "darwin");

const AUDIO_ID = "0b6f1c1e-5a44-4f0e-9d0b-2f9f3a1c7e55";
const audio = () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 7]).buffer;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-delivery-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// recordingsDir：录音存哪儿；add(rows, row)：往历史里记一行（默认推进 rows，测试里可以让它抛）
function setup(
  paste = async () => ({ ok: true, reason: null }),
  { recordingsDir = join(dir, "Recordings"), add = (rows, row) => rows.push(row) } = {},
) {
  const rows = [];
  const pasted = [];
  const clipboard = [];
  const errors = [];
  const delivery = createDelivery({
    recordingsDir,
    history: { add: (row) => add(rows, row) },
    paste: (text) => {
      pasted.push(text);
      return paste(text);
    },
    writeClipboard: (text) => clipboard.push(text),
    log: { warn() {}, error: (name, fields) => errors.push({ name, ...fields }) },
    now: () => new Date("2026-10-13T08:00:00.000Z"),
  });
  return { delivery, rows, pasted, clipboard, errors };
}

const payload = (overrides = {}) => ({
  audioId: AUDIO_ID,
  text: "我们后天开会。",
  durationSeconds: 4.2,
  audio: audio(),
  ...overrides,
});

test("成品：存录音、记历史、贴出去", async () => {
  const { delivery, rows, pasted } = setup();
  assert.deepEqual(await delivery.completed(payload()), { notice: null });

  // 历史里只记文件名：家目录搬了家也对得上
  assert.deepEqual([...readFileSync(join(dir, "Recordings", `${AUDIO_ID}.webm`))], [0x1a, 0x45, 0xdf, 0xa3, 7]);
  assert.deepEqual(rows, [
    {
      id: AUDIO_ID,
      kind: "dictate",
      sourceText: null,
      outputLanguage: null,
      status: "completed",
      refinedText: "我们后天开会。",
      error: null,
      duration: 4.2,
      audioFile: `${AUDIO_ID}.webm`,
      createdAt: "2026-10-13T08:00:00.000Z",
    },
  ]);
  assert.deepEqual(pasted, ["我们后天开会。"]);
});

test("没有听到声音：记历史但不去贴", async () => {
  const { delivery, rows, pasted } = setup();
  const { notice: silent } = await delivery.completed(payload({ text: "" }));
  assert.equal(zh.text(silent), "没有听到声音");
  assert.equal(rows.length, 1);
  assert.deepEqual(pasted, []);
});

test("没有辅助功能权限：提示用户自己粘贴", async () => {
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "not_trusted" }));
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /没有辅助功能权限.*⌘V/);
  // 这种情况小帮手自己已经写过剪贴板，这里不重复写
  assert.deepEqual(clipboard, []);
});

test("Windows 上目标窗口是管理员身份的：小帮手没按 Ctrl+V，文字留在剪贴板里，提示用户自己粘贴", async () => {
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "elevated" }));
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /管理员身份.*Ctrl\+V/);
  assert.deepEqual(clipboard, []);
});

test("Windows 上小帮手没能把文字写进剪贴板（clipboard）：这里再放一次，提示自己粘贴，不提辅助功能", async () => {
  const win = createTranslator("zh-CN", "win32");
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "clipboard" }));
  const { notice } = await delivery.completed(payload());
  assert.equal(win.text(notice), "没能自动粘贴：文字已复制，按 Ctrl+V 粘贴");
  assert.deepEqual(clipboard, ["我们后天开会。"]);
});

test("Windows 上模拟按键没成（send_input）：文字已在剪贴板里，提示自己粘贴，不提辅助功能", async () => {
  const win = createTranslator("zh-CN", "win32");
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "send_input" }));
  const { notice } = await delivery.completed(payload());
  assert.equal(win.text(notice), "没能自动粘贴：文字已复制，按 Ctrl+V 粘贴");
  assert.deepEqual(clipboard, []);
});

test("粘贴出错：文字放进剪贴板，历史照样记上", async () => {
  const { delivery, rows, clipboard } = setup(async () => {
    throw new Error("原生小帮手退出了");
  });
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /没能自动粘贴.*⌘V/);
  assert.deepEqual(clipboard, ["我们后天开会。"]);
  assert.equal(rows.length, 1);
});

test("语音翻译：贴的是译文，原文和目标语言只进历史", async () => {
  const { delivery, rows, pasted } = setup();
  const translated = payload({
    kind: "translate",
    text: "Let's meet the day after tomorrow.",
    sourceText: "我们后天开会。",
    outputLanguage: "en",
  });
  assert.deepEqual(await delivery.completed(translated), { notice: null });
  assert.deepEqual(pasted, ["Let's meet the day after tomorrow."]);
  assert.deepEqual(
    [rows[0].kind, rows[0].refinedText, rows[0].sourceText, rows[0].outputLanguage],
    ["translate", "Let's meet the day after tomorrow.", "我们后天开会。", "en"],
  );
  // 翻译失败的也记是哪个功能
  delivery.failed({ ...translated, audioId: "1b6f1c1e-5a44-4f0e-9d0b-2f9f3a1c7e55", error: "超时", sourceText: null });
  assert.deepEqual([rows[1].kind, rows[1].status, rows[1].outputLanguage], ["translate", "failed", "en"]);
});

test("失败的听写：录音和原因都留下", () => {
  const { delivery, rows, pasted } = setup();
  delivery.failed({ audioId: AUDIO_ID, error: "等了 20 秒没有等到成品", durationSeconds: 9, audio: audio() });
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].refinedText, "");
  assert.equal(rows[0].error, "等了 20 秒没有等到成品");
  assert.ok(existsSync(join(dir, "Recordings", rows[0].audioFile)));
  assert.deepEqual(pasted, []);
});

test("录音是某个缓冲区里的一段时，只存那一段", async () => {
  const { delivery, rows } = setup();
  const whole = Uint8Array.from([9, 9, 0x1a, 0x45, 9]);
  await delivery.completed(payload({ audio: whole.subarray(2, 4) }));
  assert.deepEqual([...readFileSync(join(dir, "Recordings", rows[0].audioFile))], [0x1a, 0x45]);
});

test("来自页面的参数不合格时拒绝，不落任何文件", async () => {
  const { delivery, rows } = setup();
  const bad = [
    payload({ audioId: "../../etc/passwd" }),
    payload({ audioId: `${AUDIO_ID}/x` }),
    payload({ durationSeconds: Number.NaN }),
    payload({ audio: "不是二进制" }),
    payload({ text: 42 }),
    // 不是说话的功能、不认识的语言、原文不是字
    payload({ kind: "cancel" }),
    payload({ kind: "nope" }),
    payload({ kind: "translate", outputLanguage: "klingon" }),
    payload({ kind: "translate", sourceText: 42 }),
  ];
  for (const item of bad) await assert.rejects(delivery.completed(item), TypeError);
  assert.throws(() => delivery.failed(payload({ error: undefined })), TypeError);
  assert.deepEqual(rows, []);
  assert.equal(existsSync(join(dir, "Recordings")) ? readdirSync(join(dir, "Recordings")).length : 0, 0);
});

test("参数不合格时连贴都不贴：拒绝得比粘贴早", async () => {
  const { delivery, pasted } = setup();
  const bad = [
    payload({ text: 42 }),
    payload({ audioId: "../../etc/passwd" }),
    payload({ kind: "nope" }),
    payload({ kind: "translate", outputLanguage: "klingon" }),
  ];
  for (const item of bad) await assert.rejects(delivery.completed(item), TypeError);
  assert.deepEqual(pasted, []);
});

// 历史库写不进去的常见情形：磁盘满（SQLITE_FULL）、被别的连接占着（SQLITE_BUSY）
const historyFull = () => {
  throw new Error("database or disk is full");
};

test("历史没记上（比如磁盘满了）：文字照样贴出去，并说明这次记录没存上", async () => {
  const { delivery, pasted, errors } = setup(undefined, { add: historyFull });
  const { notice } = await delivery.completed(payload());
  assert.deepEqual(pasted, ["我们后天开会。"]);
  assert.equal(zh.text(notice), "已粘贴，但这次记录没存上");
  // 存录音/记历史这一句失败留在日志里，三个月后排查看得出是哪一步
  assert.deepEqual(
    errors.map(({ name, error }) => [name, error]),
    [["delivery_record_failed", "database or disk is full"]],
  );
});

test("录音目录建不出来、录音文件写不进去：文字照样贴出去，只是记录没存上", async () => {
  // 录音目录的位置上是个文件：mkdirSync 抛 EEXIST（没权限、路径被占走的是同一条路）
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "占着位置");
  const mkdirFailed = setup(undefined, { recordingsDir: blocked });
  const { notice } = await mkdirFailed.delivery.completed(payload());
  assert.deepEqual(mkdirFailed.pasted, ["我们后天开会。"]);
  assert.equal(zh.text(notice), "已粘贴，但这次记录没存上");

  // 录音文件的位置上是个目录：writeFileSync 抛 EISDIR
  const recordingsDir = join(dir, "Recordings");
  mkdirSync(join(recordingsDir, `${AUDIO_ID}.webm`), { recursive: true });
  const writeFailed = setup(undefined, { recordingsDir });
  const written = await writeFailed.delivery.completed(payload());
  assert.deepEqual(writeFailed.pasted, ["我们后天开会。"]);
  assert.equal(zh.text(written.notice), "已粘贴，但这次记录没存上");
  assert.equal(writeFailed.errors[0].name, "delivery_record_failed");
});

test("既没听到声音、记录也没存上：如实说两句，不去贴", async () => {
  const { delivery, pasted } = setup(undefined, { add: historyFull });
  const { notice } = await delivery.completed(payload({ text: "" }));
  assert.equal(zh.text(notice), "没有听到声音，记录也没存上");
  assert.deepEqual(pasted, []);
});

test("历史没记上、粘贴也出错：文字仍然放进剪贴板", async () => {
  const { delivery, clipboard } = setup(
    async () => {
      throw new Error("原生小帮手退出了");
    },
    { add: historyFull },
  );
  const { notice } = await delivery.completed(payload());
  assert.deepEqual(clipboard, ["我们后天开会。"]);
  assert.match(zh.text(notice), /没能自动粘贴.*⌘V/);
});

test("失败的听写记不进历史时只记日志，不把悬浮条的失败分支带崩", () => {
  const { delivery, errors } = setup(undefined, { add: historyFull });
  assert.doesNotThrow(() =>
    delivery.failed({ audioId: AUDIO_ID, error: "等了 20 秒没有等到成品", durationSeconds: 9, audio: audio() }),
  );
  assert.equal(errors[0].name, "delivery_record_failed");
});
