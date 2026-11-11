# 规格：sdd-guard 自举检查

## Requirement: 检查器必须能在自身仓库上通过流程档

### Scenario: 变更目录齐备时流程档可自我关闭

- GIVEN `changes/self-host-guard/` 下已提供 proposal.md、specs/、design.md、tasks.md
- WHEN 执行 `node cli.mjs check --change changes/self-host-guard --profile process --repo . --config guard.config.json`
- THEN 输出 `通过 N · 失败 0`，且 `机器实际执行` 的分母等于 process 档机器规则总数
- AND 退出码为 0

### Scenario: 缺任一制品时必须跳过而不是通过

- GIVEN 删掉 `design.md`
- WHEN 以 process 档检查
- THEN 依赖 design 的规则状态为 `skip`，报告里 `通过` 不增加
- AND 覆盖率分母不变，因此"跳过"不会被读成"通过"

## Requirement: `--only` 与档位组合为空时必须报错

### Scenario: 代码档规则配流程档

- GIVEN 执行 `--profile process --only KISS-C1`（KISS-C1 属于 acceptance 档）
- WHEN 参数解析完成
- THEN 退出码为 2，并打印「这些规则不属于当前档位 process: KISS-C1(acceptance)」
- AND **不得**以「0 条规则 ⇒ 全过」退出 0

## Requirement: 嵌套判据不得把对象字面量算作控制流嵌套

### Scenario: 深层配置对象

- GIVEN 源码里有 `{ a: { b: { c: { d: 1 } } } }` 这样的 5 层对象字面量
- WHEN 执行 `KISS-C1`
- THEN 判为 pass（数据结构长这样不等于逻辑复杂）

### Scenario: 真实的控制流嵌套

- GIVEN `for { if { while { ... } } }` 共 4 层块
- WHEN 执行 `KISS-C1`
- THEN 判为 fail 并回显行号与深度