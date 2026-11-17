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

/**
 * ★ 2026-11-18 改：豁免不再在 `emptyCatches` 内部过滤。
 *
 * 旧测试断言 `emptyCatches(rel, code, new Set([key]))` 返回空 —— 那是
 * 「扫描器做过滤」的旧结构。现在职责分开（扫描器只负责**找**，
 * `rules.mjs` 负责**判**），所以这里改为断言**扫描器返回带锚点的全部命中**，
 * 而"豁免是否生效"由 `test/exempt-anchor.test.mjs` 与
 * `test/arch-rules.test.mjs` 经 `RULES.run` 真实路径验证。
 *
 * 保留本条的意义：**证明扫描器不再吞掉任何命中**。
 * 若它还做过滤，"谁被豁免了"就藏进扫描器，无法审计。
 */
test('★ 扫描器不做豁免过滤：永远返回全部命中（含锚点）', () => {
  const code = `try { x(); } catch { }`;
  const hits = emptyCatches('lib/temp.mjs', code);
  assert.equal(hits.length, 1, '扫描器必须如实返回命中，不得因豁免而少报');
  const h = hits[0];
  assert.match(h.key, /^lib\/temp\.mjs:\d+$/, `key 应是 relPath:line（仅供人读），实际 ${h.key}`);
  assert.equal(typeof h.snippet, 'string', '必须带内容锚点 snippet');
  assert.match(h.snippet, /catch \{ \}/, `锚点应包含 catch 块，实际 ${JSON.stringify(h.snippet)}`);
});

test('★★ 命脉：锚点里**不含行号信息**（否则改行就失效）', () => {
  // 这是本轮的核心回归：旧机制以 `relPath:line` 作唯一身份，
  // 文件靠前处加代码后 `:239`→`:240`，全部豁免静默失效。
  // 现在 snippet 必须是纯代码文本 —— 前插 50 行不该改变它。
  const code = `try { x(); } catch { }`;
  const shifted = Array.from({ length: 50 }, (_, i) => `// f${i}`).join('\n') + '\n' + code;
  const a = emptyCatches('lib/temp.mjs', code)[0].snippet;
  const b = emptyCatches('lib/temp.mjs', shifted)[0].snippet;
  assert.equal(b, a, '前插 50 行后锚点必须一模一样');
  // 而行号确实变了 —— 证明上一条不是"因为文件没动"而碰巧相等
  assert.equal(emptyCatches('lib/temp.mjs', shifted)[0].line,
    emptyCatches('lib/temp.mjs', code)[0].line + 50);
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
