// 契约漂移检测：把「ICD 写的」「contract.mjs 声明的」「代码实际做的」三者逐项比对。
//
// 只写文档会让 ICD 变成第二份 README；只写常量会让代码与文档分叉。
// 这个脚本是三者之间的差值检测器：任何一项对不上就 exit 1 并指出具体差异。
//
// 用法：node tools/check-contract.mjs
// 退出码：0 = 无漂移；1 = 有漂移（逐条打印）

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION, STATUSES, EXIT_CODES, OPTIONS, CONFIG_DEFAULTS, REPEATABLE_KEYS, PROFILE_NAMES, EVIDENCE_KEYS, rulesForProfile, SWITCHES, SWITCH_CLASS } from '../lib/contract.mjs';
import { EXIT as RUNNER_EXIT } from '../lib/runner.mjs';
import { REPEATABLE_KEYS as ARGS_REPEATABLE } from '../lib/args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICD = join(ROOT, 'docs', 'ICD.md');
const RULES = join(ROOT, 'lib', 'rules.mjs');
const README = join(ROOT, 'README.md');

const findings = [];
const ok = (msg) => findings.push({ level: 'ok', msg });
const bad = (msg) => findings.push({ level: 'fail', msg });

function readText(p, label) {
  if (!existsSync(p)) {
    bad(`${label} 不存在: ${p}`);
    return '';
  }
  return readFileSync(p, 'utf8');
}

const icd = readText(ICD, 'ICD.md');
const rules = readText(RULES, 'lib/rules.mjs');
const readme = readText(README, 'README.md');

// ── 1. 退出码：contract vs runner vs ICD ─────────────────────
{
  const same = ['OK', 'FAIL', 'CONFIG'].every((k) => EXIT_CODES[k] === RUNNER_EXIT[k]);
  if (same) ok(`退出码 contract 与 runner 一致: ${JSON.stringify(EXIT_CODES)}`);
  else bad(`退出码不一致: contract=${JSON.stringify(EXIT_CODES)} runner=${JSON.stringify(RUNNER_EXIT)}`);

  for (const [k, v] of Object.entries(EXIT_CODES)) {
    if (icd.includes(`\`${v}\``)) ok(`ICD 记录了退出码 ${v}(${k})`);
    else bad(`ICD 未记录退出码 ${v}(${k})`);
  }
}

// ── 2. 四态：contract vs ICD vs formatText 图标表 ─────────────
{
  const missing = STATUSES.filter((s) => !icd.includes(`\`${s}\``));
  if (missing.length) bad(`ICD 未记录结论状态: ${missing.join(', ')}`);
  else ok(`ICD 记录了全部 ${STATUSES.length} 种结论状态`);

  // runner.formatText 的图标表必须覆盖且只覆盖这四态
  const icons = (readText(join(ROOT, 'lib', 'runner.mjs'), 'runner') .match(/const icon = \{([^}]*)\}/) || [])[1] || '';
  const keys = [...icons.matchAll(/(\w+):/g)].map((m) => m[1]);
  const setEqual = keys.length === STATUSES.length && STATUSES.every((s) => keys.includes(s));
  if (setEqual) ok('runner 图标表与四态一致');
  else bad(`runner 图标表与四态不一致: 图标=${keys.join(',')} 契约=${STATUSES.join(',')}`);
}

