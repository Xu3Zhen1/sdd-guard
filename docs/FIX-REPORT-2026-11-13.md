# sdd-guard 审计修复交付报告

审计依据：`docs/LOGIC-AUDIT-2026-11-13.md`（基线 `311a54c`）与 `_work/audit-{rules,evidence,integration}.md`。
日期：2026-11-13。执行环境：Windows / Node v24.19.0。

> ## ⚠ 本报告已按独立复核修订（**第五版**）
>
> **第一版**报「self-check 22/22 全绿、可复现」。**那个结论是错的**——它只在一种环境配置下成立，
> 而那种配置恰好把缺陷掩盖了。独立复核在另一种配置下复现出 **20/22、exit 1**，并指出五项问题。
>
> **第二版**修完那五项、报了「三种配置下 25/25」。**又漏了两件**，第三次复核指出：
> ① 真实变更不只是"超预算"，C1 报 **17 项**（含 12 个越界文件）、C3 报 **27 项**（文档↔代码绑定失败），
> （**第五版更新**：越界已清零、C3 已转 PASS；仅余行数超预算，且该预算与拆分方案存在结构冲突，见 §六）
> 报告只披露了预算；
> ② 我新加的 `real-diff-notice` 在**输入无法判定**时（如 config 不存在、CLI 退 2）会打印
> **"本次真实变更通过 C1/C3"** —— 用"没找到失败文本"倒推"通过"。
>
> 两件都已修。**第二版最严重的问题不是代码，而是披露不全**：只说"超预算"，
> 读者会以为范围与绑定都是好的。
>
> 修的过程中又踩了一次同类坑：我用脚本做文本手术改 `tools/self-check.mjs`，
> 把 `scanReceipt`/`coverageGuard`/`disciplineFixtures`/`evidenceChain` 等函数连同
> `main` 的执行体一起切坏了，且**没有可回退的干净副本**（HEAD 是三版之前的基线）。
> 只能按 `buildPlan` 的调用签名逐个重建。**教训：大文件结构改造不能用正则/切片脚本，
> 要么用 `edit` 做定点替换，要么先 `git commit` 一次拿回退点。**
>
> 同时补了两处真正重要的机制：① `self-check.mjs` 加了 `isMain` 守卫 ——
> 原实现只要有人 `import` 它（比如为单测 `classifyRealDiff`）就会**静默跑一整次 25 步自检**；
> ② 新增 `test/real-diff-notice.test.mjs` 把归因逻辑钉住。
>
> **第四次复核**又抓到一个**同类漏洞换个位置**：`classifyRealDiff` 用**排除法**
> （排除 skip/manual/fail，剩下就算通过），于是两条规则**均缺 status**、
> 均为 `"unknown"`/`null`/`""`/`1`/拼错的 `"passed"` —— 六种畸形输入**全部宣称"通过"**。
> 已改为**状态白名单** `{pass, fail}`：不在此列的一律「无法判定」。
> 结论：**排除法会让未知值默认落到"好"的一侧**；判据要的是正面好消息，不是"没有坏消息"。

## 零、独立复核五项问题的处置（第二版新增）

| # | 复核指出的问题 | 复现 | 根因 | 处置 |
|---|---|---|---|---|
| 1 | `contract-guard.test.mjs:35` 整仓 `cpSync` 到 `tmpdir()` 子目录 | ✅ 5/6 用例在**准备夹具**阶段就红 | 工作区把 `TMP` 指向项目内 `_work/tmp` ⇒ 副本落进 ROOT 内部 ⇒ `cpSync` 报「复制到自己的子目录」 | 新建 `lib/temp.mjs`，**逐个候选实测可写**再选；整仓复制用 `avoidRoot=true` 强制排除 ROOT 内路径 |
| 2 | `make-diff.test.mjs:286` 的"非 Git 目录"夹具前提不成立 | ✅ 实际 exit 0，断言要求 2 | 夹具目录落在父仓库内，`git diff` 向上发现仓库 | 夹具建好后**自证** `git rev-parse --show-toplevel` 为空；不成立则 skip 并声明未执行（不假绿也不假红） |
| 3 | `scan-roots.test.mjs:34` 只列 Windows 系统目录 | ✅ Ubuntu 上会因夹具缺失而红 | 跨平台夹具缺陷，**不是**"矩阵尚未跑" | 先**自己造**不可读目录（POSIX `chmod 000` / Windows `icacls /deny`），造不出才回落系统目录；造不出则 `t.skip` 并声明未执行 |
| 4 | ACCEPT-E2 返回 `pass` 但 detail 写「不据此判 PASS」 | ✅ 实测 `status: pass` 而文案自相否证 | 状态与措辞不一致 | 保持 `pass`（不拿判据回归换措辞），改用 `signal='partial'` + 改写 detail，**明确区分"已判定的（杀死率/自洽性）"与"未判定的子项（清单完整性）"** |
| 5 | `acceptance` 仍 7/10，三条 SKIP 只是"可追踪" | ✅ | C1/C3 因自检从不产出 diff 而永远跳过 | 自检新增 `make-diff` 步 + 两个新步：`discipline-fixtures`（**三向**验证 C1 会判：合规 PASS / 越界 FAIL / 超预算 FAIL）与 `real-diff-notice`（用真实变更量一次并**如实通报**是否超预算，advisory 不参与绿红） |

