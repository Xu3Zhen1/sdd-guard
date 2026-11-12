# sdd-guard 接口控制文档（ICD）

| 项 | 值 |
|---|---|
| 文档版本 | **v0.1**（2026-11-11） |
| 适用实现 | `sdd-guard` 0.1.0（`package.json`） |
| 真源 | 本文档；实现偏离即为缺陷，须改实现或改本文档，二者不得各说各话 |
| 状态 | 前 6 节为**已实现且被测试锁定**；第 7 节为**尚未实现**，明确不是契约 |

**稳定性分级**

- **S1 冻结** —— 已对外承诺，改动须升主版本
- **S2 稳定** —— 可加字段，不可改语义
- **S3 试验** —— 可能改
- **TBD** —— 未实现，调用方不得依赖

---

## 1. 调用契约（CLI）

### 1.1 命令形态

```bash
node cli.mjs check --change <dir> [选项]
node cli.mjs --help
```

只有一个子命令 `check`。`--help` / `help` / 无参数均打印帮助并以 `0` 退出。

### 1.2 选项表

| 选项 | 必填 | 可重复 | 类型 | 默认 | 语义 |
|---|---|---|---|---|---|
| `--change <dir>` | **是** | 否 | 路径 | — | change 目录；不存在 ⇒ 退出码 2 |
| `--repo <dir>` | 否 | 否 | 路径 | 首个 `--code` 根，其次 `--change` | **所有相对路径的解析基准**（design/tasks 里的路径、C2 扫描的根） |
| `--config <file>` | 否 | 否 | 路径 | 空配置 `{}` | JSON；不存在 ⇒ 退出码 2，解析失败 ⇒ 退出码 2 |
| `--code <dir>` | 否 | **是（累积）** | 路径 | `[]` | 被扫描源码根；多个根会合并去重 |
| `--diff <file>` | 否 | 否 | 路径 | `null` | 变更清单 JSON，见 §5 |
| `--only <ids>` | 否 | 否 | 逗号分隔 | 全部规则 | 只跑指定规则 id；**含未知 id ⇒ 退出码 2** |
| `--profile <name>` | 否 | 否 | 枚举 | `all` | `process` / `acceptance` / `all`；未知值 ⇒ 退出码 2 |
| `--evidence <file>` | acceptance 时**必填** | 否 | 路径 | `null` | 验收证据 JSON，见 §5；`--profile acceptance` 缺它 ⇒ 退出码 2 |
| `--json` | 否 | 否 | 布尔 | `false` | 输出 JSON 而非文本报告 |
| `--strict` | 否 | 否 | 布尔 | `false` | 把 `manual` 也视为失败 |
| `--min-coverage` | 是 | 否 | `<0..1>` | 不启用 | 机器规则最低执行覆盖率（`covered / machineTotal`），低于它 ⇒ 退出码 1。**CI 建议给 `0.8`** |
| `--help` | 否 | 否 | 布尔 | `false` | 打印帮助并退出 0（`help` 子命令与无参数同义） |

**解析规则（S1）**：

1. `--key value`：值与键之间恰好一个参数；值若以 `--` 开头则视为缺值。
2. 缺值记为布尔 `true`，**不**当作字符串 `"true"`；`--change` 缺值 ⇒ 退出码 2。
3. `--code` 重复出现时**累积成数组**；单个也归一为长度 1 的数组。
4. 其余选项重复出现时**后者覆盖前者**（明确语义，不是静默丢弃）。
5. 非 `--` 开头的参数进入 `_` 数组。
6. `--only` 里出现任何**未知规则 id** ⇒ 退出码 2 并打印可用 id 列表。原因：静默过滤成空集会变成"跑了 0 条规则 ⇒ 全过"，与「空集不构成通过」同型。

> 历史偏差（已修，2026-11-11）：0.1.0 早期实现中 `--code` 重复出现只保留最后一个，而 HELP 声称"可重复"。该缺陷由 `test/args.test.mjs` 与 `test/prove-multiroot.mjs` 双重锁定。

### 1.3 退出码（S1）

| 码 | 条件 | 含义 |
|---|---|---|
| `0` | 无 `fail`，且未开 `--strict`（或开启但 `manual=0`），且未开 `--min-coverage`（或覆盖率达标） | 机器规则全过 |
| `1` | 存在 `fail`，或 `--strict` 且存在 `manual`，或 `--min-coverage` 下覆盖率不足 | 判据未通过 |
| `2` | 参数缺失/非法、目录不存在、配置文件不存在或非合法 JSON | 调用方错误，**不是**代码质量问题 |

