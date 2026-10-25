# SpeakMore 项目分析与优化报告

> 生成于 2026-10-24。执行方式：「项目分析与优化」工作流（五名分析员并行摸底 → 规划 → 独立评审 →
> 逐项实施，门禁为 biome 全绿 + 单元测试无基线外新增失败）。工作流在第 4 项实施中途因模型账号配额
> 中断（2026-10-26 07:42 重置），第 4~6 项与最终报告由主会话按同一门禁纪律补完。

## 一、结论

本轮从五个侧面（架构与启动链路、核心运行时、服务与 CLI、渲染层、工程与依赖）分析了这个项目，
共产出 31 条发现，经规划与独立评审选出 6 项低风险、单测可验证的优化，**全部落地并通过门禁**；
随后独立审查员对全部改动做对抗性审查，确认的问题已修复并复验。六项改动覆盖四类问题：

- **Windows 可用性**：仓库缺 `.gitattributes`，Windows 默认克隆后 lint 门禁完全不可用（已实测复现）；
- **数据安全**：`settings.json` 非原子写，写到一半中断会让 App 启动即退出；
- **运行韧性**：本地小帮手（native helper）意外退出后只能人工恢复；
- **协议健壮性**：CLI 靠中文错误文案的正则识别旧版后台，文案一改就断。

另有工程化补强（模型目录防呆、最小 CI）。全部改动见「三、六项优化明细」。

## 二、基线状况与门禁口径

- 环境：Windows 10.0.26200 x64，Node v24.9.0，仓库全新克隆于 2026-10-24。
- 克隆后发现：默认 `autocrlf=true` 使全部文本文件变 CRLF，`biome check .` 报 500+ 条格式错误。
  修正克隆行尾后 lint 恢复真实基线（这也成了第 1 项优化的动因）。
- 门禁两条，每条改动后都跑：
  1. `node node_modules/@biomejs/biome/bin/biome check .` 退出码与基线一致（基线为 0）；
  2. `node --test --test-timeout=5000 --test-reporter=spec "test/*.test.mjs" "test/!(install)/**/*.test.mjs"`
     —— **相对基线不得出现新增失败**（出现新失败时自动重跑一次排除偶发）。
- 测试基线：1511 个用例，1436 通过，65 跳过，10 失败。10 个失败全部是 Windows 环境性问题
  （创建符号链接需要开发者模式/管理员权限；卸载流程依赖 macOS 钥匙串行为），
  失败集合在全部改动前后完全一致（0 新增失败）。

## 三、六项优化明细

### 1. 新增 `.gitattributes` 统一行尾（已提交 d80ad1b）

- **问题**：仓库没有 `.gitattributes`。Windows 上以默认 `core.autocrlf=true` 克隆时所有文本文件被转成
  CRLF，`biome check .` 直接报 500+ 条格式错误——lint 门禁在 Windows 克隆上完全不可用。
- **改法**：`* text=auto eol=lf`（入库与检出统一 LF）；`*.ps1 text eol=crlf`（PowerShell 按 Windows 惯例）；
  icns/ico/png/jpg/ogg/webm 显式标 `binary`，防 `text=auto` 误判。
- **验证**：本机复现（全新克隆 → 全红 → `core.autocrlf false` 重检出 → 立即全绿）；
  落地后 `biome check .` 退出码 0。
- **文件**：`.gitattributes`（新增）。

### 2. `settings.json` 改原子写

- **问题**：`src/storage/settings.mjs` 的 `writeFile` 直接 `writeFileSync` 覆盖。写到一半断电/盘满会留下
  半截 JSON，而 App 启动时读设置失败会直接退出——坏一次文件，损失的不是一项设置，是整个应用起不来。
- **改法**：先写 `${file}.${pid}.tmp`，再用 `replaceFile`（复用 `vocabulary.mjs` 已导出的实现）原子换上；
  失败时 `rmSync` 清理临时文件再抛。序列化格式与从前一字不差（两空格缩进、末尾换行）。
- **测试**：新增 2 条——临时文件不残留（目录里只有 `settings.json`）；写出的 JSON 与预期一字节不差。
- **文件**：`src/storage/settings.mjs`、`test/storage/settings.test.mjs`。

### 3. 小帮手意外退出后自动重拉

- **问题**：本地转写/录音用的小帮手（native helper）意外退出时，App 只弹提示等用户手动从设置恢复。
  一次崩溃之后转写就一直用不了。
