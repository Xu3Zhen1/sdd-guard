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

import { VERSION, STATUSES, EXIT_CODES, OPTIONS, CONFIG_DEFAULTS, CONFIG_SCHEMA, REPEATABLE_KEYS, PROFILE_NAMES, EVIDENCE_KEYS, rulesForProfile, SWITCHES, SWITCH_CLASS } from '../lib/contract.mjs';
import { EXIT as RUNNER_EXIT } from '../lib/runner.mjs';
import { REPEATABLE_KEYS as ARGS_REPEATABLE } from '../lib/args.mjs';
import { stripComments, scanCodeRoots } from '../lib/code.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICD = join(ROOT, 'docs', 'ICD.md');
const RULES = join(ROOT, 'lib', 'rules.mjs');
const README = join(ROOT, 'README.md');
const DESIGN_RATIONALE = join(ROOT, 'docs', 'DESIGN-RATIONALE.md');

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

/**
 * 生成「README 分档计数漂移」的诊断文本（2026-11-16，第 3 项）。
 *
 * 单独成函数的原因：内联会形成 `for → if/else → if/else` 四层嵌套，
 * 本项目的 KISS-C1 自举判据会当场判红（实测：`check-contract.mjs:323=4`）。
 * **判据抓得对** —— 这段"先看总数对不对、再看机器/人工数"的分支值得单独命名。
 *
 * 为什么要区分两种失败：
 *   · 总数对、机器/人工数不对 ⇒ 是**分类错误**（某条规则的 decidability 改了）；
 *   · 总数都不对 ⇒ 是**没写**或**规则数量变了**。
 *   两种修法不同，所以诊断必须分开。
 */
function describeCountDrift(name, real, claims) {
  const sameTotal = claims.find((c) => c.total === real.total);
  if (sameTotal) {
    return `README ${name} 档的机器/人工数漂移: README=${sameTotal.machine}+${sameTotal.manual} 实际=${real.machine}+${real.manual}`;
  }
  return `README 未声明 ${name} 档计数（实际 ${real.total} = ${real.machine} 机器 + ${real.manual} 人工）`;
}

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
    for (const c of behaviour.cases) {
      // ★ `code === -1` 表示**命令根本没执行**，与"退出码不符"是两种失败，必须分开报：
      //   前者意味着这条判据整体无效（探针/环境坏了），后者意味着 CLI 行为漂移。
      if (c.code === -1) bad(`CLI 实测退出码 ${c.label} 无法测得: ${c.why} —— 这条判据本次无效`);
      else if (c.code === c.want) ok(`CLI 实测退出码 ${c.label} = ${c.code}`);
      else bad(`CLI 实测退出码 ${c.label} 应为 ${c.want}，实际 ${c.code}`);
    }
    // 负控：3 与 1 必须**可区分**（把 INCOMPLETE 并回 FAIL 时这条会红）
    const inc = behaviour.cases.find((c) => c.label === 'INCOMPLETE')?.code;
    const fl = behaviour.cases.find((c) => c.label === 'FAIL')?.code;
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

/**
 * 跑一条 CLI 命令，把结果分类成「真实退出码」或「无法测得」。
 *
 * ★ 2026-11-16 实测发现的假绿（见 `probeExitCodes` 的注释）：
 *   原实现 `r.status === null ? -1 : r.status` 的 `null` 分支**几乎永不命中** ——
 *   `cli.mjs` 不存在时 spawn 返回 **status=1**，与真实 FAIL 同形。
 *   于是 `FAIL` 那条判据（期望 1）在命令从未执行的情况下仍报 ok。
 *
 * 修法：**证明"命令真的执行了"** —— 输出文件必须存在、非空，
 * 且不含解释器级失败特征。因为**子进程失败与目标失败在退出码上同形**。
 *
 * 单独成函数的原因：内联会让 `probeExitCodes` 里出现 `try/if` 四层嵌套，
 * 本项目的 KISS-C1 自举判据会当场判红（实测：`check-contract.mjs:190=4`）。
 *
 * @returns {{code:number, why:string}} `code === -1` 表示无法测得，`why` 给出原因
 */
