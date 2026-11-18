/**
 * 外部实测报告（`G:\AMup`，2026-11-18）抓到的三处缺陷的回归。
 *
 * ★ 本文件的来源不是自举，是**第一份外部采纳报告**。三条都不是读代码读出来的，
 *   而是在 2.7 万文件、非 git、多副本的真实仓库上跑出来的。
 *
 * 三处：
 *   ① `ARCH-06` 假阳性 —— 模板插值闭合的 `}` 被当真实花括号输出，把循环体提前闭合。
 *      报告抓到 74 命中里 **17 处**可证假阳性（同一文件 17 份副本，每份 1 处）。
 *   ② `DISCIPLINE-C2` 假阴性 —— `.dsh-smoke-tmp` 未被抓（点号开头 + 后缀形态）。
 *   ③ `ARCH-07` 的 fail 文案缺分母 —— 与 `ARCH-06` 同一扫描集合，却只有一条能外部核对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unterminatedWhiles, maskCommentsAndStrings } from '../lib/arch.mjs';
import { isJunkDirName, RULES } from '../lib/rules.mjs';
import { readFileSync } from 'node:fs';

const BT = String.fromCharCode(96);
const DL = String.fromCharCode(36); // '$'

// ─────────────────────────────────────────────────────────────
// ① ARCH-06 假阳性：模板插值
// ─────────────────────────────────────────────────────────────

/** 把 expr 放进 `${expr}` 再嵌进 `while(true)`，后面跟一个真 break。 */
const inInterpolation = (expr) =>
  'while (true) {\n  const s = ' + BT + DL + '{' + expr + '}' + BT + '\n  if (k) break\n}\n';

test('★★★ 命脉：`${...}` 插值不得让后面的 break 消失（报告实测的假阳性根因）', () => {
  // 触发条件与"有没有除法"无关 —— 只要有插值就曾必假阳性。
  const exprs = ['x', 'a / b', 'Math.round(x)', 'Math.round(100 * a / b)', 'f(1 * a / b)'];
  for (const e of exprs) {
    const hits = unterminatedWhiles('t.mjs', inInterpolation(e));
    assert.deepEqual(hits, [], `插值 \`\${${e}}\` 后面有 break，不该报恒真循环：${JSON.stringify(hits)}`);
  }
});

test('★★★ 命脉：插值闭合的 `}` 不得被当成真实花括号（括号必须平衡）', () => {
  const code = inInterpolation('x');
  const masked = maskCommentsAndStrings(code);
  // 掩码与原文等长（既有约束）
  assert.equal(masked.length, code.length, '掩码必须与原文等长');
  // 关键：掩码里的 `{` 与 `}` 计数必须平衡 —— 否则循环体边界会被判错
  const opens = (masked.match(/\{/g) || []).length;
  const closes = (masked.match(/\}/g) || []).length;
  assert.equal(opens, closes, `掩码后花括号不平衡（{=${opens} }=${closes}）⇒ 循环体边界会判错`);
});

test('★★ 负控：插值内真无 break ⇒ 仍必须报出（不能为了消假阳性而变宽松）', () => {
  const code = 'while (true) {\n  const s = ' + BT + DL + '{x}' + BT + '\n  tick()\n}\n';
  const hits = unterminatedWhiles('t.mjs', code);
  assert.equal(hits.length, 1, `插值后没有 break，应当报出，实际 ${hits.length}`);
});

test('★ 负控：普通花括号代码块不受影响', () => {
  const code = 'while (true) {\n  const o = { a: 1 }\n  if (k) break\n}\n';
  assert.deepEqual(unterminatedWhiles('t.mjs', code), []);
});

// ─────────────────────────────────────────────────────────────
// ② DISCIPLINE-C2 假阴性
// ─────────────────────────────────────────────────────────────

test('★★ 命脉：`.dsh-smoke-tmp` 必须被抓（报告的正对照实测为漏）', () => {
  // 报告 §1.4 的正对照：前四种被抓、这一种漏。
  assert.equal(isJunkDirName('.dsh-smoke-tmp'), true, '点号开头 + -tmp 结尾，属临时产物');
});

test('★★ 点号前缀不得让原有形态失效（`.pip-x` / `.diag-12345`）', () => {
  for (const n of ['.pip-x', '.tmpabcde', '.cdp-profile-x', '.diag-12345']) {
    assert.equal(isJunkDirName(n), true, `点号前缀不该让 ${n} 逃过`);
  }
});

test('★★ 后缀形态必须覆盖（报告指出"去掉点号也不匹配任何前缀"）', () => {
  for (const n of ['smoke-tmp', 'work-temp', 'build-tmpdir', 'x.tmp']) {
    assert.equal(isJunkDirName(n), true, `${n} 是 -tmp/-temp 结尾，应被抓`);
  }
});

test('★ 负控：正常目录名不得误伤（不能为了抓临时名而变敏感）', () => {
  for (const n of ['normal-dir', 'temple', 'smoketmp', 'node_modules', 'src', 'lib', 'docs', 'templates']) {
    assert.equal(isJunkDirName(n), false, `${n} 是正常名字，不该被抓`);
  }
});

test('★ 负控：空名不抛错', () => {
  assert.equal(isJunkDirName(''), false);
  assert.equal(isJunkDirName('.'), false);
  assert.equal(isJunkDirName(null), false);
});

// ─────────────────────────────────────────────────────────────
// ③ ARCH-07 的 fail 文案必须带分母
// ─────────────────────────────────────────────────────────────

test('★★ 命脉：ARCH-07 的 fail 文案必须写出「实检 N 个文件」（报告卡在无法核分母）', () => {
  // 用源码断言而不是跑一遍：这条判据的 fail 分支需要真实空 catch 夹具，
  // 而改动的实质是**文案对称性** —— 直接查源码里那条 reason 模板最直接、最不脆。
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  const m = src.match(/reason: `\$\{bad\.length\} 处 catch 块体为空[^`]*`/);
  assert.ok(m, '找不到 ARCH-07 的 fail reason 模板（源码形态已变，需同步本条判据）');
  assert.match(m[0], /实检 \$\{stats\.scanned\.length\} 个文件/,
    `fail 文案必须带分母，实际: ${m[0]}`);
});

test('元判据：两条 ARCH 判据的 fail 文案都带分母（对称）', () => {
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  const arch06 = src.match(/reason: `\$\{bad\.length\} 处恒真循环[^`]*`/);
  assert.ok(arch06, 'ARCH-06 的 fail 模板找不到');
  assert.match(arch06[0], /实检 \$\{stats\.scanned\.length\} 个文件|实检 \$\{/, 'ARCH-06 应带分母');
  // 27 条规则表仍完整
  assert.equal(RULES.length, 27);
});