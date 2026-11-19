/**
 * DRY-C1 重叠区间合并（2026-11-16）。
 *
 * ★ 这条修复的单一根因解释四个独立仓的荒唐数字：
 *   Java `--code .` 55144 / 本仓 `--code .` 10593 / Python 1039882 / 本仓干净根 45
 *   —— 旧实现给**每一个滑动窗口**都记一条命中，去重键是精确坐标，
 *   于是同一段 N 行重复产出 O(N) 条，而不是 1 条。
 *
 * ★ 本文件的测试必须成对：只测"合并了"会让实现朝"吞掉真问题"漂移。
 *   合并是危险的修法 —— 它把多条变一条，最容易顺手把**两处独立复制**也合并掉。
 *   所以负控比正控更重要。
 *
 * ★ 夹具纪律（第一版测试写错过）：两侧的"填充行"必须**内容不同**。
 *   若两侧填充完全相同，那么从第 1 行到第 N 行就**确实**是连续重复 ——
 *   工具报"一大段"是对的，测试却期望"两段各一条"。那是夹具错，不是实现错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { duplicateBlocks } from '../lib/code.mjs';

// ─────────────────────────────────────────────────────────────
// 内存模型（2026-11-19 第一刀）
//
// ★ 缺陷形状（本机实测，`G:/AMup` `--only DRY-C1`）：
//   默认堆 4288 MB → 28.6 s exit 134、输出 0 字节；8 GB → 仍崩；12 GB → 仍崩。
//   不是"堆小了"，是**每条命中都被物化进一个数组**：
//   该语料 1,566 万个滑动窗口、跨文件命中 **1,292 万条**，
//   `found.push(...)` 把它们全留下再排序分组 —— 1292 万个对象的峰值就是 9 GB 量级。
//
// ★ 修法（判定语义一行没动）：分组键 (文件对, a.file, 行差) 已蕴含 b 侧文件，
//   而文件顺序扫、窗口行递增 ⇒ 同组命中天然按 a.line 递增到达，
//   于是"先收齐再排序分组"是多余的 —— 边扫边合并、每文件结束收尾即可。
//   另：索引只留 {line,file}（key 就是 Map 的键），sample 只在命中时拼。
// ─────────────────────────────────────────────────────────────

test('元判据：duplicateBlocks 不得物化全部命中（必须流式合并）', () => {
  const src = readFileSync(new URL('../lib/code.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function duplicateBlocks'), src.indexOf('function createRunMerger'));
  assert.ok(fn, '找不到 duplicateBlocks（源码形态已变，需同步本条判据）');
  assert.match(fn, /createRunMerger\(/, '必须用流式合并器');
  assert.match(fn, /flushFile\(\)/, '每个文件扫完必须收尾，否则内存回到 O(全部命中)');
  assert.doesNotMatch(fn, /const found = \[\]/, '不得再建 found 数组 —— 1292 万条命中的物化就是本次 OOM 的根因');
  assert.doesNotMatch(fn, /found\.push/, '不得把每条命中都推进数组');
});

test('★ 大规模重复：40 份相同文件 × 20 个，段数有限且 span 正确', () => {
  const body = Array.from({ length: 30 }, (_, i) => 'const v' + i + ' = compute(' + i + ');').join('\n') + '\n';
  const files = {};
  for (let c = 0; c < 40; c++) {
    for (let f = 0; f < 20; f++) { files['c' + c + '/f' + f + '.js'] = body; }
  }
  const ws = makeRepo(files);
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.ok(dups.length > 0, '全同文件之间必须报出重复');
    for (const d of dups) assert.equal(d.span, 30, '每段应是整段 30 行（窗口 6），实际 ' + d.span);
    assert.ok(dups.length <= 800 * 799 / 2, '段数不得超过文件对数（否则是没合并的滑窗重复）');
  } finally {
    ws.cleanup();
  }
});

test('★ 流式消费：onRun 必须逐条交付，且不与数组模式不一致', () => {
  const body = Array.from({ length: 40 }, (_, i) => 'const s' + i + ' = pick(' + i + ');').join('\n') + '\n';
  const files = {};
  for (let c = 0; c < 6; c++) files['g' + c + '.js'] = body;
  const ws = makeRepo(files);
  try {
    const arr = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    const seen = [];
    const n = duplicateBlocks(ws.paths, 6, { minChars: 40, onRun: (d) => seen.push(d) });
    assert.equal(n, seen.length, 'finish() 返回的条数必须等于实际交付条数');
    assert.equal(n, arr.length, '流式与数组模式条数必须一致');
    const canon = (x) => JSON.stringify(x.map((d) => ({ a: d.a, b: d.b, span: d.span, windows: d.windows, size: d.size })));
    assert.equal(canon(seen.sort((x, y) => x.a.file.localeCompare(y.a.file) || x.a.line - y.a.line)),
      canon(arr.sort((x, y) => x.a.file.localeCompare(y.a.file) || x.a.line - y.a.line)),
      '流式交付的内容必须与数组模式逐条一致');
  } finally {
    ws.cleanup();
  }
});

test('元判据：DRY-C1 必须以 onRun 流式消费（不得先取全量数组再 map）', () => {
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf("id: 'DRY-C1'"), src.indexOf("id: 'YAGNI-C1'"));
  assert.ok(seg, '找不到 DRY-C1 源码段');
  assert.match(seg, /onRun\(/, 'DRY-C1 必须用 onRun 流式消费（164 万段全量物化 = 1 GB）');
  assert.doesNotMatch(seg, /const dups = duplicateBlocks/, '不得先取全量数组');
});

/** 造一个临时仓，写入若干文件，返回文件绝对路径列表。 */
function makeRepo(files) {
  const dir = mkdtempSync(join(writableTempRoot(), 'dry-merge-'));
  const paths = [];
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body, 'utf8');
    paths.push(p);
  }
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 生成 N 行互不相同的代码（保证每行都是有效非注释行）。 */
function block(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}_line_${i} = ${i * 7 + 3};`).join('\n');
}

/**
 * 生成 N 行填充，**两侧内容不同** —— 用不同的前缀保证不会被判成重复。
 * 这是负控成立的前提：只有填充不同，「两段独立复制」才是真的独立。
 */
function filler(tag, n) {
  return Array.from({ length: n }, (_, i) => `${tag}_filler_${i} = ${i * 11 + 5};`).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 1. 正控：一段长重复只报一条
// ─────────────────────────────────────────────────────────────

test('一段 20 行重复（窗口 6）⇒ 只报 1 条，不再是 15 条', () => {
  const shared = block('shared', 20);
  const ws = makeRepo({
    'a.js': `${shared}\n`,
    'b.js': `${shared}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    assert.equal(dups.length, 1, `20 行重复在窗口 6 下应只报 1 条，实际 ${dups.length} 条`);
    assert.ok(dups[0].span >= 20, `合并后跨度应 ≥20，实际 ${dups[0].span}`);
    assert.ok(dups[0].windows >= 15, `应记录合并了 ≥15 个窗口，实际 ${dups[0].windows}`);
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 负控：不重叠的重复不许被合并掉（本次修法最大的风险）
// ─────────────────────────────────────────────────────────────

