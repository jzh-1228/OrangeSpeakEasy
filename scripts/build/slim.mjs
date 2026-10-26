// 发布包里装上了、但用的人用不到的东西，打包时删掉：每个首次安装的人都要多下这些。
// 2026-10-20 量过：Electron 自带五十多种界面语言（Mac 约 46 MB、Windows 约 48 MB，没压缩），OrangeSpeakEasy 的界面只有中英；
// 依赖里的源码映射、类型声明、C/C++ 源码约 18 MB。
//
// Mac 终端安装用的原版 Electron.app（runtime/）不在这里裁：它带着 Electron 自己的签名，删掉里面的文件签名就坏了，
// 而麦克风、辅助功能这些权限按签名认。OrangeSpeakEasy.app 是打包时我们自己签的，裁完再签，没有这个问题。

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 留下的界面语言：英文、简体中文、繁体中文（Chromium 自带的右键菜单、对话框这些跟着系统语言走，繁中用户也看得懂） */
const MAC_KEEP = /^(en|en_GB|zh_CN|zh_TW)(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/;
const WINDOWS_KEEP = /^(en-US|en-GB|zh-CN|zh-TW)\.pak$/;

function removeUnmatched(dir, pattern, candidate) {
  for (const name of readdirSync(dir)) {
    if (candidate(name) && !pattern.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * OrangeSpeakEasy.app（还没签名）：Electron 框架和应用自己的语言包只留几种
 * @param {string} app …/OrangeSpeakEasy.app 或打包中途的 Electron.app
 */
export function trimMacLocales(app) {
  const lproj = (name) => name.endsWith(".lproj");
  removeUnmatched(join(app, "Contents", "Resources"), MAC_KEEP, lproj);
  const framework = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources");
  removeUnmatched(framework, MAC_KEEP, lproj);
}

/** Windows 的运行环境（原版 Electron 解开的目录）：locales 里只留几种 */
export function trimWindowsLocales(runtimeDir) {
  removeUnmatched(join(runtimeDir, "locales"), WINDOWS_KEEP, (name) => name.endsWith(".pak"));
}

/** 只在开发时用的文件：源码映射、TypeScript 类型声明和编译记录、原生模块的 C/C++ 源码和头文件（编好的 .node 留着） */
const DEV_FILE = /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo|c|cc|cpp|h|hh|hpp)$/;

/** 摆好的程序目录里，node_modules 下只在开发时用的文件 */
export function pruneDevFiles(appDir) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && DEV_FILE.test(entry.name)) rmSync(path);
    }
  };
  visit(join(appDir, "node_modules"));
}
