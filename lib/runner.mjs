// 运行与聚合。核心语义：
//   - fail 一定让进程失败
//   - manual 默认不失败，但**永远不算通过**，并单独计入"未覆盖"
//   - skip 不失败，但单独列出（跳过 ≠ 通过）
//   - 报告末尾强制打印覆盖率，禁止把"没检查"读成"没问题"

import { RULES, buildContext } from './rules.mjs';
import { listArtifacts } from './spec.mjs';
import { rulesForProfile, CONFIG_DEFAULTS } from './contract.mjs';

export const EXIT = { OK: 0, FAIL: 1, CONFIG: 2 };

/**
 * 解析 `--only`。**未知 id 必须被报出，不得静默变成"跑了 0 条规则 ⇒ 全过"**。
 * 这是「空集不构成通过」在 CLI 层的同款陷阱：`--only TYPO` 若返回空集并通过，
 * 调用方会以为检查过了。
 */
export function resolveOnly(only, rules = RULES) {
  if (!only || !only.length) return { selected: rules, unknown: [] };
  const known = new Set(rules.map((r) => r.id));
  const unknown = only.filter((id) => !known.has(id));
  return { selected: rules.filter((r) => only.includes(r.id)), unknown };
}

/**
 * 档位 + `--only` 的组合选择。**这是第二个空集陷阱**：
 * `--only KISS-C1 --profile process` 里 KISS-C1 是代码档规则，过滤后剩 0 条，
 * 旧实现直接"0 条规则 ⇒ 退出 0"，等于把"我查了个不存在的组合"报成通过。
 *
 * 返回三分类：selected（真要跑的）/ unknownIds（规则表里根本没有）/ outOfProfile（存在但不在本档）。
 */
export function selectRules({ only = null, profile = 'all', rules = RULES }) {
  const inProfile = rulesForProfile(rules, profile);
  if (!only || !only.length) return { selected: inProfile, unknownIds: [], outOfProfile: [] };
  const allIds = new Set(rules.map((r) => r.id));
  const profileIds = new Set(inProfile.map((r) => r.id));
  const unknownIds = only.filter((id) => !allIds.has(id));
  const outOfProfile = only.filter((id) => allIds.has(id) && !profileIds.has(id));
  return { selected: inProfile.filter((r) => only.includes(r.id)), unknownIds, outOfProfile };
}

export function runRules({
  changeDir,
  repo = null,
  cwd,
  cfg = {},
  codeRoots = [],
  diff = null,
  evidence = null,
  profile = 'all',
  only = null,
  rules = RULES,
}) {
  const art = listArtifacts(changeDir);
  const ctx = buildContext({ art, changeDir, repo, cwd, cfg, codeRoots, diff, evidence });
  const inProfile = rulesForProfile(rules, profile);
  const selected = only ? inProfile.filter((r) => only.includes(r.id)) : inProfile;
  const results = [];
  for (const rule of selected) {
    let res;
    try {
      res = rule.run(ctx);
    } catch (e) {
      res = { status: 'fail', reason: `规则执行异常: ${e.message}` };
    }
    results.push({
      id: rule.id,
      principle: rule.principle,
      stage: rule.stage,
      decidability: rule.decidability,
      title: renderTitle(rule.title, ctx.cfg),
      ...res,
    });
  }
  return { results, ctx };
}

/**
 * 渲染标题里的阈值占位符。占位符名 = 配置键名（`{maxNesting}` 等），
 * 不另起别名——别名表本身就会与配置键漂移（曾经用 {max}/{window}，
 * 结果 ACCEPT-E2 的 {ratio} 一直没被替换，报告里直接印出 `{ratio}`）。
 */
function renderTitle(title, cfg) {
  return String(title).replace(/\{(\w+)\}/g, (all, key) => {
    const v = cfg[key] !== undefined ? cfg[key] : CONFIG_DEFAULTS[key];
    return v === undefined || typeof v === 'object' ? all : String(v);
  });
}

export function summarize(results) {
  const by = (s) => results.filter((r) => r.status === s);
  const pass = by('pass');
  const fail = by('fail');
  const skip = by('skip');
  const manual = by('manual');
  return {
    pass: pass.length,
    fail: fail.length,
    skip: skip.length,
    manual: manual.length,
    total: results.length,
    machineTotal: results.filter((r) => r.decidability === 'machine').length,
    covered: pass.length + fail.length,
  };
}

export function formatText(results) {
  const s = summarize(results);
  const lines = [];
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', manual: 'MANUAL' };
  let group = null;
  for (const r of results) {
    const g = `${r.principle} · ${r.stage}`;
    if (g !== group) {
      group = g;
      lines.push(`\n[${g}]`);
    }
    lines.push(`  ${icon[r.status].padEnd(7)} ${r.id}  ${r.title}`);
    if (r.detail) lines.push(`          → ${r.detail}`);
    if (r.reason) lines.push(`          → ${r.reason}`);
    if (r.items && r.items.length) for (const it of r.items.slice(0, 12)) lines.push(`            · ${it}`);
    if (r.status === 'manual') lines.push('            · 需人工判定，机器不计为通过');
  }
  lines.push('');
  lines.push('── 汇总 ──────────────────────────────────');
  lines.push(`  通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skip} · 待人判 ${s.manual}   (共 ${s.total} 条)`);
  lines.push(`  机器实际执行 ${s.covered}/${s.machineTotal} 条机器规则`);
  if (s.skip) lines.push(`  ⚠ ${s.skip} 条因输入不足从未执行 —— 跳过不等于通过`);
  if (s.manual) lines.push(`  ⚠ ${s.manual} 条本质不可机械判定，必须人工签字后才算过关`);
  return lines.join('\n');
}