**`skip` 与 `manual` 永远不导致退出码 0 的"通过"语义**：它们只影响报告数字，check 的通过判据只看 `fail`（与可选 `--strict` 下的 `manual`）。

**关于 `--min-coverage`（2026-11-12 补，外部实测发现）**：默认**不启用**——`process` 档的用法是"边写边查"，文档没写完就 `skip` 是合理的，判 fail 会打断正常流程。但**不启用时存在一个真实缺口**：

> 一个**什么都没写**的 change 目录，13 条机器规则全 SKIP，汇总报「通过 0 · 失败 0 · 跳过 13」，
> 硬失败只看 `fail > 0` ⇒ **退出码 0 ⇒ CI 放行空提交**。

实测确认（空 change 目录）：`通过 1 · 失败 0 · 跳过 16`、`covered = 1/17`、**EXIT=0**。
所以：**CI 里必须显式加 `--min-coverage`**，否则「什么都没做」与「全部通过」在退出码上不可区分。
这是"不改变既有语义的显式选项"，不是又一处静默跳过 —— 两者区别在于**使用者必须主动选择**。

### 1.4 两套档位（profile）：开发流程 ≠ 验收标准

两件事被刻意分开，因为**责任、时机、稳定性都不同**：

| | `process`（开发流程） | `acceptance`（验收标准） |
|---|---|---|
| 回答的问题 | 「有没有按流程把活写清楚」 | 「能不能交付」 |
| 规则来源 | `stage` ∈ proposal / specs / design / tasks | `stage === 'code'`（含代码级判据与 `ACCEPT-E*`） |
| 运行时机 | 开发过程中反复跑 | 交付前跑一次 |
| 失败的含义 | **还没走到位**，不表示交付不合格 | **不能收** |
| 输入 | 四个 md 制品 | 制品 + **外部证据**（§5） |
| 豁免 | 可豁免（原型阶段） | 不可豁免 |

档位由规则的 `stage` **派生**，不维护手工清单——手工清单必然与规则表漂移。`--profile all`（默认）跑全部。

**`acceptance` 的硬约束**：没有 `--evidence` 直接退出码 2。理由：sdd-guard 自己跑不了测试与变异，验收只能读**它没有参与生产**的证据；否则就是"用被测对象的成绩单判自己合格"。

---

## 2. 输出契约

### 2.1 `--json` 结构（S2）

```json
{
  "repo": "<绝对路径>",
  "results": [
    {
      "id": "YAGNI-P1",
      "principle": "YAGNI | KISS | DRY | DISCIPLINE | DECOUPLING",
      "stage": "proposal | specs | design | tasks | code",
      "decidability": "machine | manual",
      "title": "<已渲染阈值的人类可读标题>",
      "status": "pass | fail | skip | manual",
      "detail": "<可选，仅 pass 时常见>",
      "reason": "<可选，fail/skip 时必有>",
      "items": ["<可选，逐条违例，已截断>"]
    }
  ],
  "summary": {
    "pass": 0, "fail": 0, "skip": 0, "manual": 0,
    "total": 0, "machineTotal": 0, "covered": 0
  }
}
```

**字段语义（S1）**

- `status` 仅四个值，**不得新增**而不升版本；新增会让下游判据失效。
- `covered = pass + fail`：**机器真正执行过的规则数**。`covered < machineTotal` 就说明「有规则没跑」。
- `skip`：输入不足导致未执行。**不得在报告或下游把 skip 计为通过。**
- `manual`：本质不可机械判定，永远不计入 `covered`。
- `items` **可能被截断**（部分规则 ≤30 条，也有规则不截断），**不是全量计数**；要数字请看 `reason` 里的计数，要定位请看 `items`。

### 2.2 文本报告关键行（S3，供人读，稳定但非机器契约）

- 每条规则一行：`  PASS|FAIL|SKIP|MANUAL  <id>  <title>`
- 汇总区两行必备：
  - `通过 N · 失败 N · 跳过 N · 待人判 N   (共 N 条)`
  - `机器实际执行 N/M 条机器规则`

---

## 3. 产物契约（输入侧四制品）

位置：`<change>/` 下。

