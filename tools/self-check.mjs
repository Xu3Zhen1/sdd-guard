#!/usr/bin/env node
// self-check —— 一条命令跑完「开发流程 + 验收标准」的全部自检。
//
// 为什么要有它：一条流程如果要在 6 条命令里手敲，就不会被执行。
// 但"一条命令"必须保持诚实：
//   · 每一步都留原始输出，失败即整条命令失败（不 catch 后继续、不把 fail 变成 warn）；
//   · 汇总里逐项列出 PASS/FAIL 与耗时，不接受"最后一行说成功"；
//   · 验收步骤用的是**刚刚真实跑出来的证据**，不是仓库里躺着的旧 evidence.json；
//   · 每个子进程断言**精确退出码**（0/1/2/3），不接受"非零即失败"——
//     "非零"把「判据判定不合格(1)」「输入错误(2)」「没跑完(3)」混成一种，正是 Q4.5 要拆开的东西。
//
// 用法：
//   node tools/self-check.mjs                      # 用自带的夹具做自检（开发者用）
//   node tools/self-check.mjs --change <目录> --repo <仓库> --config <配置> --code <根> [--code <根>…]
//   node tools/self-check.mjs --skip-acceptance    # 只跑测试/变异/漂移/证据
//   node tools/self-check.mjs --print-steps        # 只打印本脚本**将要执行**的步骤清单(JSON)，不做任何事
//
// ── 为什么有 --print-steps（2026-11-13 · A08）──────────────────
// tools/check-contract.mjs 要证明「self-check 覆盖了 CI 的每一步」，而**旧做法是
// 在 self-check 源码里 `includes('tools/check-publish.mjs')`** —— 把那一行注释掉，
// 字符串还在，检查照样绿，而这一步实际已经不跑了（审计 I-02 实证 53/53 假绿）。
//
// 修法不是"把正则写得更聪明"，而是**让 self-check 自己报出它的执行清单**：
// 清单里的每一项都来自真正会被 `spawnSync` 执行的 step 对象，注释掉 `push` 就没了这一项。
// 于是"文本里有"与"会执行"不再能混淆 —— 检查的是数据，不是字符串。

import { EVIDENCE_KEYS } from '../lib/contract.mjs';
import { scanCodeRoots } from '../lib/code.mjs';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writableTempRoot } from '../lib/temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 日志目录：`.selfcheck/`，但**每次运行一个子目录**（`.selfcheck/<pid>/`）。
 *
 * ★ 2026-11-13 实证：固定文件名会被**上一个进程的残留句柄**占住（Windows EBUSY）。
 * 表现极具欺骗性：cmd 的重定向失败 ⇒ 命令根本没跑 ⇒ 退出码 1、日志 0 字节 ⇒
 * 自检报"这一步失败"，而它连一次都没执行。**"没跑"与"跑了但不合格"症状同形。**
 *
 * 每次运行独立子目录从根上避开这个坑（同时也让并发的两次自检不互相踩）。
 * `.selfcheck/` 已在 .gitignore 里，子目录同样被忽略。
 */
const LOG_DIR = join(ROOT, '.selfcheck', String(process.pid));
const LATEST_LINK = join(ROOT, '.selfcheck', 'latest.txt');

/**
 * ── 三类范围（A07 要求"分别声明"）───────────────────────────────
 *
 * 旧汇总只有一行「N/N 项通过」，于是「我查了工具本身」与「我查了交付物」混成一个数字。
 * 一个 17/17 既可能是"工具全好、交付没查"，也可能是"交付全好、工具没查" ——
 * 总数不能代替范围。这里把三步分开记名，汇总时分段打印，缺任何一段都看得见。
 */
const GROUP = {
  TOOL: '工具健康（tests / 变异 / 契约 / 发布）',
  BOOT: '自举流程（process 档）',
  DELIVERY: '交付检查（acceptance + 覆盖率）',
};

// ── 步骤清单：常量表，改这里等于改门禁 ──────────────────────────

/**
 * 测试清单的唯一真源 = `package.json` 的 `scripts.test`（A07 的"唯一测试入口"）。
 *
 * ★ 2026-11-13：此处**曾经**把七套专项的路径字面量再抄一遍，与 check-contract.mjs
 * 里的 REQUIRED_SPECIALTY 完全重复 —— 验收时 DRY-C1 当场把自己判红（3 处 ≥6 行重复：
 * `tools/check-contract.mjs:34↔tools/self-check.mjs:64`）。
 *
 * 这不是"误报"，是**真的有两份清单**。而两份清单的漂移方式正是本项目最怕的那种：
 * 加了一套专项却只改了一边 ⇒ 一边跑、另一边不查，全绿。
 *
 * 现在两边都从 package.json 读：它既是人能看懂的声明（A07 要求"唯一测试入口"），
 * 也是**独立于被测实现**的事实来源（check-contract 比对 self-check 时不算自证）。
 */
