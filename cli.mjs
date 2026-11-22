#!/usr/bin/env node
// sdd-guard —— 把 YAGNI/KISS/DRY 里可机械判定的部分变成会 FAIL 的检查。
// 退出码: 0=全过, 1=判据判定不合格, 2=输入/配置错误, 3=判据不可信或没跑完
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRules, formatText, summarize, selectRules, EXIT, SIGNAL } from './lib/runner.mjs';
import { RULES } from './lib/rules.mjs';
import { CODE_EXT, scanCodeRoots } from './lib/code.mjs';
import { parseArgs } from './lib/args.mjs';
import { renderHelp, PROFILE_NAMES, EVIDENCE_KEYS, OPTIONS, CONFIG_SCHEMA } from './lib/contract.mjs';
import { missingEvidenceKeys } from './lib/evidence.mjs';
import { compareTree, readTreeIdentity } from './lib/tree.mjs';
import { validateConfig } from './lib/config.mjs';
import { isPlainObject, isNonEmptyString, isRatio } from './lib/values.mjs';

const KNOWN = new Set(OPTIONS.map((o) => o.key));

/**
 * 判断一个选项值是否属于"缺值"。
 *
 * 两种形态都是缺值：
 *   · 单值选项：`--config` 后无值 ⇒ `true`
 *   · **可重复选项**：`--code` 后无值 ⇒ `[true]`（parseArgs 把值归一成数组再累积）
 * 只判 `=== true` 会漏掉第二种 —— 实测裸 `--code` 正是这样绕过校验，
 * 一路走到 `resolve(true)` 抛 TypeError，退出 1 而非承诺的 2。
 */
function hasMissingValue(v) {
  if (v === true) return true;
  return Array.isArray(v) && v.some((x) => x === true);
}

/**
 * 收集参数层问题（A01/A14）。返回问题数组，空 = 通过。
 *
 * 为什么必须在这里集中做，而不是各消费点 `if (x === true)`：
 * 审计实测三种形态：
 *   ① 裸 `--code` ⇒ args.code 为 true ⇒ `resolve(true)` 抛 TypeError ⇒ **exit 1**，
 *      而"输入错误"承诺的是 2。**异常逃逸把输入错误伪装成了质量不合格。**
 *   ② 裸 `--min-coverage` ⇒ `Number(true) === 1` ⇒ 覆盖率下限被静默设成 1。
 *   ③ 拼错 `--min-covergae` ⇒ 未知键静默保存 ⇒ 本该开启的门禁根本没开。
 *
 * 三类都不该靠"记得写对"来避免，必须在执行前统一挡住。
 */
function collectArgProblems(argv, args, strict) {
  const problems = [];

  // ① 未知选项：先给拼写提示，再报未知。
  for (const key of Object.keys(args)) {
    if (key === '_' || KNOWN.has(key)) continue;
    const near = [...KNOWN].filter((k) => levenshtein(k, key) <= 2 || k.startsWith(key) || key.startsWith(k));
    problems.push(`未知选项 --${key}${near.length ? `（是否想写 --${near[0]}？）` : ''}`);
  }

  // ② 缺值：`--code` 后没有值 ⇒ parseArgs 记 true。**这就是缺值，不是布尔真。**
  //    ★ 可重复选项的缺值形态是 `[true]`（parseArgs 先归一为数组再累积），
  //      只判 `=== true` 会漏掉它 —— 实测裸 `--code` 就是这样逃过校验、
  //      在 `resolve(true)` 处抛 TypeError 变成 exit 1（输入错误伪装成质量不合格）。
  for (const o of OPTIONS) {
    if (!o.value) continue; // 布尔选项的 true 是正常值
    if (hasMissingValue(args[o.key])) problems.push(`--${o.key} 缺少取值（应为 ${o.value}）`);
  }

  // ③ 必需项
  if (!isNonEmptyString(args.change) || args.change === true) problems.push('缺少 --change <dir>');

  // ④ 位置参数：`check` 之后再写非选项内容是调用方错误（曾经被静默塞进 _ 数组）。
  //    默认模式只提示（宽松解析是既有契约），--strict-args 下直接失败。
  const stray = args._ || [];
  if (stray.length && strict) problems.push(`多余的位置参数: ${stray.join(' ')}`);

  return problems;
}

