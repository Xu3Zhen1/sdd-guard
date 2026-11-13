# 使用说明书

> sdd-guard 是一个命令行检查器。你把一次变更写成四个 Markdown 文件，它按 23 条判据逐条检查，打印每条的状态，并用退出码告诉你结果。

本文只讲怎么用。判据为什么这么设计，见 [DESIGN-RATIONALE.md](./DESIGN-RATIONALE.md)；字段与数据契约，见 [ICD.md](./ICD.md)。

---

## 1. 它检查什么

**输入**：一个 change 目录（四个 Markdown 文件）+ 你要它检查的代码目录。

**输出**：23 条判据各自的状态，分四种：

| 状态 | 含义 | 算通过吗 |
|---|---|---|
| `PASS` | 机器执行了，判定合格 | 是 |
| `FAIL` | 机器执行了，判定不合格 | 否，退出码 1 |
| `SKIP` | 输入不足，**没有执行** | **否**，但不影响退出码 |
| `MANUAL` | 不能机器判定，需人工签字 | **否**，但不影响退出码（`--strict` 下影响） |

报告末尾一定打印一行「机器实际执行 N/M 条机器规则」。**`SKIP` 与 `MANUAL` 都不计入通过**，所以看报告不能只看「失败 0」。

---

## 2. 目录结构与最小跑通

change 目录的形状（缺文件不报错，对应判据转 SKIP）：

```
changes/<变更名>/
  proposal.md          # 提案：问题、范围、非目标、验收标准
  specs/<模块>/spec.md # 规格：Requirement + Scenario(GIVEN/WHEN/THEN)
  design.md            # 设计：依赖登记、复用清单、接口契约
  tasks.md             # 任务：引用哪些文件、怎么拆
```

在仓库根建好这四个文件后，跑开发流程档：

```bash
node cli.mjs check --change changes/<变更名> --profile process --repo . --config guard.config.json
```

`--repo` 是路径基准：design/tasks 里写的相对路径都相对它解析。

模板在 `templates/`：`proposal.md`、`specs/spec.md`、`design.md`、`tasks.md`，复制改即可。

---

## 3. 两个档位

| 档位 | 包含哪些判据 | 什么时候跑 | 必须给的额外输入 |
|---|---|---|---|
| `process` | 11 条 = 7 机器 + 4 人工（proposal / specs / design / tasks 阶段） | 写作过程中反复跑 | 无 |
| `acceptance` | 12 条 = 10 机器 + 2 人工（代码阶段 + 证据判据） | 交付前跑一次 | `--evidence <file>` |
| `all` | 全部 23 条 = 17 机器 + 6 人工 | 不带 `--profile` 时的默认值 | 同 acceptance |

`acceptance` 档缺 `--evidence` 会直接退出码 2 —— 它不接受「没证据就算合格」。

---

## 4. 代码阶段需要 diff

`DISCIPLINE-C1`（越界修改 / 行数预算）和 `DISCIPLINE-C3`（文档↔代码绑定）**必须有 diff 数据**，否则是 `SKIP`。

```bash
node tools/make-diff.mjs --repo . --out diff.json
node cli.mjs check --change changes/<变更名> --profile acceptance \
  --evidence evidence.json --diff diff.json --repo . --config guard.config.json --code src
```

`make-diff` 的四种取法：

```bash
node tools/make-diff.mjs --repo . --out diff.json              # 工作树 vs HEAD
node tools/make-diff.mjs --repo . --base origin/main --out diff.json
node tools/make-diff.mjs --repo . --staged --out diff.json
node tools/make-diff.mjs --repo . --range HEAD~3..HEAD --out diff.json
```

输出格式：`{ "files": [{ "path": "lib/x.mjs", "added": 10, "deleted": 2 }], "total": 12 }`。

> **要求 git ≥ 2.31**：`make-diff` 用 `git diff --output=<file>` 把结果写文件而不是捕获 stdout（捕获 stdout 在受限沙箱里会 EPERM）。更老的 git 不支持该选项。

---

## 5. 验收证据从哪来

`acceptance` 档读三个键，缺任一 ⇒ 退出码 2：