function readTestManifest() {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const raw = pkg.scripts?.test || '';
  const files = [];
  for (const m of raw.matchAll(/node\s+([\w./-]+\.mjs)/g)) files.push(m[1]);
  return { raw, files: [...new Set(files)] };
}

const MANIFEST = readTestManifest();

/** 门禁自身的守卫（A06 扫描收据 / A08 CI 等价性），同样必须常跑。 */
const GUARD_TESTS = ['test/scan-roots.test.mjs', 'test/contract-guard.test.mjs'];

/**
 * 验收档里**已知会 SKIP** 的机器规则（A07："自检一直允许三个 SKIP"）。
 *
 * 不把它们当通过，也不许它们静默增殖：每个都必须在这里登记原因，
 * 出现新的 SKIP id ⇒ 本步判红。这样"跳过"是**被清点过的**，不是被忽略的。
 */
const KNOWN_SKIPS = {
  'DECOUPLE-2': '需要 guard.config.json 的 boundaries 配置（本项目未声明边界前缀）',
  // DISCIPLINE-C1 / C3 在本步里 SKIP，是**职责切分**的结果，不是"没验证"：
  //   · 本步（acceptance）刻意不带 --diff ⇒ C1/C3 无输入 ⇒ skip
  //   · 判据本身由 `discipline-fixtures` 三向验证（合规 PASS / 越界 FAIL / 超预算 FAIL）
  //   · 本次真实变更由 `real-diff-notice` 如实通报（advisory，不参与绿红）
  // 若哪天这两条在这步**没有** skip（例如有人给本步加了 --diff），登记还在也不算错——
  // 那说明覆盖变多了，是改进方向。
  'DISCIPLINE-C1': '本步不带 --diff（判据健康由 discipline-fixtures 三向验证；本次变更由 real-diff-notice 通报）',
  'DISCIPLINE-C3': '本步不带 --diff（同上）',
};

/** 自检产出的真实 diff（供 real-diff-notice 使用；不进版本库）。 */
const DIFF_FILE = join(ROOT, '.selfcheck-diff.json');

