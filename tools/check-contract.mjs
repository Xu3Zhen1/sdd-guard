// 契约漂移检测：把「ICD 写的」「contract.mjs 声明的」「代码实际做的」三者逐项比对。
//
// 只写文档会让 ICD 变成第二份 README；只写常量会让代码与文档分叉。
// 这个脚本是三者之间的差值检测器：任何一项对不上就 exit 1 并指出具体差异。
//
// 用法：node tools/check-contract.mjs
// 退出码：0 = 无漂移；1 = 有漂移（逐条打印）

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writableTempRoot } from '../lib/temp.mjs';

import { VERSION, STATUSES, EXIT_CODES, OPTIONS, CONFIG_DEFAULTS, REPEATABLE_KEYS, PROFILE_NAMES, EVIDENCE_KEYS, rulesForProfile, SWITCHES, SWITCH_CLASS } from '../lib/contract.mjs';
import { EXIT as RUNNER_EXIT } from '../lib/runner.mjs';
import { REPEATABLE_KEYS as ARGS_REPEATABLE } from '../lib/args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICD = join(ROOT, 'docs', 'ICD.md');
const RULES = join(ROOT, 'lib', 'rules.mjs');
const README = join(ROOT, 'README.md');

/**
 * 规格要求必须常跑的七套专项（审计 A07 / task-2）。
 *
 * ★ 这里**必须是一份独立的硬编码清单**，不能从 package.json 反推。
 *   2026-11-13 试过反推，变异负控当场证明了那样是**自证**：
 *   把 q4-5 从 package.json 删掉后，"要求"和"实际"一起消失了 ⇒ 检查照样绿（实测 exit 0）。
 *   而缺陷正是"有人删掉了它"。
 *
 * 三份东西各司其职，互相印证（与本文件其它检查同一形状）：
 *   · 这里  = 规格（谁要求这七套必须常跑）
 *   · package.json scripts.test = 声明（唯一测试入口，人能看懂）
 *   · self-check --print-steps  = 实际（真会被 spawn 的那些步骤）
 * 任意两份对不上就判红。
 *
 * ★ 必须声明在模块顶部：下面的检查在顶层立即执行，放后面会撞 TDZ。
 */
const REQUIRED_SPECIALTY_TESTS = [
  'test/q1-backdoor.test.mjs',
  'test/q2-crossrule.test.mjs',
  'test/q2-value.test.mjs',
  'test/q3-invariant.test.mjs',
  'test/q46-switch.test.mjs',
  'test/q4-5-exit-signal.test.mjs',
  'test/prove-multiroot.mjs',
];

/** 从 package.json 的 scripts.test 读出"声明的唯一测试入口"。 */
function declaredTestFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const raw = pkg.scripts?.test || '';
  return { raw, files: [...new Set([...raw.matchAll(/node\s+([\w./-]+\.mjs)/g)].map((m) => m[1]))] };
}

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

