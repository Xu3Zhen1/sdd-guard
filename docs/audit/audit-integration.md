# 自检与接口审计（task-3）

日期：2026-11-13。生产源码与已有测试只读；所有变异、npm 打包、日志与生成证据均在独立副本中。环境：Windows、Node v24.19.0。

## 结论

基线 self-check 为 10/10、exit 0，契约 53/53；不能据此声称全部规格已受 CI 保护。本轮实证 3 项回归门禁缺口、1 项默认扫描遗漏、1 项输入错误分流缺陷，以及 npm 分发的工具依赖不完整。它们不同于“空 change 缺省 exit 0”和启发式扫描等已有边界。

## 可复现命令与证据

从项目根执行（PowerShell）：

```powershell
# 按本会话约定，将 TMP/TEMP 设为工作区内 sdd-guard/_work/tmp 的绝对路径
$env:TMP = (Resolve-Path _work/tmp).Path
$env:TEMP = $env:TMP
node _work/audit-integration-probe.mjs
# 上一步打印 RESULT_DIR；以下用本次实际目录
# 在 RESULT_DIR/repo 内：npm pack --ignore-scripts --pack-destination ..
node _work/audit-integration-package.mjs _work/tmp/audit-integration-1794556559201
```

探针：[audit-integration-probe.mjs](audit-integration-probe.mjs)、[audit-integration-package.mjs](audit-integration-package.mjs)。主探针 exit 0 表示本报告断言全部复现，绝不表示被测对象无缺陷。原始日志集中在 [_work/tmp/audit-integration-1794556559201](tmp/audit-integration-1794556559201/results.json)，该目录由项目忽略规则排除。三个变异均打印 MUTATION_APPLIED，node --check exit 0，完成后副本内容逐字恢复，恢复后 self-check 再次 10/10。

## 新发现缺口

### I-01 高：专项测试未进自检/CI，退出码分流回归仍能全绿