| 键 | 判据 | 要求 |
|---|---|---|
| `tests` | ACCEPT-E1 | `failed=0` 且 `passed>0`（`passed=0` 判 FAIL —— 空样本与「没跑」同形） |
| `mutation` | ACCEPT-E2 | 杀死率 ≥ `minMutationRatio`（默认 0.8） |
| `drift` | ACCEPT-E3 | 漂移数 0 |

不用手写。`tools/make-evidence.mjs` 会调**你自己项目的命令**、解析输出、附 provenance：

```bash
node tools/make-evidence.mjs --out evidence.json
```

它读同目录的 `evidence.config.json`：

```json
{
  "tests":    { "command": "node test/guard.test.mjs" },
  "mutation": { "command": "node test/mutation.mjs" },
  "drift":    { "command": "node tools/check-contract.mjs" },
  "keepOutputs": false
}

```

三条纪律（这是它存在的理由）：

1. 任何一步失败 ⇒ 退出码 1，且**不把该证据写进结果**（不写 0 冒充「跑了但零」）；
2. 输出必须能被解析器验过 —— 找不到汇总行、或 `pass+fail>tests` 这种自相矛盾，一律抛错；
3. 每条证据带 `provenance`（命令 / 退出码 / cwd / 输出 sha256），可审计这份成绩单是谁出的。

每条证据都记 `command` 与 `exitCode`，所以「跑的命令是什么」和「它自己退出几」都留痕。

---

## 6. 配置怎么填

`--config guard.config.json` 可选；缺省值如下。**只写你要改的键**。

| 键 | 缺省 | 作用于 |
|---|---|---|
| `maxNesting` | `3` | KISS-C1 嵌套层数上限 |
| `dupWindow` | `6` | DRY-C1 连续重复行窗口 |
| `dupMinChars` | `40` | DRY-C1 参与比较的行最短长度 |
| `yagniMinNonGoals` | `3` | YAGNI-P1 非目标最少条数 |
| `dryMinReuse` | `1` | DRY-D1 复用清单最少路径数 |
| `dependencies` | `{}` | KISS-D1 依赖登记表 |
| `allowedPrefixes` | `[]` | DISCIPLINE-C1 允许改动的路径前缀 |
| `maxDiffLines` | **（无默认；不写 = 未启用）** | DISCIPLINE-C1 行数预算；`0` = 零行预算（禁止任何变更），与「未启用」不同 |
| `boundaries` | `{}` | DECOUPLE-2 边界前缀表 |
| `forbidImports` | `[]` | DECOUPLE-2 禁止的跨边界引用 |
| `contractPrefixes` | `[]` | DECOUPLE-1 契约文件必须落的目录前缀 |
| `minMutationRatio` | `0.8` | ACCEPT-E2 杀死率下限 |
| `equivalentMutants` | `[]` | ACCEPT-E2 从分母扣除的等价变异，**每条必须带 reason** |
| `codeScopes` | `[]` | DISCIPLINE-C3 反向检查范围；空数组 = 全查 |

两个需要特别注意的：

- `allowedPrefixes` 缺省是空数组。`DISCIPLINE-C1` 用它判「越界」，空数组下无越界可判；要用这条就显式列前缀。
- `equivalentMutants` 里每项必须是 `{ id, reason }` 且 `reason` 是非空字符串。**没有 reason 的条目判 FAIL** —— 防止随手豁免。

---

## 7. 看报告

文本格式：

```
[KISS · code]
  PASS    KISS-C1  嵌套深度不得超过 3 层
          → 2092 → 2081
[DRY · code]
  FAIL    DRY-C1  跨文件连续 6 行规范化重复
          → 53 块超过上限
            · lib/a.js ↔ lib/b.js 连续 7 行
```

`--json` 输出机器可读版：`{ repo, profile, results[], summary }`。**代码里请读这个**，不要去正则解析文本。

---

## 8. 退出码

| 码 | 含义 |
|---|---|
| `0` | 全过 |
| `1` | 判据判定不合格（对被测对象的结论） |
| `2` | 输入/配置错误（参数缺值、目录不存在、证据不全、未知 id…） |
| `3` | 判据自身不可信，或没跑完（覆盖率不足） |

