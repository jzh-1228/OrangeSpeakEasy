// 测试用：在本机的一个目录里摆出下载地址的样子（src/update/layout.mjs），当 ORANGESPEAKEASY_INSTALL_BASE 用。
// 和 scripts/release/release.mjs 一样：每棵树切块存进 store/，清单也存成对象，channel.json 写着每种装法用哪份清单。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../src/update/chunker.mjs";
import { CHANNEL, objectPath } from "../../src/update/layout.mjs";
import { describeTree, encodeManifest } from "../../src/update/manifest.mjs";
import { packObject } from "../../src/update/objects.mjs";

/**
 * @param {string} root 下载地址（本机目录）
 * @param {string} version 不带 v
 * @param {Record<string, string>} trees 装法 → 那棵树
 * @returns {Promise<{ version: string, electron: string, targets: Record<string, string> }>} 写进 channel.json 的
 */
export async function publishTrees(root, version, trees) {
  mkdirSync(join(root, "store"), { recursive: true });
  const put = (sha, data) => {
    const path = join(root, objectPath(sha));
    if (!existsSync(path)) writeFileSync(path, packObject(data));
  };
  const targets = {};
  for (const [target, tree] of Object.entries(trees)) {
    const encoded = encodeManifest(await describeTree(tree, { put }));
    targets[target] = sha256(encoded);
    put(targets[target], encoded);
  }
  const channel = { format: 1, version, electron: "44.0.0", targets };
  writeFileSync(join(root, CHANNEL), JSON.stringify(channel));
  return channel;
}