// ── 1. 退出码：contract vs runner vs ICD vs CLI 实际行为 ─────
//
// ★ A08（审计 I-03）：旧实现只比 `['OK','FAIL','CONFIG']` 三个键，
// 于是把 runner 的 `INCOMPLETE` 从 3 改成 1（语法有效）后本检查仍 53/53 全绿 ——
// **遗漏键**本身就是"没检查"，而不是"检查了没问题"。
//
// 现在两层判据：
//   ① 契约层：键集合必须完全相等（不是"包含"），且每个值相等；
//   ② 行为层：真的起子进程跑 cli.mjs，断言 4 个退出码**实际**是 0/1/2/3。
// 只做 ① 会漏掉"常量对了但 CLI 没用它"；只做 ② 会漏掉"CLI 对了但常量表缺键"。
const EXIT_KEYS = ['OK', 'FAIL', 'CONFIG', 'INCOMPLETE'];
{
  const contractKeys = Object.keys(EXIT_CODES).sort().join(',');
  const runnerKeys = Object.keys(RUNNER_EXIT).sort().join(',');
  if (contractKeys === runnerKeys) ok(`退出码键集合 contract 与 runner 完全相同: [${contractKeys}]`);
  else bad(`退出码键集合不一致: contract=[${contractKeys}] runner=[${runnerKeys}]`);

  const missing = EXIT_KEYS.filter((k) => !(k in EXIT_CODES) || !(k in RUNNER_EXIT));
  if (missing.length) bad(`退出码缺少必需键: ${missing.join(', ')}（四态必须齐备）`);

  // 值比较：逐个键，且**PIN 写死规格值** —— 不引用被测常量做期望值，
  // 否则把两边一起改错时本判据恒真。
  const SPEC = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 3 };
  for (const [k, want] of Object.entries(SPEC)) {
    if (EXIT_CODES[k] === want && RUNNER_EXIT[k] === want) ok(`退出码 ${k}=${want}（contract 与 runner 均符合规格）`);
    else bad(`退出码 ${k} 漂移: 规格=${want} contract=${EXIT_CODES[k]} runner=${RUNNER_EXIT[k]}`);
  }

  for (const [k, v] of Object.entries(EXIT_CODES)) {
    if (icd.includes(`\`${v}\``)) ok(`ICD 记录了退出码 ${v}(${k})`);
    else bad(`ICD 未记录退出码 ${v}(${k})`);
  }

  // ④ 行为层：真实子进程。三个不可区分的输入必须给出三种不同退出码。
  const behaviour = probeExitCodes(ROOT);
  if (behaviour.error) bad(`无法实测 CLI 退出码: ${behaviour.error}`);
  else {
    for (const [label, want, got] of behaviour.cases) {
      if (got === want) ok(`CLI 实测退出码 ${label} = ${got}`);
      else bad(`CLI 实测退出码 ${label} 应为 ${want}，实际 ${got}`);
    }
    // 负控：3 与 1 必须**可区分**（把 INCOMPLETE 并回 FAIL 时这条会红）
    const inc = behaviour.cases.find((c) => c[0] === 'INCOMPLETE')?.[2];
    const fl = behaviour.cases.find((c) => c[0] === 'FAIL')?.[2];
    if (inc !== undefined && fl !== undefined && inc !== fl) ok(`INCOMPLETE(${inc}) 与 FAIL(${fl}) 在进程边界上可区分`);
    else bad(`INCOMPLETE 与 FAIL 在进程边界上不可区分（同为 ${inc}）—— 两种失败信号又被合流了`);
  }
}

/**
 * 实测 cli.mjs 的四个退出码（真实子进程，stdio 重定向到文件，不用 PIPE）。
 *
 * 四个输入分别对应：OK（正常运行，无硬失败）/ FAIL（--strict 下有 MANUAL）/
 * CONFIG（未知子命令）/ INCOMPLETE（覆盖率不足）。
 * 空 change 目录在默认情况下不报 fail，所以 OK 与 INCOMPLETE 用同一目录、只差 `--min-coverage`，
 * 这样两者的差异**只能**来自覆盖率分流 —— 是干净的单因子对照。
 */

