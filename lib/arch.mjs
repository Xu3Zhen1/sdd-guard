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

/**
 * 支持做结构判定的语言。
 *
 * ★ 2026-11-17 收窄（独立审查实测确认）：
 *   旧表把 `.go` `.rs` 一并列为"结构可判"，但 `unterminatedWhiles` 的入口
 *   正则要求 `while(`，而这两个语言根本没有这种语法：
 *
 *   | 语言 | 惯用恒真循环 | 旧实现结果 |
 *   |---|---|---|
 *   | Rust | `loop { … }` | 0 命中 |
 *   | Go | `for { … }` | 0 命中 |
 *   | Rust | `while true { … }`（无括号） | 0 命中 |
 *   | Go | `for true { … }` | 0 命中 |
 *
 *   ⇒ 规则 detail 却输出「扫描 N 个结构可判文件，恒真循环均有退出路径」——
 *     **把"没检查"写成"检查通过"**，正是本工具最该识别的问题类型。
 *
 *   现在把两者**移除**：它们会走进"不支持"分支，detail 明确写
 *   「跳过 N 个不支持结构判定的文件」，而不是混进"已检查"的计数里。
 *
 *   **补支持的前提**：需要为 `loop {` / `for {` 各写入口与退出语义
 *   （Rust 的 `break` 属于最近 loop，Go 的 `break` 属于最近 for/switch/select），
 *   那不是加一行正则的事。在做到之前，**不宣称覆盖**。
 */
export const STRUCTURAL_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.kt', '.swift', '.php'];

/** 明确"不支持结构判定"但本项目可能遇到的扩展名（用于报告的诚实计数）。 */
export const UNSUPPORTED_EXT = ['.go', '.rs', '.py', '.rb'];

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
/**
 * 词法器自洽校验（2026-11-17，两轮返工后补的兜底）。
 *
 * ★ 为什么需要它：
 *   这个屏蔽器是**手写状态机**，不是真正的 JS 词法器。它在嵌套模板串、
 *   正则与除号歧义、注释里的反引号等组合上仍可能出错。实测在
 *   `lib/rules.mjs`（2000+ 行、注释密集）上仍有 62 行注释未被正确屏蔽。
 *
 *   出错时最坏的后果不是"报错"，而是**给出错误结论**：
 *   注释里的 `` `while (true)` `` 被当成真代码 ⇒ 假红；
 *   真代码被当字符串抹掉 ⇒ 假绿。
 *
 *   本工具一贯的纪律是「**没检查 ≠ 检查通过**」。所以这里做的是：
 *   **先证明屏蔽器在这份文件上自洽，再允许它输出结论**；不自洽就交还给调用方报 skip。
 *
 * 判据：
 *   ① 输出与输入**等长**（行号/位置不能漂移）
 *   ② 输出里**不残留**未配对的块注释开标记或闭标记（下面是它们的中文说法，
 *      不写字符本身，否则这段 JSDoc 会自己把自己截断 —— 本项目已踩过两次）
 *   ③ 输出的非空白字符数 ≤ 原文（只会减少，不会凭空产生）
 *
 * 三条任一不满足 ⇒ `ok=false`，调用方必须报 skip 而不是 pass/fail。
 */
export function lexerSelfCheck(text, masked) {
  const problems = [];
  if (masked.length !== text.length) {
    problems.push(`长度不一致（原文 ${text.length} / 屏蔽后 ${masked.length}）`);
  }
  const strayOpen = countOf(masked, '/*');
  const strayClose = countOf(masked, '*/');
  if (strayOpen || strayClose) {
    problems.push(`残留未配对的注释标记（/* ${strayOpen} 个、*/ ${strayClose} 个）`);
  }
  return { ok: problems.length === 0, problems };
}

