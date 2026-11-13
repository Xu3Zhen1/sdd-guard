# 规则与设计独立审计

审计任务：task-1「规则与设计审计」。生产源码与既有测试只读；唯一可执行探针为 [audit-rules-probe.mjs](<audit-rules-probe.mjs>)，夹具与原始输出位于已忽略的同名前缀目录。

## 结论

实际阅读 [rules.mjs](<../lib/rules.mjs>) 全部 1273 行、[md.mjs](<../lib/md.mjs>)、[spec.mjs](<../lib/spec.mjs>)、[code.mjs](<../lib/code.mjs>)，对照 [README](<../README.md>)、[设计依据](<../docs/DESIGN-RATIONALE.md>) 与 [使用说明](<../docs/USAGE.md>)。结果不能解读为全绿验收：独立探针确认 **6 个具体行为缺口**，其中 2 个属于已披露嵌套启发式能力中的新复现缺陷；其余涉及规则承诺与实现不一致或解析隔离不足。

探针共有 **46 次规则调用**：JSON cases 数组 42 条，外加 YAGNI-P1 四次独立调用。17 条机器规则与 6 条人工规则均被直接调用，但这不代表每条规则的全部分支均已覆盖。42 条包含故意断言当前错误行为仍然出现的用例，因此 exit 0 仅证明复现成立，**绝不表示产品无缺陷**。

## 复现命令与证据

在项目根执行：

~~~powershell
node --check _work/audit-rules-probe.mjs
node _work/audit-rules-probe.mjs | Out-File -Encoding utf8 _work/tmp/audit-rules-results.json
~~~

实际结果：语法检查 exit 0；完整探针重复运行 exit 0。三个深度样本还分别经 Node vm.Script 编译成功，排除语法无效造成的漏检。文件读取、代码规则与路径规则使用真实 task-owned 夹具；输入文件集显式非空。原始结果：[audit-rules-results.json](<tmp/audit-rules-results.json>)。探针仅修改 [_work/tmp/audit-rules-fixture](<tmp/audit-rules-fixture>) 下自行创建的夹具；不改生产或已有测试。

## 实测缺口

### R-A：YAGNI-P1 列表分支省略“每条带理由”检查（中）

