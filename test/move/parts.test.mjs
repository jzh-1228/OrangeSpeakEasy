import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canRehome, installerIn, rehome } from "../../src/move/installer.mjs";
import { probeTarget } from "../../src/move/probe.mjs";
import { stillMoving } from "../../src/move/state.mjs";

// 搬家用到的几块小零件：试盘（probe.mjs）、找会换家的安装脚本（installer.mjs）、认"还在搬"（state.mjs）。

const posixOnly = { skip: process.platform === "win32" && "试盘、跑 install.sh 是 macOS 的事" };

function scratch(t) {
  // macOS 上要短路径（套接字最长 103 字节），Windows 上没有 /tmp
  const root = realpathSync(mkdtempSync(process.platform === "win32" ? join(tmpdir(), "sm-p-") : "/tmp/sm-p-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(file, content = "x") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

test("试盘：建出来的目录只让自己进，试用的链接、套接字不留下", posixOnly, async (t) => {
  const home = join(scratch(t), ".orangespeakeasy");
  assert.deepEqual(await probeTarget(home), { created: true });
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(home), []);
});

test("试盘：哪一样做不到就说哪一样；目录是这里建的就删掉，本来就有的留着", posixOnly, async (t) => {
  const root = scratch(t);
  const fails = () => {
    throw Object.assign(new Error("not supported"), { code: "EINVAL" });
  };
  const home = join(root, "a", ".orangespeakeasy");
  mkdirSync(join(root, "a"));
  await assert.rejects(probeTarget(home, { restrict: fails }), (error) => {
    assert.equal(error.problem.key, "move.unsupportedDrive");
    assert.deepEqual(error.problem.params.what, { key: "move.probe.restrict" });
    assert.equal(error.problem.params.reason, "EINVAL");
    return true;
  });
  assert.equal(existsSync(home), false);

  const kept = join(root, "b", ".orangespeakeasy");
  mkdirSync(kept, { recursive: true });
  await assert.rejects(probeTarget(kept, { restrict: fails }));
  assert.equal(existsSync(kept), true);

  // chmod 不报错、只是不起作用（exFAT 上权限位总是 755 之类）
  await assert.rejects(probeTarget(join(root, "c"), { restrict: (dir) => chmodSync(dir, 0o755) }), (error) => {
    assert.deepEqual(error.problem.params.what, { key: "move.probe.restrict" });
    return true;
  });
});

test("会换家的安装脚本：Mac 在 app 里，Windows 在 current 指着的版本里；0.11.0 的不认换家", (t) => {
  const root = scratch(t);
  const mac = join(root, "mac");
  assert.equal(installerIn(mac, "darwin"), null);
  put(join(mac, "app", "install.sh"), "ORANGESPEAKEASY_PREVIOUS_HOME");
  assert.equal(installerIn(mac, "darwin"), join(mac, "app", "install.sh"));
  assert.equal(canRehome(join(mac, "app", "install.sh")), true);

  const win = join(root, "win");
  put(join(win, "versions", "0.12.0-abc", "app", "install.ps1"), "# 0.11.0");
  assert.equal(installerIn(win, "win32"), null);
  put(join(win, "current"), "0.12.0-abc\r\n");
  assert.equal(installerIn(win, "win32"), join(win, "versions", "0.12.0-abc", "app", "install.ps1"));
  assert.equal(canRehome(installerIn(win, "win32")), false);
  for (const bad of ["..", "a/b", ""]) {
    put(join(win, "current"), bad);
    assert.equal(installerIn(win, "win32"), null, bad);
  }
  assert.equal(canRehome(join(root, "missing")), false);
});

test("换家：交给安装脚本新旧两个目录，只给安装、更新用的变量一个都不带过去", posixOnly, async (t) => {
  const root = scratch(t);
  const home = join(root, "new");
  const seen = join(root, "seen");
  put(
    join(home, "app", "install.sh"),
    `# ORANGESPEAKEASY_PREVIOUS_HOME\nprintf '%s|%s|%s|%s|%s' "$ORANGESPEAKEASY_HOME" "$ORANGESPEAKEASY_PREVIOUS_HOME" "$1" "$ORANGESPEAKEASY_INSTALL_DIR$ORANGESPEAKEASY_VERSION$ELECTRON_RUN_AS_NODE" "$KEEP" > '${seen}'\nexit 7\n`,
  );
  const env = {
    PATH: process.env.PATH,
    KEEP: "kept",
    ORANGESPEAKEASY_INSTALL_DIR: "/x",
    ORANGESPEAKEASY_VERSION: "9",
    ELECTRON_RUN_AS_NODE: "1",
  };
  const code = await rehome({ home, previous: join(root, "old"), env, stdio: "ignore", platform: "darwin" });
  assert.equal(code, 7);
  assert.equal(readFileSync(seen, "utf8"), `${home}|${join(root, "old")}|--no-start||kept`);
  assert.throws(() => rehome({ home: join(root, "none"), previous: home, env, stdio: "ignore", platform: "darwin" }));
});

test("还在搬：记录说在搬、那个进程还在、没超过六个小时", () => {
  const now = () => new Date("2026-10-20T12:00:00Z");
  const record = { state: "running", pid: 42, startedAt: "2026-10-20T11:00:00Z" };
  assert.equal(stillMoving(record, { alive: () => true, now }), true);
  assert.equal(stillMoving(record, { alive: () => false, now }), false);
  assert.equal(stillMoving({ ...record, startedAt: "2026-10-20T05:00:00Z" }, { alive: () => true, now }), false);
  assert.equal(stillMoving({ ...record, state: "done" }, { alive: () => true, now }), false);
  assert.equal(stillMoving(null, { alive: () => true, now }), false);
});
