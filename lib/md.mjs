// Markdown 结构解析：只做检查器需要的三件事——分节树、取某一级标题块、取表格行/列表项。
// 刻意不做通用 Markdown 解析：不引入依赖，也不猜语义。
//
// 关键设计：分节返回**树**而不是扁平列表。标题层级是包含关系，
// 若把 `#### Scenario:` 切成 `### Requirement:` 的兄弟节点，Requirement 的 body 里
// 就永远看不到自己的 Scenario —— 这正是"扫描了但扫不到"的假阴性来源。
//
// ★ A05：**围栏代码块里的 `#` 不是标题**。
//   实测形态：正文没有「非目标」章节，只有一段 ```markdown 围栏里展示的示例，
//   围栏里的 `## 非目标` 被当成正式小节 ⇒ YAGNI-P1 PASS。
//   "示例代码"与"真实制品"不是一回事，靠格式就能判定，不该交给语义猜。
//   同理，围栏里的表格/列表也不参与 tableRows/bulletItems —— 那是示例数据。

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 标出哪些行属于围栏代码块（含围栏行本身）。
 * 支持 ``` 与 ~~~，支持更长的围栏定界（```` 包裹 ```），并允许围栏带语言标记。
 */
export function fencedMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null; // 当前围栏的定界符（同长或更长才算闭合）
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (open === null) {
      if (!m) continue;
      open = m[1];
      mask[i] = true;
      continue;
    }
    // 已在围栏内：本行是围栏结束行吗？
    mask[i] = true;
    if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null;
  }
  return mask;
}

/** 去掉围栏代码块后的行（行号保留：用空串占位，避免下标漂移）。 */
export function stripFences(lines) {
  const mask = fencedMask(lines);
  return lines.map((l, i) => (mask[i] ? '' : l));
}

/**
 * 分节树。每个节点：{level, title, line, body, children, raw}
 * - body   = 该节点标题之后、第一个子标题之前的所有行（不含子标题内容）
 * - raw    = 该节点整体（含全部子节点）的原文行
 */
export function parseOutline(text) {
  const lines = String(text).split(/\r?\n/);
  const mask = fencedMask(lines);
  const roots = [];
  const stack = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    // 围栏内的内容一律当作正文（不是标题，也不进入新的节点）
    const m = mask[i] ? null : HEADING.exec(lines[i]);
    if (m) {
      const level = m[1].length;
      const node = { level, title: m[2].trim(), line: i + 1, bodyLines: [], start: i, end: lines.length };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].children.push(node);
      node.children = node.children || [];
      stack.push(node);
      cur = node;
      continue;
    }
    if (cur) cur.bodyLines.push(lines[i]);
    else {
      // 首个标题之前的前言
      if (!roots.__preamble) roots.__preamble = [];
      roots.__preamble.push(lines[i]);
    }
  }

  // 计算 end 并生成 body / raw
  const finish = (node, parentEnd) => {
    let last = node.start;
    for (const ch of node.children) last = Math.max(last, finish(ch, parentEnd));
    node.end = node.children.length ? node.children[node.children.length - 1].end : node.start;
    // 真正常规情况：body 到下一兄弟前，用父级传下来的边界补齐
    node.body = node.bodyLines.join('\n');
    node.raw = lines.slice(node.start, node.end + 1).join('\n');
    return node.end;
  };
  for (const r of roots) finish(r, lines.length - 1);

  // 修正 end：兄弟边界
  const fixBoundaries = (nodes, limit) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const nextStart = i + 1 < nodes.length ? nodes[i + 1].start : limit;
      n.end = nextStart - 1;
      if (n.children.length) fixBoundaries(n.children, n.end + 1);
      n.raw = lines.slice(n.start, n.end + 1).join('\n');
    }
  };
  fixBoundaries(roots, lines.length);

  return { roots, preamble: (roots.__preamble || []).join('\n'), lines, fenced: mask };
}

/** 扁平化：所有节点，深度优先，附 parent。 */
export function flatten(outline) {
  const acc = [];
  const walk = (nodes, parent) => {
    for (const n of nodes) {
      acc.push({ ...n, parent });
      if (n.children && n.children.length) walk(n.children, n);
    }
  };
  walk(outline.roots, null);
  return acc;
}

/** 取所有恰好为 level 级的节点（深度优先顺序）。 */
export function nodesAtLevel(outline, level) {
  return flatten(outline).filter((n) => n.level === level);
}

/** 找标题匹配 re 的首个节点（任意层级）。 */
export function findSection(outline, re) {
  return flatten(outline).find((n) => re.test(n.title)) || null;
}

/** 取标题匹配 re 的**顶层节**（层级最小的那个），用于"找小节"这类场景。 */
export function findTopSection(outline, re) {
  const hits = flatten(outline).filter((n) => re.test(n.title));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.level < a.level ? b : a));
}

/** 表格数据行（不含表头与分隔行）。每行为 cells 数组。围栏示例里的表格不计。 */
export function tableRows(body) {
  const lines = String(body)
    .split(/\r?\n/);
  const mask = fencedMask(lines);
  const kept = lines
    .map((l, i) => (mask[i] ? '' : l))
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (kept.length === 0) return [];
  const data = kept.filter((l) => !/^\|[\s:|-]+\|?$/.test(l));
  return data
    .slice(1)
    .map((l) =>
      l
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    );
}

/** 列表项文本（去掉前导 - * +）。围栏示例里的列表不计（A05）。 */
export function bulletItems(body) {
  const lines = String(body).split(/\r?\n/);
  const mask = fencedMask(lines);
  return lines
    .map((l, i) => (mask[i] ? '' : l))
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+\S/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, '').trim());
}

/** 去掉包裹的反引号，得到可用于路径解析的原始值。 */
export function unquote(s) {
  return String(s).trim().replace(/^`+/, '').replace(/`+$/, '').trim();
}