| 文件 | 必需 | 说明 |
|---|---|---|
| `proposal.md` | 条件必需 | 缺则 `YAGNI-P1` = skip |
| `specs/*.md` 或 `specs/<cap>/spec.md` | 条件必需 | 两层都识别；按文件名排序 |
| `design.md` | 条件必需 | 缺则 `KISS-D1`、`DRY-D1` = skip |
| `tasks.md` | 条件必需 | 缺则 `DRY-T1` = skip |

### 3.1 `proposal.md`（S2）

- 「非目标」小节标题须匹配 `非目标|不做(的)?事|out of scope|non-goals`（英文不区分大小写）；次选 `不做什么|明确不做|excluded`。
- 该小节须是**表格**（表头 + ≥`yagniMinNonGoals` 行）或**列表**（≥同数量项）。
- 表格每行第 2 列（理由）非空。
- ⚠ 只有「变更范围 / scope」**不算**非目标——泛标题不得顶替。

### 3.2 `specs/*.md`（S2）

- `Requirement` 标题：任意层级，匹配 `^require?ment\s*[:：]`（不区分大小写）。
- `Scenario` 必须是被检 Requirement 的**直接子标题**，匹配 `^scenario\s*[:：]`。
- 每个 Scenario 正文须同时含 `GIVEN/WHEN/THEN`（大小写不敏感）或 `给定 / 当 / 那么`。
- 单个 Scenario 的列表项中，含 `THEN|那么` 的行数 >1 ⇒ `KISS-S2` 失败。
- **零 Requirement 不构成通过**（`KISS-S1` 判 fail）。

### 3.3 `design.md`（S2）

- 「复用清单」小节匹配 `复用|reuse`；其内**反引号包裹的路径**必须存在（按 `--repo` 解析），条数 ≥ `dryMinReuse`。
- 「依赖」小节匹配 `依赖|dependenc`；表格每行须有第 2 列「标准库为什么不行」；配置里 `dependencies` 声明的每个键都必须在表中出现。

### 3.4 `tasks.md`（S2）

- 反引号路径必须存在，或该行含 `新建|新增|create|new file`。
- 一个路径都不给 ⇒ `DRY-T1` 失败（无法查重）。

---

## 4. 配置契约（S2）

`--config` 指向的 JSON，全部键可选：

| 键 | 类型 | 默认 | 影响 |
|---|---|---|---|
| `maxNesting` | int | `3` | `KISS-C1` 嵌套深度上限 |
| `dupWindow` | int | `6` | `DRY-C1` 跨文件重复的窗口行数 |
| `dupMinChars` | int | `40` | `DRY-C1` 窗口最小字符数（避免短行误报） |
| `yagniMinNonGoals` | int | `3` | `YAGNI-P1` 非目标最少条数 |
| `dryMinReuse` | int | `1` | `DRY-D1` 复用清单最少路径数 |
| `dependencies` | object | `{}` | `KISS-D1` 期望被登记的依赖（key 为包名） |
| `allowedPrefixes` | string[] | `[]` | `DISCIPLINE-C1` 允许变更的路径前缀（空 = 不校验） |
| `maxDiffLines` | int | `400` | `DISCIPLINE-C1` 变更行数预算 |
| `minMutationRatio` | number | `0.8` | `ACCEPT-E2` 变异杀死率下限 |
| `equivalentMutants` | array | `[]` | 等价变异声明 `[{id, reason}]`；从 `ACCEPT-E2` 分母扣除。**`reason` 必填**，缺则判 fail |
| `boundaries` | object | `{}` | `DECOUPLE-2` 边界前缀表 `{ 边界名: [仓库相对前缀…] }`；空 = 解耦检查 skip |
| `forbidImports` | array | `[]` | `DECOUPLE-2` 禁止的跨边界引用，`{from,to}` 或 `[from,to]`；空 = skip |
| `contractPrefixes` | string[] | `[]` | `DECOUPLE-1` 契约文件必须落在的前缀；空 = 不限制位置 |

未知键**忽略**（不报错），因此新配置项可前向兼容。

---

## 5. diff / evidence 输入契约

### 5.1 `--diff`（S3）

```json
{ "files": [ { "path": "src/a.js", "added": 10, "deleted": 2 } ] }
```

