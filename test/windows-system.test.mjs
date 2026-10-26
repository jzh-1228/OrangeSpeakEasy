import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { clearUserHome, isOurShortcut, removeLoginItem, removePathEntry } from "../src/windows-system.mjs";

const windowsOnly = { skip: process.platform !== "win32" && "要在 Windows 上起 PowerShell" };

test("退出后再删：叫它的进程马上就退出，那几个目录照样在它退出之后删掉", windowsOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-winsys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doomed = join(dir, "runtime.old.test");
  mkdirSync(doomed);
  writeFileSync(join(doomed, "electron.exe"), "");
  // 和 orangespeakeasy uninstall、update 一样：交代完马上退出。Node 在 Windows 上会把直接起的子进程跟着自己一起收掉
  const script = join(dir, "caller.mjs");
  const module = pathToFileURL(join(import.meta.dirname, "../src/windows-system.mjs")).href;
  writeFileSync(
    script,
    `import { removeAfterExit } from ${JSON.stringify(module)};\nremoveAfterExit([process.argv[2]]);\n`,
  );
  execFileSync(process.execPath, [script, doomed]);
  // 起两次 PowerShell 加上等的那一下，真机上两秒左右；整个文件只有 5 秒（--test-timeout）
  for (let waited = 0; existsSync(doomed) && waited < 4000; waited += 100) await delay(100);
  assert.equal(existsSync(doomed), false, "叫它的进程退出 4 秒后目录还在");
});

test("用户环境变量 ORANGESPEAKEASY_HOME 不是指着这个目录的：不动", windowsOnly, () => {
  assert.equal(clearUserHome(join(tmpdir(), "sm-winsys-nowhere", ".orangespeakeasy")), false);
});

test("没有那一项时如实说没有，不报错：开机启动、Path 里都没有这个家目录的", windowsOnly, () => {
  // 家目录是编出来的：真装着的那份的开机启动、Path 不会被碰到（只删指着这个家目录的）
  const home = join(tmpdir(), "sm-winsys-nowhere", ".orangespeakeasy");
  assert.equal(removeLoginItem(home), false);
  assert.equal(removePathEntry(join(home, "bin")), false);
});

test(
  "快捷方式是不是我们的：照 Windows 读出来的目标认，指着这个家目录里的程序才算（路径里有中文也认得）",
  windowsOnly,
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sm-快捷方式-"));
    // 刚建完快捷方式，系统还占着这个目录一小会儿：删不掉就隔一会儿再删，不留空目录
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const home = join(dir, "用户", ".orangespeakeasy");
    const targets = {
      "ours.lnk": join(home, "versions", "0.9.3-1a2b3c4d", "runtime", "electron.exe"),
      // 0.9.2 及以前装的：程序直接在家目录的 runtime 里
      "legacy.lnk": join(home, "runtime", "electron.exe"),
      "theirs.lnk": join(dir, "别的", "runtime", "electron.exe"),
      // 名字只是前面一截一样的另一个目录
      "prefix.lnk": join(`${home}-old`, "runtime", "electron.exe"),
    };
    // 和 install.ps1 的 Add-Shortcut 一样用 WScript.Shell 建，一次起 PowerShell 建完（整个文件只有 5 秒）；目标不用真的存在
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$shell = New-Object -ComObject WScript.Shell; ($env:LINKS | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $s = $shell.CreateShortcut((Join-Path $env:DIR $_.Name)); $s.TargetPath = $_.Value; $s.Arguments = $env:ARGS; $s.Save() }",
      ],
      { env: { ...process.env, DIR: dir, LINKS: JSON.stringify(targets), ARGS: `"${join(home, "app")}"` } },
    );
    const ours = (name) => isOurShortcut(join(dir, name), home);
    assert.equal(ours("ours.lnk"), true);
    assert.equal(ours("legacy.lnk"), true);
    assert.equal(ours("theirs.lnk"), false);
    assert.equal(ours("prefix.lnk"), false);
    assert.equal(ours("missing.lnk"), false);
  },
);