function runAndClassify(root, tmp, args, spawnSync, readFileSync) {
  const log = join(tmp, 'out.txt');
  const r = spawnSync(`node cli.mjs ${args} > "${log}" 2>&1`, { cwd: root, shell: true, stdio: 'inherit' });
  if (r.status === null) return { code: -1, why: 'spawn 失败（status=null）' };
  let out = '';
  try {
    out = readFileSync(log, 'utf8');
  } catch {
    return { code: -1, why: '输出文件未生成' };
  }
  if (!out.trim()) return { code: -1, why: '命令无任何输出（疑似未真正执行）' };
  if (/Cannot find module|ENOENT|is not recognized as an internal|command not found/i.test(out)) {
    return { code: -1, why: '解释器/命令未找到（cli.mjs 可能不存在）' };
  }
  return { code: r.status, why: '' };
}

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
    /**
     * 跑一条命令，返回真实退出码；**命令根本没跑起来时返回 -1**。
     *
     * ★ 2026-11-16（第 1 项 · 子进程类判据变异体检）实测发现的缺陷：
     *   原实现是 `r.status === null ? -1 : r.status` —— 那个 `null` 分支**几乎永远不命中**。
     *   实测：`cli.mjs` 不存在时，无论 `shell:true` 还是 `shell:false`，
     *   spawn 都返回 **status=1**（不是 null）。
     *
     *   后果按期望值分岔：
     *     · 期望 ≠ 1（OK=0 / CONFIG=2 / INCOMPLETE=3）⇒ 侥幸红；
     *     · **期望 = 1（FAIL）⇒ 命令从未执行，判据却报 ok** ⇒ **假绿**。
     *   实测复现：把 `cli.mjs` 改名藏起来，输出里仍有
     *   `ok  CLI 实测退出码 FAIL = 1`。
     *
     *   修法：**不看 status 是否为 null，而是看文件是否存在 + 输出里有没有解释器的报错特征**。
     *   更稳的做法是"先证明这条命令真的执行了"：要求输出文件非空，
     *   且不含 `Cannot find module` / `ENOENT` / `not recognized` 这类特征。
     *   这比判断 status 可靠 —— 因为**子进程失败与目标失败在退出码上同形**。
     */
    const run = (args) => runAndClassify(root, tmp, args, spawnSync, readFileSync);
    /**
     * 收集一条用例。`code` 为 -1 时**单独成一条失败**，
     * 不与"期望值不符"混为一谈 —— 因为这两种失败修法不同：
     *   -1 是探针/环境坏了（可能整条判据无效）；
     *   数值不符是 CLI 行为漂移。
     */
    const one = (label, want, args) => {
      const { code, why } = run(args);
      return { label, want, code, why };
    };
    const base = `check --change "${change}" --repo "${tmp}" --config "${cfg}"`;
    const cases = [
      one('OK', 0, base),
      one('FAIL', 1, `${base} --profile process --strict`),
      one('CONFIG', 2, 'nosuchsubcommand'),
      one('INCOMPLETE', 3, `${base} --min-coverage 0.8`),
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

/**
 * 从 ICD 里解析**配置表**（`| 键 | 类型 | 默认 | 影响 |`）。
 *
 * ★ 必须限定范围。第一版扫全篇取"首格是反引号包裹的键"，反向检查立刻误报 5 个：
 *   `tests`/`mutation`/`drift`（来自**证据键**表）、`art`（来自**制品**表）、
 *   以及 `maxDiffLines`（另一张"预算字段"表也有它）。
 *
 *   教训与契约体检里 `--profile` 那次同族 —— **解析器必须先限定范围，再谈结论**。
 *   扫全篇再判断"多余"，等于把别的表格当成本表。
 *
 * @returns {Map<string, {type:string, default:string}>}
 */
function parseConfigTable(icdText) {
  const out = new Map();
  let inTable = false;
  for (const line of icdText.split('\n')) {
    if (/\|\s*键\s*\|\s*类型\s*\|\s*默认\s*\|\s*影响\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) {
      inTable = false; // 表格段结束
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue; // 分隔行
    /**
     * ★ 必须先处理**转义竖线 `\|`**。
     *
     * 实测踩过：`| \`testNesting\` | int \| null | \`null\` | … |`
     * 天真的 `[^|]*` 会把 `int \` 当类型、把 `null` 当默认值 ——
     * 于是 `docDefaultValue('null')` 恰好等于代码里的 `null`，
     * **"把默认值从 null 改成 6"这个变异完全无法被察觉**。
     *
     * 修法：先把 `\|` 换成占位符（U+0001）再按 `|` 切分，切完再还原。
     * 这样"类型列里的转义竖线"不会破坏列边界。
     */
    const cells = line
      .replace(/\\\|/g, '\u0001')
      .split('|')
      .map((c) => c.replace(/\u0001/g, '|').trim());
    // cells[0] 是行首空串，cells[1]=键，cells[2]=类型，cells[3]=默认
    const keyM = (cells[1] || '').match(/^`([A-Za-z]\w*)`$/);
    if (keyM) out.set(keyM[1], { type: cells[2] || '', default: cells[3] || '' });
  }
  return out;
}

/** 把代码里的默认值渲染成与文档同年份的写法。 */
function renderDefault(v) {
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 从 ICD"默认"单元格里抽出真正表示值的部分。
 *
 * 形如：`` `3` `` / `` `[]` `` / `` `null` `` / `（无默认；**未配置 = 未启用**）`
 */
function docDefaultValue(cell) {
  const backtick = String(cell).match(/`([^`]+)`/);
  if (backtick) return backtick[1].trim();
  if (/无默认/.test(cell)) return '(无默认)';
  return String(cell).trim();
}

// ── 4. 配置键与默认值：contract vs rules.mjs 的 `??` 字面量 vs ICD ─
{
  /**
   * ★ 完整性以 `CONFIG_SCHEMA` 为依据（旧实现遍历 `CONFIG_DEFAULTS`，取消 `maxDiffLines`
   * 默认值后该键自动退出检查 —— 「消掉一项检查，还显示绿」）。
   * 且须**先去注释**再搜源码：注释里含 `ctx.cfg.maxDiffLines ?? 400`，不去注释会报假红。
   * 只认**首格恰好是键名**的表格行：ICD 另有 `| 预算字段（…） |`，更松的写法会让负控红不了。
   */
  const schemaKeys = Object.keys(CONFIG_SCHEMA);
  const rulesCode = stripComments(rules);
  const documented = new Set();
  for (const row of icd.split('\n').filter((l) => l.trim().startsWith('|'))) {
    const firstCell = (row.split('|')[1] || '').trim();
    const m = firstCell.match(/^`([^`]+)`$/);
    if (m) documented.add(m[1]);
  }
  const missingInIcd = schemaKeys.filter((k) => !documented.has(k));
  if (missingInIcd.length) bad(`ICD 配置表未登记配置键: ${missingInIcd.join(', ')}（仅在正文提及名字不算登记）`);
  else ok(`ICD 配置表登记了全部 ${schemaKeys.length} 个配置键（依据 CONFIG_SCHEMA，比对表格首列）`);

  const orphanDefaults = Object.keys(CONFIG_DEFAULTS).filter((k) => !(k in CONFIG_SCHEMA));
  if (orphanDefaults.length) bad(`CONFIG_DEFAULTS 有 schema 未声明的键: ${orphanDefaults.join(', ')}`);
  else ok(`CONFIG_DEFAULTS 全部键均在 CONFIG_SCHEMA 内（无孤儿默认值）`);

  for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
    if (typeof expected === 'object') continue; // 对象/数组型没有 `??` 字面量可对
    const m = rulesCode.match(new RegExp(`cfg\\.${key}\\s*\\?\\?\\s*([\\w.-]+)`));
    if (!m) {
      bad(`rules.mjs 里找不到 cfg.${key} 的默认值读取（契约声明默认 ${JSON.stringify(expected)}）`);
      continue;
    }
    const actual = Number(m[1]);
    if (actual === expected) ok(`配置默认值 ${key}=${expected}（rules.mjs 实测一致）`);
    else bad(`配置默认值漂移 ${key}: 契约=${expected} 实现=${actual}`);
  }

  // 声明"无默认值"的键：rules.mjs 不得再有该键的 `??`（否则隐式默认值偷偷回来）
  for (const key of schemaKeys) {
    if (key in CONFIG_DEFAULTS) continue;
    if (new RegExp(`cfg\\.${key}\\s*\\?\\?`).test(rulesCode)) bad(`rules.mjs 仍给 ${key} 写了 \`??\` 默认值，但契约声明它无默认值（隐式默认值会偷偷回来）`);
    else ok(`配置 ${key} 无默认值，rules.mjs 里也无 \`??\` 兜底（缺省=未启用）`);
  }

  /**
   * ★ 2026-11-16（契约体检最后一块）：核对 **ICD 表格里写的"默认"列**是否与代码一致。
   *
   * 上面几段核的都是 contract ↔ rules.mjs 的关系，**从没核对过 ICD 文档里的取值**。
   * 于是这族缺陷完全无声：
   *   文档写 `| maxNesting | int | 3 |`，代码里 `CONFIG_DEFAULTS.maxNesting = 4`
   *   ⇒ 名字对得上、取值对不上，出现性检查（上面那段）**照样绿**。
   *
   * 这不是理论风险：使用者会按文档以为默认是 3，而实际跑的是 4，**且他不会去读代码**。
   *
   * ★ 解析必须**限定在配置表内**（第一版扫全篇，反向检查误报 5 个"多余行"——
   *   `tests`/`mutation`/`drift` 来自证据键表、`art` 来自制品表）。
   *   教训与 `--profile` 那次同族：**解析器必须先限定范围，再谈结论**。
   */
  const configTable = parseConfigTable(icd);
  for (const [key, expected] of Object.entries(CONFIG_DEFAULTS)) {
    const row = configTable.get(key);
    if (!row) continue; // 缺行已由上面 `missingInIcd` 报过，不重复报
    const docVal = docDefaultValue(row.default);
    const realVal = renderDefault(expected);
    if (docVal === realVal) ok(`ICD 写的默认值 ${key}=${realVal} 与代码一致`);
    else bad(`ICD 写的默认值漂移 ${key}: 文档=${JSON.stringify(docVal)} 代码=${JSON.stringify(realVal)}`);
  }

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

  /**
   * ★ 2026-11-18 加：**逐条 id 必须出现在 README 的逐条清单里**。
   *
   * 为什么这条必须补（实测踩过）：
   *   上面那个正则只核「N 条 = M 机器 + K 人工」这个**计数串**。
   *   README 顶部写 27 = 19 + 8（对的），分档计数也对，
   *   但**逐条表格停在 19 条** —— ACCEPT-E1..E4、ARCH-06、ARCH-06-M、ARCH-07、ARCH-07-M
   *   这 8 个 id 在 README 里**一次都没出现过**，而门禁全绿。
   *
   *   ⇒ 计数对 ≠ 枚举完备。这正是本工具自己反复强调的那条：
   *     **报机械计数时必须证明枚举互斥且完备**，否则数字只是"看起来对"。
   *
   * 判据（两条都要成立）：
   *   ① 每个 `id` 都以反引号形式出现在 README 里（避免只出现前缀被误判）
   *   ② README 里不得出现**不存在的** rule id（防清单里留了已删除的规则）
   */
  const idMentioned = (id) => new RegExp('`' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`').test(readme);
  const missingIds = RULES.filter((r) => !idMentioned(r.id)).map((r) => r.id);
  if (missingIds.length) {
    bad(`README 逐条清单缺 ${missingIds.length} 条 rule id（计数对不等于枚举完备）: ${missingIds.join(', ')}`);
  } else {
    ok(`README 逐条清单覆盖全部 ${RULES.length} 条 rule id`);
  }

  // 反向：README 里不得出现 RULES 中不存在的 id（防清单陈旧）
  const knownIds = new Set(RULES.map((r) => r.id));
  const candidates = [...readme.matchAll(/`((?:YAGNI|KISS|DRY|DECOUPLE|ACCEPT|DISCIPLINE|ARCH)-[A-Z0-9]+(?:-[A-Z])?)`/g)]
    .map((x) => x[1])
    .filter((id) => !knownIds.has(id));
  const staleIds = [...new Set(candidates)];
  if (staleIds.length) bad(`README 提到 ${staleIds.length} 个不存在的 rule id: ${staleIds.join(', ')}`);
  else ok('README 未提及任何已不存在的 rule id');

  // 档位：两档必须完备、互斥，且 README 必须写出两档的名字与命令
  const proc = rulesForProfile(RULES, 'process');
  const acc = rulesForProfile(RULES, 'acceptance');

  /**
   * ★ 2026-11-18 加：**DESIGN-RATIONALE.md 的数字也必须核**。
   *
   * 为什么（实测踩过）：这份文档 §9 明写「这些数字**由脚本核对**，不是手抄」，
   * 但 `check-contract` 只 `readFileSync(README)`，**根本不打开这个文件**。
   * 于是它自己声明的"由脚本核对"是空话，数字一路停在 23 条 / acceptance 12=10+2，
   * 之后 6 个提交没人碰过，全文 0 次提及 ARCH。
   *
   * ⇒ 文档里的"由脚本核对"必须真的有一条脚本在核；否则就删掉那句话。
   *   这里选前者（让声明成真），判据同 README：总数 + 两档分档数。
   */
  checkDesignRationale({ bad, ok, total, machine, manual, proc, acc });

  /**
   * ★ 2026-11-16（第 3 项 · 契约体检未覆盖面）：**逐档核对 README 的计数声明**。
   *
   * 上面只核对了**总量**（`23 = 17 + 6`），而 README 还声明了**每档各自的数字**：
   *   「四制品判据 … 11 条 = 7 机器 + 4 人工」
   *   「代码级判据 + ACCEPT-E* … 12 条 = 10 机器 + 2 人工」
   *
   * 这两个数字**从来没人核对过**。契约体检时实测它们恰好正确，
   * 但"恰好正确"与"有判据保证正确"是两件事 —— 前者下次加规则就漂了。
   *
   * 实现要点：README 的这两处声明**不在同一行**，所以要按「N 条 = M 机器 + K 人工」
   * 全量抽取，再按**档位规则的机器/人工数**匹配（不按出现顺序 —— 顺序会因排版调整而变）。
   */
  const countRules = (rs) => ({
    total: rs.length,
    machine: rs.filter((r) => r.decidability === 'machine').length,
    manual: rs.filter((r) => r.decidability === 'manual').length,
  });
  const claims = [...readme.matchAll(/(\d+)\s*条\s*=\s*(\d+)\s*机器\s*\+\s*(\d+)\s*人工/g)].map((x) => ({
    total: Number(x[1]),
    machine: Number(x[2]),
    manual: Number(x[3]),
    raw: x[0],
  }));
  for (const [name, rs] of [['process', proc], ['acceptance', acc]]) {
    const real = countRules(rs);
    const hit = claims.find(
      (c) => c.total === real.total && c.machine === real.machine && c.manual === real.manual,
    );
    if (hit) ok(`README 写明了 ${name} 档计数: ${hit.raw}`);
    else bad(describeCountDrift(name, real, claims));
  }

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

  /**
   * ★ 2026-11-15 修（父键名盲区）。
   *
   * 旧实现只断言 ICD 里出现过**裸字段名** `command` / `exitCode` / `sha256`：
   *   if (icd.includes('`command`')) ok(...)
   * 于是 ICD 把父键写成 `meta.provenance`（代码实际是 `meta.producers`）时，
   * 三个裸字段名照样都在，**67/67 全绿**。
   *
   * 这是「`icd.includes` 太松」这一族的第二次复发：第一次是配置键
   * （ICD 里另有一行「预算字段（maxDiffLines/dupMinChars）」让负控永远红不了），
   * 改成「表格首格恰好等于键名」才修好。同一个教训在另一个位置又出现了一次。
   *
   * 现在的判据：**父键名与子字段名必须成对出现**。
   * `PROVENANCE_PARENT` 是父键名的唯一真源，必须与 `lib/evidence.mjs`
   * 实际产出、`lib/rules.mjs` 实际读取保持同一字符串。
   */
  const PROVENANCE_PARENT = 'meta.producers';
  const PROV_SUBFIELDS = ['command', 'exitCode', 'sha256'];

  /**
   * ★ 判据必须是「结构定义」而不是「文本里提到过」。
   *
   * 第一版写成 `icd.includes(PROVENANCE_PARENT)`，负控立刻暴露问题：
   * **删掉那行正式定义后检查仍然通过** —— 因为我自己写的"命名坑"说明段里
   * 也提到了 `meta.producers`。这正是本项目反复踩的坑：
   * **「文本里出现过」≠「文档定义了它」**。
   *
   * 现在的判据：父键名必须出现在**定义语境**里，三种任一即可：
   *   ① 表格行（以 `|` 开头）—— 字段表 / 信任边界表
   *   ② 列表项或编号项（以 `- ` / `<n>. ` 开头）—— 字段清单
   *   ③ 反引号包裹的定义句（`` **`meta.producers`** `` 这种加粗定义）
   * 说明段（`>` 引用块）与散文中提到，**不算定义**。
   */
  const definitionLines = icd.split('\n').filter((line) => {
    const t = line.trim();
    if (!t.includes(PROVENANCE_PARENT)) return false;
    if (t.startsWith('>')) return false; // 说明/引用块不算定义
    const isTableRow = t.startsWith('|');
    const isListOrNumbered = /^([-*+]\s|\d+\.\s)/.test(t);
    const isBacktickDefinition = new RegExp('\\*\\*`' + PROVENANCE_PARENT.replace('.', '\\.') + '`\\*\\*').test(t);
    return isTableRow || isListOrNumbered || isBacktickDefinition;
  });
  if (definitionLines.length) {
    ok(`ICD 在 ${definitionLines.length} 处定义语境（表格/清单/加粗定义）中记录了父键 ${PROVENANCE_PARENT}`);
  } else {
    bad(`ICD 没有在定义语境中记录证据父键 ${PROVENANCE_PARENT}（说明段里提到不算定义）`);
  }

  for (const k of PROV_SUBFIELDS) {
    // 两个条件同时成立才算过：父键有**定义**，且子字段名在同一份文档里被反引号标注。
    if (definitionLines.length && icd.includes(`\`${k}\``)) {
      ok(`ICD 记录了 ${PROVENANCE_PARENT} 的子字段 ${k}`);
    } else {
      bad(`ICD 未在 ${PROVENANCE_PARENT} 下记录子字段 ${k}`);
    }
  }
  // 反向：ICD 里不得出现已被证伪的父键名（防止改回来）。
  /**
   * ★ 只查**非说明性**的出现。
   *
   * 第一版直接 `icd.includes('meta.provenance')` ⇒ 我自己写的"命名坑"说明段
   * （正文里点出「此前四处写作 `meta.provenance`」）立刻把检查判红。
   * 这与本项目 2026-11-13 踩过的「检查器匹配到自己的注释」是同一族：
   * **反例说明必须允许存在，否则就没法在文档里记录"曾经错在哪"。**
   *
   * 判据：逐行扫，排除 `>` 开头（说明块）与含"废弃/此前/曾/命名坑/已修"的行。
   * 剩下的行里若仍有旧父键名 ⇒ 那是真的把错误写法当成正述在用。
   */
  const RETIRED_PARENT_NAMES = ['meta.provenance'];
  const EXPLANATORY = /(废弃|此前|曾经|曾写|命名坑|已修|已改|旧实现|旧写法)/;
  for (const rp of RETIRED_PARENT_NAMES) {
    const offending = icd
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes(rp))
      .filter(({ line }) => !line.trim().startsWith('>') && !EXPLANATORY.test(line));
    if (offending.length) {
      bad(
        `ICD 仍把已废弃的父键 ${rp} 当作正述使用（代码实际为 ${PROVENANCE_PARENT}）：` +
          offending.map((o) => `第${o.no}行`).join('、'),
      );
    } else {
      ok(`ICD 未把废弃父键 ${rp} 当作正述使用（说明性提及不计）`);
    }
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
/**
 * 核对 `docs/DESIGN-RATIONALE.md` 里的判据数字（2026-11-18 加）。
 *
 * ★ 为什么必须有这条（实测踩过）：
 *   该文档 §9 明写「这些数字**由脚本核对**，不是手抄」，
 *   而 `check-contract` 只 `readFileSync(README)`，**根本不打开这个文件**。
 *   于是那句话是空话：数字一路停在「23 条（17+6）」「acceptance 12 = 10+2」，
 *   之后 6 个提交没人碰过它，全文 0 次提及 ARCH。
 *
 *   这与 README 逐条清单漏 8 条同族：**文档声明了某种保证，但没有实现兑现它**。
 *   两种处理：删掉那句声明，或让它成真。这里选后者。
 */
