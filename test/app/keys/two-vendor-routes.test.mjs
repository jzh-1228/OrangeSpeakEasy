import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { dictateOnce, requests, boot as start } from "../route-harness.mjs";

// 一条路线要两家 key 时（第一跳交给云端、润色交给另一家）整套拼起来走一遍（../route-harness.mjs）。

const zh = createTranslator("zh-CN");

/** 第一跳交给百炼、润色交给 DeepSeek */
const TWO_VENDORS = { mode: "local", transcriber: "bailian/qwen3-asr-flash", polish: "deepseek" };
const boot = (t, { stored }) => start(t, { settings: TWO_VENDORS, stored });

test("给不在路线里的一家存 key：只验它自己，不拉上路线里第一跳那家（没带它的 key 时会被判成无效）", async (t) => {
  const app = await boot(t, { stored: { deepseek: "ds-good", bailian: "bl-good" } });
  await app.keys.loadAtStartup();
  requests.length = 0;
  const saved = await app.keys.save("kimi-good", { provider: "moonshot" });
  assert.deepEqual(saved, { ok: true });
  assert.equal(app.keyStores.moonshot.value, "kimi-good");
  assert.ok(
    requests.every(({ url }) => url.includes("moonshot")),
    JSON.stringify(requests),
  );
});

test("密钥表里检测一家、检测一个润色模型：只验那一家，路线里第一跳那家没有 key 也不受牵连", async (t) => {
  const app = await boot(t, { stored: { deepseek: "ds-good", moonshot: "kimi-good" } });
  const kimi = await app.modes.check("local", { polish: "moonshot" });
  assert.equal(kimi.ok, true, JSON.stringify(kimi));
});

test("第一跳那家的 key 失效：状态点名它；重填润色那家没用，给它存好 key 就接着用起来", async (t) => {
  const app = await boot(t, { stored: { deepseek: "ds-good", bailian: "bl-revoked" } });
  const started = await app.keys.loadAtStartup();
  assert.equal(started.state, "rejected");
  assert.deepEqual(started.vendor, { id: "bailian", name: "Bailian" });
  assert.match(zh.text(started.problem), /Bailian/);

  const again = await app.keys.save("ds-good");
  assert.equal(again.ok, false);
  assert.match(zh.text(again.problem), /Bailian/, "没通过的原因要点名真正出问题的那家");

  assert.deepEqual(await app.keys.save("bl-good", { provider: "bailian" }), { ok: true });
  assert.equal(app.keys.current.state, "ready");
  assert.equal(app.service.ready, true);
});

test("删掉第一跳那家的 key：听写的报错点名它、给的命令是它的", async (t) => {
  const app = await boot(t, { stored: { deepseek: "ds-good", bailian: "bl-good" } });
  await app.keys.loadAtStartup();
  await app.keys.forget({ provider: "bailian" });
  assert.deepEqual(app.keys.current.vendor, { id: "bailian", name: "Bailian" });
  const said = zh.text((await dictateOnce(app.service.url)).V.problem);
  assert.match(said, /Bailian/);
  assert.match(said, /orangespeakeasy key bailian/);
});

test("两把都删了、只把第一跳那家存回去：状态改说缺润色那家的", async (t) => {
  const app = await boot(t, { stored: { deepseek: "ds-good", bailian: "bl-good" } });
  await app.keys.loadAtStartup();
  await app.keys.forget({ provider: "deepseek" });
  await app.keys.forget({ provider: "bailian" });
  assert.deepEqual(await app.keys.save("bl-good", { provider: "bailian" }), { ok: true });
  assert.equal(app.keys.current.state, "missing");
  assert.equal(app.keys.current.vendor, undefined, "缺的是正在用的那家（DeepSeek），不再点名百炼");
});
