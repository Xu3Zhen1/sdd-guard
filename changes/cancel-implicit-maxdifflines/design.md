# 设计

## 复用清单

| 现有模块路径 | 能复用什么 |
| :-- | :-- |
| `lib/values.mjs` | `readCount` 已是非负整数校验，计数防线不重写 |
| `lib/paths.mjs` | `outOfPrefixRows` 的段边界归一，越界检查原样保留 |
| `lib/config.mjs` | `CONFIG_SCHEMA` 值域校验，非法取值已能退 2 |
| `lib/code.mjs` | 导出 `stripComments`，供契约检查去注释后搜源码 |

## 结构决策

1. `lib/contract.mjs`：`CONFIG_DEFAULTS` **删掉** `maxDiffLines: 400`；`CONFIG_SCHEMA` 的
   `maxDiffLines: { kind: 'nonNegInt' }` **保留** —— 前者是"默认值"，后者是"可配置且需校验"。
2. `lib/rules.mjs`：预算改为 `ctx.cfg.maxDiffLines`（无 `??`），按组合分支产出 `detail`/`reason`。
3. `tools/check-contract.mjs`：完整性改为**以 `CONFIG_SCHEMA` 为枚举依据**；新增
   「无孤儿默认值」「声明无默认值的键不得有 `??`」两条反向检查。
4. `lib/code.mjs`：`stripComments` 改为导出——契约检查要在源码里搜 `cfg.<key> ??`，
   不去注释会匹配到**自己的说明文字**（实测踩到）。

## 接口契约

配置契约的**单一真源**是 `lib/contract.mjs`：`CONFIG_SCHEMA` 回答"有哪些配置键"，
`CONFIG_DEFAULTS` 只回答"哪些键有默认值"。两者不再是同一张表 —— 这正是本变更的核心结构。

## 关键取舍：为什么不用 `null`

`null` 会让"未配置"与"显式关闭"变成两个语义，还要在值域校验里开特例。
**缺省即未启用**不需要新取值，也不会出现"配了 null 却被当成 400"的歧义。
`0` 保留为「零行预算」，与未启用严格区分（A6/A7 锁死这个区分）。