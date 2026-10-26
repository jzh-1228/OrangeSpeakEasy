import { msg } from "../../i18n/index.mjs";
import { downloadSize, findModel } from "../../models/catalog.mjs";
import { sizeText } from "../../models/describe.mjs";
import { createModelStore } from "../../models/store.mjs";
import { currentSettings } from "../common.mjs";

// 命令行里的本机模型：下没下载、下载并等它下完、要用却没下载时先问一句。
// 下载由用户点：orangespeakeasy transcriber download，或者要用一个没下载的模型时答"是"。
// 后台在运行就交给它下（和设置页里看到的是同一个下载）；没在运行就在这个进程里下。

/** 等后台下载时多久看一次进度 */
const POLL_MS = 500;

/**
 * 某个模型现在怎样：后台在运行且报了每个模型的情况（0.7.1 起）就以它为准，否则看文件
 * @returns {{ installed: boolean, download: { received: number, total: number } | null, problem: string | null }}
 */
export function modelStatus(io, status, id) {
  const reported = status?.localModels?.find((model) => model.id === id);
  if (reported) return reported;
  const installed = createModelStore({ dir: io.paths.modelsDir }).isInstalled(findModel(id));
  return { installed, download: null, problem: null };
}

/** 进度每过 10% 说一行 */
function progressPrinter(io) {
  let reported = -1;
  return ({ received, total }) => {
    const percent = Math.floor((received / total) * 10) * 10;
    if (percent === reported) return;
    reported = percent;
    io.out(io.t("cli.local.downloadProgress", { percent, received: sizeText(received), total: sizeText(total) }));
  };
}

/**
 * 下载一个本机模型，等它下完。后台在运行就交给它下：这时按 Ctrl-C 只是不看了，下载在后台接着进行
 * @returns {Promise<boolean>} 下好了没有
 */
export async function downloadAndWait(io, id) {
  const model = findModel(id);
  const status = await io.daemon.status();
  if (modelStatus(io, status, id).installed) {
    io.out(io.t("cli.local.downloadAlready", { model: model.name }));
    return true;
  }
  const source = currentSettings(io).modelSource.value;
  io.out(
    io.t("cli.local.downloadStart", {
      model: model.name,
      size: sizeText(downloadSize(model)),
      source: io.t(`modelSources.${source}`),
    }),
  );
  const print = progressPrinter(io);
  // 0.7.0 及以前的后台不报每个模型的情况，也不认下载这条命令：在这个进程里下
  if (status?.localModels) return viaDaemon(io, model, print);
  return inProcess(io, model, source, print);
}

async function viaDaemon(io, model, print) {
  const started = await io.daemon.request("download-model", { id: model.id });
  if (!started.ok) {
    io.err(io.t("common.sentence", { text: started.problem }));
    return false;
  }
  io.out(io.t("cli.local.downloadBackground", { id: model.id }));
  for (;;) {
    const status = await io.daemon.status();
    const now = status?.localModels?.find(({ id }) => id === model.id);
    if (!now) {
      // 后台在下载途中退出了：已经下好的文件留着，下次接着下
      io.err(io.t("cli.local.downloadInterrupted", { id: model.id }));
      return false;
    }
    if (now.installed) break;
    if (now.download) print(now.download);
    else if (now.problem) {
      io.err(io.t("common.sentence", { text: now.problem }));
      return false;
    } else {
      io.err(io.t("cli.local.downloadStopped", { model: model.name }));
      return false;
    }
    await io.sleep(POLL_MS);
  }
  io.out(io.t("cli.local.downloadDone", { model: model.name }));
  return true;
}

async function inProcess(io, model, source, print) {
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const models = io.localModels({
    source,
    onChange: () => {
      const now = models.status(model.id);
      if (now.download) print(now.download);
      else settle(now);
    },
  });
  const started = await models.download(model.id);
  if (!started.ok) {
    io.err(io.t("common.sentence", { text: started.problem }));
    return false;
  }
  const now = await finished;
  if (!now.installed) {
    io.err(io.t("common.sentence", { text: now.problem ?? msg("cli.local.downloadStopped", { model: model.name }) }));
    return false;
  }
  io.out(io.t("cli.local.downloadDone", { model: model.name }));
  return true;
}

/**
 * 要用的本机模型还没下载时：能问就问一句要不要现在下（默认不下），答"是"就下完再往下走；
 * 不能问就说先运行哪条命令
 * @returns {Promise<boolean>} 现在下载好了没有
 */
export async function offerDownload(io, id) {
  const model = findModel(id);
  if (!io.interactive) {
    io.err(io.t("cli.local.notDownloadedHint", { model: model.name, id }));
    return false;
  }
  const source = currentSettings(io).modelSource.value;
  const question = io.t("cli.local.notDownloadedAsk", {
    model: model.name,
    size: sizeText(downloadSize(model)),
    source: io.t(`modelSources.${source}`),
  });
  if (!(await io.confirm(question))) {
    io.out(io.t("cli.local.notDownloadedLater", { id }));
    return false;
  }
  return downloadAndWait(io, id);
}
