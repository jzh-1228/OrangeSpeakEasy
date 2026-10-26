import { chordString, chordsText, chordText } from "../../hotkeys/chord.mjs";
import { h, svg } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { keycapRow as keycaps } from "./keycaps.mjs";
import { describeError } from "./setup-text.mjs";

// 快捷键编辑（docs/hotkey-research.md 5.6、D4），设置页用：动作目录里每个动作一行，每个组合一个胶囊框
// （点它换掉、× 删掉），"添加另一个"（至多 4 个），和默认不一样时"恢复默认"。
// 录键在主进程和小帮手那边：这里点了告诉主进程（recordHotkey），主进程经 onHotkeyRecording 报回现在按着什么、存没存上。
// 页面只画，不判断合不合规矩：存的时候主进程查，被拒了说原因，人直接重按。

/**
 * 现在录不了的原因（文案的名字），录得了是 null：录键要小帮手在跑、收得到按键（Mac 上要输入监控权限）
 * @param {{ helper: string, permissions: { listen?: boolean } }} setup setup:get 的状态
 */
export function recordBlocker(setup) {
  if (setup.helper !== "running") return "hotkeyRecord.helperStopped";
  if (setup.permissions.listen === false) return "hotkeyRecord.needsListen";
  return null;
}

/**
 * @param {HTMLElement} root 画在这里面
 * @param {{ onChanged: () => Promise<void> }} options onChanged：存好、删掉、恢复默认之后，让页面重新要一份状态
 */
