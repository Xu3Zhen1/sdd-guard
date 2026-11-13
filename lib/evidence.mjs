// 证据生产层的解析器（纯函数，可单测）。
//
// 定位：make-evidence 只负责"跑项目自己的命令 + 把输出解析成结构化证据"，
// **不负责判断合格与否**——判定是 sdd-guard acceptance 档的事。
// 三条硬纪律：
//   ① 解析失败 ⇒ 抛错，绝不返回 {"passed":0} 之类的默认值（那会把"没跑"伪装成"跑了但零"）；
//   ② 证据带 provenance（命令、退出码、cwd、输出完整 sha256），否则无法审计这份成绩单是谁出的；
//   ③ **歧义即错误**：同一份输出里出现两组互相矛盾的汇总 ⇒ 抛错，绝不"各取第一个匹配"。
//      纪律 ③ 是 2026-11-13 审计 A09 的核心：旧实现分字段各取首个匹配，
//      于是「先 999 全绿、后 2 跑 1 红」被拼成不存在的 999 全绿 ⇒ ACCEPT-E1 假绿。

import { createHash } from 'node:crypto';
import { isNonNegInt } from './values.mjs';

/**
 * 把文本切成"行"，并丢掉 ANSI 颜色码。
 *
 * 为什么必须剥 ANSI：CI 里 Node 用彩色 reporter 时，`ℹ tests 45` 实际是
 * `\x1b[32mℹ\x1b[39m tests 45`，未剥色时行首锚点全失效 ⇒ 在 CI 上永远解析不出汇总行。
 * 这是一个"本地绿、CI 红"的典型来源。
 */
function toLines(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/);
}

/**
 * 从一组"同义正则"里找出所有匹配，返回每个匹配的捕获组。
 * 与旧实现的区别：返回**全部**匹配（数组），由调用方负责判断唯一性。
 */
function findAll(lines, patterns) {
  const hits = [];
  for (const p of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(p);
      if (m) hits.push({ line: i + 1, value: m[1], text: lines[i] });
    }
  }
  return hits;
}

/**
 * 要求"同一字段的全部匹配完全一致"，否则抛错。
 *
 * @param hits findAll 的结果
 * @param field 字段名（写进错误信息）
 * @returns {string|null} 唯一值；没有任何匹配时返回 null
 */
function uniqueValue(hits, field) {
  if (!hits.length) return null;
  const values = [...new Set(hits.map((h) => h.value))];
  if (values.length > 1) {
    const where = hits.map((h) => `第${h.line}行「${h.text.trim()}」`).join('；');
    throw new Error(
      `测试输出自相矛盾：${field} 出现 ${hits.length} 处且取值不一致（${values.join(' / ')}），无法判定哪一份是真的。位置：${where}`,
    );
  }
  return values[0];
}

/**
 * 解析 node --test / node test.mjs 的输出。
 *
 * **汇总块唯一性**（A09 修）：不再"每个字段各取首个匹配"，而是
 *   ① 收集 tests / pass / fail 的**全部**出现位置；
 *   ② 每个字段内部取值必须一致；
 *   ③ tests 出现的位置行区间必须能覆盖 pass 与 fail 的出现位置（同一份汇总块）；
 * 任一不满足 ⇒ 抛错。绝不用"先出现的那一组"冒充结论。
 */
