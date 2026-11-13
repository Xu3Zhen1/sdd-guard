#!/usr/bin/env node
// make-evidence —— 调项目**自己的**命令，把输出解析成 sdd-guard 验收档可读的 evidence.json。
//
// 它是"证据生产者"，不是"判定者"：判定在 `cli.mjs check --profile acceptance`。
// 四条不可妥协的纪律：
//   ① 任何一步失败 ⇒ 退出码 1，并**不把该证据写进结果**（不写 0，不写 null）；
//   ② 输出必须由解析器验过（自相矛盾/找不到汇总行/清单不完整即抛错），不接受"看起来成功了"；
//   ③ 每条证据带 provenance（命令、退出码、cwd、输出**完整** sha256），可审计；
//   ④ **失败时旧输出必须消失**（A10 修）：开始时先把 outPath 隔离掉，成功后原子写。
//
// 为什么要自己重定向到文件而不是读 stdout：沙箱化的子进程里 piped stdio 会 EPERM，
// 且直接把输出写成文件让证据可复查（同一份 txt 可人工重看）。
//
// 用法：
//   node tools/make-evidence.mjs --repo . [--config evidence.config.json] [--out evidence.json]
//                                [--expected-mutants 12] [--keep-outputs]
// 配置（同名 JSON，缺省用内置默认）：
//   { "tests": {"command": "node test/guard.test.mjs"},
//     "mutation": {"command": "node test/mutation.mjs"},
//     "drift": {"command": "node tools/check-contract.mjs"},
//     "expectedMutants": 12,          // 或 ["M1","M2",…] 逐条清单
//     "keepOutputs": true }

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { PARSERS, PARSER_BY_KEY, buildEvidence, digest, digestShort } from '../lib/evidence.mjs';
import { EVIDENCE_KEYS } from '../lib/contract.mjs';
import { isNonNegInt, isStringArray } from '../lib/values.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_CONFIG = {
  tests: { command: 'node test/guard.test.mjs' },
  mutation: { command: 'node test/mutation.mjs' },
  drift: { command: 'node tools/check-contract.mjs' },
  keepOutputs: false,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * 跑一个外部命令并**把 stdout 收进文件**，全程不经过管道。
 *
 * ★ 为什么用 shell 重定向而不是 `encoding:'utf8'` 捕获：
 * 本机沙箱里 piped stdio 会直接 `spawn … EPERM`（2026-11-13 实测）。
 * 重定向到文件既避开 EPERM，又天然留下可复查的原始输出。
 *
 * shell:true 是必须的：配置里给的是**命令字符串**（可能带 `&&`、重定向、引号），
 * 这是面向人的配置文件，不是 argv 数组。
 */
function runToFile(command, cwd, outFile) {
  const r = spawnSync(`${command} > "${outFile}" 2>&1`, { cwd, shell: true, stdio: 'inherit' });
  return { status: r.status === null ? -1 : r.status, error: r.error };
}

/**
 * 跑 git 并把输出收进文件。
 * 同样用 shell 重定向（理由见 runToFile）。这里的参数**由本文件构造**、
 * 不含任何外部输入，所以走 shell 没有注入风险；git 子命令本身固定。
 * @returns {{ok:true,text:string}|{ok:false,reason:string}}
 */
