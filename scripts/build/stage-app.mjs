// 在一个临时目录里摆出"装到别人机器上的程序该有的东西"：代码、编好的小帮手、运行时依赖。
// 打 .app（package.mjs）和打发布包（release.mjs）都从这里开始。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pruneDevFiles } from "./slim.mjs";

const NPM_FLAGS = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];

/**
 * 后台应用运行时要从仓库里读的目录：代码、编好的小帮手、图标。
 * 打 .app 只摆这些；发布包另外带上命令行入口和许可证。漏了哪个，测试会指出（test/scripts/build）
 */
export const APP_ENTRIES = ["src", "build", "assets"];

/**
 * 摆好之后、打成 .app 时不带的（按应用目录里的路径认，开头是 /）：命令行的代码 App 用不到，锁文件装完依赖就没用了。
 * 装进去的代码不能引用这里剔掉的文件，不然 App 一启动就找不到模块（0.9.0、0.9.1 就是这样），test/scripts/build 会查
 */
export const MAC_APP_IGNORE = [/^\/src\/cli($|\/)/, /^\/package-lock\.json$/];

/**
 * 装上了、但程序从来不加载的包，不随程序分发。@audio/decode-webm 声明依赖了另外几种解码器（AAC、AC-3、DTS、
 * E-AC-3、FLAC、MP3、Opus、Vorbis），其中 AAC、AC-3、DTS 是 GPL，E-AC-3 是 LGPL，和本项目的 MIT 不兼容；
 * 而它打包好的代码只用自带的 Opus 解码。codec-parser（LGPL）是拆 Ogg 用的，程序不转 Ogg（见 src/server/audio/transcode.mjs）。
 * 实测把这几个挪走，WebM 照样转得出来（test/server/audio）。
 */
export const UNUSED_PACKAGES = [
  "@audio/decode-aac",
  "@audio/decode-ac3",
  "@audio/decode-dts",
  "@audio/decode-eac3",
  "@audio/decode-flac",
  "@audio/decode-mp3",
  "@audio/decode-opus",
  "@audio/decode-vorbis",
  "codec-parser",
];

export function pruneUnused(stagingDir) {
  for (const name of UNUSED_PACKAGES) rmSync(join(stagingDir, "node_modules", name), { recursive: true, force: true });
}

/** 一个 SPDX 许可证表达式是不是只能按 GPL 一类（GPL、LGPL、AGPL）来用。"MIT OR GPL-3.0" 可以选 MIT，不算 */
function copyleftOnly(license) {
  const alternatives = license.replace(/[()]/g, "").split(/\s+OR\s+/i);
  return alternatives.every((alternative) => /GPL/i.test(alternative));
}

/** package.json 里的许可证。老写法是一个对象或者一组对象 */
function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  if (Array.isArray(licenses)) return licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return null;
}

/**
 * 找出 node_modules 里（连嵌套的一起）只能按 GPL 一类许可证用、或者根本没写许可证的包。
 * 机器查得了的就别等人来查：加依赖时不小心带进来的，打包这一步就拦下。
 * @returns {{ name: string, license: string }[]}
 */
export function findCopyleft(nodeModulesDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }
      const manifestFile = join(path, "package.json");
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        const license = licenseOf(manifest);
        if (license === null || copyleftOnly(license))
          found.push({ name: manifest.name, license: license ?? "（没写）" });
      }
      if (existsSync(join(path, "node_modules"))) visit(join(path, "node_modules"));
    }
  };
  visit(nodeModulesDir);
  return found;
}

/** build 里编好的小帮手按系统分（src/cli/native-helper.mjs），给哪个系统打包就只带那一个 */
export const HELPER_FILES = {
  darwin: ["key-helper", "key-helper.source-sha256"],
  win32: ["key-helper.exe", "key-helper.exe.source-sha256"],
};

/**
 * @param {string} packageDir 源码仓库
 * @param {string} stagingDir 摆到哪。要是一个空目录
 * @param {string[]} entries 除了 package.json 和锁文件之外，还要从仓库里拷哪些
 * @param {"arm64" | "x64"} arch 给哪种芯片用
 * @param {"darwin" | "win32"} [platform] 给哪个系统用
 */
export function stageApp(packageDir, stagingDir, entries, arch, platform = "darwin") {
  for (const entry of ["package.json", "package-lock.json", ...entries]) {
    cpSync(join(packageDir, entry), join(stagingDir, entry), { recursive: true });
  }
  // 别的系统的小帮手不带
  for (const [system, files] of Object.entries(HELPER_FILES)) {
    if (system === platform) continue;
    for (const file of files) rmSync(join(stagingDir, "build", file), { force: true });
  }
  // 本地转写的运行库按系统和芯片各有一个带原生库的包（optionalDependencies），npm 默认只装本机这一种：
  // 在 Apple 芯片的 Mac 上给 Intel 或 Windows 打包时，要说清装哪种，不然装进去的是本机的、到那边加载不了
  const target = [`--os=${platform}`, `--cpu=${arch}`];
  const npm = (args) =>
    execFileSync("npm", [...args, ...target, ...NPM_FLAGS], {
      cwd: stagingDir,
      stdio: "inherit",
      // Windows 上的 npm 是 npm.cmd，不经 shell 起不来（参数都是固定的，不经过用户输入）
      shell: process.platform === "win32",
    });
  // 不直接拿源码仓库让打包工具去剔开发依赖：实测它剔不干净，代码检查工具几十兆的可执行文件会被带进去
  npm(["ci"]);
  // electron 这个依赖是给从源码仓库跑的人找运行环境用的。装好的程序另有运行环境，不用带它和它的下载工具
  // （这里也要 --omit=dev：不带的话 uninstall 会顺手把开发依赖全装回来）
  npm(["uninstall", "electron"]);
  pruneUnused(stagingDir);
  // 源码映射、类型声明、C/C++ 源码这些只在开发时用（slim.mjs）
  pruneDevFiles(stagingDir);
  // 卸掉、删掉之后会剩下几个空目录（node_modules/@electron 之类）
  execFileSync("find", [join(stagingDir, "node_modules"), "-type", "d", "-empty", "-delete"]);
  const copyleft = findCopyleft(join(stagingDir, "node_modules"));
  if (copyleft.length > 0) {
    const listed = copyleft.map(({ name, license }) => `${name}（${license}）`).join("、");
    throw new Error(`程序里有许可证和 MIT 不兼容、或者没写许可证的包，先确认再发：${listed}`);
  }
}
