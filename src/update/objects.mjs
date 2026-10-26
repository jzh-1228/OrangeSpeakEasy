import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { sha256 } from "./chunker.mjs";

// 下载地址上按内容存的东西（块和清单）一律叫"对象"：名字是原始内容的 sha256，存的是 zstd 压过的。
// 名字就是校验值：取回来解开、算一遍对得上才用，所以不用另外的 .sha256 文件，内容也永远不会变（可以一直缓存）。

/** 发布时压得狠一点：压一次、下很多次。内存紧的机器可以用 ORANGESPEAKEASY_ZSTD_LEVEL 调低 */
const LEVEL = Number(process.env.ORANGESPEAKEASY_ZSTD_LEVEL ?? 19);

/** @param {Uint8Array} data 原始内容 */
export function packObject(data) {
  return zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: LEVEL } });
}

/**
 * 解开一个对象、核对它就是名字说的那份
 * @param {Uint8Array} packed 下载到的（压着的）
 * @param {string} expected 对象的名字（原始内容的 sha256）
 */
export function unpackObject(packed, expected) {
  let data;
  try {
    data = zstdDecompressSync(packed);
  } catch (error) {
    throw new Error(`对象 ${expected.slice(0, 12)} 解不开（${error.message}）`, { cause: error });
  }
  const actual = sha256(data);
  if (actual !== expected)
    throw new Error(`对象 ${expected.slice(0, 12)} 的 sha256 对不上：解开后是 ${actual.slice(0, 12)}`);
  return data;
}
