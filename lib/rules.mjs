// 规则表：每个原则拆成「可机械判定」与「必须人工判断」两类，绝不混为一谈。
// 状态语义是这套东西的核心：
//   pass   = 机器真的检查了，且通过
//   fail   = 机器真的检查了，且不通过
//   skip   = 输入不足/未提供，**不是通过**（空集不构成通过）
//   manual = 本质上不可机械判定，必须人来签字；机器永远不会把它算绿

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { parseOutline, flatten, findTopSection, tableRows, bulletItems, unquote, requirementsOf } from './spec.mjs';
import { walkCode, scanCodeRoots, nestingDepth, duplicateBlocks, speculativeMarks, importSpecifiers, boundaryOfPath, resolveSpecifier } from './code.mjs';
import { assertInvariant } from './invariant.mjs';
import { classifyTest } from './testfiles.mjs';
import { structuralSupported, STRUCTURAL_EXT, scanArch } from './arch.mjs';

/**
 * `KISS-C1` 在**含 `.py` 文件**时使用的标题（2026-11-16，第 ④ 位）。 *
 * ★ 为什么必须按语言分派措辞：`.py` 走 `pyNesting()` —— 只有 8 行 `indent // 4`；
 *   而 JS/TS 走约 200 行的词法状态机（注释/字符串/模板串/正则/括号栈跨行维护）。
 *   **两者不在同一精度等级，却顶着同一句标题「嵌套深度不得超过 N 层」。**
 *
 *   实测（真实 Python 仓 `eda_skill`，30 文件）：工具报 827 处，
 *   用 Python 自己的 `ast` 独立核对 —— 真实超限仅 21 处，**虚报 97.5%**；
 *   其中 96.6% 的命中行根本不是控制流块起点（`return (` 的参数续行、docstring 正文、
 *   列表推导内部）。
 *
 * ★ 关键约束：必须保留 `{maxNesting}` 占位符 —— 它由 `runner.renderTitle()`
 *   用配置值替换。把数字写死会让用户改 `maxNesting` 后标题与阈值不符（更隐蔽的漂移）。
 *
 * ★ 只改措辞，**不改判定**：`pyNesting()` 的实现一行未动。
 *   加正则补丁正是 `jsNesting` 注释里记的 A04 假绿路径（"看起来修了"，换种语法又漏）。
 */
const NESTING_TITLE_PY = '缩进层级不得超过 {maxNesting} 层（按缩进近似，≠ 控制流嵌套）';

/**
 * 把**一个文件**里超过 `limit` 层的行收进 `out`（结构化为 `{file, text}`）。
 *
 * ★ 收集时保留结构化 `{file, text}`，**不要**先拼成字符串再截断 ——
 *   旧实现 `bad.slice(0, 30)` 按出现顺序截断，实测 30 条里 29 条来自单文件，
 *   而实际涉及 15 个文件（第 ⑤ 位）。聚合必须在结构化阶段做。
 *
 * 单独成函数：`KISS-C1` 要按生产/测试两档各收一遍，
 * 内联会形成 `for → for → if` 四层嵌套（自举判据会判红）。
 */
function collectTooDeep(file, ctx, limit, out) {
  for (const h of nestingDepth(file, ctx.readFile(file))) {
    if (h.depth > limit) {
      out.push({ file, text: `${ctx.rel(file)}:${h.line} 深度 ${h.depth} > ${limit}` });
    }
  }
}

/**
 * 把生产/测试两档的命中合成最终判定（第 ⑥ 位）。
 *
 * ★ **生产与测试分别计数**，不混成一个总数：
 *   混在一起会让"83 处测试 + 128 处生产 = 211"看起来像一个整体问题，
 *   而实际是**两类不同性质**的信号。
 *
 * ★ 判定只看**生产档**：测试文件的深嵌套不构成本判据的失败理由
 *   （《零依赖自测脚本 `main()` 里顺序断言》天然深嵌套，那不是可测性缺陷）。
 *   但测试档的命中**必须写进 reason 里**，不许隐藏 —— 否则就是"没检查"冒充"检查了没问题"。
 */
function nestingVerdict({ prod, tests, max, testMax, pyTitle, hasPy, fileCount }) {
  const suffix = hasPy ? '（含 .py 文件：该分支按缩进估算，不等于控制流嵌套）' : '';
  const testNote = tests.length
    ? `；另测试档 ${tests.length} 处超过 ${testMax} 层（不计入失败，见 testNesting）`
    : '';
  if (prod.length) {
    return {
      status: 'fail',
      ...pyTitle,
      reason: `${prod.length} 处超过 ${max} 层${testNote}${suffix}`,
      items: aggregateByFile(prod),
    };
  }
  const detail = tests.length
    ? `扫描 ${fileCount} 个文件：生产档无超限${testNote}${suffix}`
    : `扫描 ${fileCount} 个文件，无超限${suffix}`;
  return { status: 'pass', ...pyTitle, detail };
}

/**
 * `signal = PARTIAL`：该判据**判过的部分**通过，但有子项**未判定**。
 *
 * 与 `pass` 的区别只在措辞层面：`status` 仍是 pass（否则会让"合法证据被接受"
 * 这条既有正控变红、用判据回归换措辞正确），但报告与 `--json` 里带 `signal='partial'`，
 * 使用者能看出"这不是全项通过"。
 *
 * 与 runner 的 `SIGNAL.UNTRUSTED` 正交：那个说"判据坏了"，这个说"判据有一项没看"。
 */
const PARTIAL = 'partial';
import { resolveRepoRef, repoFileExists, withinPrefix, isAbsoluteLike, normalizeRel } from './paths.mjs';
import { isNonNegInt, isPlainObject, readCount } from './values.mjs';

/** GWT 三要素是否齐全（中英双写法）。 */
const GWT_PATTERNS = {
  GIVEN: [/\bGIVEN\b/gi, /给定/g],
  WHEN: [/\bWHEN\b/gi, /当(?:用户|收到|点击|触发)?/g],
  THEN: [/\bTHEN\b/gi, /那么/g],
};

function missingGwt(body) {
  const miss = [];
  for (const [key, res] of Object.entries(GWT_PATTERNS)) {
    const hit = res.some((re) => new RegExp(re.source, re.flags).test(body));
    if (!hit) miss.push(key);
  }
  return miss;
}

/**
 * 抽出所有反引号包裹的片段（不去重、不做路径判定）。
 * 与 `extractPaths` 配合：extractPaths 给出"能识别的"，本函数给出"全部的"，
 * 两者之差就是**被跳过的候选**——必须显式暴露，否则就是静默漏检。
 */
export function backticked(text) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(text))) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 把一组路径归一化，只保留"仓库内、带目录"的项。
 *
 * 抽成独立函数有两个原因：
 *  ① 同一套过滤规则（斜杠归一、裸文件名、绝对路径）在多处复用，
 *     写在循环里会累积嵌套层级，触发项目自己的 KISS-C1；
 *  ② 归一化规则一旦要改（比如将来支持 `~` 开头），只需改这一处。
 */
export function normalizeRefs(paths) {
  const out = [];
  for (const p of paths) {
    const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm.includes('/')) continue; // 裸文件名歧义大，跳过
    if (/^[A-Za-z]:\//.test(norm)) continue; // 本机绝对路径不是仓库内声明
    out.push(norm);
  }
  return out;
}

/**
 * 判断一段文本"像不像文件路径"（用于把被跳过的候选显式报出来）。
 *
 * 比 `extractPaths` 的判定**宽松**：只要含 `/` 或 `\` 且有扩展名就算。
 * 目的不是收窄，而是**别让任何看起来是路径的东西悄悄消失**。
 *
 * 但**必须排除 shell 命令本身**——实测 `git diff -- lib/client.js` 和
 * `node --check lib/client.js lib/index.js` 都被误报成"未校验的路径候选"，
 * 这类提示一多就变成噪音，用户会开始忽略整条通道。
 *
 * ★ 不过**不能把整条命令丢掉**（2026-11-12 第 8 次外部实测）：
 * 命令里往往含**真实路径**，整条丢弃等于给命令行开了后门。实测
 * `node tools/ZZZ-ghost.mjs --x` 和 `git diff -- lib/ZZZ-ghost.js`
 * 里的幽灵路径既不校验、也不进提示 —— 连显式化通道都绕过了。
 *
 * 现在的分工：
 *  - `looksLikePath` 仍返回 false（它回答的是"这整条像不像路径"）；
 *  - 但调用方用 `splitCommandPaths()` 从中**再抽一次子路径**。
 */
export function looksLikePath(v) {
  if (!v) return false;
  if (/\s{2,}/.test(v)) return false;
  if (v.length > 200) return false;
  // 含 `=`/`(`/`{` 之类基本是代码表达式，不是路径
  if (/[=(){}[\],;]/.test(v)) return false;
  const first = v.split(' ')[0];
  if (!first.includes('/') && !first.includes('\\') && !first.includes('.')) return false; // 命令名
  // 含分隔符即认为是路径候选：扩展名不再是必要条件
  // （2026-11-13 Q1：无扩展名文件曾被整条排除，且不进 skipped 提示 ⇒ 静默漏检）
  return /[\\/]/.test(v);
}

/**
 * 从"可能是命令行"的字符串里抽出**子路径**。
 *
 * 用于补 `looksLikePath` 的漏洞：`git diff -- lib/x.js` 整条不是路径，
 * 但里面有一个真路径。按空白切分后对每个 token 单独判定。
 *
 * 例：
 *   `node tools/run-smoke.mjs --filter=lock` → ['tools/run-smoke.mjs']
 *   `git diff -- lib/client.js`             → ['lib/client.js']
 */
export function splitCommandPaths(v) {
  if (!v) return [];
  const out = [];
  // 引号感知 token 化：引号内的空白不切分
  // （2026-11-13 Q1：`"src/export/ghost probe.js"` 曾被切成两片残片后全部丢弃）
  // 把"引号内"的空白替换成占位符后再切分 —— 避免嵌套 if/else 链（KISS-C1 深度上限 3）
  const SENTINEL = '\u0000';
  let quote = null;
  let flat = '';
  for (const ch of v) {
    const isQuoteChar = ch === '"' || ch === "'";
    // 引号字符本身丢弃（只作状态切换）；引号内的空白转占位符，避免被切分
    const closing = isQuoteChar && quote === ch;
    const opening = isQuoteChar && !quote;
    if (closing) quote = null;
    if (opening) quote = ch;
    if (!isQuoteChar) flat += quote && /\s/.test(ch) ? SENTINEL : ch;
  }
  const tokens = flat.split(/\s+/).map((t) => t.split(SENTINEL).join(' '));
  for (const t of tokens) {
    if (!t) continue;
    if (looksLikePath(t)) out.push(t);
  }
  return out;
}

/**
 * 从文本里抽取"看起来是路径"的片段（反引号包裹）。
 *
 * ★ **必须支持 Unicode**（2026-11-12 外部实测发现的第 6 个缺陷）。
 *
 * 历史缺陷：第三分支用的是 `[\w.@-]`，而 JS 里 `\w` **只匹配 [A-Za-z0-9_]**，
 * 不含任何非 ASCII 字符。后果不是"漏看一个文件"，而是**整条路径完全脱离管辖**：
 *
 *   lib/ascii-only.js            → 识别
 *   lib/中文路径.js               → 跳过（全中文文件名）
 *   lib/ZZZ-mixed-中文.js         → 跳过（混合）
 *   幽灵目录/ghost-file.js        → 跳过（**中文目录 + ASCII 文件名**）
 *   文档/note.md                  → 跳过
 *
 * 中文目录下放纯 ASCII 文件同样被跳过——这一条最容易漏想。
 * 对中文项目这是**系统性失效**，而且 C3 会把它算进"全部落地"，
 * **以肯定句式的假绿报告**，比不报更糟。
 *
 * 修法：用 `\p{L}\p{N}` + `u` flag 覆盖任意语言的字母与数字。
 */
