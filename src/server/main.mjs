import { log } from "../log.mjs";
import { findModel } from "../models/catalog.mjs";
import { createModelStore } from "../models/store.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { openVocabulary } from "../storage/vocabulary.mjs";
import { startTranscriber } from "./asr/start.mjs";
import { loadConfig } from "./config.mjs";
import { createModeRefiner, describeRoute, usesLocalModel } from "./modes.mjs";
import { findProvider } from "./providers/index.mjs";
import { startServer, WS_PATH } from "./server.mjs";

let config;
/** 本地模型放在哪：只有本地转写链路用得上 */
let modelsDir = null;
/** 用户的词典：和后台应用读的是同一份（ORANGESPEAKEASY_HOME 下的 vocabulary.json） */
let vocabulary;
try {
  config = loadConfig(process.env);
  const paths = resolvePaths(process.env);
  if (usesLocalModel(config.route)) modelsDir = paths.modelsDir;
  vocabulary = openVocabulary(paths.vocabularyFile);
} catch (error) {
  // 配置写错是使用上的问题，给一句人话就够了，不需要调用栈
  console.error(error.message);
  process.exit(2);
}
const { route, keys } = config;

/** 下载进度每 10% 记一行，不刷屏 */
function progressLogger(modelId) {
  let reported = -1;
  return ({ received, total }) => {
    const percent = Math.floor((received / total) * 10) * 10;
    if (percent === reported) return;
    reported = percent;
    log.info("model_download_progress", { model: modelId, percent });
  };
}

// 本地转写链路先把模型准备好，装进转写进程。单独启动服务端是开发时用的：用的人明说了要 local，没下载过就直接下
// （App 里不这样，下不下由用户点）
if (usesLocalModel(route)) {
  const store = createModelStore({ dir: modelsDir, source: config.modelSource });
  const model = findModel(route.transcriber);
  if (!store.isInstalled(model)) {
    log.info("model_downloading", { model: model.id, source: config.modelSource });
    await store.install(model, { onProgress: progressLogger(model.id) });
  }
}
const transcriber = usesLocalModel(route)
  ? await startTranscriber({ modelId: route.transcriber, modelsDir, log })
  : null;
const refiner = await createModeRefiner({ route, keys, transcriber, log });

let server;
try {
  server = await startServer({ host: config.host, port: config.port, refiner, log, vocabulary: vocabulary.terms });
} catch (error) {
  if (error.code !== "EADDRINUSE") throw error;
  // 最常见的原因是已经开着一个了，给一句人话，不甩调用栈
  console.error(`端口 ${config.port} 已经被占用：服务端可能已经在运行。要另开一个就用 PORT 换端口。`);
  transcriber?.dispose();
  process.exit(1);
}
log.info("listening", {
  url: `ws://${config.host}:${server.port}${WS_PATH}`,
  route: describeRoute(route),
  // 思考档位只有 Gemini 用得上，别家不写，免得看日志的人以为它起了作用
  ...(route.mode === "native" && findProvider(route.model.provider).thinkingLevels
    ? { thinking_level: route.thinkingLevel }
    : {}),
  ...(transcriber ? { transcriber_backend: transcriber.backend } : {}),
});

// 不等它：预热失败不该拦着服务启动，但要让人看得见
const warmUpStartedAt = performance.now();
refiner.warmUp().then(
  () => log.info("warmed_up", { ms: Math.round(performance.now() - warmUpStartedAt) }),
  (error) => log.error("warm_up_failed", { route: describeRoute(route), error: error.message, detail: error.detail }),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    log.info("shutting_down", { signal });
    transcriber?.dispose();
    await server.close();
    process.exit(0);
  });
}
