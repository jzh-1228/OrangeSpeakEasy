// 本地模型的国内源（魔搭）上长什么样：每个模型一个仓库（src/models/catalog.mjs 的 mirrorRepo），
// 里面是和原始仓库一字不差、路径也一样的模型文件，外加三份我们写的说明：
//   README.md  模型卡：魔搭页面上显示的那份，开头是魔搭认的元数据（许可、任务）
//   LICENSE    许可原文（配置表里 license.url 那一份）
//   NOTICE     这是谁的模型、从哪个仓库哪次提交来的、每个文件的 sha256，后面接原仓库自带的 NOTICE（有的话）
// FunASR 的许可要求注明来源和作者、保留模型名；Apache-2.0 要求随文件给出许可原文、保留原有的 NOTICE。
// 上传和核对的流程在 sync-models.mjs，这里只有不碰网络的部分。

import { join } from "node:path";
import { mirrorRepo } from "../../src/models/catalog.mjs";

const REPO_URL = "https://github.com/jzh-1228/OrangeSpeakEasy";

/**
 * 一个模型要传的模型文件：本机模型仓里的那一份（storeDir/<模型 id>/<路径>）、仓库里的路径、大小和校验值。
 * 本机那一份对不对，由调用方先核对过
 * @param {object} model 配置表里的一项
 * @param {string} storeDir 本机模型仓的目录（src/models/store.mjs 的 dir）
 */
export function repoFiles(model, storeDir) {
  return Object.values(model.files).map((file) => ({
    local: join(storeDir, model.id, ...file.path.split("/")),
    path: file.path,
    size: file.size,
    sha256: file.sha256,
  }));
}

/** 魔搭认的许可写法。FunASR 的许可魔搭的列表里没有，记成 other，原文在 LICENSE */
export function licenseId(model) {
  return model.license.name === "Apache-2.0" ? "apache-2.0" : "other";
}

/** 这份副本是什么、从哪来。英文写：看它的人不一定懂中文 */
function sourceLines(model) {
  const { origin } = model;
  return [
    `These files are a byte-identical mirror of https://huggingface.co/${origin.repo}`,
    `at commit ${origin.revision}, kept by OrangeSpeakEasy (${REPO_URL})`,
    "so that its users can download them quickly from China.",
    "",
    `Model: ${model.name}, originally released by ${model.author} (https://huggingface.co/${model.author}).`,
    `License: ${model.license.name}. Full text in LICENSE, copied from ${model.license.url}`,
  ];
}

/**
 * NOTICE 的内容
 * @param {object} model 配置表里的一项
 * @param {string | null} upstream 原仓库自带的 NOTICE（没有是 null）
 */
export function noticeText(model, upstream) {
  const lines = [
    model.name,
    "",
    ...sourceLines(model),
    "",
    "Files (sha256):",
    ...Object.values(model.files).map((file) => `  ${file.sha256}  ${file.path}`),
  ];
  if (upstream) lines.push("", `---- NOTICE from ${model.origin.repo} ----`, "", upstream.trim());
  return `${lines.join("\n")}\n`;
}

/** 模型卡：魔搭的模型页显示的那份 */
export function readmeText(model) {
  const lines = [
    "---",
    `license: ${licenseId(model)}`,
    "tasks:",
    "- auto-speech-recognition",
    "---",
    "",
    `# ${model.name}`,
    "",
    ...sourceLines(model),
    "",
    "See NOTICE for the sha256 of every file and the upstream notice.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * 传完以后核对魔搭上的仓库：配置表里的每个文件都在、大小和 sha256 都对。
 * 最新的那次提交（所有文件里最近改过的那一次）就是要钉进配置表的 mirror.revision
 * @param {object} model 配置表里的一项
 * @param {{ Path: string, Type: string, Size: number, Sha256: string, Revision: string, CommittedDate: number }[]} listing
 *   魔搭列文件接口（/api/v1/models/<仓库>/repo/files?Recursive=true）给的 Files
 * @returns {{ head: string | null, problems: string[] }}
 */
export function checkRemote(model, listing) {
  const repo = mirrorRepo(model);
  const blobs = listing.filter((entry) => entry.Type === "blob");
  const byPath = new Map(blobs.map((entry) => [entry.Path, entry]));
  const problems = [];
  for (const file of Object.values(model.files)) {
    const entry = byPath.get(file.path);
    if (!entry) problems.push(`${repo} 上没有 ${file.path}`);
    else if (entry.Size !== file.size)
      problems.push(`${repo} 上的 ${file.path} 是 ${entry.Size} 字节，配置表里是 ${file.size} 字节`);
    else if (entry.Sha256 !== file.sha256)
      problems.push(`${repo} 上的 ${file.path} 的 sha256 是 ${entry.Sha256}，配置表里是 ${file.sha256}`);
  }
  const latest = blobs.reduce(
    (last, entry) => (last && last.CommittedDate >= entry.CommittedDate ? last : entry),
    null,
  );
  return { head: latest?.Revision ?? null, problems };
}
