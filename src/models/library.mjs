import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { msg, problemOf } from "../i18n/index.mjs";
import { downloadSize, findModel, MODELS } from "./catalog.mjs";
import { sizeText } from "./describe.mjs";
import { createModelStore } from "./store.mjs";

// 本机的模型库：配置表（models/catalog.mjs）里的模型，哪些下好了、哪些正在下、下到哪、上次为什么没下下来；
// 下载、取消、删除都由用户点（设置里的"模型"页、orangespeakeasy transcriber），这里不自己下。
// 下载前先查磁盘空间。几个模型可以同时下，各下各的。
// 和识别模式无关：哪种模式里都能下、能删。正在用的不能删，这条规矩在模式那一层（app/modes.mjs 的 removeModel）。
// App 和命令行（后台没在运行时）用的都是它。

/** 下载进度最多这么久报一次，不刷屏 */
const PROGRESS_EVERY_MS = 500;
/** 下完还要留这么多磁盘给别的：塞满磁盘的话系统和别的程序都会出问题 */
const DISK_HEADROOM = 200_000_000;

/** 模型目录所在的那块磁盘还剩多少字节。目录还没建的话看它最近的上一级 */
export function freeBytesAt(dir) {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const { bavail, bsize } = statfsSync(at);
  return bavail * bsize;
}

/**
 * @param {object} options
 * @param {string} options.dir 模型放在哪（storage/paths.mjs 的 modelsDir）
 * @param {string} options.source 先从哪个下载源下（设置里的 modelSource，models/catalog.mjs 的 SOURCES）
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {(id: string) => void} [options.onChange] 某个模型的状态变了（开始下、进度、下好了、没下下来、取消、删了）
 * @param {typeof createModelStore} [options.createStore] 测试时换成假的
 * @param {(dir: string) => number} [options.freeBytes] 测试时换成假的
 */
export function createLocalModels({
  dir,
  source: initialSource,
  log,
  onChange = () => {},
  createStore = (options) => createModelStore(options),
  freeBytes = freeBytesAt,
}) {
  let source = initialSource;
  let store = createStore({ dir, source });
  /** 正在下的：id → { abort, received, total } */
  const downloads = new Map();
  /** 上一次没下下来的原因（msg）：id → problem。再下、删掉时清掉 */
  const problems = new Map();

  const modelOf = (id) => {
    const model = findModel(id);
    if (!model) throw new Error(`模型清单里没有 ${id}`);
    return model;
  };

  /** 一个模型现在怎样。partial：没下好时已经在那儿的字节（下过一半） */
  function status(id) {
    const model = modelOf(id);
    const installed = store.isInstalled(model);
    const job = downloads.get(id);
    return {
      id,
      installed,
      download: job ? { received: job.received, total: job.total } : null,
      partial: installed ? 0 : downloadSize(model) - store.missingBytes(model),
      problem: problems.get(id) ?? null,
    };
  }

  function start(model) {
    const job = { abort: new AbortController(), received: 0, total: downloadSize(model) };
    downloads.set(model.id, job);
    problems.delete(model.id);
    let reportedAt = Number.NEGATIVE_INFINITY;
    const startedAt = performance.now();
    log.info("model_downloading", { model: model.id, bytes: job.total, source });
    onChange(model.id);
    store
      .install(model, {
        signal: job.abort.signal,
        onProgress: ({ received }) => {
          job.received = received;
          const now = performance.now();
          if (now - reportedAt < PROGRESS_EVERY_MS) return;
          reportedAt = now;
          onChange(model.id);
        },
      })
      .then(
        () => {
          if (downloads.get(model.id) !== job) return;
          downloads.delete(model.id);
          log.info("model_downloaded", { model: model.id, ms: Math.round(performance.now() - startedAt), source });
          onChange(model.id);
        },
        (error) => {
          // 被停下的（取消、删除、换源）由 stop 交代过了
          if (downloads.get(model.id) !== job) return;
          downloads.delete(model.id);
          log.error("model_download_failed", { model: model.id, source, error: String(error?.stack ?? error) });
          problems.set(model.id, msg("localModels.downloadFailed", { model: model.name, reason: problemOf(error) }));
          onChange(model.id);
        },
      );
  }

  /** 停下某个正在下的，不算失败；reason 是为什么停（cancelled：用户取消、删除、退出；restart：换了源接着下） */
  function stop(id, reason) {
    const job = downloads.get(id);
    if (!job) return false;
    downloads.delete(id);
    job.abort.abort(new Error(reason));
    log.info("model_download_stopped", { model: id, reason, received: job.received, total: job.total });
    return true;
  }

  return {
    dir,

    /** 配置表里的每个模型现在怎样，顺序同配置表 */
    list: () => MODELS.map(({ id }) => status(id)),

    status,

    isInstalled: (id) => store.isInstalled(modelOf(id)),

    /**
     * 开始下载一个模型（在后台下，不等它下完）。已经下好、正在下的什么都不做。
     * 下之前查磁盘：剩的不够还差的那些（加上余量）就不下
     * @returns {Promise<{ ok: true } | { ok: false, problem: object }>}
     */
    async download(id) {
      const model = findModel(id);
      if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
      if (store.isInstalled(model) || downloads.has(id)) return { ok: true };
      const need = store.missingBytes(model);
      let free;
      try {
        free = freeBytes(dir);
      } catch (error) {
        // 查不了就不拦：下的时候写不进去照样会报出来
        log.warn("disk_space_unknown", { dir, error: String(error) });
        free = Number.POSITIVE_INFINITY;
      }
      if (free < need + DISK_HEADROOM) {
        log.warn("model_download_no_space", { model: id, need, free });
        return {
          ok: false,
          problem: msg("localModels.noSpace", { model: model.name, need: sizeText(need), free: sizeText(free) }),
        };
      }
      start(model);
      return { ok: true };
    },

    /** 取消正在下的：停下来，不算失败。下完、校验过的文件留着；下到一半的那个不留（store.mjs 不续传），下次从头来 */
    cancel(id) {
      if (stop(id, "cancelled")) onChange(id);
    },

    /**
     * 删掉一个模型（下过一半的也删）。正在下的先停下。正在用的能不能删由模式那一层管，这里不管
     * @returns {{ ok: true }}
     */
    remove(id) {
      const model = modelOf(id);
      stop(id, "cancelled");
      store.remove(model);
      problems.delete(id);
      log.info("model_removed", { model: id });
      onChange(id);
      return { ok: true };
    },

    /** 换下载源：以后的下载用新的；正在下的停下，从新的源接着下（已经下好的文件不重下） */
    setSource(next) {
      if (next === source) return;
      log.info("model_source_changed", { from: source, to: next, downloading: [...downloads.keys()] });
      source = next;
      store = createStore({ dir, source });
      for (const id of [...downloads.keys()]) {
        stop(id, "restart");
        start(modelOf(id));
      }
    },

    /** 退出时停下所有正在下的 */
    close() {
      for (const id of [...downloads.keys()]) stop(id, "cancelled");
    },
  };
}
