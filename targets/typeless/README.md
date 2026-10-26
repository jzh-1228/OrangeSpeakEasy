# Typeless 逆向

目标：Typeless for macOS 2.8.1（`now.typeless.desktop`，build 2.8.1.130），一款语音输入工具。目的是学习它的实现，并为自己做一个同类工具（服务端自建）提供依据。照这份分析做出来的就是 [OrangeSpeakEasy](../../README.md)。

分析主干是 [REA](https://github.com/morluto/rea) 6.4.0（MCP 工具 + 命令行），结论引用它返回的 Evidence ID。

## 当前进度

| 部分 | 状态 |
| --- | --- |
| 包结构、签名、权限 | 完成 |
| JS 层（主进程、预加载、渲染层）静态分析 | 主链路、上下文采集、状态机、录音器、登录、云同步、结果投递、更新与权限已读；引导页、结果卡片窗口内部、排障向导没有读 |
| 原生库（4 个 Swift 动态库） | 接口与机制完成；逐函数只看了 3 个关键函数 |
| 本机数据 | 完成（上下文与调试信息是服务端密钥加密的，读不出明文） |
| 运行时抓包 | 做过一次（2026-10-13，4 次普通听写），消息序列、上下文明文、耗时已回填各篇；翻译、"问任何事"、修改跟踪、按住和取消还没有抓，见 [09](docs/09-runtime-capture.md#结果) |
| 可视化 | 各篇里共 9 张 Mermaid 图（GitHub 上直接渲染）；另有单页 HTML 阅读版，由 `tools/site/build.mjs` 生成到 `_work/site/index.html` |

## 文档

| 编号 | 文档 | 内容 |
| --- | --- | --- |
| 00 | [总览](docs/00-overview.md) | 一页看完：它是怎么工作的、为什么快、发了什么出去 |
| 01 | [包结构与签名](docs/01-bundle-and-signing.md) | 包里有什么、签名、权限、Electron 安全开关 |
| 02 | [代码还原](docs/02-code-recovery.md) | 混淆形态、还原方法、REA 输入的选择 |
| 03 | [进程与窗口架构](docs/03-process-architecture.md) | 进程、窗口、IPC 通道、本地存储 |
| 04 | [语音主链路](docs/04-voice-pipeline.md) | 从按键到文字落进输入框的全过程 |
| 05 | [网络协议](docs/05-network-protocol.md) | 签名、WebSocket 消息（含实测字段）、HTTP 接口表 |
| 06 | [上下文采集与隐私](docs/06-context-capture-and-privacy.md) | 采了什么、什么时候采、黑名单管到哪、实测发出去多少 |
| 07 | [原生库](docs/07-native-helpers.md) | 4 个动态库的接口、用到的系统 API、关键伪代码 |
| 08 | [本机数据](docs/08-local-data.md) | 数据库、录音、配置文件 |
| 09 | [运行时抓包](docs/09-runtime-capture.md) | 抓包方案、操作步骤、2026-10-13 的结果、被纠正的静态结论 |
| 10 | [交互状态机与按键](docs/10-interaction-state-machine.md) | 按键事件流向、听写状态图、全部时间参数、统计事件 |
| 11 | [录音与编码](docs/11-audio-recorder.md) | 麦克风约束、采样与编码参数、无声检测 |
| 12 | [账号与登录](docs/12-account-and-login.md) | 登录流程、令牌刷新、本地令牌文件的加密 |
| 13 | [历史云同步](docs/13-history-cloud-sync.md) | 同步什么、推拉协议、冲突与删除 |
| 14 | [结果投递](docs/14-result-delivery.md) | 成品怎么落到输入框、结果卡片、打开外链，两份名单的本意 |
| 15 | [更新、企业策略与权限](docs/15-update-policy-permissions.md) | 更新源、组织策略、各项系统权限的实际用途 |
| 90 | [证据台账](docs/90-evidence-ledger.md) | Evidence ID 与结论对照 |
| 91 | [未决问题](docs/91-open-questions.md) | 还不知道的、还没验证的 |

## 目录

```
targets/typeless/
├── README.md
├── docs/          文档（进仓库）
├── tools/         自写脚本（进仓库）；tools/site/ 是 HTML 阅读版的生成脚本、样式和交互
└── _work/         原始产物：解包代码、还原代码、REA 证据、抓包、切片库、生成的阅读版（不进仓库）
```

`_work/` 里是从 Typeless 拆出来的代码和你本人的数据，被 `.gitignore` 挡住。文档只写机制和结构，不贴大段原始代码，不记录包内写死的密钥值。

## 复现

```bash
cd targets/typeless

# 1. 解包（只取应用自己的代码，跳过 node_modules）
node tools/asar-extract.mjs /Applications/Typeless.app/Contents/Resources/app.asar _work/asar dist package.json

# 2. 去混淆（一次性准备：mkdir -p _work/tooling && cd _work/tooling && npm init -y && npm i node@24 webcrack@2.16.0 markdown-it@14.1.0）
tools/deobfuscate.sh
tools/build-readable-tree.sh          # 生成 _work/readable/dist，作为 REA 的输入

# 3. REA 分析（在 Claude Code 里走 MCP，或用命令行）
npx -y rea-agents@6.4.0 analyze-javascript-application _work/readable/dist --json

# 4. 抓包（步骤见 docs/09；mitmproxy 装在 <仓库>/.tools/venv-mitm）
tools/capture.sh start --decrypt-context   # 另开终端：退出 Typeless → capture.sh on → 启动 → 使用 → 退出 → capture.sh off
tools/capture.sh har _work/capture/<时间>   # 导出隐去凭据的 HAR 给 REA

# 5. HTML 阅读版（文档改过之后重跑；图在打开时联网渲染，文字离线可读）
node tools/site/build.mjs && open _work/site/index.html

# 6. 原生库（需要 Ghidra 12.1.4，见 docs/07）
export GHIDRA_INSTALL_DIR=<仓库>/.tools/ghidra_12.1.4_PUBLIC
lipo -thin arm64 <库> -output _work/native-thin/<库>.arm64.dylib
npx -y rea-agents@6.4.0 function _work/native-thin/libInputHelper.arm64.dylib _insertText --provider ghidra
```

## 边界

只做静态分析和对自己账号的流量观察。抓包原件里有本人说的话和当时屏幕上的文字，只留在 `_work/`，文档里只记结构、长度和时间。不做绕过订阅或额度，不碰别人的数据。服务端加密的内容（调试信息）不尝试破解。
