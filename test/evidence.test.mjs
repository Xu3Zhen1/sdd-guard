// 证据生产层的接口测试：解析器必须"吃得下真输出"，并"拒收假输出"。
// 夹具是真实命令的输出（test/fixtures/raw/*.txt），不是手写的理想文本——
// 手写夹具会掩盖真实格式，判据就永远绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNodeTest, parseMutationReport, parseDriftReport, buildEvidence, digest, missingEvidenceKeys } from '../lib/evidence.mjs';
import { EVIDENCE_KEYS } from '../lib/contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name) => readFileSync(join(HERE, 'fixtures/raw', name), 'utf8');

// ── 正控：真实输出必须被正确解析 ───────────────────────────
test('parseNodeTest 正控：真实 guard 输出 → passed=45 / failed=0', () => {
  const r = parseNodeTest(raw('guard.txt'));
  assert.equal(r.failed, 0);
  assert.equal(r.passed, 45);
  assert.equal(r.total, 45);
  assert.ok(r.passed > 0, '样本非空');
});

test('parseMutationReport 正控：真实变异报告 → killed=total=11', () => {
  const r = parseMutationReport(raw('mutation.txt'));
  assert.equal(r.total, 11);
  assert.equal(r.killed, 11);
  assert.deepEqual(r.survived, []);
  assert.equal(r.concludedAllKilled, true);
});

test('parseDriftReport 正控：真实漂移报告 → checks=44 / findings=0', () => {
  const r = parseDriftReport(raw('drift.txt'));
  assert.equal(r.checks, 44);
  assert.equal(r.findings, 0);
  assert.equal(r.passed, 44);
  assert.deepEqual(r.items, []);
});

// ── 跨 Node 版本：汇总行前缀不同 ───────────────────────────
test('parseNodeTest：Node 20 的 "# tests/# pass" 格式也要能解析（CI 矩阵真实踩过）', () => {
  const legacy = ['# tests 47', '# suites 0', '# pass 47', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n');
  const r = parseNodeTest(legacy);
  assert.equal(r.total, 47);
  assert.equal(r.passed, 47);
  assert.equal(r.failed, 0);
});

// ── 负控：解析失败必须抛错，不能返回 0 ─────────────────────
test('parseNodeTest 负控：空输出 → 必须抛错（不能返回 passed=0 冒充"跑过"）', () => {
  assert.throws(() => parseNodeTest(''), /无法解析测试输出/);
});

test('parseNodeTest 负控：换了非 TAP reporter（只有 ok/not ok）→ 抛错而不是猜', () => {
  assert.throws(() => parseNodeTest('ok 1 - works\nnot ok 2 - broken\n'), /无法解析/);
});

test('parseNodeTest 负控：自相矛盾（pass+fail > tests）→ 抛错', () => {
  assert.throws(() => parseNodeTest('ℹ tests 3\nℹ pass 3\nℹ fail 2\n'), /自相矛盾/);
});

test('parseMutationReport 负控：没有任何变异行 → 抛错', () => {
  assert.throws(() => parseMutationReport('全部通过\n'), /无法解析变异报告/);
});

test('parseDriftReport 负控：缺汇总行 → 抛错', () => {
  assert.throws(() => parseDriftReport('  ok    something\n'), /无法解析漂移报告/);
});

test('parseDriftReport 负控：通过+漂移 ≠ 检查项 → 抛错', () => {
  assert.throws(() => parseDriftReport('检查项 10 · 通过 5 · 漂移 2\n'), /自相矛盾/);
});

// ── 存活变异体必须被回显（否则无法定位）─────────────────────
test('parseMutationReport：存活变异体带出名字', () => {
  const text = [
    '  M1 甲: 判据依赖被测实现 ✓（fail → pass → fail）',
    '  M2 乙: 判据依赖被测实现 ✗',
    '结论: 1 项未被捕获 ✗',
  ].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.killed, 1);
  assert.equal(r.total, 2);
  assert.equal(r.survived.length, 1);
  assert.match(r.survived[0], /M2 乙/);
});

// ── 回执缺陷①（最严重）：前缀绑死 `M` 会让存活变异被整段吞掉 ──
// 实测形态：存活变异叫 S1..S4 时，解析出 killed=total ⇒ 杀死率 100% ⇒ ACCEPT-E2 假绿。
test('parseMutationReport 负控：非 M 前缀的存活变异也必须被计入（否则假绿）', () => {
  const text = [
    '  M1 甲 ✓',
    '  M2 乙 ✓',
    '  S1 丙 ✗',
    '  S2 丁 ✗',
  ].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.total, 4, '非 M 前缀的行被吞掉了 —— 分母缩水，杀死率会假性变高');
  assert.equal(r.killed, 2);
  assert.equal(r.survived.length, 2);
  assert.deepEqual(r.survived.map((s) => s.split(' ')[0]), ['S1', 'S2']);
});

test('parseMutationReport 正控：多种 id 形态都要认出（mut-3 / X12 / A1）', () => {
  const text = ['  mut-3 甲 ✓', '  X12 乙 ✗', '  A1 丙 ✓'].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.total, 3);
  assert.equal(r.killed, 2);
});

// ── 回执缺陷①的配套：报告自相矛盾必须抛错，不能"取信一边" ──
test('parseMutationReport 负控：声称"全部被捕获"但有存活行 → 抛错', () => {
  const text = ['  M1 甲 ✓', '  M2 乙 ✗', '结论: 全部变异均被捕获 ✓'].join('\n');
  assert.throws(() => parseMutationReport(text), /自相矛盾/);
});

// ── 合成与校验 ────────────────────────────────────────────
test('buildEvidence 负控：没有任何证据 → 抛错（不能产出空证据文件）', () => {
  assert.throws(() => buildEvidence({}, { generatedAt: 'x' }), /没有任何证据/);
});

test('buildEvidence 正控：带上 provenance 与 meta', () => {
  const ev = buildEvidence({ tests: { passed: 1, failed: 0 } }, { cwd: '/x', producers: {} });
  assert.deepEqual(ev.tests, { passed: 1, failed: 0 });
  assert.equal(ev.meta.cwd, '/x');
});

test('missingEvidenceKeys：缺键必须被逐个报出（acceptance 据此退出码 2）', () => {
  const ev = { tests: { passed: 1, failed: 0 } };
  assert.deepEqual(missingEvidenceKeys(ev, EVIDENCE_KEYS), ['mutation', 'drift']);
  assert.deepEqual(missingEvidenceKeys(null, EVIDENCE_KEYS), EVIDENCE_KEYS);
  assert.deepEqual(missingEvidenceKeys({ tests: {}, mutation: {}, drift: {} }, EVIDENCE_KEYS), []);
});

test('digest：同输入同指纹，不同输入不同指纹（provenance 可区分两次运行）', () => {
  assert.equal(digest('abc'), digest('abc'));
  assert.notEqual(digest('abc'), digest('abd'));
  assert.equal(digest('abc').length, 16);
});