### 第 1、3 项暴露的**同类根因**（比单项修复更重要）

`tmpdir()` 在本机有三种行为，**每一种都让"判据没被执行"伪装成"判据判定失败"**：

| 配置 | `tmpdir()` | 结果 |
|---|---|---|
| `TMP=项目内 _work/tmp` | `…/_work/tmp` | 副本落进 ROOT ⇒ `ERR_FS_CP_EINVAL`；且被 `check-publish` 判"本机绝对路径" |
| `TMP` 未设 | `C:\WINDOWS\temp` | 该目录在本沙箱**不可写** ⇒ `mkdtemp` EPERM |
| Linux CI | `/tmp` | 正常 |

全仓库 **12 个文件**散着这个假设（含 `tools/check-contract.mjs` 与 `tools/make-evidence` 路径上的工具）。
所以不是逐处打补丁，而是抽出 `lib/temp.mjs` 统一：候选**逐个实测**（`mkdir` 成功**且**能在其中 `mkdtemp` 一个 probe），
顺序**先项目周边、后系统 tmp**。收敛后三种配置（默认 / 工作区 TMP / 随机被拒 TMP）**全部绿**。

### 一个必须点明的连带错误

`tools/check-contract.mjs` 里两处 `mkdtemp(tmpdir(), …)` 失败时，**不是报错而是把两项检查降级成 FAIL 行**
（「无法实测 CLI 退出码」「无法取得 self-check 的执行清单」）。也就是说：
**A08「CI 等价性」与「退出码实测」这两项在默认环境下从来没真正跑过**，只是它们失败时看起来像"检查发现了问题"。
这是审计 I-02 那个形态的复现，是我自己引入的。

## 一、验收结论

> **验收通过，含一项已批准的行数预算例外。**

**审计列举的 A01–A16 全部有处置**（15 项实现修复 + A12 的未测边界用真实 git 临时仓库补实证），
**独立复核指出的问题（五轮）全部复现并修复**。

实测（**两种临时目录配置**各跑一遍 + **六环境矩阵**）：

- `self-check 28/28 exit 0`（工具健康 20 · 自举流程 1 · 交付检查 7）
- `check-contract 66/66 漂移 0`、17 套专项测试全绿、`spec-probe 38/38`、`mutation-selfproof 4/4`
- 发布阻断 0；`DISCIPLINE-C3`（文档↔代码绑定）**PASS**：33 条声明全落地、53 个变更均有出处
- 六环境矩阵 **6/6 success**（ubuntu/windows × Node 20/22/24，三次独立运行均绿）：
  run `43453136896` @ `0f5cb93` · run `43455372979` @ `f823a08` · **run `43464814098` @ `bd26ef8`（最终提交）**

**唯一未通过的机器判据**：`DISCIPLINE-C1` 的**行数预算**（7782 行 > 400），**已获人工批准一次性例外**（见 §六）。

> 措辞纪律：这是「验收通过 **+** 一项已批准的机器判据例外」，
> **不是**「全部机器判据通过」。`DISCIPLINE-C1` 的 FAIL **照旧保留在输出里**，
> 人工批准不等于机器判定被改写成 PASS。

**仍未覆盖的**：macOS、Node 21/23、`workflow_dispatch`/PR 触发路径、git 不可用路径、非 JS 真实仓库、MANUAL 规则语义。逐条见 §六。

## 二、验收数字（全部实跑，可复现）

**复现命令**（关键是**不设 TMP**，即系统默认；第一版只在工作区 TMP 下跑过，掩盖了两个缺陷）：

```powershell
cd sdd-guard
Remove-Item Env:TMP,Env:TEMP -ErrorAction SilentlyContinue   # ← 第一版漏了这一步
node tools/self-check.mjs
```

