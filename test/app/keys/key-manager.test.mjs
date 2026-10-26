import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyManager } from "../../../src/app/keys/key-manager.mjs";
import { createTranslator, LocalizedError, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { findProvider } from "../../../src/server/providers/index.mjs";
import { findVendor } from "../../../src/server/vendors.mjs";

const zh = createTranslator("zh-CN");

/** 换路线并等到找 key、验 key 有了结论，交回换没换上 */
async function switched(keys, route) {
  const result = keys.switchRoute(route);
  await result.settled;
  return result.ok;
}

const nativeRoute = (provider, model) => ({ mode: "native", model: { provider, model }, thinkingLevel: null });
const LOCAL_DEEPSEEK = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "deepseek", model: "deepseek-flash" },
  customUrl: null,
};

/** 不说走哪条路线时，改用 OpenAI 走的那条：它的默认模型、原生链路 */
const OPENAI_DEFAULT = {
  mode: "native",
  model: { provider: "openai", model: findProvider("openai").defaultModel },
  thinkingLevel: null,
};

// 服务报上来的错都是模型层分好类的 ModelError（见 src/server/providers/errors.mjs），下面几种的原文都是实测到的
const OFFLINE = () =>
  new ModelError({ kind: "unavailable", problem: "连不上 Gemini，检查网络后再试", detail: "fetch failed" });
const BUSY = () =>
  new ModelError({
    kind: "unavailable",
    problem: "Gemini 暂时用不了（The service is currently unavailable），过一会儿再试",
    detail: '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}',
  });
const INVALID = () =>
  new ModelError({ kind: "key", problem: "这把 key 无效，检查有没有复制完整", detail: "API key not valid." });
const NO_SUCH_MODEL = () =>
  new ModelError({
    kind: "other",
    problem: "Gemini 拒绝了请求：models/gemini-nope is not found",
    detail: '{"error":{"code":404,"message":"models/gemini-nope is not found.","status":"NOT_FOUND"}}',
  });

/**
 * 假的听写服务。verdicts：key → 拿它去验证时抛什么错（不写就是通过）。
 * 和真的一样：允许"先用着"时，连不上不算失败。
 */
function fakeService(verdicts = {}) {
  const service = {
    calls: [],
    /** 正在用的那把；没有时是 null */
    using: null,
    /** 正在走的路线；没换过时是 null（启动时设置里的那条） */
    route: null,
    /** 给了就让验证卡在这里，等它放行（模拟那一家回话慢） */
    gate: null,
    async useKey(apiKey, { allowUnverified = false, keys } = {}) {
      service.calls.push({ useKey: apiKey, allowUnverified, ...(keys ? { keys } : {}) });
      if (service.gate) await service.gate;
      const error = verdicts[apiKey]?.();
      if (error && !(allowUnverified && error.kind === "unavailable")) throw error;
      service.using = apiKey;
      return { verified: !error };
    },
    /** 换路线：当场换上，手里那把作废（和真的一样不验证） */
    setRoute(route) {
      service.calls.push({ setRoute: route });
      service.route = route;
      service.using = null;
    },
    /** 拿一把 key 试另一条路线，不换掉正在用的 */
    async probe({ route, apiKey, keys }) {
      service.calls.push({ probe: apiKey, route, ...(keys ? { keys } : {}) });
      const error = verdicts[apiKey]?.();
      if (error) throw error;
    },
    async verify() {
      service.calls.push({ verify: service.using });
      const error = verdicts[service.using]?.();
      if (error) throw error;
    },
    forgetKey() {
      service.using = null;
    },
  };
  return service;
}

function fakeStore(initial = null) {
  const store = {
    value: initial,
    load() {
      if (store.value instanceof Error) throw store.value;
      return store.value;
    },
    save(key) {
      if (store.failOnSave) throw new Error("钥匙串不可用");
      store.value = key;
    },
    clear() {
      store.value = null;
    },
    exists() {
      return store.value !== null;
    },
  };
  return store;
}

