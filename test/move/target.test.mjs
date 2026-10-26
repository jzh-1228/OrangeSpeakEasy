import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { checkLength, checkTarget, homeIn } from "../../src/move/target.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

const zh = createTranslator("zh-CN");
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

function setup(t) {
  // macOS 上用 /tmp 下的短路径（系统给的临时目录太长，控制通道的套接字放不下）；真实路径：/tmp 其实是 /private/tmp
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = realpathSync(mkdtempSync(join(base, "sm-t-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "old", ".orangespeakeasy");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), "{}");
  return { root, paths: resolvePaths({ ORANGESPEAKEASY_HOME: home }) };
}

test("搬到哪：所选文件夹里的 .orangespeakeasy；选的本身就叫 .orangespeakeasy 时就是它（Windows 上不分大小写）", () => {
  assert.equal(homeIn("/Volumes/Data", "darwin"), "/Volumes/Data/.orangespeakeasy");
  assert.equal(homeIn("/Volumes/Data/.orangespeakeasy/", "darwin"), "/Volumes/Data/.orangespeakeasy");
  assert.equal(homeIn("D:\\Apps", "win32"), "D:\\Apps\\.orangespeakeasy");
  assert.equal(homeIn("D:\\", "win32"), "D:\\.orangespeakeasy");
  assert.equal(homeIn("D:\\Apps\\.OrangeSpeakEasy", "win32"), "D:\\Apps\\.OrangeSpeakEasy");
});

test("新位置合格：交回新家目录", (t) => {
  const { root, paths } = setup(t);
  mkdirSync(join(root, "Data"));
  assert.equal(checkTarget({ paths, folder: join(root, "Data") }).home, join(root, "Data", ".orangespeakeasy"));
  // 已经有一个空的 .orangespeakeasy 也行
  mkdirSync(join(root, "Data", ".orangespeakeasy"));
  assert.equal(checkTarget({ paths, folder: join(root, "Data") }).home, join(root, "Data", ".orangespeakeasy"));
});

test("所选文件夹要是完整路径、已经在、是个文件夹", (t) => {
  const { root, paths } = setup(t);
  assert.throws(() => checkTarget({ paths, folder: "Data" }), said(/完整路径/));
  assert.throws(() => checkTarget({ paths, folder: join(root, "nope") }), said(/不存在/));
  writeFileSync(join(root, "file"), "x");
  assert.throws(() => checkTarget({ paths, folder: join(root, "file") }), said(/不存在/));
});

test("新家目录已经有东西：不往里拷（不覆盖、不混在一起）", (t) => {
  const { root, paths } = setup(t);
  mkdirSync(join(root, "Data", ".orangespeakeasy"), { recursive: true });
  writeFileSync(join(root, "Data", ".orangespeakeasy", "settings.json"), "{}");
  assert.throws(() => checkTarget({ paths, folder: join(root, "Data") }), said(/已经有东西/));
});

test("就是现在这个：不用搬", (t) => {
  const { root, paths } = setup(t);
  assert.throws(() => checkTarget({ paths, folder: join(root, "old") }), said(/已经在/));
  assert.throws(() => checkTarget({ paths, folder: paths.home }), said(/已经在/));
});

test("新位置在现在这个里面：按磁盘上的身份认，写法不同（经过符号链接、末尾带 /）也认得出来，不往自己里面拷", (t) => {
  const { root, paths } = setup(t);
  mkdirSync(join(paths.home, "sub"));
  assert.throws(() => checkTarget({ paths, folder: join(paths.home, "sub") }), said(/里面/));
  // 一个指进现在这个目录的符号链接：按字符串看不在里面
  symlinkSync(join(paths.home, "sub"), join(root, "sneaky"));
  assert.throws(() => checkTarget({ paths, folder: join(root, "sneaky") }), said(/里面/));
  assert.throws(() => checkTarget({ paths, folder: `${join(root, "sneaky")}/` }), said(/里面/));
});

test("路径太长：macOS 上控制通道的套接字路径最长 103 字节（家目录 86 字节）；Windows 上 120 个字符", (t) => {
  const { root, paths } = setup(t);
  const deep = join(root, "x".repeat(90));
  mkdirSync(deep);
  if (process.platform !== "win32") assert.throws(() => checkTarget({ paths, folder: deep }), said(/太长/));
  assert.doesNotThrow(() => checkLength(`/Users/someone/${"x".repeat(54)}/.orangespeakeasy`, "darwin"));
  // 按字节算：中文一个字三个字节
  assert.throws(() => checkLength(`/Users/someone/${"中".repeat(25)}/.orangespeakeasy`, "darwin"), said(/太长/));
  assert.doesNotThrow(() => checkLength(`D:\\${"x".repeat(100)}\\.orangespeakeasy`, "win32"));
  assert.throws(() => checkLength(`D:\\${"x".repeat(101)}\\.orangespeakeasy`, "win32"), said(/太长/));
});