function parseArgs(argv) {
  const out = { code: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (key === 'code') out.code.push(val);
    else out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function resolveContext(a) {
  const pick = (k, dflt) => (a[k] && a[k] !== true ? resolve(a[k]) : dflt);
  return {
    change: pick('change', join(ROOT, 'changes/self-host-guard')),
    repo: pick('repo', ROOT),
    config: pick('config', join(ROOT, 'guard.config.json')),
    // ★ A06：默认根**显式枚举**——lib 与 tools 是目录，cli.mjs 是**文件**。
    //   旧实现把三者一视同仁地当目录 readdir，文件根抛错被吞 ⇒ 整个 CLI 入口从未被扫过。
    codeRoots: a.code.length ? a.code.map((c) => resolve(c)) : ['lib', 'tools', 'cli.mjs'].map((p) => join(ROOT, p)),
    evOut: join(ROOT, 'evidence.json'),
    skipAcceptance: a['skip-acceptance'] === true,
  };
}

const ctx = resolveContext(args);

/** 一条"跑外部命令并断言精确退出码"的步骤。 */
function spawnStep(group, name, cmd, invokes, expect) {
  return { group, name, cmd, invokes, expect, mode: 'spawn' };
}

/** 一条在本进程里做判断的步骤（收据类、负控类）。 */
function customStep(group, name, invokes, run) {
  return { group, name, invokes, mode: 'custom', run };
}

/**
 * 构建执行清单。**这是唯一真源**：
 *   · 执行时按它跑；`--print-steps` 也按它输出；check-contract 比对的是后者。
 */
function buildPlan(c, state) {
  const plan = [];
  /**
   * 测试步骤全部来自 MANIFEST（package.json scripts.test）。
   *
   * ★ 专项测试（A07）此前**存在但不在门禁里**：审计实证把 cli.mjs 的 coverageFail
   * 从 3 改成 1（语法有效），self-check 仍 10/10 全绿，而单跑 q4.5 立刻变红 ——
   * 判据有能力发现问题，却没有被接到会红的地方。现在它们从唯一入口来，进不了这个循环就上不了门禁。
   *
   * 逐文件 `node test/<name>.mjs`：本机沙箱下 `node --test` 的多进程会撞 PIPE EPERM，
   * 那是环境限制，不是被测行为；这些文件用 node:test 的 test()，单进程跑同样产出 TAP 汇总，
   * 退出码即 0/1，可直接断言。
   *
   * 运行顺序沿用 package.json 里的书写顺序（guard/args/evidence 先行），
   * 这样"哪个测试先跑"由**唯一入口**决定，而不是这里再排一次。
   */
  // mutation 已在 package.json 的 scripts.test 中登记（唯一入口），此处不再重复登记。
  const testFiles = [...MANIFEST.files, ...GUARD_TESTS.filter((g) => !MANIFEST.files.includes(g))];
  for (const f of testFiles) {
    const name = f.replace(/^test\//, '').replace(/\.mjs$/, '');
    plan.push(spawnStep(GROUP.TOOL, name, `node ${f}`, [f], 0));
  }
  plan.push(spawnStep(GROUP.TOOL, 'contract', 'node tools/check-contract.mjs', ['tools/check-contract.mjs'], 0));
  plan.push(spawnStep(GROUP.TOOL, 'publish', 'node tools/check-publish.mjs', ['tools/check-publish.mjs'], 0));
  plan.push(customStep(GROUP.TOOL, 'scan-receipt', [], () => scanReceipt(c)));
  const processCmd =
    `node cli.mjs check --change "${c.change}" --profile process --repo "${c.repo}" --config "${c.config}"`;
  plan.push(spawnStep(GROUP.BOOT, 'process', processCmd, ['cli.mjs'], 0));
  plan.push(customStep(GROUP.DELIVERY, 'coverage-guard', ['cli.mjs'], () => coverageGuard(c)));
  // ★ 2026-11-13：先产出真实 diff，让 DISCIPLINE-C1/C3 真的执行（不再靠 KNOWN_SKIPS 放行）。
  plan.push(
    spawnStep(
      GROUP.DELIVERY,
      'make-diff',
      `node tools/make-diff.mjs --repo "${c.repo}" --out "${DIFF_FILE}" --json`,
      ['tools/make-diff.mjs'],
      0,
    ),
  );
  plan.push(
    spawnStep(GROUP.DELIVERY, 'make-evidence', `node tools/make-evidence.mjs --out "${c.evOut}" --repo .`, [
      'tools/make-evidence.mjs',
    ], 0),
  );
  plan.push(customStep(GROUP.DELIVERY, 'evidence-chain', [], () => evidenceChain(c, state)));
  plan.push(customStep(GROUP.DELIVERY, 'acceptance', ['cli.mjs'], () => acceptance(c, state)));
  // ★ 2026-11-13 复核后新增两项，把 C1/C3 从"登记跳过"变成"真的验过"：
  //   discipline-fixtures —— 受控夹具证明 C1/C3 会判（合规 PASS / 越界 FAIL / 超预算 FAIL）
  //   real-diff-notice    —— 用真实变更量一次，**如实通报**是否超预算（advisory，不参与绿红）
  plan.push(customStep(GROUP.DELIVERY, 'discipline-fixtures', ['cli.mjs'], () => disciplineFixtures(c)));
  plan.push(customStep(GROUP.DELIVERY, 'real-diff-notice', ['cli.mjs', 'tools/make-diff.mjs'], () => realDiffNotice(c)));
  return plan;
}


/**
 * ★ 主流程包进函数 + isMain 守卫（2026-11-13 第三次复核抓到）。
 *
 * 原实现把整段主流程摊在模块顶层：只要有人 `import` 本文件（例如为了单测
 * `classifyRealDiff`），就会**静默执行一整次 self-check** —— 实测一次 import 触发了 25 步、
 * 几十秒、若干子进程。那是"导入一个纯函数"与"跑一次全量门禁"症状同形，
 * 与被测项目无关的副作用，必须消除。
 */

/**
 * 归因可接受的**状态白名单**。
 *
 * ★ 必须是**白名单**，不能是黑名单（2026-11-13 第四次复核抓到）。
 *
 * 上一版写的是"排除 skip/manual/fail，剩下就算通过"——那是**排除法**：
 * ```js
 * const notRun = [...].filter(id => { const x=...; return !x || x.status==='skip' || x.status==='manual'; });
 * if (notRun.length) return '无法判定…';
 * const bad = results.filter(x => x.status === 'fail');
 * if (bad.length) return '未通过…';
 * return '通过 C1/C3';        // ← 任何没被上面两条拦下的怪值都掉进这里
 * ```
 * 负面用例实测：两条规则 **均缺 status**、均为 `"unknown"`、`null`、`""`、`1`、
 * 拼错的 `"passed"` —— 六种畸形输入**全部宣称"通过"**。
 *
 * 排除法的通病：**未知值默认落到"好"的那一侧**。判据要求的不是"没有坏消息"，
 * 而是"必须有正面好消息"。所以反过来写：只有出现在白名单里的状态才被承认，
 * 其余（含缺失、未知、拼错）一律「无法判定」。
 */
const ACCEPTED_STATUSES = new Set(['pass', 'fail']);

/**
 * 把一次 C1/C3 的真实执行结果**归因**成一句话。
 *
 * ★ 抽成**纯函数**是为了能被单测直接负控（`test/real-diff-notice.test.mjs`）。
 *
 * 判据顺序：**先证明可判定，再判结论**。
 *   ① 退出码 0 是唯一可谈通过的值；2/null 一律"无法判定"
 *   ② `--json` 必须能解析出 results 数组
 *   ③ 两条规则都必须存在，且 **status 必须落在白名单 `{pass, fail}` 内** ——
 *      缺失 / `unknown` / `null` / 拼错 等一律「无法判定」，**绝不默认当作执行过**
 *   ④ 以上全部成立，才区分"通过"与"哪几条红"
 *
 * **绝不**用"没找到失败文本"倒推"通过"，也**绝不**用"排除了已知坏状态"倒推"通过"。
 *
 * @param {number} status 真实 CLI 退出码（-1 表示进程起不来）
 * @param {string} txt    CLI 的 stdout+stderr 文本
 * @returns {string}
 */
export function classifyRealDiff(status, txt) {
  const parseResults = () => {
    const s = txt.indexOf('{');
    const e = txt.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try {
      const j = JSON.parse(txt.slice(s, e + 1));
      return Array.isArray(j.results) ? j.results : null;
    } catch {
      return null;
    }
  };

  if (status !== 0) {
    const results = parseResults();
    // 退出 1 + 有结构化结果 ⇒ 这是"本次变更被判红"，是有结论的
    if (status === 1 && results) {
      const bad = results.filter((x) => x.status === 'fail');
      const budget = txt.match(/变更 (\d+) 行，超预算 (\d+) 行/);
      return (
        `本次真实变更**未通过** C1/C3：${bad.length ? bad.map((x) => x.id).join(', ') + ' 判红' : '判红'}` +
        (budget ? `（变更 ${budget[1]} 行 > ${budget[2]} 行预算）` : '') +
        '。是本次变更的结论，不是工具缺陷'
      );
    }
    const why = status === 2 ? '配置/输入错误' : status === -1 ? '进程起不来' : 'CLI 内部错误';
    return `**无法判定**：CLI 退出 ${status}（${why}）⇒ 本步没有得出任何 C1/C3 结论（不是通过）`;
  }

  const results = parseResults();
  if (!results) {
    return '**无法判定**：退出 0 但 `--json` 无法解析出 results ⇒ 不能据"没找到失败"判通过';
  }

  // ★ 白名单：状态必须被正面承认，否则视为"未判定"。
  const unjudged = ['DISCIPLINE-C1', 'DISCIPLINE-C3'].filter((id) => {
    const x = results.find((y) => y.id === id);
    if (!x) return true; // 缺这条结果
    return !ACCEPTED_STATUSES.has(x.status); // 缺 status / unknown / null / 拼错…
  });
  if (unjudged.length) {
    const detail = unjudged
      .map((id) => {
        const x = results.find((y) => y.id === id);
        const raw = x === undefined ? '(无此结果)' : JSON.stringify(x.status);
        return `${id}=${raw}`;
      })
      .join(', ');
    return `**无法判定**：${detail} 不是可承认的状态（只承认 ${[...ACCEPTED_STATUSES].join('/')}）⇒ 不构成通过`;
  }

  const bad = results.filter((x) => x.status === 'fail');
  if (bad.length) {
    const budget = txt.match(/变更 (\d+) 行，超预算 (\d+) 行/);
    return (
      `本次真实变更**未通过** C1/C3：${bad.map((x) => x.id).join(', ')} 判红` +
      (budget ? `（变更 ${budget[1]} 行 > ${budget[2]} 行预算）` : '') +
      '。是本次变更的结论，不是工具缺陷'
    );
  }
  return '本次真实变更通过 C1/C3（C1 与 C3 均已真实执行且均 pass）';
}

/**
 * 执行一条 `spawnStep` 步骤：跑命令、把输出写日志、按期望退出码判定。
 *
 * 与 `withTimeout`（跑 `customStep` 的 `run()`）配对，构成两条执行通路。
 * 子进程输出**重定向到文件**（本沙箱禁止 PIPE 捕获），失败时从日志尾部取上下文。
 */
function runCommand(step) {
  const logFile = join(LOG_DIR, `${slugOf(step.name)}.txt`);
  const started = Date.now();
  const cmd = `${step.cmd} > "${logFile}" 2>&1`;
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' });
  const exitCode = r.status === null ? -1 : r.status;
  const ok = exitCode === step.expect;
  return {
    group: step.group,
    name: step.name,
    invokes: step.invokes,
    exitCode,
    ok,
    expect: step.expect,
    ms: Date.now() - started,
    logFile,
    tail: ok ? tailOf(logFile) : `期望 exit ${step.expect}，实际 ${exitCode}｜ ${tailOf(logFile)}`,
  };
}

/** 日志尾部若干行，用于汇总里显示上下文。 */
function tailOf(logFile, n = 2) {
  if (!existsSync(logFile)) return '';
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join(' | ')
    .slice(0, 200);
}

/** 步骤名 → 安全文件名。 */
function slugOf(name) {
  return name.replace(/[^\w.-]+/g, '_');
}

/**
 * 扫描完整性收据（A06）：证明"扫了哪些根、各贡献几个文件"。
 *
 * 守审计 I-04 那类缺陷：默认根里混了 `cli.mjs` 这个**文件**，扫描器对每个根做 readdir，
 * 文件根抛错被吞 ⇒ 该根贡献 0 个文件 ⇒ CLI 入口从未被扫过，报告只说"扫描 14 个文件"。
 * **"我没扫到"与"扫了没问题"症状同形**。
 *
 * 四条判红（缺一就只是"看起来有收据"）：
 *   ① 每根 files>0（不允许静默贡献 0）
 *   ② `cli.mjs` 必须在文件集内（文件根真的生效了）
 *   ③ Σroots[].files == files.length（逐根之和与总数一致）
 *   ④ candidates == scanned == files.length（收据字段是真值，不是恒 0 占位）
 */
function scanReceipt(c) {
  const name = 'scan-receipt';
  const { files, report } = scanCodeRoots(c.codeRoots);
  const problems = [];
  for (const r of report.roots) {
    if (r.files === 0) problems.push(`根 ${r.root} 贡献 0 个文件（kind=${r.kind}）`);
  }
  if (!files.some((f) => basename(f) === 'cli.mjs')) problems.push('cli.mjs 不在文件集内 ⇒ 文件根没生效');
  const sum = report.roots.reduce((a, r) => a + r.files, 0);
  if (sum !== files.length) problems.push(`逐根之和 ${sum} ≠ 文件总数 ${files.length}`);
  if (report.candidates !== files.length) problems.push(`candidates ${report.candidates} ≠ ${files.length}`);
  if (report.scanned !== files.length) problems.push(`scanned ${report.scanned} ≠ ${files.length}`);
  const perRoot = report.roots.map((r) => `${basename(r.root)}=${r.kind === 'file' ? 'file' : 'dir'}:${r.files}`).join(' · ');
  return {
    name,
    exitCode: problems.length ? 1 : 0,
    ok: problems.length === 0,
    ms: 0,
    tail: problems.length
      ? problems.join(' | ')
      : `${report.roots.length} 根 / 候选 ${report.candidates} / 已扫描 ${report.scanned}（${perRoot}）`,
  };
}

/**
 * 覆盖率守卫负控（A07 配套）。
 *
 * 断言**两个写死的退出码**：不开启 ⇒ 0；开启（`--min-coverage` 高于实际覆盖率）⇒ 3。
 * 旧版只判"非零"，所以"把 3 改成 1"那个变异在旧自检里完全看不出来 ——
 * **只判"红没红"而不判"红成什么"，等于允许退出码语义漂移**。
 */
function coverageGuard(c) {
  const name = 'coverage-guard';
  const tmpRoot = join(writableTempRoot(), `sdd-covguard-${process.pid}`);
  mkdirSync(tmpRoot, { recursive: true });
  const emptyChange = join(tmpRoot, 'changes', 'empty-guard');
  mkdirSync(emptyChange, { recursive: true });
  const problems = [];
  const run = (tag, extra) => {
    const log = join(tmpRoot, `${tag}.txt`);
    const cmd =
      `node cli.mjs check --change "${emptyChange}" --repo "${c.repo}" --config "${c.config}"` +
      ` --code "${join(c.repo, 'lib')}"${extra} > "${log}" 2>&1`;
    const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' });
    return r.status === null ? -1 : r.status;
  };
  const off = run('off', '');
  if (off !== 0) problems.push(`未开启时应当 exit 0，实际 ${off}`);
  const on = run('on', ' --min-coverage 0.99');
  if (on !== 3) problems.push(`开启且覆盖率不足时应当 exit 3，实际 ${on}`);
  rmSync(tmpRoot, { recursive: true, force: true });
  return {
    name,
    exitCode: problems.length ? 1 : 0,
    ok: problems.length === 0,
    ms: 0,
    tail: problems.length ? problems.join(' | ') : `未开启 ⇒ exit ${off}；开启 ⇒ exit ${on}（两值都写死）`,
  };
}

/**
 * DISCIPLINE-C1/C3 的**判据健康**检查（受控夹具）。
 *
 * 为什么不直接拿本次真实变更喂 C1：C1 判的是"**本次变更**是否越界/超预算"。
 * 审计修复改了 8000+ 行、预算 400 行 ⇒ 它**理应报红**。那是**对本次变更的真实结论**，
 * 不是工具坏了。若为了让自检变绿而调高预算或裁 diff，那才是把判据改绿。
 *
 * 所以把两件事分开：本步用受控夹具问"C1 拿到合法输入会不会 PASS、违规输入会不会 FAIL"。
 * 三条断言（缺一即红）：① 合规输入 ⇒ PASS ② 越界输入 ⇒ FAIL 且理由指向范围
 * ③ 超预算 ⇒ FAIL 且理由提到预算。
 */
function disciplineFixtures(c) {
  const name = 'discipline-fixtures';
  const dir = join(LOG_DIR, 'discipline');
  mkdirSync(dir, { recursive: true });
  const cfgFile = join(dir, 'cfg.json');
  writeFileSync(cfgFile, JSON.stringify({ allowedPrefixes: ['lib/'], maxDiffLines: 1000, contractPrefixes: ['lib/'] }));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ files: [{ path: 'lib/a.js', added: 5, deleted: 1 }] }));
  writeFileSync(join(dir, 'out.json'), JSON.stringify({ files: [{ path: 'src/a.js', added: 5, deleted: 1 }] }));
  writeFileSync(join(dir, 'big.json'), JSON.stringify({ files: [{ path: 'lib/a.js', added: 5000, deleted: 1 }] }));

  const runOne = (tag, diffFile) => {
    const of = join(dir, `${tag}.txt`);
    const cmd =
      `node cli.mjs check --change "${c.change}" --profile acceptance --evidence "${c.evOut}"` +
      ` --repo "${c.repo}" --config "${cfgFile}" --diff "${diffFile}" --code "${join(c.repo, 'lib')}" --only DISCIPLINE-C1 --json`;
    const fd = openSync(of, 'w');
    let r;
    try {
      r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: ['ignore', fd, fd] });
    } finally {
      closeSync(fd);
    }
    const txt = readFileSync(of, 'utf8');
    return { status: r.status === null ? -1 : r.status, txt, bad: /"status"\s*:\s*"fail"/.test(txt) };
  };

  const ok = runOne('ok', join(dir, 'ok.json'));
  const out = runOne('out', join(dir, 'out.json'));
  const big = runOne('big', join(dir, 'big.json'));

  const problems = [];
  if (ok.status !== 0 || ok.bad) problems.push(`合规输入应当 PASS，实际 exit ${ok.status}${ok.bad ? '（含 fail）' : ''}`);
  if (!(out.bad || out.status !== 0)) problems.push('越界路径应当 FAIL，实际通过');
  else if (!/越界|allowedPrefixes|不在允许范围/.test(out.txt)) problems.push('越界 FAIL 的理由没指向范围判定');
  if (!(big.bad || big.status !== 0)) problems.push('超预算应当 FAIL，实际通过');
  else if (!/预算/.test(big.txt)) problems.push('超预算 FAIL 的理由没提到预算');

  return {
    name,
    exitCode: problems.length ? 1 : 0,
    ok: problems.length === 0,
    ms: 0,
    tail: problems.length ? problems.join(' | ') : 'C1 判据健康：合规 PASS · 越界 FAIL · 超预算 FAIL（三向都验到）',
  };
}

