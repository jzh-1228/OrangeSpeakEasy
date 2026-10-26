import { createHash } from "node:crypto";

// 按内容切块（FastCDC）：在哪里切只看那一小段内容本身，不看它在文件里的位置。
// 一个文件里改了一处，只有那一处附近的一两块变了，前后的块原样不动；整段内容挪了位置，块也认得出来。
// 发布时（scripts/release）把每个版本的程序切成块、按内容的 sha256 存一份；更新时（assemble.mjs）把本机装着的那份
// 用同样的切法切一遍，已经有的块不再下载。两边切法不一样不会出错（块按 sha256 认），只是认得出的块少了、下得多了。
// 2026-10-20 拿 0.10.0 → 0.10.1 实测（docs/development.md 的"分块更新"）：平均 128 KiB 时 Mac App 只要下 1.3 MB，
// 按整个文件比要下 76 MB（每次重新签名都会改掉二进制末尾的签名）。

/**
 * 切法。改了任何一项都是另一种切法，要换 algorithm 的名字：清单里记着用的是哪种
 * min/avg/max 是块的最小、平均、最大字节数
 */
export const CHUNKING = Object.freeze({
  algorithm: "fastcdc-gear32-v1",
  min: 32 * 1024,
  avg: 128 * 1024,
  max: 512 * 1024,
});

/** 每个字节值对应的随机数（gear 表）。由固定的种子算出来：两边、每个版本都一样 */
const GEAR = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1)
    table[i] = createHash("sha256").update(`orangespeakeasy-gear-${i}`).digest().readUInt32BE(0);
  return table;
})();

/** 判定切点的掩码：取哈希的高位（高位受前面更多字节影响）。小于平均长度时多看一位（难切），过了平均长度少看一位（好切） */
function masks(avg) {
  const bits = Math.round(Math.log2(avg));
  return {
    strict: (((1 << (bits + 1)) - 1) << (31 - bits)) >>> 0,
    loose: (((1 << (bits - 1)) - 1) << (33 - bits)) >>> 0,
  };
}

/**
 * 一段内容的切点
 * @param {Uint8Array} data
 * @returns {{ offset: number, size: number }[]} 依次的每一块；空内容是一个 0 字节的块
 */
export function cutPoints(data, { min, avg, max } = CHUNKING) {
  const { strict, loose } = masks(avg);
  const chunks = [];
  let start = 0;
  while (start < data.length) {
    let end = data.length - start;
    if (end > min) {
      if (end > max) end = max;
      const normal = Math.min(avg, end);
      let hash = 0;
      let i = min;
      let cut = end;
      for (; i < normal; i += 1) {
        hash = ((hash << 1) + GEAR[data[start + i]]) >>> 0;
        if ((hash & strict) === 0) {
          cut = i;
          break;
        }
      }
      if (cut === end) {
        for (; i < end; i += 1) {
          hash = ((hash << 1) + GEAR[data[start + i]]) >>> 0;
          if ((hash & loose) === 0) {
            cut = i;
            break;
          }
        }
      }
      end = cut;
    }
    chunks.push({ offset: start, size: end });
    start += end;
  }
  if (chunks.length === 0) chunks.push({ offset: 0, size: 0 });
  return chunks;
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * 切好并算出每块的 sha256
 * @param {Uint8Array} data
 * @returns {{ offset: number, size: number, sha256: string }[]}
 */
export function chunksOf(data) {
  return cutPoints(data).map(({ offset, size }) => ({
    offset,
    size,
    sha256: sha256(data.subarray(offset, offset + size)),
  }));
}
