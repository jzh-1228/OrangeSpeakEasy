#!/usr/bin/env node
// 把配置表（src/models/catalog.mjs）里的本地模型传到国内源：魔搭（ModelScope）上配置表 MODELSCOPE_OWNER 名下的仓库，一个模型一个。
// 加了模型、换了原始提交之后跑一次；魔搭上已经有、内容一样的文件 SDK 自己跳过，断了再跑就接着传。
//
//   scripts/release/with-modelscope-key.sh npm run sync-models -- --from <本机模型仓>              传
//   scripts/release/with-modelscope-key.sh npm run sync-models -- --from <本机模型仓> --download   本机没有的先从原始地址下
//   npm run sync-models -- --from <本机模型仓> --dry-run                                         只列出要传什么，不联网
//   npm run sync-models -- --check                                                              只核对配置表钉的提交，不用令牌
//
// 本机模型仓就是 App 下载模型的那种目录（一个模型一个子目录），比如 ~/.orangespeakeasy/models、bench/_work/models。
// 每个文件传之前都按配置表核对 sha256；传完从魔搭上逐个核对大小和 sha256，再按下载地址真取一次开头，
// 都对了才报出这个模型该钉的提交（填进配置表的 mirror.revision）。
// 传文件用魔搭的 Python SDK（modelscope-sdk.sh 第一次跑时装进 .tools/modelscope），这里只调 modelscope-upload.py。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_SOURCE, downloadUrls, MODELS, mirrorRepo } from "../../src/models/catalog.mjs";
import { createModelStore } from "../../src/models/store.mjs";
import { checkRemote, licenseId, noticeText, readmeText, repoFiles } from "./models-layout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK = join(ROOT, "scripts/release/modelscope-sdk.sh");
const TRACKERS = join(ROOT, ".tools/modelscope/upload-tracker");

async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 取一份文字（许可原文、原仓库的 NOTICE） */
async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`取不到 ${url}：HTTP ${response.status}`);
  return response.text();
}

/** 本机模型仓里的这个模型齐不齐、对不对；不齐的话 --download 时从原始地址下 */
async function ensureLocal(model, store, storeDir, download) {
  if (!store.isInstalled(model)) {
    if (!download) throw new Error(`本机模型仓里没有装好的 ${model.id}。加 --download 从原始地址下，或者换一个 --from`);
    console.log(`下载        ${model.id}（从原始地址）`);
    await store.install(model);
  }
  for (const file of repoFiles(model, storeDir)) {
    if ((await sha256Of(file.local)) !== file.sha256) {
      throw new Error(`${file.local} 的 sha256 和配置表对不上：删掉这个模型的目录再用 --download 重下`);
    }
  }
}

/** 把要传的摆成仓库里的样子：模型文件用硬链接（不占空间），三份说明现写 */
async function stage(model, storeDir, dir) {
  for (const file of repoFiles(model, storeDir)) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    try {
      linkSync(file.local, target);
    } catch (error) {
      // 临时目录和模型仓不在同一块盘上：只能拷
      if (error.code !== "EXDEV") throw error;
      copyFileSync(file.local, target);
    }
  }
  const { origin, license } = model;
  const upstream = origin.notice
    ? await fetchText(`https://huggingface.co/${origin.repo}/raw/${origin.revision}/${origin.notice}`)
    : null;
  writeFileSync(join(dir, "LICENSE"), await fetchText(license.url));
  writeFileSync(join(dir, "NOTICE"), noticeText(model, upstream));
  writeFileSync(join(dir, "README.md"), readmeText(model));
}

/** 跑 modelscope-upload.py：建仓库（没有的话）、传目录。它说的话原样接到终端上 */
function upload(job) {
  return new Promise((done, fail) => {
    const child = spawn(SDK, [join(ROOT, "scripts/release/modelscope-upload.py")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (code !== 0) return fail(new Error(`modelscope-upload.py 退出码 ${code}`));
      const last = out.trim().split("\n").at(-1);
      try {
        done(JSON.parse(last));
      } catch {
        fail(new Error(`modelscope-upload.py 最后没有报结果：${out.trim().slice(-500)}`));
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/** 魔搭上某个版本（分支或提交）的文件清单 */
async function listRemote(model, revision) {
  const url = `https://modelscope.cn/api/v1/models/${mirrorRepo(model)}/repo/files?Revision=${revision}&Recursive=true`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`列不出 ${mirrorRepo(model)} 的文件：HTTP ${response.status}`);
  const body = await response.json();
  if (!body.Data?.Files) throw new Error(`列不出 ${mirrorRepo(model)} 的文件：${JSON.stringify(body).slice(0, 300)}`);
  return body.Data.Files;
}

/** 多大的文件要能断点续传。魔搭上的小文件（不走大文件存储的）不好好认 Range：带着 Range 去要，回的是 200 加那一截 */
const RESUMABLE_FROM = 8 * 1024 * 1024;

/**
 * 照用户下载的地址（钉在那次提交上）真取一次：匿名取得到、内容对，用户才下得到。
 * 小文件整个取回来核对 sha256；大文件只取第一个字节，要回 206、总大小对，断了才能续
 */
async function probeDownloads(model, revision) {
  const pinned = { ...model, mirror: { revision } };
  const problems = [];
  for (const file of Object.values(model.files)) {
    const [url] = downloadUrls(pinned, file, DEFAULT_SOURCE);
    try {
      if (file.size < RESUMABLE_FROM) {
        const response = await fetch(url, { redirect: "follow" });
        const body = Buffer.from(await response.arrayBuffer());
        const digest = createHash("sha256").update(body).digest("hex");
        if (!response.ok) problems.push(`${url}：HTTP ${response.status}`);
        else if (digest !== file.sha256)
          problems.push(`${url}：取回来的 sha256 是 ${digest}，配置表里是 ${file.sha256}`);
        continue;
      }
      const response = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "follow" });
      await response.body?.cancel();
      const total = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
      if (response.status !== 206) problems.push(`${url}：HTTP ${response.status}（大文件要能断点续传，应该回 206）`);
      else if (total !== file.size) problems.push(`${url}：总大小 ${total}，配置表里是 ${file.size}`);
    } catch (error) {
      problems.push(`${url}：${error.message}`);
    }
  }
  return problems;
}

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    download: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  },
});

