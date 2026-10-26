#!/usr/bin/env node
// 把 OrangeSpeakEasy 打成一个可以双击的 macOS 应用：dist/OrangeSpeakEasy-darwin-<架构>/OrangeSpeakEasy.app
// 用法：npm run dist
//
// 平时用 orangespeakeasy 命令启动就够了。打成应用的区别是：三项系统权限记在"OrangeSpeakEasy"自己名下
// （而不是启动它的终端名下），并且可以设成登录时自动启动。
// 应用里装的是 src、编好的小帮手和运行时依赖；测试、脚本、命令行入口都不进去。怎么打、怎么签名在 mac-app.mjs。

import { join, resolve } from "node:path";
import { buildHelper } from "../../src/cli/native-helper.mjs";
import { packageMacApp } from "./mac-app.mjs";
import { signingConfig } from "./signing.mjs";

const packageDir = resolve(import.meta.dirname, "../..");
// 先读：配错了在编译、打包之前就说
const signing = signingConfig(packageDir);

buildHelper(packageDir);
const appPath = await packageMacApp({ packageDir, arch: process.arch, out: join(packageDir, "dist"), signing });
const how = signing === null ? "本机签名" : `${signing.identity}${signing.notaryProfile ? "，已公证" : "，没公证"}`;
console.log(`\n打好了（${how}）：${appPath}`);
