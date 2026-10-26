import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENTITLEMENTS, osxSignOptions, signingConfig } from "../../../scripts/build/signing.mjs";

/** 一个临时的仓库根目录，.machine.env 写成 content（null 是没有这个文件） */
function repo(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "sm-signing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (content !== null) writeFileSync(join(dir, ".machine.env"), content);
  return dir;
}

const IDENTITY = "Developer ID Application: Someone (TEAM123456)";

test("什么都没配：不签身份，打本机签名", (t) => {
  assert.equal(signingConfig(repo(t, null), {}), null);
  assert.equal(signingConfig(repo(t, "MAC_SIGNING_IDENTITY=\nMAC_NOTARY_PROFILE=\n"), {}), null);
});

test("从 .machine.env 读证书名和公证档案名，带引号、带空格的照读", (t) => {
  const dir = repo(t, `# 本机配置\nMAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=orangespeakeasy-notary\n`);
  assert.deepEqual(signingConfig(dir, {}), { identity: IDENTITY, notaryProfile: "orangespeakeasy-notary" });
});

test("环境变量优先于 .machine.env", (t) => {
  const dir = repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=orangespeakeasy-notary\n`);
  assert.deepEqual(signingConfig(dir, { MAC_NOTARY_PROFILE: "other" }), { identity: IDENTITY, notaryProfile: "other" });
});

test("只签名不公证也行：本机自己用", (t) => {
  assert.deepEqual(signingConfig(repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\n`), {}), {
    identity: IDENTITY,
    notaryProfile: null,
  });
});

test("配了公证却没配证书：说清楚，不悄悄打一个没签名的", (t) => {
  assert.throws(
    () => signingConfig(repo(t, "MAC_NOTARY_PROFILE=orangespeakeasy-notary\n"), {}),
    /MAC_SIGNING_IDENTITY/,
  );
});

test("Chromium 的几个 helper 照签名库的默认给，其余只给 JIT 和麦克风两项", () => {
  const { identity, optionsForFile } = osxSignOptions(IDENTITY);
  assert.equal(identity, IDENTITY);
  for (const helper of ["Renderer", "GPU", "Plugin"]) {
    assert.deepEqual(
      optionsForFile(`/x/OrangeSpeakEasy.app/Contents/Frameworks/OrangeSpeakEasy Helper (${helper}).app`),
      {},
    );
  }
  for (const file of [
    "/x/OrangeSpeakEasy.app",
    "/x/OrangeSpeakEasy.app/Contents/Frameworks/OrangeSpeakEasy Helper.app",
    "/x/OrangeSpeakEasy.app/Contents/Resources/app/build/key-helper",
  ]) {
    assert.deepEqual(optionsForFile(file), { entitlements: ENTITLEMENTS });
  }
  const keys = [...readFileSync(ENTITLEMENTS, "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]);
});
