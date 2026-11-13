#!/usr/bin/env node
// sdd-guard —— 把 YAGNI/KISS/DRY 里可机械判定的部分变成会 FAIL 的检查。
// 退出码: 0=全过, 1=判据判定不合格, 2=输入/配置错误, 3=判据不可信或没跑完
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRules, formatText, summarize, selectRules, EXIT, SIGNAL } from './lib/runner.mjs';
import { RULES } from './lib/rules.mjs';
import { CODE_EXT, scanCodeRoots } from './lib/code.mjs';
import { parseArgs } from './lib/args.mjs';
import { renderHelp, PROFILE_NAMES, EVIDENCE_KEYS, OPTIONS, CONFIG_SCHEMA } from './lib/contract.mjs';
import { missingEvidenceKeys } from './lib/evidence.mjs';
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
 * 警告级问题（不强制的宽松解析遗留）。它们**进 --json 的 trace**，
 * 这样"我拼错了选项"在机器可读结果里也看得见，而不是只留在 stderr 的一行字里。
 */
function collectArgWarnings(args) {
  const warnings = [];
  for (const key of Object.keys(args)) {
    if (key === '_' || KNOWN.has(key)) continue;
    const near = [...KNOWN].filter((k) => levenshtein(k, key) <= 2);
    if (near.length) warnings.push(`未知选项 --${key}，是否想写 --${near[0]}？`);
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
 * @param {{summary:{untrusted:number}, coverageFail:boolean, hardFail:boolean}} p
 * @returns {{signal:string, exitCode:number}}
 */
export function decideExit({ summary, coverageFail, hardFail }) {
  if (summary.untrusted > 0) return { signal: SIGNAL.UNTRUSTED, exitCode: EXIT.INCOMPLETE };
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

  const codeRoots = args.code
    ? (Array.isArray(args.code) ? args.code : [args.code]).map((p) => resolve(p))
    : [];
  const codeProblems = validateCodeRoots(codeRoots);
  if (codeProblems.length) {
    console.error(`--code 参数错误:\n  - ${codeProblems.join('\n  - ')}`);
    process.exit(EXIT.CONFIG);
  }
  // 扫描收据（A06）：一次扫描、两处复用 —— 执行前判错 + 报告里给候选/已扫/排除原因。
  const scan = scanCodeRoots(codeRoots);
  const scanErrors = scan.report.errors || [];

  const repo = args.repo && args.repo !== true ? resolve(args.repo) : null;

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
   *   3 INCOMPLETE：判据自身不可信，或覆盖率不足 ⇒ 结论无效，必须阻断
   *   1 FAIL      ：判据跑完了，明确判定不合格 ⇒ 阻断
   *   0 OK        ：机器规则全过
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
 */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
