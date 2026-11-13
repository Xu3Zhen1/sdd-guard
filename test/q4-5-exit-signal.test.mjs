// 评审包 §5 Q4.5：两种「失败信号」被合流成同一个退出码。
//
// 被拆开的两种性质（语义相反，所以必须分开）：
//   「我没跑完」      —— coverage 不足。告诉你要补输入。
//   「跑完了但不可信」—— 自洽性矛盾 / 判据自身抛异常。说明判据坏了，
//                       它报的"通过"不算数。
//
// ★ 判据口径（2026-11-13 A14 修订）：
//   上一版有多条断言是**匹配 cli.mjs 源码文本形状**（`if (coverageFail) process.exit(...)`、
//   `process.exit(hardFail ? ...)`、两处 indexOf 的先后）。那些断言验证的是"代码长什么样"，
//   不是"行为对不对"——实测在把内联三元重构成可测函数时，语义完全没变却红了 5 条。
//   现在改成**直接调用真实现** `decideExit()`（cli.mjs 已加 isMain 闸，import 不执行 main），
//   断言的是行为：给定这些信号，退出码是多少。
//
// 保留一处源码级断言（顺序检查）——它锁的是"3 优先于 1"这条**结构约束**，
// 而该约束无法只靠 decideExit 的输入输出证明（优先级实现在返回值里，但仍需防止有人
// 把它改成先判 coverage 再判 untrusted 却恰好结果相同）。这条断言改为**行为化**的：
// 同时给 untrusted 与 coverageFail，必须得 3 且 signal=untrusted。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { EXIT, SIGNAL, summarize, runRules } from '../lib/runner.mjs';
import { decideExit } from '../cli.mjs';

/** 规格期望全部写死为字面量 —— 绝不引用被测对象的常量（否则改常量用例照样绿）。 */
const SPEC = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 3 };

/** 覆盖率判定：与 cli.mjs 同式（ratio < min ⇒ coverageFail）。 */
function coverageDecision(covered, machineTotal, min) {
  if (min === undefined) return false;
  const ratio = machineTotal > 0 ? covered / machineTotal : 0;
  return ratio < min;
}

