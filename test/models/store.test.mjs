import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createModelStore } from "../../src/models/store.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BYTES = { "a.onnx": Buffer.from("weights ".repeat(1000)), "tokenizer/vocab.json": Buffer.from('{"a":1}') };
const fileOf = (path) => ({ path, size: BYTES[path].length, sha256: sha256(BYTES[path]) });
const MODEL = {
  id: "fake-asr",
  origin: { repo: "someone/fake-asr", revision: "a".repeat(40) },
  mirror: { revision: "c".repeat(40) },
  files: { model: fileOf("a.onnx"), vocab: fileOf("tokenizer/vocab.json") },
};

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CN_HOST = "modelscope.cn";
/** 地址里 resolve/<提交> 后面的就是文件的路径：魔搭和 Hugging Face 都这么排 */
const pathOf = (url) => url.split(/\/resolve\/[^/]+\//)[1];

/** 一个临时的仓，下载走假的 fetch：按地址最后的路径给内容，记下下了哪些 */
function setUp({ serve = (path) => new Response(BYTES[path]) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const fetched = [];
  const fetch = async (url) => {
    const path = pathOf(url);
    fetched.push(path);
    return serve(path);
  };
  return { dir, fetched, store: createModelStore({ dir, fetch }) };
}

test("默认先走国内源：它连不上、回错误码就换原始地址接着下，都不行才报错，报错里列出每个地址的原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    if (host === CN_HOST) return new Response("", { status: 404 });
    if (host === "huggingface.co") throw new TypeError("fetch failed");
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
  const tried = [CN_HOST, "huggingface.co", "hf-mirror.com"];
  assert.deepEqual(hosts, [...tried, ...tried]);

  const failingDir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(failingDir);
  const failing = createModelStore({
    dir: failingDir,
    fetch: async (url) =>
      new URL(url).host === "huggingface.co"
        ? Promise.reject(new TypeError("fetch failed"))
        : new Response("", { status: 503 }),
  });
  await assert.rejects(
    failing.install(MODEL),
    (error) =>
      new RegExp(`${CN_HOST}.*HTTP 503`, "s").test(error.message) &&
      /huggingface\.co.*fetch failed/s.test(error.message) &&
      /hf-mirror\.com.*HTTP 503/s.test(error.message),
  );
});

test("选了原始地址：先从 Hugging Face 下，国内源垫在最后", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    return host === CN_HOST ? new Response(BYTES[pathOf(pathname)]) : new Response("", { status: 503 });
  };
  await createModelStore({ dir, fetch, source: "original" }).install(MODEL);
  assert.deepEqual(hosts.slice(0, 3), ["huggingface.co", "hf-mirror.com", CN_HOST]);
});

test("连上了但迟迟不给数据：到时候放弃这个地址，换下一个", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const fetch = async (url, { signal }) => {
    const { host, pathname } = new URL(url);
    if (host === CN_HOST) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch, stallMs: 50 });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
});

test("装一个模型：文件照清单的路径放好，校验过，写上收据；再装一次不重新下载", async () => {
  const { dir, fetched, store } = setUp();
  const progress = [];
  assert.equal(store.isInstalled(MODEL), false);
  const modelDir = await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.equal(modelDir, join(dir, "fake-asr"));
  assert.deepEqual(readFileSync(join(modelDir, "tokenizer/vocab.json")), BYTES["tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(modelDir, "a.onnx")), BYTES["a.onnx"]);
  assert.equal(store.isInstalled(MODEL), true);
  assert.deepEqual(store.installed(), ["fake-asr"]);
  // 进度按整个模型算：下好的文件算满，正在下的算到哪
  const total = BYTES["a.onnx"].length + 7;
  assert.deepEqual(progress.at(-1), { received: total, total });
  assert.ok(progress.every((p) => p.total === total && p.received <= total));

  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
});

test("内容和 sha256 对不上：报错说清是哪个文件，不留半截文件，也不算装好", async () => {
  const { dir, store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? "tampered" : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx 下载到 8 字节/);
  assert.equal(store.isInstalled(MODEL), false);
  assert.deepEqual(readdirSync(join(dir, "fake-asr")), []);
});

test("大小对但内容不对：报 sha256 对不上", async () => {
  const forged = Buffer.alloc(BYTES["a.onnx"].length, 1);
  const { store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? forged : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx 的 sha256 对不上/);
});

test("服务器回错误码：报出状态码，不当成下载成功", async () => {
  const { store } = setUp({ serve: () => new Response("nope", { status: 404 }) });
  await assert.rejects(store.install(MODEL), /HTTP 404/);
  assert.equal(store.isInstalled(MODEL), false);
});

test("断了重来：已经下好、内容也对的文件不再下载，只补缺的", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  await store.install(MODEL);
  assert.deepEqual(fetched, ["tokenizer/vocab.json"]);
  assert.equal(store.isInstalled(MODEL), true);
});

test("已经在那儿的文件内容不对（下坏了、被改过）：重新下载，不拿来用", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), "stale");
  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), BYTES["a.onnx"]);
});

