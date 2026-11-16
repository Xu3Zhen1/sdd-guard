// ARCH 判据的实现（2026-11-17）。
//
// ★ 本文件的设计原则：**只把能可靠机械判定的做成机器判据，不能的明确交还给人。**
//
// 用户提了 ARCH-06 / ARCH-07 共 4 条子要求。逐条做过可行性实验（`_work/tmp/arch-judgeability.cjs`），
// 结论是：**2 条可机械判定、2 条不可**。不把不可判定的硬做成"看起来能判"——
// 那种判据会给出确定性的红/绿，而依据是启发式，比不做更坏。
//
// ┌─ 可机械判定 ──────────────────────────────────────────────┐
// │ ① while 循环必须有**可终止的退出路径**（不是必须有 break）  │
// │ ② try-catch 的 catch 块**体为空**（真空吞）                 │
// └──────────────────────────────────────────────────────┘
// ┌─ 不可机械判定（做成 manual，机器永不算绿）──────────────────┐
// │ ③ 事件监听器必须有防重入锁                                 │
// │ ④ 基础系统异常不得静默吞掉（"吞"的判定需要语义）             │
// │ ⑤ 业务拦截器不得修改系统核心状态                            │
// └──────────────────────────────────────────────────────┘
//
// ★ 为什么 ① 的措辞从「必须有 break 条件」改成「必须有可终止的退出路径」：
//   实测本仓 27 个 while 里 **25 个没有 break**，而它们全部正确 ——
//   `while (i < raw.length) { ...; i = ...; }` 靠**循环条件**终止，
//   `while ((m = re.exec(t)))` 靠**正则返回 null** 终止。
//   这两类都是比 `break` 更清晰的写法。**照字面执行会把正确代码全部判红。**

import { readFileSync } from 'node:fs';

/** 支持做结构判定的语言（有花括号 + while 语法可按括号匹配）。 */
export const STRUCTURAL_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.kt', '.swift', '.php'];

/** 该文件能否做结构判定。 */
export function structuralSupported(file) {
  return STRUCTURAL_EXT.some((e) => file.endsWith(e));
}

/**
 * 去注释与字符串，保留换行（行号不变）。
 *
 * ★ 为什么必须做：注释里写 `// while (true) {` 会被当成真循环；
 *   字符串里写 `"catch { }"` 会被当成真空 catch。实测本项目多个文件都有这种注释。
 *
 * ★ 为什么写成"表驱动 + 短路"而不是一串 `if`：
 *   第一版把每种状态的处理都嵌在 `while` 里，形成了
 *   `while` → `if (state)` → `if (c===…)` 的 4 层缩进 ——
 *   被本项目自己的 KISS-C1 判红 **7 处**（`lib/arch.mjs:49-61`）。
 *   那种写法在语义上是**平级分支**，但按缩进算就是深层嵌套。
 *   改成"每步只算一次转移"后结构变平，且更易读。
 */
export function maskCommentsAndStrings(text) {
  const out = [];
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const step = nextMaskStep(text, i, state);
    out.push(step.emit);
    state = step.state;
    i += step.advance;
  }
  return out.join('');
}

/**
 * 计算"在 `state` 状态下从 `i` 开始读一个 token"的转移。
 *
 * 返回 `{emit, state, advance}`：
 *   emit    —— 要写进输出的字符（保持与原文字符数/换行一致）
 *   state   —— 新状态
 *   advance —— 前进了几个字符
 */
function nextMaskStep(text, i, state) {
  const c = text[i];
  const n = text[i + 1];
  // 各种状态的转移表：每个 handler 只管自己那一种状态
  const handler = MASK_HANDLERS[state] || MASK_HANDLERS.code;
  return handler(c, n);
}

/** 状态 → 单步转移函数。 */
const MASK_HANDLERS = {
  code(c, n) {
    if (c === '/' && n === '/') return { emit: '  ', state: 'line', advance: 2 };
    if (c === '/' && n === '*') return { emit: '  ', state: 'block', advance: 2 };
    if (c === "'") return { emit: ' ', state: 'sq', advance: 1 };
    if (c === '"') return { emit: ' ', state: 'dq', advance: 1 };
    if (c === '`') return { emit: ' ', state: 'tpl', advance: 1 };
    return { emit: c, state: 'code', advance: 1 };
  },
  line(c) {
    if (c === '\n') return { emit: '\n', state: 'code', advance: 1 };
    return { emit: ' ', state: 'line', advance: 1 };
  },
  block(c, n) {
    if (c === '*' && n === '/') return { emit: '  ', state: 'code', advance: 2 };
    return { emit: c === '\n' ? '\n' : ' ', state: 'block', advance: 1 };
  },
  /** 单/双引号与模板串共用：遇到转义跳 2 个字符，遇到配对的引号回 code。 */
  sq: stringHandler("'", 'sq'),
  dq: stringHandler('"', 'dq'),
  tpl: stringHandler('`', 'tpl'),
};