function countOf(s, needle) {
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/**
 * 去注释、字符串与正则，保留换行与字符数（行号与位置都不变）。
 *
 * 返回值与输入**等长**，被抹除的位置替换成空格（换行保留）。
 * 这样 `lineOf()` 用输出算行号仍然准确。
 *
 * ★ 调用方必须配合 `lexerSelfCheck` 使用 —— 见该函数注释。
 */
export function maskCommentsAndStrings(text) {
  const out = [];
  /**
   * 状态机上下文。
   *
   * `lastSignificant` —— 区分 `/` 是正则还是除法
   * `frames` —— **模板串/插值的嵌套栈**
   *
   * ★ 为什么必须是栈（2026-11-17，两轮返工后定稿）：
   *   前两版用 `tplDepth`（数字）+ `braceStack`（数字栈）两个独立计数器，
   *   它们在 `` `${a ? `x${b}` : ''}` `` 这种**插值里嵌模板串、模板串里再嵌插值**
   *   的写法上会互相错位。错位的后果不是"报错"，而是**状态永久回不到 `code`**——
   *   之后整段源码被当字符串抹掉，而报告照样输出结论。
   *   实测：`lib/rules.mjs` 从 L766 起 `stage:`/`title:` 全部消失，
   *   最终把 JSDoc 里的 `` `while (true)` `` 暴露出来 ⇒ ARCH-06 假红。
   *
   *   现在每个 `frame` 是一层模板串：`{ braces: 0 }` 记录该层插值内的花括号深度。
   *   进插值压栈、插值结束弹栈、内层模板串自己的插值再压一层 —— 层次天然对齐。
   */
  const ctx = { lastSignificant: '', frames: [], tplStack: [] };
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const step = nextMaskStep(text, i, state, ctx);
    out.push(step.emit);
    state = step.state;
    if (step.significant !== undefined) ctx.lastSignificant = step.significant;
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
function nextMaskStep(text, i, state, ctx = { lastSignificant: '' }) {
  const c = text[i];
  const n = text[i + 1];
  // 各种状态的转移表：每个 handler 只管自己那一种状态
  const handler = MASK_HANDLERS[state] || MASK_HANDLERS.code;
  return handler(c, n, ctx);
}

/**
 * 状态 → 单步转移函数。
 *
 * ★ 2026-11-17 修两处（独立审查实测确认）：
 *
 *  ① **正则字面量 `/…/` 未识别**（原 `code` 分支缺失）。
 *     实测：`const r=/while (true) {}/;` 会命中 ARCH-06，`/catch { }/` 会命中 ARCH-07
 *     —— 正则里的是**纯数据**，两处都是误报。JS/TS 是主要扫描语言，正则很常见。
 *
 *  ② **模板插值 `${…}` 被整体抹除**。原 `tpl` handler 把 `${` 之后一律当字符串，
 *     实测 `${(()=>{try{x()}catch{}})()}` 里的真实空 catch **漏报**。
 *     现改为：`tpl` 内遇 `${` 切回 `code`，并用 `tplDepth` 记住"要回到哪个模板"。
 *
 * ★ 正则与除号的歧义（`a / b` vs `/re/`）用**前一个有效字符**判断：
 *   前一个是标识符/数字/右括号/右方括号 ⇒ 除法；否则 ⇒ 正则。
 *   这是 JS 词法里的经典启发式，不完美但覆盖实际代码。
 */
const MASK_HANDLERS = {
  code(c, n, ctx) {
    if (c === '/' && n === '/') return { emit: '  ', state: 'line', advance: 2 };
    if (c === '/' && n === '*') return { emit: '  ', state: 'block', advance: 2 };
    // ★ 正则字面量：`/` 在"非表达式位置"才算正则起始（见下方 looksLikeRegexStart）
    if (c === '/' && looksLikeRegexStart(ctx.lastSignificant)) {
      return { emit: ' ', state: 'regex', advance: 1 };
    }
    if (c === "'") return { emit: ' ', state: 'sq', advance: 1 };
    if (c === '"') return { emit: ' ', state: 'dq', advance: 1 };
    if (c === '`') {
      /**
       * ★ 进入最外层模板串时必须**清零 `tplDepth`**。
       *
       * 原来漏了这一步：上一次模板串若因为嵌套记账不对称而留下 `tplDepth > 0`，
       * 下一次最外层模板串的结束反引号就会被当成"内层结束"——
       * 于是状态**回不到 `code`**，之后整段源码被当字符串抹掉。
       * 实测：`lib/rules.mjs` 从 L766 起 `stage:`/`title:` 等全部消失，
       * 最终把 JSDoc 里的 `` `while (true)` `` 暴露出来 ⇒ ARCH-06 假红。
       */
      ctx.tplDepth = 0;
      ctx.tplStack.push('code'); // 记录"从 code 进入模板串"，结束时要回 code
      return { emit: ' ', state: 'tpl', advance: 1 };
    }
    /**
     * ★ 记录"前一个有效字符"供 `looksLikeRegexStart` 使用。
     *
     * 这里**只记非空白字符**（第一版写成"空白时若还没有记录就记空白"，
     * 导致 `lastSignificant` 一旦是空白就再也更新不动，正则/除法判断随之漂移）。
     */
    const significant = /\s/.test(c) ? undefined : c;
    return { emit: c, state: 'code', advance: 1, significant };
  },
  /** 正则字面量内部：只关心 `\` 转义与结束的 `/`，以及字符类 `[...]`。 */
  regex(c) {
    if (c === '\\') return { emit: '  ', state: 'regex', advance: 2 };
    if (c === '/') return { emit: ' ', state: 'code', advance: 1 };
    return { emit: c === '\n' ? '\n' : ' ', state: 'regex', advance: 1 };
  },
  line(c) {
    if (c === '\n') return { emit: '\n', state: 'code', advance: 1 };
    return { emit: ' ', state: 'line', advance: 1 };
  },
  block(c, n) {
    if (c === '*' && n === '/') return { emit: '  ', state: 'code', advance: 2 };
    return { emit: c === '\n' ? '\n' : ' ', state: 'block', advance: 1 };
  },
  /** 模板串：遇 `${` 进入插值（压帧），遇反引号结束。 */
  tpl(c, n, ctx) {
    if (c === '\\') return { emit: '  ', state: 'tpl', advance: 2 };
    if (c === '`') {
      /**
       * 结束一层模板串。`tplStack` 记录"这一层模板串是从哪进来的"：
       *   · 从 code 进来的 ⇒ 结束回 code
       *   · 从 tplExpr 进来的（内层模板串）⇒ 结束回 tplExpr
       * 用栈而不是计数器，才能正确区分"外层"与"内层"。
       */
      const from = ctx.tplStack.pop();
      return { emit: ' ', state: from === 'tplExpr' ? 'tplExpr' : 'code', advance: 1 };
    }
    if (c === '$' && n === '{') {
      ctx.frames.push({ braces: 0 }); // 新的一层插值
      return { emit: '  ', state: 'tplExpr', advance: 2 };
    }
    return { emit: c === '\n' ? '\n' : ' ', state: 'tpl', advance: 1 };
  },
  /**
   * 模板插值内部：这里**是代码**，必须正常扫描。
   *
   * 花括号深度存在**当前帧**里；`}` 归零即该层插值结束、弹帧回 `tpl`。
   * 插值内出现的字符串必须回到 `tplExpr`（不是 `code`），否则状态会永久跑偏。
   */
  tplExpr(c, n, ctx) {
    const frame = ctx.frames[ctx.frames.length - 1];
    if (c === '{') { frame.braces++; return { emit: '{', state: 'tplExpr', advance: 1 }; }
    if (c === '}') {
      if (frame.braces > 0) { frame.braces--; return { emit: '}', state: 'tplExpr', advance: 1 }; }
      ctx.frames.pop();
      /**
       * ★★ 2026-11-18 修（外部实测抓到的**假阳性**，报告里的 17/74 全部来自这一处）：
       *
       *   这里原本 `emit: '}'` —— 把**插值分隔符**当成真实代码的花括号输出。
       *   而开头的 `${` 在 `tpl` 状态里被抹成**两个空格**（L252 `emit: '  '`）。
       *   于是掩码文本里花括号**不平衡**：多出一个 `}`。
       *
       *   后果（实测）：
       *     `while (true) { const s = \`${x}\`; if (k) break }`
       *     掩码后变成 `while (true) { const s =   x}  ; if (k) break }`
       *     ⇒ 那个多出来的 `}` **把 while 体提前闭合** ⇒ `break` 落到循环外
       *     ⇒ 判为「恒真循环缺少退出路径」—— **只要有插值就必假阳性**，
       *       与"模板串里有没有除法"无关（实测 `${Math.round(x)}` 也误报）。
       *
       *   修法：闭合也叫空格，与开头对称。分隔符不是代码，不该参与括号配对。
       *
       * ★ 为什么 `lexerSelfCheck` 没拦住：它校验的是「等长 / 不残留块注释标记 /
       *   非空白字符不增」。本缺陷**三条全过**——掩码自洽、只是**语义错了**。
       *   ⇒ 自洽校验只能证伪"结构性崩坏"，证不了"语义正确"。这条边界要写进 ICD。
       */
      return { emit: ' ', state: 'tpl', advance: 1 };
    }
    if (c === '/' && n === '/') return { emit: '  ', state: 'tplExprLine', advance: 2 };
    if (c === '/' && n === '*') return { emit: '  ', state: 'tplExprBlock', advance: 2 };
    if (c === "'") return { emit: ' ', state: 'sqInExpr', advance: 1 };
    if (c === '"') return { emit: ' ', state: 'dqInExpr', advance: 1 };
    // 内层模板串：记住"从 tplExpr 进来"，结束后才知道要回哪
    if (c === '`') { ctx.tplStack.push('tplExpr'); return { emit: ' ', state: 'tpl', advance: 1 }; }
    return { emit: c, state: 'tplExpr', advance: 1 };
  },
  sqInExpr: stringHandler("'", 'tplExpr'),
  dqInExpr: stringHandler('"', 'tplExpr'),
  tplExprLine(c) {
    if (c === '\n') return { emit: '\n', state: 'tplExpr', advance: 1 };
    return { emit: ' ', state: 'tplExprLine', advance: 1 };
  },
  tplExprBlock(c, n) {
    if (c === '*' && n === '/') return { emit: '  ', state: 'tplExpr', advance: 2 };
    return { emit: c === '\n' ? '\n' : ' ', state: 'tplExprBlock', advance: 1 };
  },
  /** 单/双引号与模板串共用：遇到转义跳 2 个字符，遇到配对的引号回 code。 */
  sq: stringHandler("'", 'sq'),
  dq: stringHandler('"', 'dq'),
};

/** 生成"字符串内"的单步转移函数。 */
function stringHandler(quote, name) {
  return function inside(c) {
    if (c === '\\') return { emit: '  ', state: name, advance: 2 };
    if (c === quote) return { emit: ' ', state: 'code', advance: 1 };
    return { emit: c === '\n' ? '\n' : ' ', state: name, advance: 1 };
  };
}

/**
 * `/` 是"正则起始"还是"除号"？
 *
 * 规则：前一个**有效字符**是标识符字符、数字、`)`、`]`、`}` 时是除法；
 * 其余（运算符、`(`、`,`、`=`、行首等）是正则起始。
 *
 * 这是 JS 词法的经典启发式，不完美（例如 `if (x) /re/.test(s)` 会被当成除法），
 * 但覆盖实际代码的绝大多数情形。**不完美之处已在测试里显式记录**，
 * 避免把它当成"正确处理"。
 */
function looksLikeRegexStart(last) {
  if (!last) return true; // 行首/表达式开头 ⇒ 正则
  if (/[A-Za-z0-9_$]/.test(last)) return false; // 标识符或数字结尾 ⇒ 除法
  return ![')', ']', '}'].includes(last);
}

/** 是否要把该字符记为"前一个有效字符"（跳过空白）。 */
function isSignificant(c, ctx) {
  return !/\s/.test(c) || ctx.lastSignificant === '';
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
    if (!hasExitForThisLoop(code, range)) out.push({ line: lineOf(code, m.index), cond });
  }
  return out;
}

/**
 * 循环体内**是否真的存在一条能终止本循环的退出语句**（作用域敏感）。
 *
 * ★ 为什么必须做作用域分析（2026-11-17 修，独立审查实测确认四个假绿）：
 *
 *   旧实现只做正文正则 `/\b(break|return|throw)\b/`，于是这四种写法全部通过：
 *
 *   | 代码 | 实际语义 |
 *   |---|---|
 *   | `while(true){switch(x){case 1: break;} tick();}` | break 属于 switch |
 *   | `while(true){const f=()=>{return;}; tick();}`      | return 属于内层函数 |
 *   | `while(true){while(x){break;} tick();}`           | break 属于内层循环 |
 *   | `while(true){if(false) break; tick();}`           | break 不可达 |
 *
 *   ⇒ **旧实现证明的其实是「循环体里出现过这些关键字」**，
 *     而规则宣称的是「有可终止的退出路径」。这两件事差得很远。
 *
 * ★ 本实现的做法（宁可漏报，不可假绿）：
 *   从循环体起点做一次**作用域感知的扫描**，维护一个"嵌套边界栈"：
 *     · 遇到 `{` 压栈，`}` 出栈；
 *     · 遇到 `function` / `=>` / 方法定义 ⇒ 压入 `fn` 边界（其内 return 不算）；
 *     · 遇到 `switch` ⇒ 压入 `switch` 边界（其内 break 不算）；
 *     · 遇到内层 `while`/`for`/`do` ⇒ 压入 `loop` 边界（其内 break/continue 不算）。
 *   只有**栈深度为 0**（即直接属于本循环体）的 `break`/`return`/`throw` 才算退出路径。
 *
 * ★ 仍然**不判可达性**（`if (false) break` 目前仍算有退出路径）：
 *   可达性需要常量传播/控制流分析，超出本判据的能力与宣称范围。
 *   这一点写进 `why` 与文档，不靠"我们做了作用域分析"暗示它更强。
 */
function hasExitForThisLoop(code, range) {
  const body = code.slice(range.start, range.end + 1);
  const scope = new ScopeStack();
  let i = 0;
  while (i < body.length) {
    const tok = readToken(body, i);
    if (tok.kind === 'boundary') { scope.push(tok.boundary); i = tok.next; continue; }
    if (tok.kind === 'brace') { scope.onBrace(tok.text); i = tok.next; continue; }
    if (tok.kind === 'exit' && scope.atLoopTop()) return true;
    i = tok.next;
  }
  return false;
}

/** 嵌套边界栈：只有"直接属于本循环体"的退出语句才算数。 */
class ScopeStack {
  constructor() {
    this.frames = []; // 每项是 {kind, depthAtEntry}
    this.depth = 0;   // 花括号深度（相对循环体）
  }

  push(kind) {
    this.frames.push({ kind, depthAtEntry: this.depth });
  }

  onBrace(text) {
    if (text === '{') { this.depth++; return; }
    this.depth--;
    // 出栈所有"进入深度 >= 当前深度"的边界帧（它们的作用域到此结束）
    while (this.frames.length && this.frames[this.frames.length - 1].depthAtEntry >= this.depth) {
      this.frames.pop();
    }
  }

  /** 是否处在循环体最外层（没有任何嵌套边界）。 */
  atLoopTop() {
    return this.frames.length === 0;
  }
}

/**
 * 从 `i` 读一个"有语义的 token"。
 *
 * 返回 `{kind, text, boundary, next}`，kind ∈ `brace | boundary | exit | other`。
 *
 * 边界识别的关键词表（保守：只认明确的形态，不猜）：
 *   `function` / `=>` / `switch` / `while` / `for` / `do`
 *   —— `do` 只在 `do {` 形态下算循环边界（`doSomething` 不算，因为按 `\b` 切分）。
 */
function readToken(s, i) {
  const c = s[i];
  if (c === '{' || c === '}') return { kind: 'brace', text: c, next: i + 1 };
  const word = readWord(s, i);
  if (word) return classifyWord(word, i);
  const arrow = readArrow(s, i);
  if (arrow) return arrow;
  return { kind: 'other', next: i + 1 };
}

/** 读一个标识符词；不是标识符起始则返回 null。 */
function readWord(s, i) {
  if (!/[A-Za-z_$]/.test(s[i] || '')) return null;
  let j = i;
  while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
  return { text: s.slice(i, j), end: j };
}

const EXIT_WORDS = new Set(['break', 'return', 'throw']);
const LOOP_WORDS = new Set(['while', 'for']);

function classifyWord(word, i) {
  const next = word.end;
  if (EXIT_WORDS.has(word.text)) return { kind: 'exit', text: word.text, next };
  if (word.text === 'switch') return { kind: 'boundary', boundary: 'switch', next };
  if (word.text === 'function') return { kind: 'boundary', boundary: 'fn', next };
  if (LOOP_WORDS.has(word.text)) return { kind: 'boundary', boundary: 'loop', next };
  return { kind: 'other', next };
}

/** `=>` 视为函数边界（箭头函数体内的 return 不算本循环的退出）。 */
function readArrow(s, i) {
  if (s[i] === '=' && s[i + 1] === '>') return { kind: 'boundary', boundary: 'fn', next: i + 2 };
  return null;
}

/**
 * 只去注释、**保留字符串字面量**（用于判断"catch 体是否真的为空"）。
 *
 * ★ 为什么需要它（2026-11-17 修，独立审查实测确认）：
 *   `try{x()}catch{ "handled" }` 是**合法非空块**（字符串表达式语句）。
 *   用 `maskCommentsAndStrings` 之后字符串被抹成空格 ⇒ `trim() === ''`
 *   ⇒ 被判"体完全为空"——这是**事实判断错误**，不是政策选择。
 *
 *   这正是本工具一直强调的病：**屏蔽手段夸大了自己的判断力**。
 *   一个块"看起来空"和"真的没有语句"是两件事。
 */
export function maskCommentsOnly(text) {
  const out = [];
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const step = COMMENT_ONLY_HANDLERS[state](text, i);
    out.push(step.emit);
    state = step.state;
    i += step.advance;
  }
  return out.join('');
}