| 检查 | 修复前 | 第一版（单配置） | **当前（第五版）** | 命令 |
|---|---|---|---|---|
| 一键自检 | 10/10，验收实际 7/10 | 22/22（后撤回） | **26/26，exit 0（两种 TMP 配置各跑一遍）** | `node tools/self-check.mjs` |
| 契约漂移 | 53/53 | 66/66 | **66/66，漂移 0** | `node tools/check-contract.mjs` |
| 基础测试 | guard 76 · args 12 · evidence 18 | 同左 | **guard 76 · args 12 · evidence 31** | 见 `scripts.test` |
| 专项测试 | 51 条**不在门禁** | 进 `scripts.test` | **进 `scripts.test`，15 套全绿** | 同上 |
| KISS-C1 自举 | 未扫 `cli.mjs` | 18 文件 0 超限 | **19 文件 0 超限**（新增 `lib/temp.mjs`） | `--only KISS-C1` |
| 规格探针 | 旧探针锁缺陷现状 | 38/38 | **38/38** | `node _work/spec-probe.mjs` |
| 变异自证 | 无 | 4/4 | **4/4** | `node _work/mutation-selfproof.mjs` |
| 发布前置 | — | 阻断 0 | **阻断 0** | `node tools/check-publish.mjs` |
| **真实变更 C1** | — | 未披露 | **越界项 0；仍超 400 行预算（7683 行）** | `real-diff-notice` 步 |
| **真实变更 C3** | — | 未披露 | **PASS：33 条声明全部落地、53 个变更文件均有出处** | 同上 |

**临时目录配置实测矩阵**（这是第一版缺的维度）：

| TMP 配置 | guard | make-diff | scan-roots | contract-guard | contract | 自检 |
|---|---|---|---|---|---|---|
| 未设（`C:\WINDOWS\temp`，沙箱禁写） | ✅ | ✅ | ✅ | ✅ | 66/66 | **26/26** |
| 指向 `_work/tmp`（项目内） | ✅ | ✅ | ✅ | ✅ | 66/66 | **26/26** |
| 指向家目录随机目录（被拒） | `lib/temp.mjs` 自动回落 | — | — | — | — | — |

**只跑过这两种配置**。第三种（随机被拒）本轮没有独立复跑，报告不再声称"三配置"。

逐套测试（默认 TMP，全部 exit 0）：

```
guard.test 76/76 · args.test 12/12 · evidence.test 31/31 · make-diff.test 12/12
q1 17/17 · q2 7/7 · q2-value 7/7 · q3 6/6 · q46 6/6 · q4.5 8/8
scan-roots 9/9 · contract-guard 6/6 · mutation 12 变异全捕获 · prove-multiroot
```

自检汇总（三类范围，当前 **28 项** = 工具健康 20 · 自举流程 1 · 交付检查 7）：

```
── 工具健康（tests / 变异 / 契约 / 发布） · 17/17 ──
── 自举流程（process 档） · 1/1 ──
── 交付检查（acceptance + 覆盖率） · 7/7 ──
    coverage-guard · make-diff · make-evidence · evidence-chain
    acceptance · discipline-fixtures · real-diff-notice
```

## 三、逐项处置

### A01 · 配置值域（P1）—— 已修
新增 `lib/config.mjs` + `lib/contract.mjs` 的 `CONFIG_SCHEMA`：按 **kind** 校验（posInt / nonNegInt / ratio / stringArray / pathPrefixArray / stringMap / prefixMap / forbidImports / exemptArray），**未知键也报错**。
证据：`maxNesting:"garbage"` 现在 **exit 2** 并指明「maxNesting 必须是正整数」；正控证明合法阈值下四层嵌套仍 FAIL。

### A02 · 数值域（P1）—— 已修
新增 `lib/values.mjs`：计数只接受**非负安全整数**，比例只接受 0..1 有限数，布尔/null/数组一律拒收（不做隐式 `Number()`）。
证据：`passed=-1/-1`、`true/null`、`"1"/0`、`[]/0` 四类全 FAIL；`checks=-1`、`findings>checks` 全 FAIL；`added=1000/deleted=-1000` 判 FAIL（旧实现报「0 行，均在范围内」）。

### A03 · 仓库路径基准（P1）—— 已修
新增 `lib/paths.mjs`：`normalizeRel` 词法归一、`withinPrefix` 按**段边界**、`resolveRepoRef` 拒绝绝对路径与越界点段。`buildContext.existsProjectFile` **不再回落 cwd**。
证据：只在 cwd 存在的 `src/outside.js` 不再冒充 repo 内路径；`src/../outside.js` 与 `srcx/x.js` 都不再命中 `src/` 前缀。

### A04 · KISS-C1 嵌套计数（P1）—— 已修
`lib/code.mjs` 的 `nestingDepth` 重写为**词法状态机 + 括号栈 + 圆括号 callee 栈**：
- 右括号**弹出它所属那一层**，对象结尾不再扣控制流层数；
- 逐字符扫每行、记录**行内最大**控制深度，单行紧凑写法不再漏计；
- 维护块注释 / 字符串 / 模板串 `${}` / 正则字面量的状态。

