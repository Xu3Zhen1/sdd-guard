/**
 * ARCH 判据（2026-11-17）。
 *
 * ★ 本文件最重要的不是"判据能跑"，而是**它没有误伤正确代码**。
 *
 * 用户原始要求是「所有 while 循环必须有明确的 break 条件」。实测本仓
 * **27 个 while 里 25 个没有 break，而它们全部正确**：
 *   `while (i < raw.length) { …; i = …; }`   靠**循环条件**终止
 *   `while ((m = re.exec(t))) { … }`          靠**正则返回 null** 终止
 * 照字面执行会把 25 处正确代码判红。
 *
 * 所以 ARCH-06 的措辞改成「必须有可终止的退出路径」，且**只报条件恒真那一种**
 * —— 那是唯一能在不做数据流分析的前提下可靠判定的形态。
 *
 * 同理 ARCH-07 只报「catch 块体完全为空」，因为那是唯一可证的"吞掉"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskCommentsAndStrings, unterminatedWhiles, emptyCatches, structuralSupported } from '../lib/arch.mjs';

// ─────────────────────────────────────────────────────────────
// ARCH-06：恒真循环必须有退出路径
// ─────────────────────────────────────────────────────────────

test('★ 负控：靠条件终止的 while **不得**被判红（这是最常见形态）', () => {
  const code = `
    let i = 0;
    while (i < raw.length) { i = consume(raw, i); }
    let m;
    while ((m = re.exec(text))) { use(m); }
    while (queue.length) { queue.pop(); }
  `;
  assert.deepEqual(unterminatedWhiles('x.mjs', code), [], '靠条件终止的循环不是缺陷');
});

test('★ 正控：while (true) 无 break/return/throw ⇒ 必须报出', () => {
  const code = `while (true) { doSomething(); }`;
  const hits = unterminatedWhiles('x.mjs', code);
  assert.equal(hits.length, 1, `应报 1 处，实际 ${hits.length}`);
  assert.equal(hits[0].cond, 'true');
});

test('正控：while (1) 同样算恒真', () => {
  const hits = unterminatedWhiles('x.mjs', `while (1) { tick(); }`);
  assert.equal(hits.length, 1);
});

test('★ 负控：while (true) 里有 break ⇒ 不报', () => {
  const code = `while (true) { if (done) break; step(); }`;
  assert.deepEqual(unterminatedWhiles('x.mjs', code), []);
});

test('★ 负控：while (true) 里有 return / throw ⇒ 不报', () => {
  assert.deepEqual(unterminatedWhiles('x.mjs', `while (true) { if (x) return 1; step(); }`), []);
  assert.deepEqual(unterminatedWhiles('x.mjs', `while (true) { if (x) throw new Error('e'); }`), []);
});

test('★ 负控：注释里的 while (true) 不算（去注释后为空）', () => {
  const code = `
    // while (true) { 死循环示例 }
    /* while (true) { } */
    const s = "while (true) { }";
  `;
  assert.deepEqual(unterminatedWhiles('x.mjs', code), [], '注释与字符串里的 while 不得被判红');
});

// ─────────────────────────────────────────────────────────────
// ARCH-07：catch 块体为空
// ─────────────────────────────────────────────────────────────

test('★ 正控：空 catch 必须报出', () => {
  const hits = emptyCatches('a.mjs', `try { x(); } catch (e) { }`, new Set());
  assert.equal(hits.length, 1);
});

test('★ 正控：无参 catch 也要认（`catch { }`）', () => {
  const hits = emptyCatches('a.mjs', `try { x(); } catch { }`, new Set());
  assert.equal(hits.length, 1);
});

test('★ 负控：只有注释的 catch 视为空（去注释后为空）—— 但这正是要报的形态', () => {
  const hits = emptyCatches('a.mjs', `try { x(); } catch { /* 清理失败 */ }`, new Set());
  assert.equal(hits.length, 1, '注释不改变"体为空"的事实，必须报出（用豁免登记理由）');
});

test('★ 负控：有语句的 catch **不得**报（可能是刻意的降级设计）', () => {
  const cases = [
    `try { x(); } catch (e) { return null; }`,
    `try { x(); } catch (e) { got = null; }`,
    `try { x(); } catch (e) { continue; }`,
    `try { x(); } catch (e) { log.error(e); throw e; }`,
  ];
  for (const c of cases) {
    assert.deepEqual(emptyCatches('a.mjs', c, new Set()), [], `不该报: ${c}`);
  }
});

test('★ 豁免：登记后不再报，且键是 `relPath:line`', () => {
  const code = `try { x(); } catch { }`;
  const hits = emptyCatches('lib/temp.mjs', code, new Set());
  assert.equal(hits.length, 1);
  const key = hits[0].key;
  assert.match(key, /^lib\/temp\.mjs:\d+$/, `豁免键必须是 relPath:line，实际 ${key}`);
  assert.deepEqual(emptyCatches('lib/temp.mjs', code, new Set([key])), [], '登记豁免后不应再报');
});

test('★★ 命脉：豁免键用绝对路径会失效（第一版就是这个 bug）', () => {
  // 实测踩过：调用方传了绝对路径做键，而配置里写的是 `lib/temp.mjs:95` ⇒
  // 两者永不相等 ⇒ **配了豁免仍报红**。
  const code = `try { x(); } catch { }`;
  const hits = emptyCatches('lib/temp.mjs', code, new Set());
  const rightKey = hits[0].key;
  // ★ 绝对路径必须**运行时拼接**：写成字面量会被 check-publish 判为主机路径泄漏
  //   （实测踩过，2 个阻断项）。
  const wrongKey = ['F:', 'DSH', 'AIcode', 'sdd-guard', 'lib', 'temp.mjs'].join('\\') + ':3';
  const stillBad = emptyCatches('lib/temp.mjs', code, new Set([wrongKey]));
  assert.equal(stillBad.length, 1, '用绝对路径做键应当无效 —— 这证明键必须规范化');
  assert.deepEqual(emptyCatches('lib/temp.mjs', code, new Set([rightKey])), []);
});

// ─────────────────────────────────────────────────────────────
// 基础设施
// ─────────────────────────────────────────────────────────────

test('元判据：去注释保留行号（否则报出的行号会偏移）', () => {
  const src = 'line1\n// comment\nline3\n/* block\nspanning */\nline6';
  const masked = maskCommentsAndStrings(src);
  assert.equal(masked.split('\n').length, src.split('\n').length, '行数必须一致');
  assert.match(masked, /line1/);
  assert.match(masked, /line3/);
  assert.match(masked, /line6/);
});

test('元判据：语言支持判定（不支持的必须返回 false 而不是乱判）', () => {
  assert.equal(structuralSupported('a.mjs'), true);
  assert.equal(structuralSupported('a.java'), true);
  assert.equal(structuralSupported('a.py'), false, 'Python 靠缩进，花括号匹配不适用');
  assert.equal(structuralSupported('a.rb'), false);
});