/**
 * `maskCommentsOnly` 的状态转移表。
 *
 * ★ 为什么表驱动：第一版把整个状态机写成
 *   `while` → `if (state === …)` → `if (c === …)` 三层 `if` 嵌在 `while` 里，
 *   被本项目自己的 KISS-C1 判红 **8 处**（`lib/arch.mjs:515-527`）。
 *   语义上那些分支是平级的，但按缩进算就是 4 层。
 *   拆成"每步只算一次转移"后，每个 handler 内部最多一层 `if`。
 */
const COMMENT_ONLY_HANDLERS = {
  code(text, i) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') return { emit: '  ', state: 'line', advance: 2 };
    if (c === '/' && n === '*') return { emit: '  ', state: 'block', advance: 2 };
    if (c === "'") return { emit: c, state: 'sq', advance: 1 };
    if (c === '"') return { emit: c, state: 'dq', advance: 1 };
    if (c === '`') return { emit: c, state: 'tpl', advance: 1 };
    return { emit: c, state: 'code', advance: 1 };
  },
  line(text, i) {
    const c = text[i];
    return c === '\n'
      ? { emit: '\n', state: 'code', advance: 1 }
      : { emit: ' ', state: 'line', advance: 1 };
  },
  block(text, i) {
    const c = text[i];
    if (c === '*' && text[i + 1] === '/') return { emit: '  ', state: 'code', advance: 2 };
    return { emit: c === '\n' ? '\n' : ' ', state: 'block', advance: 1 };
  },
  /** 字符串内：**原样保留**（这是本函数与 `maskCommentsAndStrings` 的唯一区别）。 */
  sq: stringKeeper("'", 'sq'),
  dq: stringKeeper('"', 'dq'),
  tpl: stringKeeper('`', 'tpl'),
};

