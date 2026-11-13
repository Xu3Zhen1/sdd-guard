// 代码扫描：只做三件可机械判定的事——嵌套深度、跨文件重复块、投机性标记。
// 这里刻意不判断"这个抽象好不好"，那是人的事。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withinPrefix } from './paths.mjs';

export const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', '.venv', '__pycache__', 'target']);

/**
 * 扫一个代码根，并**留下完整扫描收据**（A06）。
 *
 * 旧实现的三个静默点，每一个都能把"没扫描"读成"扫描了没问题"：
 *   ① 根是**文件**时 `readdirSync` 抛错，错误被吞 ⇒ 该根贡献 0 个文件。
 *      自检默认根里的 `cli.mjs` 正是文件 ⇒ **整个 CLI 入口从未被代码级规则扫过**，
 *      而报告只说"扫描 14 个文件"。
 *   ② 子目录不可读时同样吞掉 ⇒ 其余文件照扫，结论仍是 PASS。
 *   ③ 只报"规则执行了一次"，不报候选/已处理/排除原因。
 *
 * 现在的契约：目录（递归）或单个源码文件都接受；收据里逐根记录 kind/files/errors。
 * **一个根出错不代表整次失败，但它必须出现在收据里**，由调用方决定是否升级。
 *
 * @returns {{files:string[], report:{roots:Array, candidates:number, scanned:number, errors:string[]}}}
 */
export function scanCodeRoots(roots, { skip = [], ext = CODE_EXT } = {}) {
  const skipSet = new Set([...SKIP_DIRS, ...skip]);
  const files = [];
  const report = { roots: [], candidates: 0, scanned: 0, errors: [] };
  for (const root of roots) {
    const entry = scanOneRoot(root, { skipSet, ext, files, report });
    report.roots.push(entry);
  }
  // ★ 收据字段必须**有真值**（t-gates 2026-11-13 抓到：原先这两个字段初始化后从未赋值，
  //   恒为 0 —— "看着像数据、其实是没测"，与本项目一贯反对的形态同类）。
  //   candidates = 命中可扫描后缀的候选数；scanned = 实际进入规则处理的文件数。
  //   当前实现里两者相等（调用方不再二次过滤）；将来若加过滤，scanned 必须单独维护。
  report.candidates = files.length;
  report.scanned = files.length;
  // 逐根的排除原因汇总（与 report.errors 同源，便于按根解释）。
  report.excluded = report.roots.flatMap((r) => r.errors.map((e) => `${r.root}: ${e}`));
  return { files: files.sort(), report };
}

/** 扫一个根，把命中文件推进 `files`、把收据推进 `report.errors`，返回该根的 entry。 */
function scanOneRoot(root, { skipSet, ext, files, report }) {
  const entry = { root, kind: 'unknown', files: 0, errors: [] };
  const fail = (kind, msg) => {
    entry.kind = kind;
    entry.errors.push(msg);
    report.errors.push(`${root}: ${msg}`);
    return entry;
  };
  let st;
  try {
    st = statSync(root);
  } catch (e) {
    return fail('missing', `不可访问: ${e.code || e.message}`);
  }
  if (st.isFile()) return scanFileRoot(root, ext, files, entry);
  if (!st.isDirectory()) return fail('other', '既不是文件也不是目录');
  entry.kind = 'dir';
  const before = files.length;
  visitDir(root, { skipSet, ext, files, entry, report });
  entry.files = files.length - before;
  if (entry.files === 0) entry.errors.push('该根下没有可扫描的源码文件');
  return entry;
}

/** 单文件根：后缀不合规要留痕，不能静默贡献 0 个文件（A06 的原始缺陷）。 */
function scanFileRoot(root, ext, files, entry) {
  entry.kind = 'file';
  if (!ext.has(extname(root))) {
    entry.errors.push(`后缀不在可扫描集合内: ${extname(root)}`);
    return entry;
  }
  files.push(root);
  entry.files = 1;
  return entry;
}