try {
  if (values.check) {
    // 只核对：配置表钉的每个提交上，文件都在、都对、都取得到
    const problems = [];
    for (const model of MODELS) {
      if (!model.mirror.revision) {
        problems.push(`${model.id} 还没钉魔搭的提交`);
        continue;
      }
      problems.push(...checkRemote(model, await listRemote(model, model.mirror.revision)).problems);
      problems.push(...(await probeDownloads(model, model.mirror.revision)));
      console.log(`核对        ${mirrorRepo(model)}@${model.mirror.revision.slice(0, 12)}`);
    }
    if (problems.length > 0) throw new Error(`有 ${problems.length} 处不对：\n${problems.join("\n")}`);
    console.log(`\n国内源齐了：${MODELS.length} 个模型都能从魔搭钉住的提交下到，大小和 sha256 都对。`);
  } else {
    if (!values.from)
      throw new Error("要用 --from 说本机模型仓在哪，比如 --from ~/.orangespeakeasy/models（只核对用 --check）");
    const storeDir = resolve(values.from.replace(/^~(?=\/)/, process.env.HOME));
    if (values["dry-run"]) {
      for (const model of MODELS) {
        console.log(`${mirrorRepo(model)}（${licenseId(model)}）`);
        for (const file of repoFiles(model, storeDir)) console.log(`  ${file.path}  ${file.size} 字节`);
        console.log("  LICENSE  NOTICE  README.md");
      }
      process.exit(0);
    }
    if (!process.env.MODELSCOPE_API_TOKEN) {
      throw new Error(
        "环境里没有 MODELSCOPE_API_TOKEN：用 scripts/release/with-modelscope-key.sh npm run sync-models -- …",
      );
    }
    if (!existsSync(storeDir) && !values.download) throw new Error(`没有 ${storeDir} 这个目录`);

    const store = createModelStore({ dir: storeDir, source: "original" });
    const pins = [];
    for (const model of MODELS) {
      await ensureLocal(model, store, storeDir, values.download);
      const dir = mkdtempSync(join(tmpdir(), `orangespeakeasy-modelscope-${model.id}-`));
      try {
        await stage(model, storeDir, dir);
        console.log(`上传        ${mirrorRepo(model)}`);
        const { created } = await upload({
          repo: mirrorRepo(model),
          folder: dir,
          license: licenseId(model),
          description: `${model.name}: mirror of huggingface.co/${model.origin.repo} for OrangeSpeakEasy`,
          message: `Mirror ${model.origin.repo}@${model.origin.revision.slice(0, 12)}`,
          tracker: join(TRACKERS, model.id),
        });
        if (created) console.log(`新建了仓库  ${mirrorRepo(model)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const { head, problems } = checkRemote(model, await listRemote(model, "master"));
      problems.push(...(head ? await probeDownloads(model, head) : [`${mirrorRepo(model)} 上一个文件都没有`]));
      if (problems.length > 0)
        throw new Error(`传完了，但魔搭上有 ${problems.length} 处不对：\n${problems.join("\n")}`);
      console.log(`核对好了    ${mirrorRepo(model)}@${head.slice(0, 12)}`);
      pins.push({ model, head });
    }
    console.log("\n都传好、核对过了。配置表里每个模型的 mirror 应该是：");
    for (const { model, head } of pins) {
      const mark = model.mirror.revision === head ? "（已经是）" : "（要改）";
      console.log(`  ${model.id}: mirror: { revision: "${head}" }${mark}`);
    }
  }
} catch (error) {
  console.error(`没有成：${error.message}`);
  process.exitCode = 1;
}