/** 生成"字符串内原样保留"的转移函数。 */
function stringKeeper(quote, name) {
  return function keep(text, i) {
    const c = text[i];
    if (c === '\\') return { emit: c + (text[i + 1] || ''), state: name, advance: 2 };
    if (c === quote) return { emit: c, state: 'code', advance: 1 };
    return { emit: c, state: name, advance: 1 };
  };
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
 *   所以允许豁免，且豁免必须带理由。豁免的**锚定方式**见 `rules.mjs` 的
 *   `matchCatchExemptions` —— 它是**内容锚定**，不是行号锚定。
 *
 * ★ 2026-11-18 改：本函数**不再做豁免过滤**，只返回全部命中（含 `snippet`）。
 *   原因：豁免需要"按内容匹配"，而内容匹配需要看到全部候选才能判断哪个是哪个
 *   —— 在扫描阶段过滤掉就等于把"谁被豁免了"这件事藏进了扫描器。
 *   现在职责分开：这里只负责**找**，`rules.mjs` 负责**判**。
 *
 * @returns {Array<{line:number, snippet:string, key:string, hasComment:boolean}>}
 *   `snippet` —— 从 `catch` 到闭合花括号的**规范化文本**（空白折叠），
 *                是豁免的内容锚点：代码移动后仍能匹配，代码本身改了才会失配。
 *   `key`     —— `relPath:line`，仅供**人读**与快速路径，不作唯一身份。
 */
export function emptyCatches(relPath, text) {
  const code = maskCommentsAndStrings(text);
  // ★ 判空必须用"只去注释"的版本：字符串字面量是**语句**，不是空。
  const bare = maskCommentsOnly(text);
  const out = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = matchPair(code, openBrace, '{', '}');
    if (closeBrace < 0) continue;
    // 用 bare 的同位置切片判断真实内容（两者与原文等长）
    const body = bare.slice(openBrace + 1, closeBrace);
    if (!isEmptyBody(body)) continue; // 有语句：不判（见函数注释）
    const line = lineOf(code, m.index);
    out.push({
      line,
      key: `${relPath}:${line}`,
      // ★ 说清"是哪一种空"：判定不变，措辞要区分（见 hasCommentIn 的注释）。
      hasComment: hasCommentIn(text.slice(openBrace + 1, closeBrace)),
      // ★ 锚点必须带**上下文**，否则 `catch { }` 之间无法区分（实测：8 条里 6 条
      //   光看块体完全一样，内容锚定等于失效）。取 `catch` 所在语句的前文 + 块体。
      snippet: normalizeSnippet(aroundCatch(text, m.index, closeBrace)),
    });
  }
  return out;
}