export function createHotkeyEditor(root, { onChanged }) {
  /** 主进程给的每个动作一行（setup:get 的 hotkeyActions） */
  let actions = [];
  /** 录不了的原因（文案的名字）；录得了是 null */
  let blocker = null;
  /**
   * 正在录的那一处：{ action, index, token, codes, unknown, tooMany, reason }；没在录是 null。
   * token 每次开始录换一个，主进程报回来的都带着它：上一次晚到的结束、结果不会算到这一次头上
   */
  let recording = null;
  let lastToken = 0;
  /** 每个动作下面那一行字：{ text, tone } */
  const notes = new Map();

  const say = (actionId, message, tone = "") => {
    if (message) notes.set(actionId, { text: t.text(message), tone });
    else notes.delete(actionId);
  };

  async function run(actionId, task) {
    say(actionId, null);
    try {
      const result = await task();
      if (result?.note) say(actionId, result.note);
    } catch (error) {
      say(actionId, describeError(error), "problem");
    }
    await onChanged();
  }

  function start(actionId, index) {
    const action = actions.find((item) => item.id === actionId);
    if (!action || action.env) return;
    // 录不了时照实说为什么，不然点了没有任何反应
    if (blocker !== null) {
      say(actionId, t(blocker), "problem");
      draw();
      return;
    }
    const at = index ?? action.chords.length;
    if (recording?.action === actionId && recording.index === at) return;
    say(actionId, null);
    const token = ++lastToken;
    recording = { action: actionId, index: at, token, codes: [], unknown: false, tooMany: false };
    draw();
    window.orangespeakeasy.recordHotkey(actionId, index, token).catch((error) => {
      if (recording?.token !== token) return;
      recording = null;
      say(actionId, describeError(error), "problem");
      draw();
    });
  }

  /** reason 记进日志（src/app/hotkey-recording.mjs 的 PAGE_REASONS） */
  function stop(reason) {
    if (recording === null) return;
    recording = null;
    window.orangespeakeasy.stopRecordingHotkey(reason);
    draw();
  }

  window.orangespeakeasy.onHotkeyRecording((payload) => {
    if (recording === null || payload.token !== recording.token) return;
    if (payload.state === "recording") {
      recording = {
        ...recording,
        codes: payload.codes,
        unknown: payload.unknown,
        tooMany: payload.tooMany,
        // 被拒的原因留到下一次按下：全部松开时的那份空快照不能把它冲掉
        reason: payload.codes.length > 0 ? null : recording.reason,
      };
    } else if (payload.state === "rejected") {
      recording = { ...recording, codes: payload.codes, unknown: false, tooMany: false, reason: payload.reason };
    } else if (payload.state === "saved") {
      recording = null;
      say(payload.action, payload.note ?? t("hotkeyRecord.saved"), payload.note ? "" : "ok");
      onChanged();
    } else {
      recording = null;
    }
    draw();
  });

  // 录着的时候点了别处：不录了（录键时按键被小帮手吞掉，点鼠标是还能用的出口）。点的是编辑器里另一个组合或"添加另一个"时
  // 不在这里停：按下时就重画会把那个按钮删掉，点击就丢了；交给它的点击开始新的一次，主进程把旧的那次结束掉
  document.addEventListener("pointerdown", (event) => {
    if (recording === null || event.target.closest?.("[data-recording]")) return;
    if (root.contains(event.target) && event.target.closest?.(".chord-keys, .hotkey-add")) return;
    stop("elsewhere");
  });

  /** 一个组合的框。index 是它在这个动作里排第几；录着的那个画实时按着的键 */
  function chordBox(action, codes, index) {
    const live = recording?.action === action.id && recording.index === index ? recording : null;
    const text = codes ? t.text(chordText(codes)) : "";
    const problem =
      codes && action.problems.find((item) => item.chord && chordString(item.chord) === chordString(codes));
    const removable = codes && !live && !action.env && (action.clearable || action.chords.length > 1);
    let caps;
    if (live) {
      caps =
        live.codes.length > 0
          ? keycaps(live.codes)
          : [h("span", { class: "chord-prompt", text: t("hotkeyRecord.prompt") })];
      if (live.unknown) caps.push(h("kbd", { class: "keycap", text: "?" }));
    } else {
      caps = keycaps(codes);
    }
    return h(
      "span",
      {
        class: "chord",
        "data-recording": live ? "" : null,
        "data-tone": live?.reason || live?.tooMany ? "problem" : problem ? "problem" : null,
        title: problem ? t.text(problem.reason) : null,
      },
      h(
        "button",
        {
          type: "button",
          class: "chord-keys",
          "data-key": `${action.id}:${index}:keys`,
          // 被环境变量盖着时只看不改：改了也是写进设置文件，眼前不生效（noteOf 交代）
          disabled: Boolean(action.env) && !live,
          "aria-label": live ? t("hotkeyRecord.prompt") : t("hotkeyRecord.change", { chord: text }),
          onclick: () => (live ? stop("reclick") : start(action.id, index)),
        },
        ...caps,
      ),
      removable
        ? h(
            "button",
            {
              type: "button",
              class: "chord-remove",
              "data-key": `${action.id}:${index}:remove`,
              "aria-label": t("hotkeyRecord.remove", { chord: text }),
              onclick: () => run(action.id, () => window.orangespeakeasy.removeHotkey(action.id, index)),
            },
            svg("i-close"),
          )
        : null,
    );
  }

  /** 这个动作下面那一行：录着时的提示和原因，存好、出错的结果，被环境变量盖着、装不上退回默认的 */
  function noteOf(action) {
    const live = recording?.action === action.id ? recording : null;
    if (live?.reason) return { text: t.text(live.reason), tone: "problem" };
    if (live?.tooMany) return { text: t("hotkeyRecord.tooMany"), tone: "problem" };
    if (live)
      return { text: t(action.when === "capturing" ? "hotkeyRecord.hintCapturing" : "hotkeyRecord.hint"), tone: "" };
    if (notes.has(action.id)) return notes.get(action.id);
    if (action.env) return { text: t("hotkeyRecord.envOverride", { variable: action.env }), tone: "" };
    const fallback = action.problems.find((item) => item.fallback);
    if (fallback) {
      return {
        text: t("hotkeyProblem.fallback", {
          action: t(`actions.${action.id}.name`),
          chord: chordsText(fallback.fallback),
        }),
        tone: "problem",
      };
    }
    return null;
  }

  function row(action) {
    const adding = recording?.action === action.id && recording.index >= action.chords.length;
    const isDefault =
      JSON.stringify(action.chords.map(chordString)) === JSON.stringify(action.defaults.map(chordString));
    const full = action.chords.length >= action.max;
    const note = noteOf(action);
    return h(
      "div",
      { class: "hotkey-row", "data-action": action.id },
      h("div", { class: "hotkey-label" }, h("span", { class: "hotkey-name", text: t(`actions.${action.id}.name`) })),
      h(
        "div",
        { class: "hotkey-chords" },
        ...action.chords.map((codes, index) => chordBox(action, codes, index)),
        adding ? chordBox(action, null, action.chords.length) : null,
        // 只在说话时生效的动作（取消）只认一个键，加了也是撞自己：不给加
        !adding && action.when !== "capturing" && !action.env
          ? h(
              "button",
              {
                type: "button",
                class: "button small ghost hotkey-add",
                "data-key": `${action.id}:add`,
                "aria-label": t("hotkeyRecord.addLabel", { action: t(`actions.${action.id}.name`) }),
                disabled: full,
                title: full ? t("hotkeyRecord.limit", { count: action.max }) : null,
                onclick: () => start(action.id, null),
              },
              svg("i-plus"),
              t("hotkeyRecord.add"),
            )
          : null,
        isDefault || action.env
          ? null
          : h(
              "button",
              {
                type: "button",
                class: "button small ghost hotkey-reset",
                "data-key": `${action.id}:reset`,
                "aria-label": t("hotkeyRecord.resetLabel", { action: t(`actions.${action.id}.name`) }),
                onclick: () => run(action.id, () => window.orangespeakeasy.resetHotkey(action.id)),
              },
              t("hotkeyRecord.reset"),
            ),
      ),
      note ? h("p", { class: "hotkey-note", "data-tone": note.tone || null, role: "status", text: note.text }) : null,
    );
  }

  /** 整块重画。键盘焦点在编辑器里的话，画完放回同一个按钮（它没了就放到这一行的第一个组合上） */
  function draw() {
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    root.replaceChildren(...actions.map(row));
    root.title = blocker === null ? "" : t(blocker);
    if (focused === undefined) return;
    const action = focused.split(":")[0];
    (root.querySelector(`[data-key="${focused}"]`) ?? root.querySelector(`[data-key="${action}:0:keys"]`))?.focus();
  }

  return {
    /**
     * 按主进程给的状态重画
     * @param {object[]} hotkeyActions setup:get 的 hotkeyActions
     * @param {{ blocker: string | null }} options blocker：录不了的原因（recordBlocker），录得了是 null
     */
    render(hotkeyActions, options) {
      actions = hotkeyActions;
      blocker = options.blocker;
      if (blocker !== null && recording !== null) stop("unavailable");
      draw();
    },
  };
}
