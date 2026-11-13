// 证据生产层的接口测试：解析器必须"吃得下真输出"，并"拒收假输出"。
// 夹具是真实命令的输出（test/fixtures/raw/*.txt），不是手写的理想文本——
// 手写夹具会掩盖真实格式，判据就永远绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseNodeTest,
  parseMutationReport,
  parseDriftReport,
  buildEvidence,
  digest,
  digestShort,
  missingEvidenceKeys,
} from '../lib/evidence.mjs';
import { EVIDENCE_KEYS } from '../lib/contract.mjs';
import { runRules } from '../lib/runner.mjs';

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

test('parseMutationReport 正控：真实变异报告（带 MUTANT_TOTAL）→ killed=total=12 且 completeness=complete', () => {
  const r = parseMutationReport(raw('mutation.txt'));
  assert.equal(r.total, 12);
  assert.equal(r.killed, 12);
  assert.deepEqual(r.survived, []);
  assert.equal(r.concludedAllKilled, true);
  // ★ 规格变更（A09）：total 不再只是"匹配到的行数"，报告必须自己声明清单长度。
  assert.equal(r.declaredTotal, 12, '夹具里的 MUTANT_TOTAL=12 没被识别');
  assert.equal(r.completeness, 'complete');
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
    'MUTANT_TOTAL=2',
    '结论: 1 项未被捕获 ✗',
  ].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.killed, 1);
  assert.equal(r.total, 2);
  assert.equal(r.survived.length, 1);
  assert.match(r.survived[0], /M2 乙/);
  assert.equal(r.completeness, 'complete');
});

// ── 回执缺陷①（最严重）：前缀绑死 `M` 会让存活变异被整段吞掉 ──
// 实测形态：存活变异叫 S1..S4 时，解析出 killed=total ⇒ 杀死率 100% ⇒ ACCEPT-E2 假绿。
test('parseMutationReport 负控：非 M 前缀的存活变异也必须被计入（否则假绿）', () => {
  const text = ['  M1 甲 ✓', '  M2 乙 ✓', '  S1 丙 ✗', '  S2 丁 ✗', 'MUTANT_TOTAL=4'].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.total, 4, '非 M 前缀的行被吞掉了 —— 分母缩水，杀死率会假性变高');
  assert.equal(r.killed, 2);
  assert.equal(r.survived.length, 2);
  assert.deepEqual(r.survived.map((s) => s.split(' ')[0]), ['S1', 'S2']);
});

test('parseMutationReport 正控：多种 id 形态都要认出（mut-3 / X12 / A1）', () => {
  const text = ['  mut-3 甲 ✓', '  X12 乙 ✗', '  A1 丙 ✓', 'MUTANT_TOTAL=3'].join('\n');
  const r = parseMutationReport(text);
  assert.equal(r.total, 3);
  assert.equal(r.killed, 2);
});

// ── 回执缺陷①的配套：报告自相矛盾必须抛错，不能"取信一边" ──
test('parseMutationReport 负控：声称"全部被捕获"但有存活行 → 抛错', () => {
  const text = ['  M1 甲 ✓', '  M2 乙 ✗', '结论: 全部变异均被捕获 ✓'].join('\n');
  assert.throws(() => parseMutationReport(text), /自相矛盾/);
});

// ══════════════════════════════════════════════════════════════
// ★ A09 变异自证 ①：「唯一汇总」判据的负控
// ══════════════════════════════════════════════════════════════
// 审计实证的缺陷：旧实现「分字段各取首个匹配」，于是同一份输出里
// 先放 `tests 999 / pass 999 / fail 0`、后放真实 `tests 2 / pass 1 / fail 1`，
// 解析器拼出 999 全绿、make-evidence exit 0、ACCEPT-E1 也 exit 0 ——
// **真实失败被拼成不存在的"999 全绿"**。
//
// 本负控证明：现在**抛错**，而不是"取第一个"。
test('parseNodeTest 负控（A09 双汇总）：两组数值不同的汇总 → 必须抛错，不得取第一个', () => {
  const doubleSummary = [
    '✔ 某用例 (1.2ms)',
    'ℹ tests 999',
    'ℹ pass 999',
    'ℹ fail 0',
    '',
    '✔ 后一组真实结果 (2.3ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
  ].join('\n');

  // 先自证这份输入**确实**含有两组不同数值的汇总（否则下面的 throws 可能是别的原因）。
  const testsLines = doubleSummary.split('\n').filter((l) => /tests \d+/.test(l));
  assert.equal(testsLines.length, 2, '夹具本身没构造出双汇总');
  assert.notEqual(testsLines[0], testsLines[1], '两组的数值必须不同，否则不算歧义');

  assert.throws(() => parseNodeTest(doubleSummary), /自相矛盾/);

  // 反向断言：绝不允许"取第一个"的行为 —— 不能返回 999。
  let got = null;
  try {
    got = parseNodeTest(doubleSummary);
  } catch {
    got = null;
  }
  assert.equal(got, null, `解析器返回了结果（${JSON.stringify(got)}）—— 说明它仍在"取第一个"`);
});

