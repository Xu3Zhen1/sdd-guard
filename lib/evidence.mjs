// 证据生产层的解析器（纯函数，可单测）。
//
// 定位：make-evidence 只负责"跑项目自己的命令 + 把输出解析成结构化证据"，
// **不负责判断合格与否**——判定是 sdd-guard acceptance 档的事。
// 两条硬纪律：
//   ① 解析失败 ⇒ 抛错，绝不返回 {"passed":0} 之类的默认值（那会把"没跑"伪装成"跑了但零"）；
//   ② 证据带 provenance（命令、退出码、cwd、输出 sha），否则无法审计这份成绩单是谁出的。

import { createHash } from 'node:crypto';

/** 解析 node --test / node test.mjs 的输出（TAP 汇总行 `ℹ tests 45` / `ℹ pass 45` / `ℹ fail 0`）。 */
export function parseNodeTest(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const tests = num(/ℹ\s*tests\s+(\d+)/);
  const pass = num(/ℹ\s*pass\s+(\d+)/);
  const fail = num(/ℹ\s*fail\s+(\d+)/);
  const skipped = num(/ℹ\s*skipped\s+(\d+)/) ?? 0;
  const todo = num(/ℹ\s*todo\s+(\d+)/) ?? 0;
  if (tests === null || pass === null || fail === null) {
    throw new Error('无法解析测试输出：找不到 `ℹ tests/pass/fail` 汇总行（是不是换成了非 TAP reporter？）');
  }
  if (pass + fail > tests) {
    throw new Error(`测试输出自相矛盾：pass(${pass}) + fail(${fail}) > tests(${tests})`);
  }
  return { passed: pass, failed: fail, skipped, todo, total: tests };
}

/** 解析变异报告：逐个数 `✓` / `✗` 标记行（格式见 test/mutation.mjs）。 */
export function parseMutationReport(text) {
  const lines = text
    .split('\n')
    .filter((l) => /^\s*M\w+\s/.test(l) && /[✓✗]/.test(l));
  if (!lines.length) {
    throw new Error('无法解析变异报告：找不到任何 `M<n> … ✓/✗` 行');
  }
  const killed = lines.filter((l) => l.includes('✓')).length;
  const total = lines.length;
  const survived = lines
    .filter((l) => l.includes('✗'))
    .map((l) => l.replace(/^\s*/, '').split('✗')[0].replace(/[：:]\s*$/, '').trim());
  const conclusion = /全部变异均被捕获/.test(text);
  return { killed, total, survived, concludedAllKilled: conclusion };
}

/** 解析契约漂移报告：`检查项 37 · 通过 37 · 漂移 0`。 */
export function parseDriftReport(text) {
  const m = text.match(/检查项\s*(\d+)\s*·\s*通过\s*(\d+)\s*·\s*漂移\s*(\d+)/);
  if (!m) throw new Error('无法解析漂移报告：找不到 `检查项 N · 通过 N · 漂移 N` 汇总行');
  const checks = Number(m[1]);
  const passed = Number(m[2]);
  const findings = Number(m[3]);
  if (passed + findings !== checks) {
    throw new Error(`漂移报告自相矛盾：通过(${passed}) + 漂移(${findings}) ≠ 检查项(${checks})`);
  }
  const items = text
    .split('\n')
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
 * @param {object} meta   { generatedAt, cwd, producers: { key: {command, exitCode, sha256, bytes} } }
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

/** 输出文本的指纹，用于证明"这份证据对应哪次输出"。 */
export function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 校验 evidence 对象是否含 acceptance 档要求的全部键。 */
export function missingEvidenceKeys(evidence, keys) {
  if (!evidence || typeof evidence !== 'object') return [...keys];
  return keys.filter((k) => evidence[k] === undefined || evidence[k] === null);
}