# 使用说明书

> 面向"要拿它去改真实代码"的人。**前 10 分钟读第 1–3 节就能开始跑**；其余按需查。
> 设计取舍与内部结构见 [README.md](../README.md) 与 [ICD.md](./ICD.md)；判据依据见 [DESIGN-RATIONALE.md](./DESIGN-RATIONALE.md)。

## 1. 它是什么 / 不是什么

**是**：一个**判据执行器**。你把"这次变更"写成四个制品（proposal / specs / design / tasks），它检查这些制品与对应代码是否满足 23 条判据（17 条机器判定、6 条必须人工签字），并打印**机器实际执行了几条**。

**不是**：

| 常见误解 | 事实 |
|---|---|
| "全仓库扫描器" | 只检查**你指向的 change 目录 + 代码根**。存量债务不扫，除非你把它指出来 |
| "代码质量门禁" | 它不评判代码好坏，只判定**可机械化的硬约束**（嵌套层数、跨文件重复、投机标记、越界改动、临时产物、跨边界 import…） |
| "能替代测试" | 相反：验收档**只读**你自己产出的测试/变异/漂移证据，自己不跑测试 |
| "AI 自动修代码" | 不修。它只给出**红/绿 + 原因 + 定位行** |

**一句话**：它把"说好的事"变成"会红的判据"。判断对不对仍需人；它负责让"没做到"无法被说成"做到了"。

## 2. 10 分钟最小可用路径（先跑起来）

```bash
# 1) 建一个 change
mkdir -p changes/first-cut
# 写 proposal.md（含非目标表）、specs/x/spec.md、design.md、tasks.md
# 模板：templates/proposal.md / templates/specs/spec.md / templates/design.md / templates/tasks.md

# 2) 写作阶段反复跑（四制品形态）
node cli.mjs check --change changes/first-cut --profile process --repo . --config guard.config.json

# 3) 交付前：先产出外部证据，再跑验收档
node tools/make-evidence.mjs --out evidence.json
node cli.mjs check --change changes/first-cut --profile acceptance --evidence evidence.json \
  --repo . --config guard.config.json --code src

# 4) 一键自检（8 步：含变异与契约漂移，等价于 CI 跑的东西）
node tools/self-check.mjs
```

不带 `--profile` 时等价 `--profile all`（两档一起跑）。

> 当作 CLI 用：`node <仓库>/cli.mjs …`；装了全局包则是 `sdd-guard check …`。
> 零依赖，不需要 `npm install`。

## 3. 拿它重构一个积重难返的插件：推荐路线

存量项目不能"一次全绿"，硬来只会让人关掉工具。**切片 + 棘轮**是唯一可持续的做法。

### 第 0 步：量基线（不改代码，只拿数字）

```bash
# 先把存量债务量出来，作为"不许变多"的对照
node cli.mjs check --change changes/_baseline --profile acceptance \
  --repo <插件目录> --config <插件>/guard.config.json \
  --code <插件目录>/src --only KISS-C1,DRY-C1,YAGNI-C1
```

记下三个数：`KISS-C1 违例 N 处`、`DRY-C1 重复块 N 处`、`YAGNI-C1 标记 N 处`。
**把这三个数字抄进 proposal.md 的「现状」一节**——它们是本次重构的起点，也是后面判断"有没有变多"的唯一标准。

> `changes/_baseline` 可以是个空目录，代码级判据不依赖制品；但 `--profile acceptance` 要求 `--evidence`，可先用 `node tools/make-evidence.mjs` 生成一份。

### 第 1 步：切出一个小 change，先写"不做什么"

```bash
mkdir -p changes/refactor-core
```

`proposal.md` 至少包含**非目标**表（≥3 行，每行带理由）。重构项目的非目标尤其重要：

```markdown
## 非目标

| 不做的事 | 为什么不做 |
| :-- | :-- |
| 不改公共 API 签名 | 这次只动内部结构，改签名会牵连 3 个调用方，留给下一刀 |
| 不迁移持久化格式 | 迁移需要双写与回滚方案，本次不承担该风险 |
| 不动 UI 层 | UI 与本次目标无关，混进来会让 diff 无法审查 |
```

这三条不是形式主义——`YAGNI-P1` 会检查它们存在且带理由，而**它们恰好是你给自己划的重构边界**。