test('parseNodeTest 负控（A09 双汇总）：数值相同但来自两份输出（相隔很远）→ 也要抛错', () => {
  // 这一形态专打"每个字段各取第一个，碰巧数值相同就看不出来"的盲区：
  // tests 在文件头、pass/fail 在 200 行之外，属于"从两份输出里各拿一行"。
  const far = [
    'ℹ tests 5',
    ...Array.from({ length: 200 }, (_, i) => `✔ 填充行 ${i} (0.1ms)`),
    'ℹ pass 5',
    'ℹ fail 0',
  ].join('\n');
  assert.throws(() => parseNodeTest(far), /自相矛盾/);
});

// ══════════════════════════════════════════════════════════════
// ★ A09 变异自证 ②：变异报告「清单完整性」判据的负控
// ══════════════════════════════════════════════════════════════
// 审计实证的缺陷：只有一行 `M1 ✓` 的报告（生产者崩了/被截断）与
// "真的只有一个变异体"的报告**完全同形**，旧实现一律给 killed=1/total=1。
test('parseMutationReport 负控（A09 截断报告）：只有一行且无声明 → completeness 必须是 unknown', () => {
  const truncated = '  M1 甲 ✓\n';
  const r = parseMutationReport(truncated);
  // 不能抛错（这份报告本身合法），但**必须**标明"我无法证明它是完整的"。
  assert.equal(r.total, 1);
  assert.equal(r.killed, 1);
  assert.equal(r.completeness, 'unknown', '截断报告被判成完整了 —— 1/1 假绿会回来');
  assert.match(r.completenessReason, /未声明清单长度/);
});

test('parseMutationReport 负控（A09 截断报告）：声明 5 条但只有 1 行 → 必须抛错', () => {
  const truncated = ['  M1 甲 ✓', 'MUTANT_TOTAL=5'].join('\n');
  assert.throws(() => parseMutationReport(truncated), /不完整/);
});

test('parseMutationReport：声明与实测一致 → complete（这才是可以判 PASS 的证据）', () => {
  const ok = ['  M1 甲 ✓', '  M2 乙 ✓', 'MUTANT_TOTAL=2'].join('\n');
  const r = parseMutationReport(ok);
  assert.equal(r.completeness, 'complete');
  assert.equal(r.declaredTotal, 2);
});

test('parseMutationReport：三种声明写法（MUTANT_TOTAL= / 变异总数：/ TOTAL=）都要认', () => {
  const body = ['  M1 甲 ✓', '  M2 乙 ✓'].join('\n');
  for (const decl of ['MUTANT_TOTAL=2', '变异总数：2', 'TOTAL=2']) {
    const r = parseMutationReport(`${body}\n${decl}`);
    assert.equal(r.completeness, 'complete', `声明写法未被识别: ${decl}`);
    assert.equal(r.declaredTotal, 2);
  }
});

test('parseMutationReport：没有声明但给了 expectedMutants 清单 → 逐条对账通过则 complete', () => {
  const text = ['  M1 甲 ✓', '  M2 乙 ✗', '  S3 丙 ✓'].join('\n');
  const r = parseMutationReport(text, { expectedMutants: ['M1', 'M2', 'S3'] });
  assert.equal(r.completeness, 'complete');
  assert.equal(r.total, 3);

  // 清单对不上（少一条）必须抛错，而不是"凑合算完整"。
  assert.throws(() => parseMutationReport(text, { expectedMutants: ['M1', 'M2'] }), /不一致/);
});

test('parseMutationReport 负控：两处清单声明互相矛盾 → 抛错', () => {
  const text = ['  M1 甲 ✓', 'MUTANT_TOTAL=1', 'MUTANT_TOTAL=7'].join('\n');
  assert.throws(() => parseMutationReport(text), /自相矛盾/);
});

// ── A09 同族：漂移报告的歧义也必须抛错 ──────────────────────
test('parseDriftReport 负控（A09 双汇总）：两组数值不同的汇总 → 必须抛错', () => {
  const text = ['检查项 10 · 通过 10 · 漂移 0', '检查项 10 · 通过 5 · 漂移 5'].join('\n');
  assert.throws(() => parseDriftReport(text), /自相矛盾/);
});

test('parseDriftReport：同一组汇总重复出现（CI 重打）仍可解析，不算歧义', () => {
  const text = ['检查项 44 · 通过 44 · 漂移 0', '检查项 44 · 通过 44 · 漂移 0'].join('\n');
  const r = parseDriftReport(text);
  assert.equal(r.checks, 44);
  assert.equal(r.findings, 0);
});