证据：普通四层=4、三层+对象+第四层=4（旧报 3）、单行四层=4（旧无命中）、纯对象=0、模板串/正则/块注释里的括号不计层。

> **口径决定（需知悉）**：函数体**算一层**。这是 `guard.test.mjs:568` 既有负控明确要求的语义（"改语义不能把真问题一起放过"）；改用 eslint `max-depth` 口径会让那条负控变绿。**重构期间发现本项目自身有 13 处超限嵌套**（旧计数器全部掩盖），已逐处重构至 ≤3。

### A05 · 文档格式判据（P1）—— 已修
`lib/md.mjs` 新增 `fencedMask`/`stripFences`：分节树、表格、列表**全部隔离围栏代码块**。
`lib/rules.mjs`：YAGNI-P1 列表分支现在要求「事项 —— 理由」（新增 `splitReason`）；KISS-S2 按**出现次数**数 THEN 而非只数列表项。
证据：无理由列表 FAIL（旧 PASS）；带理由列表 PASS；围栏里的「非目标」不再成为正式小节；普通文本双 THEN FAIL、单 THEN PASS。

### A06 · 扫描完整性收据（P1）—— 已修
`lib/code.mjs` 新增 `scanCodeRoots`：逐根记录 `kind`/`files`/`errors`，**文件根不再贡献 0 个文件**，不可读子目录**留痕不吞**。
`cli.mjs` 的 `--code` 支持目录或单文件，非法根 exit 2。`tools/self-check.mjs` 新增 `scan-receipt` 步。
证据：`3 根 / 候选 18 / 已扫描 18（lib=dir:12 · tools=dir:5 · cli.mjs=file:1）`，`cli.mjs` 真的进了集合。

> 附带修掉 t-gates 抓到的**假字段**：`report.candidates`/`report.scanned` 原先初始化后从未赋值、恒为 0 —— "看着像数据、其实是没测"。

### A07 · 自检真实门禁（P1）—— 已修
七套专项全部进 `scripts.test` 与自检常跑清单；每个子进程断言**精确退出码**；coverage-guard 期望**写死 0 与 3**（旧版只判"非零"，"3→1"那个变异完全看不出来）；汇总按**三类范围**分段声明（工具健康 17 · 自举流程 1 · 交付检查 4）；acceptance 用 `--json` 结构化断言且 **SKIP 必须在 `KNOWN_SKIPS` 登记**。

> 修掉一个真 bug（t-evidence 定位）：`self-check` 的 `evidenceProduced` 赋值在整轮循环**之后**，而读取在循环**之内** ⇒ 无论 make-evidence 成败都必然红。是"绿不了"而非"真红"。

### A08 · CI 等价性（P1）—— 已修
`tools/self-check.mjs` 新增 `--print-steps` 输出**真实执行清单**（JSON）；`tools/check-contract.mjs` 用**行级状态机**解析 yaml 的 `run:` 步骤（`stripYamlComment` 剔除注释、不误删字符串内 `#`），再与清单**比对数据**而不是 `scText.includes`。退出码检查改为**键集合完全相等 + 规格值写死 + 真起子进程断言 0/1/2/3**。
证据：注释掉 push ⇒ 该项不在清单里 ⇒ 判红；`INCOMPLETE` 改成 1 ⇒ 判红。五个变异负控全实证。

> 收敛一处**过度承诺**：README/USAGE 原称"自检与 CI 完全等价"，改为"覆盖单机命令链，**不等价于六环境矩阵**"。

### A09 · 证据解析完整性（P1）—— 已修
`lib/evidence.mjs`：三个解析器统一"**遇到歧义就抛错，绝不取第一个**"——
- `parseNodeTest`：收集**全部**汇总行，同字段取值不一致即抛错并给每处行号；五字段还须聚在同一连续块（首末行距 ≤30）；
- `parseDriftReport`：按三元组去重，不同组即歧义；
- `parseMutationReport`：要求报告**自证清单长度**（`MUTANT_TOTAL=`/`变异总数：`/`TOTAL=`），声明≠实测即抛错；缺声明 ⇒ `completeness:'unknown'`（**不是**默认 complete）。
`digest()` 改为**完整 64 位**，另设 `digestShort()`；provenance 字段名实相符。
ACCEPT-E2 增加完整性闸门：`unknown`/`incomplete` FAIL；`undeclared` + 有生产者痕迹 FAIL；`undeclared` + 纯手写三键不据此判 pass 但 detail 显式声明。

### A10 · 旧证据失效（P1）—— 已修
`tools/make-evidence.mjs`：跑任何生产者**之前**先隔离旧输出；原子写（`tmp-<pid>` + rename）；`runId`/`startedAt`/`finishedAt`；git 代码树身份（`rev-parse HEAD` + 工作树脏度摘要）；`--expected-mutants`；运行收据。
证据：run1 成功 → run2 让 producer 输出不可解析 ⇒ exit 1 且 `ev.json` **不存在**，旧证据无法冒充本次。

