import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneDevFiles, trimMacLocales, trimWindowsLocales } from "../../../scripts/build/slim.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "sm-slim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const touch = (path) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

test("Mac 的应用包：框架和应用两处的语言包只留英文、简中、繁中（连同按性别分的变体），别的资源不动", (t) => {
  const app = join(tempDir(t), "OrangeSpeakEasy.app");
  const framework = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources");
  for (const name of [
    "en",
    "en_GB",
    "en_FEMININE",
    "zh_CN",
    "zh_CN_NEUTER",
    "zh_TW",
    "de",
    "de_MASCULINE",
    "ja",
    "es_419",
  ]) {
    touch(join(framework, `${name}.lproj`, "locale.pak"));
  }
  touch(join(framework, "resources.pak"));
  for (const name of ["en", "zh_CN", "fr"])
    touch(join(app, "Contents", "Resources", `${name}.lproj`, "InfoPlist.strings"));
  touch(join(app, "Contents", "Resources", "app", "package.json"));
  trimMacLocales(app);
  assert.deepEqual(readdirSync(framework).sort(), [
    "en.lproj",
    "en_FEMININE.lproj",
    "en_GB.lproj",
    "resources.pak",
    "zh_CN.lproj",
    "zh_CN_NEUTER.lproj",
    "zh_TW.lproj",
  ]);
  assert.deepEqual(readdirSync(join(app, "Contents", "Resources")).sort(), ["app", "en.lproj", "zh_CN.lproj"]);
});

test("Windows 的运行环境：locales 里只留英文、简中、繁中", (t) => {
  const runtime = tempDir(t);
  for (const name of ["en-US", "en-GB", "zh-CN", "zh-TW", "de", "ja", "pt-BR"])
    touch(join(runtime, "locales", `${name}.pak`));
  touch(join(runtime, "resources.pak"));
  trimWindowsLocales(runtime);
  assert.deepEqual(readdirSync(join(runtime, "locales")).sort(), ["en-GB.pak", "en-US.pak", "zh-CN.pak", "zh-TW.pak"]);
  assert.ok(existsSync(join(runtime, "resources.pak")));
});

test("依赖里只有开发时用的文件删掉（源码映射、类型声明、C/C++ 源码和头文件），代码、原生库、许可证都留着", (t) => {
  const dir = tempDir(t);
  const keep = [
    "a/index.js",
    "a/index.mjs",
    "a/LICENSE",
    "a/LICENSE.md",
    "a/package.json",
    "b/build/Release/b.node",
    "c/lib.dylib",
    "d/README.md",
  ];
  const drop = [
    "a/index.js.map",
    "a/index.d.ts",
    "a/index.d.mts",
    "a/types.d.cts",
    "a/x.tsbuildinfo",
    "b/src/b.cc",
    "b/src/b.h",
    "b/src/b.hh",
    "b/src/b.cpp",
    "b/src/b.c",
  ];
  for (const path of [...keep, ...drop]) touch(join(dir, "node_modules", ...path.split("/")));
  pruneDevFiles(dir);
  for (const path of keep) assert.ok(existsSync(join(dir, "node_modules", ...path.split("/"))), path);
  for (const path of drop) assert.ok(!existsSync(join(dir, "node_modules", ...path.split("/"))), path);
});