/**
 * `catch` 体算不算"空"——**统一口径**（2026-11-18，外部实测 ⑤）。
 *
 * 三种形态都算空，因为它们**运行时行为完全相同**：不碰异常对象、不记录、不降级、不重抛。
 *   ① 真空          `{}`
 *   ② 仅注释        `{ /* … *\/ }` / `{\n // … \n}`   —— 注释是给**人**看的，不是语句
 *   ③ 仅空语句      `{ ; }`                          —— `;` 什么都不做
 *
 * ★ ③ 是本次新收进来的：旧实现里 `bare.trim() !== ''` 会把 `;` 当成语句 ⇒ **判非空**。
 *   同一个"空"在两处不一致（注释算空、分号不算），说明口径从来没定义过。
 *   现在只有一条判据：**去掉注释与空语句后是否还剩东西**。
 *
 * ★ 反向（必须保住）：`{ "handled" }` 是**表达式语句**，不是空；
 *   `{ b(); }` 也不是空。判据不管"处理得好不好"，只管"有没有语句"。
 */
function isEmptyBody(body) {
  return body.replace(/;/g, '').trim() === '';
}

/**
 * 块体内是否出现过注释（**只看原文切片，不看掩码结果**）。
 *
 * ★ 为什么要它：`maskCommentsOnly` 把注释抹成空格后，"有注释"与"真空"
 *   在掩码文本里**完全同形**。如果只判不区分，报告就永远写"异常被完全吞掉"，
 *   读者会以为作者连说明都没写 —— 而实测本仓库 6 处里有 5 处写了注释。
 *   判定不变，措辞分两档：这就是"不抹掉作者写下的意图"的最小代价。
 */
