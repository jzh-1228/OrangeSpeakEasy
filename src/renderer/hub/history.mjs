import { ACTIONS, SPOKEN_ACTIONS } from "../../hotkeys/actions.mjs";
import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { h } from "../shared/dom.mjs";
import { t } from "../shared/i18n.mjs";
import { slidingIndicators } from "./indicators.mjs";

// 历史记录：按天分组（今天、昨天、再往前写日期），一行一条，鼠标移上去才出现复制和详情。
// 和原版一样一行只有时间和文字；我们多出来的录音时长、模型用时和花费放在详情的悬停提示里。
// 翻译的那几条正文是译文，下面一行是小标签（功能 · 目标语言）和原文。标题右边按功能筛：全部，和动作目录里每个功能。

const $ = (id) => document.getElementById(id);

const clock = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "long" });
const longDayWithYear = new Intl.DateTimeFormat(t.locale, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** 分组的标题：今天、昨天，再往前写几月几日星期几（不是今年的带上年份） */
function dayTitle(day, now) {
  const today = startOfDay(now);
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return t("history.today");
  if (days === 1) return t("history.yesterday");
  return (day.getFullYear() === now.getFullYear() ? longDay : longDayWithYear).format(day);
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return whole < 60
    ? t("units.seconds", { value: whole })
    : t("units.minutesSeconds", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** 详情：录音多长（说话的功能才有录音，划词没有）、等了模型多久、花了多少，token 细节 */
function detailsOf(row) {
  const lines = SPOKEN_ACTIONS.includes(row.kind)
    ? [t("history.recording", { duration: formatDuration(row.duration) })]
    : [];
  if (row.usage) {
    const cost = row.usage.costUsd === null ? t("history.unpriced") : formatUsd(row.usage.costUsd);
    lines.push(t("history.model", { latency: formatSeconds(row.usage.latencyMs, t), cost }));
    const tokens = { input: formatTokens(row.usage.inputTokens), output: formatTokens(row.usage.outputTokens) };
    lines.push(
      row.usage.calls > 1
        ? t("history.tokensCalls", { ...tokens, calls: row.usage.calls })
        : t("history.tokens", tokens),
    );
  }
  return lines.join("\n");
}

/** 能筛的功能：任何时候都能按的动作（取消不算） */
const FEATURES = ACTIONS.filter((action) => action.when === "always").map(({ id }) => id);

/**
 * 翻下一页：新取到的记录接在已经有的后面，按 id 去掉重复的（两次翻页之间来了新记录也不会重一行），
 * 总数换成这一次一起取回的 total。翻页只是并数据，单独拎出来好在 Node 里测
 * @param {{ id: string }[]} latest 已经加载的记录
 * @param {{ rows: { id: string }[], total: number }} page 新取到的一页
 * @returns {{ rows: object[], total: number }}
 */
export function mergePage(latest, { rows, total }) {
  const seen = new Set(latest.map(({ id }) => id));
  return { rows: [...latest, ...rows.filter((row) => !seen.has(row.id))], total };
}

export function createHistory() {
  const dayTemplate = $("history-day");
  const rowTemplate = $("history-row");
  /** 已经加载的记录：首屏是最近的一页，翻页后往后接；换筛选时按它重画 */
  let latest = [];
  /** 历史库里一共多少条：已加载的到了这个数就是到底了 */
  let total = 0;
  /** 正在取下一页：连点两下不会取两遍 */
  let loadingMore = false;
  /** 筛的是哪个功能；all 是全部 */
  let filter = "all";
  const indicators = slidingIndicators(document.querySelector('.page[data-route="history"]'));

  // 分段控件：全部，加每个功能一个
  $("history-filter").append(
    ...["all", ...FEATURES].map((id) =>
      h("button", {
        type: "button",
        class: "segment",
        role: "radio",
        "aria-checked": String(id === filter),
        "data-filter": id,
        text: id === "all" ? t("history.all") : t(`actions.${id}.name`),
        onclick: () => {
          filter = id;
          for (const segment of $("history-filter").querySelectorAll(".segment")) {
            segment.setAttribute("aria-checked", String(segment.dataset.filter === id));
          }
          indicators.place();
          draw();
        },
      }),
    ),
  );
  $("history-more").addEventListener("click", more);

  /** 翻译的那几条：功能和目标语言的小标签，后面是原文。不是翻译的（没有目标语言）不画 */
  function renderSource(node, row) {
    if (!row.outputLanguage) return;
    const source = node.querySelector(".entry-source");
    source.hidden = false;
    source.querySelector(".tag").textContent =
      `${t(`actions.${row.kind}.name`)} · ${t(`languages.${row.outputLanguage}`)}`;
    const original = source.querySelector(".entry-original");
    original.textContent = row.sourceText ?? "";
    original.title = row.sourceText ?? "";
  }

  function renderRow(row) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const time = node.querySelector("time");
    time.dateTime = row.createdAt;
    time.textContent = clock.format(new Date(row.createdAt));

    const text = node.querySelector(".entry-text");
    const copy = node.querySelector(".copy");
    if (row.status === "failed") {
      node.dataset.kind = "failed";
      // 失败的原因是当时界面上的那句话，记在历史里，不随语言再变
      text.dataset.prefix = t("history.failed");
      text.textContent = row.error;
      copy.hidden = true;
    } else if (row.refinedText === "") {
      // 原版的说法：hub__history__item__empty__text
      node.dataset.kind = "silent";
      text.textContent = t("history.silent");
      copy.hidden = true;
    } else {
      text.textContent = row.refinedText;
      copy.addEventListener("click", async () => {
        try {
          await window.orangespeakeasy.copyText(row.refinedText);
          copy.dataset.done = "";
          copy.title = t("history.copied");
        } catch (error) {
          console.error("复制失败", error);
          copy.title = t("history.copyFailed");
        }
        setTimeout(() => {
          delete copy.dataset.done;
          copy.title = t("history.copy");
        }, 1500);
      });
    }

    renderSource(node, row);
    const details = node.querySelector(".details");
    details.title = detailsOf(row);
    details.setAttribute("aria-label", details.title);
    return node;
  }

  function draw() {
    const rows = filter === "all" ? latest : latest.filter((row) => row.kind === filter);
    $("history-empty").hidden = rows.length > 0;
    $("history-empty").textContent = t("history.empty");

    const now = new Date();
    const groups = [];
    for (const row of rows) {
      const day = startOfDay(new Date(row.createdAt));
      const last = groups.at(-1);
      if (last && last.day.getTime() === day.getTime()) last.rows.push(row);
      else groups.push({ day, rows: [row] });
    }
    $("history-days").replaceChildren(
      ...groups.map(({ day, rows: dayRows }) => {
        const node = dayTemplate.content.firstElementChild.cloneNode(true);
        node.querySelector(".day-title").textContent = dayTitle(day, now);
        node.querySelector(".entries").replaceChildren(...dayRows.map(renderRow));
        return node;
      }),
    );
  }

  /** 还能往前翻时露出"加载更多"那一行，提示写明已加载多少、一共多少 */
  function updateMore() {
    const again = latest.length < total;
    $("history-more-row").hidden = !again;
    if (again) $("history-more-hint").textContent = t("history.shown", { shown: latest.length, total });
  }

  function showError(message) {
    $("history-error").textContent = t("history.loadError", { reason: message });
    $("history-error").hidden = false;
  }

  /** 取下一页：游标是已加载的最后一条，两列一起比，同一毫秒的几条不会漏、不会重 */
  async function more() {
    const last = latest.at(-1);
    if (loadingMore || !last || latest.length >= total) return;
    loadingMore = true;
    $("history-more").disabled = true;
    try {
      const page = await window.orangespeakeasy.listHistory({ before: last.createdAt, beforeId: last.id });
      ({ rows: latest, total } = mergePage(latest, page));
      draw();
      updateMore();
    } catch (error) {
      console.error("读历史失败", error);
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      loadingMore = false;
      $("history-more").disabled = false;
    }
  }

  return {
    /**
     * @param {{ rows: object[], total: number }} data 第一页的记录，和历史库里一共多少条
     */
    render({ rows, total: count }) {
      $("history-error").hidden = true;
      latest = rows;
      total = count;
      draw();
      updateMore();
    },

    /** 页面切到前台时，分段控件的底块要按真实宽度重新放（藏着时量不出来） */
    shown() {
      indicators.reset();
      indicators.place();
    },

    showError,
  };
}