function realDiffNotice(c) {
const name = 'real-diff-notice';
const of = join(LOG_DIR, 'real-diff.txt');
const cmd =
  `node cli.mjs check --change "${c.change}" --profile acceptance --evidence "${c.evOut}"` +
  ` --repo "${c.repo}" --config "${c.config}" --diff "${DIFF_FILE}"` +
  ` --code "${join(c.repo, 'lib')}" --code "${join(c.repo, 'tools')}" --code "${join(c.repo, 'cli.mjs')}"` +
  ` --only DISCIPLINE-C1,DISCIPLINE-C3 --json`;
const fd = openSync(of, 'w');
let r;
try {
  r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: ['ignore', fd, fd] });
} finally {
  closeSync(fd);
}
const status = r.status === null ? -1 : r.status;
const txt = readFileSync(of, 'utf8');
return {
  name,
  exitCode: status,
  ok: true, // ★ 通报项恒 ok：把它做成门禁 = 拿"本次改动大"判工具坏
  ms: 0,
  logFile: of,
  advisory: true,
  tail: classifyRealDiff(status, txt),
};
}



/** 证据链完整性（provenance 齐全）。必须先有本次产出的证据，否则拒绝用旧文件。 */
function evidenceChain(c, st) {
  const name = 'evidence-chain';
  if (!st.evidenceProduced) {
    return { name, exitCode: 1, ok: false, ms: 0, tail: '本次 make-evidence 未成功产出证据，拒绝用旧 evidence.json' };
  }
  try {
    const ev = JSON.parse(readFileSync(c.evOut, 'utf8'));
    const missing = EVIDENCE_KEYS.filter((k) => ev[k] === undefined);
    const noProv = EVIDENCE_KEYS.filter((k) => !ev.meta?.producers?.[k]?.sha256);
    const ok = !missing.length && !noProv.length;
    st.evidenceOk = ok;
    return {
      name,
      exitCode: ok ? 0 : 1,
      ok,
      ms: 0,
      tail: ok ? '三键齐全，provenance 完整' : `缺键: ${missing.join(',') || '无'} | 无 provenance: ${noProv.join(',') || '无'}`,
    };
  } catch (e) {
    return { name, exitCode: 1, ok: false, ms: 0, tail: `不可解析: ${e.message}` };
  }
}