function checkDesignRationale({ bad, ok, total, machine, manual, proc, acc }) {
  let text;
  try {
    text = readText(DESIGN_RATIONALE, 'docs/DESIGN-RATIONALE.md');
  } catch {
    bad('docs/DESIGN-RATIONALE.md 不存在或不可读（该文件自称数字由脚本核对，必须存在）');
    return;
  }
  checkDesignVersionLine({ bad, ok, total, machine, manual }, text);
  checkDesignTable({ bad, ok, total, machine, manual, proc, acc }, text);
}

/** ① 版本行：**版本**：YYYY-MM-DD · 对应 `lib/rules.mjs` N 条规则（M 机器 + K 人工） */
function checkDesignVersionLine({ bad, ok, total, machine, manual }, text) {
  const m = text.match(/对应 `lib\/rules\.mjs`\s*(\d+)\s*条规则（(\d+)\s*机器\s*\+\s*(\d+)\s*人工）/);
  if (!m) { bad('DESIGN-RATIONALE 版本行未按「N 条规则（M 机器 + K 人工）」声明，无法校验'); return; }
  const [t, mac, man] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (t === total && mac === machine && man === manual) ok(`DESIGN-RATIONALE 版本行判据数一致: ${t} = ${mac} + ${man}`);
  else bad(`DESIGN-RATIONALE 版本行漂移: 文档=${t}=${mac}+${man} 实际=${total}=${machine}+${manual}`);
}

