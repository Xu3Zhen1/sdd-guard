/**
 * items 按文件聚合（2026-11-16，第 ⑤ 位）。
 *
 * ★ 修的是什么：旧实现一律 `bad.slice(0, 30)` —— **纯粹按出现顺序截断**。
 *
 *   实测（Java 仓，KISS-C1 共 211 处）：`items` 30 条里 **29 条来自 `BuildPlan.java`**，
 *   而实际涉及 **15 个文件**。
 *   ⇒ 读者看到 30 条几乎全指向一个文件，会以为"就这一个文件有问题"，
 *     而真相是 15 个文件都有问题，只是**前 30 条恰好都被单文件占满**。
 *
 *   这与第 ④ 位同族：**输出格式让真相失真**。判据本身没错，错在取样方式。
 *
 * ★ 本文件的负控为什么重要：聚合是"改变取样"的操作，
 *   最容易顺手把**必须全部列出的条目**也合并掉（例如变更行清单）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByFile } from '../lib/rules.mjs';

/**
 * 取**样本部分**（去掉末尾的截断自曝行）。
 *
 * ★ 2026-11-18 为什么需要它：
 *   `aggregateByFile` 现在会在**超出名额时**追加一条自曝
 *   「…… 另有 N 处未列出（本项共 M 处，此处仅示 K 处）」。
 *   本文件测的是**名额分配策略**（谁获得名额），不是报告形态，
 *   所以断言必须只看样本 —— 否则每加一条自曝就要改四处无关的断言，
 *   那种改法是"让测试迁就实现"，会掩盖真实回归。
 *
 *   截断自曝本身的判据在 `test/items-truncation.test.mjs` 单独测。
 */
const sampleOf = (items) => (items.some((t) => /^…… 另有 /.test(t)) ? items.slice(0, -1) : items);

/** 造 N 条属于同一文件的条目。 */
function ofFile(file, n, tag = '') {
  return Array.from({ length: n }, (_, i) => ({ file, text: `${file}:${i + 1} ${tag}` }));
}

// ─────────────────────────────────────────────────────────────
// 1. 正控：每个文件都必须有代表
// ─────────────────────────────────────────────────────────────

test('★ 单文件占满名额的情形 ⇒ 其他文件必须仍然出现', () => {
  // 模拟 Java 仓实测：A 文件 29 条、其余 14 个文件各 1 条
  const entries = [
    ...ofFile('A.java', 29),
    ...Array.from({ length: 14 }, (_, i) => ({ file: `F${i}.java`, text: `F${i}.java:1 x` })),
  ];
  const items = aggregateByFile(entries, 30);
  const sample = sampleOf(items);
  assert.equal(sample.length, 30, `样本应保持上限 30，实际 ${sample.length}`);

  const files = new Set(sample.map((t) => t.split(':')[0]));
  assert.equal(files.size, 15, `15 个文件都必须出现，实际 ${files.size} 个: ${[...files].join(',')}`);
  // 43 条 > 30 ⇒ 必须有截断自曝
  assert.match(items[items.length - 1], /另有 13 处未列出/, '超限必须自曝截断条数');
});

test('文件数少于名额时，剩余名额按"文件内条数"降序分配给热点', () => {
  const entries = [
    ...ofFile('big.js', 10),
    ...ofFile('small.js', 2),
    ...ofFile('mid.js', 5),
  ];
  const items = aggregateByFile(entries, 10);
  const sample = sampleOf(items);
  assert.equal(sample.length, 10, '应取满 10 条');
  const cnt = {};
  for (const t of sample) {
    const f = t.split(':')[0];
    cnt[f] = (cnt[f] || 0) + 1;
  }
  // 第一轮各 1 条（big/small/mid），剩 7 条按剩余条数降序：big 剩 9 → mid 剩 4 → small 剩 1
  assert.ok(cnt['big.js'] >= cnt['mid.js'], `热点文件应获得更多名额，实际 big=${cnt['big.js']} mid=${cnt['mid.js']}`);
  assert.ok(cnt['mid.js'] >= cnt['small.js'], `mid 应不少于 small，实际 mid=${cnt['mid.js']} small=${cnt['small.js']}`);
  assert.ok(cnt['small.js'] >= 1, 'small 必须有代表');
});

