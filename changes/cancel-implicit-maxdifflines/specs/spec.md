# 取消隐式 maxDiffLines 规范

### Requirement: 缺省预算不得约束变更

#### Scenario: 范围内大 diff 不得因隐式 400 失败

- **GIVEN** 配置里**没有** `maxDiffLines`，且 `allowedPrefixes` 为 `["src/"]`
- **WHEN** diff 里 `src/a.js` 的新增行数为 3000
- **THEN** `DISCIPLINE-C1` 状态为 `pass`，且 `detail` 含「行数预算未启用」

#### Scenario: 越界仍然判红且理由写明预算未启用

- **GIVEN** 配置里**没有** `maxDiffLines`，且 `allowedPrefixes` 为 `["src/"]`
- **WHEN** diff 里含 `docs/x.md`
- **THEN** 状态为 `fail`，`reason` 同时含「越界」与「预算未启用」

### Requirement: 显式 0 是零行预算，不等于未启用

#### Scenario: 显式 0 且有一行变更

- **GIVEN** `maxDiffLines` 为 0
- **WHEN** diff 总行数为 1
- **THEN** 状态为 `fail`

### Requirement: 非法取值必须以配置错误退出

#### Scenario: 六种非法取值

- **GIVEN** `maxDiffLines` 依次取 `"400"`、`true`、`-1`、`1.5`、`null`、`[]`
- **WHEN** 用真实 CLI 校验该配置
- **THEN** 每种取值都退出码 2

### Requirement: 文档检查不得因删默认值而失效

#### Scenario: ICD 配置表删掉该键

- **GIVEN** ICD 配置表里删掉 `maxDiffLines` 那一行
- **WHEN** 运行契约检查脚本
- **THEN** 退出码非 0 且点名 `maxDiffLines`