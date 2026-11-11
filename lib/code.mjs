// 代码扫描：只做三件可机械判定的事——嵌套深度、跨文件重复块、投机性标记。
// 这里刻意不判断"这个抽象好不好"，那是人的事。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java']);

export function walkCode(root, opts = {}) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'venv', '.venv', '__pycache__', 'target']);
  const files = [];
  const visit = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (skip.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) visit(p);
      else if (ent.isFile() && CODE_EXT.has(extname(ent.name))) files.push(p);
    }
  };
  visit(root);
  return files.sort();
}

/** Python 用缩进、其余用花括号深度；返回 [{file, line, depth}]。 */
export function nestingDepth(file, text) {
  const lines = text.split(/\r?\n/);
  const isPy = file.endsWith('.py');
  const hits = [];
  if (isPy) {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      const depth = Math.floor(indent / 4);
      if (depth > 0) hits.push({ file, line: i + 1, depth });
    }
  } else {
    let depth = 0;
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      line = line.replace(/\/\*.*?\*\//g, '');
      const start = line.indexOf('/*');
      if (start !== -1 && line.indexOf('*/', start) === -1) {
        inBlockComment = true;
        line = line.slice(0, start);
      }
      line = line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
      const flags = blockBraceFlags(line);
      const opens = flags.filter(Boolean).length;
      const closes = (line.match(/\}/g) || []).length;
      if (depth > 0) hits.push({ file, line: i + 1, depth: depth + opens });
      depth = Math.max(0, depth + opens - closes);
    }
  }
  return hits;
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
    const text = readFileSync(f, 'utf8');
    const seq = [];
    text.split(/\r?\n/).forEach((raw, i) => {
      const n = normalize(raw);
      if (n !== null) seq.push({ text: n, line: i + 1 });
    });
    for (let i = 0; i + size <= seq.length; i++) {
      const win = seq.slice(i, i + size);
      const key = win.map((w) => w.text).join('\n');
      if (key.length < minChars) continue;
      const item = { key, file: f, line: win[0].line, sample: win.slice(0, 3).map((w) => w.text).join(' / ') };
      const prev = index.get(key);
      if (!prev) {
        index.set(key, item);
        continue;
      }
      if (prev.file === f) continue;
      found.push({ size, a: { file: prev.file, line: prev.line }, b: { file: item.file, line: item.line }, sample: item.sample });
    }
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

// ─────────────────────────────────────────────────────────────
// 前后端解耦：抽 import 说明符 + 按边界前缀归类
// ─────────────────────────────────────────────────────────────

/**
 * 抽取一个文件里的 import/require/use 说明符。
 * 只做**可判定**的部分：静态 import / require / from-import / Go import / Java import。
 * 不做动态拼接路径（`await import(someVar)`）——那类无法判定，宁可漏报也不误报。
 */
export function importSpecifiers(file, text) {
  const out = [];
  const ext = extname(file);
  const push = (spec) => {
    if (!spec) return;
    const s = spec.trim();
    if (s) out.push(s);
  };

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) push(m[1]);
    for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
    for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
    for (const m of text.matchAll(/(?:^|\n)\s*export\s+[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) push(m[1]);
  } else if (ext === '.py') {
    for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) push(m[1].replace(/\./g, '/'));
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) push(m[1].replace(/\./g, '/'));
  } else if (ext === '.go') {
    for (const m of text.matchAll(/^\s*import\s+(?:\(\s*)?["`]([^"`]+)["`]/gm)) push(m[1]);
    for (const m of text.matchAll(/^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]\s*$/gm)) push(m[1]);
  } else if (ext === '.java') {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)) push(m[1].replace(/\./g, '/'));
  }
  return [...new Set(out)];
}

/**
 * 把一个路径映射到边界名。
 * 规则：boundaries 是 { 名称: [路径前缀...] }，按**最长前缀**匹配，避免 `src/` 抢走 `src/shared/`。
 * 匹配用仓库相对路径，前缀一律归一为 `/`。
 */
export function boundaryOfPath(relPath, boundaries) {
  const p = String(relPath).replace(/\\/g, '/');
  let best = null;
  let bestLen = -1;
  for (const [name, prefixes] of Object.entries(boundaries || {})) {
    for (const raw of Array.isArray(prefixes) ? prefixes : [prefixes]) {
      const pre = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!pre) continue;
      if ((p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/')) && pre.length > bestLen) {
        best = name;
        bestLen = pre.length;
      }
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

// 哪些 `{` 算「一层嵌套」：只算**控制流/函数体**，不算对象/数组字面量。
// 自举时发现：旧实现数所有花括号，把 `{ a: { b: { c: { d: 1 } } } }` 这种配置对象
// 也判成 4 层嵌套 —— 那不是"逻辑复杂"，是"数据结构长这样"。
// 判据：`{` 紧跟在 `)` / `=>` / else / do / try / finally 之后，或独占行首 ⇒ 块。
const BLOCK_PREFIX = /(?:\)|=>|\belse|\bdo|\btry|\bfinally)\s*$/;
const OBJ_PREFIX = /(?:=|\(|\[|,|:|\breturn)\s*$/;

/** 一行里哪些 `{` 是块：返回布尔数组（长度 = 该行 `{` 的个数）。 */
function blockBraceFlags(line) {
  const flags = [];
  let idx = -1;
  while ((idx = line.indexOf('{', idx + 1)) !== -1) {
    const before = line.slice(0, idx).trimEnd();
    const atLineStart = before === '';
    const isBlock = atLineStart || BLOCK_PREFIX.test(before);
    const isObj = OBJ_PREFIX.test(before);
    flags.push(isBlock && !isObj);
  }
  return flags;
}

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