/**
 * @param {object} [options]
 * @param {string} [options.provider] 正在用哪一家，默认 Gemini
 * @param {string | Error | null} [options.stored] 正在用的那一家存着的 key
 * @param {string | Error | null} [options.storedOther] 另一家（Gemini 时是 OpenAI，反之亦然）存着的 key
 * @param {string | Error | null} [options.storedDeepseek] 润色那一家（DeepSeek）存着的 key
 * @param {string | Error | null} [options.storedBailian] 第一跳交给云端时那一家（百炼）存着的 key
 * @param {(id: string) => object} [options.routeFor] 不写就用 key-manager 自带的（原生链路、默认模型）
 */
function setup({
  verdicts,
  provider = "gemini",
  stored = null,
  storedOther = null,
  storedDeepseek = null,
  storedBailian = null,
  env = {},
  external = false,
  routeFor,
} = {}) {
  const service = external ? null : fakeService(verdicts);
  const other = provider === "gemini" ? "openai" : "gemini";
  const keyStores = { [provider]: fakeStore(stored), [other]: fakeStore(storedOther) };
  if (provider !== "deepseek") keyStores.deepseek = fakeStore(storedDeepseek);
  if (provider !== "bailian") keyStores.bailian = fakeStore(storedBailian);
  const logged = [];
  const record = (level) => (event, fields) => logged.push({ level, event, ...fields });
  let changes = 0;
  const keys = createKeyManager({
    service,
    provider: findVendor(provider),
    keyStores,
    ...(routeFor ? { routeFor } : {}),
    env,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
    onChange: () => changes++,
  });
  return {
    keys,
    service,
    keyStore: keyStores[provider],
    otherStore: keyStores[other],
    deepseekStore: keyStores.deepseek,
    bailianStore: keyStores.bailian,
    logged,
    changes: () => changes,
  };
}

// ---------- 启动时找 key ----------

test("没有环境变量也没存过：还没有 key，不去打扰服务", async () => {
  const { keys, service } = setup();
  assert.deepEqual(await keys.loadAtStartup(), { state: "missing", source: null, problem: null });
  assert.deepEqual(service.calls, []);
});

test("存着的那把通过验证：可以用；途中的每一步都通知出去", async () => {
  const { keys, service, changes } = setup({ stored: "stored-key" });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: true });
  assert.equal(keys.current.state, "ready");
  assert.equal(service.using, "stored-key");
  // 正在验证 → 可以用
  assert.equal(changes(), 2);
});

test("环境变量里有就用它，不去读存着的那把", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key", env: { GEMINI_API_KEY: " env-key " } });
  keyStore.load = () => assert.fail("不该读存着的");
  assert.equal((await keys.loadAtStartup()).source, "env");
  assert.equal(service.using, "env-key");
});

test("启动时连不上 Gemini：存着的那把照样启用，如实标成还没验证", async () => {
  const { keys, service, logged } = setup({ stored: "stored-key", verdicts: { "stored-key": OFFLINE } });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: false });
  assert.equal(service.using, "stored-key");
  assert.deepEqual(service.calls, [{ useKey: "stored-key", allowUnverified: true }]);
  assert.deepEqual(logged.at(-1), {
    level: "info",
    event: "key_ready",
    provider: "gemini",
    source: "stored",
    verified: false,
  });
});

test("启动时 Gemini 一时不可用（503）：和没网一样先用着，不说成模型设置有问题", async () => {
  const { keys, service } = setup({ stored: "stored-key", verdicts: { "stored-key": BUSY } });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: false });
  assert.equal(service.using, "stored-key");
});

test("启动时 key 无效、或者 Gemini 拒绝了请求：不能用，并分清是哪一种", async () => {
  const invalid = setup({ stored: "revoked", verdicts: { revoked: INVALID } });
  const rejected = await invalid.keys.loadAtStartup();
  assert.deepEqual(
    { state: rejected.state, source: rejected.source, cause: rejected.cause },
    { state: "rejected", source: "stored", cause: "key" },
  );
  assert.match(zh.text(rejected.problem), /无效/);
  assert.equal(invalid.service.using, null);

  const wrongModel = setup({ stored: "good", verdicts: { good: NO_SUCH_MODEL } });
  const other = await wrongModel.keys.loadAtStartup();
  assert.equal(other.cause, "other");
  assert.match(zh.text(other.problem), /gemini-nope is not found/);
});

