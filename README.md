# sdd-guard

[![CI](https://github.com/Xu3Zhen1/sdd-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Xu3Zhen1/sdd-guard/actions/workflows/ci.yml)

> 要拿去改真实项目？先读 **[使用说明书](docs/USAGE.md)** —— 含「重构积重难返的项目」推荐路线、常见红→怎么修、已知边界。

把 YAGNI / KISS / DRY 里**可机械判定**的部分，变成会 FAIL 的检查。
零依赖，只用 Node 内置模块。

## 为什么需要它

把三原则写进 `AGENTS.md` 是**倡议书**：AI 会顺从地点头，然后照旧堆代码。
真正有约束力的是"会变红的判据"。但三原则里大部分内容**本质上不可机械判定**
（比如"这个抽象该不该有"），所以正确做法是分流：

| 类别 | 处理 | 占比 |
| :-- | :-- | :-- |
| 可机械判定 | 写成规则，违背即 FAIL | 16 条 |
| 本质不可判定 | 标记 MANUAL，**永远不算通过**，必须人签字 | 6 条 |
| 输入不足 | 标记 SKIP，**不算通过**，单独计数 | 动态 |

合计 **23 条 = 17 机器 + 6 人工**。

## 两套档位：开发流程 ≠ 验收标准

| | `--profile process` | `--profile acceptance` |
| :-- | :-- | :-- |
| 回答什么 | 有没有按流程把活写清楚 | 能不能交付 |
| 包含哪些规则 | 四制品判据（proposal / specs / design / tasks），**11 条** | 代码级判据 + `ACCEPT-E*`，**11 条** |
| 何时跑 | 开发过程中反复跑 | 交付前跑一次 |
| 失败含义 | 还没走到位，**不代表交付不合格** | **不能收** |
| 输入 | 四个 md 制品 | 制品 + `--evidence` 外部证据 |
| 可豁免 | 可（原型阶段） | **不可** |

```bash
# 开发中：只查流程
node cli.mjs check --change <dir> --profile process --repo . --config guard.config.json

# 交付前：只查验收，必须给证据（缺它或证据不全 ⇒ 退出码 2）
node tools/make-evidence.mjs --out evidence.json    # 跑项目自己的 test/mutation/drift 并合成证据
node cli.mjs check --change <dir> --profile acceptance --evidence evidence.json \
  --repo . --config guard.config.json --code src --code web --code shared
```

`acceptance` 档**只读它没参与生产的证据**（测试/变异/漂移由项目自己的脚本产出），因为同一进程既生产证据又判定证据等于自证。`--profile all`（默认）跑全部规则。

`SKIP` 与 `MANUAL` 都不计入通过数，报告末尾强制打印覆盖率。
这是针对本项目历史教训的设计：**空集与未执行不得被读成"没问题"**。

## 用法

```bash
node cli.mjs check \
  --change changes/add-empty-check \
  --repo . \
  --config guard.config.json \
  --code src \
  --diff diff.json
```

退出码：`0` = 机器规则全过；`1` = 有 fail（或 `--min-coverage` 下覆盖率不足）；`2` = 输入/配置错误。
`--strict` 把 MANUAL 也算失败（CI 用，慎用：会逼人签字）。

**CI 里请加 `--min-coverage 0.8`。** 不加的话，「一个空的 change 目录」与「全部通过」退出码都是 `0`——
实测空目录会报「通过 1 · 失败 0 · 跳过 16」而退出码 0，等于放行空提交。
覆盖率不足说明的是**没检查**，不是**检查了没问题**。

## 规则清单

### 提案阶段（proposal.md）

| ID | 原则 | 判据 |
| :-- | :-- | :-- |
| YAGNI-P1 | YAGNI | 「非目标」小节存在，且 ≥3 条**每条都带理由** |
| YAGNI-P2 | YAGNI | *MANUAL* 非目标是否真的被裁掉 |

注意：只有「变更范围」不算数。标题必须写明**不做**的事。

### 规范阶段（specs/）

| ID | 原则 | 判据 |
| :-- | :-- | :-- |
| KISS-S1 | KISS | 每条 Requirement ≥1 个 Scenario，GIVEN/WHEN/THEN 齐全；**零 Requirement 判失败** |
| KISS-S2 | KISS | 单个 Scenario 不得有 ≥2 条 THEN |

### 设计阶段（design.md）

| ID | 原则 | 判据 |
| :-- | :-- | :-- |
| KISS-D1 | KISS | 配置里声明的每个依赖，都必须在依赖表登记「标准库为什么不行」 |
| DRY-D1 | DRY | 复用清单里的路径**必须真实存在**（凭空写的会红） |
| KISS-D2 | KISS | *MANUAL* 架构是否过度设计 |

`DRY-D1` 是这套东西最有价值的一条之一：它把"我检索过现有代码了"
这种无法验证的自述，换成了可验证的文件存在性。

### 任务阶段（tasks.md）

| ID | 原则 | 判据 |
| :-- | :-- | :-- |
| DRY-T1 | DRY | 任务里的文件路径必须存在，或显式标注「新建」；**一个路径都不给判失败** |
| DRY-T2 | DRY | *MANUAL* 是否需要先抽公共函数 |

### 代码阶段

| ID | 原则 | 判据 |
| :-- | :-- | :-- |
| KISS-C1 | KISS | 嵌套深度 ≤ `maxNesting`（默认 3） |
| DRY-C1 | DRY | 跨文件连续 ≥`dupWindow` 行规范化重复 |
| YAGNI-C1 | YAGNI | 不得出现「预留/未来可能用到/for future use」类标记 |
| DISCIPLINE-C1 | 纪律 | 变更落在 `allowedPrefixes` 内，且总行数 ≤ `maxDiffLines` |
| DISCIPLINE-C2 | 纪律 | **仓库根不得堆积临时产物**（`pip-*` / 随机 `tmp*` / `cdp-profile-*` / `diag-*`） |
| DISCIPLINE-C3 | 纪律 | **文档声明的文件必须出现在实际变更里**（文档↔代码绑定） |
| KISS-C2 | KISS | *MANUAL* 现有依赖能否替代新增抽象 |

### 前后端解耦（DECOUPLING）

| ID | 阶段 | 判据 |
| :-- | :-- | :-- |
| DECOUPLE-1 | design | 必须有「接口契约」小节，契约路径**真实存在**且落在 `contractPrefixes`（默认 `shared/`）内 |
| DECOUPLE-2 | code | 按 `boundaries` + `forbidImports` 检查 import：**前后端不得直接引用对方内部路径** |
| DECOUPLE-3 | design | *MANUAL* 契约是否覆盖所有跨端通道（字段/错误码/分页/枚举/空值语义） |

解耦的落点是**契约单一真源**：类型与错误码只写一处，两侧各自引用或生成。`DECOUPLE-2` 只做**静态 import** 判定（`import` / `require` / `from-import` / Go-Java import），动态拼接路径不判定——宁可漏报也不误报。

**关于 DISCIPLINE-C2（2026-11-11 实证）**：同一工作区并行跑 1 主线 + 4 teammate，
共 66 次 pip install 以工作区根为 cwd，在根上留下 **335 个** `pip-*` 临时目录。
根因是子进程里 `TMPDIR/TEMP/TMP` 不可用、Python `tempfile` 回退 `os.getcwd()`；
危害是挤占按一级目录扫描的工具额度（身份卡扫描上限 200），后加的子项目**扫不到且不报警**。
配套的可执行前置约定写在 `AGENTS.md.template` 第 5 节（workdir ≤ 项目子目录、显式指定临时目录、清理要覆盖工作区根）。

**关于 DRY 的取舍**：原方案提的"相似度 >60% 必须抽函数"被**故意不实现**。
那是个可测但无意义的指标——按行算两个不同分支很容易撞上，AI 会为了压数字
硬抽 `handleCommonCase2`。`DRY-C1` 只抓**跨文件**的连续重复块，抓真复制粘贴，
且同文件内重复不报（那常是合理的数据表）。

## 配置

```json
{
  "maxNesting": 3,
  "dupWindow": 6,
  "dupMinChars": 40,
  "yagniMinNonGoals": 3,
  "dryMinReuse": 1,
  "dependencies": { "left-pad": "^1.3.0" },
  "allowedPrefixes": ["src/"],
  "maxDiffLines": 400
}
```

`dependencies` 用来喂 KISS-D1：从 `package.json` 的 diff 里提取新增包名填进去。

## 验证

```bash
node test/guard.test.mjs      # 45 个用例：正向基线 + 每条规则的负控与正控 + 档位与验收证据
node test/args.test.mjs       # 10 个用例：CLI 参数契约（--code 累积、--only 未知 id…）
node test/evidence.test.mjs   # 15 个用例：证据解析器（真输出吃得住、假输出必抛错）
node test/mutation.mjs        # 11 个变异：证明判据真的依赖实现
node tools/check-contract.mjs # 契约漂移检测：ICD / contract.mjs / 代码 / README 四方比对
node tools/self-check.mjs     # ← 一条命令跑完以上全部 + 生成证据 + 跑验收（推荐）
node tools/check-publish.mjs   # 脱敏 / LF / package.json 结构 / .gitignore 覆盖

## CI 跑什么

`.github/workflows/ci.yml` 在 ubuntu 与 windows、Node 20 与 22 上跑**同样两条命令**：`self-check` 与 `check-publish`。
本地绿 ≠ CI 绿的事我们不接受——所以 CI 不重新发明规则，只是把这两条命令执行一遍；失败时上传 `.selfcheck/` 原始日志。
```

`self-check` 是交付前唯一需要记住的命令：8 个步骤全部通过才 exit 0；任一步失败整条命令失败，原始输出留在 `.selfcheck/`。**默认对 sdd-guard 自己跑验收（自举）**：change 目录 `changes/self-host-guard/`，代码根 `lib tools cli.mjs`。
它**先删旧证据再重新生成**，避免 make-evidence 失败时拿上一次的 `evidence.json` 跑出假绿。

`mutation.mjs` 对每条规则做 `fail → pass → fail` 三态验证：
把 `run()` 换成恒真实现后规则必须翻绿，还原后必须翻红。
这排除了"判据恒真"与"判据由环境而非实现决定"两种假象。

## 与 OpenSpec 的关系

本目录**不是** OpenSpec 的分支，也不依赖它。四制品的结构约定
（proposal / specs / design / tasks）参考了 OpenSpec 与 GitHub Spec Kit
等公开的 spec-driven development 实践，均为公开方法论。
模板与全部提示词为本项目自行撰写，未抄录任何第三方的模板原文。

## 已知边界

- 只支持 Markdown 的 `##` / `###` / `####` 标题结构；不用 Markdown 表格的非目标清单走列表分支。
- 重复块检测基于行序列，不做 AST 归一化；变量重命名后的等价代码抓不到。
- `KISS-C1` 的花括号深度是启发式（会剔除字符串与注释），非完整解析器。
- 中文与英文的 GWT 都识别，但混写在一行内的简写形式可能漏判。
