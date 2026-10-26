import { LocalizedError, msg } from "../../i18n/index.mjs";
import { downsample, encodeWav, mixDown, SPEECH_SAMPLE_RATE } from "./pcm.mjs";

// 把录音换成别家模型收的格式。录音是 Opus：悬浮条录的装在 WebM 里，原版 Typeless 的装在 Ogg 里。
// Gemini 两种都直接收，用不到这里；OpenAI 只收 wav 和 mp3（实测，别的格式回 400）。
// Ogg 不转：拆 Ogg 要用 LGPL 的 codec-parser，作者定了不随程序分发；OrangeSpeakEasy 自己只录 WebM。

const CONTAINERS = [
  { magic: Buffer.from("OggS"), mimeType: "audio/ogg" },
  { magic: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), mimeType: "audio/webm" },
];

/** 靠文件头认录音的容器：audio/ogg、audio/webm，别的是 null */
export function audioTypeOf(bytes) {
  return CONTAINERS.find(({ magic }) => bytes.subarray(0, magic.length).equals(magic))?.mimeType ?? null;
}

/**
 * 程序自己认的录音格式：格式 → 加载它的解码器。用到才加载：解码器带着 WASM，只用 Gemini 的人不必付这个启动开销。
 * 评测要解原版的 Ogg，自己另传一份（bench/），程序里不放。
 */
export const DECODERS = new Map([["audio/webm", () => import("@audio/decode-webm")]]);

/**
 * 录音 → 识别用的统一格式：16 kHz 单声道的样本（-1 到 1）。
 * 实测 90 秒的录音交给 OpenAI：48 kHz 要 18 秒，16 kHz 是 7–9 秒，算的音频 token 数一样。
 * @param {Buffer} audio 整段录音
 * @param {string} mimeType 服务端按文件头认出来的格式（见 protocol/session.mjs）
 * @param {Map<string, () => Promise<{ default: (bytes: Uint8Array) => Promise<{ channelData: Float32Array[], sampleRate: number }> }>>} [decoders]
 * @returns {Promise<Float32Array>}
 */
export async function toSpeech(audio, mimeType, decoders = DECODERS) {
  const load = decoders.get(mimeType);
  if (!load) throw new Error(`没法把 ${mimeType} 换成识别用的格式：只认 ${[...decoders.keys()].join("、")}`);
  const { default: decode } = await load();
  let decoded;
  try {
    decoded = await decode(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
  } catch (error) {
    throw new LocalizedError(msg("audio.undecodable", { type: mimeType, reason: String(error?.message ?? error) }), {
      cause: error,
    });
  }
  if (!decoded?.channelData?.length || decoded.channelData[0].length === 0) {
    throw new LocalizedError(msg("audio.empty", { type: mimeType }));
  }
  return downsample(mixDown(decoded.channelData), decoded.sampleRate, SPEECH_SAMPLE_RATE);
}

/**
 * 录音 → 16 kHz 单声道 16 位 WAV，给只收 WAV 的那几家。
 * @returns {Promise<{ audio: Buffer, mimeType: "audio/wav" }>}
 */
export async function toWav(audio, mimeType) {
  return { audio: encodeWav(await toSpeech(audio, mimeType), SPEECH_SAMPLE_RATE), mimeType: "audio/wav" };
}
