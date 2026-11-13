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
// ★ 2026-11-13 增加 INCOMPLETE（评审包 §5 Q4.5）。
// 它表「判据自身不可信 / 没跑完」——与 FAIL（判据判定不合格）语义相反，
// 合流会让 CI 无法分流，详见 cli.mjs 的退出码注释。
export const EXIT_CODES = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 3 };

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
    value: '<dir|file>',
    repeatable: true,
    desc:
      '被检代码根：目录（递归）或单个文件，可重复（累积）。不可读/不存在/非源码后缀 ⇒ 退出码 2（不静默贡献 0 个文件）',
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
  {
    key: 'min-coverage',
    value: '<0..1>',
    desc:
      '机器规则的最低执行覆盖率（covered / machineTotal）。低于它 ⇒ 退出码 3（没跑完≠不合格）。' +
      '默认不启用；CI 建议给 0.8 —— 否则「什么都没写」与「全部通过」都是退出码 0',
  },
  {
    key: 'strict-args',
    boolean: true,
    desc: '严格参数模式：未知选项、缺少取值、类型不符一律退出码 2（默认模式只对必需项做校验）',
  },
  { key: 'help', boolean: true, desc: '打印帮助' },
];

/**
 * 配置文件键与默认值。改默认值 = 行为变更，须同步 ICD 与 README 并升次版本。
 *
 * ★ `maxDiffLines` **故意没有默认值**（2026-11-14 取消隐式预算）。
 *
 * 旧行为：`maxDiffLines: 400` + `rules.mjs` 里 `?? 400` ⇒ **任何项目不写配置，
 * 默认就被 400 行约束**。那是把一项政策选择（预算该多大）藏进了默认值，
 * 使用者既看不见也不知道自己在被什么约束。
 *
 * 现在的语义：**字段缺省 = 行数预算未启用**。要约束就显式写。
 * 注意 `0` 不等于未启用 —— `0` 是「零行预算」（禁止任何变更），见 `lib/config.mjs`。
 *
 * 这个键仍必须出现在 `CONFIG_SCHEMA` 里（否则配置校验不认它），
 * 也必须出现在 ICD 里（`tools/check-contract.mjs` 改为以 schema 为依据枚举）。
 */
export const CONFIG_DEFAULTS = {
  maxNesting: 3,
  dupWindow: 6,
  dupMinChars: 40,
  yagniMinNonGoals: 3,
  dryMinReuse: 1,
  dependencies: {},
  allowedPrefixes: [],
  /** DISCIPLINE-C3 反向检查的代码范围（空 = 全查）。见 docs/DESIGN-RATIONALE.md。 */
  codeScopes: [],
  // 前后端解耦：边界前缀表 { 边界名: [仓库相对前缀…] }
  boundaries: {},
  // 禁止的跨边界引用 [{ from, to }] 或 [[from, to]]
  forbidImports: [],
  // 契约文件必须落在这些前缀内（空 = 不限制）
  contractPrefixes: [],
  // 变异杀死率下限（acceptance 档 ACCEPT-E2）
  minMutationRatio: 0.8,
  /**
   * 等价变异声明：这些变异在语言语义上不可杀死，应从分母中扣除。
   *
   * 为什么需要它（2026-11-12 实测）：真实项目里存在物理不可杀的变异，例如
   * `String(s) === s` 恒真（JS 字符串是值类型）、`toBuffer` 对 Buffer 入参
   * 字节相同仅引用不同。硬阈值会把这类必然误红。
   *
   * 但**不能让人随手豁免**：每条必须带 `reason`，且 evidence 里全程留痕；
   * 无 reason 的条目判 FAIL。扣除后的分母若为 0 也判 FAIL（空集陷阱）。
   */
  equivalentMutants: [],
};

/**
 * 配置值域契约（A01）。**新增配置键必须同时登记在这里**，
 * 否则 `validateConfig` 会把该键报成"未知配置键"（宁可当场红，也不静默失效）。
 *
 * 每个键只声明一个 `kind`，具体校验器在 lib/config.mjs。
 * 之所以不在契约里写函数：契约要能被 tools/check-contract.mjs **比对文档**，
 * 函数无法出现在 ICD 表格里。
 *
 * kind 取值：
 *   posInt           正整数（阈值、窗口、条数）
 *   nonNegInt        非负整数（行数预算、最小字符数）
 *   ratio            0..1 有限数
 *   stringArray      字符串数组
 *   pathPrefixArray  仓库相对前缀数组（拒绝对路径与越界点段）
 *   stringMap        { 名称: 非空字符串 }
 *   prefixMap        { 名称: [仓库相对前缀…] }
 *   forbidImports    [{from,to}] 或 [[from,to]]
 *   exemptArray      等价变异声明 [{id,reason}]，两者都非空
 */
