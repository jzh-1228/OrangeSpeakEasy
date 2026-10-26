import { localize, t } from "../shared/i18n.mjs";

// 搬家的进度窗口（主进程那边是 src/app/move-window.mjs）：照它发来的状态画。
// phase：preparing 准备（问 App 退出、试盘）· copying 拷 · switching 换家 · done 搬好了 · failed 没搬成

const $ = (id) => document.getElementById(id);

/** 多大，给人看（和 models/describe.mjs 的 sizeText 一样：十进制，1 GB 以下按 MB） */
const size = (bytes) =>
  bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${(bytes / 1_000_000_000).toFixed(1)} GB`;

function render(state) {
  $("move").dataset.phase = state.phase;
  $("move-title").textContent = t(`moveWindow.title.${state.phase}`);
  $("move-icon").setAttribute(
    "href",
    state.phase === "done" ? "#i-check" : state.phase === "failed" ? "#i-circle-alert" : "#i-folder-sync",
  );
  $("move-from").textContent = state.from;
  $("move-from").title = state.from;
  $("move-to").textContent = state.to ?? "";
  $("move-to").title = state.to ?? "";
  const percent = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  $("move-fill").style.width = state.phase === "copying" ? `${percent}%` : "";
  $("move-track").setAttribute("aria-valuenow", String(state.phase === "done" ? 100 : percent));
  $("move-step").textContent =
    state.phase === "copying"
      ? t("moveWindow.copying", { done: size(state.done), total: size(state.total), percent })
      : state.phase === "failed"
        ? state.problem
        : t(`moveWindow.step.${state.phase}`);
  $("move-notes").replaceChildren(
    ...state.notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }),
  );
  const finished = state.phase === "done" || state.phase === "failed";
  $("move-close").hidden = !finished;
  $("move-close").textContent = t(state.phase === "done" ? "moveWindow.done" : "moveWindow.close");
  if (finished) $("move-close").focus();
}

localize();
$("move-close").addEventListener("click", () => window.orangespeakeasy.closeMove());
window.orangespeakeasy.onMoveState(render);
render(await window.orangespeakeasy.moveState());