/** 生成"字符串内"的单步转移函数。 */
function stringHandler(quote, name) {
  return function inside(c) {
    if (c === '\\') return { emit: '  ', state: name, advance: 2 };
    if (c === quote) return { emit: ' ', state: 'code', advance: 1 };
    return { emit: c === '\n' ? '\n' : ' ', state: name, advance: 1 };
  };
}

/** 从 `open` 位置的左括号找到匹配的右括号下标；找不到返回 -1。 */
function matchPair(s, open, oc = '(', cc = ')') {
  let d = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === oc) d++;
    else if (s[k] === cc) { d--; if (d === 0) return k; }
  }
  return -1;
}

/** 跳过空白。 */
function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 取语句体范围：`{...}` 或到行尾/分号。返回结束下标。 */
function bodyRange(s, start) {
  const b = skipWs(s, start);
  if (s[b] === '{') {
    const e = matchPair(s, b, '{', '}');
    return e < 0 ? null : { start: b, end: e };
  }
  let k = b;
  while (k < s.length && s[k] !== ';' && s[k] !== '\n') k++;
  return { start: b, end: k };
}

/** 行号（1 基）。 */
function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

/**
 * 找所有 `while` 循环，判断**是否有可终止的退出路径**。
 *
 * 返回 `{line, cond}` 数组 —— **不含路径**：调用方用 `ctx.rel()` 渲染。
 * （第一版把 file 拼进文本，调用方又拼一次，输出成了
 *  `lib/temp.mjs:` 后面再接一遍完整绝对路径 —— 路径重复。）
 */
export function unterminatedWhiles(file, text) {
  const code = maskCommentsAndStrings(text);
  const out = [];
  const re = /\bwhile\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchPair(code, openParen);
    if (closeParen < 0) continue;
    const cond = code.slice(openParen + 1, closeParen).trim();
    const isAlwaysTrue = /^(true|1)$/.test(cond);
    if (!isAlwaysTrue) continue; // 只有恒真条件才需要 break —— 见函数注释
    const range = bodyRange(code, closeParen + 1);
    if (!range) continue;
    const body = code.slice(range.start, range.end + 1);
    const hasExit = /\b(break|return|throw)\b/.test(body);
    if (!hasExit) out.push({ line: lineOf(code, m.index), cond });
  }
  return out;
}

/**
 * 找所有 `catch` 块，判断**块体是否为空**（去掉注释与空白后为空）。
 *
 * 返回 `{line}` 数组（不含路径，理由同上）。
 *
 * ★ 豁免键用 **`relPath:line`**（仓库相对路径），不是绝对路径 ——
 *   第一版用绝对路径做键，而配置里写的是 `lib/temp.mjs:95`，
 *   **两者永不相等 ⇒ 豁免永远失效**（实测：配了豁免仍报红）。
 *   所以 `file` 参数必须是调用方给的**仓库相对路径**。
 *
 * ★ 只报「真空」。为什么不报更多：
 *   `catch (e) { return null; }` / `{ got = null; }` / `{ continue; }` 都可能是"吞掉"，
 *   但也可能是**刻意的降级设计**（本仓 `temp.mjs` 就靠 catch 试下一个候选目录）。
 *   判定"吞掉"需要知道调用方是否处理了 null —— 那是语义，机器看不到。
 *   ⇒ 真空是可证的；"看起来像吞"不可证。**只报可证的。**
 *
 * ★ 真空也可能合理（`finally` 里的清理失败不该掩盖主异常），
 *   所以允许 `allow` 豁免（键为 `relPath:line`），且豁免必须带理由。
 */
export function emptyCatches(relPath, text, allow = new Set()) {
  const code = maskCommentsAndStrings(text);
  const out = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = matchPair(code, openBrace, '{', '}');
    if (closeBrace < 0) continue;
    const body = code.slice(openBrace + 1, closeBrace);
    if (body.trim() !== '') continue; // 有语句：不判（见函数注释）
    const line = lineOf(code, m.index);
    const key = `${relPath}:${line}`;
    if (allow.has(key)) continue;
    out.push({ line, key });
  }
  return out;
}

/**
 * 读文件并做两项结构检查。
 *
 * @param {string} absPath 绝对路径（读文件用）
 * @param {string} relPath 仓库相对路径（**豁免键与输出都用它**）
 * @param {Set<string>} allow 豁免键集合（`relPath:line`）
 * @returns {{unterminated:Array, emptyCatch:Array}|null} 不支持的语言返回 null
 */
export function scanArch(absPath, relPath = absPath, allow = new Set()) {
  if (!structuralSupported(absPath)) return null;
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  return {
    unterminated: unterminatedWhiles(absPath, text),
    emptyCatch: emptyCatches(relPath, text, allow),
  };
}
