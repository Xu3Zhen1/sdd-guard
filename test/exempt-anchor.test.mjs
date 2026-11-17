/**
 * 豁免的**内容锚定**（2026-11-18）。
 *
 * ★ 为什么需要这一层测试（实测踩过）：
 *   旧实现的豁免身份是 `relPath:line`。2026-11-18 我在
 *   `tools/check-contract.mjs` 靠前处加代码后，两处豁免的行号从
 *   `:239`→`:240`、`:822`→`:869` 漂走，**全部豁免静默失效**。
 *
 *   ⇒ **行号是位置，不是身份。** 豁免的对象是"这段代码"，不是"第 95 行"。
 *     代码移动不该让豁免失效；代码本身改了才该失效（那才是重新审的时候）。
 *
 * 本文件测两个方向，缺一不可：
 *   · 代码**移动**（行号变、内容不变）⇒ 豁免必须仍然有效
 *   · 代码**改了**（该 catch 不再为空）⇒ 豁免必须失配并暴露为"陈旧"
 *
 * ★ 只测前一个方向是不够的：那样"内容锚定"退化成"永不失效"，
 *   等于把豁免变成永久白名单 —— 比绑行号更坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyCatches, scanArch } from '../lib/arch.mjs';
import { REPO_ROOT } from '../lib/temp.mjs';

const TARGET = join(REPO_ROOT, 'tools', 'check-contract.mjs');

/** 取某文件里全部空 catch 的锚点。 */
function anchorsOf(text) {
  return emptyCatches('tools/check-contract.mjs', text).map((h) => h.snippet);
}

test('★★ 命脉：代码**移动**（前插无关行）⇒ 锚点不变', () => {
  const before = readFileSync(TARGET, 'utf8');
  const filler = Array.from({ length: 50 }, (_, i) => `// filler ${i}`).join('\n') + '\n';
  const moved = filler + before;

  const a0 = anchorsOf(before);
  const a1 = anchorsOf(moved);
  assert.ok(a0.length >= 2, `本文件应至少有 2 个空 catch，实际 ${a0.length}`);
  assert.deepEqual(a1, a0, '前插 50 行后锚点必须完全一致 —— 否则说明锚点里混入了行号信息');
});

test('★★ 命脉：行号确实变了（证明上一条不是"因为没动"而通过）', () => {
  const before = readFileSync(TARGET, 'utf8');
  const filler = Array.from({ length: 50 }, (_, i) => `// filler ${i}`).join('\n') + '\n';
  const moved = filler + before;

  const l0 = emptyCatches('tools/check-contract.mjs', before).map((h) => h.line);
  const l1 = emptyCatches('tools/check-contract.mjs', moved).map((h) => h.line);
  assert.equal(l1.length, l0.length);
  for (let i = 0; i < l0.length; i++) {
    assert.equal(l1[i] - l0[i], 50, `第 ${i} 个命中的行号应整体下移 50，实际 ${l0[i]}→${l1[i]}`);
  }
});