### 第 2 步：specs 写"重构后必须仍然成立的行为"

重构的规格不是"新功能"，而是**不变量**：

```markdown
### Requirement: 解析器输出结构不变

#### Scenario: 合法输入

- GIVEN 一份含 3 个节点的配置文件
- WHEN 调用 parse()
- THEN 返回节点数与输入一致
- AND 每个节点的 id 保持原顺序
```

`KISS-S1` 要求每条 Requirement 至少一个 Scenario 且 GIVEN/WHEN/THEN 齐全；`KISS-S2` 禁止一个 Scenario 多个 THEN（一个场景只验一个行为）。

### 第 3 步：design 写"复用清单"与"接口契约"

- **复用清单**：`DRY-D1` 要求路径**真实存在**。重构时这条最有价值——它逼你承认"这段逻辑已经有现成实现"，而不是又抄一遍。
- **接口契约**（跨前后端时）：`DECOUPLE-1` 要求契约路径存在且落在 `contractPrefixes`（默认 `shared/`）。
- **新增依赖**：`KISS-D1` 要求每行写"标准库为什么不行"。

### 第 4 步：tasks 写"改哪些文件"

`DRY-T1` 校验路径存在或显式标「新建」。重构时把**不动的文件也列出来**并标"不改"，能防止 diff 悄悄扩大。

### 第 5 步：每次改完都跑两档

```bash
node cli.mjs check --change changes/refactor-core --profile process  --repo . --config guard.config.json
node cli.mjs check --change changes/refactor-core --profile acceptance --evidence evidence.json \
  --repo . --config guard.config.json --code src
```

- 流程档红 → **还没写到位**，不是代码坏了。
- 验收档红 → **不能收**。

### 第 6 步：收口（不要一次全绿）

```bash
node tools/self-check.mjs
```

八步全过才算交付。构数量必须**不变多**（对照第 0 步的三个数）；变少是加分项，不是要求。

> **没有实现的"棘轮"**：本项目暂无"基线数字自动比对"的判据（见 ICD §7 TBD）。
> 现状做法是把基线抄进 proposal 的「现状」一节，验收时人工比对——这条属于
> `ACCEPT-E4`（人工签字）的范畴，机器不管。

## 4. 配置怎么填

`guard.config.json`（放仓库根，随项目走）：

```json
{
  "contractPrefixes": ["shared/"],
  "boundaries": { "web": ["web/"], "server": ["src/"], "shared": ["shared/"] },
  "forbidImports": [{ "from": "web", "to": "server" }, { "from": "server", "to": "web" }],
  "maxNesting": 3,
  "dupWindow": 6,
  "dupMinChars": 40,
  "yagniMinNonGoals": 3,
  "dryMinReuse": 1,
  "maxDiffLines": 400,
  "minMutationRatio": 0.8
}
```

**按需开启，不要一次全开**：

| 想查什么 | 需要配什么 | 不配会怎样 |
|---|---|---|
| 越界改动行数 | 提供 `--diff`，配 `allowedPrefixes` + `maxDiffLines` | `DISCIPLINE-C1` = **skip**（不是通过） |
| 前后端不互引内部路径 | `boundaries` + `forbidImports` | `DECOUPLE-2` = skip |
| 契约单一真源 | `contractPrefixes` | 只校验路径存在性，不校验位置 |

**说明**：`--diff` 需要一份 `{"files":[{"path":"a/b.ts","added":10,"deleted":2}]}`。没有 git 集成时用脚本从 `git diff --numstat` 生成即可。

## 5. 验收档的证据从哪来

`--evidence` 是**验收档必填**，且必须含三个键：`tests` / `mutation` / `drift`。缺任一 ⇒ 退出码 2。

```bash
node tools/make-evidence.mjs                 # 默认配置见 evidence.config.json
node tools/make-evidence.mjs --config my.json --out evidence.json
```

`evidence.config.json`：

```json
{
  "tests":    { "command": "node test/guard.test.mjs",       "parser": "node-test" },
  "mutation": { "command": "node test/mutation.mjs",         "parser": "mutation" },
  "drift":    { "command": "node tools/check-contract.mjs",  "parser": "drift" }
}
```