// ── 3. 选项：contract vs args.mjs 的可重复键 vs ICD 表格 ──────
{
  const contractRepeat = [...REPEATABLE_KEYS].sort().join(',');
  const argsRepeat = [...ARGS_REPEATABLE].sort().join(',');
  if (contractRepeat === argsRepeat) ok(`可重复选项一致: [${contractRepeat}]`);
  else bad(`可重复选项不一致: contract=[${contractRepeat}] args=[${argsRepeat}]`);

  // 选项只从 §1.2 选项表里抽，不从全文抽——正文里出现 `--key value` 这种说明文字会被误判成选项
  const sec = icd.split(/^###\s*1\.3/m)[0].split(/^###\s*1\.2/m)[1] || '';
  // 只取表格行：§1.2 里还有「解析规则」散文，其中出现 `--key value` 这种说明会被误判成选项
  const tableText = sec.split('\n').filter((l) => l.trim().startsWith('|')).join('\n');
  const icdFlags = new Set([...tableText.matchAll(/`--([a-z][a-z-]*)(?=[\s<`])/g)].map((m) => m[1]));
  const known = new Set(OPTIONS.map((o) => o.key));
  const phantom = [...icdFlags].filter((f) => !known.has(f));
  if (phantom.length) bad(`ICD 选项表提到契约里没有的选项: ${phantom.join(', ')}`);
  else ok(`ICD 选项表的 ${icdFlags.size} 个选项全部存在于契约`);

  // 契约里的每个选项都必须在 ICD 选项表出现（防"实现了没写文档"）
  const missing = OPTIONS.filter((o) => !icdFlags.has(o.key)).map((o) => o.key);
  if (missing.length) bad(`契约有但 ICD 选项表没写: ${missing.join(', ')}`);
  else ok(`契约的 ${OPTIONS.length} 个选项全部在 ICD 选项表中出现`);

  // 可重复标记必须与 ICD 选项表一致：行首必须是 `| \`--key`，避免匹配到别处提及该选项的行
  for (const o of OPTIONS) {
    const re = new RegExp(`^\\|\\s*\`--${o.key}(\\s|\`)`, 'm');
    const row = sec.split('\n').find((l) => re.test(l));
    if (!row) {
      bad(`ICD 选项表里找不到 --${o.key} 的行（无法校验可重复性）`);
      continue;
    }
    const saysRepeatable = /累积/.test(row);
    if (!!o.repeatable !== saysRepeatable) bad(`ICD 与契约对 --${o.key} 的可重复性表述不一致: ICD=${saysRepeatable} contract=${!!o.repeatable}`);
    else ok(`--${o.key} 可重复性一致: ${o.repeatable ? '可累积' : '不累积'}`);
  }
}

// ── 4. 配置键与默认值：contract vs rules.mjs 的 `??` 字面量 vs ICD ─
{
  const missingInIcd = Object.keys(CONFIG_DEFAULTS).filter((k) => !icd.includes(`\`${k}\``));
  if (missingInIcd.length) bad(`ICD 未记录配置键: ${missingInIcd.join(', ')}`);
  else ok(`ICD 记录了全部 ${Object.keys(CONFIG_DEFAULTS).length} 个配置键`);

  // 从 rules.mjs 抽 `cfg.<key> ?? <literal>` 与 `ctx.cfg.<key> ?? <literal>`
  for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
    if (typeof expected === 'object') continue; // 对象/数组型没有 `??` 字面量可对
    const re = new RegExp(`cfg\\.${key}\\s*\\?\\?\\s*([\\w.-]+)`);
    const m = rules.match(re);
    if (!m) {
      bad(`rules.mjs 里找不到 cfg.${key} 的默认值读取（契约声明默认 ${JSON.stringify(expected)}）`);
      continue;
    }
    const actual = Number(m[1]);
    if (actual === expected) ok(`配置默认值 ${key}=${expected}（rules.mjs 实测一致）`);
    else bad(`配置默认值漂移 ${key}: 契约=${expected} 实现=${actual}`);
  }

  // ICD 表格里的默认值渲染（反引号包裹）必须与契约一致
  for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
    if (typeof expected === 'object') continue;
    const row = icd.split('\n').find((l) => l.includes(`\`${key}\``) && l.trim().startsWith('|'));
    if (!row) continue;
    if (!row.includes(`\`${expected}\``)) bad(`ICD 里 ${key} 的默认值未写成 ${expected}`);
  }
}

// ── 5. 版本号：package.json vs contract ──────────────────────
{
  const pkg = JSON.parse(readText(join(ROOT, 'package.json'), 'package.json') || '{}');
  if (pkg.version === VERSION) ok(`版本一致: ${VERSION}`);
  else bad(`版本不一致: package.json=${pkg.version} contract=${VERSION}`);
}