export const CONFIG_SCHEMA = {
  maxNesting: { kind: 'posInt', desc: 'KISS-C1：允许的最大控制流嵌套深度' },
  dupWindow: { kind: 'posInt', desc: 'DRY-C1：跨文件重复块的行窗口' },
  dupMinChars: { kind: 'nonNegInt', desc: 'DRY-C1：重复块的最小字符数（0 = 不限）' },
  yagniMinNonGoals: { kind: 'posInt', desc: 'YAGNI-P1：非目标条目下限' },
  dryMinReuse: { kind: 'posInt', desc: 'DRY-D1：复用清单路径下限' },
  dependencies: { kind: 'stringMap', desc: '新增第三方依赖 { 包名: 版本或理由 }' },
  allowedPrefixes: { kind: 'pathPrefixArray', desc: 'DISCIPLINE-C1：允许变更的仓库相对前缀（空 = 不限）' },
  maxDiffLines: { kind: 'nonNegInt', desc: 'DISCIPLINE-C1：变更行数预算' },
  codeScopes: { kind: 'pathPrefixArray', desc: 'DISCIPLINE-C3：反向检查的代码范围（空 = 全查）' },
  boundaries: { kind: 'prefixMap', desc: 'DECOUPLE-2：边界名 → 仓库相对前缀数组' },
  forbidImports: { kind: 'forbidImports', desc: 'DECOUPLE-2：禁止的跨边界引用' },
  contractPrefixes: { kind: 'pathPrefixArray', desc: 'DECOUPLE-1：契约文件必须落在这些前缀内（空 = 不限）' },
  minMutationRatio: { kind: 'ratio', desc: 'ACCEPT-E2：变异杀死率下限' },
  equivalentMutants: { kind: 'exemptArray', desc: 'ACCEPT-E2：等价变异豁免 [{id,reason}]（reason 必填）' },
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

/**
 * 开关的「可察觉性」分级（评审包 §5 Q4.6）。
 *
 * 问题："任何默认安全、但可以显式关掉的开关，都算不算合格？"
 * 原直觉：分界线在于"关掉之后还能不能察觉自己关掉了"。
 * 本表把那句直觉落成**可校验的三档**——每档都规定了「关闭后必须留下什么痕迹」。
 *
 *   AUDITABLE  —— 关闭后可察觉，允许存在。
 *                 要求：退出码或报告里必须出现显式标记，且该标记**影响机器判定**
 *                 （不是只印一行文案让人类看，那属于"看见但无权改变仍是静默"）。
 *   DEGRADING  —— 关闭后只降级不消失：判据仍跑，只是结论变弱，且弱化本身被记录。
 *   FORBIDDEN  —— 即使显式要求也不得关闭。判据自身的**完整性**属此类：
 *                 关掉它会让"没检查"被读成"没问题"，而使用者无从察觉。
 *
 * ★ 判据（这条比结论重要）：一个开关属于哪档，不由"它感觉危不危险"决定，
 *   而由**关掉之后信号是否仍然可分辨**决定。可分辨 ⇒ 至多 AUDITABLE；
 *   不可分辨 ⇒ FORBIDDEN。
 */
export const SWITCH_CLASS = {
  AUDITABLE: 'auditable',
  DEGRADING: 'degrading',
  FORBIDDEN: 'forbidden',
};

/**
 * 已登记的可关闭开关。**新加开关必须在此登记**，否则 check-contract 报漂移。
 *
 * 登记项字段：
 *   key       —— 开关名（与 OPTIONS 的 key 或 config 键一致）
 *   kind      —— SWITCH_CLASS 之一
 *   evidence  —— 关闭后留下的可观测痕迹（AUDITABLE/DEGRADING 必填）
 *   why       —— 为什么允许（或禁止）
 */
export const SWITCHES = [
  {
    key: 'min-coverage',
    kind: SWITCH_CLASS.AUDITABLE,
    evidence: '退出码 3（INCOMPLETE）+ stderr 报覆盖率数字；设 0 时 0>=0 放行，但"显式设 0"与"没设"在参数层面可区分',
    why: '覆盖不足可能是使用者没写文档，也可能是抽不出来。它属"没跑完"，不该无条件阻断，但必须可察觉。',
  },
  {
    key: 'skip-acceptance',
    kind: SWITCH_CLASS.AUDITABLE,
    evidence: '报告须打印 SKIP 并声明"本次不构成交付验收"；退出码必须为 3 而非 0',
    why: '本地迭代时跳过验收是合理的，但绝不能让"跳过了验收"读成"验收通过了"。',
  },
  {
    key: 'strict',
    kind: SWITCH_CLASS.DEGRADING,
    evidence: '开启后 manual 计入 fail；关闭时 manual 仍单独计数并打印"必须人工签字"',
    why: '它只**加强**判定，不削弱；关闭只是回到默认强度，不产生假绿。',
  },
  {
    key: 'self-consistency',
    kind: SWITCH_CLASS.FORBIDDEN,
    evidence: '不提供关闭入口',
    why: '自洽性校验（如 killed+survived≠total）一旦可关闭，使用者会用它消掉麻烦的红，而"没检查"与"检查了没问题"症状同形 —— 这正是假绿的定义。',
  },
  {
    key: 'strict-args',
    kind: SWITCH_CLASS.DEGRADING,
    evidence: '开启后未知选项/缺值/类型不符 ⇒ 退出码 2；关闭时只校验必需项，宽松解析仍在 JSON 结果里留 trace',
    why: 'AI 常在命令行里多写一个选项；默认拒绝会让既有调用方当场红。默认宽松、显式严格，是可察觉的降级而非静默。',
  },
];

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
    `退出码: ${EXIT_CODES.OK} = 机器规则全过; ${EXIT_CODES.FAIL} = 存在 fail（或 --strict 下存在 manual）; ${EXIT_CODES.CONFIG} = 输入/配置错误; ${EXIT_CODES.INCOMPLETE} = 判据不可信或没跑完`,
    '',
    `结论四态: ${STATUSES.join(' | ')}`,
    '注意: SKIP 与 MANUAL 都不构成通过。报告末尾会打印覆盖率；--json 结果含 signal/exitCode。',
    `契约真源: lib/contract.mjs 与 docs/ICD.md（由 tools/check-contract.mjs 校验一致性）`,
    '',
  ].join('\n');
}