import { msg } from "../../i18n/index.mjs";
import { measuredText, sizeText, tagTexts } from "../../models/describe.mjs";
import { findChatVendor } from "../../server/chat/vendors.mjs";
import { findProvider } from "../../server/providers/index.mjs";
import { displayWidth, INDENT, padEnd, paint } from "./text.mjs";

// 识别模式（orangespeakeasy mode），和 local 模式的两跳（orangespeakeasy transcriber、orangespeakeasy polish）。
// native 的模型照旧在 models.mjs（orangespeakeasy model）。

/** "DeepSeek 的 deepseek-flash"；自定义服务写它的主机名："127.0.0.1:11434 的 qwen3:8b"。一句 msg */
export function polishTitle({ vendor, model }, customUrl) {
  const name = vendor === "custom" && customUrl ? new URL(customUrl).host : findChatVendor(vendor).name;
  return msg("cli.model.describe", { provider: name, model });
}

/** 一条路线用的模型，写成一句话（msg）：native 是那一家的模型，local 是 第一跳 → 第二跳，private 是那个本机模型 */
export function routeTitle(route) {
  if (route.mode === "native") {
    return msg("cli.model.describe", { provider: findProvider(route.model.provider).name, model: route.model.model });
  }
  if (route.mode === "private") return msg("cli.modes.privateRoute", { transcriber: route.transcriber });
  return msg("cli.modes.localRoute", {
    transcriber: route.transcriber,
    polish: polishTitle(route.polish, route.customUrl),
  });
}

/**
 * @param {object} view
 * @param {Record<string, object>} view.routes 每种模式按现在的设置走哪条路线
 * @param {string} view.current 现在是哪种模式
 * @param {{ color: boolean, t: Function }} options
 */
export function renderModes({ routes, current }, { color, t }) {
  const c = paint(color);
  const ids = Object.keys(routes);
  const idWidth = Math.max(...ids.map((id) => id.length)) + 3;
  const labelWidth = Math.max(...ids.map((id) => displayWidth(t(`modes.${id}`)))) + 3;
  const lines = [t("cli.modes.title"), ""];
  for (const id of ids) {
    const mark = id === current ? c.green("●") : " ";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(id, idWidth))}${padEnd(t(`modes.${id}`), labelWidth)}${t.text(routeTitle(routes[id]))}`,
    );
  }
  const others = ids.filter((id) => id !== current);
  lines.push(
    "",
    `${INDENT}${t("cli.modes.switch", { mode: others.join(" / ") })}`,
    `${INDENT}${t("cli.modes.nativeModels")}`,
    `${INDENT}${t("cli.modes.localHops")}`,
    `${INDENT}${t("cli.modes.privateModel")}`,
    `${INDENT}${t("cli.modes.withSettings")}`,
    "",
  );
  return lines.join("\n");
}

/** 不在用本机模型的模式（local、private）时：列出来看可以，开头说一句现在用不上 */
const notInLocal = (t, current) =>
  current === "local" || current === "private" ? [] : [`${INDENT}${t("cli.local.notInLocal", { current })}`, ""];

/**
 * 第一跳：本机转写模型。每个模型下好了没有、正在下到哪、下过一半的、上次没下下来的；最后说本机下了几个、磁盘剩多少，
 * 怎么下载、删除、换、换下载源
 * @param {object} view
 * @param {ReadonlyArray<{ id: string, name: string, bytes: number, installed: boolean,
 *   download?: { received: number, total: number } | null, partial?: number, problem?: string | null,
 *   tags: readonly string[], measured: readonly object[] }>} view.models
 * @param {string | null} view.chip 这台机器是哪类芯片（catalog.mjs 的 chipOf）
 * @param {number | null} view.freeBytes 模型目录那块磁盘还剩多少，查不了是 null
 * @param {string} view.setting 设置里选的那个
 * @param {string} view.source 设置里的下载源
 * @param {readonly string[]} view.sources 能选的下载源
 * @param {string} view.current 现在是哪种模式
 * @param {{ color: boolean, t: Function }} options
 */
export function renderTranscribers({ models, chip, freeBytes, setting, source, sources, current }, { color, t }) {
  const c = paint(color);
  const idWidth = Math.max(...models.map(({ id }) => id.length)) + 3;
  const nameWidth = Math.max(...models.map(({ name }) => displayWidth(name))) + 3;
  const sizeWidth = Math.max(...models.map(({ bytes }) => sizeText(bytes).length)) + 3;
  const lines = [t("cli.local.transcribersTitle"), "", ...notInLocal(t, current)];
  for (const model of models) {
    const mark = model.id === setting ? c.green("●") : " ";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(model.id, idWidth))}${padEnd(model.name, nameWidth)}${padEnd(sizeText(model.bytes), sizeWidth)}${stateText(model, t, c)}`,
    );
    const under = `${INDENT}  ${" ".repeat(idWidth)}`;
    lines.push(c.dim(`${under}${tagTexts(model.tags).map(t.text).join(" · ")}`));
    lines.push(c.dim(`${under}${t.text(measuredText(model.measured, chip))}`));
    if (model.problem && !model.download) lines.push(`${under}${c.red(t.text(model.problem))}`);
  }
  const installed = models.filter((model) => model.installed);
  const summary = [
    t("cli.local.summary", {
      count: String(installed.length),
      all: String(models.length),
      size: sizeText(installed.reduce((sum, model) => sum + model.bytes, 0)),
    }),
  ];
  if (freeBytes !== null) summary.push(t("cli.local.freeSpace", { size: sizeText(freeBytes) }));
  const missing = models.find((model) => !model.installed) ?? models[0];
  const other = models.find(({ id, installed: done }) => id !== setting && done);
  const otherSource = sources.find((id) => id !== source);
  lines.push(
    "",
    `${INDENT}${summary.join(" · ")}`,
    `${INDENT}${t("cli.local.transcriberCurrent", { model: setting })}`,
    ...(other ? [`${INDENT}${t("cli.local.transcriberSwitch", { id: other.id })}`] : []),
    `${INDENT}${t("cli.local.transcriberManage", { id: missing.id })}`,
    `${INDENT}${t("cli.local.sourceCurrent", { source: t(`modelSources.${source}`) })}`,
    `${INDENT}${t("cli.local.sourceSwitch", { other: otherSource })}`,
    "",
  );
  return lines.join("\n");
}