test("存着的 key 解不开：说读不出来了，请用户重新填", async () => {
  const { keys, service } = setup({ stored: new Error("钥匙串里的密钥没了") });
  const state = await keys.loadAtStartup();
  assert.deepEqual({ state: state.state, source: state.source }, { state: "unreadable", source: "stored" });
  assert.match(zh.text(state.problem), /读不出来/);
  assert.deepEqual(service.calls, []);
});

test("环境变量里的 key 带着换行：直接判成不能用，不交给服务，它的内容不出现在任何地方", async () => {
  const { keys, service, logged } = setup({ env: { GEMINI_API_KEY: "line-one-SECRET\nline-two-SECRET" } });
  const state = await keys.loadAtStartup();
  assert.deepEqual(
    { state: state.state, source: state.source, cause: state.cause },
    { state: "rejected", source: "env", cause: "key" },
  );
  assert.match(zh.text(state.problem), /空格或换行/);
  assert.deepEqual(service.calls, []);
  assert.doesNotMatch(JSON.stringify([state, logged]), /SECRET/);
});

test("连的是单独启动的服务端：key 在那边，这里不管", async () => {
  const { keys } = setup({ external: true, stored: "stored-key" });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "external", problem: null });
  assert.match(zh.text((await keys.save("new-key")).problem), /ORANGESPEAKEASY_SERVER_URL/);
  await keys.forget();
  assert.equal(keys.current.source, "external");
});

// ---------- 换一把 ----------

test("存一把新的：验证通过才存下来并开始用", async () => {
  const { keys, service, keyStore } = setup();
  assert.deepEqual(await keys.save("  new-key \n"), { ok: true });
  assert.equal(keyStore.value, "new-key");
  assert.equal(service.using, "new-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

test("什么都没填：不验证也不存", async () => {
  const { keys, service } = setup();
  for (const empty of ["", "   ", undefined, 42]) {
    assert.match(zh.text((await keys.save(empty)).problem), /还没有填/);
  }
  assert.deepEqual(service.calls, []);
});

test("新填的 key 带着换行：当场拒绝，不交给服务，它的内容不出现在回答和日志里", async () => {
  const { keys, service, keyStore, logged } = setup({ stored: "old-key" });
  await keys.loadAtStartup();
  const result = await keys.save("line-one-SECRET\nline-two-SECRET");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /这把 key 里有空格或换行/);
  assert.equal(service.using, "old-key");
  assert.equal(keyStore.value, "old-key");
  assert.equal(keys.current.state, "ready");
  assert.doesNotMatch(JSON.stringify([result, logged, keys.current]), /SECRET/);
});

test("新填的 key 没连上网验证不了：不算通过（它从没验证过），原来的状态不变", async () => {
  const withOld = setup({ stored: "old-key", verdicts: { "new-key": OFFLINE } });
  await withOld.keys.loadAtStartup();
  const result = await withOld.keys.save("new-key");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /连不上/);
  assert.deepEqual(withOld.service.calls.at(-1), { useKey: "new-key", allowUnverified: false });
  assert.equal(withOld.service.using, "old-key");
  assert.equal(withOld.keyStore.value, "old-key");
  assert.deepEqual(withOld.keys.current, { state: "ready", source: "stored", problem: null, verified: true });

  // 原来就没有 key 的，失败后仍然是"还没有"，而不是"存着的那把不能用"
  const empty = setup({ verdicts: { "new-key": INVALID } });
  assert.match(zh.text((await empty.keys.save("new-key")).problem), /无效/);
  assert.deepEqual(empty.keys.current, { state: "missing", source: null, problem: null });
  assert.equal(empty.keyStore.value, null);
});

test("验证过了但存不下来：这次能用，如实说下次要重填", async () => {
  const { keys, service, keyStore } = setup();
  keyStore.failOnSave = true;
  const result = await keys.save("new-key");
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /未能保存.*钥匙串不可用/);
  assert.equal(service.using, "new-key");
  assert.equal(keys.current.state, "ready");
});

