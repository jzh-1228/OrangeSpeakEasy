import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { PROBE_SPEECH, speechSample } from "../../../src/server/asr/probe.mjs";

/** 系统朗读写出来的那种 WAV：fmt 和 data 之间夹着一个别的块（实测 say 会写一个 FLLR） */
function sayLikeWav(values, { rate = 16_000, channels = 1, bits = 16 } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * (bits / 8), 16);
  fmt.writeUInt16LE(channels * (bits / 8), 20);
  fmt.writeUInt16LE(bits, 22);
  const filler = Buffer.alloc(8 + 6);
  filler.write("FLLR", 0, "ascii");
  filler.writeUInt32LE(6, 4);
  const data = Buffer.alloc(8 + values.length * 2);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(values.length * 2, 4);
  for (const [i, value] of values.entries()) data.writeInt16LE(value, 8 + i * 2);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, filler, data]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** 假的 say：记下每次的参数，往 -o 给的路径写 wav；failVoice 为真时带 -v 的那次失败（这台电脑上没装那个声音） */
function fakeSay(wav, { failVoice = false } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (failVoice && args.includes("-v")) throw new Error("Voice `Tingting' not found.");
    writeFileSync(args[args.indexOf("-o") + 1], wav);
  };
  return { calls, run };
}

test("用系统朗读现念一句检查用的话，读回 16 kHz 单声道的样本；中间多出来的块跳过", async () => {
  const { calls, run } = fakeSay(sayLikeWav([0, 16384, -32768, 32767]));
  const { samples, said } = await speechSample("zh-CN", { run, platform: "darwin" });
  assert.equal(said, PROBE_SPEECH["zh-CN"].text);
  assert.deepEqual(samples, new Float32Array([0, 16384 / 32767, -1, 1]));
  assert.equal(calls[0].file, "say");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-v", PROBE_SPEECH["zh-CN"].voice]);
  assert.ok(calls[0].args.includes("--data-format=LEI16@16000"));
  assert.equal(calls[0].args.at(-1), PROBE_SPEECH["zh-CN"].text);
});

test("界面是英文就念英文；不认识的语言按英文", async () => {
  const { calls, run } = fakeSay(sayLikeWav([1, 2]));
  assert.equal((await speechSample("en", { run, platform: "darwin" })).said, PROBE_SPEECH.en.text);
  assert.equal((await speechSample("fr", { run, platform: "darwin" })).said, PROBE_SPEECH.en.text);
  assert.equal(calls[1].args[1], PROBE_SPEECH.en.voice);
});

test("这台电脑上没有那个声音：换系统默认的声音再念一次", async () => {
  const { calls, run } = fakeSay(sayLikeWav([1, 2, 3]), { failVoice: true });
  const { samples } = await speechSample("zh-CN", { run, platform: "darwin" });
  assert.equal(samples.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("-v"), false);
});

test("念出来的不是 16 kHz 单声道 16 位：照实报错，不拿错的样本去转写", async () => {
  await assert.rejects(
    speechSample("en", { ...fakeSay(sayLikeWav([1, 2], { rate: 22_050 })), platform: "darwin" }),
    /22050/,
  );
  await assert.rejects(
    speechSample("en", { ...fakeSay(sayLikeWav([1, 2], { channels: 2 })), platform: "darwin" }),
    /声道/,
  );
  await assert.rejects(speechSample("en", { ...fakeSay(Buffer.from("not a wav")), platform: "darwin" }), /WAV/);
});

test("Windows：用系统自带的语音合成念，要念的话、写到哪、哪种语言都经环境变量交过去，读回的样本一样", async () => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    writeFileSync(options.env.ORANGESPEAKEASY_PROBE_FILE, sayLikeWav([0, 16384]));
  };
  const { samples, said } = await speechSample("zh-CN", { run, platform: "win32" });
  assert.equal(said, PROBE_SPEECH["zh-CN"].text);
  assert.equal(samples.length, 2);
  const [{ file, args, env }] = calls;
  assert.equal(file, "powershell");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  // 脚本里不拼外来的字：念的那句只在环境变量里
  assert.ok(!args[3].includes(PROBE_SPEECH["zh-CN"].text));
  assert.match(args[3], /SpeechAudioFormatInfo 16000/);
  assert.equal(env.ORANGESPEAKEASY_PROBE_TEXT, PROBE_SPEECH["zh-CN"].text);
  assert.equal(env.ORANGESPEAKEASY_PROBE_CULTURE, "zh-CN");
});
