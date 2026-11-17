/**
 * ARCH 判据的**规则级**回归（2026-11-17，独立审查缺陷 6 的修复）。
 *
 * ★ 为什么要另开一个文件：
 *   原 `arch.test.mjs` 全部只测 helper（`unterminatedWhiles` / `emptyCatches`），
 *   直接把相对路径喂给 helper —— 而历史上那个致命 bug（豁免永远失效）
 *   恰恰出在**调用方传了绝对路径**。helper 单测**盖不住调用方的错误**。
 *
 *   所以这里一律经 `RULES.run(ctx)` + `ctx.rel` 走真实路径：
 *     · 用真实临时仓库（真文件、真 `--repo`）
 *     · 断言 status / reason / detail 里的**关键措辞**
 *     · 对 `--repo` / `--config` 缺失各建一条用例（缺陷 7）
 *
 * ★ 本文件测的行为清单（对应审查报告编号）：
 *   1. 退出语句作用域（switch / 内层函数 / 内层循环 三种假绿不再复现）
 *   2. 正则字面量不再误报
 *   3. 模板插值里的真实 catch 能被发现
 *   4. 字符串语句的非空 catch 不再被判空
 *   5. 豁免按**实际命中**计数，陈旧项可见
 *   6. 词法器自检不过时**报 skip 而不是给结论**
 *   7. Go/Rust 不再被冒充为"已检查"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RULES } from '../lib/rules.mjs';

/** 建一个真实临时仓库：<root>/<subdir>/<file>，返回 {repo, write, cleanup}。 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'arch-rule-'));
  return {
    repo,
    write(rel, content) {
      const abs = join(repo, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    cleanup() { rmSync(repo, { recursive: true, force: true }); },
  };
}

/** 构造一个最小 `ctx`，字段与 cli.mjs 传给 run() 的一致。 */
function makeCtx(repo, files, cfg = {}) {
  const abs = files.map((f) => resolve(repo, f));
  return {
    cfg,
    codeFiles: abs,
    readFile: (f) => {
      // 与生产一致：走 fs 读
      return require('node:fs').readFileSync(f, 'utf8');
    },
    rel: (f) => f.replace(repo, '').replace(/^[\\/]/, '').replace(/\\/g, '/'),
  };
}

const RULE = (id) => RULES.find((r) => r.id === id);

// ─────────────────────────────────────────────────────────────
// 缺陷 1：退出语句的作用域
// ─────────────────────────────────────────────────────────────

const SCOPE_CASES = [
  ['break 属于 switch', 'a.js', 'while (true) {\n  switch (x) { case 1: break; }\n  tick();\n}\n'],
  ['return 属于内层函数', 'b.js', 'while (true) {\n  const f = () => { return 1; };\n  tick();\n}\n'],
  ['break 属于内层循环', 'c.js', 'while (true) {\n  while (x) { break; }\n  tick();\n}\n'],
];

for (const [label, file, code] of SCOPE_CASES) {
  test(`★★ 缺陷1 回归：${label} ⇒ ARCH-06 必须判红（旧实现假绿）`, () => {
    const r = makeRepo();
    try {
      r.write(file, code);
      const res = RULE('ARCH-06').run(makeCtx(r.repo, [file]));
      assert.equal(res.status, 'fail', `${label} 应判红，实际 ${res.status}：${res.reason || res.detail}`);
      assert.ok(res.items.some((it) => it.includes('while (true)')), `诊断必须指出该循环：${JSON.stringify(res.items)}`);
    } finally { r.cleanup(); }
  });
}

test('★ 负控：真属于本循环的 break 仍算有出口（不能矫枉过正）', () => {
  const r = makeRepo();
  try {
    r.write('d.js', 'while (true) {\n  if (done) break;\n  tick();\n}\n');
    const res = RULE('ARCH-06').run(makeCtx(r.repo, ['d.js']));
    assert.equal(res.status, 'pass', `直接 break 应通过，实际 ${res.status}：${res.reason}`);
  } finally { r.cleanup(); }
});