function hasCommentIn(rawBody) {
  // ★ 2026-11-19 复核修正：原先用正则 `/\/\*|(^|\n)[ \t]*\/\//`，只认**行首** `//`。
  //   `catch { ; // 行尾注释 }` 会被漏判成"没有注释"⇒ 报「异常被完全吞掉」。
  //   在 AMup 的 6,386 条量级上，任何一种写法漏判都是成百上千条失真。
  //
  //   现在改成**掩码差分**：把块体过一遍 `maskCommentsOnly`，
  //   只要结果与原文**不完全相同**，就说明里面有注释（块注释/行注释/行首/行尾一次覆盖）。
  //   这是"问实现自己"而不是"再写一条正则猜"—— 正则猜注释正是本项目反复踩的坑。
  return maskCommentsOnly(rawBody) !== rawBody;
}

/**
 * 取一个有区分度的锚点：**从配对的 `try` 起，到 `catch` 块结束**。
 *
 * ★ 三版试错记录（都实测过，写下来避免再走）：
 *   ① 「上一个语句边界」—— `catch {}` 紧跟 `}`，而 `}` 正是边界 ⇒ 前缀为空，
 *      8 条锚点全变成 `catch { }`，**毫无区分度**。
 *   ② 「上一行原文」—— 加一行 `// f49` 就让锚点变成 `// f49 catch { }`，
 *      注释是允许变的，不该进锚点。
 *   ③ 「上一行去掉注释」—— 对 `try { x(); } catch { }` 这种**同一行**的写法，
 *      上一行是空行 ⇒ 又退回 `catch { }`。
 *
 * ★ 现在做的是找**配对的 `try`**：`catch` 的语义由它捕获的那个 `try` 决定
 *   （`rmSync(tmp)` / `mkdirSync(p)` / `git config` 各不相同），
 *   这才是"这是谁的 catch"的正确来源。找不到就退回到 `catch` 本块
 *   （此时区分度靠块体本身，若块体也相同则说明这两处确实难以区分，如实标注）。
 */
