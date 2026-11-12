# Q1 启发式后门探测报告

- 项目：sdd-guard（子项目身份 `sdd-guard`，工作区 `F:\DSH\AIcode`）
- 任务来源：评审包 `F:\DSH\AIcode\_diag\sdd-guard-评审包-20261112.md` §4 模式 C / §5 Q1
- 探针脚本：`test/q1-backdoor.test.mjs`（17 用例，`node test\q1-backdoor.test.mjs` → 17 passed / 0 fail）
- 夹具：`test/fixtures/q1-base/`（7 个文件，全部为构造的假项目，不落在 `F:\DSH\AIcode` 根）
- 被测对象：`lib/rules.mjs` 中 `DISCIPLINE-C3` 及其三个辅助函数 `looksLikePath` / `splitCommandPaths` / `toBlocks`
- 本轮**未修改** `lib/`、其他测试、README、AGENTS.md；未 commit / push。`git status` 仅 3 项新增：`_work/`、`test/fixtures/q1-base/`、`test/q1-backdoor.test.mjs`。

## 判定口径

| 结论 | 含义 |
| :-- | :-- |
| **LEAK** | 绕过手法生效：同一违规，带绕过的输入 PASS，去掉绕过手法后 FAIL。两个方向都实测到才算。 |
| **HOLD** | 构造了输入但启发式未被攻破（规则仍 FAIL 或无视该绕过）。 |
| **未执行** | 没能构造出绕过输入，或正控没变红 ⇒ **根本没触达目标判据**。不计入 HOLD。 |

每条探针都强制走三步：① 正控（去掉绕过）必须 FAIL **且失败原因指向被声明的路径**；② 实验组状态必须等于写死的 PIN（不引用被测常量）；③ 由 ①② 推出的 verdict 必须等于用例声明的 verdict。缺任一步即红。

## 六行结论表

| # | 启发式 | 注入输入摘要 | 期望 | 实际状态 | 结论 | 命中分支证据 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | `NOT_CHANGING` | 「修改 `src/util/text.js` 的归一化（日志格式**不适用**本次封装）」；diff 只改 `handler.js` | FAIL | **PASS** | **LEAK** | `lib/rules.mjs:964` `if (NOT_CHANGING.test(block)) continue;` —— 整块包含匹配，无修饰范围判断。detail 自报「声明 **1** 条路径全部落地」，text.js 从未进入 declared。正控（删掉「不适用」）→ FAIL「声明了但没改: src/util/text.js」。**同族第二例**：「（函数签名**不需要修改**，只加导出）」同样 LEAK。 |
| 2 | `RECON_HEAD` | 「**确认** `src/util/text.js` 需要改动」——文件真实存在，diff 里没有它 | FAIL | **PASS** | **LEAK** | `lib/rules.mjs:877` 句首动词命中 ⇒ 路径进 `reconRefs`（只查存在性，`lib/rules.mjs:1000` 的 phantom 只拦"不存在"）。同一句话把「确认」换成「修改」立刻 FAIL ⇒ **判定被一个可自由选择的动词开关**。 |
| 3 | `looksLikePath` | (a)「执行 `node tools/build.mjs src/export/ghost--probe.js`」，文件**不存在**；(b)「修改 `src/export/extless/index`」（真实存在、无扩展名），diff 里没有 | FAIL | **PASS / PASS** | **LEAK ×2**，另 1 条子分支**未执行** | (a) `lib/rules.mjs:89` `if (v.includes("--")) return false;` ⇒ 整串不算路径；`splitCommandPaths` 逐 token 再判，该 token 仍含 `--` ⇒ 也 false ⇒ **三条通道全哑**，且 `items=[]` 连"未校验提示"都不出。(b) `lib/rules.mjs:92` `/\.[A-Za-z0-9]{1,6}$/` 要求扩展名，`extractPaths`(`:141`) 同样要求 ⇒ 该文件既不可被声明、也不进 skipped 提示。(c) **未执行**：第 91 行「首词无 / 无 . 判为命令名」确实返回 false，但 `splitCommandPaths` 立刻把子路径捞回，端到端仍 FAIL ⇒ 未构造出绕过，记 UNEXECUTED。 |
| 4 | `splitCommandPaths` | 「执行 `node tools/build.mjs "src/export/ghost probe.js"`」——文件**不存在**且含空格 | FAIL | **PASS** | **LEAK** | `lib/rules.mjs:108` `v.split(/\s+/)` 无引号感知 ⇒ 被拆成 `src/export/ghost` 与 `probe.js` 两个残片，两片都不满足 `looksLikePath`（一片无扩展名、一片无斜杠）⇒ `items=[]`。正控仅把空格换成连字符（`ghost-probe.js`）→ FAIL「取证项引用了 1 个不存在的路径」。**一个空格之差**。 |
| 5 | `toBlocks` | (a) 列表项写 `handler.js`，**Tab** 缩进的续行写「同时需要改 `src/util/text.js`」；(b) 主项写 `text.js`，两空格续行写「（接口签名**不适用**本次改动）」 | FAIL | **PASS / PASS** | **LEAK ×2** | `lib/rules.mjs:896` `/^\s{2,}\S/` 只认 ≥2 个空格，制表符算 1 个字符 ⇒ 续行既不入块、又因不是列表项而**整行丢弃**（`:902-905` 结算后置空）。(b) 是 P1×P5 **组合放大**：续行并入同块后，`NOT_CHANGING` 的整块匹配（`:964`）命中续行里的「不适用」⇒ 父项的真修改一并被 continue。正控：同句改成两空格缩进 → FAIL。 |
| 6 | `codeScopes` 反向检查 | diff 凭空多出 `tools/ghost.mjs`，文档只字未提；配置留空以验证**默认值** | FAIL | **PASS** | **LEAK** | `lib/rules.mjs:1080` `const scopes = ... : ["lib/", "src/", "app/", "packages/"]` ⇒ `inScope` 对 `tools/` `tests/` `scripts/` `bin/` `docs/` 一律 false ⇒ `unexplained` 被过滤，反向检查形同虚设。正控：同一份文档、同样未提及，改成 `src/ghost.mjs` → FAIL「改了但文档没提」。 |