/**
 * 计算代码树提示。**不参与退出码**（见调用处注释）。
 *
 * 抽成模块级函数而非内联，原因有二：
 *   ① 内联时 `if (args.json) {} else { if (treeNotice) { if (…) {} } }` 把
 *      cli.mjs 的嵌套推到 4 层，**直接被本项目自己的 KISS-C1 判红**
 *      （spec-probe A04-6 报的正是这一处 —— 判据抓到了我自己刚写的代码）；
 *   ② 判定与渲染分开后，两者都能被单测直接调用，不必起子进程。
 *
 * @returns {{level:string,text:string}|null}  非 acceptance 档或无证据 ⇒ null
 */
function computeTreeNotice({ evidence, profile, repo }) {
  if (!evidence || profile !== 'acceptance') return null;
  return compareTree(evidence.meta && evidence.meta.tree, readTreeIdentity(repo));
}

/**
 * 把树提示渲染成若干行文本。**nil 安全**：null ⇒ 空数组（不打印任何东西）。
 *
 * 为什么单独抽出来：`same` 是唯一不需要"仅作提示"脚注的档位，
 * 这个判断若写在主流程里会再叠一层 if。
 */
function renderTreeNotice(treeNotice) {
  if (!treeNotice) return [];
  const mark = treeNotice.level === 'same' ? '✓' : '⚠';
  const lines = [`  ${mark} 代码树: ${treeNotice.text}`];
  const needsFootnote = treeNotice.level !== 'same' && treeNotice.level !== 'dirty-drift';
  if (needsFootnote) {
    lines.push('     （此项仅作提示，不改变退出码 —— 证据来源认证不在本工具边界内）');
  }
  return lines;
}

/**
 * 警告级问题（不强制的宽松解析遗留）。它们**进 --json 的 trace**，
 * 这样"我拼错了选项"在机器可读结果里也看得见，而不是只留在 stderr 的一行字里。
 *
 * ★ 2026-11-16（契约体检发现）：旧实现 `if (near.length) warnings.push(...)`
 *   **没有 else 分支** —— 找不到相近拼写的未知选项会被**完全静默丢弃**。
 *
 *   这与 `SWITCHES` 里 `strict-args` 的契约直接冲突：
 *   契约写的是「关闭时只校验必需项，**宽松解析仍在 JSON 结果里留 trace**」。
 *   实测：`--not-a-real-flag` 的 `warnings` 是 `[]` —— **契约承诺了 trace，而实际没有**。
 *
 *   这类"承诺了留痕却没留"比"直接报错"更危险：
 *   使用者以为机器看见了那个参数，实际它凭空消失了。
 */
function collectArgWarnings(args) {
  const warnings = [];
  for (const key of Object.keys(args)) {
    if (key === '_' || KNOWN.has(key)) continue;
    const near = [...KNOWN].filter((k) => levenshtein(k, key) <= 2);
    if (near.length) {
      warnings.push(`未知选项 --${key}，是否想写 --${near[0]}？`);
    } else {
      // 没有相近建议也**必须留痕**（契约要求），否则就是静默丢弃。
      warnings.push(`未知选项 --${key} 已被忽略（加 --strict-args 可让它直接失败）`);
    }
  }
  return warnings;
}

/** 编辑距离（只用于拼写提示，长度都很短）。 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

function readJsonFile(p, label) {
  const full = resolve(p);
  if (!existsSync(full)) throw new Error(`${label} 不存在: ${full}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(full, 'utf8'));
  } catch (e) {
    throw new Error(`${label} 不是合法 JSON: ${e.message}`);
  }
  if (!isPlainObject(raw)) throw new Error(`${label} 的顶层必须是 JSON 对象，实际 ${Array.isArray(raw) ? '数组' : typeof raw}`);
  return raw;
}

/**
 * 解析一个 `--code` 路径（2026-11-18）。
 *
 * 绝对路径原样返回；相对路径**优先相对 `--repo`**，不存在才退回 cwd。
 * 详见调用处注释里记录的实测缺陷。
 */
function resolveCodeRoot(p, repo) {
  if (isAbsolute(String(p))) return resolve(String(p));
  if (repo) {
    const underRepo = resolve(repo, String(p));
    // 只有真的存在才采纳，否则会把打错的路径变成"目录不存在"的报错
    if (existsSync(underRepo)) return underRepo;
  }
  return resolve(String(p));
}