export function extractPaths(text) {
  const out = new Set();
  const re = /`([^`\n]+)`/g;
  // 路径段：任意语言的字母/数字 + 常见文件名字符
  const SEG = '[\\p{L}\\p{N}_.@-]';
    // 2026-11-13 R3-b：扩展名不再是必要条件 —— 只要有路径分隔符即视为候选。
  // 无扩展名文件（src/export/extless/index）曾被整条排除且不进 skipped 提示 ⇒ 静默漏检。
  const pathRe = new RegExp(`^${SEG}+([\\\\/]${SEG}+)+`, 'u');
  let m;
  while ((m = re.exec(text))) {
    const v = m[1].trim();
    if (!v || /\s{2,}/.test(v)) continue;
    if (/^[A-Za-z]:[\\/]/.test(v)) out.add(v);
    else if (v.startsWith('./') || v.startsWith('../')) out.add(v);
    else if (pathRe.test(v)) out.add(v);
  }
  return [...out];
}

function resolveFrom(base, p) {
  return isAbsoluteLike(p) ? p : resolve(base, p);
}

/**
 * KISS-S2 的逐 Scenario 扫描（A05 · R-E）。
 *
 * 旧实现只数**列表项**里的 THEN：
 *   两行普通文本 `THEN done` / `THEN other` ⇒ PASS，且 detail 还声称「均为单断言」。
 * 同一个规格，写成列表就红、写成普通行就绿 —— 判定被格式开关左右（README 承诺禁止多条 THEN）。
 * 修法：按**出现次数**数 THEN，不要求列表格式；与 KISS-S1 的口径一致。
 *
 * 0 条 THEN 不是本条判据的事（GWT 缺失由 KISS-S1 报），但**也不能算"单断言通过"**：
 * 没有断言就没有可数的东西，所以单独记入 unjudged，避免 detail 用肯定句式掩盖未判定。
 */
function thenAssertionScan(sp, acc) {
  for (const req of requirementsOf(sp.text)) {
    for (const sc of req.scenarios) {
      acc.n++;
      const thenHits = (sc.body.match(/\bTHEN\b|那么/g) || []).length;
      if (thenHits > 1) acc.problems.push(`${sp.name} →「${sc.title}」有 ${thenHits} 条 THEN`);
      if (thenHits === 0) acc.unjudged.push(`${sp.name} →「${sc.title}」`);
    }
  }
}

/**
 * DISCIPLINE-C1 的越界判定（A02 + A03）：
 *   ① 路径先词法归一，再按**段边界**判前缀 —— `src/../outside.js` 与 `srcx/x.js` 都不再命中 `src/`；
 *   ② 绝对路径与越界点段本身就算越界（引用写法不合法，不能读成"在范围内"）。
 */
function outOfPrefixRows(rows, allowed) {
  const problems = [];
  for (const r of rows) {
    const ref = resolveRepoRef(String(r.path ?? ''));
    if (!ref.ok) {
      problems.push(`越界修改: ${r.path}（${ref.reason}）`);
      continue;
    }
    if (!allowed.some((a) => withinPrefix(ref.rel, a))) {
      problems.push(`越界修改: ${r.path}（归一后 ${ref.rel}，不在 ${allowed.join(' / ')} 内）`);
    }
  }
  return problems;
}

/**
 * 按**列表项段落**（而不是按行）切分 Markdown 文本。
 *
 * 为什么必须按段落：Markdown 里一个列表项常折成两三行，
 * 「检查」这个动词在**首行**、而路径在**续行**。按行判断时续行既没有"检查"也没有"不改"，
 * 于是它的路径被当成"声明要改"⇒ 误报「声明了但没改」。按段落则整条一起被识别。
 *
 * 判定规则：
 *   · `- * + 1.` 开头 ⇒ 新段落
 *   · 制表符或 ≥2 空格开头的续行 ⇒ 归入当前段落（单个空格仍视为普通文本）
 *   · 其余 ⇒ 结束当前段落
 */
function toListBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const isItem = /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
    const isCont = (/^\t+\s*\S/.test(line) || /^\s{2,}\S/.test(line)) && cur;
    if (isItem) {
      if (cur) blocks.push(cur);
      cur = line;
    } else if (isCont) {
      cur += '\n' + line;
    } else {
      if (cur) blocks.push(cur);
      cur = null;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/**
 * DISCIPLINE-C3 的「从一条列表项段落里抽取声明」。
 *
 * 三条语义必须同时成立（每一条都来自一次真实假绿）：
 *
 * ① `NOT_CHANGING` **不把路径移出 declared**。
 *    注入形态：`修改 src/util/text.js 的归一化（日志格式不适用本次封装）`
 *    —— "不适用"修饰的是**日志格式**，而这个文件**确实要改**。
 *    把它降级为"只查存在性"后文件真实存在 ⇒ PASS ⇒ 真问题被吞。
 *    正确语义：豁免词只影响人类阅读，路径一律进 declared，由主判据「声明了但没改」判定。
 *
 * ② 纯取证项（句首取证动词 **且** 块内无"要改"表述）是唯一合法的"不要求被改"通道。
 *    这就是修 RECON_HEAD 后门的做法：`确认 lib/ZZZ.js 需要改动` 仍进 declared。
 *
 * ③ 命令行里的子路径只做存在性校验。
 *    `node tools/ZZZ-ghost.mjs --x` 里的幽灵路径以前既不校验也不提示。
 *    但**不能把所有反引号内容都当命令行** —— 普通声明 `src/util/text.js` 也是反引号内容，
 *    全归进"只查存在性"会让主判据整体失效。判据：整串不像路径、但拆出的 token 像路径。
 */
function collectFromBlock(block, acc) {
  const reconHeadHit = RECON_HEAD.test(block);
  const isRecon = reconHeadHit && !WANTS_CHANGE.test(block);
  const found = extractPaths(block);
  for (const p of found) {
    const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm.includes('/')) continue; // 裸文件名跳过，避免误伤
    if (/^[A-Za-z]:\//.test(norm)) continue; // 本机绝对路径不是仓库内声明
    if (isRecon) acc.reconRefs.push(norm);
    else acc.declared.add(norm);
    // 句首取证动词但块内有"要改"表述 ⇒ 自相矛盾句，额外接受幻觉路径检查
    if (!isRecon && reconHeadHit) acc.reconRefs.push(norm);
  }
  for (const raw of backticked(block)) {
    if (!looksLikePath(raw)) acc.reconRefs.push(...normalizeRefs(splitCommandPaths(raw)));
    else if (!found.includes(raw)) acc.skipped.push(raw); // ③ 显式化：不能静默消失
  }
}

/**
 * DISCIPLINE-C3 反向匹配用的裸文件名集合。
 *
 * 文档常写短名（`smoke-test-r26-cross-layer`），而 diff 里是完整路径
 * （`tests/smoke/smoke-test-r26-cross-layer.mjs`）。反向匹配必须接受裸文件名，
 * 否则真实切片会被误报成「改了但文档没提」——实测 3 个切片都栽在这里。
 *
 * 取证/不改的块不计入：那些行说的是"我看过了、决定不动它"，不是"这次改了"。
 */
function collectBareNames(block, bareNames) {
  if (NOT_CHANGING.test(block) || RECON_HEAD.test(block)) return;
  for (const p of extractPaths(block)) {
    const base = String(p).replace(/\\/g, '/').split('/').pop();
    bareNames.add(base);
    // 去掉扩展名：文档写 `smoke-test-x`，实际文件是 `smoke-test-x.mjs`
    bareNames.add(base.replace(/\.[A-Za-z0-9]{1,6}$/, ''));
  }
}

/**
 * DISCIPLINE-C3 的三组语义正则（模块级：`collectFromBlock` 与 `collectBareNames` 都要用）。
 */

/**
 * 「这条整条不做」的措辞。**只认整体否定**：
 * 拿去掉了 `不动` / `排除` / `保持原样` 这些既可修饰整体又可修饰局部的词 ——
 * 宽词会吞掉真修改（`在 lib/x.js 末尾增加 export（实现不动）` 里"不动"修饰的是实现，
 * 而它确实要改这个文件），实测会让 C3 变成永真。
 */
const NOT_CHANGING = /(不适用|不并入|不合并|不在本片范围|不需要修改|无需修改|不修改此文件|刻意不并入|不属于本次|不纳入)/;

/**
 * 取证/确认句式：**锚定在列表项的句首动词**，不做全段包含匹配。
 *
 * 关键区别（负控暴露）：
 *   T1 `确认 lib/config-lock.js 与 lib/shared-state-lock.js 逐字节相同` ← 取证，应过滤
 *   T4 `在 lib/shared-state-lock.js 末尾增加 export { claim }`          ← **真修改，必须保留**
 * 若用"整段包含'确认'"判断，段落级合并会把 T4 一起吞掉 ⇒ C3 变成永真。
 * 修法：只剥掉列表符号与任务编号，再看**紧跟的第一个词**是不是取证动词。
 */
const RECON_HEAD =
  /^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?(?:[A-Z]{1,3}\d+[a-z]?\s+)?(检查|确认|核对|复核|实测|grep|记录|查看|取证|统计|复算|对拍)/;

/**
 * 「要改」表述 —— 取证句式的**否决条件**。
 *
 * 句首写「确认」曾是完整豁免：`确认 lib/x.js 需要改动` 判 PASS，
 * 同一句改成「修改」立刻 FAIL ⇒ 判定被一个可自由选择的动词开关。
 * 收紧为双条件：句首是取证动词 **且** 块内不含"要改"表述。
 */
const WANTS_CHANGE = /(需要改动|需要修改|需要调整|要改|改为|改成|替换为|新增|增加|删除|移除|重写|实现)/;

/** 抽出一条 spec 里的 GWT 问题，并累加计数（KISS-S1 用；拆函数是为了不超嵌套上限）。 */
function gwtProblems(sp, stats) {
  const problems = [];
  for (const req of requirementsOf(sp.text)) {
    stats.reqs++;
    if (!req.scenarios.length) {
      problems.push(`${sp.name}:「${req.title}」无 Scenario`);
      continue;
    }
    for (const sc of req.scenarios) {
      stats.scens++;
      const miss = missingGwt(sc.body);
      if (miss.length) problems.push(`${sp.name}:「${req.title}」→「${sc.title}」缺 ${miss.join('/')}`);
    }
  }
  return problems;
}

/**
 * 把一条列表项拆成「事项 / 理由」（A05）。
 *
 * 接受的分隔符：`——` `—` `–` `：` `:` `|`。
 * 必须在事项**非空且理由非空**时才算"带理由"——
 * `- 导出 ——` 这种只有分隔符的不算。
 *
 * 返回 `{ item, reason }` 或 null。
 */
export function splitReason(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^(.+?)\s*(?:——|—|–|：|:|\|)\s*(.+)$/.exec(s);
  if (!m) return null;
  const item = m[1].trim();
  const reason = m[2].trim();
  if (!item || !reason) return null;
  return { item, reason };
}

export const RULES = [
  // ---------------- 提案阶段 ----------------
  {
    id: 'YAGNI-P1',
    principle: 'YAGNI',
    stage: 'proposal',
    decidability: 'machine',
    title: '提案必须显式声明「不做的事」，且每条带理由',
    why: '没有非目标就没有可反驳的范围，AI 会把所有"顺带做得到"的东西都塞进来。',
    run(ctx) {
      const f = ctx.art.files['proposal.md'];
      if (!f) return { status: 'skip', reason: '未提供 proposal.md' };
      const outline = parseOutline(f.text);
      // 按特异性从高到低找，避免「变更范围」这类泛标题把「非目标」抢走
      const sec =
        findTopSection(outline, /(非目标|不做(的)?事|out\s*of\s*scope|non-?goals?)/i) ||
        findTopSection(outline, /(不做什么|明确不做|excluded)/i);
      if (!sec) return { status: 'fail', reason: '缺少「非目标 / 不做的事」小节（只有"范围"不算，必须写明不做的事）' };
      const need = ctx.cfg.yagniMinNonGoals ?? 3;
      const rows = tableRows(sec.raw).filter((r) => r.length >= 2 && r[0]);
      if (rows.length) {
        if (rows.length < need) return { status: 'fail', reason: `非目标表格仅 ${rows.length} 行，需 ≥ ${need}` };
        const noReason = rows.filter((r) => !(r[1] && r[1].trim()));
        if (noReason.length) return { status: 'fail', reason: `${noReason.length} 条非目标缺「为什么不做」`, items: noReason.map((r) => r[0]) };
        return { status: 'pass', detail: `${rows.length} 条非目标，均带理由` };
      }
      /**
       * 列表分支（A05 · R-A）。
       *
       * 旧实现只看条数：三行完全无理由的 `- 导出 / - 缓存 / - 多端` ⇒ PASS，
       * 而同内容的表格（理由列为空）⇒ FAIL。**同一条规格，两种格式两种判据**，
       * 使用者只要换成列表写法就绕过了"每条带理由"。
       *
       * 修法：列表项必须写成 `事项 —— 理由`（或 `：` / `—` / `:` 分隔）。
       * 判定理由是否"业务上充分"仍是人的事，这里只要求**结构上存在理由字段**。
       */
      const bullets = bulletItems(sec.raw);
      if (bullets.length >= need) {
        const noReason = bullets.filter((b) => !splitReason(b));
        if (noReason.length) {
          return {
            status: 'fail',
            reason: `${noReason.length} 条非目标列表项缺「为什么不做」（列表项须写成「事项 —— 理由」）`,
            items: noReason.slice(0, 10),
          };
        }
        return { status: 'pass', detail: `${bullets.length} 条非目标（列表），均带理由` };
      }
      return { status: 'fail', reason: `非目标不足（表格 ${rows.length} 行 / 列表 ${bullets.length} 条），需 ≥ ${need}` };
    },
  },
  {
    id: 'YAGNI-P2',
    principle: 'YAGNI',
    stage: 'proposal',
    decidability: 'manual',
    title: '非目标是否真的被裁掉（而非只是没写）',
    why: '机器只能看"有没有写"，看不出"该砍的砍了没有"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 规范阶段 ----------------
  {
    id: 'KISS-S1',
    principle: 'KISS',
    stage: 'specs',
    decidability: 'machine',
    title: '每条 Requirement 至少一个 Scenario，且 GIVEN/WHEN/THEN 齐全',
    why: '写不出 Given/When/Then 的需求，就是测试写不出来的需求。',
    run(ctx) {
      if (!ctx.art.specs.length) return { status: 'skip', reason: '未提供 specs/*.md' };
      const problems = [];
      const stats = { reqs: 0, scens: 0 };
      for (const sp of ctx.art.specs) problems.push(...gwtProblems(sp, stats));
      // 零 Requirement 不等于通过
      if (stats.reqs === 0) return { status: 'fail', reason: '未解析到任何 Requirement（空集不构成通过）' };
      if (problems.length) return { status: 'fail', reason: `${problems.length} 处不合格`, items: problems };
      return { status: 'pass', detail: `${stats.reqs} 条 Requirement / ${stats.scens} 个 Scenario 全部合格` };
    },
  },
  {
    id: 'KISS-S2',
    principle: 'KISS',
    stage: 'specs',
    decidability: 'machine',
    title: '单个 Scenario 只描述一个行为（禁止一个场景多条 THEN）',
    why: '一个场景多个 THEN，失败时无法定位是哪条行为坏了。',
    run(ctx) {
      if (!ctx.art.specs.length) return { status: 'skip', reason: '未提供 specs/*.md' };
      const acc = { problems: [], unjudged: [], n: 0 };
      for (const sp of ctx.art.specs) thenAssertionScan(sp, acc);
      if (acc.n === 0) return { status: 'fail', reason: '未解析到任何 Scenario（空集不构成通过）' };
      if (acc.problems.length) return { status: 'fail', reason: `${acc.problems.length} 处多断言场景`, items: acc.problems };
      if (acc.unjudged.length === acc.n) {
        return { status: 'skip', reason: `${acc.n} 个 Scenario 均无 THEN，无断言可数（GWT 缺失由 KISS-S1 报）` };
      }
      return {
        status: 'pass',
        detail: `${acc.n} 个 Scenario 中 ${acc.n - acc.unjudged.length} 个有断言且为单断言${acc.unjudged.length ? `；${acc.unjudged.length} 个无 THEN 未判定` : ''}`,
        ...(acc.unjudged.length ? { items: acc.unjudged.slice(0, 10).map((x) => `未判定（无 THEN）: ${x}`) } : {}),
      };
    },
  },

  // ---------------- 设计阶段 ----------------
  {
    id: 'KISS-D1',
    principle: 'KISS',
    stage: 'design',
    decidability: 'machine',
    title: '新增第三方依赖必须逐个登记「标准库为什么不行」',
    why: 'AI 引入依赖成本为零，审查成本全在你身上。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(依赖|dependenc)/i);
      const declared = Object.keys(ctx.cfg.dependencies || {});
      if (!sec) {
        if (declared.length === 0) return { status: 'pass', detail: '设计未声明新依赖，配置中也无新增依赖' };
        return {
          status: 'fail',
          reason: `配置声明了 ${declared.length} 个依赖（${declared.join(', ')}），design.md 缺少依赖小节`,
          items: declared.map((d) => `未登记: ${d}`),
        };
      }
      const rows = tableRows(sec.raw);
      if (declared.length && !rows.length) {
        return {
          status: 'fail',
          reason: `配置声明了 ${declared.length} 个依赖，但依赖小节没有表格逐一登记（未登记: ${declared.join(', ')}）`,
          items: declared.map((d) => `未登记: ${d}`),
        };
      }
      const covered = new Set(rows.map((r) => unquote(r[0] || '')));
      const missing = declared.filter((d) => !covered.has(d));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 个依赖未登记理由`, items: missing.map((d) => `未登记: ${d}`) };
      const noWhy = rows.filter((r) => !(r[1] && r[1].trim()));
      if (noWhy.length) return { status: 'fail', reason: `${noWhy.length} 行依赖缺「标准库为什么不行」`, items: noWhy.map((r) => r[0]) };
      return { status: 'pass', detail: declared.length ? `${declared.length} 个依赖均已登记` : '无新增依赖，小节存在且为空表' };
    },
  },
  {
    id: 'DRY-D1',
    principle: 'DRY',
    stage: 'design',
    decidability: 'machine',
    title: '复用清单必须是真实存在的路径，不能只写「已检索」',
    why: '"我检索过现有代码" 无法验证；可验证的是：列出的文件真的在仓库里。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(复用|reuse)/i);
      if (!sec) return { status: 'fail', reason: '缺少「复用清单」小节（DRY 前置动作未执行）' };
      const paths = extractPaths(sec.raw);
      const need = ctx.cfg.dryMinReuse ?? 1;
      if (paths.length < need) return { status: 'fail', reason: `复用清单仅 ${paths.length} 条路径，需 ≥ ${need}` };
      // 路径基准是**项目根**：design/tasks 里的路径都相对仓库根写，不是相对 change 目录
      const missing = paths.filter((p) => !ctx.existsProjectFile(p));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 条复用路径不存在（基准: ${ctx.repo}）`, items: missing };
      return { status: 'pass', detail: `${paths.length} 条复用路径全部真实存在` };
    },
  },
  {
    id: 'KISS-D2',
    principle: 'KISS',
    stage: 'design',
    decidability: 'manual',
    title: '架构是否过度设计（模式、分层、抽象是否被任务真正需要）',
    why: '机器分不清"合理分层"与"炫技分层"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 任务阶段 ----------------
  {
    id: 'DRY-T1',
    principle: 'DRY',
    stage: 'tasks',
    decidability: 'machine',
    title: '任务引用的文件路径必须存在，或显式标注为新建',
    why: '路径写错会让 AI 去创造重复文件——这是重复劳动最常见的来源。',
    run(ctx) {
      const f = ctx.art.files['tasks.md'];
      if (!f) return { status: 'skip', reason: '未提供 tasks.md' };
      const paths = extractPaths(f.text);
      if (!paths.length) return { status: 'fail', reason: 'tasks.md 未给出任何具体文件路径（无法执行，也无法查重）' };
      const problems = [];
      for (const p of paths) {
        if (ctx.existsProjectFile(p)) continue;
        const line = f.text.split(/\r?\n/).find((l) => l.includes(p)) || '';
        if (!/(新建|新增|create|new file)/i.test(line)) problems.push(`${p}（不存在，且未标注新建）`);
      }
      if (problems.length) return { status: 'fail', reason: `${problems.length} 条路径无法定位（基准: ${ctx.repo}）`, items: problems };
      return { status: 'pass', detail: `${paths.length} 条路径均可定位或已标注新建` };
    },
  },
  {
    id: 'DRY-T2',
    principle: 'DRY',
    stage: 'tasks',
    decidability: 'manual',
    title: '任务拆解是否需要先抽公共函数再继续',
    why: '依赖任务语义，机器无法可靠判断"这两个任务在造同一个轮子"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 前后端解耦 ----------------
  {
    id: 'DECOUPLE-1',
    principle: 'DECOUPLING',
    stage: 'design',
    decidability: 'machine',
    title: '设计必须声明「接口契约真源」，且路径真实存在',
    why: '前后端解耦的落点是**契约单一真源**：类型/字段/错误码只写一处，两侧各自生成或引用。只写"前后端分离"不算。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(接口契约|API\s*契约|contract|schema|dto)/i);
      if (!sec) return { status: 'fail', reason: '缺少「接口契约」小节（前后端解耦没有声明契约真源）' };
      const paths = extractPaths(sec.raw);
      if (!paths.length) return { status: 'fail', reason: '「接口契约」小节没有给出任何具体文件路径（无法验证单一真源）' };
      const missing = paths.filter((p) => !ctx.existsProjectFile(p));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 条契约路径不存在`, items: missing };
      // 契约文件若同时被两侧各自定义，等于没有真源：要求契约路径落在共享/契约目录
      const sharedPrefixes = ctx.cfg.contractPrefixes || [];
      if (sharedPrefixes.length) {
        const outside = paths.filter((p) => !sharedPrefixes.some((pre) => p.replace(/\\/g, '/').startsWith(pre)));
        if (outside.length) {
          return {
            status: 'fail',
            reason: `${outside.length} 条契约路径不在契约目录（应位于 ${sharedPrefixes.join(' / ')}）`,
            items: outside,
          };
        }
      }
      return { status: 'pass', detail: `${paths.length} 条契约路径真实存在${sharedPrefixes.length ? '且在契约目录内' : ''}` };
    },
  },
  {
    id: 'DECOUPLE-2',
    principle: 'DECOUPLING',
    stage: 'code',
    decidability: 'machine',
    title: '前后端不得直接引用对方内部路径（import 边界）',
    why: '一旦前端 import 后端内部模块，两侧就无法独立部署与替换；解耦退化成"同一个进程里的两堆文件"。',
    run(ctx) {
      const boundaries = ctx.cfg.boundaries || {};
      const forbids = ctx.cfg.forbidImports || [];
      if (!Object.keys(boundaries).length) return { status: 'skip', reason: '未配置 boundaries（无法判定边界）' };
      if (!forbids.length) return { status: 'skip', reason: '未配置 forbidImports（无禁止规则）' };
      if (!ctx.codeFiles.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };

      const violations = [];
      let checkedImports = 0;
      // 边界前缀按 **repo 相对路径** 匹配，不能按 cwd 相对路径——
      // 否则 `--repo` 指向别处（如夹具目录）时，所有文件都会落到边界之外，检查静默变成空集。
      const relRepo = (p) => ctx.relRepo(p);
      for (const f of ctx.codeFiles) {
        const fromRel = relRepo(f);
        const fromBoundary = boundaryOfPath(fromRel, boundaries);
        if (!fromBoundary) continue;
        const text = ctx.readFile(f);
        for (const spec of importSpecifiers(f, text)) {
          const r = resolveSpecifier(spec, f, ctx.repo);
          let toRel = null;
          if (r.kind === 'relative') toRel = relRepo(r.abs);
          else if (r.kind === 'absolute') toRel = r.abs.replace(/\\/g, '/');
          const toBoundary = toRel ? boundaryOfPath(toRel, boundaries) : boundaryOfPath(spec, boundaries);
          if (!toBoundary) continue;
          checkedImports++;
          const banned = forbids.some((p) => (Array.isArray(p) ? p[0] === fromBoundary && p[1] === toBoundary : p.from === fromBoundary && p.to === toBoundary));
          if (banned) violations.push({ file: f, text: `${fromRel} → ${toBoundary}: ${spec}` });
        }
      }
      if (checkedImports === 0) {
        return { status: 'skip', reason: `扫描 ${ctx.codeFiles.length} 个文件，但没有任何跨边界 import（空集不构成通过）` };
      }
      if (violations.length) {
        return { status: 'fail', reason: `${violations.length} 处跨边界直接引用`, items: aggregateByFile(violations) };
      }
      return { status: 'pass', detail: `${checkedImports} 处跨边界引用，均未命中禁止规则` };
    },
  },
  {
    id: 'DECOUPLE-3',
    principle: 'DECOUPLING',
    stage: 'design',
    decidability: 'manual',
    title: '契约是否覆盖了所有跨端通道（字段/错误码/分页/枚举/空值语义）',
    why: '机器能查"有没有契约文件"，查不出"契约是否完整到足以让两侧独立开发"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 验收证据（acceptance 档）----------------
  // 与上面所有判据的区别：这些判据**不自己生产证据**，只读外部提交的 evidence。
  // 自己跑测试再去判自己跑的结果 = 用被测对象的成绩单判自己合格。
  {
    id: 'ACCEPT-E1',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '测试证据：全绿且样本非空',
    why: 'passed=0 的"全绿"与"没跑"同形；只有 passed>0 且 failed=0 才是证据。',
    run(ctx) {
      const t = ctx.evidence && ctx.evidence.tests;
      if (!t) return { status: 'skip', reason: '未提供 evidence.tests（验收档必须给证据）' };
      /**
       * ★ A02：计数只接受非负安全整数。
       *
       * 旧实现 `Number(t.passed)` 的三条假绿（审计实测）：
       *   passed=-1 / failed=-1   ⇒ PASS，报告写「-1 通过 / 0 失败」
       *   passed=true / failed=null ⇒ PASS（Number(true)=1, Number(null)=0）
       *   passed 是数组/对象        ⇒ 隐式转换后偶然通过
       * 判据：**类型错了不是"值等于 0"**，必须当场判 FAIL 并说清哪一项坏了。
       */
      const pv = readCount(t, 'passed', 'evidence.tests');
      if (!pv.ok) return { status: 'fail', reason: pv.reason };
      const fv = readCount(t, 'failed', 'evidence.tests');
      if (!fv.ok) return { status: 'fail', reason: fv.reason };
      const passed = pv.value;
      const failed = fv.value;
      // 总数与分项自洽：给了 total 就必须等于 passed+failed（宽容 skipped/todo）
      if (t.total !== undefined) {
        const tv = readCount(t, 'total', 'evidence.tests');
        if (!tv.ok) return { status: 'fail', reason: tv.reason };
        if (tv.value < passed + failed) {
          return {
            status: 'fail',
            reason: `测试证据自相矛盾：passed(${passed}) + failed(${failed}) = ${passed + failed} > total(${tv.value})`,
          };
        }
      }
      if (failed > 0) return { status: 'fail', reason: `${failed} 个测试失败` };
      if (passed === 0) return { status: 'fail', reason: 'passed=0：空样本不构成通过' };
      return { status: 'pass', detail: `${passed} 通过 / 0 失败${t.skipped ? ` / ${t.skipped} 跳过` : ''}` };
    },
  },
  {
    id: 'ACCEPT-E2',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '变异证据：杀死率 ≥ {minMutationRatio}',
    why: '测试全绿不等于判据有判别力；变异杀不死说明测试没测到那段实现。',
    run(ctx) {
      const m = ctx.evidence && ctx.evidence.mutation;
      if (!m) return { status: 'skip', reason: '未提供 evidence.mutation' };
      const killed = Number(m.killed);
      const total = Number(m.total);
      const min = ctx.cfg.minMutationRatio ?? 0.8;
      if (!Number.isFinite(killed) || !Number.isFinite(total)) {
        return { status: 'fail', reason: 'evidence.mutation 的 killed/total 不是数字' };
      }
      if (total === 0) return { status: 'fail', reason: 'total=0：没有变异体，空集不构成通过' };

      // 等价变异豁免：从分母扣除。硬阈值遇到物理不可杀的变异必然误红（实测：
      // `String(s) === s` 恒真、`toBuffer` 字节相同仅引用不同）。
      // 但豁免必须留痕：每条要 reason，理由空的直接判 FAIL，防止随手静音。
      const declared = Array.isArray(ctx.cfg.equivalentMutants) ? ctx.cfg.equivalentMutants : [];
      /**
       * 豁免必须留痕：id 与 reason 都要是**非空字符串**，且 id 要规范化。
       *
       * 为什么必须做类型校验（2026-11-12 外部实测暴露的绕过）：
       * 早期写成 `!String(e.reason).trim()`，它只能拦 null/undefined/空串/纯空白，
       * 拦不住非字符串 —— `{}`→"[object Object]"、`123`→"123"、`true`→"true"、
       * `[1,2]`→"1,2"，全都"非空"从而让豁免生效。
       * 实测：killed=7 total=8 只豁免 S1，reason 传 `{}` 就能把 ACCEPT-E2
       * 从 FAIL 翻成 PASS —— 留痕设计被绕过，等于"随便填个值就放行"。
       */
      const badDecl = declared.filter((e) => {
        if (!e || typeof e !== 'object') return true;
        if (typeof e.id !== 'string' || !e.id.trim()) return true;
        if (typeof e.reason !== 'string' || !e.reason.trim()) return true;
        return false;
      });
      if (badDecl.length) {
        return {
          status: 'fail',
          reason: `equivalentMutants 有 ${badDecl.length} 条 id/reason 不是非空字符串（豁免必须留痕，不能用对象/数字/布尔绕过）`,
          items: badDecl.slice(0, 10).map((e) => `无效声明: ${JSON.stringify(e)}`),
        };
      }
      // id 去空白后再比对，避免 {" S1 "} 这种写法悄悄失效或悄悄生效。
      const exemptIds = new Set(declared.map((e) => e.id.trim()));
      /**
       * 重复声明：trim 后重复的 id 只算一个。
       *
       * 从 Set 去重的行为是对的（绝不重复扣分母），但**不提示就是静默**——
       * 用户写了 2 条 [S1, "S1 "]，以为豁免了 2 个，实际只扣 1 个，
       * 而报告里只说"扣除 1 个"，看不出为什么。
       * 这里把合并掉的数量显式说出来（外部实测建议，2026-11-12）。
       */
      const dupMerged = declared.length - exemptIds.size;

      const survived = Array.isArray(m.survived) ? m.survived : [];
      // 存活项的 id 是首段（如 "M11" / "S3"）；只有真出现在 survived 里的豁免才算数。
      const survivedIds = survived.map((s) => String(s).trim().split(/[\s:：]/)[0]);
      const hitExempt = survivedIds.filter((id) => exemptIds.has(id));
      const notSurvived = [...exemptIds].filter((id) => !survivedIds.includes(id));

      /**
       * 证据自洽性：killed + survived 必须恰好等于 total。
       *
       * 不校验的后果（2026-11-12 自测发现）：killed=7 total=8 survived 只列 2 个时，
       * 扣掉 2 个等价变异后分母算成 6，得到 **7/6 = 1.17** —— 杀死率大于 1 这种
       * 数学上不可能的结论会被静默输出并判 PASS。
       *
       * ★ 不要写成 `survived.length && ...`（2026-11-12 外部实测指出）：
       * 那个短路让 survived=[] 时完全不校验，而"漏列"恰恰常在留空时发生。
       * 后果不是变绿（方向安全），而是**误导**——同时声明了豁免的 S1 时，
       * 报告会写「声明但未存活（理由可能已过时）: S1」，用户于是去删掉一个
       * 合理的豁免，而真正要修的是报告漏列。四种形态的判定：
       *   killed=8 total=8 survived=[]  → 不触发（全杀，8+0=8）✓
       *   killed=6 total=8 survived=[]  → 触发（漏列，6+0≠8）✓ 准确定位
       *   killed=8 total=8 survived=2   → 触发（多列，8+2>8）✓
       *   killed=10 total=14 survived=4 → 不触发（10+4=14）✓
       */
      if (killed + survived.length !== total) {
        return {
          status: 'fail',
          reason: `变异证据自相矛盾：killed(${killed}) + survived(${survived.length}) = ${killed + survived.length} ≠ total(${total})（survived 必须列全，否则分母算不准）`,
        };
      }

      const effectiveTotal = total - hitExempt.length;
      if (effectiveTotal <= 0) {
        return {
          status: 'fail',
          reason: `扣除等价变异后分母为 0（total=${total}，豁免命中=${hitExempt.length}）：空集不构成通过`,
        };
      }
      /**
       * 不变量：killed ≤ effectiveTotal（2026-11-13 复算，评审包 §5 Q3）。
       *
       * 证明：自洽性校验成立 ⇒ killed = total - survived.length；
       *      hitExempt ⊆ survivedIds ⇒ hitExempt.length ≤ survived.length；
       *      effectiveTotal = total - hitExempt.length。
       *      ⇒ effectiveTotal ≥ total - survived.length = killed，恒成立。
       * 复算：枚举 total ≤ 12 的 **454 组**自洽组合，可达次数 **0**（与 2026-11-12 首次穷举一致）。
       *
       * ★ 为什么不删（Q3 的答案）：
       *
       * 删掉它需要的是"上游一定不出错"这个假设，而这个假设本身无法被本文件验证 ——
       * 它依赖自洽性校验、豁免去重、survivedIds 对齐三处同时正确。**判据越复杂，
       * 这个假设越不可靠**；而一旦假设破了，后果是静默输出 `rate > 1` 并判 PASS，
       * 正是评审包反复强调的"假绿比假红危险"。
       *
       * ★ 但保留它的旧方式有问题：原来它在 `if` 里 `return fail`，**永不触发**，
       * 于是它与"根本不存在"在可观测行为上完全等价 —— 这就是 Q3 说的"变相的未测试分支"。
       * 测试覆盖不到它，也没人能证明它还能工作（万一有人把阈值改成 `>=`？）。
       *
       * 现在的处理：把它降级为**运行时断言**（assertInvariant），
       * 它不再是"规则的一个返回分支"，而是一条**每次运行都会真的被求值**的不变量检查。
       * 区别在于：
       *   · 作为 return 分支：不满足条件才执行 ⇒ 永真 ⇒ 死代码
       *   · 作为断言调用：每次都求值 `!(killed > effectiveTotal)` 并计入统计 ⇒ 活的
       * 这样它就从"测不到的分支"变成"每次都跑、且能自证次数"的检查点。
       */
      assertInvariant(
        killed <= effectiveTotal,
        () => `内部不变量被破坏：killed(${killed}) > 有效分母(${effectiveTotal})，杀死率 > 1 不可能。这是判据缺陷，请报 issue`,
        'ACCEPT-E2.killed<=effectiveTotal',
      );

      const rate = killed / effectiveTotal;
      const notes = [];
      if (hitExempt.length) notes.push(`已按声明扣除等价变异 ${hitExempt.length} 个（${hitExempt.join(',')}）`);
      if (dupMerged > 0) notes.push(`重复声明已合并 ${dupMerged} 条（去空白后同名）`);
      // 声明了但本次并未存活 ⇒ 该理由已过时，提示而非阻断（不制造新的静默）。
      const stale = notSurvived.length ? `；声明但未存活（理由可能已过时）: ${notSurvived.join(',')}` : '';

      if (rate < min) {
        const realSurvivors = survived.filter((s, i) => !exemptIds.has(survivedIds[i]));
        return {
          status: 'fail',
          reason: `变异杀死率 ${rate.toFixed(2)} < ${min}（${killed}/${effectiveTotal}${hitExempt.length ? `，已扣等价变异 ${hitExempt.length}` : ''}）${stale}`,
          items: realSurvivors.slice(0, 20).map((s) => `存活: ${s}`),
        };
      }

      /**
       * ★ A09：**清单完整性**（2026-11-13 修）。放在杀死率判定**之后**。
       *
       * 缺陷形态（审计实证，与本规则此前的全部判据都无关）：
       * 解析器过去把 `total` 定义成"匹配到的行数"，于是
       *   · 生产者跑到一半崩了、只打出第一条变异的报告 ⇒ killed=1/total=1 ⇒ 1.00 ≥ 0.8 ⇒ **PASS**
       *   · 真正只有一个变异体的报告 ⇒ 完全同形
       * **"被截断"与"完整"在文本与算术上都同形** —— 上面所有自洽校验（killed+survived===total）
       * 在这种输入上**全部成立**，因为它们校验的是"报告内部自洽"，不是"报告是否完整"。
       *
       * 判据分三档（`completeness` 由 lib/evidence.mjs 的 parseMutationReport 给出）：
       *   · 'complete'（报告声明了 MUTANT_TOTAL 并与实测行数一致，或与配置清单逐条对账一致）
       *       ⇒ 这才是可以据此判 PASS 的完整清单；
       *   · 'unknown' / 'incomplete' ⇒ **FAIL**：生产者没能证明清单完整，截断报告不能算满分；
       *   · 'undeclared' —— 没有 completeness 字段的**手写**证据。此时看有没有生产者痕迹：
       *       有 `meta.producers.mutation` 或 `mutation.expectedTotal` ⇒ 是机器生产的证据，
       *       **它本该声明却没声明 ⇒ FAIL**（这条正是审计实证的那个洞：make-evidence 产出的
       *       1/1 证据必然带 meta.producers，所以会被拦下）；
       *       都没有 ⇒ 属于 A11 已明示的"信任调用方自带证据"边界，**不据此项判 pass**，
       *       但在 detail 里显式写「变异清单完整性未声明」，不制造"看起来完整"的假象。
       *
       * ★ 为什么放在 rate 判定之后：rate 不足时"杀死率 0.45 < 0.8"是更精确、更可指导行动的
       *   归因；完整性是**第二层**的怀疑（"这个 1.00 是真是假"）。把它前置会把
       *   "明明杀不够"的用例统一改成"清单不完整"，反而丢掉更有用的信息。
       */
      const completeness = m.completeness;
      const hasProducerTrace = Boolean(
        (ctx.evidence && ctx.evidence.meta && ctx.evidence.meta.producers && ctx.evidence.meta.producers.mutation) ||
          m.expectedTotal !== undefined,
      );
      const completenessNote = (() => {
        if (completeness === 'complete') return { ok: true, note: `清单完整性: complete（${m.completenessReason || '已声明'}）` };
        if (completeness === 'unknown' || completeness === 'incomplete') {
          return {
            ok: false,
            reason:
              `变异清单完整性未声明：${m.completenessReason || '报告未给出清单长度'} —— ` +
              '生产者需输出 `MUTANT_TOTAL=<n>` 或提供 expectedMutants。' +
              '（截断的报告与"只有一个变异体"的报告同形，不能据此判 PASS）',
          };
        }
        // 走到这里：字段缺失 / 'undeclared' / 任何无法识别的值
        if (hasProducerTrace) {
          return {
            ok: false,
            reason:
              '变异清单完整性未声明：这份证据带生产者痕迹（meta.producers.mutation / expectedTotal），' +
              '却没有给出 completeness。机器生产的变异证据必须声明清单长度（MUTANT_TOTAL 或 expectedMutants）。',
          };
        }
        /**
         * ★ 产品政策：**信任调用方**（见 ICD §5.2「信任边界」）。
         *
         * 手写证据（无 meta、无生产者痕迹）不带 completeness 时，本工具不据此判失败 ——
         * 我们校验的是结构与自洽性，不认证来源。
         *
         * **状态与措辞必须一致**（2026-11-13 独立复核抓到）：
         * 旧实现返回 `ok: true` 但 detail 写「本项不据此判 PASS」——同一份结论里
         * 两个说法互相否证；使用者读 status 或读文字会得出相反结论。
         *
         * 修法不是把状态降成 skip（那会让 4 条既有"正控必须 PASS"的用例变红，
         * 等于用判据回归换取措辞正确），而是**把话说准**：
         * pass 的依据是"杀死率与自洽性已判定且通过"，未判定的是**清单完整性**这一子项。
         * 因此 detail 明确区分「已判定的」与「未判定的子项」，不再出现
         * "判了 PASS 但不据此判 PASS" 这种自相矛盾。
         */
        return {
          ok: true,
          partial: true,
          note: '清单完整性**未判定**（手写证据、无生产者痕迹 ⇒ 不认证来源，属已声明的信任边界）；本项 pass 仅就杀死率与自洽性成立',
        };
      })();
      if (!completenessNote.ok) {
        return { status: 'fail', reason: completenessNote.reason };
      }
      if (completenessNote.partial) {
        // 子项未全判 ⇒ 用 `signal` 之外的显式标记，避免被读成"全部已验"。
        // 注意：不降为 skip —— `pass` 表达的是"该判据判过的部分全部通过"。
        return {
          status: 'pass',
          signal: PARTIAL,
          detail: `${killed}/${effectiveTotal} = ${rate.toFixed(2)} ≥ ${min}${notes.length ? '；' + notes.join('；') : ''}${stale}；${completenessNote.note}`,
        };
      }

      return {
        status: 'pass',
        detail: `${killed}/${effectiveTotal} = ${rate.toFixed(2)} ≥ ${min}${notes.length ? '；' + notes.join('；') : ''}${stale}；${completenessNote.note}`,
      };
    },
  },
  {
    id: 'ACCEPT-E3',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '契约漂移证据：零漂移',
    why: '接口文档与实现不一致时，"文档写的"不能作为验收依据。',
    run(ctx) {
      const d = ctx.evidence && ctx.evidence.drift;
      if (!d) return { status: 'skip', reason: '未提供 evidence.drift' };
      // ★ A02：checks=-1 / findings=-1 曾静默 PASS；两个计数都必须是**非负整数**。
      const cv = readCount(d, 'checks', 'evidence.drift');
      if (!cv.ok) return { status: 'fail', reason: cv.reason };
      const fv = readCount(d, 'findings', 'evidence.drift');
      if (!fv.ok) return { status: 'fail', reason: fv.reason };
      const checks = cv.value;
      const findings = fv.value;
      if (checks === 0) return { status: 'fail', reason: 'evidence.drift.checks=0：漂移检测没跑过，空集不构成通过' };
      if (findings > checks) {
        // 漂移数不可能超过检查项数 —— 这比"有漂移"更严重，说明证据本身不可信。
        return { status: 'fail', reason: `漂移证据自相矛盾：findings(${findings}) > checks(${checks})` };
      }
      if (findings > 0) {
        return {
          status: 'fail',
          reason: `${findings} 处契约漂移`,
          items: Array.isArray(d.items) ? d.items.slice(0, 20) : [],
        };
      }
      return { status: 'pass', detail: `${checks} 项检查，0 漂移` };
    },
  },
  {
    id: 'ACCEPT-E4',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'manual',
    title: '未被执行的分支是否已显式报告（自曝）',
    why: '所有机器断言都绿时，唯一能暴露"跳过一半规格"的只有实现者主动报告。',
    run() {
      return { status: 'manual' };
    },
  },

// ---------------- 代码阶段 ----------------
  {
    id: 'KISS-C1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '嵌套深度不得超过 {maxNesting} 层',
    why: '深嵌套是可测性最直接的敌人，也是最容易机械检查的一条。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (!files.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const max = ctx.cfg.maxNesting ?? 3;
      // ★ 2026-11-16（第 ④ 位）：标题按语言分派，**只改措辞，不改判定**。
      //
      // 为什么必须改：`.py` 走的是 `pyNesting()` —— 只有 8 行 `indent // 4`；
      // 而 JS/TS 走的是约 200 行的词法状态机（注释/字符串/模板串/正则/括号栈跨行维护）。
      // **两者不在同一个精度等级，却顶着同一句标题「嵌套深度不得超过 N 层」。**
      //
      // 实测（一个真实 Python 仓的 `eda_skill`，30 个文件）：
      //   工具报 827 处，用 Python 自己的 `ast` 独立核对 —— 真实超限只有 21 处，
      //   **虚报 97.5%**。其中 96.6% 的命中行根本不是控制流块的起点
      //   （括号续行 `return (` 的参数、docstring 正文、列表推导内部）。
      //
      // 所以对 `.py` 如实标注「缩进近似」：读者看到 827 时会知道那是缩进层数，
      // 不是控制流嵌套。**这不是修 bug，是修"标题承诺了它做不到的事"。**
      //
      // ★ 刻意**不**改 `pyNesting()` 的实现：加正则补丁正是 `jsNesting` 注释里
      //   记的 A04 假绿路径（"看起来修了"，换一种语法又漏）。
      //   真要做对需要用 Python 自己的解析器，那要引入子进程，
      //   破坏"零依赖 Node CLI"的定位 —— 那是另一个决定，不在本次范围。
      const hasPy = files.some((f) => f.endsWith('.py'));
      // ★ 只在含 .py 时才返回 title 键。返回 `title: undefined` 会**覆盖**
      //   runner 已渲染好的默认标题（`{...res}` 在后），于是 JS/Java 分支的标题变空。
      //   实测踩过：纯 JS 仓的 KISS-C1.title 变成 undefined。
      //
      // ★ 这里必须**自己替换 `{maxNesting}`**：runner 只对 `rule.title`（静态串）
      //   跑 `renderTitle`，`run()` 返回的 title 不经过那道渲染。
      //   实测踩过：返回未替换的模板会让报告直接印出 `{maxNesting}` 字面量 ——
      //   与 `renderTitle` 注释里记的 `{ratio}` 事故同族。
      const pyTitle = hasPy ? { title: NESTING_TITLE_PY.replace('{maxNesting}', String(max)) } : {};
      // ★ 2026-11-16（第 ⑥ 位）：**测试文件单独分档**。
      //
      // 为什么必须分：实测 Java 仓 211 处里，`CoreSelfTest.java` **一个文件占 83 处（39%）、
      // max=7**。它是 10995 行的零依赖自测脚本，`main()` 里顺序断言、天然深嵌套。
      // 若按"绝对处数"设阈值，**测试文件会把生产代码的信号淹掉**。
      //
      // ★ 判定依据是**显式的路径约定**（见 lib/testfiles.mjs），不是"我猜"：
      //   目录段（`test/` `tests/` `__tests__/` …）与文件名约定（`*.test.ts` `test_*.py` `*Test.java` …）。
      //   可用 `testOverrides` 覆盖（`+前缀` 强制算、`-前缀` 强制不算）。
      //
      // ★ 默认 `testNesting` = `maxNesting`（**不放宽**）：
      //   分档能力默认不改变任何既有结论；要放宽必须显式配置。
      //   "默认值不是便利，是政策" —— 静默放宽阈值等于偷走一次判定。
      const testMax = ctx.cfg.testNesting ?? max;
      const overrides = Array.isArray(ctx.cfg.testOverrides) ? ctx.cfg.testOverrides : [];
      const prod = [];
      const tests = [];
      for (const f of files) {
        const cls = classifyTest(f, ctx.rel(f), overrides);
        collectTooDeep(f, ctx, max, cls.isTest ? tests : prod);
      }
      // 测试档若被显式放宽，需要单独再收集一遍（用 testMax）
      if (testMax !== max) {
        tests.length = 0;
        for (const f of files) {
          const cls = classifyTest(f, ctx.rel(f), overrides);
          if (cls.isTest) collectTooDeep(f, ctx, testMax, tests);
        }
      }
      return nestingVerdict({ prod, tests, max, testMax, pyTitle, hasPy, fileCount: files.length });
    },
  },
  {
    id: 'DRY-C1',
    principle: 'DRY',
    stage: 'code',
    decidability: 'machine',
    title: '跨文件连续 {dupWindow} 行规范化重复',
    why: '抓真复制粘贴，且只在跨文件时报警——同文件内的重复常是合理的数据表。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (files.length < 2) return { status: 'skip', reason: `仅 ${files.length} 个源码文件，跨文件重复不可判定` };
      const win = ctx.cfg.dupWindow ?? 6;
      const dups = duplicateBlocks(files, win, { minChars: ctx.cfg.dupMinChars ?? 40 });
      if (dups.length) {
        // ★ 按 **a 侧文件**分组聚合：重复块的"归属"取起点一侧，
        //   否则同一个热点文件会在两侧各占名额，把别的文件挤掉。
        const entries = dups.map((d) => ({
          file: d.a.file,
          text: `${ctx.rel(d.a.file)}:${d.a.line} ↔ ${ctx.rel(d.b.file)}:${d.b.line}`,
        }));
        return {
          status: 'fail',
          reason: `${dups.length} 处跨文件重复块（≥${win} 行）`,
          items: aggregateByFile(entries),
        };
      }
      return { status: 'pass', detail: `扫描 ${files.length} 个文件，无 ≥${win} 行跨文件重复` };
    },
  },
  {
    id: 'YAGNI-C1',
    principle: 'YAGNI',
    stage: 'code',
    decidability: 'machine',
    title: '代码中不得出现投机性标记（预留 / 将来扩展 / 暂未使用等）',
    why: '这是 YAGNI 唯一能可靠机械判定的信号：作者自己标注了"当前无用、留待以后"。',
    run(ctx) {
      if (!ctx.codeFiles.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const marks = [];
      for (const f of ctx.codeFiles) marks.push(...speculativeMarks(f, ctx.readFile(f)));
      if (marks.length) {
        const entries = marks.map((m) => ({
          file: m.file,
          text: `${ctx.rel(m.file)}:${m.line} [${m.why}] ${m.text}`,
        }));
        return {
          status: 'fail',
          reason: `${marks.length} 处投机性标记`,
          items: aggregateByFile(entries),
        };
      }
      return { status: 'pass', detail: `扫描 ${ctx.codeFiles.length} 个文件，无投机标记` };
    },
  },
  {
    id: 'DISCIPLINE-C1',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '变更必须落在声明范围内，且行数不超过预算',
    why: '越权修改是"规范包装下的屎山"的主要通道。',
    run(ctx) {
      if (!ctx.diff) return { status: 'skip', reason: '未提供 diff 数据（需 --diff <json>）' };
      const rows = ctx.diff.files || [];
      if (!rows.length) return { status: 'skip', reason: 'diff 为空（空集不构成通过）' };

      /**
       * ★ A02 + A03：这一条曾同时被两个域缺陷击穿。
       *
       *   A02：added=1000 / deleted=-1000 ⇒ 合计 0 ⇒「0 行，均在范围内」PASS。
       *        合计是"变更量"，负的删除行在数学上不存在；正负相消更是把违规蒸发了。
       *   A03：allowedPrefixes 用归一化前的 `startsWith` 比较
       *        ⇒ `src/../outside.js` 以 `src/` 开头 ⇒ 越界路径 PASS。
       *
       * 现在的判据：
       *   ① 每个计数必须是**非负整数**（类型错了 ⇒ 这是证据格式错误，直接 FAIL）；
       *   ② 路径**先词法归一**再按段边界判前缀，绝对路径与越界点段一律算越界。
       */
      const allowed = ctx.cfg.allowedPrefixes || [];
      let total = 0;
      const problems = [];
      const badCounts = [];
      for (const r of rows) {
        const a = readCount(r, 'added', `diff.files[${r.path ?? '?'}]`);
        const d = readCount(r, 'deleted', `diff.files[${r.path ?? '?'}]`);
        if (!a.ok) badCounts.push(a.reason);
        else if (!d.ok) badCounts.push(d.reason);
        else total += a.value + d.value;
      }
      if (badCounts.length) {
        return {
          status: 'fail',
          reason: `diff 有 ${badCounts.length} 处计数非法（行数必须是非负整数）`,
          items: badCounts.slice(0, 10),
        };
      }
      if (allowed.length) problems.push(...outOfPrefixRows(rows, allowed));
      /**
       * ── 行数预算：**缺省 = 未启用**（2026-11-14 取消隐式 400）────────────
       * 旧实现 `?? 400` ⇒ 不写配置也被约束，且只报「超预算 400」，使用者不知道这个 400 不是他配的。
       * 现在缺省即不执行（**不 skip 整条规则**，C1 还担范围检查），但必须写明「未启用」——
       * 「未启用」不能渲染成「通过」。`0` 是零行预算，不等于未启用。
       */
      const budget = ctx.cfg.maxDiffLines;
      const budgetEnabled = budget !== undefined;
      if (budgetEnabled && total > budget) problems.push(`变更 ${total} 行，超预算 ${budget} 行`);

      if (problems.length) {
        // reason 按规格 §1.1 写死：使用者必须能看出**哪项检查没启用**
        let reason;
        if (!budgetEnabled) reason = `${problems.length} 项越界（预算未启用）`;
        else if (!allowed.length) reason = `${problems.length} 项超预算（范围检查未启用）`;
        else reason = `${problems.length} 项越界/超预算`;
        // ★ 刻意**不**用 aggregateByFile：这里的每一条是「一个变更行」，
        //   同一文件多行越界是**必须全部列出**的事实（聚合会让"这个文件改了 5 处
        //   都越界"退化成 1 条，反而隐藏严重性）。
        //   与 KISS-C1/DRY-C1 的差别：那两处的重复是**同质样本**（都是"深度超限"，
        //   给一条即可说明性质）；这里的每条是**不同的变更行**，不可互替。
        return { status: 'fail', reason, items: problems.slice(0, 30) };
      }

      // pass 也必须说清哪些检查没跑
      if (!allowed.length && !budgetEnabled) {
        return { status: 'pass', detail: `${rows.length} 个文件、${total} 行；范围检查与行数预算均未启用` };
      }
      if (!budgetEnabled) {
        return { status: 'pass', detail: `${rows.length} 个文件、${total} 行，均在范围内；行数预算未启用` };
      }
      if (!allowed.length) {
        return { status: 'pass', detail: `${rows.length} 个文件、${total} 行；范围检查未启用；行数预算 ${budget} 行未超限` };
      }
      return { status: 'pass', detail: `${rows.length} 个文件、${total} 行，均在范围内；行数预算 ${budget} 行未超限` };
    },
  },
  {
    id: 'DISCIPLINE-C2',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '工作区根不得堆积临时产物（pip-* / 随机 tmp* / cdp-profile-* / diag-* / *-tmp / *-temp，可带前导点）',
    why: '临时目录落在项目根而不是临时目录，是"当前工作目录回退"的典型后果；它还会挤占按一级目录扫描的工具（如身份卡扫描上限 200）。',
    run(ctx) {
      if (!existsSync(ctx.repo)) return { status: 'skip', reason: `仓库根不存在: ${ctx.repo}` };
      let ents;
      try {
        ents = readdirSync(ctx.repo, { withFileTypes: true });
      } catch (e) {
        return { status: 'skip', reason: `仓库根不可读: ${e.message}` };
      }
      const junk = [];
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        if (isJunkDirName(e.name)) junk.push(e.name);
      }
      if (junk.length) {
        // `junk` 是仓库根下的**目录名**，每个名字天然唯一（同一个目录不会出现在两处），
        // 所以这里不存在"单文件占满名额"的问题，无需聚合。
        return {
          status: 'fail',
          reason: `${junk.length} 个临时目录残留在仓库根`,
          items: junk.slice(0, 30),
        };
      }
      return { status: 'pass', detail: `仓库根 ${ents.filter((e) => e.isDirectory()).length} 个一级目录中无临时产物` };
    },
  },
  {
    /**
     * ★ 2026-11-12 新增：把「四制品」与「实际代码变更」绑起来。
     *
     * **为什么必须有这条**（对方 8 片实测暴露，决定性实验）：
     *   同一份 change 目录，只改四制品不动代码：
     *     - 四制品完美 + 代码零改动      → process 档 7 绿 0 红
     *     - 四制品描述**另一件没做的事**  → **仍 7 绿 0 红**
     *   也就是说 process 档**不读代码**，它不知道 proposal 说要做的 A
     *   和代码实际做的 B 是否同一件事。8 片共跑 9 次 process 档，
     *   **0 次因"这片做得不对"而红**，只有 3 次因为文档格式不规范而红。
     *   它当时更接近 Markdown 链接检查器。
     *
     * 这条判据补的就是那个缺口：**文档里声明的文件路径，必须出现在真实 diff 里**。
     * 没有 diff 时仍然 skip（不假装通过），但一旦提供 diff，
     * 「文档说改 A、实际改了 B」就会被抓出来。
     */
    id: 'DISCIPLINE-C3',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '文档声明的文件必须出现在实际变更里（文档↔代码绑定）',
    why: '四制品写得再漂亮，只要它描述的不是"实际做的这件事"，规范就退化成了作文检查。',
    run(ctx) {
      // 单行早返回：多行写法会让块嵌套多一层，本项目的 KISS-C1 会自己判自己红。
      if (!ctx.diff) return { status: 'skip', reason: '未提供 diff 数据（需 --diff <json>，可用 tools/make-diff.mjs 生成）' };
      const rows = ctx.diff.files || [];
      if (!rows.length) return { status: 'skip', reason: 'diff 为空：无法判断"声明"与"实际改动"是否一致（空集不构成通过）' };

      /**
       * ★ 只从 **tasks.md** 抽取"我要改"的声明，不从 design.md 抽。
       *
       * 2026-11-12 在 AMup 的 8 个真实切片上回放发现的设计缺陷：
       * design.md 里有「复用清单」表（列头是「现有模块路径 | 提供什么能力 | 本次如何复用」），
       * 表里**本来就包含"不适用 / 只读复用 / 不合并"的条目** —— 那些路径是
       * **明确不打算改**的，却被当成"声明要改"，于是 8 个切片全部误报 FAIL。
       * 实测证据：`lib/team-primitives.js` 那行的"本次如何复用"写的是
       * 「**不适用**：语义不同」，`lib/diag-throttle.js` 写的是「**不适用**：与传输键无关」。
       *
       * tasks.md 才是"要做的事"清单，它的路径基本等同于"要动的地方"。
       * 只认 tasks.md 后，若 tasks 里没有带目录路径则 skip（不假装通过）。
       */
      const arts = ['tasks.md'].map((n) => ctx.art.files[n]).filter(Boolean);
      if (!arts.length) {
        return { status: 'skip', reason: '未提供 tasks.md，无从判断"声明要改什么"' };
      }

      /**
       * 抽取"我要改"的声明 —— 但要排除**同义反复的复查条目**。
       *
       * 2026-11-12 在 8 个真实切片上回放后第二次修正：
       * 只认 tasks.md 之后仍有 6/8 误报，因为 tasks.md 里有「复用复查」这一类小节，
       * 写的是「检查是否与 `lib/x.js` 重复 —— **是，但语义不同/被钉死/刻意不并入**」。
       * 那里的路径语义是**"我看过了，决定不动它"**，恰恰是声明**不改**的文件。
       * 实测三例：`lib/team-primitives.js`（语义不同）、`lib/team-transport-http.js`（被 I4/I4b 钉死）、
       * `lib/index.js`（r26 哈希锁，刻意不并入）。
       *
       * 判据：**同一行里若出现"不改"语义的标记，该行内的路径不计入声明**。
       * 这是启发式，但方向安全——漏判只会让检查更宽松（少报），
       * 而误判会让用户去改一份本来就不该动的文档。
       */
      /**
       * 抽取"我要改"的声明 —— 排除三类**同义反复/取证句式**。
       *
       * 2026-11-12 在 8 个真实切片上回放，逐步收敛出这三类：
       *
       * ① **不改语义**：`不适用 / 不并入 / 不合并 / 不在本片范围 / 钉死 / 刻意不`。
       *    实测：「`lib/team-primitives.js` …**不适用**：语义不同」。
       * ② **取证/确认语义**：`检查 / 确认 / 核对 / 复核 / 实测 / grep`。
       *    实测：「检查 T3 是否与 `lib/shared-state-lock.js` 重复 —— 结论：不含这 4 个原语」、
       *          「确认既有行为测试：`tests/smoke/smoke-test-style-variants.mjs` 真跑 iter5ReadMode」。
       *    这些行是**"我去查过/会去确认"**，不是"我要改它"。
       * ③ **纯文件名**（无目录）：留在正向里会被当成"声明路径"，但实际歧义大。
       *
       * 共同点：这三类的路径**都不代表"要修改"**，误判会让用户去改一份本来不该动的文档。
       * 方向安全：宁可少报（放过真声明），也不制造"修错地方"的误导——
       * 因为真正的越界由 `DISCIPLINE-C1` 的 allowedPrefixes + 行数预算负责，那才是硬约束。
       */
      /**
       * ★ 只认**明确的"这条不做"声明**。
       *
       * 2026-11-12 负控暴露的坑：宽词 `不动` 会吞掉真修改——
       *    T4 `在 lib/shared-state-lock.js 末尾增加 export { claim }（实现不动）`
       * 这句的"不动"修饰的是**实现**（只加导出、不改实现），而它**确实要改这个文件**。
       * 用宽词过滤后 C3 变成永真：把 `lib/shared-state-lock.js` 改成不存在的
       * 文件名仍然 PASS ⇒ 假绿。**这是回放过程中我自己造出来的假绿。**
       *
       * 收紧原则：只有"这一整条都不做"的措辞才算；修饰局部的不算。
       * 去掉了 `不动` / `排除` / `保持原样` 这些既可修饰整体又可修饰局部的词。
       */
      const NOT_CHANGING = /(不适用|不并入|不合并|不在本片范围|不需要修改|无需修改|不修改此文件|刻意不并入|不属于本次|不纳入)/;
      /**
       * 取证/确认句式：**锚定在列表项的句首动词**，不做全段包含匹配。
       *
       * 2026-11-12 第 11 次回放发现的关键区别（负控暴露）：
       *
       *   T1 `确认 lib/config-lock.js 与 lib/shared-state-lock.js 逐字节相同` ← 取证，应过滤
       *   T4 `在 lib/shared-state-lock.js 末尾增加 export { claim }`          ← **真修改，必须保留**
       *
       * 两者同在一个 slices 的 tasks.md 里。若用"整段包含'确认'"来判断，
       * 段落级合并会把 T4 一起吞掉 ⇒ C3 变成永真。负控实测：把
       * `lib/shared-state-lock.js` 改成不存在的文件名，C3 仍 PASS —— 假绿。
       *
       * 修法：只剥掉列表符号与任务编号（`- [ ] T1 `），再看**紧跟的第一个词**是不是取证动词。
       */
      const RECON_HEAD =
        /^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?(?:[A-Z]{1,3}\d+[a-z]?\s+)?(检查|确认|核对|复核|实测|grep|记录|查看|取证|统计|复算|对拍)/;
      /**
       * 「要改」表述 —— 取证句式的**否决条件**（2026-11-13 Q1 · R2）。
       *
       * 句首写「确认」曾是完整豁免：`确认 lib/x.js 需要改动` 判 PASS，
       * 同一句改成「修改」立刻 FAIL ⇒ 判定被一个可自由选择的动词开关。
       * 收紧为双条件：句首是取证动词 **且** 块内不含"要改"表述。
       */
      const WANTS_CHANGE =
        /(需要改动|需要修改|需要调整|要改|改为|改成|替换为|新增|增加|删除|移除|重写|实现)/;

      /**
       * 三组语义正则已提到模块级（`NOT_CHANGING` / `RECON_HEAD` / `WANTS_CHANGE`）：
       * `collectFromBlock` 与 `collectBareNames` 是独立的纯函数，需要它们在同作用域内。
       * 曾经把它们留在 `run()` 里而把抽取逻辑搬出去，导致运行期 ReferenceError ——
       * 症状是"C3 该红的分支没红，反而报内部错"，比判据弱更糟。
       */

      /**
       * 按**列表项段落**（而不是按行）切分来判断语义。
       *
       * 2026-11-12 第十次回放发现：Markdown 里一个列表项常折成两三行，
       * 「检查」这个动词在**首行**、而路径在**续行**：
       *
       *   - [ ] 检查 T3 是否与 `lib/shared-state-lock.js` / `lib/team-transport.js` 重复
       *         —— 结论：`lib/shared-state-lock.js` 不含这 4 个原语……
       *
       * 按行判断时，续行既没有"检查"也没有"不改"，于是它的两个路径被当成
       * "声明要改"⇒ 误报「声明了但没改」。按段落判断则整条一起被识别为取证句式。
       */
      const toBlocks = (text) => toListBlocks(text);

      /**
       * 取证项（句首为「确认/检查/核对…」）不要求"必须被改"，
       * 但**它引用的路径必须真实存在**。
       *
       * ★ 2026-11-12 外部实测发现的第 5 个缺陷（`RECON_HEAD` 后门）。
       *
       * 我上一版对取证项是 `continue` —— **整条跳过**。后果：
       * 任何声明只要句首写「确认」，就脱离了 C3 的管辖。实测注入
       *
       *     - [ ] T99 确认 `lib/ZZZ-attack-via-recon-head.js` 需要改动
       *
       * 结果 **PASS**（盲区）；把句首改成「修改」则立刻 FAIL。
       * 五个动词都是后门：确认 / 检查 / 记录 / 复核 / 查看。
       *
       * **为什么比缺陷④更隐蔽**：④ 需要「宽词恰好修饰局部」这种巧合，
       * ⑤ 只要句首写个"确认"就行 —— 它是**故意设计出来的豁免面**。
       *
       * 修法（对方建议的 A 方案，采纳）：取证项仍不要求"被改"，
       * 但补上一条更基本的要求 —— **不能引用幻觉路径**。
       * 这样既不误伤真实取证项（它们引用的是真文件），又堵住注入。
       */
      /**
       * ★ 先做**格式前置检查**：反引号必须成对。
       *
       * 2026-11-12 外部实测发现的第 7 个缺陷（**整篇级跳过**，比前六个都危险）。
       *
       * `backticked()` 的正则 `/`([^`\n]+)`/g` 遇到未闭合反引号时**整对失配**，
       * 于是整篇抽不出任何路径 ⇒ `declared` 为空 ⇒ C3 走「无声明」分支 ⇒ **PASS**。
       * 实测：只删掉一个右引号（改 1 个字符），
       * 结论立刻变成「声明 1 条路径全部落地；6 个变更文件均可在文档中找到出处」。
       *
       * **它的失败形态是「C3 什么都没做，却报肯定结论」，这比前六种都危险。**
       *
       * 判据：反引号总数必须是偶数。奇数 ⇒ 必然有未闭合 ⇒ 直接 fail
       * （这是可机械判定的格式错误，不该容忍，也不该降级成提示）。
       */
      for (const a of arts) {
        const ticks = (a.text.match(/`/g) || []).length;
        if (ticks % 2 === 1) {
          return {
            status: 'fail',
            reason: `反引号未闭合（共 ${ticks} 个，奇数）⇒ 无法可靠抽取声明。请检查 Markdown 里的 \` 是否成对`,
          };
        }
      }

      const reconRefs = []; // 取证项引用的路径（只校验存在性）
      const declared = new Set();
      const skipped = []; // 被跳过的 B 引号块（用于显式提示，见下）
      for (const a of arts) {
        for (const block of toBlocks(a.text)) collectFromBlock(block, { reconRefs, declared, skipped });
      }
      // 取证项不能引用幻觉路径（外部实测的注入攻击正是从这里进来的）
      // ★ 只查 reconRefs：declared 里的幽灵路径由下面的 missing 分支报「声明了但没改」，
      //   两者语义不同 —— 前者是"取证句引用了不存在的东西"，后者是"说要改但没改"。
      //   （2026-11-13 Q1 修 R1/R2 时曾误把 declared 并进来，导致诊断理由整体偏移。）
      const phantom = reconRefs.filter((p) => !ctx.existsProjectFile(p));
      if (phantom.length) {
        return {
          status: 'fail',
          reason: `取证项引用了 ${phantom.length} 个不存在的路径（取证可以不改文件，但不能引用幻觉路径）`,
          items: [...new Set(phantom)].slice(0, 20).map((p) => `取证项引用了不存在的路径: ${p}`),
        };
      }
      if (!declared.size) {
        return {
          status: 'fail',
          reason: '文档未声明任何带目录的源码路径（无法验证"说的和做的是同一件事"）；若确为仓库根级文件，请写成 ./文件名',
        };
      }

      const changed = new Set(rows.map((r) => String(r.path).replace(/\\/g, '/').replace(/^\.\//, '')));
      // 声明的路径必须在变更集里；不在的列出来。
      const missing = [...declared].filter((d) => !changed.has(d));

      /**
       * 反向：改了源码但文档一个字都没提 —— 这是"偷偷扩大范围"。
       *
       * ★ 匹配必须**同时看全路径与基名**（2026-11-12 第三次回放发现）。
       *
       * 历史缺陷：正向只收"带目录的路径"（裸文件名歧义大），但反向匹配时
       * 却要求 diff 里的路径能在 declared 里找到 —— 于是文档写
       * `smoke-test-r26-cross-layer`（短名，无目录）、diff 里是
       * `tests/smoke/smoke-test-r26-cross-layer.mjs`，两边对不上，
       * 被误报成"改了但文档没提"。实测 3 个切片都栽在这里
       * （fix-http 的 T7/T8/T9 明确写了要重钉这三个套件）。
       *
       * 修法：反向匹配也接受**文档里出现过的裸文件名**（去掉扩展名后比较，
       * 允许文档写短名、diff 带完整路径）。正向仍只认带目录路径 —— 那是为了
       * 避免"声明了却无法定位"，方向不同，标准可以不同。
       */
      const bareNames = new Set();
      for (const a of arts) {
        for (const block of toBlocks(a.text)) collectBareNames(block, bareNames);
      }
      const mentions = (p) => {
        const base = p.split('/').pop();
        const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
        return declared.has(p) || bareNames.has(base) || bareNames.has(stem);
      };
      /**
       * 反向检查的**语义**必须和正向不同（2026-11-12 第八次回放才定清）。
       *
       * 正向问的是：「文档说要改 A，A 改了吗？」—— 要求 A 落在 diff 里。
       * 反向问的应该是：「这个文件**在任何制品里出现过吗**？」——
       *   而不是「它在不在"我要改"的清单里」。
       *
       * 为什么这个区别致命：`flatten-iter5-mode-read` 的文档提了
       * `lib/client.js` **12 次**（"由生成器重建"、"不手改"、"51 行逐行核过"），
       * 但那些行不构成"声明要改"（有的带"不手改"，有的只是叙述），
       * 于是它被误报成"改了但文档没提"。实测两个切片栽在这里。
       *
       * 新语义：**文档全文（含 design/proposal/specs）都找不到这个文件名**才算"没提"。
       * 这样"由生成器重建"（间接改）、"逐行核过"（已审阅）都能正确匹配，
       * 而真正偷偷加的文件（文档一个字没提）照样被抓。
       *
       * 注意：这是**弱检查**，主要价值是提示"你可能加了计划外的文件"；
       * 真正的越界拦截由 DISCIPLINE-C1 的 allowedPrefixes + diff 预算负责，
       * 那条才是硬约束。C3 不该重复承担 C1 的职责。
       */
      /**
       * ★ 2026-11-13（Q2 价值实测发现的真实缺陷）：`ctx.art.files` **不含 specs**。
       *
       * listArtifacts 把 specs 单独放在 `art.specs`（数组），而这里只遍历了 files
       * （proposal/design/tasks）。后果：在 specs/spec.md 里正常披露的新增文件，
       * 会被判成「改了但文档没提」——**注释写着"含 specs"，实现却没读**。
       *
       * 实测复现（test/_q2diag.mjs）：specs 里写「新增 ghost.js 用于占位校验」，
       * C3 仍报 fail「改了但文档没提: src/export/ghost.js」。
       * 这是"文档说了但工具看不见"的假红——比假绿安全，但它让弱检查变成噪音，
       * 促使使用者关掉整条规则。
       */
      const allArtText = [
        ...Object.values(ctx.art.files || {}).map((f) => (f && f.text) || ''),
        ...(ctx.art.specs || []).map((sp) => (sp && sp.text) || ''),
      ].join('\n');
      const mentionedAnywhere = (p) => {
        const base = p.split('/').pop();
        const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
        return allArtText.includes(base) || (stem.length >= 8 && allArtText.includes(stem));
      };
      // 默认**全查**（2026-11-13 Q1 · R6）：原先默认只查 lib/src/app/packages，
      // 对把代码放在 tools/ scripts/ bin/ 的项目是系统性失效。
      // 需要收窄时显式配置 codeScopes；显式空数组 = 全查。
      const scopes = Array.isArray(ctx.cfg.codeScopes) ? ctx.cfg.codeScopes : [];
      const inScope = (p) => (scopes.length ? scopes.some((s) => p.startsWith(s)) : true);
      const unexplained = [...changed].filter(
        (p) => /\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|java)$/.test(p) && inScope(p) && !mentionedAnywhere(p),
      );

      const problems = [
        ...missing.map((p) => `声明了但没改: ${p}`),
        ...unexplained.slice(0, 20).map((p) => `改了但文档没提: ${p}`),
      ];

      /**
       * ③ 跳过必须**显式**（外部实测建议，采纳）。
       *
       * 反引号里"看起来像路径、但没能被识别"的内容，以前是**静默消失**。
       * 后果：`declared` 少了这几条，而结论仍然是
       * 「声明 N 条路径全部落地」—— **以肯定句式掩盖了漏检**，比不报更糟。
       *
       * 现在把它们列进 items 提示：不一定判 fail（可能只是文档里举的例子），
       * 但必须让用户看见「这几条我没校验」。
       */
      const skippedNote = skipped.length
        ? [`未校验的路径候选（未能识别，可能是示例而非声明）: ${[...new Set(skipped)].slice(0, 10).join(' / ')}`]
        : [];

      if (problems.length) {
        // ★ 同样不做按文件聚合：`missing` 是"声明了但没改的路径"、`unexplained` 是
        //   "改了但文档没提的路径" —— 每条都是**不同的路径事实**，不可互替。
        //   （`skippedNote` 末尾必须保留，它是"这几条我没校验"的自曝，不能被截断吃掉。）
        return {
          status: 'fail',
          reason: `文档与变更不对应：${missing.length} 条声明未落地、${unexplained.length} 个变更未声明`,
          items: [...problems.slice(0, 30), ...skippedNote],
        };
      }
      /**
       * ★ pass 文案必须与判据的实际能力相符（Q2 价值实测的结论）。
       *
       * 旧文案「N 个变更文件均可在文档中找到出处」暗示"文档确实说了这件事"，
       * 而实现只证明了"这个文件名作为子串出现过"。两者差别在实测里很具体：
       *
       *   S1 文档写「本次不修改 ghost.js」，实际改了 → 旧文案说"能找到出处"
       *   S2 文档在「上一版本的 ghost.js…」里提到 → 同样说"能找到出处"
       *   S5 文档提的是 test/ghost.js（另一个目录） → 同样说"能找到出处"
       *
       * 三种都不是"文档披露了本次变更"。以肯定句式掩盖，与本项目一贯反对的
       * 「假绿比假红危险」同型 —— 即使方向安全（不会误放违规），措辞也在骗人。
       *
       * 改后文案明确写出「仅名称匹配，不判断上下文」。
       * 注意：**没有改判据本身** —— 加强它需要语义理解，强行加强只会重演
       * Q1 的六个后门（为消误报加豁免 ⇒ 造出新绕过面）。弱检查就该老实承认自己弱。
       */
      const reverseNote = `${changed.size} 个变更文件名均可在文档中找到（仅名称匹配，不判断上下文）`;
      return {
        status: 'pass',
        // 有未校验候选时必须说清楚，不能只报"全部落地"
        detail: skipped.length
          ? `声明 ${declared.size} 条路径全部落地；${reverseNote}（另有 ${skipped.length} 条路径候选未校验，见 items）`
          : `声明 ${declared.size} 条路径全部落地；${reverseNote}`,
        items: skippedNote,
      };
    },
  },
  {
    id: 'KISS-C2',
    principle: 'KISS',
    stage: 'code',
    decidability: 'manual',
    title: '现有依赖是否可替代本次新增的抽象',
    why: '需要读项目历史与依赖语义，机器裁决会误伤。',
    run() {
      return { status: 'manual' };
    },
  },

  // ─────────────────────────────────────────────────────────────
  // ARCH：架构级判据（2026-11-17 新增）
  //
  // ★ 用户提了 4 条要求，**只有 2 条做成了机器判据**，另外 2 条明确交还给人。
  //   这不是偷工：把不可判定的做成"看起来能判"，会给出确定性的红/绿，
  //   而依据只是启发式 —— **比不做更坏，因为它会被人当成结论。**
  //   逐条依据见 `lib/arch.mjs` 顶部注释与 `_work/tmp/arch-judgeability.cjs` 的实测。
  // ─────────────────────────────────────────────────────────────
  {
    id: 'ARCH-06',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '循环必须有可终止的退出路径（恒真条件必须有作用于本循环的 break/return/throw）',
    /**
     * ★ 能力边界必须写在这里，不许靠措辞暗示它更强（2026-11-17 独立审查后补）。
     *
     * 本判据**做**：作用域分析 —— 只有直接属于本循环体的 break/return/throw 才算数。
     * 下列写法不再假绿（旧实现全部漏）：
     *   · `switch` 内的 break   · 内层函数(含箭头函数)里的 return
     *   · 内层循环里的 break     · —— 三种均有专项用例。
     *
     * 本判据**不做**：
     *   · **可达性**：`if (false) break;` 仍算有退出路径（需常量传播/控制流分析）。
     *   · **循环变量的单调性**：`while (true)` 之外的条件不作终止性推断。
     *   · **Go / Rust**：`for {}` 与 `loop {}` 未覆盖（已从 STRUCTURAL_EXT 移除，
     *     报告里计作"跳过"而不是"已检查"）。
     */
    why:
      '无法退出的循环会挂死进程。本判据只报「条件恒真且作用域内无退出语句」，' +
      '**不判可达性**（`if(false) break` 仍算有出口）。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (!files.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const { supported, unsupported } = splitSupported(files);
      if (!supported.length) {
        return {
          status: 'skip',
          reason: `扫描 ${files.length} 个文件，但没有结构可判的语言（支持：${STRUCTURAL_EXT.join(' ')}）`,
        };
      }
      const scan = scanArchSet(supported, ctx);
      // ★ 把"输入里有多少文件语言不支持"回填进去 —— 它们不在 supported 里，
      //   不显式记一笔就会从计数里消失（规则级测试抓到的真缺陷）。
      scan.unsupported += unsupported;
      /**
       * ★ 三种"没检查"必须各自成为 skip，不得混进 pass/fail 的计数里：
       *   · 词法器自检不过（`lexerUnreliable`）—— 屏蔽器在这份文件上不可信
       *   · 读文件失败（`readErrors`）
       *   · 语言不支持（`skipped`，如 .go/.rs）
       * 只有 `scanned` 里的文件是**真的检查过**的。
       */
      if (!scan.scanned.length) {
        return { status: 'skip', reason: describeNoScan(scan, files.length) };
      }
      const bad = [];
      for (const r of scan.scanned) {
        for (const hit of r.unterminated) {
          bad.push({ file: r.file, text: `${ctx.rel(r.file)}:${hit.line} while (${hit.cond}) 无 break/return/throw` });
        }
      }
      if (bad.length) {
        return {
          status: 'fail',
          reason: `${bad.length} 处恒真循环缺少 break/return/throw（实检 ${scan.scanned.length} 个文件）${describeGaps(scan, ctx)}`,
          items: aggregateByFile(bad),
        };
      }
      return {
        status: 'pass',
        detail: `实检 ${scan.scanned.length} 个结构可判文件，恒真循环均有退出路径${describeGaps(scan, ctx)}`,
      };
    },
  },
  {
    id: 'ARCH-06-M',
    principle: 'KISS',
    stage: 'code',
    decidability: 'manual',
    title: '事件监听器是否包含防重入锁',
    why:
      '「事件监听器」与「防重入锁」都没有统一形态（on/addEventListener/useEffect/装饰器；' +
      '布尔标志/早退/键集/mutex/节流），机器无法可靠识别，识别不了就无法裁决。',
    run() {
      return { status: 'manual' };
    },
  },
  {
    id: 'ARCH-07',
    principle: 'DECOUPLING',
    stage: 'code',
    decidability: 'machine',
    title: 'catch 块不得体完全为空（真空吞异常）',
    why: '空的 catch 块是唯一可证的"吞掉"；其余形态需要语义判断，不在此判据内。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (!files.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const supported = files.filter((f) => structuralSupported(f));
      if (!supported.length) {
        return {
          status: 'skip',
          reason: `扫描 ${files.length} 个文件，但没有结构可判的语言（支持：${STRUCTURAL_EXT.join(' ')}）`,
        };
      }
      /**
       * 豁免：`catchAllowlist` 形如 `[{where, snippet?, reason}]`，`where` 与 `reason` 必填。
       *
       * ★ 与 `equivalentMutants` 同一纪律：**豁免必须留痕，且不得靠"填个值"绕过**。
       *
       * ★ 2026-11-17 修「豁免计数虚报」：旧实现用 `allow.size`（配置条数）当
       *   "已豁免 N 处"，于是 0 处命中 + 2 条过期 ⇒ 报「已豁免 2 处」并 pass。
       *   现在分三计数：登记数 / 实际命中数 / 陈旧数，陈旧项点名。
       *
       * ★★ 2026-11-18 修「豁免绑行号」：
       *   旧实现以 `relPath:line` 作唯一身份。实测后果——在文件靠前处加代码后，
       *   `tools/check-contract.mjs:239` 漂到 `:240`、`:822` 漂到 `:869`，
       *   **全部豁免静默失效**（那次幸好是报红而不是假绿）。
       *
       *   ⇒ 行号是**位置**，不是**身份**。豁免的对象是"这段代码"，
       *     不是"第 95 行"。现改为**内容锚定**：
       *       · 优先按 `snippet`（去注释、折叠空白后的 `catch {...}` 全文）匹配
       *       · `where` 里的行号仅作**人读提示与快速路径**
       *       · 代码移动 ⇒ 仍能命中；代码本身改了 ⇒ 失配并报红（那才是该重审的时候）
       */
      const allow = parseCatchAllowlist(ctx.cfg.catchAllowlist);
      const bad = [];
      const hitKeys = new Set();
      const stats = collectCatchHits(supported, ctx, allow, bad, hitKeys);
      // ★ 词法器不可用 / 读失败 / 语言不支持，同样必须与"检查过"分开
      if (!stats.scanned.length) {
        return { status: 'skip', reason: describeNoScan(stats.scan, files.length) };
      }
      const gaps = describeGaps(stats.scan, ctx);
      if (bad.length) {
        return {
          status: 'fail',
          /**
           * ★ 2026-11-18 修：**fail 文案也要带分母**。
           *
           * 外部实测（`G:\AMup`）原话：「ARCH-06 的 fail 文案带『实检 26138 个文件』，
           * ARCH-07 的 fail 文案**没有**这个数 —— 两条判据同一扫描集合，
           * 却只有一条能外部核对分母」。读者无法判断"189739 处"是在多少文件上数出来的。
           *
           * 本项目的判据是「报机械计数要让人能复算」，分母是复算的前提。
           * pass 分支本来就有（`describeCatchPass` 首句），fail 分支漏了 —— 不对称。
           */
          reason: `${bad.length} 处 catch 块体为空（未登记豁免）（实检 ${stats.scanned.length} 个文件）${gaps}`,
          items: aggregateByFile(bad),
        };
      }
      return {
        status: 'pass',
        detail: describeCatchPass(stats.scanned.length, allow, hitKeys, stats) + gaps,
      };
    },
  },
  {
    id: 'ARCH-07-M',
    principle: 'DECOUPLING',
    stage: 'code',
    decidability: 'manual',
    title: '基础系统异常是否被静默吞掉；业务拦截器是否修改系统核心状态',
    why:
      '「基础系统异常」只有 Java/Python 有类型可认（JS 只有 message 文本、Go 无异常）；' +
      '「系统核心状态」与「业务拦截器」均无法从代码文本判定。两项都属人工评审。',
    run() {
      return { status: 'manual' };
    },
  },
];

