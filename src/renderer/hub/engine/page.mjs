import { $, h, svg } from "../../shared/dom.mjs";
import { t } from "../../shared/i18n.mjs";
import { describeError } from "../../shared/setup-text.mjs";
import { createChecks } from "../checks.mjs";
import { slidingIndicators } from "../indicators.mjs";
import { needText } from "../route-view.mjs";
import { toast } from "../toast.mjs";
import { createCanvas } from "./canvas.mjs";
import { createDetail } from "./detail.mjs";
import { createKeys } from "./keys.mjs";
import { createLookupSegment } from "./lookup.mjs";
import { itemKey, itemName, MODE_ROLES, modeName, plazaView, ROLE_IDS, ROLES } from "./plaza-view.mjs";
import { createSearch } from "./search.mjs";
import { createTree } from "./tree.mjs";

// 侧栏"引擎"一页（路由名还是 models：主进程、菜单栏按这个名字打开它）。一棵从左往右长的树：
// 识别方式 → 环节（原生、转写、润色）→ 厂商 → 型号，点型号在右边出详情；树排在一块可拖动、可缩放的画布上。
// 识别方式在这里换（首页只显示），各环节用哪个模型也在这里换；推荐组合在标题行（preset-picker.mjs），
// 密钥是标题行右边的一张面板（keys.mjs）。数据由主进程拼好（app/model-plaza.mjs，随 getSetup 来），
// 这里只画、只转达操作：换方式、换模型当场换上，存密钥先验证，还差的照实写着（顶上的横幅也会写）。
// 控件和尺寸照界面规范（docs/desktop-ui-spec.md），文案照规范里的词表。
// 标题旁分语音、划词两段：上面说的是语音那一段；划词那一段只有厂商、型号两列（lookup.mjs），和这棵树不相干，
// 密钥面板两段共用（清单里的厂商同一家只有一把 key）。

/**
 * @param {object} options
 * @param {() => Promise<object>} options.refresh 重新问主进程要一份状态，并让整个窗口跟着更新
 */
