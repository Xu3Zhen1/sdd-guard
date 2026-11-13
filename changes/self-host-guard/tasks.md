# 任务

1. `lib/code.mjs`：`nestingDepth` 只计控制流/函数体块（对象字面量不计）——已改
2. `lib/runner.mjs`：新增 `selectRules`，把「未知 id / 不属于当前档位」分成两类——已改
3. `cli.mjs`：改用 `selectRules`，两类错误均退出码 2——已改
4. `test/guard.test.mjs`：新增 KISS-C1 对象字面量正控 + 控制流 4 层负控——已加
5. 历史项（本轮未改，见下节「历史范围声明」）：覆盖 `selectRules` 三分类的测试文件
6. `guard.config.json`：为 sdd-guard 自身建立配置（`contractPrefixes: ["lib/"]`）——新建
7. `README.md`：写明 KISS-C1 的语义边界（只算控制流，不算字面量）——已改
8. `docs/ICD.md`：记录 `--only` × `--profile` 的组合错误语义——已改
9. 历史项（本轮未改，见下节「历史范围声明」）：投机标记模式表移出代码
10. `tools/self-check.mjs`：默认验收目标改为 sdd-guard 自身——已改
11. `README.md`：写明 self-check 默认自举 + KISS-C1 语义边界——已改

验收方式：`node tools/self-check.mjs --change changes/self-host-guard --repo . --config guard.config.json --code lib --code tools --code cli.mjs`

## 历史范围声明（不属于本轮，已从本轮变更声明中分离）

下面两项由更早的 self-host-guard 任务建立，**本轮未改动**。C3 曾报的「声明但未落地」就是它们。

★ 这里**不再用列表项**：C3 只从列表项抽取「我要改这个路径」的声明，
把历史项写成列表会让它继续被当作本轮声明（`collectFromBlock` 不区分小节语义）。
用普通段落记录出处，既保留历史，又不冒充本轮变更。

`lib/speculative-markers.json` 由第 9 项建立（投机标记模式表移出代码），自建立后稳定，本轮未改。
`test/args.test.mjs` 由第 5 项建立（覆盖 `selectRules` 三分类），本轮未改。

## 本轮（A01–A16 审计修复）逐文件任务映射

格式说明：C3 只从**列表项**抽取路径，因此下面每条是一个列表项，写「改什么 —— 所属审计项 —— 怎么验」。

- 修改 `lib/values.mjs`：计数只接受非负安全整数、比例限 0..1，禁 `Number()` 隐式转换 —— A02 —— 由 ACCEPT-E1/E3 负控覆盖（`test/guard.test.mjs`）
- 修改 `lib/paths.mjs`：词法归一 + 段边界前缀匹配 + 唯一 repo 基准（不回落 cwd）—— A03 —— 由路径类用例覆盖（`test/guard.test.mjs`）
- 修改 `lib/config.mjs`：`CONFIG_SCHEMA` 值域校验，未知键报错 —— A01 —— 由 A01 探针与参数契约测试覆盖
- 修改 `lib/temp.mjs`：实测可写的临时目录，取代全仓裸 `tmpdir()` —— 复核轮次（临时目录环境假设）—— 两种 TMP 配置下各测试均绿
- 修改 `lib/code.mjs`：`nestingDepth` 改词法状态机 + 括号栈；`scanCodeRoots` 逐根收据；`stripComments` 排除注释内 import —— A04/A06/A13 —— 由 `test/scan-roots.test.mjs` 与 `test/guard.test.mjs` 覆盖
- 修改 `lib/md.mjs`：`fencedMask` 围栏代码块隔离 —— A05 —— 由围栏类用例覆盖（`test/guard.test.mjs`）
- 修改 `lib/rules.mjs`：计数域 / 路径基准 / 文档格式判据统一；ACCEPT-E2 增加清单完整性闸门 —— A01/A02/A05/A09 —— 由 `test/guard.test.mjs`（76 条）覆盖
- 修改 `lib/spec.mjs`：规格制品收集，配合围栏隔离 —— A05 —— 由 KISS-S2 用例覆盖
- 修改 `tools/self-check.mjs`：`isMain` 守卫、`--print-steps`、`scan-receipt`/`discipline-fixtures`/`real-diff-notice` 三步、`classifyRealDiff` 状态白名单 —— A06/A07/A08 与复核轮次 —— 自身即门禁，归因逻辑由 `test/real-diff-notice.test.mjs`（12 条）覆盖
- 修改 `tools/check-contract.mjs`：CI 等价性改为比对 `--print-steps` 的结构化数据 —— A08 —— 由 `test/contract-guard.test.mjs`（6 条，含五个变异负控）覆盖
- 修改 `tools/check-publish.mjs`：拆函数消 KISS-C1 超限嵌套，语义不变 —— KISS-C1 自举 —— `node tools/check-publish.mjs`（发布阻断 0）
- 修改 `tools/make-diff.mjs`：改用 `-z` numstat，覆盖 untracked / rename / binary —— A12 —— 由 `test/make-diff.test.mjs`（12 条）覆盖
- 修改 `tools/make-evidence.mjs`：旧输出隔离 + 原子写 + 代码树身份 —— A10 —— 由 `test/evidence.test.mjs`（31 条）覆盖
- 修改 `docs/audit/audit-lead.mjs`：审计总探针迁入版本管理，作为报告复现依据 —— 报告一致性 —— 其结论由 `test/spec/spec-probe.mjs` 复现
- 修改 `docs/audit/audit-rules-probe.mjs`：规则侧审计探针迁入版本管理 —— 报告一致性 —— 同上
- 修改 `docs/audit/audit-evidence-probe.mjs`：证据链侧审计探针迁入版本管理 —— 报告一致性 —— 同上
- 修改 `docs/audit/audit-integration-probe.mjs`：集成侧审计探针迁入版本管理 —— 报告一致性 —— 同上
- 修改 `docs/audit/audit-integration-package.mjs`：打包侧审计探针迁入版本管理 —— A15 分发边界 —— 同上
- 修改 `test/q1-backdoor.test.mjs`：适配规则层改动（夹具与状态白名单）—— A01–A16 回归 —— `node test/q1-backdoor.test.mjs`（17 条）
- 修改 `test/q2-crossrule.test.mjs`：夹具路径改用 `fileURLToPath`，修 Linux 相对路径缺陷 —— 六环境矩阵 —— `node test/q2-crossrule.test.mjs`（7 条）
- 修改 `test/q2-value.test.mjs`：同上路径修复；价值判据夹具适配 —— 六环境矩阵 —— `node test/q2-value.test.mjs`（7 条）
- 修改 `test/q3-invariant.test.mjs`：适配规则层改动 —— A01–A16 回归 —— `node test/q3-invariant.test.mjs`（6 条）
- 修改 `test/q4-5-exit-signal.test.mjs`：改为直接调用导出的 `decideExit`，不再匹配源码文本形状 —— 复核轮次（禁止源码形状断言）—— `node test/q4-5-exit-signal.test.mjs`（8 条）
- 修改 `test/spec/mutation-selfproof.mjs`：变异自证迁入版本管理并接入门禁 —— 复核轮次（变异自证）—— 4/4 变异：语法有效 → 诊断理由翻转 → 还原复归

验收方式：`node tools/self-check.mjs`（28 项全绿）+ `node tools/check-contract.mjs`（66 项零漂移）+ 六环境矩阵（`.github/workflows/ci.yml`，同一提交 6/6 success，run 43453136896 @ `0f5cb93`）。