- **改法**：新增纯逻辑模块 `src/app/helper-revive.mjs`（照 `setup-state.mjs` 的惯例抽出，便于单测）：
  指数退避 1s→2s→4s→8s→16s，等待封顶 30s；连续 5 次意外退出后停手等人工处理。
  「崩」算不算新的一次故障按存活时长判定：**跑满 60 秒再崩才算新故障、额度重给**，刚起来就崩则接着
  上次计数——否则报完 ready 立刻崩的小帮手会 1 秒一轮无限重拉。`main.mjs` 只在非 e2e 的当前代
  helper 退出分支里触发重拉；定时器持有句柄，任何一次显式启动（重查权限、命令行重查）与 `before-quit`
  都会先清掉它，回调前再核对代数与状态，避免手动重查后又被重拉多起一个、旧进程无人停止。
- **测试**：新增 5 条（首次 1s、逐次翻倍至上限、封顶 30s、稳定运行后重置、ready 后秒崩继续翻倍）。
- **文件**：`src/app/helper-revive.mjs`（新增）、`src/app/main.mjs`、`test/app/helper-revive.test.mjs`（新增）。

### 4. 控制通道错误回复加结构化 code，CLI 六处收敛

- **问题**：CLI 有六处靠 `/^不认识的命令/` 匹配错误文案，识别"正在运行的是升级前启动的后台、还不认识
  这条命令"的降级场景。服务端一旦改措辞（或将来做 i18n），这些分支就断，原始错误会直接抛给用户。
- **改法**：
  - `src/control.mjs`：三处错误回复加稳定 `code`（`unknown_command` / `request_too_long` / `bad_request`），
    中文文案一字不动；协议注释同步；`requestControl` 把 `reply.code` 透传到拒绝的错误对象上。
  - `src/cli/common.mjs`：新增 `isUnknownCommand(error)`——先认 `code`，旧后台不回 code 时按旧中文原话兜底。
  - 六处正则收敛为对该函数的调用：`commands/config.mjs` 1 处、`commands/local.mjs` 3 处、
    `commands/model.mjs` 1 处、`commands/route.mjs` 1 处。
- **测试**：`test/control.test.mjs` 新增 2 条（`unknown_command` 带 code 且中文照旧；超 64KB 请求回
  `request_too_long`），既有 bad-JSON 用例补 `bad_request` 断言；`test/cli/common.test.mjs`（新增）3 条
  钉住 `isUnknownCommand` 的两种认法与拒绝无关错误。
- **文件**：`src/control.mjs`、`src/cli/common.mjs`、`src/cli/commands/{config,local,model,route}.mjs`、
  `test/control.test.mjs`、`test/cli/common.test.mjs`（新增）。

### 5. 模型目录对必填字段防呆

- **问题**：`src/models/catalog.mjs` 的 `freeze` 对 `model.measured` 直接 `.map()`。新增模型条目漏写
  `measured`（最容易漏的一项）会在模块加载时抛 `TypeError`——CLI、App、后台都 import 这张表，一处漏写
  一起倒下。审查进一步指出：`tags/files/origin/mirror` 缺失虽不炸加载，但会在使用处抛看不出出处的
  裸 TypeError。
- **改法**：`measured` 缺失按空表处理（`(model.measured ?? [])`：`measuredOn` 返回空，按实测做的
  筛选自然不会选中它）；`tags/files/origin/mirror` 在 `freeze` 时一次性校验，缺了当场报
  「模型 xxx 缺少字段 yyy」。均配中文注释说明为什么。
- **验证**：全量测试无新增失败；属防御性守卫，未为此导出内部函数加测试。
- **文件**：`src/models/catalog.mjs`。

### 6. 最小 CI 门禁

- **问题**：仓库没有任何 CI。contributions 只能靠本地自觉。
- **改法**：新增 `.github/workflows/ci.yml`：`macos-latest` + Node 22，`npm ci` → `npm run lint` →
  `npm run test:unit`。不含 `test:install` / `test:native` / `test:e2e`（需要真实安装、原生工具链、
  图形会话，属发布流程）。选 macOS 是因为：仓库 `os` 只声明 darwin/win32；Linux 上 `npm ci` 受根包
  平台字段限制、且 GNU tar 不认 macOS bsdtar 参数（`windows-setup` 测试必挂）；Windows 上有一批
  环境性单测失败。macOS 是本项目自己的开发平台，单测在这上面才是全绿基线。
- **验证**：YAML 本地无法执行；`npm run lint` 与 `npm run test:unit` 两条命令在本机按门禁口径通过。
  macOS runner 上的首次运行结果需推送后由 GitHub Actions 给出（未实测，见「五、限制」）。
- **文件**：`.github/workflows/ci.yml`（新增）。

## 四、验证与证据

