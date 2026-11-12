#!/usr/bin/env node
// make-evidence —— 调项目**自己的**命令，把输出解析成 sdd-guard 验收档可读的 evidence.json。
//
// 它是"证据生产者"，不是"判定者"：判定在 `cli.mjs check --profile acceptance`。
// 三条不可妥协的纪律：
//   ① 任何一步失败 ⇒ 退出码 1，并**不把该证据写进结果**（不写 0，不写 null）；
//   ② 输出必须由解析器验过（自相矛盾/找不到汇总行即抛错），不接受"看起来成功了"；
//   ③ 每条证据带 provenance（命令、退出码、cwd、输出 sha256），可审计。
//
// 为什么要自己重定向到文件而不是读 stdout：沙箱化的子进程里 piped stdio 会 EPERM，
// 且直接把输出写成文件让证据可复查（同一份 txt 可人工重看）。
//
// 用法：
//   node tools/make-evidence.mjs [--config evidence.config.json] [--out evidence.json]
// 配置（同名 JSON，缺省用内置默认）：
//   { "tests": {"command": "node test/guard.test.mjs"},
//     "mutation": {"command": "node test/mutation.mjs"},
//     "drift": {"command": "node tools/check-contract.mjs"},
//     "keepOutputs": true }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARSERS, PARSER_BY_KEY, buildEvidence, digest } from '../lib/evidence.mjs';
import { EVIDENCE_KEYS } from '../lib/contract.mjs';

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
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function runStep(key, step, cwd, outDir) {
  const command = step && step.command;
  if (!command) return { skipped: true, reason: '配置里没有这一项' };

  const outFile = join(outDir, `${key}.txt`);
  // 用 shell 重定向而不是捕获 stdout：既避开 piped-stdio 的平台限制，也留下可复查的输出。
  const full = `${command} > "${outFile}" 2>&1`;
  const r = spawnSync(full, { cwd, shell: true, stdio: 'inherit' });

  const exitCode = r.status === null ? -1 : r.status;
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
    parsed = parser(text);
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
      sha256: digest(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      outputFile: step.keepOutputs ? outFile : undefined,
    },
  };
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

  const outDir = join(dirname(outPath), '.evidence-raw');
  mkdirSync(outDir, { recursive: true });

  console.log(`make-evidence @ ${cwd}`);
  console.log(`配置: ${existsSync(cfgPath) ? cfgPath : '(内置默认)'}`);

  const parts = {};
  const producers = {};
  const failures = [];
  const warnings = [];

  for (const key of EVIDENCE_KEYS) {
    const step = config[key];
    if (!step) continue;
    process.stdout.write(`  … ${key}: ${step.command}`);
    const r = runStep(key, { ...step, keepOutputs: config.keepOutputs }, cwd, outDir);
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
    if (r.exitCode !== 0) {
      if (step.requireZeroExit === true) {
        console.log(`  ✗ 命令退出码 ${r.exitCode}（该步声明 requireZeroExit，结果不采信）`);
        failures.push(`${key}: 命令退出码 ${r.exitCode}（requireZeroExit）`);
        continue;
      }
      warnings.push(`${key}: 命令退出码 ${r.exitCode}（输出可解析，已采信；由判据按解析结果定红）`);
    }

    parts[key] = r.parsed;
    producers[key] = r.provenance;
    console.log(`  ✓ ${JSON.stringify(r.parsed).slice(0, 90)}`);
  }

  if (failures.length) {
    console.error('\n证据不完整，拒绝写出：');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\n原始输出保留在 ${outDir}（可人工复核）`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log('\n注意（已采信，但事实记在这里，报告也会带上）：');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const evidence = buildEvidence(parts, {
    generatedAt: new Date().toISOString(),
    cwd,
    producers,
    warnings,
    tool: 'sdd-guard/tools/make-evidence.mjs',
  });

  const missing = EVIDENCE_KEYS.filter((k) => evidence[k] === undefined);
  if (missing.length) {
    console.error(`\n缺少证据键: ${missing.join(', ')}（acceptance 档要求全部三个）`);
    process.exit(1);
  }

  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`\n已写出 ${outPath}`);
  console.log(`验收命令: node cli.mjs check --change <dir> --profile acceptance --evidence ${outPath}`);
}

main();