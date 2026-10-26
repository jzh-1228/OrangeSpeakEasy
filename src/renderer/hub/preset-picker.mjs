import { $, h, progressBadge, svg } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { describeError } from "../shared/setup-text.mjs";
import { createChecks } from "./checks.mjs";
import { hopChain, needText } from "./route-view.mjs";
import { toast } from "./toast.mjs";

// 引擎页标题行右边的推荐组合（models/presets.mjs，主进程拼好，随 getSetup 来）：一个按钮，点开一列（picker.css）。
// 一项一行：左边名字和识别方式、说明、一路经过的模型，右边每月多少钱（每天 100 次）和启用；正在用的那项实底、描主题色边，
// 其余平铺。检测把这一套整条走一遍（用到本机模型的念一句交给它转，用到云端的拿这套设置发最小的请求），不换掉正在用的；
// 启用交给主进程切（app/modes.mjs 的 switchMode，当场换上，还差的照实写着）。
// 还差什么的，左边那一行写出来，右边是去补的按钮：缺 key 去密钥面板展开那一家，没下载就在这里下（显示进度）。

/**
 * @param {object} options
 * @param {() => Promise<object>} options.refresh 重读状态，整个窗口跟着更新
 * @param {(platform: string) => void} options.configureKey 去密钥表展开那一家的表单
 */
