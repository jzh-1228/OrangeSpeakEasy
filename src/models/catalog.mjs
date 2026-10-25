// 本地模型的配置表：全局只有这一份，别处不另写模型的信息。有哪些模型、每个文件从哪下（国内源 / 原始地址）、
// 大小和校验值、许可和原作者、适合什么机器（标签和实测数字），都从这里取：
//   下载和校验（store.mjs）、转写进程（server/asr/）、设置和命令行、App、评测（bench/）、
//   往国内源上传（scripts/release/sync-models.mjs）。
//
// 一项是"一个模型在一个运行库里用的一份文件"：同一个 Qwen3-ASR，sherpa-onnx 用 ONNX、transcribe.cpp 用 GGUF，是两项。
// 模型文件本身不进仓库：用到时下载到用户的机器上。原始地址钉在 Hugging Face 的某一次提交上，内容不会再变；
// 国内源是魔搭（ModelScope）上同一批文件的副本，也钉在一次提交上。每个文件下载完都按 sha256 校验，所以从哪个源下的都一样。
// files 按用途起名（encoder、tokens…），运行库的适配器按这些名字把文件填进它的配置（server/asr/engines/*.mjs 的 FAMILIES）。
// maxSeconds 是一次最多吃多少秒的音频，有上限的才写：更长的录音由 server/asr/segment.mjs 切开逐段转写。
// vocabulary 是收不收用户词典、收多少（vocabulary/support.mjs），不收的不写；放进哪里由运行库的适配器管。
//
// 加一个模型 = 在 MODELS 里加一项（它用的运行库要在 server/asr/engines/index.mjs 登记过，family 要是那个运行库认得的），
// 再跑一次 scripts/release/sync-models.mjs 把文件传到魔搭，把它报的提交填进这一项的 mirror。标签和实测数字跑过评测再补。
import { vocabularySupport } from "../vocabulary/support.mjs";

// ---------- 下载源 ----------

/**
 * 国内源：魔搭（ModelScope）上这个账号名下的模型仓库，一个模型一个仓库，仓库名就是模型 id。
 * 魔搭对下载不收钱、在国内有自己的 CDN，也认 Range（断点续传）。scripts/release/sync-models.mjs 往上传。
 * 魔搭建组织要人工审核，先放在作者的个人账号下；换到组织名下时重传一遍、改这里和各项的 mirror.revision 就行
 */
export const MODELSCOPE_OWNER = "ardsfsw";

/** 一个模型在魔搭上的仓库 */
export const mirrorRepo = (model) => `${MODELSCOPE_OWNER}/${model.id}`;

/** 国内源：魔搭上钉在那次提交（mirror.revision）的文件。换了提交就是新地址，内容不会再变 */
const modelScope = (model, file) =>
  `https://modelscope.cn/models/${mirrorRepo(model)}/resolve/${model.mirror.revision}/${file.path}`;

/** 原始地址：Hugging Face 上钉在那次提交的文件 */
const huggingFace = (model, file) =>
  `https://huggingface.co/${model.origin.repo}/resolve/${model.origin.revision}/${file.path}`;

/** 国内常用的 Hugging Face 镜像，路径的排法和 Hugging Face 一样。算在原始地址里：它只是 Hugging Face 的影子 */
const hfMirror = (model, file) =>
  `https://hf-mirror.com/${model.origin.repo}/resolve/${model.origin.revision}/${file.path}`;

/**
 * 下载源，用户在设置里选一个（modelSource）。选的那个先试，连不上、卡住、超了流量就换下一个源，
 * 所以选哪个只影响快慢，不影响下不下得到。叫什么写在文案里（modelSources.<id>）。
 * urls 是这个源里依次试的地址
 */
export const SOURCES = Object.freeze([
  Object.freeze({ id: "cn", urls: Object.freeze([modelScope]) }),
  Object.freeze({ id: "original", urls: Object.freeze([huggingFace, hfMirror]) }),
]);

/** 用的人几乎都在国内：默认先走国内源 */
export const DEFAULT_SOURCE = "cn";

/** @returns {(typeof SOURCES)[number] | null} */
export function findSource(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}

/** 一个文件依次从哪些地址下：选的那个源在前，其余的源按 SOURCES 的先后垫在后面 */
export function downloadUrls(model, file, preferred = DEFAULT_SOURCE) {
  const first = findSource(preferred);
  if (!first) throw new Error(`没有 ${preferred} 这个下载源，能用的有 ${SOURCES.map(({ id }) => id).join(" / ")}`);
  return [first, ...SOURCES.filter((source) => source !== first)].flatMap((source) =>
    source.urls.map((urlOf) => urlOf(model, file)),
  );
}