> 收据位置偏离原规格（写 `.evidence-raw/` 而非仓库根）：写根会被 `check-publish` 判「本机绝对路径」，实测确认。

### A11 · provenance 信任边界（P2）—— 已明确为产品政策
ICD §5.2 新增「信任边界」小节：**sdd-guard 把 acceptance 调用方视为可信**。它校验结构/自洽性/完整性，**不认证来源**。表格逐项列出"它做的"与"它不做的"（不签名、不认证身份、不防伪造），并写明理由：抵御恶意调用方属安全系统职责，扩成"未经定义的安全系统"会制造更大假安全感。`sha256` 名实相符问题已在 A09 修。

### A12 · make-diff 边界（P2）—— 已实证
`tools/make-diff.mjs` 改用 `-z` numstat 解析：**untracked 默认纳入**（可 `--no-untracked` 关）、**rename 归一成目标路径**（含 `pkg/{old=>new}` 中段折叠，产物不含 `=>`）、binary 标 `binaryCount`、`range`/`base`/`staged`/`untrackedIncluded` 精确标签。
`test/make-diff.test.mjs` **12/12**：真 git 临时仓库，覆盖 untracked 纳入/排除、rename、binary、staged、range、路径含空格、非 git 目录退 2。

### A13 · import 注释误判（P2）—— 已修
`lib/code.mjs` 新增 `stripComments`（保留字符串字面量、保留行号）；`importSpecifiers` 先剔除注释再抽说明符，并补 `.rs` 的 `use`/`extern crate`。
证据：块注释/行注释里的 import 均被排除；真实 import 仍抽出；`DECOUPLE-2` 真实引用 FAIL、注释引用不 FAIL。

### A14 · 参数分流（P2）—— 已修
`cli.mjs` 统一参数校验：未知选项（带拼写提示）、**缺值（含可重复选项的 `[true]` 形态）**、未知子命令/档位/规则 id ⇒ **exit 2**；`--min-coverage` 缺值不再被 `Number(true)=1` 静默；`--strict-args` 提供严格模式（登记为 DEGRADING 开关）。
`--json` 增加 `signal`/`coverageThreshold`/`coverageRatio`/`exitCode`/`strictArgs`/`warnings`，**决策在输出之前算出**。

> 修复过程中**探针抓到我自己的一个漏**：可重复选项 `--code` 缺值时 `parseArgs` 记的是 `[true]` 而非 `true`，只判 `=== true` 会漏掉，裸 `--code` 仍退 1。已加 `hasMissingValue()` 处理两种形态。

### A15 · npm 分发边界（P2）—— 已明确
`package.json` 加说明字段；`docs/USAGE.md` 新增「装到别的项目里」小节，明确 `tools/self-check.mjs` 与 `tools/check-contract.mjs` 是**仓库专用工具**（要读不进包的 `test/`、`changes/`、`.github/workflows/ci.yml`），在安装包里跑 exit 1 是**分发设计边界**而非缺依赖，并给出替代工作流。

### A16 · 文档漂移与效力层级（P2）—— 已修
- README：16→17 机器；acceptance 11→12；CI 小节改为六环境矩阵 + 等价性收窄；自检步骤表改为三类范围。
- USAGE：档位表补机器/人工拆分；契约 52→以脚本输出为准；`--skip-acceptance` 与"完全等价"表述修正；已知边界补 KISS-C1 词法级说明与 10 种后缀。
- CONTRIBUTING：8 步 → 全部步骤（含七套专项）。
- DESIGN-RATIONALE：契约 52→以输出为准、后缀 9→10；未验证项表按本轮实测更新（`codeScopes` 与行数预算已补构造验证，`requireZeroExit` 已补实测）。
- **效力层级（最深的矛盾）**：ICD 原自称"真源"而自举设计称"ICD 是投影"。现统一为**按可判定性切**：能机械判定的（选项表/默认值/退出码/规则条数）真源是 `lib/contract.mjs`；不能机械判定的（设计理由/语义边界/什么算已承诺）真源是 `docs/ICD.md`。一句话：**数字归代码，语义归文档**。

## 四、审计探针的翻转

旧审计探针（`_work/audit-lead.mjs` 等三份）锁的是**缺陷现状**——它们断言"这个假绿确实存在"。修复后它们理应失败，实测 `audit-lead.mjs` **exit 1**，正确。

新增 `_work/spec-probe.mjs` 锁**规格期望**，**38/38 成立**，覆盖 A01/A02/A03/A04/A05/A06/A09/A11/A13/A14，每条修复都配**正控**（合法输入仍 PASS）与**负控**（违规输入必须 FAIL）。