/** 递归目录；不可读子目录**必须留痕**（旧实现 `catch { return; }` 让部分目录消失后仍 PASS）。 */
function visitDir(dir, ctx) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    ctx.entry.errors.push(`目录不可读: ${dir}（${e.code || e.message}）`);
    ctx.report.errors.push(`${dir}: 目录不可读（${e.code || e.message}）`);
    return;
  }
  for (const ent of ents) {
    if (ctx.skipSet.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) visitDir(p, ctx);
    else if (ent.isFile() && ctx.ext.has(extname(ent.name))) ctx.files.push(p);
  }
}

/** 兼容旧签名：只返回文件列表（调用方需要收据时用 scanCodeRoots）。 */
export function walkCode(root, opts = {}) {
  return scanCodeRoots([root], opts).files;
}

/**
 * 嵌套深度：返回 [{file, line, depth}]。
 *
 * ★ A04 的两个实测漏检都出在**左右括号不对称**上：
 *
 *   ① 对象右括号扣减控制流深度。
 *      三层 if 里插一个多行对象字面量，随后再嵌套第四层 if：
 *      对象本身不增深度（这是对的），但它结束时的 `}` 被从**控制流深度**里扣掉一层，
 *      于是第四层被报成 3 ⇒ PASS。判据承诺"对象不计、控制流四层计"，却给了假绿。
 *   ② 单行四层控制流完全不产生命中。
 *      旧实现只在"进入该行前 depth > 0"时保存命中，而同一行的开闭会互相抵消。
 *
 * 修法（不引入 AST，仍是词法级，但**结构自洽**）：
 *   · 一个**括号栈**：每个 `{` 都压栈、每个 `}` 都弹栈，**配对来自同一实现**；
 *     只有弹出的是"块"才扣控制流深度 —— 对象右括号因此不再吃掉控制流层数。
 *   · 逐字符扫每一行，记录该行内到达过的**最大**控制深度，单行紧凑写法不再漏计。
 *   · 词法状态（块注释 / 字符串 / 模板串 `��{}` / 正则字面量）跨行维护：
 *     这是必要的 —— 旧实现把 `'…'`、`"…"` 直接替换成 `''`，却完全不管反引号，
 *     于是模板串里的花括号被当成代码括号计数。
 */
export function nestingDepth(file, text) {
  const lines = text.split(/\r?\n/);
  if (file.endsWith('.py')) return pyNesting(file, lines);
  return jsNesting(file, lines);
}

/** Python：按缩进计层（沿用原语义：4 空格 = 1 层）。 */
function pyNesting(file, lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    const depth = Math.floor(indent / 4);
    if (depth > 0) hits.push({ file, line: i + 1, depth });
  }
  return hits;
}

/** 行首 `{` 算不算块：看它前面**最后一个有效字符**的语境。 */
const BLOCK_AFTER = new Set([')', ';', '{', '}', '>']);
/** 这些字符后面跟的 `{` 是对象/取值表达式，不是块。 */
const OBJECT_AFTER = new Set(['[', ',', '(', '=', ':', '?', '+', '-', '*', '/', '%', '&', '|', '^', '!', '<']);
const BLOCK_WORDS = new Set(['else', 'do', 'try', 'finally']);

/**
 * 逐字符扫描 JS/TS 族文件，维护词法状态与括号栈。
 *
 * 统计口径：`lineMax[i]` = 第 i 行内到达过的**最大**控制流深度。
 * 词法状态（块注释/字符串/模板串/正则）必须跨行维护——
 * 旧实现把 `'…'`、`"…"` 替换成 `''` 却完全不管反引号，
 * 于是模板串里的花括号被当成代码括号计数（A04 的假绿来源之一）。
 *
 * 实现上刻意拆成「非代码模式消费」与「代码模式分派」两个纯函数：
 * 全写在一个 while 里会形成 5 层嵌套，本条判据（KISS-C1 阈值 3）会先判自己红。
 */