test("验证时的报错里带着 key 的话，回答和日志里都抹掉", async () => {
  const leaky = () => new TypeError('Headers.append: "SECRET-key" is an invalid header value.');
  const { keys, logged } = setup({ verdicts: { "SECRET-key": leaky } });
  const result = await keys.save("SECRET-key");
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify([result, logged]), /SECRET/);
  assert.equal(logged.at(-1).event, "key_rejected");
});

/** 让存着的那把在验证时卡住，直到测试放行 */
function holdStartup(service) {
  let release;
  const useKey = service.useKey;
  service.useKey = async (apiKey, options) => {
    if (apiKey === "stored-key") await new Promise((resolve) => (release = resolve));
    return useKey(apiKey, options);
  };
  return async () => {
    await new Promise((resolve) => setImmediate(resolve));
    release();
  };
}

test("启动时的验证还没回来又存了一把新的：一个一个来，最后用的是后来的那把", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.save("new-key")];
  await release();
  await Promise.all(pending);
  assert.equal(service.using, "new-key");
  assert.equal(keyStore.value, "new-key");
  assert.equal(keys.current.state, "ready");
});

test("启动时的验证还没回来又存了一把不能用的：回到的是启动验证完的状态，不会停在“正在验证”", async () => {
  const { keys, service } = setup({ stored: "stored-key", verdicts: { "bad-key": INVALID } });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.save("bad-key")];
  await release();
  const [, saved] = await Promise.all(pending);
  assert.equal(saved.ok, false);
  assert.equal(service.using, "stored-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

// ---------- 删掉 ----------

test("删掉：存着的没了，服务也不再用它", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  await keys.loadAtStartup();
  await keys.forget();
  assert.equal(keyStore.value, null);
  assert.equal(service.using, null);
  assert.deepEqual(keys.current, { state: "missing", source: null, problem: null });
});

test("启动时的验证还没回来就点了删掉：验证回来之后 key 仍然是删掉的，不会又被启用", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.forget()];
  await release();
  await Promise.all(pending);
  assert.equal(service.using, null);
  assert.equal(keyStore.value, null);
  assert.equal(keys.current.state, "missing");
});

test("删的时候出了错（文件删不掉）：照实抛出来，后面再存 key 不受连累", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  await keys.loadAtStartup();
  keyStore.clear = () => {
    throw new Error("删不掉");
  };
  await assert.rejects(keys.forget(), /删不掉/);
  assert.deepEqual(await keys.save("new-key"), { ok: true });
  assert.equal(service.using, "new-key");
});

// ---------- 启动时没验证成的，之后补上 ----------

test("补验证：连上网之后变成验证通过", async () => {
  const verdicts = { "stored-key": OFFLINE };
  const { keys, service } = setup({ stored: "stored-key", verdicts });
  await keys.loadAtStartup();

  await keys.reverify();
  assert.equal(keys.current.verified, false, "还是连不上：先用着，状态不变");
  assert.equal(service.using, "stored-key");

  delete verdicts["stored-key"];
  await keys.reverify();
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

test("补验证：连上之后发现 key 无效，改判成不能用，服务不再用它", async () => {
  const verdicts = { "env-key": OFFLINE };
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" }, verdicts });
  await keys.loadAtStartup();
  verdicts["env-key"] = INVALID;
  await keys.reverify();
  assert.deepEqual(
    { state: keys.current.state, source: keys.current.source, cause: keys.current.cause },
    { state: "rejected", source: "env", cause: "key" },
  );
  assert.equal(service.using, null);
});

test("补验证：已经验证过的、没有 key 的，都不再发请求；同时来两次只验一次", async () => {
  const verified = setup({ stored: "stored-key" });
  await verified.keys.loadAtStartup();
  await verified.keys.reverify();
  const missing = setup();
  await missing.keys.reverify();
  assert.ok(![...verified.service.calls, ...missing.service.calls].some((call) => "verify" in call));

  const pending = setup({ stored: "stored-key", verdicts: { "stored-key": OFFLINE } });
  await pending.keys.loadAtStartup();
  await Promise.all([pending.keys.reverify(), pending.keys.reverify()]);
  assert.equal(pending.service.calls.filter((call) => "verify" in call).length, 1);
});

// ---------- 不止一家 ----------

test("正在用 OpenAI：从 OPENAI_API_KEY 和它自己存着的那把里找，不碰 Gemini 的", async () => {
  const fromEnv = setup({ provider: "openai", env: { GEMINI_API_KEY: "gemini-key", OPENAI_API_KEY: "openai-key" } });
  assert.equal((await fromEnv.keys.loadAtStartup()).source, "env");
  assert.equal(fromEnv.service.using, "openai-key");

  const stored = setup({ provider: "openai", stored: "openai-stored", storedOther: "gemini-stored" });
  await stored.keys.loadAtStartup();
  assert.equal(stored.service.using, "openai-stored");
});

test("给另一家存 key：拿它那家的默认模型验证过才存，正在用的那把和状态都不动", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key" });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save(" openai-key ", { provider: "openai" }), { ok: true });
  assert.equal(otherStore.value, "openai-key");
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(service.using, "gemini-key");
  assert.deepEqual(service.calls.at(-1), { probe: "openai-key", route: OPENAI_DEFAULT });
  assert.equal(keys.current.state, "ready");
});

test("给另一家存的 key 没通过：不存，说清原因", async () => {
  const { keys, otherStore } = setup({ verdicts: { "bad-key": INVALID } });
  const result = await keys.save("bad-key", { provider: "openai" });
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /无效/);
  assert.equal(otherStore.value, null);
});