/**
 * 跑 ARCH-07 的扫描，同时收集三类计数（2026-11-17 修「豁免计数虚报」）。
 *
 * 为什么要单独一个函数：旧实现把"扫描"和"报告豁免数"混在一段里，
 * 于是很自然就用了 `allow.size`（配置条数）当"已豁免处数"。分开之后，
 * **每个计数都必须来自实际遍历结果**，不能再从配置反推。
 *
 * @returns {{registered:number, hitDenied:number, totalEmpty:number}}
 *   registered —— 配置里登记了多少条
 *   hitDenied  —— 其中真的命中并豁免掉多少条（写进 hitKeys）
 *   totalEmpty —— 扫描到的空 catch 总数（含被豁免的）
 */
/**
 * 解析 `catchAllowlist` 配置（2026-11-18）。
 *
 * 每条要求 `where`（人读的行号）与 `reason`（理由）都必填；`snippet` 可选。
 *
 * ★ `ambiguous` 标记（同日加）：当**多条豁免的 snippet 逐字相同**时，
 *   行号必须参与消歧。这不是设计缺陷，是真实存在的情形 ——
 *   `tools/check-contract.mjs` 里两处 `try { rmSync(tmp, …) } catch {}`
 *   连上下文都一模一样，纯内容无法区分。
 *   ⇒ 承认它，而不是偷偷让两条共享一条豁免（那样改掉一处不会被发现）。
 */
