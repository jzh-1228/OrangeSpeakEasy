// 划词卡片的页面：主进程交来这一次的样子（app/lookup/controller.mjs 的 view），这里画出来，量好卡片多高、
// 每个按钮在窗口里的哪一块，报回去（app/lookup/card-window.mjs 摆窗口、交给小帮手截）。
// 窗口点不到：点击是小帮手截下来、经主进程转过来的（onLookupClick）。展开语言选单这种只在页面里的事这里自己办，
// 别的（复制、换语言、固定、关闭、重试、配置密钥）报给主进程。画面在 card-ui.mjs。

import { $ } from "../shared/dom.mjs";
import { localize, setLocale, t } from "../shared/i18n.mjs";
import { drawCard } from "./card-ui.mjs";

/** "已复制"留多久 */
const COPIED_MS = 1500;

localize();
const card = $("card");

/** 现在画的样子；没开着是 null */
let view = null;
/** 语言选单展开着没有：换一张卡片（view.id 变了）就收起 */
let menuOpen = false;
let copiedTimer = null;

function render() {
  drawCard(view, { menuOpen });
  report();
}

/** 这一块在窗口里的位置：没有动画（卡片只淡入），量出来的就是排好的位置 */
function regionOf(node) {
  const box = node.getBoundingClientRect();
  return { id: node.dataset.region, x: box.left, y: box.top, width: box.width, height: box.height };
}

/** 报卡片多高、哪几块要截：按钮在前，整张卡片最后（点在卡片的空白处也不能漏到下面的应用里，也不算点别处） */
function report() {
  if (!view) return;
  const buttons = [...card.querySelectorAll("[data-region]")].filter((node) => node.getClientRects().length > 0);
  const regions = [...buttons.map(regionOf), { ...regionOf(card), id: "card" }];
  window.orangespeakeasy.lookupLayout({ height: card.offsetHeight, regions });
}

function showCopied() {
  clearTimeout(copiedTimer);
  $("copy-label").textContent = t("lookup.card.copied");
  $("copy").querySelector("use").setAttribute("href", "#i-check");
  copiedTimer = setTimeout(() => {
    $("copy-label").textContent = t("lookup.card.copy");
    $("copy").querySelector("use").setAttribute("href", "#i-copy");
  }, COPIED_MS);
}

window.orangespeakeasy.onLookupView((next) => {
  if (!next || next.id !== view?.id) menuOpen = false;
  view = next;
  render();
});

window.orangespeakeasy.onLookupClick((id) => {
  if (!view) return;
  if (id === "language") {
    menuOpen = !menuOpen;
    render();
    return;
  }
  if (id === "card") {
    // 点在卡片的空白处：收起展开着的语言选单
    if (menuOpen) {
      menuOpen = false;
      render();
    }
    return;
  }
  if (id.startsWith("pick:")) {
    menuOpen = false;
    render();
  }
  if (id === "copy") showCopied();
  window.orangespeakeasy.lookupAct(id);
});

// 卡片变高变矮（译文回来、展开选单、换了界面语言）都重报一次
new ResizeObserver(() => report()).observe(card);

// 译文长到要滚动时：指针停在译文上，让窗口收鼠标（滚轮才滚得动）；离开就还给下面的应用
const text = $("text");
text.addEventListener("pointerenter", () => {
  if (text.scrollHeight > text.clientHeight) window.orangespeakeasy.lookupScroll(true);
});
text.addEventListener("pointerleave", () => window.orangespeakeasy.lookupScroll(false));

window.orangespeakeasy.onLocaleChanged((locale) => {
  setLocale(locale);
  localize();
  render();
});