## 汇总

**探针维度**：10 条探针 —— **LEAK 9 · HOLD 0 · 未执行 1**。

**启发式维度**：6 条中 **6 条 LEAK**、0 条 HOLD、0 条整条未覆盖；其中 `looksLikePath` 有 1 个子分支（首词判定）**未能构造出绕过，显式记为未执行**。

即：评审包 §5 Q1 点名的 6 个启发式，**没有一个被证伪**——全部可以吞掉真问题并给出肯定句式的 PASS。

## 根因归类（对应评审包 §4）

- 6 条全部归入 **模式 C「为消误报而扩大跳过面」**：每一条的动机都是"别误报"，代价都是"真问题静默消失"。
- 其中 P1 / P2 / P5-b 有一个共同形态可直接命名：**豁免是"块级包含匹配"，而豁免词的语义往往只覆盖子句**。判定粒度（block）与豁免语义粒度（clause）不一致，就是后门的产生位置。
- P3-a / P4 是同一形态的**双通道**：一个"别把命令行误报成路径"的意图，加上一个"命令要拆子路径"的补丁，两者组合后**中途的 token 谁都不管**。
- P6 是模式 C 的静态版本：跳过面不由输入决定，而由**默认白名单**决定，因此对任何把代码放在 `tools/`、`scripts/`、`bin/` 的项目**系统性失效**——这与历史上"Unicode 路径整条脱离管辖"同族。

## 修复建议（仅建议，本轮未改 `lib/`）

### R1 · `NOT_CHANGING`（`lib/rules.mjs:861` · `DISCIPLINE-C3`）
把**块级包含匹配**改为**子句级、且必须修饰目标本身**：先把 block 按句读（`。`、`；`、`，`、`（`）切成子句，只在"豁免词与路径处于同一子句、且该子句不含主张动词（修改/增加/实现/重写）"时才排除该路径；否则保留。
更稳的做法是**取消整块 continue**：让豁免只影响"是否要求被改"，而不是"是否计入声明"——被豁免的路径一律降级进 `reconRefs`（走存在性校验），这样最坏情况只是少报"未落地"，不会连路径都消失。

### R2 · `RECON_HEAD`（`lib/rules.mjs:876` · `DISCIPLINE-C3`）
取证项不能靠一个可自由选择的动词来豁免。建议改成**双条件**：句首是取证动词 **且** 该块内不含"要改"表述（`需要改动` / `改为` / `替换为` / `新增` 等）才算取证。当前实现里 `确认 X 需要改动` 这种自相矛盾的句子应当判定为"声明要改"而不是"取证"。
更彻底：让句首动词**只影响提示文案**，不参与"是否要求被改"的决定；取证项与修改项走同一判据，靠 `tasks.md` 之外的 `design.md` 复用清单去表达"我看过了但不动它"。

### R3-a · `looksLikePath` 的 `--` 判定（`lib/rules.mjs:89`）
`v.includes("--")` 过宽。应只在**把该串当作整条命令**时用它，且判据改成"以 `--` 开头的 token 或孤立 `--`"，而不是"串里出现过两个连续连字符"。最小改法：把 `:89` 从 `looksLikePath` 里删掉，改由 `splitCommandPaths` 在**去掉 `--flag` token 之后**再逐 token 判定——这样 `handler--v2.js` 这类合法文件名不再被吞，而 `--x` 仍被跳过。

