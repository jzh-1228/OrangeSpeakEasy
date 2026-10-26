import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyStore } from "../../../src/app/keys/key-store.mjs";
import { createTranslator } from "../../../src/i18n/index.mjs";

// 按 macOS 的说法查；Windows 那几句的说法在 i18n 的测试里查
const zh = createTranslator("zh-CN", "darwin");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

// 假的钥匙串：把字节逐个异或一下，够区分"存的是密文还是明文"
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a)).toString("utf8"),
});

function tempStore(safeStorage = fakeSafeStorage()) {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-key-"));
  const file = join(dir, "gemini-key.bin");
  return { file, store: createKeyStore({ file, safeStorage }), cleanup: () => rmSync(dir, { recursive: true }) };
}

test("没存过时读出来是 null", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.load(), null);
});

test("存进去能原样读回来；磁盘上不是明文，文件只有自己能读写", (t) => {
  const { file, store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  assert.equal(store.load(), "AIza-not-a-real-key");
  assert.ok(!readFileSync(file).includes("AIza-not-a-real-key"));
  // Windows 上权限位没有意义，只有自己能读靠的是家目录的访问控制（storage/owner-only.mjs，paths 的测试查）
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("清掉之后读出来是 null，重复清不报错", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  store.clear();
  store.clear();
  assert.equal(store.load(), null);
});

test("清掉时连 0.7.0 及以前 App 那一份也删：不然下次启动又会把它当成要搬过来的 key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-key-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, "gemini-key.bin");
  const old = join(dir, "gemini-key.app.bin");
  writeFileSync(old, "旧密文");
  const store = createKeyStore({ file, oldFile: old, safeStorage: fakeSafeStorage() });
  store.save("AIza-not-a-real-key");
  // 存新的不碰旧的那份：退回 0.7.0 时它还在
  assert.ok(existsSync(old));
  store.clear();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(old), false);
});

test("系统钥匙串不可用时拒绝保存，不退回到存明文", (t) => {
  const { file, store, cleanup } = tempStore(fakeSafeStorage(false));
  t.after(cleanup);
  assert.throws(() => store.save("AIza-not-a-real-key"), said(/钥匙串/));
  assert.throws(() => statSync(file), { code: "ENOENT" });
});

test("exists：只看文件在不在，不解密", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createKeyStore({
    file: join(dir, "openai-key.bin"),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: () => assert.fail("不该解密"),
    },
  });
  assert.equal(store.exists(), false);
  store.save("k");
  assert.equal(store.exists(), true);
});