function jsNesting(file, lines) {
  const state = {
    lineMax: new Array(lines.length).fill(0),
    stack: [], // { kind: 'fn'|'block'|'obj', prevCtrl }
    ctrl: 0, // 当前函数体内的控制流嵌套层数
    modes: [{ kind: 'code' }],
    lastSig: null, // 最近一个有效字符（跳过空白/注释/字符串内容）
    lastWord: null, // 最近一个标识符
    lastCallee: '', // 最近一次 `)` 配对的 `(` 前面那个词
    parenStack: [], // 每个未闭合 `(` 前面那个词
    templateDepth: 0, // 模板表达式 `${ … }` 的花括号深度（防误配）
  };
  for (let li = 0; li < lines.length; li++) {
    state.line = li;
    scanLine(state, lines[li], li);
    // 行注释必须在行尾弹出，否则整份文件从第二行起全部被吞（真实的自灭 Bug）。
    while (state.modes.length > 1 && state.modes[state.modes.length - 1].kind === 'line-comment') state.modes.pop();
  }
  const hits = [];
  for (let i = 0; i < state.lineMax.length; i++) if (state.lineMax[i] > 0) hits.push({ file, line: i + 1, depth: state.lineMax[i] });
  return hits;
}

function scanLine(state, raw, li) {
  let i = 0;
  while (i < raw.length) {
    const mode = state.modes[state.modes.length - 1];
    const after = mode.kind === 'code' ? consumeCode(state, raw, i) : consumeLex(state, raw, i);
    i = after === null ? raw.length : after;
  }
  if (state.lineMax[li] === undefined) state.lineMax[li] = 0;
}

/** 记录该行到达过的最大深度。 */
function record(state, line, d) {
  if (d > (state.lineMax[line] ?? 0)) state.lineMax[line] = d;
}

/**
 * 消费一个非代码模式（块注释/行注释/字符串/模板串/正则）下的字符。
 * @returns {number|null} 下一个扫描位置；null 表示本行结束
 */
function consumeLex(state, raw, i) {
  const mode = state.modes[state.modes.length - 1];
  const ch = raw[i];
  const next = raw[i + 1];
  if (mode.kind === 'line-comment') return null;
  if (mode.kind === 'block-comment') {
    if (ch === '*' && next === '/') {
      state.modes.pop();
      return i + 2;
    }
    return i + 1;
  }
  if (mode.kind === 'string') {
    if (ch === '\\') return i + 2;
    if (ch === mode.quote) state.modes.pop();
    return i + 1;
  }
  if (mode.kind === 'template') {
    if (ch === '\\') return i + 2;
    if (ch === '`') {
      state.modes.pop();
      return i + 1;
    }
    if (ch === '$' && next === '{') {
      state.modes.push({ kind: 'code', template: true });
      state.templateDepth = 0;
      return i + 2;
    }
    return i + 1;
  }
  // regex
  if (ch === '\\') return i + 2;
  if (ch === '[') return skipCharClass(raw, i);
  if (ch === '/') state.modes.pop();
  return i + 1;
}