export function parseNodeTest(text) {
  const lines = toLines(text);
  // 汇总行前缀随 Node 版本变：Node 22+ 的 spec reporter 用 `ℹ`，Node 20 用 `#`（TAP 风格）。
  // 只认一种会在 CI 的矩阵里直接红——本地 Node 24 永远看不出这个问题。
  const P = '(?:ℹ|#)?\\s*';
  const FIELD_RE = {
    tests: new RegExp('^\\s*' + P + 'tests\\s+(\\d+)\\s*$'),
    pass: new RegExp('^\\s*' + P + 'pass\\s+(\\d+)\\s*$'),
    fail: new RegExp('^\\s*' + P + 'fail\\s+(\\d+)\\s*$'),
    skipped: new RegExp('^\\s*' + P + 'skipped\\s+(\\d+)\\s*$'),
    todo: new RegExp('^\\s*' + P + 'todo\\s+(\\d+)\\s*$'),
  };
  const testsHits = findAll(lines, [FIELD_RE.tests]);
  const passHits = findAll(lines, [FIELD_RE.pass]);
  const failHits = findAll(lines, [FIELD_RE.fail]);
  const skippedHits = findAll(lines, [FIELD_RE.skipped]);
  const todoHits = findAll(lines, [FIELD_RE.todo]);

  if (!testsHits.length || !passHits.length || !failHits.length) {
    throw new Error('无法解析测试输出：找不到 `ℹ tests/pass/fail` 汇总行（是不是换成了非 TAP reporter？）');
  }

  const testsRaw = uniqueValue(testsHits, 'tests');
  const passRaw = uniqueValue(passHits, 'pass');
  const failRaw = uniqueValue(failHits, 'fail');
  // skipped/todo 缺省为 0（真实 reporter 在小版本间会省略它们）；给了就必须唯一。
  const skippedRaw = uniqueValue(skippedHits, 'skipped') ?? '0';
  const todoRaw = uniqueValue(todoHits, 'todo') ?? '0';

  /**
   * 同一汇总块校验：五个字段的汇总行必须聚在**一个连续块**里。
   *
   * 反例 A（审计实测的那个）：先一段 `tests 999 / pass 999 / fail 0`，
   * 后面再一段 `tests 2 / pass 1 / fail 1`。此时 tests 有两个不同取值，
   * 已在上面的 uniqueValue 抛错。
   *
   * 反例 B（取值恰好相同、但来自两份不同报告）：例如 CI 把同一份报告打印两遍。
   * 那种情况取哪一份结论都一样、不算歧义，**但前提是它们确实是一整块**——
   * 若 tests 出现在文件头、pass/fail 出现在 200 行之外，那就是"从两份不同输出
   * 里各拿了一行"，必须报错而不是拼装。
   *
   * 判据：所有汇总行的首末行距 ≤ SUMMARY_BLOCK_MAX_LINES。
   * Node 的汇总是 6~8 行（tests/suites/pass/fail/cancelled/skipped/todo/duration），
   * 取 30 已很宽松，正常输出不会触顶；而任何"隔着半份报告"的形态都会触顶。
   */
  const SUMMARY_BLOCK_MAX_LINES = 30;
  const allHits = [...testsHits, ...passHits, ...failHits, ...skippedHits, ...todoHits];
  const blockLo = Math.min(...allHits.map((h) => h.line));
  const blockHi = Math.max(...allHits.map((h) => h.line));
  if (blockHi - blockLo > SUMMARY_BLOCK_MAX_LINES) {
    const outer = allHits
      .filter((h) => h.line === blockLo || h.line === blockHi)
      .map((h) => `第${h.line}行「${h.text.trim()}」`)
      .join('；');
    throw new Error(
      `测试输出自相矛盾：汇总行跨越 ${blockHi - blockLo} 行（>${SUMMARY_BLOCK_MAX_LINES}），` +
        `不构成同一份汇总块 —— 这是从多份输出里拼出来的。两端：${outer}`,
    );
  }

  const tests = Number(testsRaw);
  const pass = Number(passRaw);
  const fail = Number(failRaw);
  const skipped = Number(skippedRaw);
  const todo = Number(todoRaw);
  for (const [name, v] of [['tests', tests], ['pass', pass], ['fail', fail], ['skipped', skipped], ['todo', todo]]) {
    if (!isNonNegInt(v)) throw new Error(`测试输出里的 ${name} 不是非负整数: ${v}`);
  }
  if (pass + fail > tests) {
    throw new Error(`测试输出自相矛盾：pass(${pass}) + fail(${fail}) > tests(${tests})`);
  }
  return { passed: pass, failed: fail, skipped, todo, total: tests };
}

/**
 * 判定变异清单的完整性 —— 三种可接受的证据来源，优先级从高到低。
 *
 * 为什么必须单独成函数（而不是写在 parseMutationReport 里）：
 * 三种来源各要一层分支、每层里还要做对账，堆在解析函数里会轻松超过 3 层嵌套；
 * 而本项目自己的 KISS-C1 判据对自身源码同样生效（自举），不允许"我的文件例外"。
 *
 * @param {number[]} declared 报告里声明的 MUTANT_TOTAL（去重后；空数组=没声明）
 * @param {number} total 实测解析到的变异行数
 * @param {Array} matched 匹配到的行（用于取 id 与期望清单对账）
 * @param {object} opts { expectedMutants?: string[]|number }
 * @returns {{completeness:'complete'|'unknown', completenessReason:string}}
 */