// ---------- 机器和标签 ----------

/** 芯片：按系统和架构认（chipOf）。标签和实测数字按它分 */
export const CHIPS = Object.freeze([
  Object.freeze({ id: "apple-silicon", platform: "darwin", arch: "arm64" }),
  Object.freeze({ id: "intel-mac", platform: "darwin", arch: "x64" }),
  Object.freeze({ id: "windows-x64", platform: "win32", arch: "x64" }),
  Object.freeze({ id: "windows-arm64", platform: "win32", arch: "arm64" }),
]);

/** 这台机器是哪类芯片；不在 CHIPS 里的是 null */
export function chipOf(platform = process.platform, arch = process.arch) {
  return CHIPS.find((chip) => chip.platform === platform && chip.arch === arch)?.id ?? null;
}

/**
 * 标签和它是哪一类，文案在 models.tags.<id>。都按实测打（bench/results/），没测过的不打：
 *   chip      适合哪类芯片：在那类芯片上实测过（measured 里有），而且是那类芯片上该选的
 *   backend   能用什么跑：measured 里有在它上面跑的数字
 *   strength  比清单里同类强的地方：看评测报告里的对比
 */
export const TAGS = Object.freeze({
  "apple-silicon": "chip",
  "windows-x64": "chip",
  metal: "backend",
  vulkan: "backend",
  cpu: "backend",
  "zh-en": "strength",
  fast: "strength",
  small: "strength",
});

/**
 * 第一轮评测（bench/results/asr-round1-2026-10-16.md）：97 条真实口述，Apple 芯片的 Mac。
 * measured 里 score 是总均分，zh、mix 是按语言分的均分（中文 47 条、中英夹杂 45 条），满分 5
 */
const ROUND1 = "asr-round1-2026-10-16";
/** Windows 那一轮（bench/results/asr-windows-2026-10-17.md）：同一批录音，RTX 4060 Ti 走 Vulkan、i5-13400F 只用 CPU */
const WINDOWS = "asr-windows-2026-10-17";

// ---------- 模型 ----------

const FUNASR_LICENSE = Object.freeze({
  name: "FunASR Model License",
  // 钉在 FunASR 仓库的某一次提交上：往国内源上传时连同许可原文一起传
  url: "https://raw.githubusercontent.com/modelscope/FunASR/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE",
});
const APACHE_LICENSE = Object.freeze({
  name: "Apache-2.0",
  url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
});

const freeze = (model) => {
  // 漏写必填字段（新加一条模型时最容易出的事）当场说清是哪个模型缺了什么，
  // 而不是等某个进程用到时才抛一个看不出出处的 TypeError
  for (const field of ["tags", "files", "origin", "mirror"]) {
    if (!model[field]) throw new TypeError(`模型 ${model.id} 缺少字段 ${field}`);
  }
  return Object.freeze({
    ...model,
    origin: Object.freeze(model.origin),
    mirror: Object.freeze(model.mirror),
    files: Object.freeze(model.files),
    tags: Object.freeze(model.tags),
    // measured 漏写（新加一条模型时最容易漏的一项）不能把整个模块的加载炸掉：CLI、App、后台都 import
    // 这张表，一处漏写会一起倒下。没有实测数据就是空表——measuredOn 返回空，按实测做的筛选也不会选中它
    measured: Object.freeze((model.measured ?? []).map((entry) => Object.freeze({ run: ROUND1, ...entry }))),
  });
};

/**
 * 每一项：
 *   id、name、engine（运行库）、family（运行库里的哪一族）、maxSeconds、vocabulary（都可有可无）
 *   license   许可的名字和原文地址
 *   author    原作者发布这个模型的仓库（Hugging Face）。FunASR 的许可要求注明来源和作者、保留模型名
 *   origin    原始地址：下载的这一份在哪个仓库、钉在哪次提交；notice 是那个仓库里随文件分发的声明（可有可无）
 *   mirror    国内源：魔搭上那个仓库（mirrorRepo）钉在哪次提交（sync-models.mjs 传完报出来的）
 *   files     要下载的文件：相对路径、字节数、sha256
 *   tags      标签（TAGS）
 *   measured  实测：在哪类芯片（chip）、用什么跑（backend），判官均分（0–5）、每条录音转写耗时的中位数、
 *             实时倍数（录音时长 ÷ 转写耗时）、内存峰值，出自哪一轮评测（run，bench/results/<run>.md）
 *
 * 先后就是列给用户看的先后：默认的在最前，能用 GPU 加速的在前，只用 CPU 的在后。
 */
