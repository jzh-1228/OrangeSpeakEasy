# 本地转写评测

识别要分成两条平级的链路，让用户自己选：一条是原生链路，录音直接交给收音频的大模型（Gemini、OpenAI）；另一条是先用本地小模型转写，再把文字交给任意大模型润色。这里评的是后一条里的本地转写这一跳：转得准不准、快不快、占多少内存。模型从配置表 [`src/models/catalog.mjs`](../src/models/catalog.mjs) 里取，测的就是装进 CLI 和 App 的那一份；测出来的数字和标签也写回那张表（`measured`、`tags`）。

- **样本**：各来源的录音抽样后统一成 16 kHz 单声道 WAV，每个候选读的都是同一份。来源在 `lib/sources.mjs`，现在有原版 Typeless 的历史和 OrangeSpeakEasy 自己的历史。
- **参照**：App 现在的原生链路，也就是 Gemini 3.6 Flash（思考档位 MINIMAL）加 App 的提示词出的成品。它同时是原生链路的耗时基线。
- **候选**：清单里的一个模型加上跑它的参数，在 `lib/candidates.mjs`。每个候选在单独的子进程里跑，记加载耗时、第一次的耗时（不算进各条）、每条的耗时和内存峰值。
- **判分**：判官是开发时协作的 Claude，不是哪个接进 App 的模型。它照 `lib/stages/judge.mjs` 里的标准打 0–5 分：判的是"交给润色之后能不能还原出参照的意思"，口头禅、标点、繁简这类差别不扣分。另算一个字面相似度当旁证。

## 怎么跑

```bash
node bench/prepare.mjs                                    # 抽样、洗成统一格式（_work/datasets/default/）
scripts/dev/with-key.sh gemini node bench/run.mjs         # 跑参照和各候选的转写，出报告；只跑转写不用 key：--stages transcribe
node bench/judge.mjs pending                              # 导出一批待判的（_work/judge/pending.md），判官判完写成 verdicts.jsonl
node bench/judge.mjs record bench/_work/judge/verdicts.jsonl   # 校验后存进结果库，再 pending 拿下一批
node bench/report.mjs                                     # 只出报告
```

`run.mjs`、`judge.mjs` 和 `report.mjs` 都可以只选一部分：`--candidates a,b`、`--lang zh,mixed,en`、`--limit 20`、`--clips id1,id2`、`--dataset 名字`。

## 全量和增量

每一格的结果按"输入的指纹"存进 `_work/results.db`。指纹里是会影响这一步结果的所有东西：

- 参照：录音、模型、思考档位、提示词
- 转写：录音、模型文件、运行库版本、参数
- 判分：参照、转写、判官、评分标准

跑之前先算出这次选中的格子的指纹，库里已有的就跳过，没有的才跑。所以：

- 全量和增量是同一个命令。
- 加一个模型，只跑它那一列；加样本，只跑新的那几行。
- 改了评分标准，只重判。
- 加 `--force` 才会重跑选中的格子。

## 加东西

- **加模型**：在 `src/models/catalog.mjs` 加一项，在 `lib/candidates.mjs` 加一个候选。要给用户用的，再把文件传到国内源（`npm run sync-models`，见 [开发说明](../docs/development.md)）。
- **加运行库**：在 `src/server/asr/engines/` 写一个适配器，并在 `index.mjs` 登记。
- **加样本来源**（比如公开数据集）：在 `lib/sources.mjs` 加一项。

## 封存一轮

一轮跑完、判完以后封存成两份：

- **仓库里**：`results/` 下写一份只有汇总数字的记录，注明代码版本、运行库版本、机器、样本构成和结论。
- **本机**：把结果库、报告、判分记录、样本和日志拷进 `_work/archive/<轮次>/`，附上 `SHA256SUMS`，再改成只读。

之后的轮次接着往同一个结果库里加，封存的那份不再改动。

| 轮次 | 评的是 | 记录 |
| --- | --- | --- |
| asr-round1-2026-10-16 | 本地转写这一跳，5 个候选 | [results/asr-round1-2026-10-16.md](results/asr-round1-2026-10-16.md) |
| e2e-local-2026-10-16 | local 模式整条链路（转写加润色），和从哪个下载源下得快 | [results/e2e-local-2026-10-16.md](results/e2e-local-2026-10-16.md) |
| asr-windows-2026-10-17 | 本地转写这一跳在 Windows 上（Vulkan 和 CPU），6 个候选 | [results/asr-windows-2026-10-17.md](results/asr-windows-2026-10-17.md) |
| vocabulary-2026-10-19 | 词典：15 个模型带不带词典，认对了几个、硬塞了几个 | [results/vocabulary-2026-10-19.md](results/vocabulary-2026-10-19.md) |
| vocabulary-hillclimb-2026-10-19 | 在词典评测上爬山改三处讲词典的写法（一处都没留下） | [results/vocabulary-hillclimb-2026-10-19.md](results/vocabulary-hillclimb-2026-10-19.md) |

词典的两轮不走上面的结果库：评测是 `scripts/dev/eval-vocabulary.mjs`，爬山是 `scripts/dev/climb-vocabulary.mjs`（照 Claude Code 的 `/claude-api hillclimb` 流程），判法共用 `lib/vocabulary.mjs`，数据在 `_work/vocabulary/` 和 `_work/hillclimb/`。

`_work/` 不进仓库：里面有洗好的录音、下载的模型、结果库和报告，都包含说过的话。
