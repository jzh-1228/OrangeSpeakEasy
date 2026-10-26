#!/usr/bin/env node
// 把一棵树（里面是 app 和 runtime）打成 tar、用 zstd 压，写到 out：Windows 安装程序身上带的那一段（windows-setup.mjs）。
//   node scripts/build/pack-tree.mjs <树> <输出>
// 单独一个进程跑：压缩要靠事件循环推着走，放在打包的主进程里的话，主进程同步跑 npm ci、公证这些的时候它一点都不动。
// 压得狠（19 档、远距离匹配）：打一次、下很多次。实测 Windows 的树 430 MB 压到约 125 MB，同一棵树的 zip 是 172 MB。
// tar 的参数见 tar.mjs：不留本机的用户名、扩展属性这些。

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress } from "node:zlib";
import { TAR_ANONYMOUS } from "./tar.mjs";

const [tree, out] = process.argv.slice(2);
if (!tree || !out) {
  console.error("用法：node scripts/build/pack-tree.mjs <树> <输出>");
  process.exit(2);
}
const args = ["-cf", "-", ...TAR_ANONYMOUS, "-C", tree, "app", "runtime"];
const tar = spawn("tar", args, {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const exited = new Promise((resolve, reject) => {
  tar.on("error", reject);
  tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
});
const zstd = createZstdCompress({
  params: {
    // 默认压到最狠；内存紧的机器可以用环境变量调低（level 与 window 一起调，window 才是内存大头）
    [constants.ZSTD_c_compressionLevel]: Number(process.env.ORANGESPEAKEASY_ZSTD_LEVEL ?? 19),
    [constants.ZSTD_c_enableLongDistanceMatching]: 1,
    [constants.ZSTD_c_windowLog]: Number(process.env.ORANGESPEAKEASY_ZSTD_WINDOW ?? 27),
  },
});
try {
  await Promise.all([pipeline(tar.stdout, zstd, createWriteStream(out)), exited]);
} catch (error) {
  console.error(`打不成 ${out}：${error.message}`);
  process.exit(1);
}