function parseCatchAllowlist(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.where !== 'string' || !e.where.trim()) continue;
    if (typeof e.reason !== 'string' || !e.reason.trim()) continue;
    out.push({
      where: e.where.trim(),
      reason: e.reason.trim(),
      snippet: typeof e.snippet === 'string' && e.snippet.trim() ? e.snippet.trim() : null,
      ambiguous: false,
    });
  }
  // 标记同锚点者
  const counts = new Map();
  for (const e of out) if (e.snippet) counts.set(e.snippet, (counts.get(e.snippet) || 0) + 1);
  for (const e of out) if (e.snippet && counts.get(e.snippet) > 1) e.ambiguous = true;
  return out;
}

/**
 * 判断一条豁免是否命中某个 `catch`（**内容优先，行号消歧**）。
 *
 * ★ 顺序很重要：
 *   ① 有 `snippet` ⇒ 按**内容**比（两边都规范化过）
 *      —— 代码移动后仍然命中，代码改了则失配（该重审）
 *   ② 多条豁免的 `snippet` **相同时**（真实存在：`check-contract.mjs`
 *      里两处 `try { rmSync(tmp,…) } catch {}` 逐字相同），
 *      这些候选之间再用 `where` 的行号消歧 —— 否则两处会共享同一条豁免，
 *      改掉其中一处不会被发现。
 *   ③ 无 `snippet` ⇒ 退化为 `where` 精确匹配（兼容旧配置）
 *
 * 返回 `'snippet' | 'where' | null`。
 */