/**
 * ── 验收（缺证据/缺 change 就明确失败，不静默跳过）──────────
 *
 * 默认对 **sdd-guard 自己** 跑验收（自举），而不是对夹具——
 * 夹具在单元测试里已被覆盖；self-check 存在的意义是"项目自己能不能过关"。
 *
 * ★ A07：用 `--json` 取**结构化结果**，把"跳过了几条、跳过的是谁"变成可清点的数据。
 * 旧实现跑纯文本，三个 SKIP 只在人眼扫输出时可见，机器判定上等于不存在。
 */
function acceptance(c, st) {
  const name = 'acceptance';
  if (c.skipAcceptance) {
    return { name, exitCode: null, ok: true, skipped: true, ms: 0, tail: '按 --skip-acceptance 跳过，本次不构成交付验收' };
  }
  if (!st.evidenceProduced || !st.evidenceOk) {
    return { name, exitCode: 1, ok: false, ms: 0, tail: '本次证据不可用，验收拒绝用旧证据' };
  }
  const started = Date.now();
  const jsonFile = join(LOG_DIR, 'acceptance.json');
  const errFile = join(LOG_DIR, 'acceptance.stderr.txt');
  const codeArgs = c.codeRoots.map((p) => `--code "${p}"`).join(' ');
  /**
   * 刻意**不带 `--diff`**（2026-11-13 复核后确定的职责切分）。
   *
   * 理由：C1 判的是"**本次变更**是否越界/超预算"。本次审计修复改了 7000+ 行、
   * 预算 400 行 ⇒ 它报红是**对本次变更的正确结论**，不是工具坏了。
   * 但 `self-check` 这一档的职责是"**工具健康**"——若把"本次改动有多大"塞进
   * 门禁，就会逼着人去调预算或裁 diff 才能变绿，那正是把判据改绿。
   *
   * 所以 C1/C3 改由两步覆盖，语义各自清晰：
   *   · `discipline-fixtures`：受控夹具证明判据会判（合规 PASS / 越界 FAIL / 超预算 FAIL）
   *   · `real-diff-notice`   ：拿真实变更量一次，**如实通报**结论（advisory，不参与绿红）
   * 于是本步里 C1/C3 的 SKIP 是**分工导致的**，不是"没验证"。
   */
  const cmd =
    `node cli.mjs check --change "${c.change}" --profile acceptance --evidence "${c.evOut}"` +
    ` --repo "${c.repo}" --config "${c.config}" ${codeArgs} --json`;
  process.stdout.write(`  … ${name.padEnd(22)} ${cmd}\n`);
  const r = spawnSync(`${cmd} > "${jsonFile}" 2> "${errFile}"`, { cwd: ROOT, shell: true, stdio: 'inherit' });
  const exitCode = r.status === null ? -1 : r.status;
  const facts = readAcceptanceFacts(jsonFile);
  const problems = [];
  if (exitCode !== 0) problems.push(`期望 exit 0，实际 ${exitCode}`);
  problems.push(...acceptanceProblems(facts, exitCode));
  return {
    name,
    exitCode,
    ok: problems.length === 0,
    ms: Date.now() - started,
    logFile: jsonFile,
    tail: problems.length ? problems.join(' | ') : acceptanceSummary(facts),
  };
}

