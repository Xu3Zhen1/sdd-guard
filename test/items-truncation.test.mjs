/**
 * 报告层不得**静默截断**（2026-11-18）。
 *
 * ★ 为什么需要这一层（实测）：
 *   造 40 个文件、每个 2 处超深嵌套 ⇒ `reason` 报「80 处超过 3 层」，
 *   而 `items` 只有 **30** 条，**没有任何提示说被截断了**。
 *
 *   本项目判据层反复强调「被截断与完整在文本与算术上都同形」
 *   （见 `rules.mjs` 关于变异报告的注释），却在**自己的报告层**静默截断 ——
 *   同一个错误在不同层各犯一次，这是最容易漏的那类。
 *
 *   在 2.7 万文件的仓库上，差异会从「30 vs 80」变成「30 vs 数千」，
 *   使用者看到 30 条会以为那就是全部。
 *
 * 判据（三个方向）：
 *   ① 超限时必须**明说**截断了多少（不能只给 30 条）
 *   ② 未超限时**不得**出现截断提示（否则变成永远多一行噪音）
 *   ③ 总数必须与 `reason` 里的数字**一致**（两处数字不能各自为政）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByFile } from '../lib/rules.mjs';

/** 造 n 条 entry，分散在 k 个文件里。 */
function entries(n, k) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ file: `src/f${i % k}.js`, text: `src/f${i % k}.js:${i} 违规 ${i}` });
  }
  return out;
}

test('★★ 命脉：超过 30 条时必须自曝截断（旧实现静默返回 30 条）', () => {
  const items = aggregateByFile(entries(80, 40));
  assert.equal(items.length, 31, `应为 30 条样本 + 1 条自曝，实际 ${items.length}`);
  const note = items[items.length - 1];
  assert.match(note, /另有 50 处未列出/, `自曝必须写出漏掉多少条，实际: ${note}`);
  assert.match(note, /共 80 处/, `自曝必须写出总数，实际: ${note}`);
});

test('★ 负控：恰好 30 条时不得出现自曝（不能永远多一行）', () => {
  const items = aggregateByFile(entries(30, 10));
  assert.equal(items.length, 30, `30 条正好放得下，不该多出提示，实际 ${items.length}`);
  assert.ok(!items.some((t) => /未列出/.test(t)), '未超限时不该有截断提示');
});

test('★ 负控：少于 30 条时也不得出现自曝', () => {
  const items = aggregateByFile(entries(3, 3));
  assert.equal(items.length, 3);
  assert.ok(!items.some((t) => /未列出/.test(t)));
});

test('★★ 自曝里的数字必须与实际漏掉条数**算得上**（不能只写个含糊说法）', () => {
  for (const total of [31, 61, 145, 1435]) {
    const items = aggregateByFile(entries(total, 20));
    const note = items[items.length - 1];
    const shown = Number((note.match(/此处仅示 (\d+) 处/) || [])[1]);
    const dropped = Number((note.match(/另有 (\d+) 处未列出/) || [])[1]);
    const all = Number((note.match(/共 (\d+) 处/) || [])[1]);
    assert.equal(all, total, `共 N 处 应等于实际总数 ${total}，实际 ${all}`);
    assert.equal(shown, 30, `此处仅示应为 30，实际 ${shown}`);
    assert.equal(dropped, total - shown, `漏掉数必须等于 ${total} - ${shown}`);
    assert.equal(items.length, 31, '样本 + 自曝 = 31');
  }
});

test('★ 空输入仍返回空数组（不得凭空补一条自曝）', () => {
  assert.deepEqual(aggregateByFile([]), []);
  assert.deepEqual(aggregateByFile(null), []);
});