/**
 * 校验 `--code` 的每个根（A06）。
 *
 * 契约说 `--code` 是"代码根"，而 self-check 传的是 `cli.mjs` 这个**文件**；
 * `walkCode` 对文件根 readdir 抛错、错误被吞 ⇒ 该根贡献 0 个文件 ⇒
 * **整个 CLI 入口从未被代码级规则扫描过，而报告只说"扫描 14 个文件"**。
 *
 * 现在的契约：目录（递归）或单个源码文件都支持；其余一律 exit 2。
 * "不可读的根"与"根下没有源码"是两件事，不能都报成"扫了 0 个文件"。
 */
function validateCodeRoots(roots) {
  const problems = [];
  for (const p of roots) problems.push(...checkOneCodeRoot(p));
  return problems;
}

/** 校验单个代码根；返回问题数组（空 = 通过）。 */
function checkOneCodeRoot(p) {
  let st;
  try {
    st = statSync(p);
  } catch (e) {
    return [`--code 路径不可访问: ${p}（${e.code || e.message}）`];
  }
  if (st.isFile()) return CODE_EXT.has(extname(p)) ? [] : [
    `--code 指向的文件后缀不在可扫描集合内: ${p}（可扫描: ${[...CODE_EXT].join(' ')}）`,
  ];
  if (!st.isDirectory()) return [`--code 必须是目录或源码文件: ${p}`];
  try {
    readdirSync(p);
    return [];
  } catch (e) {
    return [`--code 目录不可读: ${p}（${e.code || e.message}）`];
  }
}

function loadConfig(p) {
  if (!p) return {};
  const raw = readJsonFile(p, '配置文件');
  const v = validateConfig(raw, CONFIG_SCHEMA);
  if (!v.ok) {
    // 配置非法 ⇒ 退出码 2，且**一次列出全部问题**（修一个跑一次是折磨）。
    const err = new Error(`配置文件有 ${v.errors.length} 处非法:\n  - ${v.errors.join('\n  - ')}`);
    err.isConfigError = true;
    throw err;
  }
  return raw;
}

/**
 * 退出码与信号的唯一决策点。**纯函数**：同样输入必得同样输出，不读全局。
 *
 * 优先级 3 > 1 > 0：判据自己都不可信时，它报的 fail 也不该当作对被测对象的结论。
 *
 * ★ 2026-11-18（外部实测 ④ · 用户裁定方案 A）：`machineTotal === 0` ⇒ 3。
 *   "本次一条机器规则都没有"不是"全过"：8 条 manual 规则逐条实测，
 *   `--only <manual id>` 原先全部 0/0 且退出码 0，CI 会把它读成放行。
 *   判 3 而不是 1：本档没有任何机器判据说"你不合格"；也不是 2：调用本身合法。
 *   ★ 只在 `=== 0` 时触发。`machineTotal > 0 且 covered === 0`（输入不足全 skip）
 *   仍归 `--min-coverage` 管 —— 那是"边写边查"的合法初稿状态，不能一并判死。
 *
 * @param {{summary:{untrusted:number, machineTotal:number}, coverageFail:boolean, hardFail:boolean}} p
 * @returns {{signal:string, exitCode:number}}
 */
export function decideExit({ summary, coverageFail, hardFail }) {
  if (summary.untrusted > 0) return { signal: SIGNAL.UNTRUSTED, exitCode: EXIT.INCOMPLETE };
  if (summary.machineTotal === 0) return { signal: SIGNAL.INCOMPLETE, exitCode: EXIT.INCOMPLETE };
  if (coverageFail) return { signal: SIGNAL.INCOMPLETE, exitCode: EXIT.INCOMPLETE };
  if (hardFail) return { signal: SIGNAL.FAIL, exitCode: EXIT.FAIL };
  return { signal: 'ok', exitCode: EXIT.OK };
}

