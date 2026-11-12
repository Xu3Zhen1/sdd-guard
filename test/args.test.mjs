// 接口契约测试：命令行参数解析必须与 ICD/HELP 写的完全一致。
// 覆盖两类历史缺陷：① `--code` 声称可重复但实现覆盖；② 布尔开关把下一个参数吃掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, REPEATABLE_KEYS } from '../lib/args.mjs';
import { resolveOnly } from '../lib/runner.mjs';
import { RULES } from '../lib/rules.mjs';
import { OPTIONS } from '../lib/contract.mjs';

test('--code 可重复出现并累积为数组（HELP 里写着「可重复」，必须真支持）', () => {
  const a = parseArgs(['check', '--change', 'c', '--code', 'src', '--code', 'lib', '--code', 'pkg']);
  assert.deepEqual(a.code, ['src', 'lib', 'pkg']);
  assert.equal(a.change, 'c');
});

test('单个 --code 也归一为长度 1 的数组（调用方不必分支判断）', () => {
  const a = parseArgs(['--code', 'src']);
  assert.deepEqual(a.code, ['src']);
  assert.ok(Array.isArray(a.code));
});

test('REPEATABLE_KEYS 之外的选项重复出现时后者覆盖前者（明确语义，不是静默丢）', () => {
  const a = parseArgs(['--change', 'a', '--change', 'b']);
  assert.equal(a.change, 'b');
  assert.ok(!REPEATABLE_KEYS.has('change'));
});

test('布尔开关不吃掉后面的位置参数', () => {
  const a = parseArgs(['check', '--json', '--change', 'c']);
  assert.equal(a.json, true);
  assert.equal(a.change, 'c');
});

test('选项值缺失时记为 true，调用方据此报错（不得把它当成字符串 "true"）', () => {
  const a = parseArgs(['--change']);
  assert.equal(a.change, true);
  const b = parseArgs(['--change', '--json']);
  assert.equal(b.change, true);
  assert.equal(b.json, true);
});

test('非选项参数进入 _ 数组，顺序保持', () => {
  const a = parseArgs(['check', 'extra1', 'extra2']);
  assert.deepEqual(a._, ['check', 'extra1', 'extra2']);
});

// ─── --only 解析：空集不构成通过 ───────────────────────────────
test('--only 全为已知 id ⇒ 只选这些规则', () => {
  const { selected, unknown } = resolveOnly(['KISS-S1', 'DRY-D1'], RULES);
  assert.deepEqual(selected.map((r) => r.id), ['KISS-S1', 'DRY-D1']);
  assert.deepEqual(unknown, []);
});

test('--only 含未知 id ⇒ 必须报出，不能静默变成"0 条规则 ⇒ 全过"', () => {
  const { selected, unknown } = resolveOnly(['KISS-S1', 'NO-SUCH-RULE'], RULES);
  assert.deepEqual(unknown, ['NO-SUCH-RULE']);
  assert.equal(selected.length, 1, '已知 id 仍应被选中，未知 id 由调用方报错');
});

test('--only 全是未知 id ⇒ selected 为空且 unknown 非空（调用方据此退出码 2）', () => {
  const { selected, unknown } = resolveOnly(['TYPO-A', 'TYPO-B'], RULES);
  assert.equal(selected.length, 0);
  assert.equal(unknown.length, 2);
});

test('不传 --only ⇒ 选中全部规则，unknown 为空', () => {
  const { selected, unknown } = resolveOnly(null, RULES);
  assert.equal(selected.length, RULES.length);
  assert.ok(selected.length > 0, '规则集非空');
  assert.deepEqual(unknown, []);
});
// ── --min-coverage：机器规则覆盖率下限（2026-11-12 外部实测的缺口）──
// 缺口形态：空 change 目录 → 通过 0 · 失败 0 · 跳过 13，而硬失败只看 fail>0
// ⇒ 退出码 0 ⇒ CI 放行空提交。实测确认过（EXIT=0）。
test('--min-coverage 出现在 OPTIONS 里且声明了取值范围', () => {
  const opt = OPTIONS.find((o) => o.key === 'min-coverage');
  assert.ok(opt, '--min-coverage 未登记在 OPTIONS（--help 里不会有它）');
  assert.equal(opt.value, '<0..1>');
  assert.match(opt.desc, /覆盖率/);
});

test('--min-coverage 能正确解析出数值字符串', () => {
  const args = parseArgs(['check', '--min-coverage', '0.8']);
  assert.equal(args['min-coverage'], '0.8');
});