/** 跳过正则的字符类 `[…]`（其中的 `/` 不结束正则）。 */
function skipCharClass(raw, i) {
  let j = i + 1;
  while (j < raw.length && raw[j] !== ']') j += raw[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** 消费 code 模式下的一个字符。 */
function consumeCode(state, raw, i) {
  const ch = raw[i];
  const next = raw[i + 1];
  if (ch === '/' && next === '/') {
    state.modes.push({ kind: 'line-comment' });
    return i + 2;
  }
  if (ch === '/' && next === '*') {
    state.modes.push({ kind: 'block-comment' });
    return i + 2;
  }
  if (ch === '/' && isRegexStart(state.lastSig)) {
    state.modes.push({ kind: 'regex' });
    return i + 1;
  }
  if (ch === '"' || ch === "'") {
    state.modes.push({ kind: 'string', quote: ch });
    return i + 1;
  }
  if (ch === '`') {
    state.modes.push({ kind: 'template' });
    return i + 1;
  }
  if (ch === '(') return openParen(state, i);
  if (ch === ')') return closeParen(state, i);
  if (ch === '{') return openBrace(state, raw, i);
  if (ch === '}') return closeBrace(state, i);
  return consumePlain(state, raw, i);
}

function openParen(state, i) {
  state.parenStack.push(state.lastWord);
  return markSig(state, '(', i);
}

function closeParen(state, i) {
  // ★ 必须在**弹出时**记住配对词：`if (...) {` 的 `{` 在 `)` 之后，
  //   此刻栈已空 —— 读栈会永远拿到空串，把所有块都判成函数体（实测正是这个 bug）。
  state.lastCallee = state.parenStack.length ? state.parenStack.pop() : '';
  return markSig(state, ')', i);
}

function openBrace(state, raw, i) {
  const mode = state.modes[state.modes.length - 1];
  if (mode.template) {
    state.templateDepth += 1;
    return i + 1;
  }
  const kind = classifyOpen(raw, i, state.lastSig, state.lastWord, state.lastCallee);
  pushEntry(state, kind);
  if (kind !== 'obj') record(state, state.line, state.ctrl);
  return markSig(state, '{', i);
}

function closeBrace(state, i) {
  const mode = state.modes[state.modes.length - 1];
  if (mode.template) return closeTemplateExpr(state, i);
  // 右括号**只弹出它所属的那一层**：对象结尾不扣控制流层数（A04-① 的修法）。
  popEntry(state);
  return markSig(state, '}', i);
}

function closeTemplateExpr(state, i) {
  if (state.templateDepth === 0) {
    state.modes.pop(); // 回到模板串
    return i + 1;
  }
  state.templateDepth -= 1;
  return i + 1;
}

/** 普通字符：更新 lastSig/lastWord（标识符整体跳过）。 */
function consumePlain(state, raw, i) {
  const ch = raw[i];
  if (/\s/.test(ch)) return i + 1;
  if (/[A-Za-z_$]/.test(ch)) {
    let j = i;
    while (j < raw.length && /[A-Za-z0-9_$]/.test(raw[j])) j++;
    state.lastWord = raw.slice(i, j);
    state.lastSig = ch;
    return j;
  }
  return markSig(state, ch, i);
}

function markSig(state, sig, i) {
  state.lastSig = sig;
  state.lastWord = '';
  return i + 1;
}

/**
 * 压一层。
 *
 * ★ 函数体**也算一层**（不改这条既有语义）。依据是两条已存在的负控：
 *   · "普通四层 if（裸写、无外层函数）⇒ FAIL" —— 审计 A04 的正控；
 *   · "函数体内 for → if → while ⇒ 必须 FAIL" —— guard.test.mjs:568 的负控，
 *     它明确写着「改语义不能把真问题一起放过」。
 * 只有"函数体算一层"能同时满足两者；改用 eslint max-depth 口径会让后者变绿。
 */
function pushEntry(state, kind) {
  state.stack.push({ kind, prevCtrl: state.ctrl });
  if (kind !== 'obj') state.ctrl += 1;
}

function popEntry(state) {
  const e = state.stack.pop();
  if (e) state.ctrl = e.prevCtrl;
}

/** `/` 是否开启正则字面量（而不是除号）。 */
function isRegexStart(lastSig) {
  if (lastSig === null) return true;
  return !/[A-Za-z0-9_$)\]}"'`]/.test(lastSig);
}

/**
 * 判断一个 `{` 属于哪一类：`'fn'`（函数体/箭头函数体）、`'block'`（控制流块）、`'obj'`（对象字面量）。
 *
 * 判据按位置优先级：
 *   ① 行内非行首：前面是同行的 `)` / `=>` / else / do / try / finally ⇒ 块或函数体；
 *      前面是 `=` / `(` / `[` / `,` / `:` / `return` ⇒ 对象。
 *   ② 行首（本行到此只有空白）：看**上一处有效字符**——
 *      `)` `;` `{` `}` `>`，或 else/do/try/finally，或文件开头 ⇒ 块；
 *      `[` `,` `(` `=` `:` 之后 ⇒ 对象（数组元素、参数、赋值右侧）。
 *      这一条专门修 `RULES = [` 后每行一个 `{ … }` 这种**行首对象字面量**：
 *      旧实现把它当块，于是对象结尾的 `}` 又扣一层，两个方向互相掩盖。
 *
 * **函数体与控制流块的区分**（决定控制深度是否归零）：
 *   `{` 紧跟 `)` 时，看这个 `)` 配对的 `(` **前面那个词**——
 *   `if / for / while / switch / catch / with` 是控制语句 ⇒ 块；
 *   其余（函数名、匿名函数、方法名）⇒ 函数体。
 *   `=>` 之后 ⇒ 函数体。
 */