/** ②③ §9 表格：规则总数 + 档位分档数 */
function checkDesignTable({ bad, ok, total, machine, manual, proc, acc }, text) {
  const tot = text.match(/\|\s*规则总数\s*\|\s*(\d+)（机器\s*(\d+)\s*\+\s*人工\s*(\d+)）/);
  if (!tot) { bad('DESIGN-RATIONALE §9 缺「规则总数 | N（机器 M + 人工 K）」行，无法校验'); return; }
  const [t, mac, man] = [Number(tot[1]), Number(tot[2]), Number(tot[3])];
  if (t === total && mac === machine && man === manual) ok(`DESIGN-RATIONALE §9 规则总数一致: ${t} = ${mac} + ${man}`);
  else bad(`DESIGN-RATIONALE §9 规则总数漂移: 文档=${t}=${mac}+${man} 实际=${total}=${machine}+${manual}`);
  checkDesignTiers({ bad, ok, total, proc, acc }, text);
}

/** §9 档位行：`process` P = M+H · `acceptance` A = M+H · `all` T */
function checkDesignTiers({ bad, ok, total, proc, acc }, text) {
  const m = text.match(/`process`\s*(\d+)\s*=\s*(\d+)\+(\d+)\s*·\s*`acceptance`\s*(\d+)\s*=\s*(\d+)\+(\d+)\s*·\s*`all`\s*(\d+)/);
  if (!m) { bad('DESIGN-RATIONALE §9 档位行格式不匹配「`process` P = M+H · `acceptance` A = M+H · `all` T」'); return; }
  const doc = {
    proc: { total: +m[1], mac: +m[2], man: +m[3] },
    acc: { total: +m[4], mac: +m[5], man: +m[6] },
    all: +m[7],
  };
  const real = { proc: tierCounts(proc), acc: tierCounts(acc), all: total };
  const same = (d, r) => d.total === r.total && d.mac === r.mac && d.man === r.man;
  if (same(doc.proc, real.proc) && same(doc.acc, real.acc) && doc.all === real.all) {
    ok(`DESIGN-RATIONALE §9 分档计数一致: process ${doc.proc.total}=${doc.proc.mac}+${doc.proc.man} · acceptance ${doc.acc.total}=${doc.acc.mac}+${doc.acc.man} · all ${doc.all}`);
    return;
  }
  bad(`DESIGN-RATIONALE §9 分档计数漂移: 文档 process ${doc.proc.total}=${doc.proc.mac}+${doc.proc.man} / acceptance ${doc.acc.total}=${doc.acc.mac}+${doc.acc.man}；`
    + `实际 process ${real.proc.total}=${real.proc.mac}+${real.proc.man} / acceptance ${real.acc.total}=${real.acc.mac}+${real.acc.man}`);
}