- `biome check .`：最终代码树 **518 个文件，退出码 0**（与基线一致）。
- 单元测试：**1513 用例（较基线新增 2 条）/ 1438 通过 / 65 跳过 / 10 失败**；10 个失败全部为本机
  环境性（符号链接权限、卸载流程的钥匙串行为），失败集合改动前后完全一致，**0 新增失败**。
- 每项改动均在通过上述两条门禁后才保留；第 1~3 项由工作流的独立实施者完成并验证，
  第 4~6 项由主会话补完并验证（同一口径）。审查后的修复改动重新过了双门禁。
- 6 项方案经独立评审员逐项读码评审（前提真实性、破坏性、收益真实性）后全数放行；
  实施完成后又由一名未参与实施的审查员对全部 diff 做了对抗性审查（见第六节）。

## 五、限制与未覆盖

- `npm run test:install` / `test:native` / `test:e2e` 未运行：分别需要真实安装流程、原生工具链、GUI 会话。
- `bench/` 本地转写评测未运行（需要模型文件与 API key）。
- 渲染层 UI 的真实交互未做运行时验证（分析阶段只做静态读码）。
- CI 在 macOS runner 上的首次运行结果未实测（本地只能验证命令口径）。
- 小帮手重拉策略有纯逻辑单测，但真实崩溃场景的集成路径未经运行时验证（定时器清理与代数守卫仅经静态审查）。
- 分析阶段共 31 条发现，6 条入选并落地（本文档）；其余 25 条因工作流中断未保留原文，
  未在本文档中呈现，也未经独立复核。

## 六、独立代码审查

改动完成后，一名未参与实施的审查员对全部 diff 做了对抗性审查（报出 9 条确认问题 + 4 条存疑）。
按「先核实再采信」逐条处理如下。

**已修复（复验通过双门禁）：**

- [high] 重拉定时器无人管理：崩溃后若用户或命令行手动重查，定时器到期会再拉起一个小帮手，旧进程无人停止；
  `before-quit` 也不清定时器。已改为持有句柄、显式启动与退出时清除、回调前核对代数与状态。
- [medium] `ready` 即重置重拉额度：报完 ready 立刻崩会 1 秒一轮无限重拉。已改为按存活时长判定
  （跑满 60 秒才算新故障），并补 2 条测试。
- [high] CI 平台：审查指出 ubuntu 上 `npm ci` 受根包 `os` 字段限制、GNU tar 不认 macOS bsdtar 参数
  （`windows-setup` 测试必挂）。CI 改为 `macos-latest`。（`os` 限制一项用 `npm ci --dry-run --os=linux`
  未能直接复现——该参数不影响根包校验路径，无法完全实证；GNU tar 一项证据确定。）
- [low] settings 原子写失败清理可能顶替原始错因（`rmSync` 清理失败再抛会盖掉真正的错误）：
  已包一层 try/catch 保留原错误，并补失败路径测试（临时文件路径被占住时：原 `settings.json` 不动、
  抛出的仍是原错误）。
- [low] catalog 其余必填字段缺失时抛裸 TypeError：已加一次性校验（见第 5 项）。
- 本机工具目录 `.v2c/`、`.video_agent/` 未被忽略：已加入 `.gitignore`。

**核实后接受（记录在案，不改）：**

- 原子写使 POSIX 上只读的 `settings.json` 也可被覆盖（rename 只受目录权限约束）：属原子写的固有语义，
  设置文件由 App 自管，接受该行为变化。
- Windows 上 `replaceFile` 重试最长同步阻塞约 0.5 秒（杀毒软件占用目标文件时）：复用词典页已在用的
  成熟实现，概率低，接受。
- 存疑项（Linux 上 Electron spawn 的共享库依赖、`posixOnly` 实为「非 Windows」、原子写无 fsync 的
  断电耐久性、`measured` 缺 `realtime` 时排序不稳定）：均未发现会导致目标平台（darwin/win32）出错，
  记录不处理。

## 七、后续建议

1. 6 项改动按逻辑单元提交（`.gitattributes` 已单独提交 d80ad1b；其余在工作区）。语义上可分三组：
   数据安全（settings 原子写）、运行韧性（helper 重拉）、协议健壮（code + isUnknownCommand）；
   CI、catalog 防呆、.gitignore 可各成一提交。
2. 推送后确认 CI 首次运行；若 macOS runner 上仍有平台性失败，把对应用例按既有 `skip` 惯例加平台守卫。
3. 如需补齐那 25 条未落地的分析发现，可另跑一轮「只分析不实施」的流程（工作流在配额重置后仍可恢复，
   但实施已完成，恢复旧运行会重派已完成的实施步骤，不建议）。
