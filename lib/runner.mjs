// 运行与聚合。核心语义：
//   - fail 一定让进程失败
//   - manual 默认不失败，但**永远不算通过**，并单独计入"未覆盖"
//   - skip 不失败，但单独列出（跳过 ≠ 通过）
//   - 报告末尾强制打印覆盖率，禁止把"没检查"读成"没问题"

import { RULES, buildContext } from './rules.mjs';
import { listArtifacts } from './spec.mjs';
import { rulesForProfile, CONFIG_DEFAULTS } from './contract.mjs';

/**
 * 退出码语义（2026-11-13 · 评审包 §5 Q4.5）。
 *
 * 原先只有 OK/FAIL/CONFIG，导致**两种性质不同的失败被合流成同一个 1**：
 *
 *   「我没跑完」  —— coverage 不足。可能是使用者没写文档，也可能是抽不出来。
 *                    这类失败**告诉你要补输入**，不该无条件阻断。
 *   「跑完了，但结果不可信」 —— 自洽性矛盾（pass+fail>tests、
 *                    killed+survived≠total、规则内部抛异常）。
 *                    这类失败**说明判据自己坏了**，必须无条件阻断：
 *                    它给出的任何"通过"都不能采信。
 *
 * 合流的后果：CI 只能写 `if exit != 0 then block`，于是要么放行没跑完，
 * 要么把"需要补文档"当成"代码有问题"。接自动分流时无从下手。
 *
 * 现在拆成三档：
 *   0 = 全过
 *   1 = 跑了，判据判定不合格（fail）——**这是对被测对象的结论**
 *   2 = 输入/配置错误——根本没开始跑
 *   3 = 跑了，但结果不可信 / 没跑完——**这是对判据自身状态的结论**
 */
export const EXIT = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 3 };

/** 失败信号的性质。'untrusted' 优先于 'incomplete'：自相矛盾比没跑完更严重。 */
export const SIGNAL = { FAIL: 'fail', INCOMPLETE: 'incomplete', UNTRUSTED: 'untrusted' };

// 不变量账本已抽到 lib/invariant.mjs（避免 rules.mjs ↔ runner.mjs 循环依赖）。
export { assertInvariant, invariantStats, resetInvariantStats } from './invariant.mjs';

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
      /**
       * 规则**自己抛异常**不是"判据判定不合格"，而是"判据坏了"。
       * 原先一律记成 status:'fail'，于是它与真正的 fail 在退出码上无法区分 ——
       * 而它的语义恰恰相反：true fail 是对被测对象的结论，
       * 规则异常是对**判据自身**的结论，后者必须无条件阻断。
       */
      res = { status: 'fail', signal: SIGNAL.UNTRUSTED, reason: `规则执行异常: ${e.message}` };
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
  /**
   * untrusted：**判据自身**报告"我给不出可信结论"的条数（§5 Q4.5）。
   * 与 fail 分开计数，因为它们的语义相反：
   *   fail      = 我查了，你（被测对象）不合格
   *   untrusted = 我坏了，我说的"通过"不算数
   */
  const untrusted = results.filter((r) => r.signal === SIGNAL.UNTRUSTED);
  return {
    pass: pass.length,
    fail: fail.length,
    skip: skip.length,
    manual: manual.length,
    total: results.length,
    machineTotal: results.filter((r) => r.decidability === 'machine').length,
    covered: pass.length + fail.length,
    untrusted: untrusted.length,
    untrustedIds: untrusted.map((r) => r.id),
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
    const mark = r.signal === SIGNAL.UNTRUSTED ? '[不可信] ' : '';
    lines.push(`  ${icon[r.status].padEnd(7)} ${r.id}  ${mark}${r.title}`);
    if (r.detail) lines.push(`          → ${r.detail}`);
    if (r.reason) lines.push(`          → ${r.reason}`);
    if (r.items && r.items.length) for (const it of r.items.slice(0, 12)) lines.push(`            · ${it}`);
    if (r.status === 'manual') lines.push('            · 需人工判定，机器不计为通过');
  }
  lines.push('');
  lines.push('── 汇总 ──────────────────────────────────');
  lines.push(`  通过 ${s.pass} · 失败 ${s.fail} · 跳过 ${s.skip} · 待人判 ${s.manual}   (共 ${s.total} 条)`);
  lines.push(`  机器实际执行 ${s.covered}/${s.machineTotal} 条机器规则`);
  if (s.untrusted) {
    lines.push(
      `  ✖ ${s.untrusted} 条判据自身不可信（${s.untrustedIds.join(', ')}）—— ` +
        '它们给出的结论不能采信，本次运行的"通过"整体无效',
    );
  }
  if (s.skip) lines.push(`  ⚠ ${s.skip} 条因输入不足从未执行 —— 跳过不等于通过`);
  if (s.manual) lines.push(`  ⚠ ${s.manual} 条本质不可机械判定，必须人工签字后才算过关`);
  return lines.join('\n');
}