test("删另一家的 key：只删它那一份，正在用的不受影响", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key", storedOther: "openai-key" });
  await keys.loadAtStartup();
  await keys.forget({ provider: "openai" });
  assert.equal(otherStore.value, null);
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(service.using, "gemini-key");
  assert.equal(keys.current.state, "ready");
});

test("不认识的厂商：不验证、不存、不删", async () => {
  const { keys, service } = setup();
  assert.match(zh.text((await keys.save("k", { provider: "nope" })).problem), /不认识 nope/);
  await assert.rejects(keys.forget({ provider: "nope" }), (error) => /不认识 nope/.test(zh.text(error.problem)));
  assert.deepEqual(service.calls, []);
});

// ---------- 换路线（改用另一家、换模型） ----------

test("换路线：当场换上，新路线那一家存着的 key 照启动时那样装上；之后存、删、检查不写厂商时说的都是新的那家", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key", storedOther: "openai-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(keys.provider.id, "openai");
  assert.deepEqual(service.calls.slice(-2), [
    { setRoute: OPENAI_DEFAULT },
    { useKey: "openai-key", allowUnverified: true },
  ]);
  assert.equal(service.using, "openai-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });

  await keys.forget();
  assert.equal(otherStore.value, null);
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(keys.current.state, "missing");
});