function classifyOpen(raw, idx, lastSig, lastWord, parenCallee) {
  const before = raw.slice(0, idx).trimEnd();
  const atLineStartOnlyWhitespace = before === '';
  if (!atLineStartOnlyWhitespace) {
    if (BLOCK_WORDS.has(lastWord)) return 'block';
    if (/=>\s*$/.test(before)) return 'fn';
    if (/\)\s*$/.test(before)) return functionBodyByCallee(parenCallee);
    if (OBJ_PREFIX.test(before)) return 'obj';
    return 'obj';
  }
  // 行首：本行该 `{` 之前只有空白
  if (lastSig === null) return 'block';
  if (BLOCK_WORDS.has(lastWord)) return 'block';
  if (lastSig === ')') return functionBodyByCallee(parenCallee);
  if (lastSig === '>') return 'fn'; // `=>` 的 `>`
  if (lastSig === ';' || lastSig === '{' || lastSig === '}') return 'block';
  if (OBJECT_AFTER.has(lastSig)) return 'obj';
  return 'obj'; // 其余按对象处理（方向安全：少计胜过虚高误报）
}

/** 控制语句的括号不是参数表；其余都是函数参数表。 */
const CONTROL_PAREN_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
function functionBodyByCallee(callee) {
  return CONTROL_PAREN_WORDS.has(callee) ? 'block' : 'fn';
}

/** 规范化：去缩进、折叠空白。只丢弃空行与纯注释行——**保留花括号行**。
 *  早期版本把孤立 `}` 也当无效行，导致含闭括号的窗口被判无效、复制粘贴检测整段失效。 */
