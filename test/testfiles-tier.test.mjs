/**
 * 测试文件单独分档（2026-11-16，第 ⑥ 位）。
 *
 * ★ 这是**新功能**，不是修缺陷。它不改变任何既有结论（默认 `testNesting = maxNesting`）。
 *
 * 动机（实测）：Java 仓 `KISS-C1` 共 211 处，`CoreSelfTest.java` **一个文件占 83 处（39%）、
 * max=7**。它是 10995 行的零依赖自测脚本、`main()` 里顺序断言、天然深嵌套。
 * 若按"绝对处数"设阈值，**测试文件会把生产代码的信号淹掉**。
 *
 * ★ 本文件的核心难点：**"哪个文件算测试"是判断，不是事实。**
 *   所以测试必须同时钉住三件事：
 *     ① 内置规则能认出各语言的常见约定；
 *     ② **不能误判生产代码**（误判会让你少看真问题）—— 这是最重要的负控；
 *     ③ 用户覆盖能救例外，且非法覆盖被拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTest } from '../lib/testfiles.mjs';

// ─────────────────────────────────────────────────────────────
// 1. 正控：各语言常见约定都要认出来
// ─────────────────────────────────────────────────────────────

test('目录段约定：test/ tests/ __tests__/ 等都算测试', () => {
  const cases = [
    'src/test/java/CoreSelfTest.java',
    'test/guard.test.mjs',
    'tests/test_generator.py',
    'src/__tests__/foo.js',
    'spec/models/user_spec.rb',
  ];
  for (const rel of cases) {
    const r = classifyTest('/x/' + rel, rel);
    assert.ok(r.isTest, `应判为测试: ${rel}（实际 why=${JSON.stringify(r.why)}）`);
  }
});

test('文件名约定：*.test.ts / test_*.py / *_test.go / *Test.java 等', () => {
  const cases = [
    'src/foo.test.ts',
    'src/foo.spec.ts',
    'pkg/test_helpers.py',
    'internal/store_test.go',
    'src/main/java/com/x/OrderTest.java',
    'src/main/java/com/x/OrderTests.java',
  ];
  for (const rel of cases) {
    const r = classifyTest('/x/' + rel, rel);
    assert.ok(r.isTest, `应判为测试: ${rel}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 负控：生产代码绝不能被误判（最重要）
// ─────────────────────────────────────────────────────────────

test('★ 负控：普通生产源码不算测试', () => {
  const cases = [
    'lib/code.mjs',
    'src/main/java/dev/autobuild/core/BuildPlan.java',
    'eda_skill/admission.py',
    'core/src/main/java/com/x/Service.java',
    'cli.mjs',
  ];
  for (const rel of cases) {
    const r = classifyTest('/x/' + rel, rel);
    assert.equal(r.isTest, false, `不该判为测试: ${rel}（why=${r.why}）`);
  }
});

test('★ 负控：名字里含 test 但不是测试目录/约定的，不算（避免模糊匹配误伤）', () => {
  const cases = [
    'mytest/foo.js', // 目录叫 mytest ≠ test
    'lib/mytest/foo.js',
    'src/testing.js', // 文件名 testing ≠ test
    'src/contest.ts', // 含 test 子串
    'src/latest.py',
    'src/attestation.go',
  ];
  for (const rel of cases) {
    const r = classifyTest('/x/' + rel, rel);
    assert.equal(r.isTest, false, `不该因"含 test 子串"就判成测试: ${rel}`);
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 用户覆盖
// ─────────────────────────────────────────────────────────────

test('★ 覆盖：`+前缀` 能把生产文件强制算测试', () => {
  const rel = 'src/main/java/com/x/BuildPlan.java';
  const r = classifyTest('/x/' + rel, rel, ['+src/main/java/com/x/BuildPlan.java']);
  assert.equal(r.isTest, true, '覆盖应生效');
  assert.match(r.why, /用户覆盖/, 'why 必须说明是"用户覆盖"而不是内置规则');
});

test('★ 覆盖：`-前缀` 能把测试文件强制排除（规则一定有例外）', () => {
  const rel = 'tests/fixtures/generated/helper.js';
  const r = classifyTest('/x/' + rel, rel, ['-tests/fixtures/']);
  assert.equal(r.isTest, false, '负向覆盖应生效');
  assert.match(r.why, /强制不算/, 'why 必须说明是强制排除');
});

test('★ 覆盖优先于内置规则（同一文件既命中目录又命中覆盖时听覆盖的）', () => {
  const rel = 'tests/foo.test.js';
  // 内置会判成测试；`-tests/` 应该压过它
  const r = classifyTest('/x/' + rel, rel, ['-tests/']);
  assert.equal(r.isTest, false, '覆盖必须优先于内置规则');
});

test('★ 负控：非法覆盖条目被忽略而不是抛错（防止一处笔误让整个检查崩）', () => {
  const rel = 'src/foo.js';
  for (const bad of [null, '', '+', '-', 'no-sign-prefix', 42]) {
    const r = classifyTest('/x/' + rel, rel, [bad]);
    assert.equal(r.isTest, false, `非法覆盖 ${JSON.stringify(bad)} 应被忽略`);
  }
});

// ─────────────────────────────────────────────────────────────
// 4. 元判据：判定必须可解释
// ─────────────────────────────────────────────────────────────

test('元判据：判为测试时必须给出非空 why（"凭什么说它是测试"）', () => {
  const rel = 'src/foo.test.ts';
  const r = classifyTest('/x/' + rel, rel);
  assert.ok(r.isTest);
  assert.ok(r.why && r.why.length > 0, 'why 不能为空 —— 报告里要能写清依据');
});

test('元判据：判定与路径分隔符无关（Windows 反斜杠也要认）', () => {
  const win = 'src\\test\\java\\FooTest.java';
  const posix = 'src/test/java/FooTest.java';
  const a = classifyTest('X:\\r\\' + win, win);
  const b = classifyTest('/x/' + posix, posix);
  assert.equal(a.isTest, true, 'Windows 分隔符也要认出来');
  assert.equal(a.isTest, b.isTest, '两种分隔符判定必须一致');
});