### R3-b · `looksLikePath` / `extractPaths` 的扩展名要求（`lib/rules.mjs:92`、`:141`）
"必须带扩展名"会把无扩展名文件整条排除，且**不进 skipped 提示**，属于静默。建议：对反引号内容，只要"含 `/` 且首段不是 `--` 开头"，就作为**候选路径**收进 `skipped` 提示（"这几条我没校验"），至少让它可见；能否判为声明，交给"文件是否存在"来定，而不是靠扩展名。

### R4 · `splitCommandPaths` 的空白切分（`lib/rules.mjs:108`）
按空白切分前先做**引号感知 token 化**（支持 `"..."` 与 `'...'`），并对未闭合引号显式报错（与本文件已有的"反引号奇数必须 fail"同款处理）。另建议：切分后若某个 token 以 `/` 结尾（被截断的路径前缀），把它标进 `skipped` 而不是静默丢弃。

### R5 · `toBlocks` 的续行判定（`lib/rules.mjs:891-909`）
两处建议：① 续行判据改为 `/^[\t ]+\S/`（制表符与空格等价），且**未识别为续行的非列表项不得静默丢弃**——应作为"孤立文本块"参与后续扫描或至少进 `skipped`；② 若坚持 block 粒度，则 `NOT_CHANGING` 的匹配必须先按子句切分（见 R1），否则 B 类的续行豁免会继续污染 A 类的主项。

### R6 · `codeScopes` 默认白名单（`lib/rules.mjs:1080`）
`["lib/","src/","app/","packages/"]` 作为**默认**等于替用户决定"哪些目录不算源码"。建议反转默认：**默认全查**（`scopes` 为空 ⇒ `inScope` 恒 true，代码里已有这条分支），把白名单变成显式配置项；若担心噪音，可对白名单外目录降级为**提示**而不是静默过滤——但提示必须出现在 `items` 里，且 pass 文案必须写清"N 个变更文件中有 M 个未参与反向检查"。

## 探针自身的负控（防止"探针假绿"）

P1..P6 全绿只证明"实现行为如 PIN 所述"，不证明这套判定有判别力。因此脚本内另有 5 条 META 用例直接对判定纯函数 `classify` 喂伪造结果：

- META-1：正控没变红（status=pass）⇒ 必须抛错；
- META-2：正控红了但原因不指向目标路径 ⇒ 必须抛错；
- META-3：实测行为与 PIN 不符 ⇒ 必须抛错；
- META-4：实测行为与声明的 verdict 不符 ⇒ 必须抛错；
- META-5：合法输入必须返回 LEAK，且换一组输入返回 HOLD ⇒ 证明 `classify` 不是恒抛，否则上面 4 条恒真。

## 未覆盖 / 已知限制

1. **`looksLikePath` 第 91 行（首词判命令名）标记为未执行**：单独看它确实返回 false，但 `splitCommandPaths` 会兜住子路径，端到端仍 FAIL。要构造出该行的独立后门，需要同时让 `splitCommandPaths` 失效——目前可见的联合条件已由 P3-a（含 `--`）与 P4（含空格）覆盖，第 91 行本身**没有独立可复现的绕过**。
2. **只测了 `DISCIPLINE-C3`**：6 个启发式中，`NOT_CHANGING` / `RECON_HEAD` / `toBlocks` / `codeScopes` 仅被 C3 使用；`looksLikePath` 与 `splitCommandPaths` 还被 `extractPaths` 相关规则（`DRY-D1` / `DRY-T1` / `DECOUPLE-1`）间接使用，这些规则上的同族影响**本轮未探**。
3. **未做变异验证**：本轮探针验证的是"实现行为如 PIN 所述"，未把绕过手法做成变异体去检验"如果 lib/ 修好了，探针会不会变红"。按项目纪律（变异负控必须自证），修复落地后应补一轮。
4. **`codeScopes` 只测了默认值**：显式配置 `codeScopes` 时是否还有别的漏查路径，未测。
5. **报告中的行号取自本轮 commit `65dbe2f` 的 `lib/rules.mjs`**，lib/ 变更后需重新核对。

## 回归

| 命令 | 结果 |
| :-- | :-- |
| `node test\guard.test.mjs` | **76 passed / 0 fail**（与本轮开工前一致，未变） |
| `node test\args.test.mjs` | 12 passed / 0 fail |
| `node test\evidence.test.mjs` | 18 passed / 0 fail |
| `node test\q1-backdoor.test.mjs` | **17 passed / 0 fail**（新增） |
