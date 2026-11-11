# 贡献与 Git 规范

本文件是**可执行约定**，不是建议。发布前跑 `node tools/check-publish.mjs`，它把下面的①②③变成会红的判据。

## ① 行尾：仓库统一 LF

- `.gitattributes` 已声明 `* text=auto eol=lf`，所以**提交进仓库的字节一律 LF**。
- Windows 上编辑后若工作区出现 CRLF，`check-publish` 会指出具体文件；一键修复：

```bash
node tools/check-publish.mjs --fix-lf
```

- 没有 `eslint`/`prettier` 之类的格式化依赖：本项目零依赖，行尾是唯一强制格式项。

## ② 脱敏：这些不许进仓库

| 类别 | 规则 |
| :-- | :-- |
| 本机绝对路径 | 禁止带盘符的绝对路径（Windows 系统目录、工作区目录）与 POSIX 家目录路径出现在文件正文里 |
| 本机身份 | 用户名只允许出现在 `package.json` / `LICENSE` / `CONTRIBUTING.md` 的作者字段 |
| 凭证 | `ghp_` / `gho_` / `github_pat_` / `sk-` / `AKIA…` / 私钥块，一律阻断 |
| 内部拓扑 | `whoiam.md`（DSH 身份卡）与 `evidence.json`（生成产物）必须在 `.gitignore` 里，不入库 |

**为什么连绝对路径也要拦**：它同时泄露用户名、目录结构与工作区布局；而路径一旦进了提交历史，改掉内容也删不掉历史。

## ③ Git 工作流

**分支**

- `main` 永远可发布：上面 8 项自检（`node tools/self-check.mjs`）必须全绿。
- 功能分支 `feat/<slug>`、修复分支 `fix/<slug>`，从 `main` 切出，合并后删除。

**提交信息**（Conventional Commits，subject 用英文祈使句，body 可中文）

```
<type>(<scope>): <subject>

<body：为什么这么改，而不是改了什么>

<footer：BREAKING CHANGE / Refs #id>
```

- `type` ∈ `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci`
- 一个提交只做一件事；**判据语义变更必须单独成提交**，并在 body 里写明"改前误报/漏报是什么"。

**提交前自检（阻断式）**

```bash
node tools/self-check.mjs     # 8 步：3 个测试 + 变异 + 契约漂移 + 证据 + 证据链 + 验收
node tools/check-publish.mjs  # 脱敏 / LF / package.json 结构
```

两者任一非 0 就**不提交**。不接受"先提交后修"。

**改动接口时**

- `lib/contract.mjs` 是单一真源；改它就必须同步 `docs/ICD.md` 与 `README.md`，否则 `check-contract` 报漂移。
- 新增判据必须同时给出：正控（合规输入必须 PASS）、负控（违规输入必须 FAIL）、以及一条变异体（证明判据真的依赖实现）。

## ④ 发布

- `version` 手动维护（本项目不用 release-please）。
- 语义：新增判据 / 改默认阈值 = 次版本；改 `status` 枚举或退出码语义 = 主版本（ICD §8 兼容性承诺）。
- 打 tag：`git tag -a v0.1.0 -m "sdd-guard 0.1.0"` 后 `git push --tags`。

## ⑤ 不欢迎的贡献

- 把判据改软以迁就某段代码（应改代码或走豁免，而不是降阈值）。
- 引入第三方依赖换取"更聪明的"检测——零依赖是本项目的产品约束之一。
- 只加规则不加负控/正控的 PR。