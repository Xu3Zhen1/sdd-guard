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
  const cwd = args.cwd && args.cwd !== true ? resolve(args.cwd) : ROOT;
  const outDir = join(dirname(outPath), '.evidence-raw');
  mkdirSync(outDir, { recursive: true });

  console.log(`make-evidence @ ${cwd}`);
  console.log(`配置: ${existsSync(cfgPath) ? cfgPath : '(内置默认)'}`);

  const parts = {};
  const producers = {};
  const failures = [];

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
    if (r.exitCode !== 0) {
      // 命令自己失败：证据不可用。不把"失败但可解析"当成证据。
      console.log(`  ✗ 命令退出码 ${r.exitCode}（输出已解析但结果不可采信）`);
      failures.push(`${key}: 命令退出码 ${r.exitCode}`);
      continue;
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

  const evidence = buildEvidence(parts, {
    generatedAt: new Date().toISOString(),
    cwd,
    producers,
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