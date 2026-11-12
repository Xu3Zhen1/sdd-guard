#!/usr/bin/env node
// sdd-guard —— 把 YAGNI/KISS/DRY 里可机械判定的部分变成会 FAIL 的检查。
// 退出码: 0=机器规则全过, 1=有 fail, 2=输入/配置错误
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRules, formatText, summarize, selectRules, EXIT } from './lib/runner.mjs';
import { RULES } from './lib/rules.mjs';
import { parseArgs } from './lib/args.mjs';
import { renderHelp, PROFILE_NAMES, EVIDENCE_KEYS } from './lib/contract.mjs';
import { missingEvidenceKeys } from './lib/evidence.mjs';

function loadConfig(p) {
  if (!p || p === true) return {};
  const full = resolve(p);
  if (!existsSync(full)) throw new Error(`配置文件不存在: ${full}`);
  return JSON.parse(readFileSync(full, 'utf8'));
}

function loadDiff(p) {
  if (!p || p === true) return null;
  const full = resolve(p);
  if (!existsSync(full)) throw new Error(`diff 文件不存在: ${full}`);
  return JSON.parse(readFileSync(full, 'utf8'));
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
  if (!args.change || args.change === true) {
    console.error('缺少 --change <dir>');
    process.exit(EXIT.CONFIG);
  }

  let cfg, diff, evidence, changeDir;
  try {
    cfg = loadConfig(args.config);
    diff = loadDiff(args.diff);
    evidence = loadDiff(args.evidence); // 同一个「读 JSON 文件」实现，避免两份 loader
    changeDir = resolve(args.change);
    if (!existsSync(changeDir)) throw new Error(`change 目录不存在: ${changeDir}`);
  } catch (e) {
    console.error(`配置错误: ${e.message}`);
    process.exit(EXIT.CONFIG);
  }

  const codeRoots = args.code ? (Array.isArray(args.code) ? args.code : [args.code]).map((p) => resolve(p)) : [];
  const repo = args.repo && args.repo !== true ? resolve(args.repo) : null;
  const only = args.only && args.only !== true ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;

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
  });
  const summary = summarize(results);

  if (args.json) {
    console.log(JSON.stringify({ repo: ctx.repo, profile, results, summary }, null, 2));
  } else {
    console.log(`sdd-guard @ ${changeDir}`);
    console.log(`路径基准(repo): ${ctx.repo}`);
    console.log(`档位(profile): ${profile}${profile === 'all' ? '' : profile === 'process' ? '（开发流程）' : '（验收标准）'}`);
    console.log(formatText(results));
  }

  const hardFail = summary.fail > 0 || (args.strict && summary.manual > 0);

  /**
   * 覆盖率守卫（2026-11-12 外部实测发现的缺口）。
   *
   * 缺口形态：change 目录里**什么都没写**时，13 条机器规则全 SKIP，
   * 汇总报「通过 0 · 失败 0 · 跳过 13」，而硬失败只看 `fail > 0`
   * ⇒ **退出码 0 ⇒ CI 放行空提交**。
   *
   * 实测确认：空 change 目录 → 通过 1(仅 DISCIPLINE-C2)· 失败 0 · 跳过 16 · **EXIT=0**。
   * 「一个空的 change 目录在 CI 里算通过」——这比任何单条规则的缺陷都严重。
   *
   * 为什么默认不启用（`--min-coverage` 缺省关闭）：
   * `process` 档的用法是"边写边查"，文档没写完就 skip 是合理的，
   * 判 fail 会打断正常流程。所以这是一个**显式选择**：
   * 想用它守 CI 的人自己加参数，不想被打断的人什么都不用改。
   * 这是「不改变既有语义的选项」，不是"又一处静默跳过"。
   */
  let coverageFail = false;
  if (args['min-coverage'] !== undefined) {
    const min = Number(args['min-coverage']);
    if (!Number.isFinite(min) || min < 0 || min > 1) {
      console.error(`--min-coverage 需为 0..1 的数字，收到: ${args['min-coverage']}`);
      process.exit(EXIT.CONFIG);
    }
    const ratio = summary.machineTotal > 0 ? summary.covered / summary.machineTotal : 0;
    if (ratio < min) {
      coverageFail = true;
      console.error(
        `机器规则覆盖率 ${summary.covered}/${summary.machineTotal} = ${ratio.toFixed(2)} < 下限 ${min}`,
      );
      console.error(
        '覆盖率不足意味着「没检查」，不等于「检查了没问题」。' +
          '请补全 changes/<id>/ 下的 proposal/design/tasks/specs 与 --code 目录。',
      );
    }
  }

  process.exit(hardFail || coverageFail ? EXIT.FAIL : EXIT.OK);
}

main();
