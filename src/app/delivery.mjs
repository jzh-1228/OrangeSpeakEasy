import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionOf } from "../hotkeys/actions.mjs";
import { msg } from "../i18n/index.mjs";
import { findLanguage } from "../languages.mjs";

// 一次听写结束后主进程要做的事：存录音、记历史、把文字贴出去。
// 和原版一样，录音存在 Recordings/<audio_id> 下，失败的也存（docs/08-local-data.md）。

/** audio_id 会拼进文件名，只接受页面用 crypto.randomUUID() 生成的那种格式 */
const AUDIO_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function checkRecording({ audioId, durationSeconds, audio }) {
  if (typeof audioId !== "string" || !AUDIO_ID.test(audioId)) throw new TypeError("audioId 不是 UUID");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new TypeError("durationSeconds 不是有效的时长");
  if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) throw new TypeError("audio 不是二进制数据");
}

/**
 * 这一次是哪个功能、翻译的原文和目标语言（存进历史）。页面不写功能的是语音输入；
 * 功能要是录音会话的动作（语音输入、语音翻译），语言要是语言表里的
 */
function featureOf({ kind = "dictate", sourceText = null, outputLanguage = null }) {
  if (actionOf(kind)?.handler !== "session") throw new TypeError(`kind 不是说话的功能：${JSON.stringify(kind)}`);
  if (sourceText !== null && typeof sourceText !== "string") throw new TypeError("sourceText 不是文字");
  if (outputLanguage !== null && findLanguage(outputLanguage)?.id !== outputLanguage) {
    throw new TypeError(`outputLanguage 不是能译成的语言：${JSON.stringify(outputLanguage)}`);
  }
  return { kind, sourceText, outputLanguage };
}

/**
 * @param {object} deps
 * @param {string} deps.recordingsDir
 * @param {{ add: Function }} deps.history
 * @param {(text: string) => Promise<{ ok: boolean }>} deps.paste
 * @param {(text: string) => void} deps.writeClipboard
 * @param {{ warn: Function, error: Function }} deps.log
 */
export function createDelivery({ recordingsDir, history, paste, writeClipboard, log, now = () => new Date() }) {
  /** 来自页面的参数先全部验一遍：不合格就抛 TypeError，这时还什么都没落盘 */
  const prepare = (payload) => {
    checkRecording(payload);
    return featureOf(payload);
  };

  // 存录音、记历史。磁盘满、录音目录没权限、历史库锁着都可能在这里出错：
  // 文字已经转出来（用户花过钱），这一步失败不能把它一起带走，所以调用方只记日志、照常往下贴
  const persist = (payload, feature, fields) => {
    mkdirSync(recordingsDir, { recursive: true });
    // 历史里只记文件名，不记完整路径：家目录整个搬了家也对得上
    const audioFile = `${payload.audioId}.webm`;
    const { audio } = payload;
    // 视图可能只是底层缓冲区的一段，只写它自己那一段
    const bytes = ArrayBuffer.isView(audio)
      ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
      : new Uint8Array(audio);
    writeFileSync(join(recordingsDir, audioFile), bytes);
    history.add({
      id: payload.audioId,
      ...feature,
      duration: payload.durationSeconds,
      audioFile,
      createdAt: now().toISOString(),
      ...fields,
    });
  };

  return {
    /**
     * 成品回来了：先落盘，再贴。贴不进去时把文字放进剪贴板，用户不会丢字。
     * 语音翻译贴的是译文（text），原文（sourceText）和目标语言（outputLanguage）只进历史
     * @returns {Promise<{ notice: object | null }>} notice 是要在悬浮条上告诉用户的话（msg，悬浮条按界面语言翻）
     */
    async completed(payload) {
      if (typeof payload.text !== "string") throw new TypeError("text 不是字符串");
      // 参数不合格还是在 try 外直接拒绝：那是调用方传错了，没有成品要救
      const feature = prepare(payload);
      let recorded = true;
      try {
        persist(payload, feature, { status: "completed", refinedText: payload.text, error: null });
      } catch (error) {
        // 存不上也接着贴：文字比这次记录重要得多
        recorded = false;
        log.error("delivery_record_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
      }
      if (payload.text === "") return { notice: msg(recorded ? "delivery.silent" : "delivery.silentNotSaved") };
      try {
        const result = await paste(payload.text);
        if (result.ok) return { notice: recorded ? null : msg("delivery.historyNotSaved") };
        log.warn("paste_not_permitted", { audio_id: payload.audioId, reason: result.reason });
        // 小帮手贴不进去的几种原因（native/mac/main.swift、native/windows/main_windows.go）：
        //   not_trusted  macOS 没有辅助功能权限，文字已经留在剪贴板里
        //   elevated     Windows 上目标窗口以管理员身份运行，系统不让模拟的按键进去，文字已经留在剪贴板里
        //   clipboard    Windows 上文字没写进剪贴板（被别的程序占着）：这里再放一次，用户才有东西可贴
        //   send_input   Windows 上模拟按键没成，文字已经在剪贴板里
        if (result.reason === "not_trusted") return { notice: msg("delivery.noAccessibility") };
        if (result.reason === "elevated") return { notice: msg("delivery.elevated") };
        if (result.reason === "clipboard") writeClipboard(payload.text);
        return { notice: msg("delivery.pasteFailed") };
      } catch (error) {
        log.error("paste_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
        writeClipboard(payload.text);
        return { notice: msg("delivery.pasteFailed") };
      }
    },

    /** 这次听写失败了：录音和原因记进历史 */
    failed(payload) {
      if (typeof payload.error !== "string") throw new TypeError("error 不是字符串");
      const feature = prepare(payload);
      try {
        persist(payload, feature, { status: "failed", refinedText: "", error: payload.error });
      } catch (error) {
        // 悬浮条在失败的分支里才走到这里（renderer/bar/bar.mjs 的 reportFailure），
        // 再抛一次只会把它的 catch 带崩，这一次失败就没法显示给用户了
        log.error("delivery_record_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
      }
    },
  };
}
