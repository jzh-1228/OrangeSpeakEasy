#!/usr/bin/env node
// 发版前看一眼：从下载地址上现在的最新版本升到这次打的（dist/release），每种装法要下多少。
// npm run ship 在上传前跑它（算法在 delta.mjs）。拦下两种：
//   - 版本号往回退了，或者同一个版本号、内容却不一样（退出码 4，不能放行）
//   - Electron 没换、却有哪种装法要下 20 MB 以上，多半是打包出了问题（退出码 3）；确实要这样发，加 --allow-big
// 没算成（连不上、下载地址上的东西不对）退出码 1。
//
//   node scripts/release/delta-report.mjs              比下载地址上的
//   node scripts/release/delta-report.mjs --allow-big  超了也不拦，只报
//
// 只比正式的下载地址（和 ship 传的、核对的是同一处），不认 ORANGESPEAKEASY_INSTALL_BASE：本机试装时设的它可能还留在终端里。
// 算的是"只装着上一版的机器要下多少"：本机还装着别的几份时（比如 Mac 上终端安装和 App 都有）能拷的更多，实际只少不多。

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chunksIn, parseManifest } from "../../src/update/manifest.mjs";
import { unpackObject } from "../../src/update/objects.mjs";
import { DOWNLOAD_URL, parseChannel } from "../../src/update/release.mjs";
import { compareReleases, LIMIT_BYTES } from "./delta.mjs";
import { CHANNEL, objectPath } from "./release-layout.mjs";

const releaseDir = join(resolve(import.meta.dirname, "../.."), "dist", "release");
const EXIT = { failed: 1, tooBig: 3, refused: 4 };

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--allow-big");
if (unknown.length > 0) {
  console.error(`不认识的参数：${unknown.join(" ")}。只认 --allow-big`);
  process.exit(2);
}
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 取一个文件；404 交回 null，别的不对就抛 */
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`取不到 ${url}：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const chunksOf = (data, sha) => chunksIn(parseManifest(unpackObject(data, sha)));

try {
  const local = parseChannel(readFileSync(join(releaseDir, CHANNEL), "utf8"));
  const liveText = await fetchBytes(`${DOWNLOAD_URL}/${CHANNEL}`);
  if (liveText === null) {
    // 下载地址被刷到了封顶时一切都回 404：安装脚本取得到才算真的还没有 channel.json
    if ((await fetchBytes(`${DOWNLOAD_URL}/install.sh`)) === null) {
      throw new Error("下载地址上 channel.json 和 install.sh 都是 404：多半是触发了用量封顶，过了这个小时再来");
    }
    console.log(`下载地址上还没有 ${CHANNEL}：这是第一次按块发布，没有可比的。`);
    process.exit(0);
  }
  const live = parseChannel(liveText.toString("utf8"));
  const liveManifests = new Map();
  for (const sha of new Set(Object.values(live.targets))) {
    const data = await fetchBytes(`${DOWNLOAD_URL}/${objectPath(sha)}`);
    liveManifests.set(sha, data ? chunksOf(data, sha) : null);
  }
  const report = compareReleases({
    local,
    live,
    localChunks: (_target, sha) => chunksOf(readFileSync(join(releaseDir, objectPath(sha))), sha),
    liveChunks: (_target, sha) => liveManifests.get(sha),
    packedSize: (sha) => statSync(join(releaseDir, objectPath(sha))).size,
  });
  console.log(`从 ${live.version}（Electron ${live.electron}）升到 ${local.version}（Electron ${local.electron}）：`);
  for (const { target, bytes, chunks, fresh } of report.rows) {
    const note = fresh ? "（上一版没有这种装法，等于整个下）" : "";
    console.log(`  ${target.padEnd(18)} 要下 ${megabytes(bytes).padStart(9)}，${chunks} 块${note}`);
  }
  if (report.refuse) {
    console.error(`\n${report.refuse}。`);
    process.exit(EXIT.refused);
  }
  if (report.tooBig.length > 0) {
    const message = `Electron 没换，${report.tooBig.join("、")} 的更新却超过 ${megabytes(LIMIT_BYTES)}：多半是打包出了问题，先查清楚`;
    if (!args.includes("--allow-big")) {
      console.error(`\n${message}。确实要这样发的，用 npm run ship -- --allow-big。`);
      process.exit(EXIT.tooBig);
    }
    console.warn(`\n${message}（加了 --allow-big，不拦）`);
  }
} catch (error) {
  console.error(`没算成：${error.message}`);
  process.exit(EXIT.failed);
}