/** 统计一档的 `{total, mac, man}`。 */
function tierCounts(rules) {
  return {
    total: rules.length,
    mac: rules.filter((r) => r.decidability === 'machine').length,
    man: rules.filter((r) => r.decidability === 'manual').length,
  };
}

// ── 8. 扫描收据字段：ICD §2.3 ↔ scanCodeRoots 实际产物（2026-11-18，外部实测 ②）──
checkScanReceipt();

/**
 * 核扫描收据字段：ICD §2.3 的字段表 ↔ `scanCodeRoots` 的实际产物。
 *
 * ★ 为什么必须有这条（2026-11-18 外部实测 ②）：
 *   `vendor` 目录被黑名单静默跳过，937 个 JS 既不进 `candidates` 也不进 `errors`。
 *   修法不是"补一个数字"，而是**让收据结构对称**：凡是没扫的，都必须留下"为什么、多少个"。
 *
 *   只改代码不核文档 ⇒ 下次有人删字段没人知道；
 *   只核文档不真扫 ⇒ 字段可能是空壳（本项目抓过"初始化后从未赋值、恒为 0"的假字段）。
 *   所以两层：① 文档字段集合与实现字段集合**双向相等**；② 真扫一个含 vendor 的夹具，
 *   断言 count / candidates / 不变量都是**写死的规格值**（不引用被测变量，避免自证）。
 */