## 五、变异自证

`_work/mutation-selfproof.mjs` **4/4**。每条都验三件事：`node --check` 通过（语法有效）→ 因**目标判据的诊断理由**翻转 → 还原后复归。

| 变异 | 基线 | 变异后 | 结论 |
|---|---|---|---|
| M1 配置值域退回不校验 | exit 2（指明 maxNesting） | exit 0 | 配置校验真在起作用 |
| M2 drift 计数退回 `Number()` | 「必须是非负整数」 | 退化成「findings>checks」 | 计数域校验真在起作用 |
| M3 嵌套退回数所有花括号 | 0 处超限 | 大量「深度 N > 3」误红 | "对象不计层"真在起作用 |
| M4 import 提取退回不算注释 | 无跨边界引用 | 「1 处跨边界直接引用」假红 | 注释剔除真在起作用 |

> **方法论收获（写进 M2 的注释）**：只看退出码会把"判据按正确理由拒绝"与"判据因**另一条**守卫拒绝"混为一谈。M2 基线退 1、变异后仍退 1 —— 但**理由从"计数非负整数"变成了"findings>checks"**。所以变异自证必须断言**诊断理由**，不能只断言退出码。

## 六、本轮没有证明的内容（硬要求，逐条列出）

**第六节是这份报告最重要的部分。** 第一版这里写了 12 条，但**漏掉了最该写的那一条**（第 0 条）。

**0. 第一版的"22/22 可复现"是错的。** 它只在 `TMP` 指向项目内时成立；换成系统默认配置
就是 20/22。我把"我这一台、这一种配置下绿"写成了"可复现绿"。**该结论已撤回**，
下面所有数字都以**实际跑过的那两种配置**复跑为准（见上表，第三种未复跑）。这条教训写进项目笔记。

1. ~~**六环境矩阵未跑**~~ **→ 已跑通（第五版更新）**：CI run `43453136896` @ `0f5cb93`，
   `ubuntu-latest` / `windows-latest` × Node `20`/`22`/`24` **6/6 success**；提交 `f823a08` 复跑 run `43455372979` 仍 6/6。
   **它抓到了 3 个本机永远发现不了的缺陷**（见 §六附「六环境矩阵实际抓到什么」）——这就是"单机无法替代"的实证。
   仍不成立的部分：这条只证明**这两个 OS 家族 + 这三个 Node 大版本**，不含 macOS、不含 Node 21/23。
2. **崩溃/异常路径未覆盖**：六环境跑的是同一批用例，不覆盖"OS 级异常"（如 git 崩溃、磁盘满）。
   早前设想的"ubuntu 未跑"已不成立；仍成立的是：`scan-roots` 的不可读夹具在 **root 容器里 `chmod 000` 无效**时会 `t.skip`——
   六环境日志未单独核对这一条是否 skip（跳过 ≠ 通过，此处只说明未核对）。
3. ~~**真实 GitHub Actions 未跑**~~ **→ 已跑通**：见第 1 条，保留了 run id、提交 SHA 与六组结论。
   仍不成立：没有验证过 **workflow_dispatch 手动触发**与 **PR 触发**这两条路径。
4. **git 不可用路径未实证**：`make-evidence` 的 `tree:{available:false}` 分支只有代码。
5. **`node --test` 路径未走**：本机沙箱下撞 PIPE EPERM。
6. **真实业务仓库 / 非 JS 语言未跑**：Go/Rust/Java 只做了花括号近似。
7. **rename 的真实业务样本未取**：测试里的 rename 是临时仓库 `git mv` 造的。
8. **binary 判定与 git 口径可能漂移**：只用"含 NUL"判定。
9. **untracked 行数口径未与 git 对齐**：测试里显式关掉了 `core.autocrlf`。
10. **并发写入未测**：两个 `make-evidence` 同写一个 `--out`。
11. **变异"还原后全量复跑"未做**：每条变异都在用例内验证了还原，但没有在变异-还原后完整重跑一次自检。
12. **MANUAL 规则的语义正确性**：6 条本质不可机械判定。
13. **`lib/temp.mjs` 只在两种 Windows 配置下验过**：Linux/macOS 的 `chmod`/`mkdir` 语义未实测；
    它的候选列表里有 `homedir` 与盘根，在无家目录的容器里会走到抛错分支——**该分支未测**。
14. **`discipline-fixtures` 的夹具配置是放宽的**（`maxDiffLines:1000`、前缀只留 `lib/`）：
    它证明的是"判据会判"（合规 PASS / 越界 FAIL / 超预算 FAIL），**不证明项目真实配置下的预算合理性**。