- `path` 用于 `allowedPrefixes` 前缀比较（`\` 归一为 `/`）。
- `added + deleted` 汇总用于 `maxDiffLines`。
- **空 `files` ⇒ `DISCIPLINE-C1` = skip**（空集不构成通过）。

**生成器**：`tools/make-diff.mjs`（2026-11-12 新增）。

```bash
node tools/make-diff.mjs --repo . --out diff.json                    # 工作树 vs HEAD
node tools/make-diff.mjs --repo . --base origin/main --out diff.json # vs 某分支
node tools/make-diff.mjs --repo . --staged --out diff.json           # 已暂存
node tools/make-diff.mjs --repo . --range HEAD~3..HEAD --out diff.json
```

**为什么这个工具是必需的**：没有 diff 时，`DISCIPLINE-C1`（越界/预算）与
`DISCIPLINE-C3`（文档↔代码绑定）**都是 skip**，而 skip 不是通过 ——
也就是说这两类问题在过去是**永远检不出来**的。

### 5.2 `DISCIPLINE-C3`：文档声明 ↔ 实际变更 绑定（S3，2026-11-12 新增）

**它解决的问题**（对方 8 片实测，决定性实验）：同一份 change 目录，只改四制品不动代码：

| 实验 | process 档结果 |
|---|---|
| 四制品完美 + 代码零改动 | 7 绿 0 红 |
| 四制品**全空** | 6 红（唯一抓到问题的场景） |
| 四制品描述**另一件完全没做的事** | **仍 7 绿 0 红** |

8 片共跑 9 次 process 档，**0 次因"这片做得不对"而红**。它当时接近 Markdown 链接检查器。

**判定规则**：

1. 从 `tasks.md` / `design.md` 抽取反引号内的路径；**只取带目录的**（裸文件名歧义太大，会误伤）。
2. 每条声明路径必须**出现在 diff 的 `files[].path` 里**，否则 FAIL（`声明了但没改`）。
3. 反向：diff 里的源码文件若在文档中完全找不到出处，也 FAIL（`改了但文档没提`）——防"偷偷扩大范围"。
4. 无 diff / diff 为空 / 无 tasks+design ⇒ **skip**（不假装通过）。

### 5.2 `--evidence`（S2，`acceptance` 档必填）

```json
{
  "tests":    { "passed": 35, "failed": 0, "skipped": 1 },
  "mutation": { "killed": 11, "total": 11, "survived": ["M7 跨文件重复检测失效"] },
  "drift":    { "checks": 27, "findings": 0, "items": ["ICD 里 maxNesting 默认值未写成 3"] }
}
```

三个键各自独立判定：

| 键 | 通过条件 | 空集/缺失的处理 |
|---|---|---|
| `tests` | `failed === 0` **且** `passed > 0` | 缺 ⇒ skip；`passed=0` ⇒ **fail**（"全绿"与"没跑"同形） |
| `mutation` | `total > 0` 且 `killed/total ≥ minMutationRatio` | 缺 ⇒ skip；`total=0` ⇒ **fail** |
| `drift` | `checks > 0` 且 `findings === 0` | 缺 ⇒ skip；`checks=0` ⇒ **fail** |

**这张表是验收档的全部可信来源。** evidence 必须由**独立于 sdd-guard 的过程**产出（项目自己的测试/变异/漂移脚本），
sdd-guard 只读不算——同一进程既生产证据又判定证据，等于自证。

**必填三个键**：`tests` / `mutation` / `drift` 缺任何一个 ⇒ **退出码 2**（不让缺失退化成 skip）。

### 5.3 证据产出器 `tools/make-evidence.mjs`（S2）

```bash
node tools/make-evidence.mjs --config evidence.config.json --out evidence.json
```

配置（缺省读仓库根的 `evidence.config.json`）：

```json
{
  "tests":    { "command": "node test/guard.test.mjs",        "parser": "node-test" },
  "mutation": { "command": "node test/mutation.mjs",          "parser": "mutation" },
  "drift":    { "command": "node tools/check-contract.mjs",   "parser": "drift" },
  "keepOutputs": false
}
```

**行为契约（S1）**：

1. 每条命令的输出**重定向到文件**再读（不捕获 stdout），原始输出保留在 `.evidence-raw/` 可人工复核。
2. **命令退出码非 0 ⇒ 该证据不写入结果**，整体退出码 1，并列出失败项。**绝不写 0 冒充"跑过"。**
3. 解析器找不到汇总行、或数字自相矛盾（`pass+fail>tests`、`passed+findings≠checks`）⇒ 抛错、整体失败。
4. 成功时写入 `meta.provenance`：每条证据的 `command` / `exitCode` / `cwd` / `sha256`（输出指纹）/ `bytes`。
5. 三个键不全 ⇒ 退出码 1，不写文件。

解析器（`lib/evidence.mjs`，纯函数，可单测）：`node-test` / `mutation` / `drift`。
**它们只解析不判定**——"合格与否"是 acceptance 档的事。

---

## 6. 规则扩展契约（S2）

`lib/rules.mjs` 导出 `RULES: Rule[]`；外部可用 `runRules({ rules })` 注入自有规则集。

```ts
type Rule = {
  id: string;                                   // 全局唯一，形如 'principle-stageN'
  principle: 'YAGNI' | 'KISS' | 'DRY' | 'DISCIPLINE';
  stage: 'proposal' | 'specs' | 'design' | 'tasks' | 'code';  // 决定所属档位（code ⇒ acceptance）
  decidability: 'machine' | 'manual';
  title: string;                                // 可含 {配置键} 占位，由 cfg 渲染（键名即配置键）
  why: string;                                  // 人类可读理由（进文档，不影响判定）
  run(ctx): RuleResult;
};