// 帮助文本由 lib/contract.mjs 生成，不在本文件手写——手写必然与实现漂移。
const HELP = renderHelp();

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === '--help' || cmd === 'help' || args.help) {
    console.log(HELP);
    process.exit(EXIT.OK);
  }
  if (cmd !== 'check') {
    console.error(`未知子命令: ${cmd}\n`);
    console.error(HELP);
    process.exit(EXIT.CONFIG);
  }

  const strictArgs = args['strict-args'] === true;
  const argProblems = collectArgProblems(argv, args, strictArgs);
  // 默认模式只拦"必需项缺失/缺值/未知选项"里会改变结论的那部分；
  // 严格模式全拦。两者的差别在 --json 的 trace 里可见（A14 的可察觉性要求）。
  const blocking = strictArgs ? argProblems : argProblems.filter((p) => !/^未知选项|多余的位置参数/.test(p));
  if (blocking.length) {
    console.error(`参数错误:\n  - ${blocking.join('\n  - ')}`);
    console.error('提示: 加 --strict-args 可让未知选项也直接失败（默认只提示）。');
    process.exit(EXIT.CONFIG);
  }

  let cfg, diff, evidence, changeDir;
  try {
    cfg = loadConfig(args.config && args.config !== true ? args.config : null);
    diff = args.diff && args.diff !== true ? readJsonFile(args.diff, 'diff 文件') : null;
    evidence = args.evidence && args.evidence !== true ? readJsonFile(args.evidence, '证据文件') : null;
    changeDir = resolve(args.change);
    if (!existsSync(changeDir) || !statSync(changeDir).isDirectory()) {
      throw new Error(`change 目录不存在或不是目录: ${changeDir}`);
    }
  } catch (e) {
    console.error(`配置错误: ${e.message}`);
    process.exit(EXIT.CONFIG);
  }

  /**
   * `--repo` 先解析（后续 `--code` 的基准要用它）。
   *
   * ★ 2026-11-18 修（真实外仓库采纳时实测暴露）：
   *   旧实现对 `--code` 一律 `resolve(p)` —— **相对于 cwd**。
   *   于是 `--repo <别的仓库> --code .` 会解析成**当前工作目录**（即 sdd-guard 自己），
   *   扫描结果报「实检 206 个文件」而目标仓库只有 76 个 .js，
   *   且"未检查"清单里出现的是 `sdd-guard/lib/rules.mjs` —— **扫了自家代码**。
   *
   *   这与用户直觉相反（`--code` 是"仓库里的代码根"，应相对 `--repo`），
   *   而且**不报错、只给出错误结论**，属于最坏的一类。
   *
   *   现在的规则：
   *     ① 绝对路径 ⇒ 原样使用
   *     ② 给了 `--repo` 且相对路径在该 repo 下存在 ⇒ 相对 `--repo` 解析
   *     ③ 否则 ⇒ 退回相对 cwd（兼容既有用法）
   *   ②③ 的顺序保证向后兼容：只有当"相对 repo"真的解析得出东西时才优先它。
   */
  const repo = args.repo && args.repo !== true ? resolve(args.repo) : null;
  const codeRoots = (args.code ? (Array.isArray(args.code) ? args.code : [args.code]) : [])
    .map((p) => resolveCodeRoot(p, repo));
  const codeProblems = validateCodeRoots(codeRoots);
  if (codeProblems.length) {
    console.error(`--code 参数错误:\n  - ${codeProblems.join('\n  - ')}`);
    process.exit(EXIT.CONFIG);
  }
  // 扫描收据（A06）：一次扫描、两处复用 —— 执行前判错 + 报告里给候选/已扫/排除原因。
  // ★ repo 已经在上面解析好了：扫描要用它跑 `git check-ignore` 过滤。
  //   若 repo 不可用（未指定 / 不是仓库），`applyGitignore` 会把原因写进收据的 `ignoreReason`，
  //   **不会**静默当成"没有需要过滤的"。
  const scan = scanCodeRoots(codeRoots, { repo });
  const scanErrors = scan.report.errors || [];

  // --profile：未知档位 ⇒ 退出码 2；acceptance 缺证据 ⇒ 退出码 2（不能"无证据也验收通过"）
  const profile = args.profile && args.profile !== true ? String(args.profile) : 'all';
  if (!PROFILE_NAMES.includes(profile)) {
    console.error(`未知档位: ${profile}（可用: ${PROFILE_NAMES.join(' / ')}）`);
    process.exit(EXIT.CONFIG);
  }
  if (profile === 'acceptance' && !evidence) {
    console.error('acceptance 档必须提供 --evidence <file>：验收只能读它没参与生产的证据');
    process.exit(EXIT.CONFIG);
  }
  if (profile === 'acceptance') {
    // 证据不全 ⇒ 调用方错误。不能让缺失的证据键退化成 skip——"没证据"与"证据说不合格"
    // 在退出码上必须区分，否则失败的生产者会被读成"跳过该项、其余通过"。
    const missing = missingEvidenceKeys(evidence, EVIDENCE_KEYS);
    if (missing.length) {
      console.error(`acceptance 档证据不全，缺少: ${missing.join(', ')}`);
      console.error('请用 `node tools/make-evidence.mjs` 生成完整证据（它不写 0 冒充"跑过"）');
      process.exit(EXIT.CONFIG);
    }
  }

  const only = args.only && args.only !== true ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;

  // --only 里有未知 id、或 id 不属于当前档位 ⇒ 调用方错误（退出码 2）。
  // 不得静默变成"0 条规则 ⇒ 全过"：`--only KISS-C1 --profile process` 就是这种组合。
  const { selected, unknownIds, outOfProfile } = selectRules({ only, profile, rules: RULES });
  if (unknownIds.length) {
    console.error(`未知规则 id: ${unknownIds.join(', ')}`);
    console.error(`可用 id: ${RULES.map((r) => r.id).join(', ')}`);
    process.exit(EXIT.CONFIG);
  }
  if (outOfProfile.length) {
    const where = outOfProfile.map((id) => `${id}(${RULES.find((r) => r.id === id).stage === 'code' ? 'acceptance' : 'process'})`);
    console.error(`这些规则不属于当前档位 ${profile}: ${where.join(', ')}`);
    console.error('提示: 代码级判据在 --profile acceptance，四制品判据在 --profile process，两者用 --profile all');
    process.exit(EXIT.CONFIG);
  }

  // --min-coverage：显式缺值/非 0..1 ⇒ 退出码 2。不得把 `true` 读成 1（A14-②）。
  let minCoverage = null;
  if (args['min-coverage'] !== undefined) {
    const raw = args['min-coverage'];
    if (raw === true) {
      console.error('--min-coverage 缺少取值（应为 0..1 之间的数字）');
      process.exit(EXIT.CONFIG);
    }
    const min = Number(raw);
    if (!isRatio(min) || (typeof raw === 'string' && raw.trim() === '')) {
      console.error(`--min-coverage 需为 0..1 的有限数字，收到: ${JSON.stringify(raw)}`);
      process.exit(EXIT.CONFIG);
    }
    minCoverage = min;
  }

  const { results, ctx } = runRules({
    changeDir,
    repo,
    cwd: process.cwd(),
    cfg,
    codeRoots,
    diff,
    evidence,
    profile: 'all', // 已按档位筛过，不让 runner 再筛一次（二次筛会掩盖空集）
    rules: selected,
    codeReport: scan.report,
    // ★ 直接传扫描结果，避免 runRules 内部再扫一次（两次扫描参数不同会让报告与实际不符）。
    codeFilesIn: scan.files,
  });
  const summary = summarize(results);

  /**
   * 覆盖率守卫（2026-11-12 外部实测发现）。
   *
   * 缺口形态：change 目录里**什么都没写**时机器规则全 SKIP，汇总报
   * 「通过 0 · 失败 0 · 跳过 N」，而硬失败只看 `fail > 0`
   * ⇒ **退出码 0 ⇒ CI 放行空提交**。
   *
   * 为什么默认不启用：`process` 档的用法是"边写边查"，文档没写完就 skip 是合理的。
   * 所以这是**显式选择**：想拿它守 CI 的人自己加参数，不想被打断的人什么都不用改。
   */
  const ratio = summary.machineTotal > 0 ? summary.covered / summary.machineTotal : 0;
  const coverageFail = minCoverage !== null && ratio < minCoverage;
  if (coverageFail) {
    console.error(
      `机器规则覆盖率 ${summary.covered}/${summary.machineTotal} = ${ratio.toFixed(2)} < 下限 ${minCoverage}`,
    );
    console.error(
      '覆盖率不足意味着「没检查」，不等于「检查了没问题」。' +
        '请补全 changes/<id>/ 下的 proposal/design/tasks/specs 与 --code 目录。',
    );
  }

  /**
   * 退出码分流（2026-11-13 · §5 Q4.5）。两种失败信号语义相反，必须可区分：
   *   3 INCOMPLETE：判据自身不可信 / 覆盖率不足 / **没有选中任何机器规则** ⇒ 结论无效
   *   1 FAIL      ：判据跑完了，明确判定不合格 ⇒ 阻断
   *   0 OK        ：**至少跑过机器规则**且全过
   *
   * 3 优先于 1：判据自己都不可信时，它报的 fail 也不该当作对被测对象的结论。
   *
   * ★ 决策抽成 `decideExit()` 纯函数，两个理由：
   *   ① 结果要在**输出之前**就算出来（A14-④）：`--json` 必须带
   *      signal / coverageThreshold / coverageRatio / exitCode，
   *      否则调用方拿到一份"全 PASS"的 JSON 却不知道进程将要退 3；
   *   ② 它必须可被单独测——写成内联三元时，测试只能匹配源码文本形状，
   *      于是"改一版实现就红"的假红接二连三（q4-5 曾有 5 条断言就是这么坏的）。
   */
  const hardFail = summary.fail > 0 || (args.strict === true && summary.manual > 0);
  const decision = decideExit({ summary, coverageFail, hardFail });
  const { signal, exitCode } = decision;

  const warnings = collectArgWarnings(args);
  // ★ 2026-11-18（外部实测 ④）：machineTotal=0 ⇒ 已在 decideExit 判 3。
  //   这里补的是**可读的原因**与 JSON 里的 machine 可读痕迹（warnings 字段），
  //   不靠退出码语义让调用方猜"为什么 3"。文字报告另有一行（runner.formatText）。
  //   与 `coverageFail` 同形：原因走 stderr（两种输出模式都有），不留 doc 里查不到的隐式字段。
  if (summary.machineTotal === 0) {
    console.error('本次没有选中任何机器规则（machineTotal=0）：「全过」不成立，判为没跑完（退出码 3）。');
    console.error('要拿机器结论，请去掉只含人工规则的 --only，或补回对应的机器规则 id。');
  }

  /**
   * 「一个源码文件都没扫到」的告警（2026-11-22，13 个公开仓实测）。
   *
   * ★ 缺口形态：`Newtonsoft.Json` 有 951 个 `.cs`，而扫描器当时只认 10 种后缀
   *   ⇒ 扫到 **0 个**，两条判据报 `skip`，**退出码 0、warnings 空**。
   *   `laravel/framework` 更隐蔽：3,205 个 `.php` 只扫到 3 个 `.js`，
   *   `KISS-C1` 给出 `pass`「扫描 3 个文件，无超限」——**看着像检查过了**。
   *
   *   后一种情形这里是抓不到的（它确实扫到了文件），那份口子归 `--min-coverage`。
   *   但只要扫到 0 个，就是**百分之百什么都没检查**，必须喊出来：
   *   同时说清「支持哪些后缀」与「该目录里实际有哪些后缀」，让用户自己判断是哪边的问题。
   *
   * ★ 仍然**不改退出码**：是否把"没检查"判成失败，由 `--min-coverage` 显式选择（ICD §2）。
   *   这里只保证「不静默」。
   */
  if (scan.report.zeroScan) {
    const z = scan.report.zeroScan;
    console.error(`未扫到任何源码文件（${ctx.repo}）。`);
    console.error(`  支持的后缀: ${z.supported.join(' ')}`);
    console.error(`  该目录下的后缀: ${z.otherExtensions.length ? z.otherExtensions.join(' ') : '（没有其它后缀的文件）'}`);
    console.error('「没检查」不等于「检查了没问题」：本次所有代码级判据都不构成结论。');
  }

  /**
   * 代码树身份提示（**不参与退出码**）。
   *
   * 定位：`meta.tree` 是审计元数据，不是认证（ICD §5.2）。这里只回答
   * 「你看的这份结论是在哪棵树上得出的」，不回答「这份结论对不对」——
   * 后者是判据的事。所以：
   *   · 它写进 `--json` 的 `treeNotice` 字段，但不改 `signal` / `exitCode`；
   *   · 它只对**提供了 evidence 的档位**出现（process 档没有证据可核对）；
   *   · 四种情况都给可区分文案，绝不统一说「可能过期」。
   *
   * 为什么必须有（2026-11-15 实测）：旧 evidence 记 head=eeba718，
   * 在当前 b6d00a4 上跑 acceptance ⇒ ACCEPT-E* 全 PASS、EXIT=0。
   * 记了 tree 却无人使用，与「没检查 ≠ 检查了没问题」是同族缺陷。
   *
   * ★ 计算与渲染都抽到模块级函数：内联时 `if/else` 里再套 `if` 会把
   *   cli.mjs 的嵌套推到 4 层，直接触发本项目自己的 KISS-C1
   *   （spec-probe A04-6 就是这么报出来的，判据抓到了我自己的代码）。
   */
  const treeNotice = computeTreeNotice({ evidence, profile, repo: ctx.repo });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          repo: ctx.repo,
          profile,
          results,
          summary,
          signal,
          coverageThreshold: minCoverage,
          coverageRatio: Number(ratio.toFixed(4)),
          exitCode,
          strictArgs,
          warnings,
          treeNotice,
          codeFiles: { count: ctx.codeFiles.length, roots: codeRoots, report: ctx.codeReport || null },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`sdd-guard @ ${changeDir}`);
    console.log(`路径基准(repo): ${ctx.repo}`);
    console.log(`档位(profile): ${profile}${profile === 'all' ? '' : profile === 'process' ? '（开发流程）' : '（验收标准）'}`);
    console.log(formatText(results));
    for (const line of renderTreeNotice(treeNotice)) console.log(line);
    // ★ 2026-11-18（外部实测 ②）：黑名单/点目录跳过原先**完全无声** —— g:/AMup 上有
    //   937 个 JS 既不在 candidates 也不在 errors 里。现在只要跳过就报，且数字可复算：
    //   candidates + count = 物理存在的源码文件数。
    const bl = scan.report.blacklisted;
    if (bl && bl.count > 0) {
      const top = bl.dirs.slice().sort((a, b) => b.files - a.files).slice(0, 3)
        .map((d) => `${d.path.split(/[\\/]/).pop()}=${d.files}`).join(' · ');
      console.error(`  ⚠ 扫描收据：另有 ${bl.count} 个源码文件因跳过规则未进入候选（${top}${bl.dirs.length > 3 ? ' …' : ''}），不计入 scanned`);
    }
    if (scanErrors.length) {
      console.error(`  ⚠ 扫描收据：${scan.report.roots.length} 个 --code 根，候选 ${scan.report.candidates} 个源码文件，实际扫描 ${ctx.codeFiles.length} 个`);
      for (const e of scanErrors) console.error(`     · ${e}`);
    }
    if (warnings.length) for (const w of warnings) console.error(`  ⚠ ${w}`);
  }

  if (summary.untrusted > 0) {
    console.error(
      `判据自身不可信（${summary.untrustedIds.join(', ')}）⇒ 本次任何"通过"都不作数。` +
        '这是判据缺陷，不是被测对象的问题。',
    );
  }
  process.exit(exitCode);
}