function judgeCompleteness(declared, total, matched, opts) {
  // ① 报告自己声明了清单长度 —— 最强的证据，与实测行数直接对账。
  if (declared.length === 1) {
    if (declared[0] !== total) {
      throw new Error(
        `变异报告不完整：声明清单长度 ${declared[0]}，实际解析到 ${total} 行 —— ` +
          '报告被截断（或声明写错）。截断的报告不能当作"全部被杀死"的证据。',
      );
    }
    return { completeness: 'complete', completenessReason: `报告声明 MUTANT_TOTAL=${declared[0]}，与解析到的 ${total} 行一致` };
  }

  const exp = opts.expectedMutants;
  // ② 调用方给了**逐条清单** ⇒ 不只比数量，还要比 id 集合。
  if (Array.isArray(exp)) return reconcileInventory(exp, total, matched);

  // ③ 调用方只给了**条数** ⇒ 只能比数量（弱一档，但仍是可判定的）。
  if (typeof exp === 'number' && isNonNegInt(exp)) {
    if (exp !== total) throw new Error(`变异报告不完整：期望 ${exp} 条，实际解析到 ${total} 条（报告被截断）`);
    return { completeness: 'complete', completenessReason: `与声明的期望条数一致（${exp} 条）` };
  }

  // ④ 什么都没声明 —— 这是"无法区分完整与截断"的唯一诚实答案。
  return {
    completeness: 'unknown',
    completenessReason: '报告未声明清单长度（既无 MUTANT_TOTAL，也未提供 expectedMutants）—— 无法区分"完整"与"被截断"',
  };
}

/**
 * 逐条清单对账：数量、缺失、多出三项都要对上。
 * 只报数量不符会让人以为"条数对就没事"，而真正的危险是**同名替换**
 * （把难的变异删掉、换一个容易杀死的）—— 那种情况数量恰好相等。
 */
function reconcileInventory(expList, total, matched) {
  const ids = matched.map((m) => m[1]);
  const missing = expList.filter((e) => !ids.includes(e));
  const extra = ids.filter((i) => !expList.includes(i));
  if (missing.length || extra.length || expList.length !== total) {
    throw new Error(
      `变异报告与期望清单不一致：期望 ${expList.length} 条，实际 ${total} 条` +
        (missing.length ? `；缺失: ${missing.slice(0, 8).join(',')}` : '') +
        (extra.length ? `；多出: ${extra.slice(0, 8).join(',')}` : ''),
    );
  }
  return { completeness: 'complete', completenessReason: `与配置的期望清单逐条一致（${expList.length} 条）` };
}

/**
 * 解析变异报告。
 *
 * **历史缺陷（2026-11-12 实测暴露，严重程度最高）**：早期只认 `M` 开头
 * （`/^\s*M\w+\s/`），于是把存活变异命名为 `S1..S4` 时它们被**完全忽略**，
 * 解析出 `killed=2 total=2` ⇒ 杀死率 100% ⇒ ACCEPT-E2 判 PASS。
 * **这是"看起来绿、实际完全失效"的形态，比红更危险。**
 *
 * 两处修正：
 *   ① 前缀放宽为「字母开头 + 可选数字/连字符/下划线」，不再绑定 M；
 *   ② 增加自洽校验：`survived` 非空却声称 `concludedAllKilled` ⇒ 直接抛错（自相矛盾）。
 *
 * **完整性缺陷（2026-11-13 审计 A09 修，最严重的一个）**：
 * 旧实现的 `total` 就是"匹配到的行数"，于是
 *   · 只有一行 `M1 ✓` 的报告（生产者中途崩了） ⇒ killed=1/total=1 ⇒ 杀死率 100% ⇒ PASS；
 *   · 真正只有 1 个变异体的报告 ⇒ 同一个数字。
 * **"截断"与"完整"同形 ⇒ 截断报告会被当成满分证据。**
 *
 * 现在的判据：报告必须**自己声明清单长度**，并给出三种 completeness：
 *   · 声明存在且 == 实测行数 ⇒ 'complete'（可判 pass）；
 *   · 声明存在但 ≠ 实测行数 ⇒ 抛错（报告被截断，或声明写错，两者都不能当证据）；
 *   · 没有声明 ⇒ 若有 allowedInventory（配置里的期望清单）逐条比对通过 ⇒ 'complete'；
 *     否则 ⇒ 'unknown'，**由规则层判红**（ACCEPT-E2），不在这里假装完整。
 *
 * @param {string} text 报告原文
 * @param {{expectedMutants?: string[]|number}} [opts] 显式清单或显式条数
 */
