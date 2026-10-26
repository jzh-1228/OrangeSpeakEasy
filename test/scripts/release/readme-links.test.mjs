import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ARCHS, dmgName, WINDOWS_SETUP } from "../../../scripts/release/release-layout.mjs";

const repoDir = resolve(import.meta.dirname, "../../..");
/** 中文是主页（README.md），英文是切换过去的那一份（README.en.md）：两份都写着安装包的下载链接 */
const READMES = ["README.md", "README.en.md"];

for (const name of READMES) {
  test(`${name} 里安装包的下载链接指向 package.json 的这个版本，两种芯片的 Mac 和 Windows 都有`, () => {
    const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
    const readme = readFileSync(join(repoDir, name), "utf8");
    for (const file of [...ARCHS.map(dmgName), WINDOWS_SETUP]) {
      const link = `https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download/v${version}/${file}`;
      assert.ok(readme.includes(link), `${name} 里没有 ${link}：升了版本号要一起改下载链接`);
    }
  });
}

test("两份 README 顶上能互相切换", () => {
  const chinese = readFileSync(join(repoDir, "README.md"), "utf8");
  const english = readFileSync(join(repoDir, "README.en.md"), "utf8");
  assert.ok(chinese.includes('href="README.en.md"'), "README.md 顶上没有切到英文的链接");
  assert.ok(english.includes('href="README.md"'), "README.en.md 顶上没有切回中文的链接");
});

/**
 * README 的截图放在官网图片的 COS 桶里（官网、宣传片也用），不进仓库：传图的脚本（website/scripts/upload-media.mjs）
 * 把传上去的记在 docs/media.json，悬浮条那张和官网共用、记在 website/src/media.json
 */
const read = (path) => JSON.parse(readFileSync(join(repoDir, path), "utf8"));
const { mediaBase } = read("website/site.config.json");
const uploaded = new Set(
  [read("docs/media.json"), read("website/src/media.json")].flatMap((media) => Object.values(media).map((m) => m.path)),
);

for (const [name, locale] of [
  ["README.md", "zh-CN"],
  ["README.en.md", "en"],
]) {
  test(`${name} 里的截图都从图片桶上取、都传过，用的是这种语言的那一张`, () => {
    const readme = readFileSync(join(repoDir, name), "utf8");
    const images = [...readme.matchAll(/(?:src|srcset)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((src) => !src.startsWith("https://img.shields.io/"));
    const shots = images.filter((src) => src !== "assets/icon.svg");
    assert.ok(shots.length >= 20, `${name} 只找到 ${shots.length} 张图`);
    for (const src of shots) {
      assert.ok(src.startsWith(`${mediaBase}/`), `${name} 引用的 ${src} 不在图片桶上`);
      // 地址后面可以带 ?v=…：GitHub 的图片代理第一次取图偶尔拿到空的，还会把空的缓存一年，换个查询串就会重取
      const path = src.slice(mediaBase.length + 1).split("?")[0];
      assert.ok(uploaded.has(path), `${name} 引用的 ${path} 没有记在 docs/media.json：用 upload-media.mjs 传`);
      assert.ok(path.includes(`.${locale}.`), `${name} 引用了别的语言的图：${path}`);
    }
    for (const src of images.filter((src) => !src.startsWith("http")))
      assert.ok(existsSync(join(repoDir, src)), `${name} 引用的 ${src} 不存在`);
  });
}
