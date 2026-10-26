#!/usr/bin/env node
// 端到端测试：真的 Electron、真的录音编码、真的服务端和模型，只有两头是假的——
// 麦克风换成一个 WAV 文件，贴字换成"记下来"。不会碰真实的键盘、剪贴板和历史记录。
//
// 用法：环境里要有所选那一家的 key（后台应用用它起内置的服务）。默认用 Gemini，ORANGESPEAKEASY_MODEL 可以换：
//   scripts/dev/with-key.sh gemini node scripts/dev/e2e.mjs <一段 16 位 PCM 的 WAV>
//   ORANGESPEAKEASY_MODEL=openai scripts/dev/with-key.sh openai node scripts/dev/e2e.mjs <一段 16 位 PCM 的 WAV>
// 录音时长默认 7.5 秒（跨过两个 3 秒的分块边界），可用 ORANGESPEAKEASY_E2E_RECORD_MS 改。
// 本地转写那条（local 模式）：数据目录是新的，本地模型会真从下载源下一遍（ORANGESPEAKEASY_MODEL_SOURCE 可以换），装好才开始录：
//   ORANGESPEAKEASY_MODE=local scripts/dev/with-key.sh deepseek node scripts/dev/e2e.mjs <WAV>
// 数据隐私那条（private 模式）不要 key，同样先下模型：ORANGESPEAKEASY_MODE=private node scripts/dev/e2e.mjs <WAV>
// 想用打包时摆出来的那一份跑（只带运行时依赖，看漏没漏包）：ORANGESPEAKEASY_E2E_APP=<摆好的目录>
// 想用打好的应用跑（签了名、开着 hardened runtime，看本地转写的原生库加载不加载得了）：
//   ORANGESPEAKEASY_E2E_ELECTRON=<OrangeSpeakEasy.app>/Contents/MacOS/OrangeSpeakEasy
// 带词典跑：ORANGESPEAKEASY_E2E_VOCABULARY="词1,词2" 先在数据目录里放一份词典，ORANGESPEAKEASY_E2E_EXPECT=词 要求成品里有这个词（不分大小写）。
// 不想每次都重下本地模型：ORANGESPEAKEASY_E2E_MODELS=<已装好的模型仓>（比如 bench/_work/models），开跑前克隆进数据目录（APFS 上不占空间）。
// 听写几遍：ORANGESPEAKEASY_E2E_ROUNDS=2。本机模型按需装载时两遍之间等它空闲释放，第二遍验重新装载：
//   ORANGESPEAKEASY_MODE=private ORANGESPEAKEASY_LOCAL_MODEL_MEMORY=1m ORANGESPEAKEASY_E2E_ROUNDS=2 node scripts/dev/e2e.mjs <WAV>
// 语音翻译：ORANGESPEAKEASY_E2E_ACTION=translate，译成什么用 ORANGESPEAKEASY_TRANSLATE_TO（默认英文）；
// ORANGESPEAKEASY_E2E_ACTION=upgrade 是先按语音输入的键、再凑成语音翻译的组合，验中途换成翻译、录音不断：
//   ORANGESPEAKEASY_E2E_ACTION=translate ORANGESPEAKEASY_TRANSLATE_TO=ja scripts/dev/with-key.sh gemini node scripts/dev/e2e.mjs <WAV>

import { spawn } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wav = process.argv[2] && resolve(process.argv[2]);
if (!wav || !existsSync(wav)) {
  console.error("用法：node scripts/dev/e2e.mjs <一段 16 位 PCM 的 WAV>");
  process.exit(2);
}

const electron = createRequire(import.meta.url)("electron");
// 名字起得短：家目录里要放控制通道的套接字，路径有长度上限
const workDir = mkdtempSync(join(tmpdir(), "sm-e2e-"));
const outPath = join(workDir, "result.json");
const home = join(workDir, "home");
const vocabulary = process.env.ORANGESPEAKEASY_E2E_VOCABULARY?.split(",")
  .map((term) => term.trim())
  .filter(Boolean);