export function parseMutationReport(text, opts = {}) {
  const lines = toLines(text);
  // 形如：`  M1 甲: …  ✓（…）` / `  S12 乙: … ✗` / `  mut-3 丙 … ✓`
  const lineRe = /^\s*([A-Za-z][\w-]*\d[\w-]*)\s+(.*?)([✓✗])/;
  // 只认"变异行"：必须形如 <id><sep><描述>…<✓|✗>，且 id 含数字（M1/X12/mut-3）。
  // 上一版把"收尾自检: … ✓"这类行排除掉靠的是 id 必须含数字，这条要保留。
  const matched = lines.map((l) => l.match(lineRe)).filter(Boolean);

  // ★ 声明行：`MUTANT_TOTAL=11` / `变异总数：11` / `total 11`，允许前导装饰与行尾说明。
  const declRes = [
    /^\s*MUTANT_TOTAL\s*[=:：]\s*(\d+)\s*$/i,
    /^\s*变异总数\s*[=:：]\s*(\d+)\s*$/,
    /^\s*TOTAL\s*[=:：]\s*(\d+)\s*$/i,
  ];
  const declHits = [];
  for (const l of lines) {
    for (const re of declRes) {
      const m = l.match(re);
      if (m) declHits.push({ line: l, value: Number(m[1]) });
    }
  }
  const declared = declHits.length ? [...new Set(declHits.map((d) => d.value))] : [];
  if (declared.length > 1) {
    throw new Error(`变异报告自相矛盾：出现 ${declHits.length} 处清单声明且取值不一致（${declared.join(' / ')}）`);
  }

  if (!matched.length) {
    throw new Error('无法解析变异报告：找不到任何「<id> <描述> ✓/✗」行');
  }

  const killed = matched.filter((m) => m[3] === '✓').length;
  const total = matched.length;
  const survived = matched
    .filter((m) => m[3] === '✗')
    .map((m) => `${m[1]} ${m[2]}`.replace(/[：:]\s*$/, '').trim());

  // 若报告正文自称"全部被捕获"，但实测有存活行 —— 两者不可能同时为真。
  const conclusion = /全部变异均被捕获/.test(text);
  if (conclusion && survived.length > 0) {
    throw new Error(
      `变异报告自相矛盾：正文声称"全部变异均被捕获"，但解析到 ${survived.length} 个存活（${survived.slice(0, 3).join('; ')}）`,
    );
  }

  // ── 完整性判定 ────────────────────────────────────────────
  // 抽成独立函数：一是把"报告声明 / 配置清单 / 无从判断"三种来源并列处理，
  // 二是让每层分支都不超过 3 层嵌套（本项目 KISS-C1 判据对自身同样生效）。
  const { completeness, completenessReason } = judgeCompleteness(declared, total, matched, opts);

  return {
    killed,
    total,
    survived,
    concludedAllKilled: conclusion,
    declaredTotal: declared.length === 1 ? declared[0] : null,
    completeness,
    completenessReason,
  };
}

/**
 * 解析契约漂移报告：`检查项 37 · 通过 37 · 漂移 0`。
 *
 * A09 同族修（歧义）：旧实现取**首个**匹配。同一份输出里若出现两行
 * 互相矛盾的汇总（例如汇总后又重打一次、或用例里贴了反例文本），
 * 取第一个就会挑到"看起来好的那一份"。现在：全部匹配必须一致，否则抛错。
 * 计数域同时收紧为非负安全整数（不再 `Number()` 隐式转换）。
 */