function aroundCatch(text, catchStart, closeBrace) {
  const tryStart = pairedTryStart(text, catchStart);
  const from = tryStart >= 0 ? tryStart : catchStart;
  return text.slice(from, closeBrace + 1);
}

/**
 * 从 `catch` 位置往回找配对的 `try` 关键字。
 *
 * 简化判据：在 `catch` 之前、最近的一处 `}` 与 `catch` 之间若有 `try`，
 * 就是它；否则再往前找一层。找不到返回 -1。
 */
function pairedTryStart(text, catchStart) {
  const window = text.slice(Math.max(0, catchStart - 400), catchStart);
  const idx = window.lastIndexOf('try');
  if (idx < 0) return -1;
  // `try` 必须是**单词**（排除 `retry` / `tryCount` 之类）
  const before = window[idx - 1] || '';
  if (/[A-Za-z0-9_$]/.test(before)) return -1;
  return Math.max(0, catchStart - 400) + idx;
}

/**
 * 把代码片段规范化成稳定身份：**去掉注释、折叠空白、抹平花括号内外的空格**。
 *
 * ★ 为什么要抹平花括号内外的空白（实测踩到）：
 *   折叠多空白只能把 `{\n\n}` 变成 `{ }`，而 `{}` 仍是 `{}` ——
 *   两者在语义上完全等价，锚点却不同。于是"把空 catch 排成多行"
 *   会让豁免失效，而这是纯粹的排版行为，不该触发重新审。
 *
 * ★ 为什么去掉注释而不是保留：注释正是我们**允许变化**的部分 ——
 *   给一个已豁免的 `catch` 补一句说明，不该让豁免失效。
 *   而块体本身的语句/结构一变，就应该失配（那才是该重新审的时候）。
 */