export function createEngine({ refresh }) {
  /** 最近一次拿到的状态，和按它算的树上各项的状态（plaza-view.mjs） */
  let setup = null;
  let view = null;
  const ui = {
    /** 树展开到哪：环节、厂商（组 id）、型号（itemKey）；detail 是型号的详情开着 */
    role: null,
    maker: null,
    item: null,
    detail: false,
    /** 各组看的是哪个渠道：组 id → 平台 id。没选过的按 viaOf 推 */
    via: {},
    /**
     * 自定义服务的两份草稿，各是 { url, model, params } 或 null：
     *   form   上次提交时表单里填的：提交没成时照它重画表单，免得白填
     *   draft  验证过、还没换上的：启用、检测都按它来；换上了就清掉
     */
    custom: { form: null, draft: null },
    /** 密钥面板里展开了哪一家的表单 */
    openKey: null,
    /** 正在等主进程回话的那一次操作（模型、密钥），按钮不重复点 */
    busy: null,
    /** 正在切过去的识别方式；上一次没切成的 { mode, problem } */
    modeBusy: null,
    modeFailure: null,
    /** 光标停在哪种识别方式上：它经过的线先亮 */
    hoverMode: null,
  };

  const checks = createChecks(() => draw());
  const page = document.querySelector('.page[data-route="models"]');
  const indicators = slidingIndicators(page);
  /** 标题旁的两段：voice（树、画布）、lookup（lookup.mjs） */
  let segment = "voice";

  // ---------- 主进程那边的操作 ----------

  /** 操作没成：失败说明挂在那一项下面，原因照主进程说的 */
  function failed(key, problem, title = "plaza.actionFailed") {
    checks.results[key] = { state: "fail", problem, title };
  }

  /** 有一件事在等主进程回话（启用、下载、存密钥，或者换识别方式）：别的先不让点，同一时间只发一件 */
  const waiting = () => ui.busy !== null || ui.modeBusy !== null;

  /** 发一件要等回话的事：同一时间只发一件，回来后重读状态 */
  async function act(key, call, { done } = {}) {
    if (waiting()) return;
    ui.busy = key;
    delete checks.results[key];
    draw();
    let result;
    try {
      result = await call();
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    } finally {
      ui.busy = null;
    }
    if (result?.ok === false) failed(key, result.problem);
    else done?.(result ?? {});
    await refresh();
    if (result?.note) toast(t.text(result.note));
  }

  /** 启用一个模型：在它那种识别方式里就只换模型，不在就连方式一起换 */
  function use(role, group, item, key) {
    const choice = view.choiceOf(role, group, item);
    const mode = view.modeFor(role, group);
    const setting = view.settingFor(role, group);
    const switching = setup.plaza.mode !== mode;
    const name = itemName(group, item, { withBuild: true });
    const extra = group.kind === "custom" ? view.customExtra() : {};
    act(
      key,
      () => {
        if (switching)
          return window.orangespeakeasy.setMode(mode, { [setting === "native" ? "model" : setting]: choice, ...extra });
        if (role === "native") return window.orangespeakeasy.setModel(choice);
        if (role === "transcribe") return window.orangespeakeasy.setTranscriber(choice);
        return window.orangespeakeasy.setPolish(choice, extra);
      },
      {
        done: () => {
          // 草稿换上了，往后照设置里存的
          if (group.kind === "custom") ui.custom.draft = null;
          toast(
            switching
              ? t("plaza.toast.switchedWith", { mode: modeName(mode), model: name })
              : t("plaza.toast.enabled", { model: name }),
          );
        },
      },
    );
  }

  /** 展开到某个环节：厂商停在它选定的那一家，型号先不点开 */
  function expandRole(role) {
    ui.role = role;
    ui.maker = view.chosenSpot(role)?.group.id ?? setup.plaza.shelves[role][0].id;
    ui.item = null;
    ui.detail = false;
  }

  /** 这种方式按现在的设置还差什么，写成几个短语 */
  function gapsOf(mode) {
    const way = setup.plaza.ways[mode];
    if (way.problem) return [];
    const platformOf = (id) => view.platformOf(id) ?? { id, name: id };
    const downloadOf = (id) => setup.local.transcribers.find((model) => model.id === id)?.download ?? null;
    return way.needs.map((need) => needText(need, { ...way, platformOf, downloadOf }));
  }

  /**
   * 换识别方式：交给主进程（app/modes.mjs 的 switchMode），当场换上、不等补齐，换过去还差的照实说；
   * 换不了（设置写错了）就在那一项下面说为什么。换好后树展开到这种方式的第一个环节
   */
  async function switchMode(mode) {
    if (waiting() || !setup.switchable) return;
    if (mode === setup.plaza.mode) {
      ui.modeFailure = null;
      expandRole(MODE_ROLES[mode][0]);
      draw({ view: "fit" });
      return;
    }
    ui.modeBusy = mode;
    ui.modeFailure = null;
    draw();
    let result;
    try {
      result = await window.orangespeakeasy.setMode(mode);
    } catch (error) {
      result = { ok: false, problem: describeError(error) };
    }
    ui.modeBusy = null;
    if (result?.ok === false) {
      ui.modeFailure = { mode, problem: result.problem };
      draw();
      toast(`${t("home.mode.failed")} · ${t.text(result.problem)}`);
      return;
    }
    await refresh();
    expandRole(MODE_ROLES[mode][0]);
    draw({ view: "fit" });
    toast([t("home.mode.switched", { mode: modeName(mode) }), ...gapsOf(mode)].join(" · "));
    if (result?.note) toast(t.text(result.note));
  }

  // ---------- 走到哪 ----------

  function pickRole(role) {
    if (ui.role === role && !ui.detail) return;
    expandRole(role);
    draw({ view: "fit" });
  }

  function pickMaker(id) {
    if (ui.maker === id && !ui.detail) return;
    ui.maker = id;
    ui.item = null;
    ui.detail = false;
    draw({ view: "fit" });
  }

  function pickItem(key, event) {
    if (ui.item === key && ui.detail) {
      closeDetail();
      return;
    }
    ui.item = key;
    ui.detail = true;
    draw({ view: "leaf" });
    // 用键盘打开的：焦点放进详情（鼠标点的不挪焦点，免得冒出聚焦框）
    if (event?.detail === 0) requestAnimationFrame(() => $("engine-detail").querySelector(".detail-close")?.focus());
  }

  function closeDetail() {
    const key = ui.item;
    ui.detail = false;
    draw({ view: "fit" });
    if (key) tree.find($("engine-models"), key)?.focus({ preventScroll: true });
  }

  /** 从搜索跳到某一项：一路展开并打开详情 */
  function reveal(role, groupId, key) {
    ui.role = role;
    ui.maker = groupId;
    ui.item = key;
    ui.detail = true;
    draw({ view: "leaf" });
  }

  // ---------- 各块 ----------

  /** 交给各块（树、详情、密钥、搜索）的：现在的状态和这几个操作 */
  const ctx = {
    get setup() {
      return setup;
    },
    get view() {
      return view;
    },
    ui,
    checks,
    waiting,
    act,
    failed,
    use,
    switchMode,
    pickRole,
    pickMaker,
    pickItem,
    closeDetail,
    reveal,
    openKeys: (platform, options) => keys.open(platform, options),
    /** 从密钥面板回到详情：焦点放在还差的那一步（配置密钥）上，补齐了就放在启用上 */
    focusDetail: () =>
      segment === "lookup"
        ? lookupSegment.focusDetail()
        : canvas.quietly(() =>
            (
              dock.querySelector(".detail-need button:not(:disabled)") ??
              dock.querySelector(".detail-actions button:not(:disabled)") ??
              dock.querySelector(".detail-close")
            )?.focus({ preventScroll: true }),
          ),
    toast,
    draw: () => draw(),
  };

  const canvasEl = $("engine-canvas");
  const dock = $("engine-detail");
  const tree = createTree(ctx, {
    tree: $("engine-tree"),
    links: $("engine-links"),
    modes: $("engine-modes"),
    roles: $("engine-roles"),
    makers: $("engine-makers"),
    models: $("engine-models"),
    canvas: canvasEl,
    canvasLinks: $("engine-canvas-links"),
    dock,
  });
  const detail = createDetail(ctx, dock);
  const keys = createKeys(ctx);
  const lookupSegment = createLookupSegment({
    els: {
      root: $("lookup-engine"),
      stage: $("lookup-stage"),
      tree: $("lookup-tree"),
      links: $("lookup-links"),
      makers: $("lookup-makers"),
      models: $("lookup-models"),
      dock: $("lookup-detail"),
      dockLinks: $("lookup-dock-links"),
    },
    getSetup: () => setup,
    refresh,
    openKeys: (platform, options) => keys.open(platform, options),
    toast,
    placeIndicators: () => indicators.place(),
  });
  createSearch(ctx);
  const canvas = createCanvas({
    canvas: canvasEl,
    world: $("engine-world"),
    content: $("engine-tree"),
    zoomValue: $("zoom-reset"),
    onMove: (ms) => tree.follow(ms),
    // 详情、缩放条上的滚动、按下归它们自己
    ignore: (event) => Boolean(event.target.closest(".detail-dock, .zoom")),
  });

  $("zoom-in").addEventListener("click", canvas.zoomIn);
  $("zoom-out").addEventListener("click", canvas.zoomOut);
  $("zoom-reset").addEventListener("click", canvas.reset);
  $("zoom-fit").addEventListener("click", () => {
    canvas.forgetZoom();
    if (ui.detail) closeDetail();
    else canvas.fit();
  });

  // 图例：线和小图标各是什么意思
  const legendItem = (glyph, text) => h("span", { class: "legend-item" }, glyph, text);
  $("engine-legend").replaceChildren(
    legendItem(h("i", { class: "legend-line", "data-tone": "live" }), t("plaza.inUse")),
    legendItem(h("i", { class: "legend-line", "data-tone": "standby" }), t("plaza.legend.standby")),
    legendItem(svg("i-key-round"), t("plaza.notice.noKey")),
    legendItem(svg("i-download"), t("plaza.state.notDownloaded")),
  );

  /** 视角跟着：fit 整棵放进画布，leaf 把点开的型号挪到详情旁边 */
  function place(how, { animate = true } = {}) {
    if (how === "leaf" && ui.detail) canvas.focus(tree.find($("engine-models"), ui.item), dock, { animate });
    else canvas.fit({ animate });
  }

  // 窗口大小变了、页面从藏着变成显示：重新放一次
  new ResizeObserver(() => {
    if (!setup?.plaza) return;
    tree.drawLinks();
    place(ui.detail ? "leaf" : "fit", { animate: false });
  }).observe(canvasEl);

  // Esc 收起详情；开着的对话框（密钥面板、设置）、弹出的单子里按的 Esc 归它们自己
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("dialog:modal, :popover-open")) return;
    if (segment === "lookup") {
      if (lookupSegment.detailOpen && $("lookup-engine").offsetParent !== null) lookupSegment.closeDetail();
      return;
    }
    if (!ui.detail || canvasEl.offsetParent === null) return;
    closeDetail();
  });

  /** 换到另一段：只露出那一段，搜索、推荐组合只在语音那一段（engine.css 按 data-segment 藏） */
  function showSegment(name) {
    segment = name;
    page.dataset.segment = name;
    for (const button of $("engine-segments").querySelectorAll(".segment")) {
      button.setAttribute("aria-checked", String(button.dataset.segment === name));
    }
    canvasEl.hidden = name !== "voice";
    $("lookup-engine").hidden = name !== "lookup";
    indicators.place();
    if (name === "lookup") {
      lookupSegment.render();
      lookupSegment.shown();
      return;
    }
    if (!setup?.plaza) return;
    requestAnimationFrame(() => {
      tree.drawLinks();
      place(ui.detail ? "leaf" : "fit", { animate: false });
    });
  }
  $("engine-segments").append(
    ...[
      ["voice", "i-mic"],
      ["lookup", "i-letter-text"],
    ].map(([name, icon]) =>
      h(
        "button",
        {
          type: "button",
          class: "segment",
          role: "radio",
          "aria-checked": String(name === segment),
          "data-segment": name,
          onclick: () => showSegment(name),
        },
        svg(icon),
        h("span", { text: t(`plaza.segments.${name}`) }),
      ),
    ),
  );

  // ---------- 总的 ----------

  /**
   * 能按的东西在重画前后怎么认：在哪一块（树的哪一列、详情、密钥列表），哪一行（节点的 data-key、密钥那一行的平台），
   * 叫什么（节点本身就是那一行，不看字：下面那行状态会变）
   */
  function spotOf(el) {
    const area = el?.closest?.(".tree-col, #engine-detail, #keys-list");
    if (!area || el === area) return null;
    const row = el.closest("[data-key], [data-platform]");
    return {
      area: area.id,
      row: row?.dataset.key ?? row?.dataset.platform ?? null,
      name: row === el ? "" : (el.getAttribute("aria-label") ?? el.textContent.trim()),
    };
  }

  /** 重画后找回那一个；没了（下载变成了取消、密钥存好了），退到同一行、这一块的主操作、这一块第一个能按的 */
  function findSpot(spot) {
    const area = $(spot.area);
    if (!area) return null;
    const usable = [...area.querySelectorAll("button, input, select, [tabindex]")].filter(
      (el) => !el.disabled && el.tabIndex >= 0,
    );
    const same = (el, name = true) => {
      const other = spotOf(el);
      return other.row === spot.row && (!name || other.name === spot.name);
    };
    return (
      usable.find((el) => same(el)) ??
      usable.find((el) => spot.row !== null && same(el, false)) ??
      usable.find((el) => el.closest(".detail-actions")) ??
      usable[0] ??
      null
    );
  }

  /**
   * 重画会把树、详情、密钥列表整块换掉：焦点在里面的，画完放回同一个（不然掉回页面开头，下载时每半秒掉一次）；
   * 正在填的输入框连值和光标一起放回去
   */
  function keepingFocus(paint) {
    const active = document.activeElement;
    const spot = spotOf(active);
    const kept = active?.closest?.(".key-entry") && active.tagName === "INPUT" ? active : null;
    const values = [...document.querySelectorAll(".key-entry .input")].map((input) => [input.id, input.value]);
    paint();
    for (const [id, value] of values) {
      const input = $(id);
      if (input) input.value = value;
    }
    if (kept) {
      const input = $(kept.id);
      input?.focus({ preventScroll: true });
      if (input && kept.selectionStart !== null) input.setSelectionRange(kept.selectionStart, kept.selectionEnd);
      return;
    }
    if (spot && !active.isConnected) canvas.quietly(() => findSpot(spot)?.focus({ preventScroll: true }));
  }

  /** 选的那几样在新状态里还在不在：不在了（换了语言、模型清单变了）就退回一层 */
  function keepSelection() {
    if (!ROLE_IDS.includes(ui.role)) {
      expandRole(ROLE_IDS.find(view.isLive) ?? "transcribe");
      return true;
    }
    const group = setup.plaza.shelves[ui.role].find(({ id }) => id === ui.maker);
    if (!group) {
      expandRole(ui.role);
      return true;
    }
    if (ui.detail && !group.items.some((item) => itemKey(item) === ui.item)) {
      ui.detail = false;
      return true;
    }
    return false;
  }

  /**
   * 重画整页
   * @param {{ view?: "fit" | "leaf" }} [options] 视角怎么跟；不写就不动
   */
  function draw({ view: how } = {}) {
    if (!setup?.plaza) return;
    view = plazaView(setup.plaza, ui);
    const reset = keepSelection();
    keepingFocus(() => {
      tree.render();
      detail.render();
      keys.render();
    });
    canvasEl.toggleAttribute("data-detail", ui.detail);
    if (ui.detail) canvas.keepDockInside(dock);
    indicators.place();
    tree.drawLinks();
    if (how || reset) place(how ?? "fit");
  }

  return {
    /** @param {object} next getSetup 给的整份状态 */
    render(next) {
      const first = setup === null;
      setup = next;
      // 没切成的那种方式后来从别处换上了（详情里启用、菜单栏、命令行）：失败的说明作废
      if (ui.modeFailure?.mode === next.plaza?.mode) ui.modeFailure = null;
      draw(first ? { view: "fit" } : {});
      lookupSegment.render();
    },

    /**
     * 从别处打开到某一处：tab 是一个环节就展开到它，是 "keys" 或给了 platform 就打开密钥面板（给了平台顺带展开那一家）；
     * section 是 "lookup" 就换到划词那一段、打开在用的那一项（划词卡片上的"配置密钥"来的）；
     * 别的都是语音那一段的事（识别方式、环节、密钥），上次停在划词段也换回来
     * @param {{ tab?: string, platform?: string, section?: "voice" | "lookup" }} target
     */
    show({ tab, platform, section } = {}) {
      if (!setup?.plaza) return;
      if (section === "lookup") {
        showSegment("lookup");
        lookupSegment.openChosen();
        return;
      }
      if (segment !== "voice") showSegment("voice");
      if (tab === "keys" || platform) {
        keys.open(platform ?? null);
        return;
      }
      if (ROLES[tab]) pickRole(tab);
    },

    /** 离开这一页：密钥面板是模态的，开着就收起，不然换到别的页它还压着整个窗口 */
    hidden() {
      if ($("keys-sheet").open) $("keys-sheet").close();
    },

    /** 页面切到前台时：滑块按真实宽度重新放，画布重新放进窗口 */
    shown() {
      indicators.reset();
      indicators.place();
      if (segment === "lookup") {
        lookupSegment.shown();
        return;
      }
      if (!setup?.plaza) return;
      requestAnimationFrame(() => {
        tree.drawLinks();
        place(ui.detail ? "leaf" : "fit", { animate: false });
      });
    },
  };
}
