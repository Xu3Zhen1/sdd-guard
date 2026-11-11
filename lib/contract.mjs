// 契约单一真源（Single Source of Truth）。
//
// 为什么需要它：`--help` 文本、`ICD.md` 的表格、`args.mjs` 的可重复键、`rules.mjs` 里
// `cfg.x ?? 默认值` 四处都在描述同一组事实，却各写各的。2026-11-11 就因此出了两次事故：
//   · HELP 写"可重复"，实现是覆盖；
//   · ICD 写下未知 id 的处理，实现是静默空集。
// 现在 HELP 由本文件**生成**，ICD 由 tools/check-contract.mjs **校验**，
// 默认值由同一脚本与 rules.mjs 里的 `??` 字面量**比对**。四处只剩一处是手写的。

export const VERSION = '0.1.0';

/** 规则结论的四态。只增不改；新增须升次版本。 */
export const STATUSES = ['pass', 'fail', 'skip', 'manual'];

/** 进程退出码。语义冻结（S1）。 */
export const EXIT_CODES = { OK: 0, FAIL: 1, CONFIG: 2 };

/**
 * 命令行选项。
 * required / repeatable / boolean / value 四项共同决定解析行为与帮助文本。
 */
export const OPTIONS = [
  {
    key: 'change',
    required: true,
    value: '<dir>',
    desc: 'change 目录（含 proposal.md / specs/ / design.md / tasks.md）；不存在 ⇒ 退出码 2',
  },
  {
    key: 'config',
    value: '<file>',
    desc: '配置 JSON（阈值、依赖清单、允许前缀、行数预算）；不存在或非合法 JSON ⇒ 退出码 2',
  },
  {
    key: 'repo',
    value: '<dir>',
    desc: '路径基准（design/tasks 里的相对路径按此解析）。缺省取首个 --code 根，其次 --change',
  },
  {
    key: 'code',
    value: '<dir>',
    repeatable: true,
    desc: '被检代码根目录，可重复（累积，单次出现也归一为数组）',
  },
  {
    key: 'diff',
    value: '<file>',
    desc: '变更清单 JSON: {"files":[{"path":"a/b.ts","added":10,"deleted":2}]}',
  },
  {
    key: 'only',
    value: '<ids>',
    desc: '仅跑指定规则，逗号分隔，如 YAGNI-P1,KISS-S1。含未知 id ⇒ 退出码 2（不静默变空集）',
  },
  {
    key: 'profile',
    value: '<name>',
    desc: '档位: process（开发流程）/ acceptance（验收标准）/ all（默认）。acceptance 必须配 --evidence',
  },
  {
    key: 'evidence',
    value: '<file>',
    desc: '验收证据 JSON（tests / mutation / drift），见 ICD §5；acceptance 档缺它 ⇒ 退出码 2',
  },
  { key: 'json', boolean: true, desc: '输出 JSON 而非文本报告' },
  { key: 'strict', boolean: true, desc: 'manual 也视为失败（CI 用，慎用）' },
  { key: 'help', boolean: true, desc: '打印帮助' },
];

/** 配置文件键与默认值。改默认值 = 行为变更，须同步 ICD 与 README 并升次版本。 */
export const CONFIG_DEFAULTS = {
  maxNesting: 3,
  dupWindow: 6,
  dupMinChars: 40,
  yagniMinNonGoals: 3,
  dryMinReuse: 1,
  dependencies: {},
  allowedPrefixes: [],
  maxDiffLines: 400,
  // 前后端解耦：边界前缀表 { 边界名: [仓库相对前缀…] }
  boundaries: {},
  // 禁止的跨边界引用 [{ from, to }] 或 [[from, to]]
  forbidImports: [],
  // 契约文件必须落在这些前缀内（空 = 不限制）
  contractPrefixes: [],
  // 变异杀死率下限（acceptance 档 ACCEPT-E2）
  minMutationRatio: 0.8,
};

/** 允许重复出现的选项（由 OPTIONS 派生，`args.mjs` 直接引用，避免两套口径）。 */
export const REPEATABLE_KEYS = new Set(OPTIONS.filter((o) => o.repeatable).map((o) => o.key));

/**
 * 两套检查档位（profile）。**开发流程 ≠ 验收标准**：
 *
 *   process    —— 约束"怎么做"：四制品形态、契约声明、任务路径。开发过程中反复跑，
 *                 失败意味着「还没按流程走到位」，不意味着「交付不合格」。
 *   acceptance —— 约束"能不能交"：代码级判据 + 外部证据（测试/变异/漂移）。
 *                 只在交付前跑一次，失败意味着「不能收」。
 *
 * 档位由规则的 `stage` 派生（stage === 'code' ⇒ acceptance），不另设手工清单——
 * 手工清单必然与规则表漂移。
 */
export const PROFILES = {
  process: (rule) => rule.stage !== 'code',
  acceptance: (rule) => rule.stage === 'code',
};

export const PROFILE_NAMES = ['process', 'acceptance', 'all'];

/** 按档位筛规则。 */
export function rulesForProfile(rules, profile = 'all') {
  if (!profile || profile === 'all') return rules;
  const pred = PROFILES[profile];
  if (!pred) throw new Error(`未知档位: ${profile}（可用: ${PROFILE_NAMES.join(' / ')}）`);
  return rules.filter(pred);
}

/**
 * 外部证据契约（acceptance 档的唯一可信输入）。
 * sdd-guard 自己跑不了测试/变异，所以验收必须读**它没参与生产**的证据——
 * 否则就是「用被测对象自己出的成绩单判自己合格」。
 *
 * schema 见 docs/ICD.md §5。
 */
export const EVIDENCE_KEYS = ['tests', 'mutation', 'drift'];

/** 由契约生成帮助文本——不再手写，从而不可能与实现漂移。 */
export function renderHelp() {
  const required = OPTIONS.filter((o) => o.required);
  const optional = OPTIONS.filter((o) => !o.required);
  const fmt = (o) => {
    const flag = `--${o.key}${o.value ? ' ' + o.value : ''}`;
    return `  ${flag.padEnd(22)}${o.desc}`;
  };
  return [
    'sdd-guard —— 规格驱动开发的 YAGNI/KISS/DRY 机械判据检查器',
    '',
    '用法:',
    '  sdd-guard check --change <dir> [选项]',
    '',
    '两套档位（默认 all）:',
    '  --profile process      开发流程：四制品形态、契约声明、任务路径。途中反复跑。',
    '  --profile acceptance   验收标准：代码级判据 + 外部证据。交付前跑一次，缺 --evidence 即错。',
    '',
    '必选:',
    ...required.map(fmt),
    '',
    '可选:',
    ...optional.map(fmt),
    '',
    `退出码: ${EXIT_CODES.OK} = 机器规则全过; ${EXIT_CODES.FAIL} = 存在 fail（或 --strict 下存在 manual）; ${EXIT_CODES.CONFIG} = 输入/配置错误`,
    '',
    `结论四态: ${STATUSES.join(' | ')}`,
    '注意: SKIP 与 MANUAL 都不构成通过。报告末尾会打印覆盖率。',
    `契约真源: lib/contract.mjs 与 docs/ICD.md（由 tools/check-contract.mjs 校验一致性）`,
    '',
  ].join('\n');
}