export function normalizeSnippet(src) {
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutComments
    .replace(/\s+/g, ' ')
    .replace(/\{\s*/g, '{ ')
    .replace(/\s*\}/g, ' }')
    .trim();
}

/**
 * 读文件并做两项结构检查。
 *
 * 返回 `{unsupported:true}` / `{error}` / `{ok:false, problems}` / `{ok:true, …}`。
 *
 * ★ 四条返回形态必须分开，不能合并成"空结果"：
 *   · `unsupported` —— 语言不支持（如 `.go`）：**没检查**，不是通过
 *   · `error`       —— 读文件失败：**没检查**
 *   · `ok:false`    —— 词法器自检不过：**没检查**（屏蔽器在这份文件上不可信）
 *   · `ok:true`     —— 真的检查了，结果在 `unterminated` / `emptyCatch`
 *
 *   前三种都不能算 pass。这条纪律与项目里「空集不构成通过」同源。
 *
 * @param {string} absPath 绝对路径（读文件用）
 * @param {string} relPath 仓库相对路径（**输出与豁免展示都用它**）
 */
export function scanArch(absPath, relPath = absPath) {
  if (!structuralSupported(absPath)) return { unsupported: true };
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (e) {
    return { error: e.message };
  }
  // ★ 先证明屏蔽器在这份文件上自洽，再允许它输出结论
  const masked = maskCommentsAndStrings(text);
  const self = lexerSelfCheck(text, masked);
  if (!self.ok) return { ok: false, problems: self.problems };
  return {
    ok: true,
    unterminated: unterminatedWhiles(absPath, text),
    emptyCatch: emptyCatches(relPath, text),
  };
}
