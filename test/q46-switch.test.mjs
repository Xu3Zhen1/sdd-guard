// 评审包 §5 Q4.6：「可选选项」本身会不会变成后门。
//
// 原直觉：「分界线在于关掉之后，还能不能察觉自己关掉了。」
// 本文件把直觉落成**可校验判据**：
//
//   AUDITABLE —— 关闭后留下痕迹，且该痕迹**影响机器判定**（退出码/结论），
//                 而不只是印一行文案给人看。
//   DEGRADING —— 只降级不消失：判据仍跑，只是结论变弱，弱化本身被记录。
//   FORBIDDEN —— 即使显式要求也不得关闭（判据自身完整性）。
//
// 核心判据：一个开关属哪档，不由「它感觉危不危险」决定，
// 而由**关掉后信号是否仍可分辨**决定。不可分辨 ⇒ FORBIDDEN。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SWITCHES, SWITCH_CLASS, OPTIONS } from '../lib/contract.mjs';

const SELF_CHECK = readFileSync(new URL('../tools/self-check.mjs', import.meta.url), 'utf8');
const CLI_SRC = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');

test('每个已登记开关都必须落在三档之一（不得有未分类的开关）', () => {
  const valid = new Set(Object.values(SWITCH_CLASS));
  assert.ok(SWITCHES.length >= 4, '至少应登记 4 个开关');
  for (const s of SWITCHES) {
    assert.ok(s.key, '开关必须有 key');
    assert.ok(valid.has(s.kind), '开关 ' + s.key + ' 的 kind 非法: ' + s.kind);
    assert.ok(s.why, '开关 ' + s.key + ' 必须写明为什么允许/禁止');
  }
});

test('AUDITABLE 档必须给出可观测痕迹', () => {
  const auditable = SWITCHES.filter((s) => s.kind === SWITCH_CLASS.AUDITABLE);
  assert.ok(auditable.length > 0, '应至少有一个 AUDITABLE 开关');
  for (const s of auditable) {
    assert.ok(s.evidence, 'AUDITABLE 开关 ' + s.key + ' 必须说明关闭后留下什么痕迹');
  }
});

test('FORBIDDEN 档不得出现在 OPTIONS 里 —— 禁止关闭的东西不能有入口', () => {
  const forbidden = SWITCHES.filter((s) => s.kind === SWITCH_CLASS.FORBIDDEN);
  assert.ok(forbidden.length > 0, '应至少登记一个 FORBIDDEN');
  const optKeys = new Set(OPTIONS.map((o) => o.key));
  for (const s of forbidden) {
    assert.ok(!optKeys.has(s.key), 'FORBIDDEN 开关 ' + s.key + ' 不该出现在 --help 里');
  }
});

test('实证：--skip-acceptance 关闭后必须留下影响机器判定的痕迹（退出码 3）', () => {
  // 这条是本次真实修复的锚点。原实现无条件 exit 0，只在文案里加说明。
  assert.match(SELF_CHECK, /if \(skipped\.length\) \{/, 'self-check 必须对跳过项单独判断');
  assert.match(SELF_CHECK, /process\.exit\(3\)/, '跳过项存在时必须以 3 退出（INCOMPLETE），不能是 0');
  // 负控：不得让 exit(0) 抢先返回
  const iExit3 = SELF_CHECK.lastIndexOf('process.exit(3)');
  const iExit0 = SELF_CHECK.lastIndexOf('process.exit(0)');
  assert.ok(iExit3 > 0 && iExit0 > iExit3, 'exit(0) 必须在 exit(3) 之后（否则跳过永远走不到 3）');
});

test('实证：--min-coverage 关闭时的痕迹是可区分的（0 vs 未设）', () => {
  // 0 是显式值；未设则不参与判定。两者在参数层面可区分。
  assert.match(CLI_SRC, /args\['min-coverage'\] !== undefined/, '必须区分「未设」与「设了 0」');
});

test('负控：所有布尔开关都必须在 SWITCHES 登记（防止新加削弱判据的开关却不登记）', () => {
  const registered = new Set(SWITCHES.map((s) => s.key));
  const boolOpts = OPTIONS.filter((o) => o.boolean).map((o) => o.key);
  const exempt = new Set(['json', 'help']);
  const unregistered = boolOpts.filter((k) => !registered.has(k) && !exempt.has(k));
  assert.deepEqual(unregistered, [], '以下布尔开关未在 SWITCHES 登记: ' + unregistered.join(', '));
});
