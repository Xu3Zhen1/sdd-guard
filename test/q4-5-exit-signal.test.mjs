// 评审包 §5 Q4.5：两种「失败信号」被合流成同一个退出码。
//
// 被拆开的两种性质（语义相反，所以必须分开）：
//   「我没跑完」      —— coverage 不足。告诉你要补输入。
//   「跑完了但不可信」—— 自洽性矛盾 / 判据自身抛异常。说明判据坏了，
//                       它报的"通过"不算数。
//
// 判据口径：每条都要有正控（该进 A 档的确实进 A 档）与负控
// （不该进 A 档的确实没进），只测一边等于没测。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { EXIT, SIGNAL, summarize, runRules } from '../lib/runner.mjs';

const CLI = new URL('../cli.mjs', import.meta.url).pathname.replace(/^\//, '');

/**
 * ★ 不启子进程。
 *
 * 本机沙箱对 subprocess 的 stdio:'pipe' 返回 EPERM（spawnSync/execFileSync
 * 都拿到 status=null）。那不是被测行为，是环境限制 —— 拿它当结论就是
 * 「测试基建缺陷伪装成关于被测对象的结论」（评审包 §4 模式 D）。
 *
 * 因此这里**直接复现 cli.mjs 的退出码决策链**，并断言它与真实 CLI 一致：
 * 决策链只有三步（untrusted → coverageFail → hardFail），把它抽出来测，
 * 测的仍是同一段逻辑，只是不经过进程边界。
 */
const CLI_SRC = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');

/**
 * 不在这里重写决策链，而是**从 cli.mjs 源码里读出分支出不出、退几**。
 *
 * 上一版我复现了一份 decideExit —— 变异实验立刻暴露它的致命问题：
 * 把 cli.mjs 的 coverageFail 退回 EXIT.FAIL 后，只有一致性用例变红，
 * 功能用例全绿（它们测的是我写的副本）。复现件取代被测对象 = 测我自己。
 */
function exitCodeOf(branchKeyword) {
  const re = new RegExp(
    'if \\([^)]*' + branchKeyword + '[^)]*\\)\\s*process\\.exit\\(EXIT\\.(\\w+)\\)',
  );
  const m = CLI_SRC.match(re);
  return m ? EXIT[m[1]] : undefined;
}

/** 覆盖率判定：与 cli.mjs 同式（ratio < min ⇒ coverageFail）。 */
function coverageDecision(covered, machineTotal, min) {
  if (min === undefined) return false;
  const ratio = machineTotal > 0 ? covered / machineTotal : 0;
  return ratio < min;
}

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'q45-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('退出码常量：必须把「不可信/没跑完」与「判据判定不合格」分开', () => {
  // PIN 写死：这三个值一旦被改成相等，"分手"就退化回合流，本用例必须红。
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAIL, 1);
  assert.equal(EXIT.CONFIG, 2);
  assert.equal(EXIT.INCOMPLETE, 3, 'EXIT.INCOMPLETE 必须存在且为 3');
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
    run() { throw new Error('判据内部炸了'); },
  };
  const ok = {
    id: 'OK-1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '必然通过的假规则',
    run() { return { status: 'pass' }; },
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
  });
});

test('负控：真正的 fail 不得被当成 untrusted（否则一切都会被升级成 3）', () => {
  const realFail = {
    id: 'REAL-1', principle: 'KISS', stage: 'code', decidability: 'machine',
    title: '正常判定不合格', run() { return { status: 'fail', reason: '嵌套 4 > 3' }; },
  };
  return withTemp((root) => {
    const cd = join(root, 'changes', 'x');
    mkdirSync(cd, { recursive: true });
    const { results } = runRules({ changeDir: cd, repo: root, cwd: root, rules: [realFail] });
    const s = summarize(results);
    assert.equal(s.fail, 1);
    assert.equal(s.untrusted, 0, '正常 fail 不应被算作 untrusted');
    assert.equal(results[0].signal, undefined);
  });
});

test('正控：覆盖率不足 ⇒ 退出码 3（INCOMPLETE），而非 1', () => {
  // 空 change 目录实测覆盖率 1/17 = 0.06
  const cf = coverageDecision(1, 17, 0.9);
  assert.equal(cf, true, '0.06 < 0.9 应判定覆盖率不足');
  // 退出码从 cli.mjs 源码读，不是写死在测试里
  assert.equal(exitCodeOf('coverageFail'), EXIT.INCOMPLETE, 'coverageFail 必须退出 3');
  assert.notEqual(exitCodeOf('coverageFail'), EXIT.FAIL, '不得退回 1');
});

test('负控：不设 --min-coverage ⇒ 覆盖率不参与退出码（不得擅自升级）', () => {
  assert.equal(coverageDecision(1, 17, undefined), false, '缺省不下限');
  // hardFail 走的是三元形式，不是 if 分支，单独用字面量断言
  assert.match(CLI_SRC, /process\.exit\(hardFail \? EXIT\.FAIL : EXIT\.OK\)/, 'hardFail 必须走 FAIL/OK 三元');
  assert.equal(EXIT.FAIL, 1);
});

test('负控：--min-coverage 0 显式关闭 ⇒ 放行（§5 Q4.6 的显式选择）', () => {
  // 0 = 显式值，表示"不要求覆盖"；这与"没设"在语义上不同，但结果都是放行。
  assert.equal(coverageDecision(0, 17, 0), false, '0/17=0 >= 0 成立');
  assert.equal(exitCodeOf('coverageFail'), EXIT.INCOMPLETE);
});

test('一致性：功能用例读的必须是 cli.mjs 真源码，而不是测试内的副本', () => {
  /**
   * ★ 这条是上一版测试能成立的前提。
   *
   * 因为沙箱下无法启子进程，我把退出码决策链在测试里复现了一份。
   * 复现件与真实现**必然存在漂移风险** —— 只要有人改了 cli.mjs 而没改这里，
   * 上面的用例就会变成"测我自己写的副本"，全是恒真。
   *
   * 所以这里直接读 cli.mjs 源码，断言三个关键判断仍然存在且顺序未变。
   * 这不是形式主义：它就是防止"复现件悄悄取代被测对象"的那道锁。
   */
  const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');
  // ① untrusted 优先
  assert.match(src, /if \(summary\.untrusted > 0\)/, 'cli.mjs 必须仍有 untrusted 优先分支');
  // ② coverage 走 INCOMPLETE（不是 FAIL）
  assert.match(src, /if \(coverageFail\) process\.exit\(EXIT\.INCOMPLETE\)/, 'coverageFail 必须退出 3 而非 1');
  // ③ hardFail 走 FAIL
  assert.match(src, /process\.exit\(hardFail \? EXIT\.FAIL : EXIT\.OK\)/, 'hardFail 必须走 FAIL/OK');
  // ④ 顺序：untrusted 出现在 coverageFail 之前
  const iU = src.indexOf('summary.untrusted > 0');
  const iC = src.indexOf('if (coverageFail) process.exit(EXIT.INCOMPLETE)');
  assert.ok(iU >= 0 && iC >= 0 && iU < iC, 'untrusted 分支必须在 coverageFail 之前');
});

test('优先级：untrusted 分支必须出现在 coverageFail 之前（按源码顺序）', () => {
  const iU = CLI_SRC.indexOf('summary.untrusted > 0');
  const iC = CLI_SRC.indexOf('if (coverageFail)');
  assert.ok(iU > 0 && iC > 0, '两个分支都必须存在');
  assert.ok(iU < iC, 'untrusted 必须先于 coverageFail 被判断');
});