test("换到一家还没有 key 的：照样换上，状态是缺 key、说的是新的那家；填上就能用", async () => {
  const { keys, service } = setup({ stored: "gemini-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(keys.provider.id, "openai");
  assert.equal(service.using, null, "手里 Gemini 那把不能拿去走 OpenAI 的路线");
  assert.deepEqual(keys.current, { state: "missing", source: null, problem: null });
  assert.deepEqual(await keys.save("openai-new"), { ok: true });
  assert.equal(keys.current.state, "ready");
  assert.equal(service.using, "openai-new");
});

test("换过去时那家 key 不对：照样换上，状态是没通过", async () => {
  const { keys } = setup({ stored: "gemini-key", storedOther: "openai-bad", verdicts: { "openai-bad": INVALID } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.deepEqual([keys.current.state, keys.current.cause], ["rejected", "key"]);
  assert.match(zh.text(keys.current.problem), /无效/);
});

test("换过去时那一家暂时连不上：存着的那把当初验证过，照样先用着，如实标成还没验证", async () => {
  const { keys } = setup({ stored: "gemini-key", storedOther: "openai-key", verdicts: { "openai-key": OFFLINE } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.deepEqual([keys.current.state, keys.current.verified], ["ready", false]);
});

test("换过去时那一家的环境变量里有 key：用它，标明来自环境变量", async () => {
  const { keys, service } = setup({ stored: "gemini-key", env: { OPENAI_API_KEY: "openai-env" } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(service.using, "openai-env");
  assert.equal(keys.current.source, "env");
});

test("换路线：连的是单独启动的服务端时不换并说清楚", async () => {
  const external = setup({ external: true });
  assert.match(zh.text(external.keys.switchRoute(OPENAI_DEFAULT).problem), /单独启动的服务端/);
});

test("同一家换条路线（换模型）：接着用这次运行手里的那把（中途存过新的就是新的），不换回环境变量里的", async () => {
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" } });
  await keys.loadAtStartup();
  await keys.save("new-key");
  const route = nativeRoute("gemini", "gemini-3.8-flash");
  assert.equal(await switched(keys, route), true);
  assert.deepEqual(service.calls.slice(-2), [{ setRoute: route }, { useKey: "new-key", allowUnverified: true }]);
  assert.equal(keys.provider.id, "gemini");
  assert.equal(keys.current.source, "stored");
});

// ---------- 检查某条路线能不能用 ----------

test("检查：用那一家的 key（环境变量优先，其次存着的）发一个最小的请求，说能不能用、花了多久", async () => {
  const { keys, service } = setup({ storedOther: "openai-stored" });
  const result = await keys.check(nativeRoute("openai", "gpt-audio-1.5"));
  assert.equal(result.ok, true);
  assert.equal(result.source, "stored");
  assert.equal(typeof result.ms, "number");
  assert.deepEqual(service.calls, [{ probe: "openai-stored", route: nativeRoute("openai", "gpt-audio-1.5") }]);

  const fromEnv = setup({ storedOther: "openai-stored", env: { OPENAI_API_KEY: "openai-env" } });
  assert.equal((await fromEnv.keys.check(nativeRoute("openai", "gpt-audio-mini"))).source, "env");
  assert.equal(fromEnv.service.calls[0].probe, "openai-env");
});

test("检查：没有那一家的 key、key 读不出来、验证没通过，各说各的", async () => {
  const none = await setup().keys.check(nativeRoute("openai", "gpt-audio-mini"));
  assert.equal(none.ok, false);
  assert.equal(none.cause, "missing");
  assert.match(zh.text(none.problem), /还没有 OpenAI 的 key.*orangespeakeasy key openai/);

  const unreadable = await setup({ storedOther: new Error("解不开") }).keys.check(
    nativeRoute("openai", "gpt-audio-mini"),
  );
  assert.equal(unreadable.ok, false);
  assert.match(zh.text(unreadable.problem), /读不出来/);

  const rejected = await setup({ storedOther: "openai-key", verdicts: { "openai-key": NO_SUCH_MODEL } }).keys.check(
    nativeRoute("openai", "gpt-audio-9"),
  );
  assert.deepEqual([rejected.ok, rejected.cause], [false, "other"]);
  assert.match(zh.text(rejected.problem), /gemini-nope is not found/);
});

test("检查：连的是单独启动的服务端时查不了，说清为什么", async () => {
  const result = await setup({ external: true }).keys.check(nativeRoute("gemini", "gemini-3.5-flash"));
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /ORANGESPEAKEASY_SERVER_URL/);
});

test("检查正在用的那家时，用的是这次运行实际在用的那把（中途存过新的就是新的），不是环境变量里的", async () => {
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" } });
  await keys.loadAtStartup();
  await keys.save("new-key");
  await keys.check(nativeRoute("gemini", "gemini-3.5-flash"));
  assert.equal(service.calls.at(-1).probe, "new-key");
  assert.equal((await keys.check(nativeRoute("gemini", "gemini-3.5-flash"))).source, "stored");
});

test("sources：每家的 key 在哪（环境变量、存着的、没有），不用解密", () => {
  const { keys, keyStore } = setup({ storedOther: "openai-key", env: { GEMINI_API_KEY: "env-key" } });
  keyStore.load = () => assert.fail("不该解密");
  assert.deepEqual(keys.sources(), { gemini: "env", openai: "stored", deepseek: null, bailian: null });
  assert.deepEqual(setup({ storedDeepseek: "ds-key" }).keys.sources(), {
    gemini: null,
    openai: null,
    deepseek: "stored",
    bailian: null,
  });
});

// ---------- 润色那一家（只收文字，走本地转写链路） ----------

test("切到 local 模式：正在用的换成润色那一家（DeepSeek），用它的 key", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedDeepseek: "ds-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, LOCAL_DEEPSEEK), true);
  assert.equal(keys.provider.id, "deepseek");
  assert.equal(service.using, "ds-key");
  assert.deepEqual(service.route, LOCAL_DEEPSEEK);
});

test("给 DeepSeek 存 key：拿 routeFor 给的路线试，不换掉正在用的", async () => {
  const { keys, service, deepseekStore } = setup({ stored: "gemini-key", routeFor: () => LOCAL_DEEPSEEK });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save("ds-key", { provider: "deepseek" }), { ok: true });
  assert.equal(deepseekStore.value, "ds-key");
  assert.equal(service.using, "gemini-key");
  assert.deepEqual(service.calls.at(-1), { probe: "ds-key", route: LOCAL_DEEPSEEK });
});

test("给别家存 key 时可以指定拿哪条路线验证（换成自定义服务的某个模型前先存 key）", async () => {
  const custom = { ...LOCAL_DEEPSEEK, polish: { vendor: "deepseek", model: "deepseek-v4-pro" } };
  const { keys, service } = setup({ stored: "gemini-key", routeFor: () => assert.fail("指定了就不该再问 routeFor") });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save("ds-key", { provider: "deepseek", route: custom }), { ok: true });
  assert.deepEqual(service.calls.at(-1), { probe: "ds-key", route: custom });
});

test("routeFor 说这一家没法验证（比如自定义服务还没填地址）：不存，原因照它说的", async () => {
  const { keys, deepseekStore, service } = setup({
    routeFor: () => {
      throw new LocalizedError(msg("chat.urlMissing"));
    },
  });
  const result = await keys.save("ds-key", { provider: "deepseek" });
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /还没填自定义服务的地址/);
  assert.equal(deepseekStore.value, null);
  assert.deepEqual(service.calls, []);
});

test("检查本地转写链路：用润色那一家的 key", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedDeepseek: "ds-key" });
  const result = await keys.check(LOCAL_DEEPSEEK);
  assert.equal(result.ok, true);
  assert.deepEqual(service.calls, [{ probe: "ds-key", route: LOCAL_DEEPSEEK }]);
});