function matchCatchExemption(entry, hit, relPath) {
  if (entry.snippet) {
    if (entry.snippet !== hit.snippet) return null;
    // ★ 同锚点多条时要行号消歧，否则豁免会"一拖多"
    if (entry.ambiguous) return entry.where === `${relPath}:${hit.line}` ? 'where' : null;
    return 'snippet';
  }
  return entry.where === `${relPath}:${hit.line}` ? 'where' : null;
}

/**
 * 跑 ARCH-07 的扫描，同时收集三类计数（2026-11-17 修「豁免计数虚报」，
 * 2026-11-18 改内容锚定）。
 *
 * 为什么单独一个函数：旧实现把"扫描"和"报告豁免数"混在一段里，
 * 于是很自然就用了 `allow.size`（配置条数）当"已豁免处数"。分开之后，
 * **每个计数都必须来自实际遍历结果**，不能再从配置反推。
 *
 * @returns {{registered:number, hitDenied:number, totalEmpty:number, scanned:Array, scan:object}}
 *   registered —— 配置里登记了多少条
 *   hitDenied  —— 其中真的命中并豁免掉多少条（写进 hitKeys）
 *   totalEmpty —— 扫描到的空 catch 总数（含被豁免的）
 */
function collectCatchHits(supported, ctx, allow, bad, hitKeys) {
  /**
   * 走 `scanArchSet` 而不是直接调 `emptyCatches` —— 这样词法器自检不过、
   * 读失败、语言不支持三种"没检查"会被归到 `scan` 里，
   * 不会混进"扫描了 N 个文件"的计数（旧实现正是这么把未检查算成通过的）。
   */
  const scan = scanArchSet(supported, ctx);
  let totalEmpty = 0;
  for (const r of scan.scanned) {
    totalEmpty += r.emptyCatch.length;
    // 分流抽成独立函数：`for` → `for` → `if` 三层缩进会被 KISS-C1 判红
    classifyCatchHits(r, ctx, allow, bad, hitKeys);
  }
  return { registered: allow.length, hitDenied: hitKeys.size, totalEmpty, scanned: scan.scanned, scan };
}