type RuleResult =
  | { status: 'pass'; detail: string }
  | { status: 'fail'; reason: string; items?: string[] }
  | { status: 'skip'; reason: string }
  | { status: 'manual' };
```

**`ctx` 可用成员（S2）**

| 成员 | 语义 |
|---|---|
| `art` | `{ files: {'proposal.md'\|'design.md'\|'tasks.md': {path,text}\|null}, specs: [{name,path,text}] }` |
| `changeDir` / `repo` / `cwd` | 绝对路径 |
| `cfg` | 配置对象（已合并默认值语义由规则自行 `??`） |
| `diff` | §5.1 结构或 `null` |
| `evidence` | §5.2 结构或 `null`（acceptance 档必填） |
| `codeFiles` | 绝对路径数组（已按 `CODE_EXT` 过滤、去重、排序） |
| `readFile(f)` | 带缓存的 UTF-8 读取 |
| `rel(f)` | 转为相对 `cwd` 的显示路径 |
| `existsProjectFile(p)` | 按 `repo`（其次 `cwd`）解析的存在性检查 |

**强制约定（S1）**

1. 规则**不得**把「集合为空」判为 `pass`——必须 `skip` 或 `fail`。
2. 规则抛错会被 runner 捕获成 `fail` + `reason: 规则执行异常: …`；不要让异常成为常规失败路径。
3. `items` 用于定位，长度须截断（建议 ≤30）。

---

## 7. 尚未实现（TBD，调用方不得依赖）

以下在讨论中出现过，但**代码里不存在**。写进契约前必须实现并配负控测试：

| 候选 | 现状 | 影响 |
|---|---|---|
| 规则级 `severity`（`error`/`warn`/`off`） | **不存在**；只有四态 + 全局 `--strict` | 「初期只 warning」无法执行 |
| 结构化豁免（`exemptions.json`：规则 id / 理由 / 到期日 / 批准人） | **不存在** | 只能自由文本静音，无法审计与过期 |
| `manual` 签字载体（`signoff.md`） | **不存在** | 4 条人工判据永久空转 |
| 规格 → 测试覆盖连通（Scenario 是否真被测到） | **不存在** | 判据全绿但可能无测试 |
| AST 级重复检测 | 仅行级规范化 | 改变量名即可绕过 `DRY-C1` |

---

## 8. 兼容性承诺

- `id` 字符串**只增不改**：下游白名单/豁免按 id 引用。
- `status` 枚举只增不改（新增须升次版本）。
- `summary` 字段只增不删；删除须升主版本。
- `exit code` 语义冻结（S1）。
- 配置文件新增键默认兼容；**默认值改动视为行为变更**，须在 `README` 与本文档同步并升次版本。

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-11 | v0.1 | 首版：从 `cli.mjs` / `runner.mjs` / `rules.mjs` / `code.mjs` 的实际行为反写；同时修正两处「文档说得到、实现做不到」的接口缺陷：① `--code` 重复出现只保留最后一个 → 改为累积；② `--only` 含未知 id 时静默过滤成空集并退出 0（「跑了 0 条 ⇒ 全过」）→ 改为退出码 2 并打印可用 id。两处均由 `test/args.test.mjs`（10 用例）与 `test/prove-multiroot.mjs` 锁定 |
| 2026-11-11 | v0.1+ | 新增第 5 类原则 **DECOUPLING**（前后端解耦，3 条判据）；新增配置键 `boundaries` / `forbidImports` / `contractPrefixes`；契约常量收敛到 `lib/contract.mjs`（帮助文本由其生成），并加 `tools/check-contract.mjs` 做三方漂移检测 |