// 怎么把发布目录（dist/release，摆法见 src/update/layout.mjs）原样搬到下载地址上。
// 打包（release.mjs）照着 layout.mjs 摆，上传（publish-release.mjs）照这里传，更新和安装脚本照着 layout.mjs 取。
//
// 传的先后保证任何时刻照着 channel.json 去取，要的东西都已经在了：
//   1. store/ 里的对象（块和清单）：按内容命名，上面已经有的跳过（同名就是同一份内容），没有的并行传
//   2. 这个版本首次安装用的包和它们的 .sha256
//   3. 两个安装脚本
//   4. 最后才换 channel.json

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// 摆法由程序里的更新和这里共用：程序要照同样的路径去取
import {
  appTarget,
  archiveName,
  CHANNEL,
  CHANNEL_FORMAT,
  dmgName,
  homeTarget,
  objectPath,
  TARGETS,
  versionDir,
  WINDOWS_ARCHIVE,
  WINDOWS_SETUP,
} from "../../src/update/layout.mjs";
import { chunksIn, parseManifest } from "../../src/update/manifest.mjs";
import { unpackObject } from "../../src/update/objects.mjs";
import { parseChannel } from "../../src/update/release.mjs";

export {
  appTarget,
  archiveName,
  CHANNEL,
  CHANNEL_FORMAT,
  dmgName,
  homeTarget,
  objectPath,
  versionDir,
  WINDOWS_ARCHIVE,
  WINDOWS_SETUP,
};

export const ARCHS = ["arm64", "x64"];

/** 下载地址上，这个产品的东西都在这个前缀下面 */
const KEY_PREFIX = "orangespeakeasy/";
/** 传上去就不再变的：各处可以放心长期缓存 */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** 每次发布都会换的：只缓存一小会儿，新版本一分钟内人人看得到 */
const MUTABLE = "public, max-age=60";
const TEXT = "text/plain; charset=utf-8";
/** 对象是 zstd 压过的字节：不让 CDN 当成文字再压一遍、改编码 */
const OBJECT = "application/octet-stream";
/** 同时传几个对象：一个对象平均几十 KB，一个一个传的话一万个要传好几分钟 */
const PARALLEL = 16;

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const RERUN = "重新运行 npm run release（两种芯片和 Windows 都要打；App 和安装包要先在 .machine.env 配好签名和公证）。";

/**
 * 核对发布目录是齐的、自己对得上，列出要传的东西：
 * channel.json 每种装法都有清单，每份清单和它用到的每一块都在 store/ 里、解得开、内容就是名字说的那份；
 * 首次安装用的包都在，和各自的 .sha256 对得上
 * @param {string} releaseDir
 * @returns {{ version: string, objects: object[], files: object[] }} objects：store/ 里要有的；files：按先后传的其余文件
 */
export function planUpload(releaseDir) {
  const item = (name, cacheControl, contentType) => {
    const path = join(releaseDir, name);
    if (!existsSync(path)) throw new Error(`发布目录里少了 ${name}。${RERUN}`);
    return {
      path,
      key: KEY_PREFIX + name,
      size: statSync(path).size,
      sha256: sha256(path),
      cacheControl,
      contentType,
      immutable: cacheControl === IMMUTABLE,
    };
  };

  const channelItem = item(CHANNEL, MUTABLE, "application/json; charset=utf-8");
  let channel;
  try {
    channel = parseChannel(readFileSync(channelItem.path, "utf8"));
  } catch (error) {
    throw new Error(`发布目录里的 ${CHANNEL} 不对：${error.message}`, { cause: error });
  }
  const missingTargets = TARGETS.filter((target) => !channel.targets[target]);
  if (missingTargets.length > 0)
    throw new Error(`${CHANNEL} 里少了这几种装法的清单：${missingTargets.join("、")}。${RERUN}`);

  // 清单和它们用到的块：一个对象可能被好几份清单用到（两种装法的树一模一样时清单也是同一份），只列一次
  const objects = new Map();
  const contents = new Map();
  const object = (sha) => {
    if (contents.has(sha)) return contents.get(sha);
    const path = join(releaseDir, objectPath(sha));
    if (!existsSync(path)) throw new Error(`发布目录里少了对象 ${objectPath(sha)}。${RERUN}`);
    const packed = readFileSync(path);
    let data;
    try {
      data = unpackObject(packed, sha);
    } catch (error) {
      throw new Error(`${objectPath(sha)} 坏了：${error.message}。${RERUN}`, { cause: error });
    }
    objects.set(sha, {
      path,
      key: KEY_PREFIX + objectPath(sha),
      size: packed.length,
      cacheControl: IMMUTABLE,
      contentType: OBJECT,
    });
    contents.set(sha, data);
    return data;
  };
  for (const target of TARGETS) {
    const data = object(channel.targets[target]);
    let manifest;
    try {
      manifest = parseManifest(data);
    } catch (error) {
      throw new Error(`${target} 的清单不对：${error.message}。${RERUN}`, { cause: error });
    }
    for (const sha of chunksIn(manifest).keys()) object(sha);
  }

  const version = versionDir(channel.version);
  const files = [];
  /** 一个包和它的校验值。安装脚本、下载的人拿这个校验值核对：两样对不上的话，传上去谁也装不成 */
  const withChecksum = (name, contentType) => {
    const file = item(`${version}/${name}`, IMMUTABLE, contentType);
    const checksum = item(`${version}/${name}.sha256`, IMMUTABLE, TEXT);
    if (readFileSync(checksum.path, "utf8").split(/\s+/)[0] !== file.sha256) {
      throw new Error(`${name} 和它的 .sha256 对不上。${RERUN}`);
    }
    return [file, checksum];
  };
  for (const arch of ARCHS) {
    files.push(
      ...withChecksum(archiveName(arch), "application/x-xz"),
      ...withChecksum(dmgName(arch), "application/x-apple-diskimage"),
    );
  }
  files.push(
    ...withChecksum(WINDOWS_ARCHIVE, "application/zip"),
    ...withChecksum(WINDOWS_SETUP, "application/vnd.microsoft.portable-executable"),
    item("install.sh", MUTABLE, "text/x-shellscript; charset=utf-8"),
    // install.ps1 要按 UTF-8 读：irm 照 charset 解码，里面有中文注释
    item("install.ps1", MUTABLE, TEXT),
    channelItem,
  );
  return { version: channel.version, objects: [...objects.values()], files };
}