/** 把单个文件的空 catch 命中分流成"已豁免"与"应报出"（**内容优先匹配**）。 */
function classifyCatchHits(r, ctx, allow, bad, hitKeys) {
  const rel = ctx.rel(r.file);
  for (const hit of r.emptyCatch) {
    const entry = allow.find((e) => matchCatchExemption(e, hit, rel));
    if (entry) { hitKeys.add(entry.where); continue; }
    bad.push({ file: r.file, text: `${rel}:${hit.line} catch 块体为空（异常被完全吞掉）` });
  }
}

/**
 * 生成 ARCH-07 通过时的 detail，**三类计数分开写，陈旧项必须可见**。
 *
 * 实测反例（旧实现）：0 处真实命中 + 2 条过期条目 ⇒
 * 报「已豁免 2 处」并整条 pass —— 过期豁免永远不会被发现。
 */
function describeCatchPass(scannedCount, allow, hitKeys, stats) {
  const parts = [`实检 ${scannedCount} 个结构可判文件`];
  parts.push(`空 catch ${stats.totalEmpty} 处`);
  if (stats.registered === 0) {
    parts.push('无需豁免');
    return parts.join('，');
  }
  parts.push(`豁免登记 ${stats.registered} 条、实际命中 ${hitKeys.size} 条`);
  const stale = allow.map((e) => e.where).filter((w) => !hitKeys.has(w));
  if (stale.length) {
    // 陈旧项单列：不阻断，但必须让人看见"这条豁免已经不管事了"
    parts.push(`其中 ${stale.length} 条已陈旧（登记了但没命中：${stale.join('、')}）`);
  }
  return parts.join('，');
}