位置：[self-check:66](../tools/self-check.mjs#L66)、[self-check:115](../tools/self-check.mjs#L115)、[cli:179](../cli.mjs#L179)、[CI:43](../.github/workflows/ci.yml#L43)。自检仅执行 guard/args/evidence 三套测试与 mutation；q1、q2、q2-value、q3、q46、q4-5-exit-signal、prove-multiroot 均未直接接入。package scripts 亦仅列三套。

独立副本只将 coverageFail 的 EXIT.INCOMPLETE 改为 EXIT.FAIL：语法通过；self-check **10/10 exit 0**；单独 q4.5 **exit 1**，触发断言差异而非语法崩溃。原因是 coverageGuardNegativeControl 只拒绝 status===0，CI 同样只要求非零，无法守住 ICD 承诺的 3。专项测试能发现错误，但没有成为实际门禁。

日志：[变异自检](tmp/audit-integration-1794556559201/coverage-mutant-selfcheck.log)、[专项红](tmp/audit-integration-1794556559201/coverage-mutant-q45.log)。专项含源码判据，不能夸称其已完整实测真实 CLI 退出链；本次通过真实子进程执行 self-check，证明实际交付门禁漏检。建议接入专项测试，并将负控期望写死为 0/3，检查异常退出与启动失败。

### I-02 高：CI 等价性检查把注释中的文件名当成调用

位置：[check-contract:242](../tools/check-contract.mjs#L242)、[check-contract:246](../tools/check-contract.mjs#L246)。实现从 YAML 正则抽脚本名，再用 scText.includes(f) 判覆盖；未证明语句执行。

把副本 publish steps.push 整行注释：node --check 通过；check-contract **53/53 exit 0**，仍声称覆盖 CI 全部 2 个脚本；self-check **9/9 exit 0**，发布步骤实际消失。并非历史“尚未加入 publish”的重复报告，而是新等价性守卫无法防复发。

日志：[契约假绿](tmp/audit-integration-1794556559201/comment-mutant-contract.log)、[实际少跑一步仍成功](tmp/audit-integration-1794556559201/comment-mutant-selfcheck.log)。建议共享结构化步骤定义或校验真实执行收据；仅去注释仍不能排除死分支/条件路径，不能声称通用等价性。

### I-03 中：退出码一致性检查遗漏 INCOMPLETE

位置：[check-contract:40](../tools/check-contract.mjs#L40)、[runner:32](../lib/runner.mjs#L32)、[contract:19](../lib/contract.mjs#L19)。比较列表仍只有 OK/FAIL/CONFIG。

副本 runner 的 INCOMPLETE 从 3 改为 1：语法通过，check-contract 仍 **53/53 exit 0**。这是明确的契约检查遗漏，原版目前两个常量均为 3，不能报告成“现行 CLI 已错误返回 1”。日志：[exit-mutant-contract](tmp/audit-integration-1794556559201/exit-mutant-contract.log)。建议比较键集合及全部值，并加该负控。

### I-04 高：self-check 默认声明扫描 CLI，但实际漏掉整个文件

位置：[self-check:168](../tools/self-check.mjs#L168)、[rules:1247](../lib/rules.mjs#L1247)、[code:16](../lib/code.mjs#L16)。默认 roots 为 lib、tools、cli.mjs；walkCode 对所有 root 执行 readdir，文件根抛错后吞掉。

真实现 runRules 的 ctx.codeFiles 只有 **14 文件**，cli.mjs 存在但不在集合。验收输出同样是扫描 14 个文件。CLI 的 KISS/DRY/YAGNI 代码级扫描因此未执行，配置本身却未报错。ICD 将 --code 定义为目录，所以“任意外部文件参数都应支持”不是现有承诺；缺陷在自检自身传入文件且默认漏扫。建议让自检改为显式文件枚举，或为扫描器提供经契约定义的文件根支持；不能粗暴扫描仓库根，否则负控夹具会制造误报。

证据：[主探针结果](tmp/audit-integration-1794556559201/results.json)、[验收原始输出](tmp/audit-integration-1794556559201/repo/.selfcheck/acceptance.txt)。

### I-05 中：缺值 --code 以未捕获 TypeError 退出 1，混淆输入错误与质量不合格

位置：[args:23](../lib/args.mjs#L23)、[cli:60](../cli.mjs#L60)、[ICD:64](../docs/ICD.md#L64)。缺值转换为 true 是 S1 已有解析规则，不把解析器本身列为缺陷；CLI 在配置错误 catch 外直接 resolve(true)，触发 ERR_INVALID_ARG_TYPE。

命令为 node cli.mjs check --change <真实空目录> --repo <真实空目录> --json --code。**exit 1 + TypeError**，而非法/缺失参数承诺 exit 2。日志：[missing-code-value](tmp/audit-integration-1794556559201/missing-code-value.log)。建议在消费端统一验证选项类型与必需值，稳定返回 2。

### I-06 中：npm 包能运行 CLI，但随包分发的自检/契约工具依赖未分发内容

位置：[package:12](../package.json#L12)、[self-check:66](../tools/self-check.mjs#L66)、[self-check:163](../tools/self-check.mjs#L163)、[check-contract:234](../tools/check-contract.mjs#L234)。

独立副本 npm pack --ignore-scripts 成功，29 文件；解包后 test/、changes/、.github/workflows/ci.yml 均不存在。node cli.mjs --help exit 0（证明基础 CLI 能加载）；node tools/check-contract.mjs exit 1（缺 workflow），node tools/self-check.mjs exit 1（多项模块/夹具缺失，非功能判据红）。因此不能称整个发布包不可用；问题是 package 暴露 self-check scripts、打包 tools 与默认 evidence.config，却缺它们的仓库级依赖。若明确将这些工具限定为源码开发流程，可以定义为分发设计边界；当前随包文档没有此说明，列为需要修正的分发一致性缺口。

日志：[打包后的契约](tmp/audit-integration-1794556559201/packed-contract.log)、[打包后自检](tmp/audit-integration-1794556559201/packed-selfcheck.log)、[包存在项](tmp/audit-integration-1794556559201/package-presence.json)。建议选择：打包所需开发资产，或剥离/明确标注仓库专用工具并给出包用户的替代工作流。

## 已有边界与本轮不升级为缺陷的项

- 空 change 默认通过，真实子进程 exit 0；显式 --min-coverage 0.8 后 exit 3。原文档与 CLI 注释已明确选择默认关闭，本轮复验，不作为新发现。
- 默认 acceptance 机器覆盖 **7/10**：DECOUPLE-2 因未配置 boundaries，DISCIPLINE-C1/C3 因没有 diff 而 SKIP；另有 2 MANUAL。自检虽 10/10，却未运行这三条分支。CLI 的 skip 语义已公开；自检没有 --diff 转发和 min-coverage，也未提供完整验收收据，属于自检覆盖声明不足，不能把 10/10 换算成全部规则覆盖。
- 未知参数静默保存/忽略、缺值记录 true 是已有宽松解析设计。拼错 --min-covergae 会关闭本想开启的门禁，这是接口设计不足；无契约声明拒绝未知选项时不直接称实现违约。建议提供严格参数校验。
- 启发式扫描、MANUAL 不自动判定、默认 coverage 关闭均是文档已有边界；不重复算新缺陷。
- invariant 模块明确声明全局调用账本和测试 reset，正常 runRules 不重置是累计统计语义，没有将其误列为本轮缺陷。

## 未执行分支与局限

- 本成员未重跑全部七套专项的原版基线；Lead 独立执行并报告全绿（q1 17/q2 7/q2-value 7/q3 6/q46 6/q4.5 8，prove-multiroot exit 0）。本成员只对 q4.5 做了变异负控。
- 没有执行远端 GitHub Actions 六环境矩阵；仅 Windows Node 24 实证，不推断 Linux 或其他 Node 版本行为。
- 未测试 npx 全局安装、发布到 registry、真实消费项目的所有 npm 使用方式；已测本地真实 npm tarball 解包加载。
- 未对全部规则结果结构构造异常返回值/异步规则、未穷举所有配置类型。审计不声称规则层或证据链无缺陷。
- 子进程输出写真实文件描述符，未使用 PIPE；未把沙箱/工具命令转义错误当成产品缺陷。探针首次复制整目录到其子目录被 Node 拒绝，已改按顶层项目枚举复制，失败属于探针基建，不是产品问题。

## 建议优先序

先修默认漏扫和实际门禁覆盖（I-01/I-04）；随后将等价性及退出码守卫做成会红的执行性判据（I-02/I-03）；再统一参数验证与包内工作流说明（I-05/I-06）。所有修复均未在本轮实施。