export function parseDriftReport(text) {
  const lines = toLines(text);
  const hits = findAll(lines, [/检查项\s*(\d+)\s*·\s*通过\s*(\d+)\s*·\s*漂移\s*(\d+)/]);
  if (!hits.length) throw new Error('无法解析漂移报告：找不到 `检查项 N · 通过 N · 漂移 N` 汇总行');

  // 逐组解析并去重：同一组 (checks, passed, findings) 出现多次是可以的（CI 重打），
  // 但只要出现**不同**的组，就是歧义 —— 不能挑一个。
  const groups = [];
  for (const h of hits) {
    const m = h.text.match(/检查项\s*(\d+)\s*·\s*通过\s*(\d+)\s*·\s*漂移\s*(\d+)/);
    if (!m) continue;
    groups.push({ line: h.line, checks: m[1], passed: m[2], findings: m[3] });
  }
  const keys = [...new Set(groups.map((g) => `${g.checks}|${g.passed}|${g.findings}`))];
  if (keys.length > 1) {
    throw new Error(
      `漂移报告自相矛盾：出现 ${groups.length} 处汇总行且取值不一致（${keys.join(' / ')}），无法判定哪一份是真的`,
    );
  }

  const g = groups[0];
  // 不隐式转换：`Number('')`=0、`Number(true)`=1 都是"类型错了"被读成合法值。
  const checks = Number(g.checks);
  const passed = Number(g.passed);
  const findings = Number(g.findings);
  for (const [name, v] of [['checks', checks], ['passed', passed], ['findings', findings]]) {
    if (!isNonNegInt(v)) throw new Error(`漂移报告里的 ${name} 不是非负整数: ${v}`);
  }
  if (passed + findings !== checks) {
    throw new Error(`漂移报告自相矛盾：通过(${passed}) + 漂移(${findings}) ≠ 检查项(${checks})`);
  }
  const items = toLines(text)
    .filter((l) => /^\s*FAIL\s+/.test(l))
    .map((l) => l.replace(/^\s*FAIL\s+/, '').trim());
  return { checks, passed, findings, items };
}

export const PARSERS = {
  'node-test': parseNodeTest,
  mutation: parseMutationReport,
  drift: parseDriftReport,
};

/** 证据文件名 → 解析器名（配置里可不写 parser，按名字推断）。 */
export const PARSER_BY_KEY = {
  tests: 'node-test',
  mutation: 'mutation',
  drift: 'drift',
};

/**
 * 合成最终 evidence 对象。
 * @param {object} parts  { tests?, mutation?, drift? } 各自已解析
 * @param {object} meta   { generatedAt, cwd, producers: { key: {command, exitCode, cwd, sha256, bytes} } }
 */
export function buildEvidence(parts, meta) {
  const out = {};
  for (const [key, value] of Object.entries(parts)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  if (!Object.keys(out).length) throw new Error('没有任何证据被产出（三个生产者全失败？）');
  out.meta = meta;
  return out;
}

/**
 * 输出文本的指纹：**完整 64 位十六进制 SHA-256**。
 *
 * A11 修：旧实现 `...slice(0, 16)` 只返回 16 位前缀，却写进名为 `sha256`
 * 的字段。16 位前缀不是 SHA-256，把它当"完整摘要"会让"证据绑定到哪次输出"
 * 只剩 2^-64 量级的可信度外观、却没有真实强度。字段名承诺什么就给什么：
 *   · `digest()`      ⇒ 64 位完整值（字段名 `sha256` 名实相符）
 *   · `digest()` 保留确定性：同一输入必须同值（可复跑比对）
 *   · 需要人读/日志里短一点的 ⇒ 用 `digestShort()`，且字段名必须写 `digest16`
 */
export function digest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 短摘要（16 位前缀），**仅供人读/日志**；不要写进声明为 sha256 的字段。 */
export function digestShort(text) {
  return digest(text).slice(0, 16);
}

/** 校验 evidence 对象是否含 acceptance 档要求的全部键。 */
export function missingEvidenceKeys(evidence, keys) {
  if (!evidence || typeof evidence !== 'object') return [...keys];
  return keys.filter((k) => evidence[k] === undefined || evidence[k] === null);
}