// ---------- 一条路线要两家的 key（第一跳交给云端、润色交给另一家） ----------

const CLOUD_FIRST_HOP = { ...LOCAL_DEEPSEEK, transcriber: "bailian/qwen3-asr-flash" };

test("第一跳交给百炼、润色交给 DeepSeek：两把都找齐，一起交给服务", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedDeepseek: "ds-key", storedBailian: "bl-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, CLOUD_FIRST_HOP), true);
  assert.equal(keys.provider.id, "deepseek");
  assert.deepEqual(service.calls.at(-1), { useKey: "ds-key", allowUnverified: true, keys: { bailian: "bl-key" } });
});

test("另一家（百炼）没有 key：照样换上，状态说缺的是哪一家，也不拿 DeepSeek 的去验", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedDeepseek: "ds-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, CLOUD_FIRST_HOP), true);
  assert.ok(!service.calls.some((call) => call.useKey === "ds-key"));
  assert.equal(keys.provider.id, "deepseek");
  assert.equal(keys.current.state, "missing");
  assert.deepEqual(keys.current.vendor, { id: "bailian", name: "Bailian" });
  assert.match(zh.text(keys.current.problem), /阿里云百炼 密钥未配置/, "厂商名按界面语言写");
});

test("启动时缺另一家的 key：状态是缺 key，点名是哪一家；存上它之后接着用起来", async () => {
  const { keys, service, bailianStore } = setup({ provider: "deepseek", stored: "ds-key" });
  service.route = CLOUD_FIRST_HOP;
  const state = await keys.loadAtStartup();
  assert.equal(state.state, "missing");
  assert.deepEqual(state.vendor, { id: "bailian", name: "Bailian" });
  assert.deepEqual(await keys.save("bl-key", { provider: "bailian", route: CLOUD_FIRST_HOP }), { ok: true });
  assert.equal(bailianStore.value, "bl-key");
  assert.equal(keys.current.state, "ready");
  assert.deepEqual(service.calls.at(-1).keys, { bailian: "bl-key" });
});