/** 同时最多跑 limit 个；有一个失败就不再开新的，等手上的跑完再抛 */
async function inParallel(items, limit, work) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
}

/**
 * 照着 planUpload 传。上面已经有的跳过，所以中途断了可以重来。
 * @param {ReturnType<typeof planUpload>} plan
 * @param {{ list: (prefix: string) => Promise<Map<string, number>>,
 *   head: (key: string) => Promise<{ size: number, sha256: string } | null>, put: (item: object) => Promise<void> }} store
 *   list：这个前缀下有哪些对象（名字 → 大小）
 * @param {(line: string) => void} log
 */
export async function publish({ objects, files }, store, log) {
  // 对象按内容命名：上面有同名的就是同一份内容（压法可能不同，不比字节），不用再传
  const storePrefix = KEY_PREFIX + objectPath("");
  const existing = await store.list(storePrefix);
  const missing = objects.filter((item) => !existing.has(item.key));
  const bytes = missing.reduce((sum, item) => sum + item.size, 0);
  log(
    `对象 ${objects.length} 个：上面已经有 ${objects.length - missing.length} 个，要传 ${missing.length} 个（${bytes} 字节）`,
  );
  let done = 0;
  await inParallel(missing, PARALLEL, async (item) => {
    await store.put(item);
    done += 1;
    if (done % 500 === 0 || done === missing.length) log(`传好了对象 ${done}/${missing.length}`);
  });
  // 再列一遍：要用到的都在，传的这些大小也对（put 带着 MD5，内容错了 COS 当场就拒）
  const after = await store.list(storePrefix);
  const absent = objects.filter((item) => !after.has(item.key));
  if (absent.length > 0)
    throw new Error(`传完以后上面还缺 ${absent.length} 个对象，比如 ${absent[0].key}。再运行一次。`);
  const wrong = missing.find((item) => after.get(item.key) !== item.size);
  if (wrong) throw new Error(`${wrong.key} 传上去之后大小和本机的对不上。再运行一次。`);

  const same = (remote, item) => remote !== null && remote.size === item.size && remote.sha256 === item.sha256;
  for (const item of files) {
    const remote = await store.head(item.key);
    if (same(remote, item)) {
      log(`已经在上面  ${item.key}`);
      continue;
    }
    // 发布过的版本不改：已经有人装了它，各处的缓存里也是它。要改就升版本号
    if (remote !== null && item.immutable) {
      throw new Error(`${item.key} 已经发布过，内容和这次的不一样。发布过的版本不改，要改就升版本号再发。`);
    }
    await store.put(item);
    if (!same(await store.head(item.key), item)) {
      throw new Error(`${item.key} 传上去之后和本机的对不上（大小或校验值不一样）。再运行一次。`);
    }
    log(`传好了      ${item.key}（${item.size} 字节）`);
  }
}
