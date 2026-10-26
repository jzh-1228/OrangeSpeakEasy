import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyManager } from "../../src/app/keys/key-manager.mjs";
import { createModeSwitch } from "../../src/app/modes.mjs";
import { startService } from "../../src/app/service.mjs";
import { keyVendorOf } from "../../src/server/modes.mjs";
import { VENDORS } from "../../src/server/vendors.mjs";
import { resolveSettings, routeOf } from "../../src/storage/settings.mjs";

// 内核整套拼起来：真的服务、真的 refiner、真的 key 管理和模式切换，只有各家的接口（下面的 fetch）和本机模型是假的。
// key-manager.test.mjs、modes.test.mjs 用的假服务不管路线里有几家、要不要 key，跨好几层的错在那边测不出来。
// 引用它的测试文件各自一个进程（node --test），换掉全局的 fetch 不会影响别的文件。

/** 认这几把，别的回 401 */
const GOOD = new Set(["bl-good", "ds-good", "kimi-good"]);

/** 发出去的请求：哪个地址、带的哪把 key */
export const requests = [];

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const key = String(init.headers?.Authorization ?? "").replace(/^Bearer /, "");
  requests.push({ url: String(url), key });
  if (!GOOD.has(key)) return reply({ error: { code: "invalid_api_key", message: "Incorrect API key provided" } }, 401);
  const body = JSON.parse(init.body);
  return reply({
    model: body.model,
    choices: [{ message: { content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, seconds: 1 },
  });
};

const fakeStore = (value = null) => ({
  value,
  load() {
    return this.value;
  },
  save(next) {
    this.value = next;
  },
  clear() {
    this.value = null;
  },
  exists() {
    return this.value !== null;
  },
});
const silent = { info() {}, warn() {}, error() {} };

/**
 * 按给的设置和存着的 key 启动一套。服务在测试结束时关掉（没过也关，不然进程退不出来）
 * @param {import("node:test").TestContext} t
 * @param {{ settings: object, stored?: Record<string, string>, installed?: string[] }} options
 *   installed：下载好了的本机模型，不写就是都下好了
 */
export async function boot(t, { settings, stored = {}, installed = null }) {
  const home = mkdtempSync(join(tmpdir(), "orangespeakeasy-routes-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settingsFile = join(home, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  const route = routeOf(resolveSettings({ file: settingsFile, env: {} }));
  const keyStores = Object.fromEntries(VENDORS.map(({ id }) => [id, fakeStore(stored[id] ?? null)]));
  const models = {
    isInstalled: (id) => installed === null || installed.includes(id),
    status: () => ({ download: null }),
    remove: (id) => ({ ok: true, removed: id }),
  };
  const service = await startService({
    log: silent,
    route,
    modelsDir: home,
    models,
    startLocal: async () => ({ backend: "cpu", transcribe: async () => ({ text: "" }), dispose() {} }),
  });
  t.after(() => service.close());
  let modes;
  const keys = createKeyManager({
    service,
    provider: keyVendorOf(route) ?? null,
    keyStores,
    env: {},
    log: silent,
    onChange() {},
    routeFor: (id) => modes.routeForVendor(id),
  });
  modes = createModeSwitch({ service, keys, models, settingsFile, env: {}, log: silent });
  /** 设置文件里现在存着什么 */
  const saved = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  return { service, keys, modes, keyStores, saved };
}

/** 照页面那样听写一次（协议见 src/server/server.mjs），交回服务最后说的那句 */
export function dictateOnce(url) {
  const chunk = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const audioId = crypto.randomUUID();
    socket.onerror = () => reject(new Error("连不上内置服务"));
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start_audio", audio_id: audioId }));
      socket.send(JSON.stringify({ type: "set_audio_chunk_info", audio_id: audioId, index: 1, size: chunk.length }));
      socket.send(chunk);
      socket.send(JSON.stringify({ type: "end_audio", audio_id: audioId }));
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.K !== "audio_processing_completed" && message.K !== "audio_processing_error") return;
      socket.close();
      resolve(message);
    };
  });
}