/**
 * 对一批文件跑 `scanArch`，把四种结果分开归类（2026-11-17）。
 *
 * 为什么要单独一个函数：四个 ARCH 判据都要用同一套归类，
 * 而"没检查"和"检查通过"绝不能在计数上混同 —— 这是本项目的核心纪律。
 *
 * @returns {{scanned:Array, lexerUnreliable:Array, readErrors:Array, unsupported:number}}
 *   scanned          —— 真检查过（`{file, unterminated, emptyCatch}`）
 *   lexerUnreliable  —— 词法器自检不过（`{file, problems}`）
 *   readErrors       —— 读文件失败（`{file, error}`）
 *   unsupported      —— 不支持结构判定的文件数
 */
function scanArchSet(supported, ctx) {
  const result = { scanned: [], lexerUnreliable: [], readErrors: [], unsupported: 0 };
  for (const f of supported) {
    const r = scanArch(f, ctx.rel(f));
    if (r.unsupported) { result.unsupported++; continue; }
    if (r.error) { result.readErrors.push({ file: f, error: r.error }); continue; }
    if (!r.ok) { result.lexerUnreliable.push({ file: f, problems: r.problems }); continue; }
    result.scanned.push({ file: f, unterminated: r.unterminated, emptyCatch: r.emptyCatch });
  }
  return result;
}

