import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { buildWindowsSetup, fileVersion, SETUP_MAGIC, setupTrailer } from "../../../scripts/build/windows-setup.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-setup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("尾巴：8 字节记号加 8 字节小端的长度，和 native/windows-setup/payload.go 读的一样", () => {
  const trailer = setupTrailer(0x0102030405);
  assert.equal(trailer.length, 16);
  assert.equal(trailer.subarray(0, 8).toString("ascii"), SETUP_MAGIC);
  assert.equal(trailer.readBigUInt64LE(8), 0x0102030405n);
});

test("文件版本只认四段数字：预发版本号取前三段", () => {
  assert.equal(fileVersion("0.9.0"), "0.9.0.0");
  assert.equal(fileVersion("0.9.0-rc.1"), "0.9.0.0");
});

test("拼法：程序在前，接着是整棵树打成的 tar 再用 zstd 压过，最后是尾巴；tar 里不留本机用户名，编译时生成的资源文件不留", async () => {
  const packageDir = join(dir, "repo");
  const source = join(packageDir, "native", "windows-setup");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(packageDir, "assets"));
  const tree = join(dir, "tree");
  mkdirSync(join(tree, "app", "bin"), { recursive: true });
  mkdirSync(join(tree, "runtime"), { recursive: true });
  writeFileSync(join(tree, "app", "install.ps1"), "& { 'install' }\n");
  writeFileSync(join(tree, "app", "bin", "orangespeakeasy.mjs"), "// 程序\n");
  writeFileSync(join(tree, "runtime", "electron.exe"), "MZ 运行环境");
  const calls = [];
  // 假的 go：记下怎么调的，把该产出的文件写出来。tar 和 zstd 是真的
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1]?.startsWith("github.com/tc-hib/go-winres"))
      writeFileSync(join(source, "rsrc_windows_amd64.syso"), "资源");
    if (args[0] === "build") writeFileSync(args[args.indexOf("-o") + 1], "MZ 安装程序");
  };
  const out = join(dir, "OrangeSpeakEasy-Setup-x64.exe");
  await buildWindowsSetup({ packageDir, version: "0.9.0", tree, out, run });

  const winres = calls.find(({ args }) => args[1]?.startsWith("github.com/tc-hib/go-winres"));
  assert.ok(winres.args.includes("--manifest") && winres.args[winres.args.indexOf("--manifest") + 1] === "cli");
  assert.ok(!winres.args.includes("--admin"), "不要管理员权限");
  assert.equal(winres.options.env?.GOOS, undefined, "go-winres 是在这台机器上跑的工具，不交叉编译");
  const build = calls.find(({ args }) => args[0] === "build");
  assert.equal(build.options.env.GOOS, "windows");

  const bytes = readFileSync(out);
  const program = Buffer.from("MZ 安装程序");
  assert.deepEqual(bytes.subarray(0, program.length), program);
  const trailer = bytes.subarray(bytes.length - 16);
  assert.equal(trailer.subarray(0, 8).toString("ascii"), SETUP_MAGIC);
  const payloadLength = Number(trailer.readBigUInt64LE(8));
  assert.equal(program.length + payloadLength + 16, bytes.length);
  // 解开压过的那段，再用 tar 列出来：就是那棵树，没有 Mac 的 ._ 文件
  const archive = join(dir, "payload.tar");
  writeFileSync(archive, zstdDecompressSync(bytes.subarray(program.length, program.length + payloadLength)));
  // Windows 自带的 tar 按 CRLF 换行
  const listed = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter((name) => name && !name.endsWith("/"))
    .sort();
  assert.deepEqual(listed, ["app/bin/orangespeakeasy.mjs", "app/install.ps1", "runtime/electron.exe"]);
  // 发出去的包里没有这台机器的用户名、编号
  const owners = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/).slice(2, 4).join(" "));
  assert.deepEqual([...new Set(owners)], ["0 0"]);
  assert.equal(existsSync(join(source, "rsrc_windows_amd64.syso")), false);
});