export const MODELS = Object.freeze(
  [
    {
      id: "qwen3-asr-0.6b-q8",
      name: "Qwen3-ASR 0.6B (Q8_0)",
      engine: "transcribe-cpp",
      family: "qwen3-asr",
      // 词表放在系统提示词里，超出运行库的预算它自己从后往前丢。2026-10-19 实测 27 秒的录音：Metal 上 1000 字只多 0.07 秒，
      // 只用 CPU 时 600 字多 0.3 秒、1000 字多 0.6 秒，取 600
      vocabulary: vocabularySupport("hotwords", { maxChars: 600 }),
      license: APACHE_LICENSE,
      author: "Qwen/Qwen3-ASR-0.6B",
      origin: {
        repo: "handy-computer/Qwen3-ASR-0.6B-gguf",
        revision: "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
        notice: "NOTICE",
      },
      mirror: { revision: "275debc0a82a6d29ed40d72cc0be5bd66bc43e26" },
      files: {
        gguf: {
          path: "Qwen3-ASR-0.6B-Q8_0.gguf",
          size: 850_423_456,
          sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
        },
      },
      // 第一轮里最准，中英夹杂时领先最多；Windows 上也是
      tags: ["apple-silicon", "windows-x64", "metal", "vulkan", "cpu", "zh-en"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "metal",
          score: 4.14,
          zh: 4.32,
          mix: 4.02,
          p50Ms: 231,
          realtime: 67.5,
          peakMB: 1964,
        },
        {
          chip: "apple-silicon",
          backend: "cpu",
          score: 4.14,
          zh: 4.34,
          mix: 4.0,
          p50Ms: 1061,
          realtime: 16,
          peakMB: 4499,
        },
        // 跑在显卡上时模型放在显存里，内存峰值不含显存
        {
          chip: "windows-x64",
          backend: "vulkan",
          run: WINDOWS,
          score: 4.16,
          zh: 4.34,
          mix: 4.04,
          p50Ms: 240,
          realtime: 72.9,
          peakMB: 509,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 4.18,
          zh: 4.38,
          mix: 4.04,
          p50Ms: 2653,
          realtime: 6.1,
          peakMB: 3997,
        },
      ],
    },
    {
      id: "sensevoice-small-q8",
      name: "SenseVoice Small (Q8_0)",
      engine: "transcribe-cpp",
      family: "sense-voice",
      license: FUNASR_LICENSE,
      author: "FunAudioLLM/SenseVoiceSmall",
      origin: {
        repo: "handy-computer/SenseVoiceSmall-gguf",
        revision: "ff8f085a8fa2e5ccae0e849ef19ebc6dc18e608b",
        notice: "NOTICE",
      },
      mirror: { revision: "b569f1bc9765ce41d43d90fca5d997060861733f" },
      files: {
        gguf: {
          path: "SenseVoiceSmall-Q8_0.gguf",
          size: 252_684_608,
          sha256: "6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29",
        },
      },
      // 速度约是 Qwen3 Q8 的 3 倍、体积约 1/3；纯中文和它差不多，弱在英文词
      tags: ["apple-silicon", "windows-x64", "metal", "vulkan", "cpu", "fast", "small"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "metal",
          score: 3.94,
          zh: 4.38,
          mix: 3.51,
          p50Ms: 73,
          realtime: 226,
          peakMB: 1214,
        },
        {
          chip: "windows-x64",
          backend: "vulkan",
          run: WINDOWS,
          score: 3.94,
          zh: 4.38,
          mix: 3.51,
          p50Ms: 107,
          realtime: 186.1,
          peakMB: 917,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 3.93,
          zh: 4.38,
          mix: 3.49,
          p50Ms: 887,
          realtime: 19.6,
          peakMB: 985,
        },
      ],
    },
    {
      id: "qwen3-asr-0.6b-int8",
      name: "Qwen3-ASR 0.6B (int8)",
      engine: "sherpa-onnx",
      family: "qwen3-asr",
      // 这份 ONNX 导出时把解码器的 KV 缓存定死成 512 个位置（提示词 + 音频 + 输出的字都算在内），音频一秒约折 13 个。
      // 实测（bench/）：38 秒以上的录音只吐出 "language" 或空的，33–35 秒的悄悄丢掉后一半。按 20 秒一段切开留足余量
      maxSeconds: 20,
      // 词表也占这 512 个位置。2026-10-19 拿 18.7 秒的录音实测：400 字（275 个 token）开始截音频，600 字只吐出标记。
      // 20 秒一段的音频约 260 个，再给输出留出余量，词表限在 120 字（约 90 个）
      vocabulary: vocabularySupport("hotwords", { maxChars: 120 }),
      license: APACHE_LICENSE,
      author: "Qwen/Qwen3-ASR-0.6B",
      origin: {
        repo: "csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        revision: "68818b2313fe77bd06f6a7c5068ff3ef59d02b8a",
      },
      mirror: { revision: "0d32a807e2af129074fb0bf6766fd9080c64141d" },
      files: {
        convFrontend: {
          path: "conv_frontend.onnx",
          size: 44_148_281,
          sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
        },
        encoder: {
          path: "encoder.int8.onnx",
          size: 182_491_662,
          sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
        },
        decoder: {
          path: "decoder.int8.onnx",
          size: 755_914_231,
          sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
        },
        tokenizerMerges: {
          path: "tokenizer/merges.txt",
          size: 1_671_853,
          sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        },
        tokenizerConfig: {
          path: "tokenizer/tokenizer_config.json",
          size: 12_487,
          sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
        },
        tokenizerVocab: {
          path: "tokenizer/vocab.json",
          size: 2_776_833,
          sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        },
      },
      tags: ["cpu"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "cpu",
          score: 4.02,
          zh: 4.32,
          mix: 3.8,
          p50Ms: 1081,
          realtime: 15.2,
          peakMB: 3526,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 4.06,
          zh: 4.36,
          mix: 3.8,
          p50Ms: 3388,
          realtime: 5.2,
          peakMB: 2475,
        },
      ],
    },
    {
      id: "sensevoice-small-int8",
      name: "SenseVoice Small (int8)",
      engine: "sherpa-onnx",
      family: "sense-voice",
      license: FUNASR_LICENSE,
      author: "FunAudioLLM/SenseVoiceSmall",
      origin: {
        repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
        revision: "355f4d4884d8afd08aef04b9007a8556d7b463b2",
      },
      mirror: { revision: "d706ce3dbf2c6b046c9f5d589354d9844e29dff0" },
      files: {
        model: {
          path: "model.int8.onnx",
          size: 237_115_547,
          sha256: "12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d",
        },
        tokens: {
          path: "tokens.txt",
          size: 315_894,
          sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
        },
      },
      tags: ["cpu", "small"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "cpu",
          score: 3.78,
          zh: 4.13,
          mix: 3.51,
          p50Ms: 145,
          realtime: 107,
          peakMB: 1916,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 3.75,
          zh: 4.13,
          mix: 3.44,
          p50Ms: 463,
          realtime: 36.8,
          peakMB: 957,
        },
      ],
    },
  ].map(freeze),
);

