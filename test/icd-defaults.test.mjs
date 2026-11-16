/**
 * ICD 配置表「默认值」与代码的一致性（2026-11-16，契约体检最后一块）。
 *
 * ★ 为什么这是最后一块盲区：
 *   之前的契约体检只做到「配置键**名字**在 ICD 出现过」（出现性检查）。
 *   但文档写 `| maxNesting | int | 3 |` 而代码 `CONFIG_DEFAULTS.maxNesting = 4`，
 *   **名字对得上、取值对不上** —— 出现性检查完全抓不到。
 *
 *   这类错误最恶劣的形态：使用者按文档以为默认是 3，实际跑的是 4，
 *   **而他不会去读代码**。
 *
 * ★ 本文件锁定两个真实踩过的坑：
 *   ① **解析必须限定在配置表内**。第一版扫全篇取"首格是反引号键"，
 *      反向检查立刻误报 5 个"多余行"——`tests`/`mutation`/`drift` 来自**证据键**表、
 *      `art` 来自**制品**表。扫全篇等于把别的表格当成本表。
 *   ② **必须先处理转义竖线 `\|`**。`testNesting` 行的类型列写成 `int \| null`，
 *      天真的 `[^|]*` 会把 `int \` 当类型、把 `null` 当默认值 ——
 *      于是"把默认值从 null 改成 6"这个变异**完全无法被察觉**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/temp.mjs';

const ICD = join(REPO_ROOT, 'docs', 'ICD.md');
const TOOL = join(REPO_ROOT, 'tools', 'check-contract.mjs');
const OUT = join(REPO_ROOT, '.selfcheck-icd-defaults.txt');

function runCheck() {
  spawnSync(`"${process.execPath}" "${TOOL}" > "${OUT}" 2>&1`, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: 'inherit',
  });
  const text = readFileSync(OUT, 'utf8');
  const m = text.match(/检查项\s*(\d+)\s*·\s*通过\s*(\d+)\s*·\s*漂移\s*(\d+)/);
  return {
    drift: m ? Number(m[3]) : -1,
    fails: text.split('\n').filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim()),
  };
}

/** 改 ICD → 跑 → 无论结果如何都还原。 */
function withIcd(from, to) {
  const before = readFileSync(ICD, 'utf8');
  if (!before.includes(from)) return { applied: false };
  try {
    writeFileSync(ICD, before.replace(from, to), 'utf8');
    return { applied: true, ...runCheck() };
  } finally {
    writeFileSync(ICD, before, 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 负控：干净状态下不许有漂移
// ─────────────────────────────────────────────────────────────

test('★ 负控：ICD 默认值与代码一致时，漂移必须为 0', () => {
  const r = runCheck();
  assert.equal(r.drift, 0, `干净状态不该有漂移，实际 FAIL: ${r.fails.join(' | ')}`);
});

// ─────────────────────────────────────────────────────────────
// 2. 正控：改坏文档里的默认值必须红
// ─────────────────────────────────────────────────────────────

const MUTATIONS = [
  ['maxNesting 3→4', '| `maxNesting` | int | `3` |', '| `maxNesting` | int | `4` |'],
  ['dupWindow 6→5', '| `dupWindow` | int | `6` |', '| `dupWindow` | int | `5` |'],
  ['minMutationRatio 0.8→0.5', '| `minMutationRatio` | number | `0.8` |', '| `minMutationRatio` | number | `0.5` |'],
  ['allowedPrefixes []→["src"]', '| `allowedPrefixes` | string[] | `[]` |', '| `allowedPrefixes` | string[] | `["src"]` |'],
  ['dependencies {}→{"x":"1"}', '| `dependencies` | object | `{}` |', '| `dependencies` | object | `{"x":"1"}` |'],
];

for (const [label, from, to] of MUTATIONS) {
  test(`★ 正控：ICD 里 ${label} ⇒ 必须变红`, () => {
    const r = withIcd(from, to);
    assert.ok(r.applied, `变异未命中（ICD 表结构已变）⇒ 这条判据等于没测: ${label}`);
    assert.ok(r.drift > 0, `${label} 未被察觉 ⇒ 文档与代码的默认值可能已经在悄悄漂移`);
    assert.ok(
      r.fails.some((f) => /ICD 写的默认值漂移/.test(f)),
      `诊断必须指出是"ICD 写的默认值漂移"，实际: ${r.fails.join(' | ')}`,
    );
  });
}

// ─────────────────────────────────────────────────────────────
// 3. ★ 命脉：`int \| null` 这种带转义竖线的行也必须能核
// ─────────────────────────────────────────────────────────────

test('★★ 命脉：`int \\| null` 类型列（转义竖线）的默认值也必须被核到', () => {
  // `testNesting` 行的类型列是 `int \| null`。
  // 天真的 `[^|]*` 解析会把 `int \` 当类型、`null` 当默认值 ⇒
  // 恰好等于代码里的 null ⇒ **这个变异无法被察觉**（实测踩过）。
  const r = withIcd(
    '| `testNesting` | int \\| null | `null` |',
    '| `testNesting` | int \\| null | `6` |',
  );
  assert.ok(r.applied, '变异未命中 ⇒ 这条判据等于没测');
  assert.ok(
    r.fails.some((f) => /testNesting/.test(f) && /漂移/.test(f)),
    `带转义竖线的行必须能核到；实际 fails=${JSON.stringify(r.fails)}`,
  );
});

// ─────────────────────────────────────────────────────────────
// 4. ★ 负控：不许把别的表格当配置表（误报）
// ─────────────────────────────────────────────────────────────

test('★ 负控：不许把证据键/制品表里的键当成"多余的配置行"', () => {
  // 第一版扫全篇 ⇒ 误报 tests/mutation/drift/art 为"多余行"。
  // 这里断言：正常状态下**不该出现**"真多余"的错误。
  const r = runCheck();
  const falsePositives = r.fails.filter((f) => /真多余|多余行/.test(f));
  assert.deepEqual(falsePositives, [], `把别的表格当配置表了: ${falsePositives.join(' | ')}`);
});

test('★ 负控：故意无默认值的键（maxDiffLines）不算"多余行"', () => {
  // `maxDiffLines` 在 CONFIG_SCHEMA 里、不在 CONFIG_DEFAULTS 里，
  // 文档明确写「无默认」—— 这是**故意的**，不是漂移。
  const r = runCheck();
  assert.ok(
    !r.fails.some((f) => /maxDiffLines/.test(f)),
    'maxDiffLines 是故意无默认值（2026-11-14 取消隐式预算），不该报错',
  );
});