/**
 * 从**全部**代码文件里分出"支持结构判定的"与"不支持的"。
 *
 * ★ 为什么要单独算 `unsupported`（2026-11-17，规则级测试抓到的真缺陷）：
 *   旧实现先 `files.filter(structuralSupported)`，然后只用 supported 去做统计，
 *   于是 `.go`/`.rs` 这些文件**从来没被计入任何一类** ——
 *   报告写「实检 1 个结构可判文件」时，读者不会知道同目录下还有 3 个 `.go` 没检查。
 *   这正是审查报告第 8 条的同族问题：**没检查的样本从计数里消失**。
 *
 *   现在 `unsupported` 由 `files.length - supported.length` 直接得出，
 *   保证"输入了多少文件"与"检查了多少"之间永远有个显式的差额。
 */
function splitSupported(files) {
  const supported = files.filter((f) => structuralSupported(f));
  return { supported, unsupported: files.length - supported.length };
}

/** 一个文件都没能检查时的 skip 理由（必须说清是哪一类没检查）。 */
function describeNoScan(scan, total) {
  const parts = [];
  if (scan.lexerUnreliable.length) parts.push(`${scan.lexerUnreliable.length} 个词法器自检不过`);
  if (scan.readErrors.length) parts.push(`${scan.readErrors.length} 个读取失败`);
  if (scan.unsupported) parts.push(`${scan.unsupported} 个语言不支持结构判定`);
  return `无法给出结论：共 ${total} 个文件，${parts.join('、')} —— 没有文件被真正检查过`;
}

/** 有部分文件没检查时，附在 detail 后面的缺口说明（不阻断，但必须可见）。 */
function describeGaps(scan, ctx) {
  const parts = [];
  if (scan.lexerUnreliable.length) {
    const names = scan.lexerUnreliable.map((x) => ctx.rel(x.file)).slice(0, 3).join('、');
    parts.push(`${scan.lexerUnreliable.length} 个文件词法器自检不过（未检查：${names}）`);
  }
  if (scan.unsupported) parts.push(`${scan.unsupported} 个文件语言不支持（未检查）`);
  if (scan.readErrors.length) parts.push(`${scan.readErrors.length} 个文件读取失败（未检查）`);
  return parts.length ? `；另有 ${parts.join('、')}` : '';
}

/**
 * 按文件聚合 items 后再截断（2026-11-16，第 ⑤ 位）。
 *
 * ★ 修的是什么：旧实现一律 `bad.slice(0, 30)` —— **纯粹按出现顺序截断**。
 *   实测（Java 仓，KISS-C1 共 211 处）：`items` 30 条里 **29 条来自 `BuildPlan.java`**，
 *   而实际涉及 **15 个文件**。
 *   ⇒ 读者看到 30 条几乎全指向一个文件，会以为"就这一个文件有问题"，
 *     而真相是 15 个文件都有问题，只是**前 30 条恰好都被单文件占满**。
 *
 *   这与第 ④ 位同族：**输出格式让真相失真**。判据本身没错，错在取样方式。
 *
 * ★ 分配规则（保证**每个被命中的文件都在前 30 条里有代表**）：
 *   ① 第一轮：每个文件取 1 条（按文件名排序，结果稳定可复现）；
 *   ② 若还有剩余名额，按"文件内剩余条数"降序继续分配 —— 热点的额外样本优先。
 *   ③ 名额用尽即停，**不改变总条数上限**（默认 30，与旧行为一致）。
 *
 * ★ 约束：
 *   · `entries` 必须是 `{file, text}` 形式 —— **在结构化阶段聚合**，
 *     不要事后再从字符串里正则挖路径（那会因路径里含 `:` 或 `→` 而解析错）。
 *   · 返回的 items 只有 `text`，顺序稳定（同文件内保持原顺序）。
 *   · 若文件数 > limit，仍保证**前 limit 个文件各 1 条**（至少覆盖 30 个文件）。
 *
 * @param {Array<{file:string, text:string}>} entries
 * @param {number} limit 最多返回条数
 * @returns {string[]}
 */
export function aggregateByFile(entries, limit = 30) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  // 分组：保持每组内部顺序（不排序组内，避免改变"第一条"的语义）
  const groups = new Map();
  for (const e of entries) {
    const key = e.file;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  // 文件名排序 ⇒ 结果稳定（不依赖文件系统遍历顺序）
  const files = [...groups.keys()].sort();
  const picked = [];
  const cursor = new Map(files.map((f) => [f, 0]));

  // 第一轮：每个文件 1 条
  for (const f of files) {
    if (picked.length >= limit) break;
    picked.push(groups.get(f)[0]);
    cursor.set(f, 1);
  }

  // 后续轮：按"剩余条数"降序补足（热点优先，但不能挤掉已入选的其他文件）
  while (picked.length < limit) {
    const best = pickMostRemaining(files, groups, cursor);
    if (!best) break; // 所有文件都已取完
    picked.push(groups.get(best)[cursor.get(best)]);
    cursor.set(best, cursor.get(best) + 1);
  }

  return withTruncationNote(picked.map((e) => e.text), entries.length);
}

/**
 * 判定一个**目录名**是否是工作区根上的临时产物（`DISCIPLINE-C2`）。
 *
 * ★ 2026-11-18 修两处（外部实测 `G:\AMup` 抓到 `.dsh-smoke-tmp` 未被抓）：
 *
 *   ① **点号开头的目录从不匹配**。旧写法四个模式全部是 `/^pip-/` 形状，
 *      `^` 直接要求首字符是字母 ⇒ `.pip-x` / `.diag-x` / `.tmpabcde` 一律漏。
 *      实测正对照（报告 §1.4）：`pip-tmp1` ✔、`tmpabcde` ✔、`cdp-profile-x` ✔、
 *      `diag-12345` ✔、**`.dsh-smoke-tmp` ✘**。
 *
 *   ② **后缀形态完全没覆盖**。报告把根因只归到"点号"，但那不完整：
 *      `dsh-smoke-tmp` **即使去掉点号也不匹配任何前缀**。
 *      它的形态是「`-tmp` 结尾」，是临时产物的常见命名，而模式表只认前缀。
 *
 *   ⇒ 现在：先剥掉前导点再匹配前缀，并补「`-tmp` / `-temp` / `-tmpdir` 结尾」形态。
 *
 * ★ 诚实的边界：这仍是**固定模式表**，不是"任意临时名"识别。
 *   标题已注明覆盖哪些形态；没列出的形态不会被抓，也不假装抓。
 */
export function isJunkDirName(rawName) {
  const name = String(rawName || '').replace(/^\.+/, '');
  if (!name) return false;
  const prefixShapes = [/^pip-/, /^tmp[a-z0-9_]{5,}$/i, /^cdp-profile-/, /^diag-[a-z0-9_]{5,}$/i];
  if (prefixShapes.some((re) => re.test(name))) return true;
  // 后缀形态要有分隔符：`smoke-tmp` 算，`temple` / `smoketmp` 不算（避免误伤正常名字）
  return /[-_.](tmp|temp|tmpdir)$/i.test(name);
}

/**
 * 把 `aggregateByFile` 的结果补上**截断自曝**（2026-11-18）。
 *
 * ★ 修的是什么（实测）：
 *   造 40 个文件、每个 2 处超深嵌套 ⇒ `reason` 报「80 处超过 3 层」，
 *   而 `items` 只有 **30** 条，**且没有任何提示说被截断了**。
 *
 *   本项目的判据层反复强调「被截断与完整在文本与算术上都同形」
 *   （`rules.mjs:954` 一带就写着这句话），却在**自己的报告层**静默截断。
 *   同一个错误在不同层各犯一次 —— 这是最容易漏的那类。
 *
 *   在 2.7 万文件的仓库上，差异从"30 vs 80"会变成"30 vs 数千"，
 *   使用者看到 30 条会以为那就全部了。
 *
 * ★ 形态：沿用本文件的既有约定 —— 把自曝**作为末条追加**，
 *   而不是新增一个只有部分消费者会读的字段（`skippedNote` 就是同一写法）。
 *   这样 `--json` 消费者与文本输出都能看到，不需要改契约。
 */
function withTruncationNote(items, total) {
  if (items.length >= total) return items;
  return [
    ...items,
    `…… 另有 ${total - items.length} 处未列出（本项共 ${total} 处，此处仅示 ${items.length} 处）`,
  ];
}

/**
 * 挑出「剩余条数最多」的文件名；全都取完时返回 `null`。
 *
 * 抽成独立函数的原因：内联会让 `aggregateByFile` 里出现
 * `while` → `for` → `if` 四层嵌套，而本项目的 KISS-C1 自举判据会当场判红
 * （实测：`rules.mjs:1674=4`）。**判据抓得对** —— 这段逻辑确实值得单独命名。
 */
function pickMostRemaining(files, groups, cursor) {
  let best = null;
  let bestRemain = 0;
  for (const f of files) {
    const remain = groups.get(f).length - cursor.get(f);
    if (remain > bestRemain) {
      bestRemain = remain;
      best = f;
    }
  }
  return best;
}

/** 建上下文：统一管理文件读取缓存、路径基准与路径显示。 */export function buildContext({ art, changeDir, repo, cwd, cfg = {}, codeRoots = [], diff = null, evidence = null, codeReport = null, codeFilesIn = null }) {
  const cache = new Map();
  const rawRead = (f) => {
    if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8'));
    return cache.get(f);
  };
  /**
   * 扫描代码根并留下收据（A06）。
   *
   * 旧实现 `for (root) for (f of walkCode(root)) push(f)` 的致命点：
   * walkCode 对**文件根** readdir 抛错后返回空数组 ⇒ 该根贡献 0 个文件 ⇒
   * 自检默认根里的 `cli.mjs` 从未被扫描，而报告只说"扫描 14 个文件"。
   * 现在用 scanCodeRoots，每个根都会在收据里留下 kind/files/errors。
   *
   * ★ 2026-11-16：优先接受调用方已扫好的 `codeFilesIn`。
   *   cli.mjs 在规则执行**之前**就要用收据判错，已经扫了一次；
   *   若这里再扫一次，两次扫描必须得到相同结果，而它们之间任何一处
   *   参数不同（例如 gitignore 过滤的 repo 根）都会让报告与实际不符。
   *   实测踩过：cli 带着 repo 过滤扫出 56 个，这里不带 repo 又扫出 201 个。
   */
  const scan = codeFilesIn ? { files: codeFilesIn, report: codeReport } : scanCodeRoots(codeRoots, { repo });
  const files = scan.files;

  // 路径基准：显式 --repo 优先；否则用 --code 的首个根，再否则用 change 目录。
  // ★ A03：一旦定下 repo，它就是**唯一**解析基准 —— existsProjectFile 不再回落 cwd。
  const repoRoot = resolve(repo || codeRoots[0] || changeDir);
  const codeFiles = [...new Set(files)].sort();
  // 扫描面收据（A06）：候选数/已处理数/每个根的失败原因都要能被报告出来。
  // 调用方（cli.mjs）可传入自己的收据覆盖 —— 它还要在**执行规则前**就用收据判错。
  const contextReport = codeReport
    ? { ...codeReport, scanned: codeFiles.length }
    : { ...scan.report, scanned: codeFiles.length, candidates: scan.report.candidates ?? codeFiles.length };

  return {
    art,
    changeDir,
    repo: repoRoot,
    cwd,
    cfg,
    diff,
    evidence,
    codeFiles,
    codeReport: contextReport,
    readFile: rawRead,

    /**
     * 项目内路径是否存在 —— **唯一基准是 ctx.repo**（A03）。
     *
     * 旧实现是 `exists(resolve(repo,p)) || exists(resolve(cwd,p))`，
     * 于是"声明了 repo 下不存在的 src/outside.js，而它恰好在 cwd 下存在" ⇒ PASS。
     * 判据验的是**另一个目录的文件**，这正是审计 A03 的第一条实测。
     *
     * 另外两类旧实现会静默放行、现在必须显式拒绝的引用：
     *   · 绝对路径（不是仓库内声明）
     *   · 归一化后越界的点段（`src/../outside.js`）
     * 它们不该被读成"存在"，也不该被读成"不存在" —— 而是"引用写法本身不合法"。
     * 为此拆分出 classifyRef()，由调用方决定是 fail 还是 skip。
     */
    existsProjectFile(p) {
      const r = resolveRepoRef(p);
      return r.ok && repoFileExists(repoRoot, r.rel);
    },

    /** 引用分类：'ok' | 'absolute' | 'escape' | 'empty'。见 existsProjectFile 的注释。 */
    classifyRef(p) {
      const r = resolveRepoRef(p);
      if (r.ok) return { kind: 'ok', rel: r.rel };
      if (isAbsoluteLike(p)) return { kind: 'absolute', reason: r.reason };
      if (!String(p || '').trim()) return { kind: 'empty', reason: r.reason };
      return { kind: 'escape', reason: r.reason };
    },

    /**
     * 仓库内相对路径（归一化后）。基准同样**只有 repo**：
     * 用 cwd 相对路径会让 `--repo` 指向别处时所有文件都落到前缀之外，
     * 检查静默变成空集（旧实现正是这样）。
     */
    relRepo(f) {
      const abs = resolve(f).replace(/\\/g, '/');
      const base = resolve(repoRoot).replace(/\\/g, '/');
      return abs.startsWith(base + '/') ? abs.slice(base.length + 1) : abs;
    },

    rel(f) {
      const norm = resolve(f).replace(/\\/g, '/');
      const rnorm = resolve(repoRoot).replace(/\\/g, '/');
      return norm.startsWith(rnorm + '/') ? norm.slice(rnorm.length + 1) : norm;
    },
  };
}