test('★ 负控：两段相同重复、中间填充**两侧不同** ⇒ 必须报出两处配对，不许合并', () => {
  const seg = block('seg', 8);
  const ws = makeRepo({
    'a.js': `${seg}\n${filler('left', 40)}\n${seg}\n`,
    'b.js': `${seg}\n${filler('right', 40)}\n${seg}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    // ★ 注意语义：`index` 只记每个窗口内容**首次出现**的位置，
    //   所以 a 侧的第二段不会被当作 `prev`。因此这里能报出的配对是
    //   「a 第一段 ↔ b 第一段」和「a 第一段 ↔ b 第二段」—— 两条，且各自 span 只有 8。
    //   本测试要钉的是**不许把这两条合并成一条大跨度**（那才是真漏报）。
    assert.equal(dups.length, 2, `两处配对应各报一条，实际 ${dups.length} 条`);
    for (const d of dups) {
      assert.ok(d.span <= 10, `每条的跨度不得把中间 40 行填充吞进去，实际 span=${d.span}`);
    }
    // 两条的 b 侧起点必须不同（证明是两处配对，不是同一处重复计数）
    const bStarts = new Set(dups.map((d) => d.b.line));
    assert.equal(bStarts.size, 2, `两条应指向 b 侧两个不同位置，实际 ${[...bStarts].join(',')}`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：两段不同内容、相隔很远 ⇒ 各报一条', () => {
  const p = block('alpha', 7);
  const q = block('beta', 7);
  const ws = makeRepo({
    'x.js': `${p}\n${filler('gapL', 50)}\n${q}\n`,
    'y.js': `${p}\n${filler('gapR', 50)}\n${q}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    assert.equal(dups.length, 2, `两段不同内容的重复应报 2 条，实际 ${dups.length} 条`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：同内容但错位（b 侧多 4 行填充）⇒ 一条且行差 = 4', () => {
  const seg = block('off', 10);
  const ws = makeRepo({
    'a.js': `${seg}\n`,
    'b.js': `${filler('pre', 4)}\n${seg}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    assert.equal(dups.length, 1, `同一段只出现一次应报 1 条，实际 ${dups.length} 条`);
    const d = dups[0];
    assert.equal(d.b.line - d.a.line, 4, `b 侧多 4 行填充，行差应为 4，实际 ${d.b.line - d.a.line}`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：短于窗口的重复 ⇒ 一条都不报', () => {
  const seg = block('tiny', 5); // 只有 5 行，窗口是 6
  const ws = makeRepo({
    'a.js': `${seg}\n`,
    'b.js': `${seg}\n`,
  });
  try {
    assert.equal(duplicateBlocks(ws.paths, 6).length, 0, '5 行重复在窗口 6 下不应报警');
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：同文件内重复不报（跨文件才是复制粘贴信号）', () => {
  const seg = block('same', 10);
  const ws = makeRepo({
    'a.js': `${seg}\n${filler('mid', 30)}\n${seg}\n`,
  });
  try {
    assert.equal(duplicateBlocks(ws.paths, 6).length, 0, '同文件内重复不该报');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 元判据：结构不变量
// ─────────────────────────────────────────────────────────────

test('元判据：每条 span ≥ size、必跨文件、windows ≥ 1', () => {
  const shared = block('meta', 18);
  const ws = makeRepo({
    'a.js': `${shared}\n`,
    'b.js': `${shared}\n`,
    'c.js': `${shared}\n`, // 三方重复
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    assert.ok(dups.length >= 1, '三方重复至少要报出跨文件命中');
    for (const d of dups) {
      assert.ok(d.span >= 6, `每条 span 应 ≥ 窗口大小 6，实际 ${d.span}`);
      assert.ok(d.windows >= 1, '每条至少含 1 个窗口');
      assert.notEqual(d.a.file, d.b.file, '每条命中必须跨文件');
    }
  } finally {
    ws.cleanup();
  }
});

test('元判据：合并后条数 = 原始窗口数减去被合并的窗口数（可加性）', () => {
  const shared = block('add', 16);
  const ws = makeRepo({
    'a.js': `${shared}\n`,
    'b.js': `${shared}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6);
    const totalWindows = dups.reduce((s, d) => s + d.windows, 0);
    // 16 行、窗口 6 ⇒ 原始应有 11 个窗口
    assert.equal(totalWindows, 11, `16 行窗口 6 应产出 11 个窗口，实际 ${totalWindows}`);
    assert.equal(dups.length, 1, '但它们属于同一段，应合为 1 条');
  } finally {
    ws.cleanup();
  }
});