`1` 与 `3` 的区别是**对谁下结论**：`1` 说你写得不合格；`3` 说这次结论本身不可用。

**CI 里请写 `if [ $? -ne 0 ]`**，不要写 `-eq 1` —— 否则会漏掉 `3`。

---

## 9. 接 CI

两件事必须做：

```bash
# ① 一键自检（按三类范围声明：工具健康 / 自举流程 / 交付检查；
#    含基础测试 + 七套专项 + 变异 + 契约漂移 + 发布前置 + 覆盖率守卫负控
#    + 生成证据 + 证据链 + 验收档）
node tools/self-check.mjs

# ② 或者分开跑，并加上覆盖率下限
node cli.mjs check --change changes/<名> --profile process --repo . --min-coverage 0.8
```

> **别把"自检绿"读成"CI 绿"**（2026-11-13 审计 A08）：`self-check` 覆盖的是 CI 里那条**单机命令链**，并由 `check-contract` 结构化断言两者同步；但 CI 还跑 **ubuntu × windows × Node 20/22/24 六环境矩阵**，那些差异只有 CI 真跑才知道。旧文案「与 CI 完全等价」是过度承诺，已改。

**`--min-coverage` 为什么建议加**：不加时，一个什么都没写的 change 目录会得到「通过 1 · 失败 0 · 跳过 16」而退出码 0 —— 「什么都没做」与「全部通过」不可区分。

`--skip-acceptance` 可以跳过自检里的验收步骤，但此时退出码是 **3**（不是 0），因为它不构成一次完整验收。

---

## 10. 其他命令

| 命令 | 用途 |
|---|---|
| `node cli.mjs --help` | 打印全部参数（由 `lib/contract.mjs` 生成，不会与实现漂移） |
| `node cli.mjs check --only <ids>` | 只跑指定判据，逗号分隔；含未知 id ⇒ 退出码 2 |
| `--strict` | `MANUAL` 也算失败 |
| `node tools/check-contract.mjs` | 校验文档与实现是否漂移（当前 65 项检查，数字以脚本输出为准） |
| `node tools/check-publish.mjs` | 发布前检查（脱敏等） |

`--only` 的已知 id 用 `--help` 或看 `lib/rules.mjs` 的 `RULES`。写错 id 不会静默变成「跑了 0 条 ⇒ 全过」，而是退出码 2。

### 装到别的项目里（分发边界，A15）

```bash
npx sdd-guard check --change changes/<名> --profile process --repo .
```

**包内可用**：`cli.mjs` + `lib/` + `templates/` + 默认配置 + 文档。
**包内不可用（有意如此）**：`tools/self-check.mjs` 与 `tools/check-contract.mjs`。它们是**仓库专用工具**——

| 工具 | 为什么装进包里也跑不起来 |
|---|---|
| `tools/self-check.mjs` | 要跑 `test/*.mjs`、要读 `changes/self-host-guard/`，这些不进包 |
| `tools/check-contract.mjs` | 要解析 `.github/workflows/ci.yml` 与 `docs/ICD.md`，这些也不进包 |

这两者在**安装包里**跑会 exit 1，那是**分发设计边界**，不是"缺依赖"。要自举检查 sdd-guard 自己，请克隆仓库而不是 `npm install`。

**接进自己的 CI 时**，把它们换成你自己的测试/变异命令，喂给 `make-evidence`（见 §5）——sdd-guard 本来就要求证据由**你的**流程产出。

---

## 11. 已知边界

这些是实际限制，不是免责声明：