15. **ACCEPT-E2 的 `signal='partial'` 只改了措辞与标记，未改判定语义**：
    手写证据（无生产者痕迹）仍然 `pass`。这是**已声明的产品政策**（信任调用方），
    但"信任调用方"是否应该是默认值，属于产品决策，**我没有替你决定**。

### ⚠ 本项如实未达（不算通过）

**C1 与 C3 的最新状态（本轮已处置，第五版更新）：**

**C1 —— 变更范围与预算**（数字来自 `real-diff-notice` 步当次输出）：

| 项 | 修前 | 现状 |
|---|---|---|
| 越界修改 | 12 个文件不在 `allowedPrefixes` 内 | **0 项** |
| 超预算 | 变更行数 > `maxDiffLines: 400` | **仍超（本次 7683 行）** |

越界的处置（按裁定「有边界地补齐必要根文件，不整目录放行」）：`allowedPrefixes` 逐项加入
`cli.mjs`、`package.json`、`README.md`、`CONTRIBUTING.md`、`AGENTS.md.template`、`.gitignore`、
`guard.config.json`、`evidence.config.json`、`.github/`。**没有加仓库根通配，也没有整体放行 `_work/`。**

审计工作目录按「先分类，再排除」处置：`spec-probe.mjs` 与 `mutation-selfproof.mjs` 迁入
`test/spec/` 并接进 `scripts.test` 与门禁（报告赖以成立的自证依据留在版本管理里）；
`audit-*.mjs` 与三路分报告迁入 `docs/audit/`（报告复现依据）；只剩 `_work/tmp/` 作临时产物被忽略。

**超预算仍未解决，且这不是「拆 commit」能自动解决的**——见下方结构冲突说明。

**C3 —— 文档↔代码绑定**：修前 29 项（2 声明未落地 + 27 变更未声明）→ **现为 PASS**：
声明 33 条路径全部落地、53 个变更文件名均可在文档中找到。
按裁定「逐文件说明修改目的、所属任务及验证方式」补齐了 `changes/self-host-guard/tasks.md`；
两条「声明未落地」经核实属于**历史范围**（`lib/speculative-markers.json` 由第 9 项建立、
参数测试文件由第 5 项建立，本轮均未改），已从本轮声明中分离为普通段落记录，**未制造任何无意义改动去凑对应关系**。

**★ 400 行预算与「按独立单元拆分」之间存在结构冲突（必须报告，未擅自处理）：**

拆分可行性已实测。把 53 个文件按修复单元分组后，**9 个单元仍超 400 行**，
其中 **4 个文件单文件就超预算**：

| 文件 | 变更行数 |
|---|---|
| `tools/self-check.mjs` | 823 |
| `lib/rules.mjs` | 633 |
| `lib/code.mjs` | 617 |
| `test/spec/spec-probe.mjs` | 489 |

**这里要精确说明证明了什么、没证明什么**（复核指出的措辞过强，已收窄）：

- **已证明**：按**完整文件**重新分组，14 组里仍有 9 组超 400 行；且上述 4 个文件**各自**的变更量已超 400。
  所以「按完整文件分组」这条路线在 400 行预算下不可行。
- **未证明**：**不能**说这四个文件「不可再分」。单文件的修改完全可以按逻辑与补丁拆成多个步骤 ——
  只是那需要**重建中间实现和验证步骤**（例如把 `nestingDepth` 的词法状态机拆成多个逐步可验证的提交），
  属于重做已完成的工作。

因此本项被批准的是**一次性例外**，理由是「继续满足 400 行的成本与收益不成比例」，
而不是「文件理论上不可再分」。前者是成本判断，后者是技术断言 —— 后者我没证明，不该那么写。

### 本项已按「预算例外已批准」关闭

**机器判定保持原样：`DISCIPLINE-C1` 仍是 FAIL，计数仍是当次的 7782 行。** 人工批准例外**不改写**机器结论。

| 绑定项 | 值 |
|---|---|
| 审计基线 | `311a54c4055e5543e305679b4df90b4f00decf68`（`docs/LOGIC-AUDIT-2026-11-13.md` 的基线） |
| 被豁免的修复范围 | `311a54c..ae8d032`（审计修复的最后一个提交；**登记提交本身不计入**，见下） |
| diff 摘要 | `git diff --numstat 311a54c..ae8d032` → 54 个文件，**`added + deleted` = 7782** |
| 计数口径 | `added + deleted` 的**总和**（`docs/ICD.md:269`），不是文件长度、也不是净增行数 |
| 当前阈值 | `maxDiffLines: 400` —— **未改动**，仍在 `lib/contract.mjs:95`（默认）与 `guard.config.json:27`（项目配置） |
| 批准方 | 用户（本项目所有者/复核方），2026-11-14 |
| 批准理由 | 见下方原文 |

