#!/usr/bin/env node
// self-check —— 一条命令跑完「开发流程 + 验收标准」的全部自检。
//
// 为什么要有它：一条流程如果要在 6 条命令里手敲，就不会被执行。
// 但"一条命令"必须保持诚实：
//   · 每一步都留原始输出，失败即整条命令失败（不 catch 后继续、不把 fail 变成 warn）；
//   · 汇总里逐项列出 PASS/FAIL 与耗时，不接受"最后一行说成功"；
//   · 验收步骤用的是**刚刚真实跑出来的证据**，不是仓库里躺着的旧 evidence.json。
//
// 用法：
//   node tools/self-check.mjs                      # 用自带的夹具做自检（开发者用）
//   node tools/self-check.mjs --change <目录> --repo <仓库> --config <配置> --code <根> [--code <根>…]
//   node tools/self-check.mjs --skip-acceptance    # 只跑测试/变异/漂移/证据

import { EVIDENCE_KEYS } from '../lib/contract.mjs';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, '.selfcheck');

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
mkdirSync(LOG_DIR, { recursive: true });

/** 跑一条命令，输出重定向到文件（可事后复核），返回 {ok, exitCode, logFile, tail}。 */
function run(name, command, extraLog = '') {
  const logFile = join(LOG_DIR, `${name}.txt`);
  const started = Date.now();
  process.stdout.write(`  … ${name.padEnd(18)} ${command}\n`);
  const r = spawnSync(`${command} > "${logFile}" 2>&1`, { cwd: ROOT, shell: true, stdio: 'inherit' });
  const exitCode = r.status === null ? -1 : r.status;
  const ms = Date.now() - started;
  const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const tail = text
    .split('\n')
    .filter((l) => l.trim())
    .slice(-3)
    .join(' | ')
    .slice(0, 160);
  if (extraLog) {
    // 供人看的关键行（如覆盖率），不代表通过与否
  }
  return { name, command, exitCode, ok: exitCode === 0, ms, logFile, tail };
}

const steps = [];

// ── 1. 测试 ─────────────────────────────────────────────────
for (const f of ['test/guard.test.mjs', 'test/args.test.mjs', 'test/evidence.test.mjs']) {
  steps.push(run(f.replace('test/', '').replace('.test.mjs', ''), `node ${f}`));
}

// ── 2. 变异（判据有没有判别力）────────────────────────────
steps.push(run('mutation', 'node test/mutation.mjs'));

// ── 3. 契约漂移 ─────────────────────────────────────────────
steps.push(run('contract', 'node tools/check-contract.mjs'));

// ── 4. 生产证据（用刚跑出来的真实结果，不是旧文件）──────────
// 先删旧证据：否则 make-evidence 失败时，验收会拿上一次的 evidence.json 跑出假绿。
const evOut = join(ROOT, 'evidence.json');
if (existsSync(evOut)) rmSync(evOut);
steps.push(run('make-evidence', `node tools/make-evidence.mjs --out "${evOut}" --repo .`));
const evidenceProduced = steps[steps.length - 1].ok && existsSync(evOut);

// ── 4b. 校验证据链完整性（provenance 齐全）──────────────────
if (evidenceProduced) {
  try {
    const ev = JSON.parse(readFileSync(evOut, 'utf8'));
    const missing = EVIDENCE_KEYS.filter((k) => ev[k] === undefined);
    const noProv = EVIDENCE_KEYS.filter((k) => !ev.meta?.producers?.[k]?.sha256);
    if (missing.length || noProv.length) {
      steps.push({
        name: 'evidence-chain',
        command: '(检查 evidence.json)',
        exitCode: 1,
        ok: false,
        ms: 0,
        tail: `缺键: ${missing.join(',') || '无'} | 无 provenance: ${noProv.join(',') || '无'}`,
      });
    } else {
      steps.push({ name: 'evidence-chain', command: '(检查 evidence.json)', exitCode: 0, ok: true, ms: 0, tail: '三键齐全，provenance 完整' });
    }
  } catch (e) {
    steps.push({ name: 'evidence-chain', command: '(检查 evidence.json)', exitCode: 1, ok: false, ms: 0, tail: `不可解析: ${e.message}` });
  }
}

// ── 5. 验收（缺证据/缺 change 就明确失败，不静默跳过）──────
// 默认对 **sdd-guard 自己** 跑验收（自举），而不是对夹具——
// 夹具在单元测试里已被覆盖；self-check 存在的意义是"项目自己能不能过关"。
const change = args.change && args.change !== true ? resolve(args.change) : join(ROOT, 'changes/self-host-guard');
const repo = args.repo && args.repo !== true ? resolve(args.repo) : ROOT;
const config = args.config && args.config !== true ? resolve(args.config) : join(ROOT, 'guard.config.json');
const codeRoots = args.code.length
  ? args.code.map((c) => resolve(c))
  : ['lib', 'tools', 'cli.mjs'].map((p) => join(ROOT, p));

if (args['skip-acceptance']) {
  steps.push({ name: 'acceptance', command: '(已按 --skip-acceptance 跳过)', exitCode: null, ok: true, skipped: true, ms: 0, tail: '' });
} else if (!evidenceProduced) {
  steps.push({
    name: 'acceptance',
    command: '(本次未产出证据)',
    exitCode: 1,
    ok: false,
    ms: 0,
    tail: 'make-evidence 本次失败，验收拒绝用旧证据',
  });
} else {
  const codeArgs = codeRoots.map((c) => `--code "${c}"`).join(' ');
  steps.push(
    run(
      'acceptance',
      `node cli.mjs check --change "${change}" --profile acceptance --evidence "${evOut}" --repo "${repo}" --config "${config}" ${codeArgs}`,
    ),
  );
}

// ── 汇总 ────────────────────────────────────────────────────
const failed = steps.filter((s) => !s.ok);
console.log('\n=== self-check 汇总 ===');
for (const s of steps) {
  const mark = s.skipped ? 'SKIP' : s.ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${s.name.padEnd(18)} ${String(s.ms).padStart(6)} ms  ${s.tail}`);
}
console.log(`\n原始输出: ${LOG_DIR}`);
if (failed.length) {
  console.log(`\n${failed.length}/${steps.length} 项失败：`);
  for (const f of failed) console.log(`  - ${f.name}（exit ${f.exitCode}）${f.logFile ? ' 日志: ' + f.logFile : ''}`);
  process.exit(1);
}
const executed = steps.filter((s) => !s.skipped).length;
const skipped = steps.filter((s) => s.skipped);

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
console.log(`\n全部 ${executed}/${steps.length} 项通过` + (skipped.length ? `（${skipped.map((x) => x.name).join(', ')} 已跳过，本次不构成交付验收）` : ''));
if (skipped.length) {
  console.error(
    `\n${skipped.length} 项被显式跳过（${skipped.map((x) => x.name).join(', ')}）⇒ 退出码 3：` +
      '本次结果不完整，不得当作交付验收。要拿到可信结论请去掉跳过参数重跑。',
  );
  process.exit(3);
}
process.exit(0);