- **无 AST**。`DRY-C1` 是行级窗口比较，改变量名可绕过；`KISS-C1` 是花括号/缩进启发式。
- **`DECOUPLE-2` 不展开 tsconfig 路径别名**，`@shared/*` 靠 `boundaries` 前缀匹配。
- **6 条 `MANUAL` 永远不在机器判定内**，需要人工；`--strict` 只能让它们变红，不能替人签字。
- **`DISCIPLINE-C3` 的反向检查是名称匹配**：文档全文任意一处出现文件名即算「提过」，不判断上下文。所以「文档写了不修改它但实际改了」不会被发现。
- **无豁免机制**（`equivalentMutants` 是唯一的显式豁免，且强制带 reason）、**无基线棘轮**（基线数字要自己抄进 proposal）、**无增量扫描缓存**。
- **`codeScopes` 缺省全查**。升级到本版本后首次运行，如果突然多出「改了但文档没提」，那是原先被跳过的范围现在被检查了，不是新 bug。
- 实测环境：Windows + Node 24（CI 另跑 ubuntu × windows × Node 20/22/24 六环境矩阵）。其他语言仓库未验证，只按 10 种后缀识别代码文件。
- **`KISS-C1` 的嵌套是词法级启发式**：它现在**左右括号严格配对**（对象右括号不会再扣控制流层数）、**每行取该行内最大控制深度**（单行紧凑写法不再漏计）、并维护块注释/字符串/模板串/正则的词法状态。但它不是 AST —— 非 JS 语言只有 Python 走缩进口径，其余按花括号近似；`switch` 的 `case` 不计层。**函数体算一层**（这是既有负控锁定的语义，不是新选的）。

---

## 12. 常见红 → 怎么修

| 判据 | 常见原因 | 修法 |
|---|---|---|
| `YAGNI-P1` | proposal 没有非目标表，或行数 < `yagniMinNonGoals`，或某行没写理由 | 补表；理由写具体（"暂不需要"不算） |
| `KISS-S1` | Requirement 没有 Scenario，或缺 GIVEN/WHEN/THEN | 每条 Requirement 至少配一个完整 Scenario |
| `KISS-S2` | 一个 Scenario 写了多条 THEN | 拆成多个 Scenario |
| `DRY-D1` | 复用清单里的路径不存在 | 路径写相对 `--repo` 的真实路径；纯手写容易拼错 |
| `DRY-T1` | tasks 里引用的路径不存在且没标「新建」 | 标「新建/新增」或改正路径 |
| `DECOUPLE-1` | design 没有「接口契约」小节，或契约路径不在 `contractPrefixes` 内 | 补小节；路径落到配置的契约目录 |
| `KISS-C1` | 嵌套超过 `maxNesting` | 提前 return / 抽函数 |
| `DRY-C1` | 跨文件连续 `dupWindow` 行重复 | 抽公共模块 |
| `YAGNI-C1` | 代码里有「预留 / 将来 / 暂未使用」类标记 | 删掉，需要时再加 |
| `DISCIPLINE-C1` | 改动越出 `allowedPrefixes`，或行数超 `maxDiffLines` | 收窄改动，或调预算并说明 |
| `DISCIPLINE-C2` | 仓库根有一级目录匹配 `pip-*`、`tmp`+随机串、`cdp-profile-*`、`diag-`+随机串 | 移入已被忽略的目录，或加进 `.gitignore` 后删除 |
| `DISCIPLINE-C3` | 改了代码但文档没提；或声明要改但没改 | 两边对齐；没 diff 时它是 SKIP，先跑 `make-diff` |
| `ACCEPT-E1/E2/E3` | 证据不合格，或证据缺失 | 看 `reason` 逐条修；空集一律 FAIL |

**最常踩的一个坑**：`--code` 不要包含 `test/`。负控夹具里天然写着违规字样（重复块、投机标记），扫进去全是假阳性。

---

## 13. 一次完整流程

```bash
# 1) 建 change 与四个制品（从 templates/ 复制）
mkdir -p changes/my-change/specs/export

# 2) 写作阶段：反复跑，把 FAIL 一条条清掉
node cli.mjs check --change changes/my-change --profile process --repo . --config guard.config.json

# 3) 写代码

# 4) 交付前：生成 diff 与证据
node tools/make-diff.mjs --repo . --out diff.json
node tools/make-evidence.mjs --out evidence.json

# 5) 验收档
node cli.mjs check --change changes/my-change --profile acceptance \
  --evidence evidence.json --diff diff.json --repo . --config guard.config.json \
  --code lib --code tools

# 6) 一键自检（等价 CI 跑的东西；全部通过时退出码 0）
node tools/self-check.mjs
```

注意第 6 步与第 5 步的区别：第 5 步检查**你的**变更，第 6 步检查 **sdd-guard 这个项目自己**。
