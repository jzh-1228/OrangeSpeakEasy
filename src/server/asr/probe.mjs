import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";

// 检查本机转写模型用的一句话：用系统朗读当场念出来，交给模型转写，看它认不认得出。
// macOS 用 say；Windows 用系统自带的语音合成（System.Speech，经 PowerShell 调）。
// 静音不行：分段时整段静音根本不交给模型（segment.mjs），查不到东西。
// 现念的好处是仓库和安装包里不用带录音，念的是什么也清楚，转写结果拿来一对就知道模型在不在正常干活。

/**
 * 按界面语言念哪句、用哪个声音。voice 是 macOS 自带的声音；Windows 按 culture 挑一个装着的那种语言的声音
 * （中文系统自带 Huihui，英文自带 Zira）。这台电脑上没有的话用系统默认的声音念
 */
export const PROBE_SPEECH = Object.freeze({
  "zh-CN": Object.freeze({ voice: "Tingting", culture: "zh-CN", text: "今天下午三点开会，记得带上电脑。" }),
  en: Object.freeze({ voice: "Samantha", culture: "en-US", text: "The meeting starts at three this afternoon." }),
});

/**
 * Windows 上念：要念的话、写到哪、哪种语言都经环境变量交过去，脚本里不拼任何外来的字，不用管转义。
 * 输出格式直接定成 16 kHz、16 位、单声道，和 macOS 那边一样
 */
const WINDOWS_SPEAK = [
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $env:ORANGESPEAKEASY_PROBE_CULTURE } | Select-Object -First 1",
  "if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }",
  `$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo ${SPEECH_SAMPLE_RATE}, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)`,
  "$synth.SetOutputToWaveFile($env:ORANGESPEAKEASY_PROBE_FILE, $format)",
  "$synth.Speak($env:ORANGESPEAKEASY_PROBE_TEXT)",
  "$synth.Dispose()",
].join("; ");

const runFile = promisify(execFile);

/**
 * 念一句检查用的话。
 * @param {string} locale 界面语言；没有对应句子的按英文
 * @param {{ run?: (file: string, args: string[], options?: object) => Promise<unknown>, platform?: NodeJS.Platform }} [options]
 *   测试时换掉真的 say / PowerShell
 * @returns {Promise<{ samples: Float32Array, said: string }>} 16 kHz 单声道的样本，和念的是哪句
 */
export async function speechSample(locale, { run = runFile, platform = process.platform } = {}) {
  const { voice, culture, text } = PROBE_SPEECH[locale] ?? PROBE_SPEECH.en;
  const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-probe-"));
  try {
    const file = join(dir, "probe.wav");
    if (platform === "win32") {
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEAK], {
        env: {
          ...process.env,
          ORANGESPEAKEASY_PROBE_FILE: file,
          ORANGESPEAKEASY_PROBE_TEXT: text,
          ORANGESPEAKEASY_PROBE_CULTURE: culture,
        },
        windowsHide: true,
      });
    } else {
      const args = ["-o", file, "--file-format=WAVE", `--data-format=LEI16@${SPEECH_SAMPLE_RATE}`, text];
      try {
        await run("say", ["-v", voice, ...args]);
      } catch {
        // 多半是这台电脑上没有这个声音：用默认的声音念。默认的也念不出来就让错往上走
        await run("say", args);
      }
    }
    return { samples: wavSamples(readFileSync(file)), said: text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * say 写出的 WAV → 样本。它在 fmt 和 data 之间会多写一个块（FLLR），所以按块找，不按固定的 44 字节头读
 * （pcm.mjs 的 decodeWav 只认评测自己写的那种）。要的是 16 kHz、单声道、16 位，不是就报错
 */
function wavSamples(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("系统朗读写出来的不是 WAV 文件");
  }
  let format = null;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        tag: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) throw new Error("系统朗读写出来的 WAV 没有格式块");
      if (format.tag !== 1 || format.bits !== 16) throw new Error("系统朗读写出来的不是 16 位 PCM");
      if (format.channels !== 1) throw new Error(`系统朗读写出来的有 ${format.channels} 个声道，要单声道`);
      if (format.rate !== SPEECH_SAMPLE_RATE) {
        throw new Error(`系统朗读写出来的是 ${format.rate} Hz，要 ${SPEECH_SAMPLE_RATE} Hz`);
      }
      const end = Math.min(body + size, wav.length);
      const samples = new Float32Array(Math.floor((end - body) / 2));
      for (let i = 0; i < samples.length; i++) {
        const value = wav.readInt16LE(body + i * 2);
        samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
      }
      return samples;
    }
    // 块的长度是奇数时后面补一个字节
    offset = body + size + (size % 2);
  }
  throw new Error("系统朗读写出来的 WAV 里没有声音");
}