function withTemp(fn) {
  const root = mkdtempSync(join(writableTempRoot(), 'q45-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('退出码常量：必须把「不可信/没跑完」与「判据判定不合格」分开', () => {
  // PIN 写死：这三个值一旦被改成相等，"分手"就退化回合流，本用例必须红。
  assert.equal(EXIT.OK, SPEC.OK);
  assert.equal(EXIT.FAIL, SPEC.FAIL);
  assert.equal(EXIT.CONFIG, SPEC.CONFIG);
  assert.equal(EXIT.INCOMPLETE, SPEC.INCOMPLETE, 'EXIT.INCOMPLETE 必须存在且为 3');
  const vals = [EXIT.OK, EXIT.FAIL, EXIT.CONFIG, EXIT.INCOMPLETE];
  assert.equal(new Set(vals).size, 4, '四个退出码必须互不相同');
});

test('正控：判据自身抛异常 ⇒ 标记为 untrusted 且退出码 3（不是 1）', () => {
  // 构造一个必抛的规则：它代表"判据坏了"，不是"被测对象不合格"
  const boom = {
    id: 'BOOM-1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '必然抛异常的假规则',
    run() {
      throw new Error('判据内部炸了');
    },
  };
  const ok = {
    id: 'OK-1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '必然通过的假规则',
    run() {
      return { status: 'pass' };
    },
  };
  return withTemp((root) => {
    const cd = join(root, 'changes', 'x');
    mkdirSync(cd, { recursive: true });
    const { results } = runRules({ changeDir: cd, repo: root, cwd: root, rules: [boom, ok] });
    const s = summarize(results);
    assert.equal(s.untrusted, 1, '必须识别出 1 条不可信');
    assert.deepEqual(s.untrustedIds, ['BOOM-1']);
    assert.equal(s.pass, 1, '另一条正常 pass 不应被吞');
    // 关键区别：抛异常的规则虽然 status 仍是 fail（保持向后兼容），
    // 但带上了 signal=untrusted，这才是分流的依据。
    const b = results.find((r) => r.id === 'BOOM-1');
    assert.equal(b.signal, SIGNAL.UNTRUSTED, '抛异常必须带 untrusted 标记');
    const o = results.find((r) => r.id === 'OK-1');
    assert.equal(o.signal, undefined, '正常规则不应被误标为 untrusted');
    // 行为断言：这样的 summary 必须退 3
    const d = decideExit({ summary: s, coverageFail: false, hardFail: false });
    assert.equal(d.exitCode, SPEC.INCOMPLETE, 'untrusted ⇒ 必须退 3');
    assert.equal(d.signal, SIGNAL.UNTRUSTED);
  });
});

test('负控：真正的 fail 不得被当成 untrusted（否则一切都会被升级成 3）', () => {
  const realFail = {
    id: 'REAL-1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '正常判定不合格',
    run() {
      return { status: 'fail', reason: '嵌套 4 > 3' };
    },
  };
  return withTemp((root) => {
    const cd = join(root, 'changes', 'x');
    mkdirSync(cd, { recursive: true });
    const { results } = runRules({ changeDir: cd, repo: root, cwd: root, rules: [realFail] });
    const s = summarize(results);
    assert.equal(s.fail, 1);
    assert.equal(s.untrusted, 0, '正常 fail 不应被算作 untrusted');
    assert.equal(results[0].signal, undefined);
    // 行为断言：真 fail + 无覆盖率问题 ⇒ 退 1，不是 3
    const d = decideExit({ summary: s, coverageFail: false, hardFail: true });
    assert.equal(d.exitCode, SPEC.FAIL, '真 fail ⇒ 必须退 1');
    assert.equal(d.signal, SIGNAL.FAIL);
  });
});

test('正控：覆盖率不足 ⇒ 退出码 3（INCOMPLETE），而非 1', () => {
  // 空 change 目录实测覆盖率 1/17 = 0.06
  assert.equal(coverageDecision(1, 17, 0.9), true, '0.06 < 0.9 应判定覆盖率不足');
  const d = decideExit({ summary: { untrusted: 0 }, coverageFail: true, hardFail: false });
  assert.equal(d.exitCode, SPEC.INCOMPLETE, 'coverageFail 必须退出 3');
  assert.notEqual(d.exitCode, SPEC.FAIL, '不得退回 1');
  assert.equal(d.signal, SIGNAL.INCOMPLETE);
});

test('负控：不设 --min-coverage ⇒ 覆盖率不参与退出码（不得擅自升级）', () => {
  assert.equal(coverageDecision(1, 17, undefined), false, '缺省不下限');
  const d = decideExit({ summary: { untrusted: 0 }, coverageFail: false, hardFail: false });
  assert.equal(d.exitCode, SPEC.OK, '无 fail、无覆盖率问题 ⇒ 退 0');
  assert.equal(d.signal, 'ok');
});

test('负控：--min-coverage 0 显式关闭 ⇒ 放行（§5 Q4.6 的显式选择）', () => {
  // 0 = 显式值，表示"不要求覆盖"；这与"没设"在语义上不同，但结果都是放行。
  assert.equal(coverageDecision(0, 17, 0), false, '0/17=0 >= 0 成立');
  const d = decideExit({ summary: { untrusted: 0 }, coverageFail: false, hardFail: false });
  assert.equal(d.exitCode, SPEC.OK);
});

test('优先级：untrusted 必须压过 coverageFail 与 hardFail（同时出现时退 3 且 signal=untrusted）', () => {
  // 这条是**行为化**的优先级断言：三个信号同时给，必须得 3、且 signal 指明是 untrusted。
  // 它替代了原来两条"比较两处 indexOf 先后"的源码文本断言——
  // 那种断言锁的是代码排版，不是行为；实测重构实现时语义不变却会假红。
  const d = decideExit({ summary: { untrusted: 2 }, coverageFail: true, hardFail: true });
  assert.equal(d.exitCode, SPEC.INCOMPLETE, '三种信号同时出现时必须退 3');
  assert.equal(d.signal, SIGNAL.UNTRUSTED, 'signal 必须指明根因是 untrusted，而不是 incomplete');
});

test('优先级：coverageFail 必须压过 hardFail（覆盖率不足时报"没跑完"而不是"不合格"）', () => {
  const d = decideExit({ summary: { untrusted: 0 }, coverageFail: true, hardFail: true });
  assert.equal(d.exitCode, SPEC.INCOMPLETE, '覆盖率不足 + 有 fail ⇒ 退 3（没跑完优先）');
  assert.equal(d.signal, SIGNAL.INCOMPLETE);
});