test('条数不超过上限时原样返回（不丢任何一条）', () => {
  const entries = [...ofFile('a.js', 3), ...ofFile('b.js', 4)];
  const items = aggregateByFile(entries, 30);
  assert.equal(items.length, 7, `7 条应全部保留，实际 ${items.length}`);
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 负控
// ─────────────────────────────────────────────────────────────

test('★ 负控：空输入 ⇒ 空数组（不是 undefined，也不抛错）', () => {
  assert.deepEqual(aggregateByFile([], 30), [], '空输入应返回空数组');
  assert.deepEqual(aggregateByFile(null, 30), [], 'null 输入应返回空数组');
});

test('★ 负控：文件数 > 名额时，仍保证前 limit 个文件各 1 条（全覆盖优先于热点）', () => {
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push({ file: `f${String(i).padStart(2, '0')}.js`, text: `f${i}.js:1` });
  const items = aggregateByFile(entries, 30);
  const sample = sampleOf(items);
  assert.equal(sample.length, 30, '样本应正好 30 条');
  const files = new Set(sample.map((t) => t.split(':')[0]));
  assert.equal(files.size, 30, `30 个名额应覆盖 30 个不同文件，实际 ${files.size}`);
  // 40 条 > 30 ⇒ 必须有截断自曝
  assert.match(items[items.length - 1], /另有 10 处未列出/);
});

test('★ 负控：同一文件内的条目保持原有顺序（不重排，避免改变"第一条"语义）', () => {
  const entries = [
    { file: 'x.js', text: 'x.js:5 e' },
    { file: 'x.js', text: 'x.js:1 a' },
    { file: 'x.js', text: 'x.js:9 i' },
  ];
  const items = aggregateByFile(entries, 30);
  assert.deepEqual(items, ['x.js:5 e', 'x.js:1 a', 'x.js:9 i'], '必须保持输入顺序');
});

test('★ 负控：结果稳定 —— 同样的输入跑两次得到完全相同的输出', () => {
  const entries = [
    ...ofFile('b.js', 5),
    ...ofFile('a.js', 3),
    ...ofFile('c.js', 8),
  ];
  const first = aggregateByFile(entries, 10);
  const second = aggregateByFile(entries, 10);
  assert.deepEqual(first, second, '输出必须可复现（不依赖 Map 遍历顺序的偶然性）');
});

// ─────────────────────────────────────────────────────────────
// 3. 元判据
// ─────────────────────────────────────────────────────────────

test('元判据：样本条数恒 ≤ limit，且每条文本都来自输入', () => {
  const entries = [...ofFile('a.js', 100), ...ofFile('b.js', 50)];
  const limit = 30;
  const items = aggregateByFile(entries, limit);
  const sample = sampleOf(items);
  assert.ok(sample.length <= limit, `样本条数不得超上限，实际 ${sample.length}`);
  // 多出来的那条只能是截断自曝，不能是违规条目
  assert.ok(items.length <= limit + 1, `最多 limit + 1 条（含自曝），实际 ${items.length}`);

  const inputTexts = new Set(entries.map((e) => e.text));
  for (const t of sample) {
    assert.ok(inputTexts.has(t), `样本条目必须来自输入，出现来源不明: ${t}`);
  }
});

test('元判据：覆盖性 —— 所有被命中的文件，在输出里都至少出现一次（文件数 ≤ limit 时）', () => {
  const files = Array.from({ length: 12 }, (_, i) => `m${i}.js`);
  const entries = files.flatMap((f, i) => ofFile(f, i + 1)); // 每个文件条数不同
  const items = aggregateByFile(entries, 30);
  const seen = new Set(items.map((t) => t.split(':')[0]));
  for (const f of files) {
    assert.ok(seen.has(f), `文件 ${f} 必须出现在输出里`);
  }
});
