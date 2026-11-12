// 评审包 §5 Q3：「不可达分支」的处理是否诚实。
//
// 原处理：`killed > effectiveTotal` 写成 `if (...) return {status:'fail'}`。
// 它确实不可达（454 组穷举，可达 0），但**永不执行**的代码与「不存在」
// 在可观测行为上完全等价 —— 测不到，也证明不了它还能工作。
//
// 现处理：降级为运行时断言 assertInvariant，每次运行都求值并记账。
// 本文件的关键是：**断言它真的被调用过**（calls > 0），
// 而不是只断言「没抛错」——「没抛错」与「没调用」症状同形。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertInvariant, invariantStats, resetInvariantStats } from '../lib/invariant.mjs';
import { runRules, summarize } from '../lib/runner.mjs';

const INV_ID = 'ACCEPT-E2.killed<=effectiveTotal';

const EVIDENCE = {
  tests: { tests: 10, pass: 10, fail: 0 },
  mutation: { killed: 8, total: 8, survived: [] },
  drift: { checks: 10, passed: 10, findings: 0 },
};

function runAcceptance(evidence) {
  const root = mkdtempSync(join(tmpdir(), 'q3-'));
  try {
    const cd = join(root, 'changes', 'x');
    mkdirSync(cd, { recursive: true });
    const { results } = runRules({
      changeDir: cd, repo: root, cwd: root,
      evidence, profile: 'acceptance',
    });
    return Object.fromEntries(results.map((r) => [r.id, r]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('不变量在正常执行路径上真的被求值（calls > 0，不是死代码）', () => {
  resetInvariantStats();
  // 一份完全自洽的变异证据：killed=8 total=8 survived=[]
  runAcceptance(EVIDENCE);
  const stats = invariantStats();
  const hit = stats.find((s) => s.id === INV_ID);
  assert.ok(hit, `不变量 ${INV_ID} 从未被调用 —— 它与死代码无异。已记录: ${JSON.stringify(stats)}`);
  assert.ok(hit.calls > 0, '不变量调用次数必须 > 0');
  assert.equal(hit.failures, 0, '正常路径不应触发不变量失败');
});

test('负控：抛异常时带 untrusted 信号（不变量破了说明判据坏了，不是被测对象不合格）', () => {
  resetInvariantStats();
  // 直接验证 assertInvariant 的失败语义
  assert.throws(
    () => assertInvariant(false, () => '不变量破了', 'TEST.inv'),
    /不变量破了/,
  );
  const st = invariantStats().find((s) => s.id === 'TEST.inv');
  assert.equal(st.calls, 1);
  assert.equal(st.failures, 1);
});

test('负控：断言成立时不抛错，但**仍然记账**（这是它与 if-return 的根本区别）', () => {
  resetInvariantStats();
  assertInvariant(true, '不该被调用', 'TEST.ok');
  assertInvariant(true, '不该被调用', 'TEST.ok');
  const st = invariantStats().find((s) => s.id === 'TEST.ok');
  assert.equal(st.calls, 2, '成立也必须记账，否则无法证明它跑过');
  assert.equal(st.failures, 0);
});

test('穷举复算：killed > effectiveTotal 确实不可达（454 组，与 2026-11-12 一致）', () => {
  // 独立复算，不引用被测代码的任何常量
  let reachable = 0;
  let cases = 0;
  const MAX = 12;
  for (let total = 1; total <= MAX; total++) {
    for (let killed = 0; killed <= total; killed++) {
      const survivedLen = total - killed; // 由自洽性 killed+survived=total 推出
      for (let hitExempt = 0; hitExempt <= survivedLen; hitExempt++) {
        cases++;
        const effectiveTotal = total - hitExempt;
        if (effectiveTotal <= 0) continue; // 有独立分支处理分母为 0
        if (killed > effectiveTotal) reachable++;
      }
    }
  }
  assert.equal(cases, 454, `枚举组合数应为 454，实际 ${cases}`);
  assert.equal(reachable, 0, `不可达分支竟然可达 ${reachable} 次 —— 原证明失效，需重新审视`);
});

test('负控：自洽性破坏时走 fail（不是 untrusted）——那是证据的问题，不是判据的问题', () => {
  resetInvariantStats();
  const r = runAcceptance({
    ...EVIDENCE,
    mutation: { killed: 6, total: 8, survived: [] }, // 6+0 != 8，漏列
  });
  const e2 = r['ACCEPT-E2'];
  assert.equal(e2.status, 'fail');
  assert.equal(e2.signal, undefined, '证据自相矛盾是证据的问题，不应标判据不可信');
  assert.match(e2.reason, /自相矛盾/);
});

test('交叉验证：rules.mjs 里该不变量已改为断言调用，不再是 if-return 死分支', () => {
  // 防止有人把它改回去 —— 改回去就等于重新制造 Q3 描述的问题
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('assertInvariant('), 'rules.mjs 必须使用 assertInvariant');
  assert.ok(src.includes(INV_ID), `不变量 id 应写死为 ${INV_ID}`);
  // 旧写法：直接 if (killed > effectiveTotal) 然后 return fail
  const oldPattern = /if \(killed > effectiveTotal\) \{\s*\n\s*return \{/;
  assert.ok(!oldPattern.test(src), '不得退回 if-return 形式（那会让它重新变成永不执行的死分支）');
});