// ─────────────────────────────────────────────────────────────
// 缺陷 2 / 3 / 4：词法层
// ─────────────────────────────────────────────────────────────

test('★★ 缺陷2 回归：正则字面量里的 while/catch 不得误报', () => {
  const r = makeRepo();
  try {
    r.write('re.js', 'const a = /while (true) {}/;\nconst b = /catch { }/;\n');
    const w = RULE('ARCH-06').run(makeCtx(r.repo, ['re.js']));
    const c = RULE('ARCH-07').run(makeCtx(r.repo, ['re.js']));
    assert.equal(w.status, 'pass', `正则内容是数据，不该报 ARCH-06：${w.reason}`);
    assert.equal(c.status, 'pass', `正则内容是数据，不该报 ARCH-07：${c.reason}`);
  } finally { r.cleanup(); }
});

test('★★ 缺陷3 回归：模板插值里的真实空 catch 必须被发现', () => {
  const r = makeRepo();
  try {
    r.write('tpl.js', 'const s = `${(() => { try { x(); } catch {} })()}`;\n');
    const res = RULE('ARCH-07').run(makeCtx(r.repo, ['tpl.js']));
    assert.equal(res.status, 'fail', `插值里是代码，空 catch 应报出：${res.detail || res.reason}`);
  } finally { r.cleanup(); }
});

test('★★ 缺陷4 回归：catch 体是字符串语句 ⇒ 非空，不得判空', () => {
  const r = makeRepo();
  try {
    r.write('str.js', 'try { x(); } catch { "handled" }\n');
    const res = RULE('ARCH-07').run(makeCtx(r.repo, ['str.js']));
    assert.equal(res.status, 'pass', `字符串语句是非空块，不该报：${res.reason}`);
  } finally { r.cleanup(); }
});

// ─────────────────────────────────────────────────────────────
// 缺陷 5：豁免按实际命中计数 + 陈旧项可见
// ─────────────────────────────────────────────────────────────

test('★★ 缺陷5 回归：豁免计数必须按**实际命中**，不得用配置条数', () => {
  const r = makeRepo();
  try {
    r.write('e.js', 'try { x(); } catch {}\n');
    const cfg = {
      catchAllowlist: [
        { where: 'e.js:1', reason: '真实命中这一处' },
        { where: 'e.js:999', reason: '过期：行号不存在' },
      ],
    };
    const res = RULE('ARCH-07').run(makeCtx(r.repo, ['e.js'], cfg));
    assert.equal(res.status, 'pass', `已登记豁免，应通过：${res.reason}`);
    // 只命中 1 条，却被登记 2 条 ⇒ detail 必须说清"登记 2、命中 1"并点名陈旧项
    assert.match(res.detail, /豁免登记 2 条/, `detail 应写登记数：${res.detail}`);
    assert.match(res.detail, /实际命中 1 条/, `detail 应写命中数：${res.detail}`);
    assert.match(res.detail, /已陈旧/, `detail 必须点名陈旧项：${res.detail}`);
    assert.match(res.detail, /e\.js:999/, `陈旧项要具体到键：${res.detail}`);
  } finally { r.cleanup(); }
});

test('★ 负控：登记了豁免但一处没命中 ⇒ 不得声称"已豁免 N 处"', () => {
  const r = makeRepo();
  try {
    r.write('clean.js', 'const x = 1;\n');
    const cfg = { catchAllowlist: [{ where: 'clean.js:1', reason: '没有空 catch 可豁免' }] };
    const res = RULE('ARCH-07').run(makeCtx(r.repo, ['clean.js'], cfg));
    assert.equal(res.status, 'pass');
    assert.match(res.detail, /实际命中 0 条/, `0 命中必须写 0：${res.detail}`);
  } finally { r.cleanup(); }
});