/** 设置里没写时用哪个：第一轮评测里最准的那个。用户可以换 */
export const DEFAULT_TRANSCRIBER = "qwen3-asr-0.6b-q8";

/** @returns {(typeof MODELS)[number] | null} */
export function findModel(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

/** 出自哪家：作者仓库的组织名，小写（qwen、funaudiollm）。界面按它配图标 */
export const makerOf = (model) => model.author.split("/")[0].toLowerCase();

/** 一个模型要下载的总字节数 */
export function downloadSize(model) {
  return Object.values(model.files).reduce((sum, file) => sum + file.size, 0);
}

/** 在某类芯片上的实测，跑得快的在前；没测过是空的 */
export function measuredOn(model, chip) {
  return model.measured.filter((entry) => entry.chip === chip).sort((a, b) => b.realtime - a.realtime);
}

/**
 * 在某类芯片上给人看的标签。适合哪类芯片、能用什么跑，只认这类芯片上的实测：在 Mac 上测出来的
 * "适合 Apple 芯片""Metal 加速"不拿到 Windows 上说。比同类强在哪（strength）不分芯片
 * @param {string | null} chip chipOf 认出来的；认不出来时只剩强项
 */
export function tagsOn(model, chip) {
  return model.tags.filter((tag) => {
    if (TAGS[tag] === "chip") return tag === chip;
    if (TAGS[tag] === "backend") return model.measured.some((entry) => entry.chip === chip && entry.backend === tag);
    return true;
  });
}