/** 一个本机模型的状态：下好了 / 下载中 x% / 下了 x% / 没下下来 / 还没下载 */
function stateText(model, t, c) {
  if (model.download) {
    const { received, total } = model.download;
    return c.yellow(t("cli.local.downloading", { percent: Math.floor((received / total) * 100) }));
  }
  if (model.installed) return t("cli.local.installed");
  if (model.problem) return c.red(t("cli.local.downloadFailed"));
  if (model.partial > 0)
    return c.dim(t("cli.local.partial", { percent: Math.floor((model.partial / model.bytes) * 100) }));
  return c.dim(t("cli.local.notInstalled"));
}

/** 一家的 key 在哪，写成什么 */
const keyText = (t, vendor, where) => {
  if (where === "stored") return t("cli.models.keyStored");
  if (where === "env") return t("cli.models.keyEnv", { variable: vendor.keyEnv });
  return t("cli.models.noKey");
};

/**
 * 第二跳：润色的那几家
 * @param {object} view
 * @param {ReadonlyArray<{ id: string, name: string, keyEnv: string, defaultModel: string | null, models: ReadonlyArray<{ id: string }> }>} view.vendors
 * @param {{ vendor: string, model: string }} view.polish 设置里选的那个
 * @param {string} view.customUrl 设置里的自定义地址（没填是空的）
 * @param {string} [view.customParams] 设置里自定义服务的额外参数（一行 JSON，没填是空的）
 * @param {Record<string, "stored" | "env" | null>} view.keys
 * @param {string} view.current 现在是哪种模式
 * @param {{ color: boolean, t: Function }} options
 */
export function renderPolish({ vendors, polish, customUrl, customParams = "", keys, current }, { color, t }) {
  const c = paint(color);
  const nameOf = (vendor) => (vendor.id === "custom" ? t("cli.local.customName") : vendor.name);
  const modelOf = (vendor) => {
    if (vendor.id === polish.vendor) return polish.model;
    return vendor.defaultModel ? t("cli.models.default", { model: vendor.defaultModel }) : t("cli.local.customModel");
  };
  const idWidth = Math.max(...vendors.map(({ id }) => id.length)) + 3;
  const nameWidth = Math.max(...vendors.map((vendor) => displayWidth(nameOf(vendor)))) + 3;
  const modelWidth = Math.max(...vendors.map((vendor) => displayWidth(modelOf(vendor)))) + 3;
  const lines = [t("cli.local.polishTitle"), "", ...notInLocal(t, current)];
  for (const vendor of vendors) {
    const mark = vendor.id === polish.vendor ? c.green("●") : " ";
    const key = keyText(t, vendor, keys[vendor.id]);
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(vendor.id, idWidth))}${padEnd(nameOf(vendor), nameWidth)}${padEnd(modelOf(vendor), modelWidth)}${keys[vendor.id] ? key : c.dim(key)}`,
    );
    // 能挑的别的模型列在下面一行
    const ids = vendor.models.map(({ id }) => id);
    const others = ids.filter((model) => model !== modelOf(vendor) && model !== vendor.defaultModel);
    const listed = vendor.id === polish.vendor ? ids.filter((model) => model !== polish.model) : others;
    if (listed.length > 0) {
      lines.push(
        c.dim(
          `${INDENT}  ${" ".repeat(idWidth + nameWidth)}${t("cli.local.alsoModels", { models: listed.join(" / ") })}`,
        ),
      );
    }
  }
  const url = polish.vendor === "custom" && customUrl ? customUrl : null;
  const params = polish.vendor === "custom" && customParams ? customParams : null;
  lines.push(
    "",
    `${INDENT}${t("cli.local.polishCurrent", { model: t.text(polishTitle(polish, url)) })}`,
    ...(params ? [`${INDENT}${t("cli.local.polishParams", { params })}`] : []),
    `${INDENT}${t("cli.local.polishSwitch")}`,
    `${INDENT}${t("cli.local.polishCustom")}`,
    `${INDENT}${t("cli.local.polishCheck")}`,
    "",
  );
  return lines.join("\n");
}