function probeExitCodes(root) {
  let tmp;
  try {
    tmp = mkdtempSync(join(writableTempRoot(), 'cc-exit-'));
    const change = join(tmp, 'changes', 'empty-one');
    mkdirSync(change, { recursive: true });
    const cfg = join(tmp, 'guard.config.json');
    writeFileSync(cfg, JSON.stringify({
      maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1,
    }));
    const run = (args) => {
      const log = join(tmp, 'out.txt');
      const r = spawnSync(`node cli.mjs ${args} > "${log}" 2>&1`, { cwd: root, shell: true, stdio: 'inherit' });
      return r.status === null ? -1 : r.status;
    };
    const base = `check --change "${change}" --repo "${tmp}" --config "${cfg}"`;
    const cases = [
      ['OK', 0, run(base)],
      ['FAIL', 1, run(`${base} --profile process --strict`)],
      ['CONFIG', 2, run('nosuchsubcommand')],
      ['INCOMPLETE', 3, run(`${base} --min-coverage 0.8`)],
    ];
    return { cases };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
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
  // ★ A08（审计 I-02 实证）：旧实现是 `scText.includes(f)` ——
  //   把 self-check 里 `steps.push(run('publish', …))` 那一行**整行注释掉**后，
  //   脚本名仍然以字符串形式留在注释里，于是 check-contract 仍报「覆盖了 CI 的全部 2 个脚本」，
  //   而 self-check 实际已经少跑一步（9/9 exit 0）。**字符串出现 ≠ 语句执行。**
  //
  //   修法不是把正则写得更聪明（注释、死分支、条件路径都还能骗过正则），
  //   而是**让 self-check 报出自己的执行清单**：`--print-steps` 输出的每一项
  //   都来自真正会被 spawn 的 step 对象；注释掉 push，这一项就不在清单里。
  //   检查从此比对的是**数据**，不是文本。
  //
  //   同时 CI 侧也不再对整份 yaml 跑正则：先**结构化解析** run 步骤、
  //   剔除 yaml 注释行（行首/前置空白的 `#`，不误删字符串内的 `#`），
  //   再取其中真正被执行的 node 脚本。
  checkCiEquivalence();
}

/**
 * CI 等价性总入口。拆成四个子函数是为了守住 KISS-C1（≤3 层）——
 * 这段判断若嵌套写在一起会到 6 层，判据会先判它自己红。
 */
function checkCiEquivalence() {
  const wfPath = join(ROOT, '.github/workflows/ci.yml');
  if (!existsSync(wfPath)) {
    bad('缺少 .github/workflows/ci.yml（无法核对 self-check 与 CI 是否等价）');
    return;
  }
  const ciScripts = extractCiNodeScripts(readFileSync(wfPath, 'utf8'));
  if (ciScripts.error) {
    bad(`无法解析 ci.yml 的 run 步骤: ${ciScripts.error}`);
    return;
  }
  if (ciScripts.scripts.length === 0) {
    bad('ci.yml 里解析出 0 个 node 脚本 —— 要么 workflow 空了，要么解析器失配（两种都不能算通过）');
    return;
  }
  const steps = selfCheckSteps();
  if (steps.error) {
    bad(`无法取得 self-check 的执行清单: ${steps.error}`);
    return;
  }
  const executed = new Set(steps.list.flatMap((s) => s.invokes));
  checkCiCoveredBy(ciScripts.scripts, executed);
  checkManifestHealthy(steps.list);
  checkSpecialtyRegistered(executed);
}

/** CI 跑的每个脚本，都必须在 self-check 的执行清单里。 */
function checkCiCoveredBy(ciScripts, executed) {
  const missing = ciScripts.filter((f) => !executed.has(f));
  if (missing.length) {
    bad(`CI 跑了但 self-check 的执行清单里没有: ${missing.join(', ')}（本地全绿 ≠ CI 全绿）`);
    return;
  }
  ok(`self-check 执行清单覆盖了 CI 的全部 ${ciScripts.length} 个 node 脚本: [${ciScripts.join(', ')}]`);
}

/**
 * 清单自身的健康度：项数与"每项是否有断言内容"。
 * 没有这一条，「把清单删到只剩 1 项」会让上面的覆盖检查变成恒真。
 */
function checkManifestHealthy(list) {
  const empty = list.filter((s) => !s.invokes || s.invokes.length === 0);
  if (list.length < 10) {
    bad(`self-check 执行清单只有 ${list.length} 项（应有 10 项以上；清单被删空会让等价性检查恒真）`);
    return;
  }
  ok(`self-check 执行清单共 ${list.length} 项，其中 ${empty.length} 项不引用任何脚本（自定义检查步）`);
}

/**
 * 三份清单互相印证：规格（本文件）· 声明（package.json）· 实际（self-check 清单）。
 *
 * 任意两份对不上就判红。**只有"实际"这一份是运行时数据**，另两份是独立事实来源，
 * 所以不能用其中一份去推导另一份 —— 那样删掉一处会让两边一起消失，检查恒真。
 */
function checkSpecialtyRegistered(executed) {
  // ① 规格 vs 实际：规格要求的，必须真的会被执行
  const notExecuted = REQUIRED_SPECIALTY_TESTS.filter((f) => !executed.has(f));
  if (notExecuted.length) {
    bad(`规格要求的专项未进入 self-check 常跑清单: ${notExecuted.join(', ')}（专项存在 ≠ 专项是门禁）`);
  } else {
    ok(`规格要求的 ${REQUIRED_SPECIALTY_TESTS.length} 套专项全部在 self-check 执行清单中`);
  }
  // ② 规格 vs 声明：唯一测试入口（package.json scripts.test）也必须包含它们
  const declared = new Set(declaredTestFiles().files);
  const notDeclared = REQUIRED_SPECIALTY_TESTS.filter((f) => !declared.has(f));
  if (notDeclared.length) {
    bad(`package.json 的 scripts.test（唯一测试入口）缺少专项: ${notDeclared.join(', ')}`);
  } else {
    ok(`package.json scripts.test 声明了全部 ${REQUIRED_SPECIALTY_TESTS.length} 套专项`);
  }
  // ③ 文件必须真实存在（防"清单写了但文件被删"）
  const gone = REQUIRED_SPECIALTY_TESTS.filter((f) => !existsSync(join(ROOT, f)));
  if (gone.length) bad(`清单引用的专项文件不存在: ${gone.join(', ')}`);
}

/**
 * 从 ci.yml 结构化抽取"真正会被执行的 node 脚本"。
 *
 * 三条规则，各自对应一种旧实现的漏检形态：
 *   ① **剔除注释**：yaml 的注释是行首（允许前导空白）的 `#`。
 *      旧实现对整份文本跑 `/node\s+([\w./-]+\.mjs)/g`，注释掉的一行照样被数进来。
 *      注意只在**行首**判 `#`：`run: echo "a # b"` 里的 `#` 不是注释。
 *   ② **只看 run 步骤**：`uses:`、`env:`、注释块里的脚本名不算"会被执行"。
 *   ③ **保留多行 `run: |` 的连续性**：块内每一行都是命令，也要逐行剔注释。
 *
 * 已知边界（写在这里而不是假装没有）：本函数不解析 yaml 的完整语法（无依赖），
 * 用缩进 + 关键字的行级状态机。`if:` 条件、matrix 展开、shell 差异都不展开 ——
 * 所以结论只能是"同步了当前的脚本步骤"，不是"等价于 CI 的六环境矩阵"。
 */
function extractCiNodeScripts(text) {
  try {
    const state = { scripts: [], inRun: false, runIndent: -1 };
    for (const raw of text.split(/\r?\n/)) consumeYamlLine(state, raw);
    return { scripts: [...new Set(state.scripts)] };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 消费一行 yaml，维护 "当前是否在 run 块内" 的状态。
 *
 * 抽成函数是为了守住 KISS-C1：内联写法会到 5 层嵌套。
 * 状态机本身很简单：在 run 块里就收集命令；遇到缩进回退就出块；遇到 `run:` 就入块。
 */
function consumeYamlLine(state, raw) {
  const line = stripYamlComment(raw);
  if (!line.trim()) return;
  const indent = line.match(/^[ \t]*/)[0].length;
  const trimmed = line.trim();
  if (state.inRun) {
    if (indent > state.runIndent) {
      collectNodeScripts(trimmed, state.scripts);
      return;
    }
    state.inRun = false;
  }
  const m = trimmed.match(/^(?:-\s+)?run:\s*(.*)$/);
  if (!m) return;
  const inline = m[1].trim();
  if (inline && !/^\||^>/.test(inline)) collectNodeScripts(inline, state.scripts);
  state.inRun = true;
  state.runIndent = indent;
}

/** 去掉 yaml 行注释：只在行首（可含前导空白）判定，避免误删字符串内的 `#`。 */
function stripYamlComment(line) {
  return /^\s*#/.test(line) ? '' : line;
}

/** 从一条命令里抽 node 脚本路径（排除 self-check 自身，避免自指）。 */
function collectNodeScripts(command, into) {
  for (const m of command.matchAll(/\bnode\s+(?:--[\w-]+\s+)*([\w./-]+\.mjs)/g)) {
    if (!m[1].includes('self-check')) into.push(m[1]);
  }
}

/**
 * 取得 self-check 的真实执行清单（`--print-steps`）。
 *
 * 这一步是 A08 修复的核心：**不读源码文本，问它要数据**。
 */
function selfCheckSteps() {
  try {
    const tmp = mkdtempSync(join(writableTempRoot(), 'cc-steps-'));
    const out = join(tmp, 'steps.json');
    const r = spawnSync(`node tools/self-check.mjs --print-steps > "${out}" 2>&1`, {
      cwd: ROOT, shell: true, stdio: 'inherit',
    });
    if (r.status !== 0) {
      return { error: `--print-steps 退出码 ${r.status}（期望 0）` };
    }
    const list = JSON.parse(readFileSync(out, 'utf8'));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!Array.isArray(list)) return { error: '--print-steps 输出不是数组' };
    return { list };
  } catch (e) {
    return { error: e.message };
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