test('★★ 锚点区分度：全仓统计应 ≥80%；单文件重复必须能靠行号消歧', () => {
  // ★ 期望值在 2026-11-18 被现实修正两次：
  //   ① 单看 `tools/check-contract.mjs`：它只有 2 处空 catch，且都是
  //      `try { rmSync(tmp, {…}) } catch {}` —— **逐字相同**，区分度必然 50%。
  //      这不是实现缺陷，是真实存在的情形。
  //   ② 硬要"每处都不同"会逼实现把行号混进锚点 —— 那正是本轮要消除的东西。
  //
  //   所以判据分两层：
  //     · 全仓层面：区分度应 ≥80%（防止整体退化成 "catch { }"）
  //     · 单文件层面：重复的锚点，其行号必须不同（消歧是可能的）
  const files = ['lib/temp.mjs', 'tools/check-contract.mjs', 'tools/make-diff.mjs', 'tools/check-publish.mjs'];
  const all = [];
  for (const rel of files) {
    const hits = emptyCatches(rel, readFileSync(join(REPO_ROOT, rel), 'utf8'));
    for (const h of hits) all.push({ rel, ...h });
  }
  assert.ok(all.length >= 5, `样本应 ≥5 处空 catch，实际 ${all.length}`);
  const uniq = new Set(all.map((h) => h.snippet));
  const ratio = uniq.size / all.length;
  assert.ok(ratio >= 0.8,
    `全仓锚点区分度应 ≥80%，实际 ${(ratio * 100).toFixed(0)}%（${uniq.size}/${all.length}）`);

  // 同文件重复的，行号必须能区分
  const byFile = new Map();
  for (const h of all) {
    if (!byFile.has(h.rel)) byFile.set(h.rel, []);
    byFile.get(h.rel).push(h);
  }
  for (const [rel, hits] of byFile) {
    const bySnippet = new Map();
    for (const h of hits) {
      if (!bySnippet.has(h.snippet)) bySnippet.set(h.snippet, []);
      bySnippet.get(h.snippet).push(h.line);
    }
    for (const [snippet, lines] of bySnippet) {
      if (lines.length < 2) continue;
      assert.equal(new Set(lines).size, lines.length,
        `${rel} 同锚点 ${lines.length} 处必须行号不同，实际 ${JSON.stringify(lines)}：${snippet}`);
    }
  }
});

test('★★ 命脉：catch 块**内容改了** ⇒ 该锚点必须消失（否则豁免成了永久白名单）', () => {
  const before = readFileSync(TARGET, 'utf8');
  // 把某个空 catch 换成有语句的块：它不再是"空 catch 命中"，
  // 若锚点还相同，说明锚点根本没包含块体内容。
  const mutated = before.replace(
    /try \{ rmSync\(tmp, \{ recursive: true, force: true \}\); \} catch \{ \/\* 清理失败不影响结论 \*\/ \}/,
    'try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.error(e); }',
  );
  assert.notEqual(mutated, before, '变异未命中 ⇒ 源码形态已变，本条等于没测');

  const a0 = anchorsOf(before);
  const a1 = anchorsOf(mutated);
  assert.equal(a1.length, a0.length - 1, `改掉一个空 catch 后数量应减 1，实际 ${a0.length}→${a1.length}`);
  // 被改的那处锚点里带着 rmSync(tmp)，它必须从结果中彻底消失
  const stillThere = a1.filter((s) => /rmSync\(tmp, \{ recursive: true, force: true \}\)/.test(s));
  assert.equal(stillThere.length, a0.filter((s) => /rmSync\(tmp/.test(s)).length - 1,
    '被改成有语句的 catch 不该再出现在空 catch 里');
});


test('★ 负控：块体的**注释**变化不该让锚点失效（注释是允许变的）', () => {
  const src = 'function f(){ try { a(); } catch { /* 旧理由 */ } }';
  const mod = 'function f(){ try { a(); } catch { /* 换了个更详细的理由说明 */ } }';
  const a0 = emptyCatches('x.js', src).map((h) => h.snippet);
  const a1 = emptyCatches('x.js', mod).map((h) => h.snippet);
  assert.deepEqual(a1, a0, '改注释不该改变锚点 —— 否则每补一句说明都要重登豁免');
});

test('★ 负控：块体的**空白**变化不该让锚点失效', () => {
  const src = 'function f(){ try { a(); } catch {} }';
  const mod = 'function f(){ try { a(); } catch {\n\n} }';
  assert.deepEqual(
    emptyCatches('x.js', mod).map((h) => h.snippet),
    emptyCatches('x.js', src).map((h) => h.snippet),
    '纯空白变化不该改变锚点',
  );
});

test('元判据：scanArch 不再接受 allow 参数（豁免判定已移到 rules.mjs）', () => {
  // 职责分离：扫描器只负责"找"，判据负责"判"。
  // 若把豁免过滤塞回扫描器，"谁被豁免了"就藏进了扫描器，无法审计。
  const fn = readFileSync(join(REPO_ROOT, 'lib', 'arch.mjs'), 'utf8');
  assert.match(fn, /export function scanArch\(absPath, relPath = absPath\) \{/,
    'scanArch 签名里不该再有 allow 参数');
  assert.equal(typeof scanArch, 'function');
});