/**
 * 只在**被当作可执行文件**时跑 main()；被 import 时（测试要直接用 `decideExit`）不执行。
 *
 * 为什么需要这道闸：`decideExit` 是退出码分流的核心，测试必须能**直接调用真实现**。
 * 若 import 即执行 main()，测试就只能去匹配源码文本形状 ——
 * 那是"用字符串相似度代替行为验证"，改一版实现就会假红（q4-5 实测踩过 5 次）。
 *
 * ★★ 2026-11-18 修：**必须比 `realpath`，不能比 `resolve`**。
 *
 * 实测缺陷（回答"其他项目怎么调用"时撞到的）：
 *   `npm install file:<本仓库>` 在 Windows 上建的是 **Junction**。于是
 *     process.argv[1]  —— 联接路径（`<消费方>/node_modules/sdd-guard/cli.mjs`）
 *     import.meta.url  —— 本仓库的真实路径
 *   而 `resolve()` **不解析符号链接** ⇒ 两者永不相等 ⇒ `isMain=false`
 *   ⇒ `main()` 根本没执行 ⇒ **CLI 静默什么都不做，并且以 0 退出**。
 *
 *   这是最坏的失败形态：既没有输出、也没有报错，退出码还表示成功。
 *   使用者会以为"检查通过了"，而实际上是"检查没跑"。
 *
 * 修法：两侧都走 `realpathSync`（拿真实路径）；拿不到（文件已删等）则回退到 resolve。
 */
function sameFile(a, b) {
  const norm = (p) => {
    const r = resolve(p);
    try {
      return realpathSync(r);
    } catch {
      return r; // 文件不可解析时退回字面路径，至少不比之前差
    }
  };
  return norm(a) === norm(b);
}

const isMain = Boolean(process.argv[1]) && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) main();
