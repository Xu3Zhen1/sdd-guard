# 任务

1. `lib/code.mjs`：`nestingDepth` 只计控制流/函数体块（对象字面量不计）——已改
2. `lib/runner.mjs`：新增 `selectRules`，把「未知 id / 不属于当前档位」分成两类——已改
3. `cli.mjs`：改用 `selectRules`，两类错误均退出码 2——已改
4. `test/guard.test.mjs`：新增 KISS-C1 对象字面量正控 + 控制流 4 层负控——已加
5. `test/args.test.mjs`：覆盖 `selectRules` 的三分类——已加
6. `guard.config.json`：为 sdd-guard 自身建立配置（`contractPrefixes: ["lib/"]`）——新建
7. `README.md`：写明 KISS-C1 的语义边界（只算控制流，不算字面量）——已改
8. `docs/ICD.md`：记录 `--only` × `--profile` 的组合错误语义——已改
9. `lib/speculative-markers.json`：投机标记模式表移出代码（检测器自指误报）——新建
10. `tools/self-check.mjs`：默认验收目标改为 sdd-guard 自身——已改
11. `README.md`：写明 self-check 默认自举 + KISS-C1 语义边界——已改

验收方式：`node tools/self-check.mjs --change changes/self-host-guard --repo . --config guard.config.json --code lib --code tools --code cli.mjs`