function readAcceptanceFacts(jsonFile) {
  try {
    const raw = readFileSync(jsonFile, 'utf8');
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return {
      ok: true,
      summary: parsed.summary,
      exitCode: parsed.exitCode,
      signal: parsed.signal,
      coverage: parsed.coverageRatio,
      skips: parsed.results.filter((x) => x.status === 'skip').map((x) => x.id),
      fails: parsed.results.filter((x) => x.status === 'fail').map((x) => x.id),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 验收结果的判据：不通过 / 新增未登记的 SKIP / JSON 的 exitCode 与真实退出码不一致。 */
function acceptanceProblems(f, exitCode) {
  if (!f.ok) return [`--json 结果不可解析: ${f.error}`];
  const out = [];
  if (f.fails.length) out.push(`机器判据失败: ${f.fails.join(', ')}`);
  if (f.exitCode !== exitCode) out.push(`--json 的 exitCode ${f.exitCode} ≠ 实际退出码 ${exitCode}`);
  const unknown = f.skips.filter((id) => !KNOWN_SKIPS[id]);
  if (unknown.length) out.push(`出现未登记的 SKIP: ${unknown.join(', ')}（跳过 ≠ 通过，必须登记原因或补齐输入）`);
  return out;
}

function acceptanceSummary(f) {
  const s = f.summary || {};
  const cover = `${s.covered}/${s.machineTotal}`;
  const skipTxt = f.skips.length ? `跳过 ${f.skips.length}(${f.skips.join(',')})` : '无跳过';
  return `通过 ${s.pass} · 失败 ${s.fail} · ${skipTxt} · 机器覆盖 ${cover} · signal=${f.signal}`;
}


function main() {
  const state = { evidenceProduced: false, evidenceOk: false };
  const plan = buildPlan(ctx, state);

  // --print-steps：只报清单，不执行。输出必须**纯 JSON**，check-contract 会当数据解析。
  if (args['print-steps']) {
    const manifest = plan.map((s) => ({ group: s.group, name: s.name, invokes: s.invokes }));
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
  }
  mkdirSync(LOG_DIR, { recursive: true });

  // ── 执行 + 汇总 ───────────────────────────────────────────────
  const results = [];
  for (const step of plan) {
    const r = step.mode === 'custom' ? withTimeout(step) : runCommand(step);
    results.push(r);
    /**
     * ★ 2026-11-13 修：evidenceProduced 必须在 make-evidence **执行完、后续步骤之前**就更新。
     *
     * 旧实现把它写在整轮循环**之后**（`state.evidenceProduced = results.some(...)`），
     * 而 evidence-chain 与 acceptance 是在**循环内**读它的 —— 于是它们读到的永远是初始 `false`，
     * 必然红。make-evidence 明明 PASS、evidence.json 也确实写出了，后两步却说"未产出证据"。
     *
     * 这正是本项目最反对的形态：「没检查」与「检查了没问题」症状同形 ——
     * 它连"make-evidence 成功了"这个**事实**都读不到，还给出了一个看起来很负责的拒绝理由。
     */
    if (r.name === 'make-evidence') {
      state.evidenceProduced = r.ok === true && existsSync(ctx.evOut);
    }
  }
  
  function withTimeout(step) {
    const started = Date.now();
    const r = step.run();
    return { group: step.group, invokes: step.invokes, ms: Date.now() - started, ...r };
  }
  
  /**
   * ── 汇总：按三类范围分段（A07）──────────────────────────────
   *
   * 三个数字分开打，因为它们的失效方式完全不同：
   *   · 工具健康红  ⇒ 判据/门禁自身不可信，此时"交付全绿"不作数；
   *   · 自举流程红  ⇒ 本项目的文档制品过不了自己的判据；
   *   · 交付检查红  ⇒ 只有它红，才说明"这次交付不合格"。
   * 合成一个总分会让人以为"17/18 差不多"，而实际上可能是最要紧的那类红。
   */
  const failed = results.filter((r) => !r.ok && !r.skipped);
  
  function printGroup(title) {
    const rows = results.filter((r) => r.group === title);
    const bad = rows.filter((r) => !r.ok && !r.skipped).length;
    console.log(`\n── ${title} · ${rows.length - bad}/${rows.length} ──`);
    for (const s of rows) {
      const mark = s.skipped ? 'SKIP' : s.ok ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${String(s.name).padEnd(22)} ${String(s.ms).padStart(6)} ms  ${s.tail || ''}`);
    }
  }
  
  console.log('\n=== self-check 汇总 ===');
  for (const g of Object.values(GROUP)) printGroup(g);
  console.log(`\n原始输出: ${LOG_DIR}`);
  
  if (failed.length) {
    console.log(`\n${failed.length}/${results.length} 项失败：`);
    for (const f of failed) console.log(`  - ${f.name}（exit ${f.exitCode}）${f.logFile ? ' 日志: ' + f.logFile : ''}`);
    process.exit(1);
  }
  
  const skipped = results.filter((s) => s.skipped);
  const executed = results.length - skipped.length;
  console.log(`\n全部 ${executed}/${results.length} 项通过` + (skipped.length ? `（${skipped.map((x) => x.name).join(', ')} 已跳过，本次不构成交付验收）` : ''));
  console.log(
    `范围声明: 工具健康 ${results.filter((r) => r.group === GROUP.TOOL).length} 项 · ` +
      `自举流程 ${results.filter((r) => r.group === GROUP.BOOT).length} 项 · ` +
      `交付检查 ${results.filter((r) => r.group === GROUP.DELIVERY).length} 项`,
  );
  
  /**
   * 跳过验收时的退出码（评审包 §5 Q4.6，2026-11-13 修正）。
   *
   * 原实现：`--skip-acceptance` 把该步标为 ok:true/skipped:true，最后无条件 exit 0。
   * 后果：「跳过了验收」与「验收通过」在退出码上**完全不可区分** ——
   * 只在文案里加一句"本次不构成交付验收"，属于"看见但无权改变仍是静默"。
   * CI 里 `node tools/self-check.mjs --skip-acceptance` 会被读成合格。
   *
   * 现在：有跳过项 ⇒ 退出码 3（INCOMPLETE，与 cli.mjs 同一语义）。
   * 依据是 SWITCH_CLASS 的 AUDITABLE 档要求「关闭后痕迹必须影响机器判定」——
   * 只印一行给人看的话不算。
   */
  if (skipped.length) {
    console.error(
      `\n${skipped.length} 项被显式跳过（${skipped.map((x) => x.name).join(', ')}）⇒ 退出码 3：` +
        '本次结果不完整，不得当作交付验收。要拿到可信结论请去掉跳过参数重跑。',
    );
    process.exit(3);
  }
  process.exit(0);
  
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