function checkScanReceipt() {
  const docKeys = documentedReceiptKeys(icd);
  if (!docKeys.length) { bad('ICD §2.3 未声明扫描收据字段表（读不到任何 \`field\` 行）'); return; }
  const real = scanReceiptFixture();
  if (real.error) { bad(`扫描收据夹具执行失败: ${real.error}`); return; }
  const doc = docKeys.slice().sort().join(',');
  const act = Object.keys(real.report).sort().join(',');
  if (doc === act) ok(`扫描收据字段 ICD §2.3 与实际一致: [${act}]`);
  else bad(`扫描收据字段漂移: ICD=[${doc}] 实际=[${act}]`);
  checkReceiptValues(real);
}

/** 从 ICD §2.3 的表格里抽出字段名（只看该节，避免误读别处的表）。 */
function documentedReceiptKeys(text) {
  const start = text.indexOf('### 2.3 扫描收据');
  if (start < 0) return [];
  const next = text.indexOf('\n### ', start + 1);
  const block = next < 0 ? text.slice(start) : text.slice(start, next);
  return [...block.matchAll(/^\|\s*\`([A-Za-z]+)\`\s*\|/gm)].map((m) => m[1]);
}

/** 造一个"1 个正常文件 + 1 个 vendor 文件"的最小夹具，返回真实收据。 */
function scanReceiptFixture() {
  const tmp = mkdtempSync(join(writableTempRoot(), 'cc-receipt-'));
  try {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'a.js'), 'export const a = 1;\n');
    mkdirSync(join(tmp, 'vendor'), { recursive: true });
    writeFileSync(join(tmp, 'vendor', 'b.js'), 'export const b = 1;\n');
    return scanCodeRoots([tmp], { useIgnore: false });
  } catch (e) {
    return { error: e.message };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 断言收据里的数字是规格值（夹具固定：1 个正常 + 1 个 vendor = 物理 2 个源码文件）。 */
function checkReceiptValues({ files, report }) {
  const bl = report.blacklisted;
  if (!bl || typeof bl.count !== 'number') {
    bad('扫描收据缺 blacklisted.count —— 黑名单跳过必须计数，否则又是无声消失');
    return;
  }
  const sum = bl.dirs.reduce((n, d) => n + d.files, 0);
  const first = bl.dirs[0] || {};
  if (bl.count === 1 && sum === 1 && bl.dirs.length === 1 && first.reason === 'builtin') {
    ok('扫描收据 blacklisted 有真值: vendor 计 1 个文件、归因 builtin');
  } else {
    bad(`扫描收据 blacklisted 不是规格值: count=${bl.count} Σ=${sum} dirs=${bl.dirs.length} reason=${first.reason}`);
  }
  if (files.length === 1 && report.candidates === 1 && report.candidates + bl.count === 2) {
    ok('扫描收据不变量成立: candidates 1 + blacklisted 1 = 物理 2 个源码文件');
  } else {
    bad(`扫描收据不变量不成立: files=${files.length} candidates=${report.candidates} blacklisted=${bl.count}（规格 1 + 1 = 2）`);
  }
}

const fails = findings.filter((f) => f.level === 'fail');
for (const f of findings) {
  if (f.level === 'fail') console.log('  FAIL  ' + f.msg);
  else console.log('  ok    ' + f.msg);
}
console.log('');
console.log(`检查项 ${findings.length} · 通过 ${findings.length - fails.length} · 漂移 ${fails.length}`);
process.exit(fails.length ? 1 : 0);
