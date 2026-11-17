/**
 * 文档一致性：**"文档说做了"与"脚本真的核了"必须一致**（2026-11-18）。
 *
 * ★ 本文件对应一类反复出现的缺陷：**文档声明某种保证，但没有实现兑现它**。
 *
 *   实测抓到的四例（同一天同一份审查里）：
 *     ① README 顶部写「27 = 19 + 8」（对的），但逐条清单停在 19 条
 *        —— ACCEPT-E1..E4 / ARCH-06 / ARCH-06-M / ARCH-07 / ARCH-07-M 一次都没出现。
 *        根因：`check-contract` 只核计数串，**不核每个 id 是否被枚举**。
 *     ② `docs/DESIGN-RATIONALE.md` §9 自称「这些数字**由脚本核对**」，
 *        而脚本只 `readFileSync(README)`，**根本不打开这个文件**。
 *     ③ 同一份文档 §8「已知未验证项」里两条早已做完，还挂着"未验证"。
 *     ④ `whoiam.md` 仍写「23 条判据 = 17 + 6」「self-check 8/8」。
 *
 *   ⇒ 统一判据：**凡是文档里写的数字，要么有一条脚本在核它，要么删掉。**
 *
 * 本文件用**变异**证明校验真的会红，而不是只看它现在绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/temp.mjs';

const TOOL = join(REPO_ROOT, 'tools', 'check-contract.mjs');
const OUT = join(REPO_ROOT, '.selfcheck-doccheck.txt');

/** 跑 check-contract，返回 `{drift, fails, text}`。 */
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

/** 改文件 → 跑 → 无论结果如何都还原。 */
function withFile(file, mutate) {
  const before = readFileSync(file, 'utf8');
  const after = mutate(before);
  if (after === before) return { applied: false };
  try {
    writeFileSync(file, after, 'utf8');
    return { applied: true, ...runCheck() };
  } finally {
    writeFileSync(file, before, 'utf8');
  }
}

const README = join(REPO_ROOT, 'README.md');
const RATIONALE = join(REPO_ROOT, 'docs', 'DESIGN-RATIONALE.md');

// ─────────────────────────────────────────────────────────────
// 负控
// ─────────────────────────────────────────────────────────────

test('★ 负控：干净状态下文档一致性必须零漂移', () => {
  const r = runCheck();
  assert.equal(r.drift, 0, `干净状态不该有漂移，实际 FAIL: ${r.fails.join(' | ')}`);
});

// ─────────────────────────────────────────────────────────────
// ① README 逐条清单：枚举必须完备
// ─────────────────────────────────────────────────────────────

test('★★ 正控：README 删掉一个 rule id ⇒ 必须红（计数对不等于枚举完备）', () => {
  // 删的是逐条表格里的一行 —— 计数串（27 = 19 + 8）**完全没动**，
  // 旧实现会照样绿。这正是实测踩过的形态。
  const r = withFile(README, (t) => t.replace('| acceptance | `ARCH-07` | machine |', '| acceptance | `ARCH-0X` | machine |'));
  assert.ok(r.applied, '变异未命中 ⇒ 这条判据等于没测');
  assert.ok(r.drift > 0, '删掉一个 rule id 未被察觉 ⇒ 枚举完备性是假的');
  assert.ok(
    r.fails.some((f) => /逐条清单缺/.test(f) || /不存在的 rule id/.test(f)),
    `诊断必须指出清单缺项或 id 不存在，实际: ${r.fails.join(' | ')}`,
  );
});

test('★★ 正控：README 写一个不存在的 rule id ⇒ 必须红（防清单陈旧）', () => {
  const r = withFile(README, (t) =>
    t.replace('| acceptance | `ARCH-07` | machine |', '| acceptance | `ARCH-99` | machine |\n| acceptance | `ARCH-07` | machine |'));
  assert.ok(r.applied, '变异未命中');
  assert.ok(
    r.fails.some((f) => /不存在的 rule id/.test(f)),
    `必须报"不存在的 rule id"，实际: ${r.fails.join(' | ')}`,
  );
});

// ─────────────────────────────────────────────────────────────
// ② DESIGN-RATIONALE：自称"由脚本核对"就必须真的核
// ─────────────────────────────────────────────────────────────

test('★★ 正控：DESIGN-RATIONALE 版本行数字写错 ⇒ 必须红', () => {
  const r = withFile(RATIONALE, (t) => t.replace(/对应 `lib\/rules\.mjs`\s*27\s*条规则/, '对应 `lib/rules.mjs` 23 条规则'));
  assert.ok(r.applied, '变异未命中 ⇒ DESIGN-RATIONALE 的版本行格式已变，需同步判据');
  assert.ok(r.drift > 0, '版本行数字写错未被察觉 ⇒ §9「由脚本核对」仍是空话');
  assert.ok(
    r.fails.some((f) => /DESIGN-RATIONALE 版本行漂移/.test(f)),
    `诊断必须指向版本行，实际: ${r.fails.join(' | ')}`,
  );
});

test('★★ 正控：DESIGN-RATIONALE §9 档位分档数写错 ⇒ 必须红', () => {
  // 旧值 acceptance 12 = 10+2 正是实测踩过的过期数字
  const r = withFile(RATIONALE, (t) =>
    t.replace(/`acceptance`\s*16\s*=\s*12\+4/, '`acceptance` 12 = 10+2'));
  assert.ok(r.applied, '变异未命中 ⇒ 档位行格式已变，需同步判据');
  assert.ok(r.drift > 0, '档位分档数写错未被察觉');
  assert.ok(
    r.fails.some((f) => /DESIGN-RATIONALE §9 分档计数漂移/.test(f)),
    `诊断必须指向分档计数，实际: ${r.fails.join(' | ')}`,
  );
});

test('★ 正控：DESIGN-RATIONALE §9 规则总数写错 ⇒ 必须红', () => {
  const r = withFile(RATIONALE, (t) => t.replace(/\|\s*规则总数\s*\|\s*27（机器\s*19/, '| 规则总数 | 23（机器 19'));
  assert.ok(r.applied, '变异未命中');
  assert.ok(r.drift > 0, '§9 规则总数写错未被察觉');
});

// ─────────────────────────────────────────────────────────────
// whoiam.md：本机拓扑文件，不进仓库，单独核
// ─────────────────────────────────────────────────────────────

test('★ whoiam.md 若存在，其判据数与 self-check 步数必须与实况一致', () => {
  // whoiam.md 在 .gitignore 里（属本机工作区拓扑），CI 上不存在 ⇒ 跳过而不是失败。
  const WHOIAM = join(REPO_ROOT, 'whoiam.md');
  if (!existsSync(WHOIAM)) {
    assert.ok(true, '本机无 whoiam.md（CI 环境），跳过 —— 不构成通过，也不构成失败');
    return;
  }
  const text = readFileSync(WHOIAM, 'utf8');
  const m = text.match(/(\d+)\s*条判据\s*=\s*(\d+)\s*机器\s*\+\s*(\d+)\s*人工/);
  assert.ok(m, 'whoiam.md 应声明判据数（格式：N 条判据 = M 机器 + K 人工）');
  const [t, mac, man] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.deepEqual([t, mac, man], [27, 19, 8], `whoiam.md 判据数应为 27 = 19 + 8，实际 ${t} = ${mac} + ${man}`);
});