function normalize(line) {
  const t = line.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^(\/\/|#|\*|\/\*|\*\/)/.test(t)) return null;
  return t;
}

/**
 * 跨文件重复块：窗口 N 行规范化后相同（不同文件视为复制粘贴）。
 * 空行/注释行不参与序列但保留各自原始行号，避免它们把窗口切断。
 * 返回 [{size, a:{file,line}, b:{file,line}, sample}]。
 */
export function duplicateBlocks(files, size = 6, opts = {}) {
  const minChars = opts.minChars ?? 40;
  const index = new Map();
  const found = [];
  for (const f of files) {
    for (const win of windowsOf(f, size, minChars)) recordWindow(win, f, size, index, found);
  }
  // 同一对文件同一位置只报一次
  const seen = new Set();
  return found.filter((d) => {
    const k = `${d.a.file}:${d.a.line}|${d.b.file}:${d.b.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 取一个文件里所有"够长"的规范化窗口。 */
function windowsOf(file, size, minChars) {
  const text = readFileSync(file, 'utf8');
  const seq = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = normalize(raw);
    if (n !== null) seq.push({ text: n, line: i + 1 });
  });
  const out = [];
  for (let i = 0; i + size <= seq.length; i++) {
    const win = seq.slice(i, i + size);
    const key = win.map((w) => w.text).join('\n');
    if (key.length < minChars) continue;
    out.push({ key, line: win[0].line, sample: win.slice(0, 3).map((w) => w.text).join(' / ') });
  }
  return out;
}

/** 登记一个窗口：首次出现只入索引；跨文件重复才报告（同文件内重复常是合理的数据表）。 */
function recordWindow(win, file, size, index, found) {
  const prev = index.get(win.key);
  if (!prev) {
    index.set(win.key, { ...win, file });
    return;
  }
  if (prev.file === file) return;
  found.push({ size, a: { file: prev.file, line: prev.line }, b: { file, line: win.line }, sample: win.sample });
}

// ─────────────────────────────────────────────────────────────
// 前后端解耦：抽 import 说明符 + 按边界前缀归类
// ─────────────────────────────────────────────────────────────

/** 引号字符集合（避免在源码里直接写三个引号字面量，易被编辑工具转义弄坏）。 */
const QUOTES = new Set(['"', "'", String.fromCharCode(96)]);

/**
 * 去掉注释（行注释/块注释）但**保留字符串字面量**，因为 import 说明符本身在字符串里。
 *
 * A13：旧实现对原始文本直接跑正则，于是**块注释里的 import 被当成真实跨边界依赖**，
 * 报 FAIL「1 处跨边界直接引用」，而注释里没有可执行依赖 —— 假红。
 *
 * 字符串边界判断决定"`//` 是注释还是 URL/正则的一部分"。
 * 这里的选择是**保守的**：字符串内的 `//` 不当注释，注释内的字符串不重复开启，
 * 宁可漏掉罕见的边界写法，也不把注释里的引用当成真实依赖。
 */
/**
 * 去掉注释、保留字符串与代码。用于"在源码里找某种写法"的所有判据。
 *
 * ★ 导出（2026-11-14）：`tools/check-contract.mjs` 需要它 —— 它在 `rules.mjs` 里搜
 * `cfg.<key> ?? <literal>`，而**我自己写的注释里就含有 `ctx.cfg.maxDiffLines ?? 400`**
 * （为了说明旧行为），于是检查器把"文档说明"当成了"实现里还有隐式默认值"，报假红。
 *
 * 这是同一类错误：**判据不能匹配到自己的说明文字**。复用一个真正的词法器，
 * 比在检查器里再手写一遍去注释安全。
 */
export function stripComments(text) {
  const st = { out: '', i: 0, quote: null, inBlock: false };
  while (st.i < text.length) {
    st.i = st.inBlock ? skipBlockComment(text, st) : st.quote ? skipQuoted(text, st) : stepPlain(text, st);
  }
  return st.out;
}

/** 块注释内：直到注释终止符，非换行字符替换成空格以保留行号。 */
function skipBlockComment(text, st) {
  if (text[st.i] === '*' && text[st.i + 1] === '/') {
    st.inBlock = false;
    return st.i + 2;
  }
  st.out += text[st.i] === '\n' ? '\n' : ' ';
  return st.i + 1;
}

/** 字符串内：转义跳两格，闭合引号清状态。 */
function skipQuoted(text, st) {
  st.out += text[st.i];
  if (text[st.i] === '\\') {
    st.out += text[st.i + 1] ?? '';
    return st.i + 2;
  }
  if (text[st.i] === st.quote) st.quote = null;
  return st.i + 1;
}

/** 代码态：开启注释/字符串，或原样输出。 */
function stepPlain(text, st) {
  const ch = text[st.i];
  const next = text[st.i + 1];
  if (ch === '/' && next === '*') {
    st.inBlock = true;
    st.out += '  ';
    return st.i + 2;
  }
  if (ch === '/' && next === '/') return skipLineComment(text, st);
  if (QUOTES.has(ch)) st.quote = ch;
  st.out += ch;
  return st.i + 1;
}

/** 行注释：整段替换成空格，保留行尾换行。 */
function skipLineComment(text, st) {
  let i = st.i;
  while (i < text.length && text[i] !== '\n') {
    st.out += ' ';
    i++;
  }
  return i;
}

/**
 * 抽取一个文件里的 import/require/use 说明符。
 * 只做**可判定**的部分：静态 import / require / from-import / Go import / Java import。
 * 不做动态拼接路径（`await import(someVar)`）——那类无法判定，宁可漏报也不误报。
 *
 * ★ A13：先剔除注释，再抽说明符。未被支持的语言返回 `{supported:false}` 的信号
 * 由此函数的调用方负责显式报告，而不是"扫描了后缀就等于支持该语言"。
 */
export function importSpecifiers(file, text) {
  const out = [];
  const ext = extname(file);
  const push = (spec) => {
    if (!spec) return;
    const s = spec.trim();
    if (s) out.push(s);
  };
  const code = stripComments(text);

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    for (const m of code.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) push(m[1]);
    for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
    for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
    for (const m of code.matchAll(/(?:^|\n)\s*export\s+[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) push(m[1]);
  } else if (ext === '.py') {
    for (const m of code.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) push(m[1].replace(/\./g, '/'));
    for (const m of code.matchAll(/^\s*import\s+([\w.]+)/gm)) push(m[1].replace(/\./g, '/'));
  } else if (ext === '.go') {
    for (const m of code.matchAll(/^\s*import\s+(?:\(\s*)?["`]([^"`]+)["`]/gm)) push(m[1]);
    for (const m of code.matchAll(/^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]\s*$/gm)) push(m[1]);
  } else if (ext === '.java') {
    for (const m of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) push(m[1].replace(/\./g, '/'));
  } else if (ext === '.rs') {
    // Rust：`use a::b::c;` / `extern crate x;`
    for (const m of code.matchAll(/^\s*use\s+([\w:]+)/gm)) push(m[1].replace(/::/g, '/'));
    for (const m of code.matchAll(/^\s*extern\s+crate\s+(\w+)/gm)) push(m[1]);
  }
  return [...new Set(out)];
}

/** 该后缀的 import 语法是否真的受支持（A13："扫了后缀"不等于"支持该语言"）。 */
export function importSyntaxSupported(file) {
  return ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.java', '.rs'].includes(extname(file));
}

/**
 * 把一个路径映射到边界名。
 * 规则：boundaries 是 { 名称: [路径前缀...] }，按**最长前缀**匹配，避免 `src/` 抢走 `src/shared/`。
 * 匹配用仓库相对路径，前缀一律归一为 `/`。
 *
 * ★ A03：前缀比较必须**归一化之后按段边界**做。
 *   旧实现是 `p.startsWith(pre)`，于是 `src/../outside.js` 和 `srcx/x.js` 都会命中 `src/`。
 */
export function boundaryOfPath(relPath, boundaries) {
  const p = String(relPath).replace(/\\/g, '/');
  let best = null;
  let bestLen = -1;
  for (const [name, prefixes] of Object.entries(boundaries || {})) {
    for (const raw of Array.isArray(prefixes) ? prefixes : [prefixes]) {
      const pre = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!pre || !withinPrefix(p, pre)) continue;
      const hit = pre.length > bestLen;
      best = hit ? name : best;
      bestLen = hit ? pre.length : bestLen;
    }
  }
  return best;
}

/** 把说明符解析成「仓库相对路径或边界前缀」的候选（相对路径按导入方目录解析）。 */
export function resolveSpecifier(spec, fromFile, repo) {
  const s = String(spec);
  if (s.startsWith('.')) {
    const abs = resolve(dirname(fromFile), s);
    return { kind: 'relative', abs };
  }
  if (s.startsWith('/')) return { kind: 'absolute', abs: s };
  return { kind: 'bare', spec: s };
}

// 哪些 `{` 算「一层嵌套」的判定集中在 classifyOpen()（见上），
// 两个正则只服务于**单行内**那一支：`{` 紧跟在 `)` / `=>` / else / do / try / finally 之后 ⇒ 块。
const BLOCK_PREFIX = /(?:\)|=>|\belse|\bdo|\btry|\bfinally)\s*$/;
const OBJ_PREFIX = /(?:=|\(|\[|,|:|\breturn)\s*$/;

/** 投机性标记：YAGNI 的可判定子集——明确写着"以后可能用到"。 */
// 投机性标记的**模式表放在 json 里**，不写成代码里的正则字面量。
// 原因（自举实测发现）：写在 .mjs 里时，正文字符串本身就是这些待检标记的原文，
// 于是 YAGNI-C1 会把自己的模式定义当违例报出来 —— 检测器的自指误报。
// json 不在 CODE_EXT 内，永远不会被当作源码扫描。
const MARKERS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'speculative-markers.json');

function loadSpeculativePatterns() {
  const raw = JSON.parse(readFileSync(MARKERS_FILE, 'utf8'));
  return raw.map((m) => ({ re: new RegExp(m.pattern, m.flags || ''), why: m.why }));
}

export const SPECULATIVE_PATTERNS = loadSpeculativePatterns();

export function speculativeMarks(file, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of SPECULATIVE_PATTERNS) {
      if (p.re.test(lines[i])) out.push({ file, line: i + 1, why: p.why, text: lines[i].trim().slice(0, 120) });
    }
  }
  return out;
}

export { statSync, relative };