产物器有三条硬纪律（不是建议）：

1. 命令**退出码非 0** ⇒ 该证据不写入，整体失败；
2. 输出**解析不出汇总行**或数字自相矛盾 ⇒ 失败；
3. 成功时写 `meta.provenance`（命令 / 退出码 / cwd / 输出 sha256），可审计。

**三条空集禁令**：`tests.passed=0`、`mutation.total=0`、`drift.checks=0` 全部判 **FAIL**——"全绿"与"没跑"必须区分开。

## 6. 看报告

```
PASS    KISS-S1   每条 Requirement 至少一个 Scenario，且 GIVEN/WHEN/THEN 齐全
        → 3 条 Requirement / 5 个 Scenario 全部合格
FAIL    KISS-C1   嵌套深度不得超过 3 层
        → 1 处超过 3 层
          · src/legacy/parser.js:88 深度 4 > 3
SKIP    DISCIPLINE-C1  变更必须落在声明范围内
        → 未提供 diff 数据（需 --diff <json>）
MANUAL  ACCEPT-E4  未被执行的分支是否已显式报告（自曝）
─────────────────────────────────────────
通过 6 · 失败 1 · 跳过 2 · 待人判 2   (共 11 条)
机器实际执行 7/9 条机器规则
```

四个状态的含义**必须分清**：

| 状态 | 含义 | 算通过吗 |
|---|---|---|
| `PASS` | 机器判定满足 | 是 |
| `FAIL` | 机器判定违背 | 否 |
| `SKIP` | 输入不足，**没检查** | **否** |
| `MANUAL` | 本质不可机械判定 | **否**（需人签字） |

**
eason 是全量计数，items 只是前 30 条样本**——看到 22 处 / 8 处 这种分组，那是样本内的分布，不是全量。要全量分布就用 lib/code.mjs 的同一函数自己聚合（见 §10 附注）。

**报告末尾那两行是重点**：`机器实际执行 N/M` 说明有多少判据真的跑了；`⚠ N 条因输入不足从未执行` 提醒你 skip 不等于通过。

退出码：`0` 机器全过 · `1` 判据判定不合格（或 `--strict` 下有 manual）· `2` 参数/输入/证据错误 · `3` 判据自身不可信或覆盖率不足。

> `3` 与 `1` 的区别是**对谁下结论**：`1` 说你（被测对象）不合格；`3` 说判据自己坏了，
> 它给不出可信结论，本次任何"通过"都不作数。CI 里两者都应阻断，但排障方向相反。

## 7. 常见红 → 怎么修

| 红 | 真实原因 | 修法（按优先级） |
|---|---|---|
| `YAGNI-P1 非目标闸` | 没有「非目标」小节，或没有表格/列表，或行数 < 3 | 写"不做的事"表，每行带理由 |
| `KISS-S1` | Requirement 缺 Scenario，或 GWT 不齐 | 每条 Requirement 至少 1 个 Scenario，四个关键词齐 |
| `KISS-S2` | 一个 Scenario 里多个 THEN | 拆成多个 Scenario（一个场景只验一个行为） |
| `DRY-D1` | 复用清单不是真实路径 | 换成真实存在的模块路径；不存在就先别写 |
| `KISS-D1` | 新增依赖没登记理由 | 每行填"标准库为什么不行" |
| `DRY-T1` | tasks 里的路径不存在也没标新建 | 标「新建」，或改成真实路径 |
| `DRY-C1` | 跨文件 ≥6 行规范化重复 | 抽公共函数；**同一文件内重复不报**（避免误伤数据表） |
| `KISS-C1` | 控制流嵌套 > 3 层 | 早返回 / 抽函数。**只算控制流与函数体，对象字面量不算** |
| `YAGNI-C1` | 代码里写着"预留/将来扩展/暂未使用" | 删掉，或改成真实需要的实现 |
| `DISCIPLINE-C1` | 改了声明范围外的文件，或超行数预算 | 收窄 diff，或用 `allowedPrefixes` 说明范围 |
| `DECOUPLE-1` | 没有「接口契约」小节，或契约路径不在契约目录 | 建契约文件放 `shared/`，design 里登记 |
| `DECOUPLE-2` | 前端 import 了后端内部路径 | 走契约/共享层。**动态拼接路径不判定**（宁可漏报不误报） |
| `ACCEPT-E1/E2/E3` | 测试/变异/漂移证据不合格 | 看 reason，逐条修；空集一律 FAIL |
| `--profile` 报"不属于当前档位" | `--only` 里的规则不属于该档 | 代码级判据在 acceptance，四制品在 process |