export function createPresetPicker({ refresh, configureKey }) {
  /** 最近一次拿到的状态 */
  let setup = null;
  /** 正在启用、或正在发起下载的那一项（id）；没有是 null */
  let busy = null;
  /** 上一次没成：{ id, problem }。浮层收起就忘掉 */
  let failure = null;

  const trigger = $("preset-trigger");
  const panel = $("preset-picker");
  const checks = createChecks(() => draw());

  const platformOf = (id) => setup.plaza.platforms.find((platform) => platform.id === id) ?? { id, name: id };
  const nameOf = (id) => t(`presets.items.${id}.name`);
  const isOpen = () => panel.matches(":popover-open");
  /** 本机模型那一行（下载状态、多大） */
  const localItem = (id) =>
    setup.plaza.shelves.transcribe.find(({ kind }) => kind === "local").items.find(({ choice }) => choice === id);

  /** 月成本按界面语言挑币种：中文写人民币，别的写美元；一律到分，不花钱的写 0 */
  function monthlyText(monthly) {
    const [symbol, value] = t.locale.startsWith("zh") ? ["¥", monthly.cny] : ["$", monthly.usd];
    return value === 0 ? `${symbol}0` : `${symbol}${value.toFixed(2)}`;
  }

  function cost(preset) {
    const tip = t("presets.costTip", { daily: setup.plaza.typical.daily, seconds: setup.plaza.typical.seconds });
    if (preset.monthly === null) return h("span", { class: "picker-cost", title: tip, text: t("presets.costUnknown") });
    return h(
      "span",
      { class: "picker-cost", title: tip },
      h("span", { class: "picker-cost-value", text: monthlyText(preset.monthly) }),
      h("span", { class: "unit", text: t("presets.perMonth") }),
    );
  }

  /** 检测一套：用到本机模型的先念一句交给它转，用到云端的再按这套设置发最小的请求；都过了才算过 */
  function checkCall(preset) {
    const local = preset.settings.transcriber ?? preset.settings.privateTranscriber;
    const usesLocal = preset.hops.some(({ platform }) => platform === "local");
    const usesCloud = preset.hops.some(({ platform }) => platform !== "local");
    return async () => {
      if (usesLocal) {
        const result = await window.orangespeakeasy.checkTranscriber(local);
        if (!result.ok) return result;
      }
      return usesCloud ? window.orangespeakeasy.checkModel(preset.mode, preset.settings) : { ok: true };
    };
  }

  /** 补上还差的那一样：缺 key 去配，没下载就下（下着显示进度） */
  function fix(preset) {
    const [need] = preset.needs;
    if (need?.kind === "key") {
      return h("button", {
        type: "button",
        class: "button block",
        disabled: !setup.switchable,
        text: t("plaza.actions.configureKey"),
        onclick: () => {
          panel.hidePopover();
          configureKey(need.platform);
        },
      });
    }
    if (need?.kind === "download") {
      const item = localItem(need.model);
      if (item?.download) return progressBadge(item.download);
      return h("button", {
        type: "button",
        class: "button block",
        disabled: busy !== null,
        text: t("presets.download", { size: `${Math.round((item?.bytes ?? 0) / 1e6)} MB` }),
        onclick: () => run(preset.id, () => window.orangespeakeasy.downloadModel(need.model)),
      });
    }
    return null;
  }

  /** 还差的，写成一行字；什么都不差是空的 */
  function gapsOf(preset) {
    if (preset.problem) return [t.text(preset.problem)];
    const way = { hops: preset.hops, platformOf };
    const localName = preset.hops.find(({ platform }) => platform === "local")?.name;
    // 正在下的写"下载中"，进度在右边
    return preset.needs.map((need) =>
      need.kind === "download" && localItem(need.model)?.download
        ? t("presets.downloading", { model: localName ?? need.model })
        : needText(need, way),
    );
  }

  /** 右边的操作：正在用、去补、启用中、启用 */
  function action(preset, gaps) {
    if (preset.active) {
      return h("span", { class: "state-box block", "data-tone": "accent" }, svg("i-check"), t("plaza.inUse"));
    }
    if (gaps.length > 0) return fix(preset);
    if (busy === preset.id) {
      return h(
        "span",
        { class: "badge block", "data-tone": "progress", role: "status" },
        svg("i-loader-circle", "icon spin"),
        h("span", { class: "label", text: t("presets.enabling") }),
      );
    }
    return h("button", {
      type: "button",
      class: "button block",
      disabled: !setup.switchable || busy !== null,
      text: t("presets.enable"),
      "aria-label": `${t("presets.enable")} ${nameOf(preset.id)}`,
      onclick: () => pick(preset),
    });
  }

  function option(preset) {
    const key = `preset:${preset.id}`;
    const gaps = gapsOf(preset);
    return h(
      "article",
      { class: "preset-row", "data-active": preset.active ? "" : null, "aria-current": preset.active ? "true" : null },
      h(
        "div",
        { class: "preset-row-main" },
        h(
          "p",
          { class: "preset-row-title" },
          h("span", { class: "preset-row-name", text: nameOf(preset.id) }),
          h("span", { class: "preset-row-mode", text: t(`plaza.modes.${preset.mode}`) }),
        ),
        hopChain(preset.hops, platformOf),
        // 还差什么写出来；都齐了才能整套检测
        gaps.length > 0
          ? h("p", { class: "preset-gap" }, svg("i-circle-alert"), h("span", { text: gaps.join(" · ") }))
          : h("div", { class: "preset-check" }, checks.control(key, t("presets.checkTip"), checkCall(preset))),
        failure?.id === preset.id &&
          h(
            "p",
            { class: "callout", role: "alert" },
            svg("i-circle-alert"),
            h("span", {}, h("b", { text: t("plaza.actionFailed") }), ` · ${t.text(failure.problem)}`),
          ),
        checks.note(key),
      ),
      h("div", { class: "preset-row-side" }, cost(preset), action(preset, gaps)),
    );
  }

  function draw() {
    if (!setup?.plaza?.presets) return;
    const { presets } = setup.plaza;
    trigger.hidden = presets.length === 0;
    trigger.replaceChildren(svg("i-zap"), h("span", { text: t("presets.title") }), svg("i-chevron", "icon chevron"));
    $("preset-options").replaceChildren(...presets.map(option));
  }

  /** 发一件要等回话的事（启用、发起下载）：同一时间只发一件；没成就挂在那一项下面 */
  async function run(id, call) {
    if (busy !== null) return null;
    busy = id;
    failure = null;
    draw();
    let result;
    try {
      result = await call();
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    }
    busy = null;
    if (result?.ok === false) {
      failure = { id, problem: result.problem };
      draw();
      // 等的时候浮层被点掉了：原因还是要说
      if (!isOpen()) toast(`${t("plaza.actionFailed")} · ${t.text(result.problem)}`);
      return null;
    }
    await refresh();
    return result ?? {};
  }

  async function pick(preset) {
    const result = await run(preset.id, () => window.orangespeakeasy.setMode(preset.mode, preset.settings));
    if (!result) return;
    panel.hidePopover();
    toast(t("presets.enabled", { name: nameOf(preset.id) }));
    if (result.note) toast(t.text(result.note));
  }

  panel.addEventListener("toggle", (event) => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "closed" && busy === null && failure !== null) {
      failure = null;
      draw();
    }
  });

  return {
    /** @param {object} next getSetup 给的整份状态 */
    render(next) {
      setup = next;
      draw();
    },
    /** 打开那一列（首次引导点了"前往引擎"）。还没有推荐组合可列时不开 */
    open() {
      if (!trigger.hidden && !isOpen()) panel.showPopover({ source: trigger });
    },
  };
}