**批准理由（原文）**：

> 本次 A01–A16 涉及跨模块判据、证据链、自检及专项测试修复。按现有完整文件分组后仍有多组超预算；
> 进一步满足 400 行限制需要重建中间实现和验证步骤。结合本次审查与验证证据，批准一次性行数预算例外。
> 保留 C1 超预算检测结果，不调整默认阈值，不扩大其他判据的豁免范围。

**豁免边界（逐条，防止外溢）**：

- **只豁免行数预算**。越界修改、C3 文档↔代码绑定、测试、契约漂移、六环境验证**全部不豁免** —— 这些项本轮都是真实通过的。
- **只绑定本次审计范围**（`311a54c..ae8d032`），**后续任何新增实现变更不自动继承本例外**，日常预算仍按 400 执行。
- **7782 不是永久固定值**。它绑定到上面那个 diff 范围与计数口径；换个基线或换次提交，必须重新测量。
- 例外登记写在本文档里，会产生一个登记提交。**登记提交只增加文档行数，不改变被豁免范围的终点**（终点固定为 `ae8d032`），否则「登记例外」这个动作本身会移动它要登记的数字 —— 那是个自指循环。

**关于 400 这个值本身（复核的追溯结论，照录）**：

400 在初始提交 `851cb69` 中即已存在，现同时位于默认配置（`lib/contract.mjs:95`）与项目配置
（`guard.config.json:27`）。**文档与历史里都没有解释为什么是 400 而不是 300 或 500 —— 没有可追溯的统计校准依据。**
因此它能作为「控制日常变更规模、提示审查负担」的硬门槛，但**不能独立证明「超过就是不合理」或「低于就是安全」**。
边界测试只证明工具准确执行了这个门槛，不证明门槛本身合理。这条限制照录，不粉饰。

**为什么它们不阻断自检**：C1/C3 在 `real-diff-notice` 通报步执行，不在 `acceptance` 门禁里。这是**有意的职责切分**（见 §零第 5 项），但代价是：**`self-check 28/28` 只代表"工具健康"，不代表"本次改动合规"。** 报告不能把两者混为一谈——第一版就是混了。

**另外修掉一个自污染**：`.selfcheck-diff.json` 是自检自己写出的中间产物，却被 `make-diff` 当成"未跟踪变更"纳入 diff ⇒ **C1 测的变更集里包含"测量工具刚写出来的文件"**，形成自我污染。已加入 `.gitignore`。同一类问题还发现 `diff.json`（早前手动实验残留）也被算成越界，已删除。

### 六环境矩阵实际抓到什么（这是它不可替代的实证）

第一轮六环境跑出 **6/6 全红**，三处缺陷**本机 100% 绿**、只有跨平台才暴露：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 	est/q2-value.test.mjs、	est/q2-crossrule.test.mjs | Linux/Node24 下 7 条全红 ENOENT | 
ew URL(...).pathname.replace(/^\//, '') —— 那个 
eplace 是为 Windows 前缀 `/F:/` 打的补丁，在 Linux 上把真正的绝对路径剥成相对路径 ⇒ cpSync 找不到夹具 |
| 	est/spec/spec-probe.mjs A11-1 | **六组全部** 1 条红 | 该断言直接读仓库根的 `evidence.json`，而该文件由 self-check 的 make-evidence 步产出；单独在 `scripts.test` 里跑时它不存在 |
| 注释里的 POSIX 路径 | check-publish 判敏感信息 | 修上面那两处时在注释里写了 CI 的真实绝对路径，被「本机绝对路径」判据命中 |

三处的修法都改成了**平台无关**的做法：用 `fileURLToPath` 而非 `pathname` 字符串裁剪；
让探针**当场产一份证据**再断言（不依赖外部前置产物）；注释里不写真实绝对路径。

**这三个缺陷的共同点：本机全绿。** 如果只看「本机 self-check 28/28」，它们会原样进仓库。
这正是裁定里「当前 Windows / Node 24 的两个 TMP 配置不能替代这六组」的直接证据。

## 七、证据索引

| 文件 | 内容 |
|---|---|
| `docs/LOGIC-AUDIT-2026-11-13.md` | 审计总报告（基线 `311a54c`） |
| `_work/audit-{rules,evidence,integration}.md` | 三路分报告 + 原始探针 |
| `_work/spec-probe.mjs` | **规格验收探针 38/38** |
| `_work/mutation-selfproof.mjs` | **变异自证 4/4** |
| `test/scan-roots.test.mjs` | A06 扫描收据 9/9 |
| `test/contract-guard.test.mjs` | A08 变异负控 6/6 |
| `test/make-diff.test.mjs` | A12 真实 git 仓库 12/12 |
| `.selfcheck/<pid>/` | 自检每步原始输出 |