## 8. 三条使用纪律（踩过坑）

1. **`--code` 不要包含 `test/`**。负控夹具天然写着违规字样（重复块、投机标记），扫进去全是假阳性。
2. **限流式推进**：不要为了变绿去改判据/降阈值。要么改代码，要么在 PR 里写明豁免理由。
3. **接口改动必须同步文档**：改 `lib/contract.mjs` 就要同步 `docs/ICD.md` 与 `README.md`，否则 `check-contract` 报漂移。

## 9. 接 CI

```yaml
- run: node tools/self-check.mjs        # 8 步
- run: node tools/check-publish.mjs     # 脱敏 / LF / 结构
```

本项目自己的 CI（`.github/workflows/ci.yml`）就是这两条，矩阵 ubuntu + windows × Node 20/22/24。
**CI 不另立标准**：如果本地绿而 CI 红，说明判据不可移植——修判据，不要给 CI 加例外。

## 10. 已知边界（别指望它）

- 无 AST：`DRY-C1` 是行级窗口，改变量名即可绕过；`KISS-C1` 是花括号/缩进启发式。
- `DECOUPLE-2` 不展开 tsconfig 路径别名（`@shared/*` 靠 `boundaries` 前缀匹配）。
- 6 条 `MANUAL` 永远不在机器判定内，需要人或 `signoff` 流程（尚未实现，ICD §7 TBD）。
- 无"豁免"机制（自由文本除外）；无基线棘轮；无增量扫描缓存。
- 只在 Windows + Node 20/22/24 实测过（CI 另跑 ubuntu）。

## 附录 A：怎么拿全量分布（存量项目专用）
CLI 的 `items` 只带前 30 条样本。存量重构需要的是**按文件排序的违例数**，因为它决定先改哪个文件。
直接 import 判定函数自己聚合，口径与 CLI 完全一致：

```js
// 放在目标仓库根跑：node baseline.mjs <代码根>
import { walkCode, nestingDepth, duplicateBlocks } from 'file:///<sdd-guard 路径>/lib/code.mjs';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const root = process.argv[2];
const MAX = 3;                       // ← 与 guard.config.json 的 maxNesting 保持一致
const files = walkCode(root);

const nest = new Map();
let nestTotal = 0;
for (const f of files) {
  const h = nestingDepth(f, readFileSync(f, 'utf8'));
  // ★ 必须只数 depth > MAX。nestingDepth 返回的是"每一行的当前层级"，
  //   不过滤会把 depth=1/2 的正常行也算进来 —— 实测差 14 倍（29542 vs 2092）。
  const bad = h.filter((x) => x.depth > MAX);
  if (bad.length) {
    const r = relative(root, f).replace(/\\/g, '/');
    nest.set(r, bad.length);
    nestTotal += bad.length;
  }
}

const blocks = duplicateBlocks(files, 6, { minChars: 40 });
const norm = (p) => String(p).replace(/\\/g, '/');
const pair = new Map();
for (const b of blocks) {
  const k = `${norm(b.a.file)} ↔ ${norm(b.b.file)}`;
  pair.set(k, (pair.get(k) || 0) + 1);
}

console.log('嵌套违例总数', nestTotal, '| 重复块总数', blocks.length);
[...nest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(String(v).padStart(6), k));
console.log('--- 重复块文件对 ---');
[...pair.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
```

**自证这条脚本对不对**：它的 `nestTotal` 必须与 CLI 报告里
`KISS-C1 →  N 处超过 3 层` 的 **N 完全相等**。不相等就说明口径错了（多半就是漏了
`depth > MAX` 过滤——这条是真踩过的坑，差 14 倍）。

真实项目上的实测样例见 `docs/` 之外的基线报告；核心经验是：
**"重复块"往往集中在中等文件之间（同族实现各写一遍），而不是在最大的文件里**——
所以先看 `pair` 那张表，再决定拆哪个。