// ── 6. 规则数量与档位：README 宣称 vs 实际 RULES ─────────────
{
  const { RULES } = await import('../lib/rules.mjs');
  const machine = RULES.filter((r) => r.decidability === 'machine').length;
  const manual = RULES.filter((r) => r.decidability === 'manual').length;
  const total = RULES.length;
  const m = readme.match(/(\d+)\s*条\s*=\s*(\d+)\s*机器\s*\+\s*(\d+)\s*人工/);
  if (m) {
    const [t, mac, man] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (t === total && mac === machine && man === manual) ok(`README 判据数一致: ${t} = ${mac} 机器 + ${man} 人工`);
    else bad(`README 判据数漂移: README=${t}=${mac}+${man} 实际=${total}=${machine}+${manual}`);
  } else {
    bad('README 未按「N 条 = M 机器 + K 人工」格式声明判据数，无法校验');
  }

  // 档位：两档必须完备、互斥，且 README 必须写出两档的名字与命令
  const proc = rulesForProfile(RULES, 'process');
  const acc = rulesForProfile(RULES, 'acceptance');
  if (proc.length + acc.length !== total) bad(`档位不完备: process=${proc.length} + acceptance=${acc.length} ≠ ${total}`);
  else if (proc.some((r) => acc.includes(r))) bad('档位有交集：同一条规则同时属于 process 与 acceptance');
  else ok(`档位完备且互斥: process=${proc.length} · acceptance=${acc.length}`);

  if (proc.length === 0 || acc.length === 0) bad('某个档位为空（空档位会让 --profile 静默跳过一切）');
  for (const name of PROFILE_NAMES.filter((n) => n !== 'all')) {
    if (readme.includes(`--profile ${name}`)) ok(`README 写明了 --profile ${name}`);
    else bad(`README 未写 --profile ${name}`);
    if (icd.includes(`\`${name}\``)) ok(`ICD 写明了档位 ${name}`);
    else bad(`ICD 未写档位 ${name}`);
  }

  // 验收证据键：ICD §5.2 必须逐个覆盖 EVIDENCE_KEYS
  const missingEvidence = EVIDENCE_KEYS.filter((k) => !icd.includes(`\`${k}\``));
  if (missingEvidence.length) bad(`ICD 未记录证据键: ${missingEvidence.join(', ')}`);
  else ok(`ICD 记录了全部 ${EVIDENCE_KEYS.length} 个证据键`);

  // 证据产出器必须存在，且 ICD 必须写明它（否则"验收"没有可用的生产者）
  for (const p of ['tools/make-evidence.mjs', 'tools/self-check.mjs', 'lib/evidence.mjs', 'evidence.config.json']) {
    if (!existsSync(join(ROOT, p))) bad(`证据链路缺文件: ${p}`);
    else ok(`证据链路文件存在: ${p}`);
  }
  if (icd.includes('make-evidence.mjs')) ok('ICD 写明了证据产出器');
  else bad('ICD 未写明证据产出器 make-evidence.mjs');
  for (const k of ['command', 'exitCode', 'sha256']) {
    if (icd.includes(`\`${k}\``)) ok(`ICD 记录了 provenance 字段 ${k}`);
    else bad(`ICD 未记录 provenance 字段 ${k}`);
  }

  if (readme.includes('tools/self-check.mjs')) ok('README 写明了 self-check 一键命令');
  else bad('README 未写明 self-check 一键命令（团队不会记住 6 条命令）');

  // acceptance 档必须有证据规则，否则"验收"名不副实
  const evidenceRules = acc.filter((r) => r.id.startsWith('ACCEPT-'));
  if (evidenceRules.length >= 3) ok(`acceptance 档含 ${evidenceRules.length} 条证据判据`);
  else bad(`acceptance 档证据判据不足（${evidenceRules.length} 条），"验收"名不副实`);

  // ── 开关可关闭性（评审包 §5 Q4.6）──────────────────────────
  // 判据：一个开关属哪档不靠"感觉危不危险"，而靠**关掉后信号是否仍可分辨**。
  // 新加一个能削弱判据的开关却不登记 ⇒ 这里报漂移。
  {
    const registered = new Set(SWITCHES.map((x) => x.key));
    const boolOpts = OPTIONS.filter((o) => o.boolean).map((o) => o.key);
    const exempt = new Set(['json', 'help']);
    const unregistered = boolOpts.filter((k) => !registered.has(k) && !exempt.has(k));
    if (unregistered.length) {
      bad(`以下布尔开关未在 contract.SWITCHES 登记（无法判断能否安全关闭）: ${unregistered.join(', ')}`);
    } else {
      ok(`SWITCHES 登记了全部 ${boolOpts.length - exempt.size} 个布尔开关`);
    }
  }
  {
    const forbidden = SWITCHES.filter((x) => x.kind === SWITCH_CLASS.FORBIDDEN);
    const optKeys = new Set(OPTIONS.map((o) => o.key));
    const leaked = forbidden.filter((x) => optKeys.has(x.key));
    if (leaked.length) bad(`FORBIDDEN 开关竟有命令行入口: ${leaked.map((x) => x.key).join(', ')}`);
    else ok(`FORBIDDEN 档 ${forbidden.length} 个开关均无命令行入口`);
  }
  {
    const auditable = SWITCHES.filter((x) => x.kind === SWITCH_CLASS.AUDITABLE);
    const noEvidence = auditable.filter((x) => !x.evidence);
    if (noEvidence.length) bad(`AUDITABLE 开关未说明关闭后痕迹: ${noEvidence.map((x) => x.key).join(', ')}`);
    else ok(`AUDITABLE 档 ${auditable.length} 个开关均声明了可观测痕迹`);
  }
  {
    const sc = readFileSync(join(ROOT, 'tools/self-check.mjs'), 'utf8');
    if (/process\.exit\(3\)/.test(sc)) ok('self-check 跳过验收时以退出码 3 留痕');
    else bad('self-check 跳过验收时未以退出码 3 留痕（仅文案不算可察觉）');
  }

  // ── self-check 必须覆盖 CI 的每一条命令 ──────────────────
  //
  // ★ 2026-11-13 实证：CI 含 check-publish，而 self-check 不含。
  // 结果：连续 3 个提交 CI 红在该步，本地「一键自检」却全绿——
  // 因为本地跑的命令集 ≠ CI 的命令集。
  //
  // 「我没测到」与「它没问题」症状同形。这条检查把两者钉死：
  // CI 加的每一步，self-check 里必须有对应调用，否则判 FAIL。
  // 不给「以后再补」留口子 —— 漂移当场红。
  {
    const wfPath = join(ROOT, '.github/workflows/ci.yml');
    if (!existsSync(wfPath)) {
      bad('缺少 .github/workflows/ci.yml（无法核对 self-check 与 CI 是否等价）');
    } else {
      const wf = readFileSync(wfPath, 'utf8');
      const scText = readFileSync(join(ROOT, 'tools/self-check.mjs'), 'utf8');
      // CI 里被直接执行的 node 脚本（排除 self-check 自身，避免自指）
      const invoked = new Set();
      for (const m of wf.matchAll(/node\s+([\w./-]+\.mjs)/g)) {
        const f = m[1];
        if (!f.includes('self-check')) invoked.add(f);
      }
      const missing = [...invoked].filter((f) => !scText.includes(f));
      if (missing.length) {
        bad(`CI 跑了但 self-check 未覆盖: ${missing.join(', ')}（本地全绿 ≠ CI 全绿）`);
      } else {
        ok(`self-check 覆盖了 CI 的全部 ${invoked.size} 个脚本命令`);
      }
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'fail');
for (const f of findings) {
  if (f.level === 'fail') console.log('  FAIL  ' + f.msg);
  else console.log('  ok    ' + f.msg);
}
console.log('');
console.log(`检查项 ${findings.length} · 通过 ${findings.length - fails.length} · 漂移 ${fails.length}`);
process.exit(fails.length ? 1 : 0);