function gitToFile(repo, args, outFile) {
  const cmd = `git ${args.map((a) => `"${a}"`).join(' ')}`;
  const r = spawnSync(`${cmd} > "${outFile}" 2>&1`, { cwd: repo, shell: true, stdio: 'inherit' });
  if (r.error) return { ok: false, reason: `git 不可用: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `git ${args.join(' ')} 退出码 ${r.status}` };
  return { ok: true, text: readFileSync(outFile, 'utf8') };
}

/**
 * 代码树身份（A10 修）。
 *
 * **为什么必须有**：证据只带"输出 sha256"时，它绑定的是**那一次输出的文本**，
 * 不是**产出该输出的代码树**。同一份 evidence.json 可以被贴到任意提交上说"我验过了"。
 *
 * 采集两项：`git rev-parse HEAD`（哪个提交）+ `git status --porcelain`（工作树脏不脏，
 * 脏的话必须留下脏的指纹 —— 否则"在改动未提交的树上跑出来的绿"会被当成该提交的绿）。
 *
 * **git 不可用时不得静默当作已绑定**：记 `{available:false, reason}`，
 * 让下游/人一眼看出这份证据没有代码树身份。
 */
function treeIdentity(repo, scratchDir) {
  const headFile = join(scratchDir, 'git-head.txt');
  const statusFile = join(scratchDir, 'git-status.txt');
  const head = gitToFile(repo, ['rev-parse', 'HEAD'], headFile);
  if (!head.ok) return { available: false, reason: head.reason };
  const sha = head.text.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    return { available: false, reason: `git rev-parse HEAD 输出不像提交号: ${JSON.stringify(sha.slice(0, 80))}` };
  }
  const st = gitToFile(repo, ['status', '--porcelain'], statusFile);
  if (!st.ok) return { available: false, reason: `无法读取工作树状态: ${st.reason}` };
  const statusText = st.text;
  const dirtyLines = statusText.split('\n').filter((l) => l.trim());
  return {
    available: true,
    head: sha,
    headShort: sha.slice(0, 7),
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    // 工作树状态的摘要：dirty=true 的树上跑出来的证据**不能**当作该提交的验证。
    statusSha256: digest(statusText),
    statusSample: dirtyLines.slice(0, 20),
  };
}

function runStep(key, step, cwd, outDir, parserOpts) {
  const command = step && step.command;
  if (!command) return { skipped: true, reason: '配置里没有这一项' };

  const outFile = join(outDir, `${key}.txt`);
  const r = runToFile(command, cwd, outFile);
  const exitCode = r.status;

  if (!existsSync(outFile)) {
    return { ok: false, reason: `命令没有产出输出文件（命令: ${command}）`, exitCode };
  }
  const text = readFileSync(outFile, 'utf8');
  const parserName = step.parser || PARSER_BY_KEY[key];
  const parser = PARSERS[parserName];
  if (!parser) {
    return { ok: false, reason: `未知解析器: ${parserName}`, exitCode, text };
  }

  let parsed;
  try {
    parsed = parser(text, parserOpts);
  } catch (e) {
    return { ok: false, reason: `解析失败(${parserName}): ${e.message}`, exitCode, text };
  }

  return {
    ok: true,
    exitCode,
    parsed,
    provenance: {
      command,
      exitCode,
      cwd,
      // ★ A11：字段名叫 sha256，就必须是**完整 64 位**。16 位前缀另存 digest16。
      sha256: digest(text),
      digest16: digestShort(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      outputFile: step.keepOutputs ? outFile : undefined,
      parser: parserName,
    },
  };
}

/**
 * 开始时隔离旧输出（A10 核心修复）。
 *
 * **审计实证的缺陷**：失败时只在末尾 `exit(1)`，旧 evidence.json 字节完全不变；
 * 随后把它交给真实 CLI acceptance，**exit 0**。于是"这次没跑成"被读成"证据说合格"。
 *
 * 判据：**任何一次运行开始时，上一次的输出就不再有效**。
 *   · 有旧文件 ⇒ 改名成 `<out>.stale`（保留供人比对，但**不再是** outPath 本身）；
 *   · 没有旧文件 ⇒ 什么都不做。
 * 失败退出后 outPath 不存在 ⇒ 下游 CLI 的"缺证据"预检会直接拦住。
 *
 * ★ 隔离目标必须落在**已被 .gitignore 覆盖**的目录里（`.evidence-raw/`）：
 * 证据正文含本机绝对路径（cwd），若 `.stale` 躺在仓库根，它会被
 * tools/check-publish.mjs 当作"拟提交文件"扫出本机绝对路径 ⇒ 发布判据变红。
 * 把垃圾留在**会被人看见的地方**之前，先让它落在已忽略目录里。
 */
function quarantineOldOutput(outPath, outDir) {
  if (!existsSync(outPath)) return null;
  const stale = join(outDir, `${basename(outPath)}.stale`);
  try {
    rmSync(stale, { force: true });
    renameSync(outPath, stale);
    return stale;
  } catch (e) {
    // 改名失败（跨设备/被占用）时退化为删除 —— 宁可丢旧文件，也不能让它继续冒充本次证据。
    try {
      rmSync(outPath, { force: true });
      return `(已删除，改名失败: ${e.message})`;
    } catch {
      return null;
    }
  }
}

/** 原子写：先写 `<path>.tmp-<pid>`，fsync 语义靠 rename 的原子性，最后 rename 覆盖。 */
function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfgPath = args.config && args.config !== true ? resolve(args.config) : join(ROOT, 'evidence.config.json');
  const config = existsSync(cfgPath)
    ? { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(cfgPath, 'utf8')) }
    : DEFAULT_CONFIG;
  const outPath = args.out && args.out !== true ? resolve(args.out) : join(ROOT, 'evidence.json');

  /**
   * 工作目录默认值（2026-11-12 修）。
   *
   * 历史缺陷：早期 `cwd` 不传就默认 `ROOT`，即 **sdd-guard 自己的仓库根**。
   * 于是拿它去验别的项目时，三个生产者全部在 sdd-guard 目录执行 →
   * 全部 `Cannot find module` → 三键全失败 →「证据不完整，拒绝写出」。
   * 文档也没提这一点，等于默认路径是个陷阱。
   *
   * 现在的优先级：--cwd > --repo > 报错。**不再静默回落到 ROOT**。
   */
  const cwdFromArgs = args.cwd && args.cwd !== true ? resolve(args.cwd) : null;
  const cwdFromRepo = args.repo && args.repo !== true ? resolve(args.repo) : null;
  const cwd = cwdFromArgs ?? cwdFromRepo;
  if (!cwd) {
    console.error('必须指定工作目录：用 --cwd <dir>（推荐）或 --repo <dir>。');
    console.error('  早期版本默认回落到 sdd-guard 自身仓库根，导致"验别人的项目却在自己目录里跑命令"。');
    console.error('  这个默认值已移除——请显式指定。');
    process.exit(2);
  }
  if (!existsSync(cwd)) {
    console.error(`工作目录不存在: ${cwd}`);
    process.exit(2);
  }

  /**
   * `--expected-mutants <n>` / 配置里的 `expectedMutants`。
   *
   * 用途：变异报告的**清单完整性**。没有它（且报告里也没 `MUTANT_TOTAL=`）时，
   * 解析器只能给 completeness='unknown' —— "只有一条变异的报告"与"报告被截断到只剩一条"
   * 在文本上同形，两者绝不能都算满分证据。
   */
  let expectedMutants;
  if (args['expected-mutants'] !== undefined) {
    const raw = args['expected-mutants'];
    if (raw === true) {
      console.error('--expected-mutants 缺少取值（应为非负整数条数）');
      process.exit(2);
    }
    const n = Number(raw);
    if (!isNonNegInt(n)) {
      console.error(`--expected-mutants 需为非负整数，收到: ${JSON.stringify(raw)}`);
      process.exit(2);
    }
    expectedMutants = n;
  } else if (config.expectedMutants !== undefined) {
    const e = config.expectedMutants;
    if (isStringArray(e) || isNonNegInt(e)) expectedMutants = e;
    else {
      console.error(`evidence.config.json 的 expectedMutants 需为非负整数或字符串数组，收到: ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:.]/g, '')}-${process.pid}-${randomUUID().slice(0, 8)}`;

  const outDir = join(dirname(outPath), '.evidence-raw');
  mkdirSync(outDir, { recursive: true });

  // ★ 第一步就是隔离旧输出：之后无论在哪一步失败，outPath 都不存在。
  const quarantined = quarantineOldOutput(outPath, outDir);
  if (quarantined) console.log(`旧证据已隔离: ${outPath} → ${quarantined}`);

  console.log(`make-evidence @ ${cwd}`);
  console.log(`配置: ${existsSync(cfgPath) ? cfgPath : '(内置默认)'}`);
  console.log(`runId: ${runId}`);

  const parts = {};
  const producers = {};
  const failures = [];
  const warnings = [];

  for (const key of EVIDENCE_KEYS) {
    const step = config[key];
    if (!step) continue;
    process.stdout.write(`  … ${key}: ${step.command}`);
    const parserOpts = key === 'mutation' ? { expectedMutants } : undefined;
    const r = runStep(key, { ...step, keepOutputs: config.keepOutputs }, cwd, outDir, parserOpts);
    if (r.skipped) {
      console.log('  (跳过)');
      continue;
    }
    if (!r.ok) {
      console.log(`  ✗ ${r.reason}`);
      failures.push(`${key}: ${r.reason}`);
      continue;
    }

    /**
     * 退出码语义（2026-11-12 修）。
     *
     * 历史缺陷：早期把「退出码非 0」一律当作「结果不可采信」，于是
     * 一个如实报告"460 跑、4 红"的生产者因为退出码 1 被整份拒收 ——
     * **连"跑了 460、红的是这 4 条"这个事实都留不下来，只剩"什么都没记录"。**
     *
     * 现在的判据：**能不能解析**才是"可不可信"的分界线；退出码只表示
     * "被测项目自己健不健康"。解析成功 ⇒ 证据可用，退出码进 provenance 留痕，
     * 由 ACCEPT-E1 依据解析出的 fail 数去判红 —— 而不是让生产者闭嘴。
     *
     * 需要"命令必须成功才算数"的生产者，对该步显式写 `requireZeroExit: true`。
     */
    if (r.exitCode !== 0 && step.requireZeroExit === true) {
      console.log(`  ✗ 命令退出码 ${r.exitCode}（该步声明 requireZeroExit，结果不采信）`);
      failures.push(`${key}: 命令退出码 ${r.exitCode}（requireZeroExit）`);
      continue;
    }
    // 非零但输出可解析 ⇒ 采信，退出码进 provenance；由判据按解析结果定红，而不是让生产者闭嘴。
    if (r.exitCode !== 0) {
      warnings.push(`${key}: 命令退出码 ${r.exitCode}（输出可解析，已采信；由判据按解析结果定红）`);
    }

    parts[key] = r.parsed;
    producers[key] = r.provenance;
    console.log(`  ✓ ${JSON.stringify(r.parsed).slice(0, 90)}`);
  }

  if (failures.length) {
    console.error('\n证据不完整，拒绝写出：');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\n${outPath} 已被隔离/不存在：本次失败不会被上一次的旧证据顶替。`);
    console.error(`原始输出保留在 ${outDir}（可人工复核）`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log('\n注意（已采信，但事实记在这里，报告也会带上）：');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const tree = treeIdentity(cwd, outDir);
  if (!tree.available) {
    console.log(`\n⚠ 代码树身份不可用: ${tree.reason}`);
    console.log('  这份证据**没有**绑定到任何提交（meta.tree.available=false），下游不得当作已验证某个版本。');
  } else {
    console.log(`\n代码树: ${tree.headShort}${tree.dirty ? `（工作树脏，${tree.dirtyCount} 项未提交）` : '（干净）'}`);
  }

  const finishedAt = new Date().toISOString();
  const evidence = buildEvidence(parts, {
    // ★ runId 是"哪一次运行"的唯一标识；acceptance 侧据此做 freshness 比对（A10）。
    runId,
    startedAt,
    finishedAt,
    generatedAt: finishedAt,
    cwd,
    tree,
    producers,
    warnings,
    expectedMutants: expectedMutants ?? null,
    tool: 'sdd-guard/tools/make-evidence.mjs',
  });

  const missing = EVIDENCE_KEYS.filter((k) => evidence[k] === undefined);
  if (missing.length) {
    console.error(`\n缺少证据键: ${missing.join(', ')}（acceptance 档要求全部三个）`);
    process.exit(1);
  }

  atomicWriteJson(outPath, evidence);

  /**
   * 末次运行收据（A10）。
   *
   * 为什么要单独一份：evidence.json 可能被复制/挪动，而"最近一次**成功**的运行是谁"
   * 必须有一个**不随证据文件漂移**的锚点。下游可用
   * `evidence.meta.runId === runRecord.runId` 判断这份证据是否就是最新产物。
   *
   * ★ 落点必须选**已被 .gitignore 覆盖**的目录。收据里有 cwd（本机绝对路径），
   * 若放在仓库根，tools/check-publish.mjs 会把它当作"拟提交文件"扫出本机绝对路径
   * ⇒ 发布判据变红。所以放进 `.evidence-raw/`（该目录已在 .gitignore 里），
   * 与"旧证据隔离文件"同一个理由。
   */
  const runRecordPath = join(outDir, 'evidence-run.json');
  atomicWriteJson(runRecordPath, {
    runId,
    outPath,
    cwd,
    startedAt,
    finishedAt,
    tree: tree.available ? { available: true, head: tree.head, dirty: tree.dirty } : { available: false, reason: tree.reason },
  });

  console.log(`\n已写出 ${outPath}`);
  console.log(`runId: ${runId}`);
  console.log(`运行收据: ${runRecordPath}`);
  console.log(`验收命令: node cli.mjs check --change <dir> --profile acceptance --evidence ${outPath}`);
}

main();