test("检查两家的路线：缺另一家时说去填哪一家；都有时两把一起试", async () => {
  const missing = setup({ storedDeepseek: "ds-key" });
  const result = await missing.keys.check(CLOUD_FIRST_HOP);
  assert.equal(result.cause, "missing");
  assert.match(zh.text(result.problem), /orangespeakeasy key bailian/);
  const both = setup({ storedDeepseek: "ds-key", storedBailian: "bl-key" });
  assert.equal((await both.keys.check(CLOUD_FIRST_HOP)).ok, true);
  assert.deepEqual(both.service.calls, [{ probe: "ds-key", route: CLOUD_FIRST_HOP, keys: { bailian: "bl-key" } }]);
});

test("按旧路线排着、正在验的那一把在换路线后作废：不改状态，也不把那家的 key 带到新的那家", async () => {
  const { keys, service } = setup({ provider: "deepseek", stored: "ds-key" });
  service.route = CLOUD_FIRST_HOP;
  await keys.loadAtStartup();
  assert.equal(keys.current.vendor.id, "bailian");
  let release;
  service.gate = new Promise((resolve) => {
    release = resolve;
  });
  // 存上百炼的 key：整条路线拿 DeepSeek 那把重新验（settle），验到一半换成 Gemini（还没有 key）
  const saving = keys.save("bl-key", { provider: "bailian", route: CLOUD_FIRST_HOP });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    service.calls.some((call) => call.useKey === "ds-key"),
    "已经在验 DeepSeek 那把",
  );
  const result = keys.switchRoute(nativeRoute("gemini", "gemini-3.6-flash"));
  service.gate = null;
  release();
  await saving;
  await result.settled;
  assert.equal(keys.provider.id, "gemini");
  assert.deepEqual(keys.current, { state: "missing", source: null, problem: null });
  // 同一家再换个模型：手里没有 DeepSeek 那把可用
  const before = service.calls.length;
  assert.equal(await switched(keys, nativeRoute("gemini", "gemini-3.8-flash")), true);
  assert.ok(!service.calls.slice(before).some((call) => call.useKey === "ds-key"));
  assert.equal(keys.current.state, "missing");
});

test("删掉正在走的路线里另一家的 key：整条路线停下，状态说缺哪一家", async () => {
  const { keys, service } = setup({ provider: "deepseek", stored: "ds-key", storedBailian: "bl-key" });
  service.route = CLOUD_FIRST_HOP;
  await keys.loadAtStartup();
  assert.equal(keys.current.state, "ready");
  await keys.forget({ provider: "bailian" });
  assert.equal(keys.current.state, "missing");
  assert.equal(keys.current.vendor.id, "bailian");
  assert.equal(service.using, null);
});

// ---------- 别的功能按厂商取 key（划词翻译：和语音那边同一家用同一把） ----------

test("keyOf：环境变量优先，其次存着的；没有是 null；存着的解不开照样抛；正在用的那家给的是这次运行实际在用的那把", async () => {
  const { keys } = setup({ provider: "gemini", stored: "gemini-stored", storedDeepseek: "deepseek-stored" });
  assert.deepEqual(keys.keyOf("deepseek"), { apiKey: "deepseek-stored", source: "stored" });
  assert.equal(keys.keyOf("bailian"), null);
  assert.throws(() => keys.keyOf("nope"), LocalizedError);
  const fromEnv = setup({ env: { DEEPSEEK_API_KEY: " env-key " }, storedDeepseek: "deepseek-stored" });
  assert.deepEqual(fromEnv.keys.keyOf("deepseek"), { apiKey: "env-key", source: "env" });
  const broken = setup({ storedDeepseek: new Error("钥匙串里的密钥没了") });
  assert.throws(() => broken.keys.keyOf("deepseek"), /钥匙串/);
  // 正在用的那家：启动时装上的那把（中途存了新的就是新的）
  const { keys: running } = setup({ stored: "gemini-stored" });
  await running.loadAtStartup();
  await running.save("gemini-new");
  assert.deepEqual(running.keyOf("gemini"), { apiKey: "gemini-new", source: "stored" });
});