if (vocabulary?.length) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "vocabulary.json"), `${JSON.stringify({ terms: vocabulary }, null, 2)}\n`);
}
if (process.env.ORANGESPEAKEASY_E2E_MODELS) {
  cpSync(resolve(process.env.ORANGESPEAKEASY_E2E_MODELS), join(home, "models"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

// 打好的应用自己知道程序在哪，不用指给它
const packaged = process.env.ORANGESPEAKEASY_E2E_ELECTRON;
const child = spawn(
  packaged ?? electron,
  [
    ...(packaged ? [] : ["."]),
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // %noloop：文件放完就静音，不从头再放
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    // 音频服务默认在沙箱里，读不到这个 WAV。只在测试里放开这一个服务的沙箱
    "--disable-features=AudioServiceSandbox",
  ],
  {
    cwd: process.env.ORANGESPEAKEASY_E2E_APP ?? resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ORANGESPEAKEASY_E2E_OUT: outPath, ORANGESPEAKEASY_HOME: home },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

// Electron 万一卡住（比如启动就出错），到时间强制结束，测试算失败而不是一直挂着。
// 要本机模型的（local、private 模式）另给下载和装载模型的时间
const recordMs = Number(process.env.ORANGESPEAKEASY_E2E_RECORD_MS ?? 7_500);
const setupMs = ["local", "private"].includes(process.env.ORANGESPEAKEASY_MODE) ? 20 * 60_000 : 0;
// 听写几遍；本机模型按需装载时，两遍之间等它空闲释放（最长 30 分钟，见 src/app/e2e.mjs）
const rounds = Number(process.env.ORANGESPEAKEASY_E2E_ROUNDS ?? 1);
const watchdog = setTimeout(
  () => child.kill("SIGKILL"),
  setupMs + rounds * (recordMs + 60_000) + (rounds - 1) * 31 * 60_000,
);

child.on("exit", (code) => {
  clearTimeout(watchdog);
  const problems = [];
  let result = null;
  if (!existsSync(outPath)) {
    problems.push(`Electron 以 ${code} 退出，没有留下结果文件`);
  } else {
    result = JSON.parse(readFileSync(outPath, "utf8"));
    if (result.failed) problems.push(`听写失败：${result.failed}`);
    if (!result.delivered) problems.push("没有拿到成品文字");
    const delivered = result.rounds.map((round) => round.delivered);
    if (result.pasted.length !== rounds || result.pasted.some((text, index) => text !== delivered[index]))
      problems.push("贴出去的文字和成品不一致");
    // 历史里新的在前
    const rows = result.history.toReversed();
    if (
      rows.length !== rounds ||
      rows.some((row, index) => row.status !== "completed" || row.refinedText !== delivered[index])
    ) {
      problems.push(`历史里应该正好有 ${rounds} 条完成的记录，内容等于成品`);
    }
    for (const [index, row] of rows.entries()) {
      const round = rounds > 1 ? `第 ${index + 1} 遍：` : "";
      if (result.rounds[index]) console.log(`${round}松开后 ${result.rounds[index].ms} 毫秒出字`);
      // 语音翻译（直接按的、升级来的）：历史里记着是翻译、原文和目标语言
      const action = process.env.ORANGESPEAKEASY_E2E_ACTION ?? "dictate";
      const kind = action === "upgrade" ? "translate" : action;
      if (row.kind !== kind) problems.push(`${round}历史里记的功能是 ${row.kind}，应该是 ${kind}`);
      if (kind === "translate") {
        if (!row.sourceText || !row.outputLanguage) problems.push(`${round}翻译的历史没有原文或目标语言`);
        console.log(`${round}原文：${row.sourceText}\n${round}译成 ${row.outputLanguage}`);
      }
      // 历史里只记录音的文件名，录音在家目录的 data/Recordings 下（storage/paths.mjs 的 recordingsDir）
      const recording = row.audioFile && join(home, "data", "Recordings", row.audioFile);
      if (!recording || !existsSync(recording) || statSync(recording).size === 0) {
        problems.push(`${round}录音文件没有存下来`);
      } else {
        console.log(`${round}录音 ${row.duration.toFixed(1)} 秒，文件 ${statSync(recording).size} 字节`);
      }
      // 记账：这一次听写调模型的账对得上这条历史。数据隐私模式只有本机转写那一笔：没有 token、不花钱
      const { usage } = row;
      const local = process.env.ORANGESPEAKEASY_MODE === "private";
      const counted = local ? usage?.calls === 1 && usage.costUsd === 0 : usage?.inputTokens > 0;
      if (!usage || usage.calls < 1 || !counted || !(usage.latencyMs > 0)) {
        problems.push(`${round}这条历史没有对上账：${JSON.stringify(usage)}`);
      } else {
        const cost = usage.costUsd === null ? "价格不明" : `$${usage.costUsd.toPrecision(2)}`;
        console.log(
          `${round}调了 ${usage.calls} 次模型：输入 ${usage.inputTokens} token、输出 ${usage.outputTokens} token，${cost}，模型 ${usage.latencyMs} 毫秒`,
        );
      }
    }
  }
  if (result?.localModel) {
    const { downloadMs, loadMs, backend } = result.localModel;
    console.log(`本地模型：下载 ${(downloadMs / 1000).toFixed(1)} 秒，装载 ${loadMs} 毫秒，跑在 ${backend}`);
  }
  for (const [index, round] of (result?.rounds ?? []).entries())
    if (round.delivered) console.log(`${rounds > 1 ? `第 ${index + 1} 遍` : ""}成品：${round.delivered}`);
  const expected = process.env.ORANGESPEAKEASY_E2E_EXPECT;
  if (expected && !result?.delivered?.toLowerCase().includes(expected.toLowerCase()))
    problems.push(`成品里没有 ${expected}${vocabulary?.length ? `（词典里放了 ${vocabulary.length} 个词）` : ""}`);
  rmSync(workDir, { recursive: true, force: true });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`);
    process.exit(1);
  }
  console.log("✔ 录音、分块上传、整理、贴字、存历史、记账都走通了");
});