契约：[README:82](<../README.md#L82>) 要求至少三条且每条有理由；[rules:183](<../lib/rules.mjs#L183>) 标题也承诺每条带理由。

实现：[rules:195](<../lib/rules.mjs#L195>) 表格分支检查第二列；[rules:202](<../lib/rules.mjs#L202>) 列表分支只看条数。

正控：三行有理由表格 PASS。负控：三行空理由表格 FAIL。绕过：非目标小节仅三行“导出 / 缓存 / 多端”的无理由列表，PASS。可复现的规格分支遗漏，并非语义理解难题；即使不判断理由好坏，也应先规定并检查列表理由格式。

### R-B：对象右括号扣减控制流深度，隐藏后续第四层（高）

实现：[code:62](<../lib/code.mjs#L62>) 仅数控制流开括号，[code:64](<../lib/code.mjs#L64>) 却把所有右花括号都从控制流深度中扣除；分类规则位于 [code:189](<../lib/code.mjs#L189>)。

正控：普通四层 if 多行结构，max=4，KISS-C1 FAIL。

反例：三层 if 内插入多行对象字面量，随后再嵌套第四层 if。对象本身不增加控制流深度，但对象结束的右括号会减掉一层，第四层被报为3，KISS-C1 PASS；所有大于3的命中数为0。

[README:214](<../README.md#L214>) 已披露深度是启发式，因此不能宣称 AST 精度；但这是明确的左右计数不对称，而非仅复杂语法不支持。新复现应纳入已知限制与回归。

### R-C：单行四层控制流完全不产生命中（中）

实现：[code:65](<../lib/code.mjs#L65>) 只有进入该行前 depth>0 才保存命中。[code:66](<../lib/code.mjs#L66>) 更新 depth 时同一行的开闭已抵消。

输入：四层 if 全写在一行，合法可编译。nestingDepth 返回 []，KISS-C1 PASS；普通同义多行版本 FAIL。也是已披露启发式中的新具体漏检，无需借助模板字符串等复杂语法。

### R-D：Markdown 代码围栏中的示例标题变成有效章节（中）

实现：[md:21](<../lib/md.mjs#L21>) 对每行直接匹配标题，未跟踪 fenced code 状态；表格也由 [md:100](<../lib/md.mjs#L100>) 直接抽取。

反例：文档正文没有“非目标”章节，仅代码围栏中展示一份含非目标表格的示例。findTopSection 找到该示例章节，YAGNI-P1 PASS。正控：同内容移出围栏，正常真实章节也 PASS。

项目有意采用简化 Markdown 解析，不等于明确声明代码示例可充当真实制品。此处属于新发现的解析隔离不足，可能扩散至读取章节的设计规则；本轮只动态证明 YAGNI-P1，未宣称所有规则均受影响。

### R-E：KISS-S2 只数列表 THEN，同样两行普通 THEN 被判“单断言”（中）

实现：[rules:267](<../lib/rules.mjs#L267>) 先过滤列表项再数 THEN。KISS-S1 对 GWT 的检查却不要求列表格式（[rules:21](<../lib/rules.mjs#L21>)、[rules:241](<../lib/rules.mjs#L241>)）。

正控：一条列表 THEN PASS；负控：两条列表 THEN FAIL；反例：两行普通 THEN（不同断言）PASS 且 detail 声称“均为单断言”。[README:92](<../README.md#L92>) 承诺禁止多条 THEN；[README:215](<../README.md#L215>) 只说混写一行简写可能漏判，不能覆盖本例两行的普通写法。建议统一 S1/S2 接受的格式或显式拒绝不支持格式。

### R-F：块注释内 import 被判真实跨边界依赖（中，假红）

实现：[code:139](<../lib/code.mjs#L139>) 直接对原始文本用正则识别 import，不剔除块注释；[rules:442](<../lib/rules.mjs#L442>) 全部当成真实引用。

正控：前端 import shared 文件 PASS；负控：前端真实 import backend/private 文件 FAIL；反例：唯一 import 已完整包在块注释内，仍 FAIL“1处跨边界直接引用”。注释里没有可执行依赖。并非动态拼接路径这一显式排除范围（[code:128](<../lib/code.mjs#L128>)）。

## 全部规则覆盖矩阵

“对照成立”仅指列出的样本，不代表规则完备。

| 规则 | 本轮直接执行 / 状态 | 结论与主要未覆盖分支 |
|---|---|---|
| YAGNI-P1 | 表格有理由 PASS；空理由 FAIL；无理由列表 PASS；围栏示例 PASS | R-A/R-D；未穷举标题别名、混合表列 |
| YAGNI-P2 | manual | 人工判断，无机器签字验证 |
| KISS-S1 | 完整GWT PASS；缺WHEN FAIL | 对照成立；未穷举中文GWT、多Requirement分片 |
| KISS-S2 | 一THEN PASS；两列表THEN FAIL；两普通THEN PASS | R-E；未穷举中英混写 |
| KISS-D1 | 配置依赖逐一登记 PASS；缺小节 FAIL | 对照成立；不检查依赖选型理由真实性 |
| DRY-D1 | 真实复用路径 PASS；幽灵路径 FAIL | 基础对照成立；跨cwd路径风险由Lead独立汇总 |
| KISS-D2 | manual | 过度设计判断留人工 |
| DRY-T1 | 新建幽灵路径 PASS；未标新建 FAIL | 对照成立；未执行同路径多次出现/逐行标注歧义 |
| DRY-T2 | manual | 是否先提公共函数留人工 |
| DECOUPLE-1 | 共享契约路径存在 PASS；不存在 FAIL | 基础对照成立；未穷举绝对路径/前缀归一 |
| DECOUPLE-2 | 允许共享import PASS；禁止跨端import FAIL；注释import FAIL | R-F；alias映射、动态拼接、非JS详见范围声明 |
| DECOUPLE-3 | manual | 契约语义完整性留人工 |
| ACCEPT-E1 | passed=1/failed=0 PASS；空测试 FAIL | 只调规则层；来源可信性交由证据链审计 |
| ACCEPT-E2 | 8/8且无survivor PASS；6/8且两survivor FAIL | 只调规则层；等价豁免/类型/重复ID/来源未覆盖 |
| ACCEPT-E3 | checks=1/findings=0 PASS；findings=1 FAIL | 只调规则层；来源绑定未覆盖 |
| ACCEPT-E4 | manual | 未执行规格分支自曝，本报告显式列出 |
| KISS-C1 | 普通四层FAIL；对象右括号与单行四层PASS | R-B/R-C；Python/模板字符串/多行注释词法未穷举 |
| DRY-C1 | 两文件同6行 FAIL；不同文件内容 PASS | 对照成立；变量重命名等价代码是已知不支持范围 |
| YAGNI-C1 | TODO:later FAIL；正常源码 PASS | 对照成立；只测固定模式子集，不识别语义投机 |
| DISCIPLINE-C1 | max=10时10行PASS；11行FAIL | 补齐设计文档原列未测预算分支；前缀绕过由Lead汇总 |
| DISCIPLINE-C2 | 干净目录PASS；新增pip-junk目录FAIL | 对照成立；未执行不可读根、其他临时命名/权限分支 |
| DISCIPLINE-C3 | 声明与diff吻合PASS；声明幽灵FAIL；显式codeScopes排除tools PASS | 基本正反例成立；未重跑历史全套启发式对抗与真实业务切片 |
| KISS-C2 | manual | 依赖是否替代新抽象留人工 |

本轮直接执行了设计文档原称未测的两个点：[设计依据:274](<../docs/DESIGN-RATIONALE.md#L274>) codeScopes显式收窄，以及 [设计依据:279](<../docs/DESIGN-RATIONALE.md#L279>) 行数预算边界。这里只证明选定样本，不能据此删除整项未验证说明。

## 正确实现、已知边界与文档漂移

- 人工六条规则均稳定返回manual；没有把它们统计成机器通过。是否永久欠签是 [设计依据:56](<../docs/DESIGN-RATIONALE.md#L56>) 已知缺口。
- C3反向仅按文件名称匹配，不理解“历史提及/声明不改/同名异目录”；[rules:1199](<../lib/rules.mjs#L1199>) 与 [设计依据:200](<../docs/DESIGN-RATIONALE.md#L200>) 已明确承认。本轮不把它重复包装为新缺陷。
- DRY-C1基于行序列、变量重命名抓不到，是 [README:213](<../README.md#L213>) 明确的能力边界。
- import动态拼接路径显式排除；alias映射并无配置解析承诺，未以此直接判为缺陷。本轮只证明注释假红。
- [README:20](<../README.md#L20>) 仍写机器16条，[README:24](<../README.md#L24>) 与真实RULES是17机器+6人工；两档表分别写11条合计22，与23总数不一致。
- [设计依据:291](<../docs/DESIGN-RATIONALE.md#L291>) 仍写契约52、自检8步；[使用说明:191](<../docs/USAGE.md#L191>) 已写10步。属于文档版本漂移，具体接口/CI正确性由integration审计。

## 执行限制与未执行规格分支

没有修改或变异生产实现；本次以独立输入变换检验判别力，因此没有提供“生产变异杀死率”。没有运行全仓self-check、既有mutation或CI，也没有把它们当作本次独立验证依据。

17机器均有规则调用，但多数只取最小正反例；没有穷举每条early-return、异常输入、各项配置类型或多文档分片。未动态覆盖listArtifacts的目录布局组合、不可读/链接/文件根walkCode、Python/Go/Rust/Java的扫描语义、JS alias、多行静态import、模板字符串与regex literal。文件根扫描和非JS扫描由Lead/integration另行审计；证据provenance、生成器解析器、绑定与退出语义由evidence任务负责。路径cwd回退与C1路径穿越由Lead已独立复现，此处不重复计数。

报告中的6项仅表示本轮相对公开设计边界新增的具体复现，不能保证未曾在历史其他会话被记录，也不能声称审计后没有剩余缺陷。