test("清单换了版本，旧收据就不算数：重新核对文件，内容没变的不重下", async () => {
  const { fetched, store } = setUp();
  await store.install(MODEL);
  const moved = { ...MODEL, origin: { ...MODEL.origin, revision: "b".repeat(40) } };
  assert.equal(store.isInstalled(moved), false);
  await createModelStore({
    dir: dirname(store.dirOf(MODEL)),
    fetch: () => assert.fail("不该下载"),
  }).install(moved);
  assert.equal(store.isInstalled(moved), true);
  assert.equal(fetched.length, 2);
});

test("还差多少字节：没下的文件按清单的大小算，已经在那儿的不算（下载前查磁盘空间用）", async () => {
  const { dir, store } = setUp();
  const total = BYTES["a.onnx"].length + 7;
  assert.equal(store.missingBytes(MODEL), total);
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  assert.equal(store.missingBytes(MODEL), 7);
  await store.install(MODEL);
  assert.equal(store.missingBytes(MODEL), 0);
});

test("断了重来时进度从已经下好的那部分算起，不从零开始", async () => {
  const { dir, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  const progress = [];
  await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.ok(progress[0].received >= BYTES["a.onnx"].length);
});

test("删掉：整个目录都不在了，列表里也没有；没装过的删了也不报错", async () => {
  const { store } = setUp();
  await store.install(MODEL);
  store.remove(MODEL);
  assert.equal(existsSync(store.dirOf(MODEL)), false);
  assert.deepEqual(store.installed(), []);
  store.remove(MODEL);
});

// ---------- 断点续传 ----------

const WEIGHTS = BYTES["a.onnx"];
const HALF = 3000;
const rangeOf = (init) => new Headers(init?.headers).get("range");

/** 先给一截再断掉的响应体：像网络掉线，不是服务器给错了文件。那一截被取走以后才断，和真的掉线一样 */
function cutOff(bytes, fail = () => new TypeError("terminated")) {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(fail());
        sent = true;
        controller.enqueue(bytes);
      },
    }),
  );
}

/** 按 Range 给后半截（206），不带 Range 给整个文件 */
function serveRange(path, init) {
  const range = rangeOf(init);
  if (!range) return new Response(BYTES[path]);
  const from = Number(/^bytes=(\d+)-$/.exec(range)[1]);
  const body = BYTES[path].subarray(from);
  return new Response(body, {
    status: 206,
    headers: { "content-range": `bytes ${from}-${BYTES[path].length - 1}/${BYTES[path].length}` },
  });
}

test("断在半路：留着下好的那截，同一个地址带 Range 从断点接着要，拼起来校验通过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const calls = [];
  const fetch = async (url, init) => {
    const path = pathOf(url);
    calls.push([new URL(url).host, path, rangeOf(init)]);
    if (path === "a.onnx" && calls.filter(([, p]) => p === "a.onnx").length === 1)
      return cutOff(WEIGHTS.subarray(0, HALF));
    return serveRange(path, init);
  };
  const store = createModelStore({ dir, fetch });
  const progress = [];
  await store.install(MODEL, { onProgress: (p) => progress.push(p.received) });
  assert.equal(store.isInstalled(MODEL), true);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.deepEqual(
    calls.filter(([, p]) => p === "a.onnx"),
    [
      [CN_HOST, "a.onnx", null],
      [CN_HOST, "a.onnx", `bytes=${HALF}-`],
    ],
  );
  // 续上的那次进度从断点算起，不倒回零
  assert.ok(
    progress.slice(progress.indexOf(HALF)).every((value) => value >= HALF),
    String(progress),
  );
});

test("上次断在半路留下的 .part：这次启动直接从那里接着下，不从零开始", async () => {
  const { dir, store } = setUp({ serve: (path) => path });
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), WEIGHTS.subarray(0, HALF));
  const ranges = [];
  const resumed = createModelStore({
    dir,
    fetch: async (url, init) => {
      ranges.push([pathOf(url), rangeOf(init)]);
      return serveRange(pathOf(url), init);
    },
  });
  await resumed.install(MODEL);
  assert.deepEqual(ranges, [
    ["a.onnx", `bytes=${HALF}-`],
    ["tokenizer/vocab.json", null],
  ]);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.equal(existsSync(join(dir, "fake-asr", "a.onnx.part")), false);
  assert.equal(store.isInstalled(MODEL), true);
});

test("服务器不认 Range、给了整个文件（200）：丢掉那截从头写，不把整个文件接在半截后面", async () => {
  const { dir } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), WEIGHTS.subarray(0, HALF));
  const store = createModelStore({ dir, fetch: async (url) => new Response(BYTES[pathOf(url)]) });
  await store.install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
});

