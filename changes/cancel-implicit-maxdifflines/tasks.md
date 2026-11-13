# 任务

1. `lib/contract.mjs`：`CONFIG_DEFAULTS` 删除 `maxDiffLines: 400`，`CONFIG_SCHEMA` 保留 —— 已改
2. `lib/rules.mjs`：预算改 `ctx.cfg.maxDiffLines`（无 `??`），按组合语义分支 + 「未启用」文案 —— 已改
3. `tools/check-contract.mjs`：完整性改以 `CONFIG_SCHEMA` 为依据 —— 已改
4. `tools/check-contract.mjs`：新增「无孤儿默认值」「无默认值的键不得有 `??`」两条反向检查 —— 已加
5. `tools/check-contract.mjs`：ICD 校验收紧为「配置表首格恰好是键名」—— 已改
6. `lib/code.mjs`：导出 `stripComments`（契约检查须去注释后搜源码）—— 已改
7. `test/c1-budget.test.mjs`：A1–A12 验收矩阵，12 条含跳过明细 —— 新建
8. `docs/ICD.md`：`maxDiffLines` 行改「无默认」+ 补未启用语义表 —— 已改
9. `docs/USAGE.md` / `README.md`：配置表与示例注明「显式启用」—— 已改
10. `docs/DESIGN-RATIONALE.md`：修正「已补边界正控」的虚假陈述 —— 已改

验收：`node test/c1-budget.test.mjs`（12/12）+ `node tools/self-check.mjs`（exit 0）
+ `node tools/check-contract.mjs`（漂移 0）+ `node tools/check-publish.mjs`（阻断 0）。
B3 负控已实测：删 ICD 配置表行 ⇒ 退出码 1 并点名该键；还原后回到 0。