// ══════════════════════════════════════════════════════════════
// ★ A09 变异自证 ②（规则级）：ACCEPT-E2 的完整性判据负控
// ══════════════════════════════════════════════════════════════
// 审计实证的完整链路：生产者只打一行 `M1 ✓` 然后退出 → make-evidence 解析成
// killed=1/total=1 → 这条证据带 meta.producers.mutation（机器生产痕迹）→
// 旧 ACCEPT-E2 只看 1/1=1.00 ≥ 0.8 ⇒ **PASS**。
//
// 这里用**真实解析器 + 真实规则**复现该链路，断言它现在判 FAIL。
test('ACCEPT-E2 负控（A09 完整性）：单行变异报告 + 生产者痕迹 → 必须 FAIL 而不是 1/1 通过', () => {
  const oneLine = '  M1 甲 ✓\n';
  const parsed = parseMutationReport(oneLine);
  assert.equal(parsed.completeness, 'unknown', '前提：单行报告无法自证完整');

  // 关键：带 meta.producers.mutation —— 这正是 make-evidence 产出的形态。
  const evidence = {
    tests: { passed: 10, failed: 0, total: 10 },
    mutation: parsed,
    drift: { checks: 5, passed: 5, findings: 0, items: [] },
    meta: { producers: { mutation: { command: 'node test/mutation.mjs', exitCode: 1, sha256: 'x'.repeat(64) } } },
  };
  const { results } = runRules({
    changeDir: join(HERE, 'fixtures/good/changes/add-empty-check'),
    repo: join(HERE, 'fixtures/good'),
    cwd: join(HERE, 'fixtures/good'),
    cfg: { maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1 },
    codeRoots: [],
    diff: null,
    evidence,
    profile: 'all',
  });
  const e2 = results.find((r) => r.id === 'ACCEPT-E2');
  assert.ok(e2, 'ACCEPT-E2 规则不存在');
  assert.equal(e2.status, 'fail', `单行变异报告被判成 ${e2.status} —— 1/1 假绿回来了`);
  assert.match(e2.reason || '', /清单完整性|completeness|MUTANT_TOTAL/);
});

test('ACCEPT-E2 正控（A09 完整性）：同一份报告声明 MUTANT_TOTAL=1 → 完整性成立，按杀死率判定', () => {
  const oneLine = '  M1 甲 ✓\nMUTANT_TOTAL=1\n';
  const parsed = parseMutationReport(oneLine);
  assert.equal(parsed.completeness, 'complete');

  const evidence = {
    mutation: parsed,
    meta: { producers: { mutation: { command: 'x', exitCode: 0, sha256: 'y'.repeat(64) } } },
  };
  const { results } = runRules({
    changeDir: join(HERE, 'fixtures/good/changes/add-empty-check'),
    repo: join(HERE, 'fixtures/good'),
    cwd: join(HERE, 'fixtures/good'),
    cfg: { maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1 },
    codeRoots: [],
    diff: null,
    evidence,
    profile: 'all',
  });
  const e2 = results.find((r) => r.id === 'ACCEPT-E2');
  assert.equal(e2.status, 'pass', `已声明完整的 1/1 反被判 ${e2.status}：${e2.reason || e2.detail}`);
  assert.match(e2.detail || '', /completeness|清单完整性/);
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

// ══════════════════════════════════════════════════════════════
// ★ A11 / A09：digest 必须是**完整 64 位** SHA-256
// ══════════════════════════════════════════════════════════════
// 【规格变更说明】原断言是 `digest('abc').length === 16`。
// 那是把**缺陷写进了规格**：字段名叫 sha256，值却只有 16 位前缀，
// 与"证据绑定到哪次输出"的承诺不符（A11 明确列为缺陷）。
// 现在断言 64 位 + 确定性 + 短形式单独存在且长度 16。
test('digest：同输入同指纹，不同输入不同指纹，且必须是**完整 64 位**（A11 规格变更）', () => {
  assert.equal(digest('abc'), digest('abc'), '不确定：同一输入两次得到不同值');
  assert.notEqual(digest('abc'), digest('abd'));

  const h = digest('abc');
  assert.equal(h.length, 64, `digest 必须是完整 64 位 hex，实际 ${h.length} 位`);
  assert.match(h, /^[0-9a-f]{64}$/);
  // 与 Node 官方实现逐字节一致（不是自己拼的伪哈希）
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('digestShort：16 位短摘要仅供人读，且是完整 digest 的前缀', () => {
  const short = digestShort('abc');
  assert.equal(short.length, 16);
  assert.equal(digest('abc').slice(0, 16), short, '短形式必须与完整值同源，不能是另一套算法');
});