test("续上的那段起点对不上（Content-Range 不是从断点开始）：不拼，那截删掉，换下一个地址从头下", async () => {
  const { dir } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), WEIGHTS.subarray(0, HALF));
  const calls = [];
  const store = createModelStore({
    dir,
    fetch: async (url, init) => {
      const { host } = new URL(url);
      const path = pathOf(url);
      calls.push([host, path, rangeOf(init)]);
      if (host === CN_HOST && rangeOf(init)) {
        return new Response(WEIGHTS.subarray(10), {
          status: 206,
          headers: { "content-range": `bytes 10-${WEIGHTS.length - 1}/${WEIGHTS.length}` },
        });
      }
      return serveRange(path, init);
    },
  });
  await store.install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.deepEqual(
    calls.filter(([, p]) => p === "a.onnx"),
    [
      [CN_HOST, "a.onnx", `bytes=${HALF}-`],
      ["huggingface.co", "a.onnx", null],
    ],
  );
});

test("留下的那截比文件还大（换了版本、写坏了）：不拿来续，删掉从头下", async () => {
  const { dir, store, fetched } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), Buffer.alloc(WEIGHTS.length + 5, 7));
  await store.install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
});

test("续完 sha256 对不上（留下的那截是坏的）：那截删掉，换下一个地址从头下，不留着下次再续出同样的错", async () => {
  const { dir } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), Buffer.alloc(HALF, 1));
  const calls = [];
  const store = createModelStore({
    dir,
    fetch: async (url, init) => {
      calls.push([new URL(url).host, pathOf(url), rangeOf(init)]);
      return serveRange(pathOf(url), init);
    },
  });
  await store.install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.deepEqual(
    calls.filter(([, p]) => p === "a.onnx"),
    [
      [CN_HOST, "a.onnx", `bytes=${HALF}-`],
      ["huggingface.co", "a.onnx", null],
    ],
  );
});

test("每个地址都给坏内容：报 sha256 对不上，不留下那截", async () => {
  const forged = Buffer.alloc(WEIGHTS.length, 1);
  const { dir, store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? forged : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx 的 sha256 对不上/);
  assert.equal(existsSync(join(dir, "fake-asr", "a.onnx.part")), false);
});

test("卡住了换下一个地址：已经下好的那截带过去，在下一个地址从断点接着下", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const calls = [];
  const fetch = async (url, init) => {
    const { host } = new URL(url);
    const path = pathOf(url);
    calls.push([host, path, rangeOf(init)]);
    if (host === CN_HOST && path === "a.onnx") {
      // 给一截以后再也不给数据
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(WEIGHTS.subarray(0, HALF));
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
          },
        }),
      );
    }
    return serveRange(path, init);
  };
  const store = createModelStore({ dir, fetch, stallMs: 50 });
  await store.install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.deepEqual(
    calls.filter(([, p]) => p === "a.onnx"),
    [
      [CN_HOST, "a.onnx", null],
      ["huggingface.co", "a.onnx", `bytes=${HALF}-`],
    ],
  );
});

test("同一个地址每次都断但每次都有进展：接着续，续到下完；一点进展都没有才换地址", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const step = 1000;
  const ranges = [];
  const fetch = async (url, init) => {
    const path = pathOf(url);
    if (path !== "a.onnx") return serveRange(path, init);
    const range = rangeOf(init);
    ranges.push(range);
    const from = range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0;
    const chunk = WEIGHTS.subarray(from, from + step);
    if (from + step >= WEIGHTS.length) return serveRange(path, init);
    const headers = range ? { "content-range": `bytes ${from}-${WEIGHTS.length - 1}/${WEIGHTS.length}` } : {};
    const response = cutOff(chunk);
    return new Response(response.body, { status: range ? 206 : 200, headers });
  };
  await createModelStore({ dir, fetch }).install(MODEL);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);
  assert.equal(ranges.length, Math.ceil(WEIGHTS.length / step));
});

test("用户取消：下好的那截留着，下次接着下", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-models-"));
  dirs.push(dir);
  const controller = new AbortController();
  const fetch = async (url, init) =>
    cutOff(BYTES[pathOf(url)].subarray(0, HALF), () => {
      controller.abort(new Error("用户取消"));
      return init.signal.reason;
    });
  await assert.rejects(createModelStore({ dir, fetch }).install(MODEL, { signal: controller.signal }), /用户取消/);
  assert.equal(readFileSync(join(dir, "fake-asr", "a.onnx.part")).length, HALF);
});

test("上次其实下完了、只是没来得及改名：对得上直接用，不再要；对不上删掉从头下", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), WEIGHTS);
  await store.install(MODEL);
  assert.deepEqual(fetched, ["tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), WEIGHTS);

  const other = setUp();
  mkdirSync(join(other.dir, "fake-asr"), { recursive: true });
  writeFileSync(join(other.dir, "fake-asr", "a.onnx.part"), Buffer.alloc(WEIGHTS.length, 2));
  await other.store.install(MODEL);
  assert.deepEqual(other.fetched, ["a.onnx", "tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(other.dir, "fake-asr", "a.onnx")), WEIGHTS);
});

test("还差多少字节：下了一截的文件只算还没下的那部分", () => {
  const { dir, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx.part"), WEIGHTS.subarray(0, HALF));
  assert.equal(store.missingBytes(MODEL), WEIGHTS.length - HALF + 7);
});