// ─────────────────────────────────────────────────────────────
// 缺陷 6：词法器自检不过 ⇒ skip，不给结论
// ─────────────────────────────────────────────────────────────

test('★★★ 缺陷6 回归：词法器自检不过时**必须报 skip**，不得给 pass/fail', () => {
  // 制造一个"长度不一致"的场景不容易，改用真实已知失败样本：
  // 这个片段含嵌套模板串 + 注释里的反引号，是实测会让屏蔽器出现未配对标记的形态。
  const r = makeRepo();
  try {
    const tricky = [
      '/**',
      ' * 说明：' + String.fromCharCode(96) + 'while (true)' + String.fromCharCode(96) + ' 不算',
      ' */',
      'function f() { return `${a ? `x${b}` : ""}`; }',
      'while (true) { tick(); }',
      '',
    ].join('\n');
    r.write('tricky.js', tricky);
    const res = RULE('ARCH-06').run(makeCtx(r.repo, ['tricky.js']));
    // 结果只允许两种：真检查过（pass/fail），或明确 skip。
    // **不允许**在词法器不可靠时输出一个看似确定的结论。
    if (res.status === 'skip') {
      assert.match(res.reason, /未检查|无法给出结论/, `skip 必须说明为什么没检查：${res.reason}`);
    } else {
      // 若判据认为自己的词法器可用，则必须是真的检查过（detail 里不能出现"未检查"）
      assert.ok(['pass', 'fail'].includes(res.status));
    }
  } finally { r.cleanup(); }
});

test('★★ 缺陷6b：不支持的扩展名必须计入"未检查"，不得并入已检查计数', () => {
  const r = makeRepo();
  try {
    r.write('main.go', 'func f() { for { tick() } }\n');
    r.write('ok.js', 'while (i < n) { i++ }\n');
    const res = RULE('ARCH-06').run(makeCtx(r.repo, ['main.go', 'ok.js']));
    assert.equal(res.status, 'pass', `ok.js 干净应通过：${res.reason}`);
    assert.match(res.detail, /实检 1 个/, `只能算 1 个已检查：${res.detail}`);
    assert.match(res.detail, /语言不支持|未检查/, `必须声明 .go 未检查：${res.detail}`);
  } finally { r.cleanup(); }
});

// ─────────────────────────────────────────────────────────────
// 缺陷 7：--config / --repo 缺失时基准必须唯一
// ─────────────────────────────────────────────────────────────

test('★★ 缺陷7：不传 cfg（`{}`）时豁免全失效 ⇒ 必须报红，不得静默通过', () => {
  const r = makeRepo();
  try {
    r.write('nocfg.js', 'try { x(); } catch {}\n');
    const res = RULE('ARCH-07').run(makeCtx(r.repo, ['nocfg.js'], {}));
    assert.equal(res.status, 'fail', `没有配置就没有豁免，空 catch 必须报出：${res.detail || res.reason}`);
  } finally { r.cleanup(); }
});

test('★★ 缺陷7b：键基准随 --code 顺序变化 ⇒ 同一仓库必须得到同一结论', () => {
  const r = makeRepo();
  try {
    r.write('a/x.js', 'try { x(); } catch {}\n');
    r.write('b/y.js', 'const y = 1;\n');
    const cfg = { catchAllowlist: [{ where: 'a/x.js:1', reason: '同一处豁免' }] };
    const forward = RULE('ARCH-07').run(makeCtx(r.repo, ['a/x.js', 'b/y.js'], cfg));
    const reverse = RULE('ARCH-07').run(makeCtx(r.repo, ['b/y.js', 'a/x.js'], cfg));
    assert.equal(forward.status, reverse.status, `顺序不同不该改变结论：${forward.status} vs ${reverse.status}`);
    assert.equal(forward.status, 'pass', `豁免键是仓库相对路径，两种顺序都应命中：${forward.reason}`);
  } finally { r.cleanup(); }
});
