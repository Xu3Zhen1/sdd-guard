#!/usr/bin/env node
/**
 * 规格验收探针（2026-11-13 修复后）。
 *
 * 与 `audit-lead.mjs` / `audit-rules-probe.mjs` / `audit-evidence-probe.mjs` 的关系：
 *   那三份是**审计探针**，锁的是「缺陷现状」——它们断言"这个假绿确实存在"。
 *   本文件锁的是「**规格期望**」——断言"这条假绿已经不存在、且真实红样本仍然红"。
 *
 * 判据纪律（沿用项目既有教训）：
 *   ① 期望值全部**写死为字面量**，绝不引用被测对象的常量；
 *   ② 每条修复都必须配**正控**（合法输入仍 PASS）与**负控**（违规输入必须 FAIL），
 *      只测一边等于没测；
 *   ③ 探针 exit 0 表示"规格成立"，不是"产品无缺陷"；
 *   ④ 未覆盖的分支在末尾显式列出，不用"全绿"掩盖。
 *
 * 运行：node _work/spec-probe.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writableTempRoot } from '../../lib/temp.mjs';
import { spawnSync } from 'node:child_process';

import { RULES, buildContext } from '../../lib/rules.mjs';
import { nestingDepth, importSpecifiers, scanCodeRoots, boundaryOfPath } from '../../lib/code.mjs';
import { parseOutline, findTopSection, tableRows, bulletItems } from '../../lib/md.mjs';
import { validateConfig } from '../../lib/config.mjs';
import { CONFIG_SCHEMA } from '../../lib/contract.mjs';
import { normalizeRel, withinPrefix, resolveRepoRef } from '../../lib/paths.mjs';
import { isNonNegInt, isRatio, readCount } from '../../lib/values.mjs';

const ROOT = resolve('.');
const out = [];
const pass = (id, msg, evidence) => {
  out.push({ id, ok: true, msg, evidence });
  console.log(`  PASS  ${id.padEnd(6)} ${msg}${evidence ? `  [${evidence}]` : ''}`);
};
const fail = (id, msg) => {
  out.push({ id, ok: false, msg });
  console.log(`  FAIL  ${id.padEnd(6)} ${msg}`);
};

/** 统一跑一条断言：捕获异常转成 FAIL 而不是让整个探针崩。 */
function check(id, fn) {
  try {
    const r = fn();
    pass(id, r.msg || '规格成立', r.evidence);
  } catch (e) {
    fail(id, e.message.split('\n')[0].slice(0, 200));
  }
}

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(writableTempRoot(), 'sdd-spec-'));
const mk = (...p) => {
  const dest = join(TMP, ...p);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  return dest;
};
/** 建一个**目录**并返回它（`mk` 返回的是路径本身、只建父目录）。 */
const mkdirp = (...p) => {
  const dest = join(TMP, ...p);
  mkdirSync(dest, { recursive: true });
  return dest;
};
const rule = (id) => RULES.find((r) => r.id === id);
const run = (id, ctx) => rule(id).run(ctx);
const ctxOf = ({ art = { files: {}, specs: [] }, cfg = {}, diff = null, evidence = null, codeFiles = [], repo = TMP } = {}) =>
  ({ ...buildContext({ art, cfg, diff, evidence, changeDir: repo, repo, cwd: repo }), codeFiles });

// ─────────────────────────────────────────────────────────────
// A01 · 配置值域：非法配置必须在执行前 exit 2，且真实违规仍红
// ─────────────────────────────────────────────────────────────
console.log('\n[A01] 配置值域校验');
check('A01-1', () => {
  const r = validateConfig({ maxNesting: 'garbage' }, CONFIG_SCHEMA);
  assert.equal(r.ok, false, '字符串阈值必须被拒');
  return { msg: `字符串阈值被拒：${r.errors[0].slice(0, 60)}` };
});
check('A01-2', () => {
  const bad = [
    { maxNesting: 0 },
    { maxNesting: -1 },
    { maxNesting: 2.5 },
    { dupWindow: 'six' },
    { minMutationRatio: 1.5 },
    { minMutationRatio: -0.1 },
    { allowedPrefixes: ['../escape'] },
    { allowedPrefixes: ['C:/abs'] },
    { boundaries: { web: 'web/' } },
    { equivalentMutants: [{ id: 'S1' }] },
    { maxNestingg: 3 },
  ];
  for (const c of bad) assert.equal(validateConfig(c, CONFIG_SCHEMA).ok, false, `应拒绝 ${JSON.stringify(c)}`);
  return { msg: `${bad.length} 类非法配置全部被拒`, evidence: '含未知键/负数/小数/零窗口/越界前缀/缺 reason' };
});
check('A01-3', () => {
  const ok = validateConfig(
    { maxNesting: 3, dupWindow: 6, dupMinChars: 0, maxDiffLines: 0, minMutationRatio: 0.8, allowedPrefixes: ['src/'] },
    CONFIG_SCHEMA,
  );
  assert.equal(ok.ok, true, `合法配置不得被误拒: ${ok.errors}`);
  return { msg: '合法配置通过（含 0 预算与 0 层阈值这两个边界的正当值）' };
});
check('A01-4', () => {
  // ★ 关键：非法阈值曾让真实违规 PASS。现在配置在执行前就 exit 2，规则层拿到的一定是合法数值。
  //   正控：正常阈值下四层嵌套必须仍 FAIL。
  const f = mk('src', 'deep.js');
  writeFileSync(f, ['if (a) {', '  if (b) {', '    if (c) {', '      if (d) {', '        w();', '      }', '    }', '  }', '}'].join('\n'));
  const r = run('KISS-C1', ctxOf({ cfg: { maxNesting: 3 }, codeFiles: [f] }));
  assert.equal(r.status, 'fail', '四层嵌套在阈值 3 下必须 FAIL');
  return { msg: '正控：合法阈值下真实违规仍判红（不是靠非法配置制造的红）' };
});

// ─────────────────────────────────────────────────────────────
// A02 · 数值证据：不可能的计数必须拒收
// ─────────────────────────────────────────────────────────────
console.log('\n[A02] 数值域：计数必须是非负安全整数');
check('A02-1', () => {
  const cases = [
    [{ passed: -1, failed: -1 }, 'E1 负数'],
    [{ passed: true, failed: null }, 'E1 布尔/null'],
    [{ passed: '1', failed: 0 }, 'E1 字符串'],
    [{ passed: [], failed: 0 }, 'E1 数组'],
  ];
  for (const [tests, label] of cases) {
    const r = run('ACCEPT-E1', ctxOf({ evidence: { tests } }));
    assert.equal(r.status, 'fail', `${label} 必须 FAIL，实际 ${r.status}`);
  }
  return { msg: '4 类不可能计数全部 FAIL', evidence: '负数/布尔/null/字符串/数组' };
});
check('A02-2', () => {
  const r = run('ACCEPT-E1', ctxOf({ evidence: { tests: { passed: 3, failed: 0 } } }));
  assert.equal(r.status, 'pass', `合法证据必须 PASS: ${r.reason}`);
  return { msg: '正控：合法测试证据仍 PASS' };
});
check('A02-3', () => {
  for (const drift of [{ checks: -1, findings: -1 }, { checks: 1, findings: 5 }, { checks: 'x', findings: 0 }]) {
    const r = run('ACCEPT-E3', ctxOf({ evidence: { drift } }));
    assert.equal(r.status, 'fail', `${JSON.stringify(drift)} 必须 FAIL`);
  }
  const ok = run('ACCEPT-E3', ctxOf({ evidence: { drift: { checks: 1, findings: 0 } } }));
  assert.equal(ok.status, 'pass');
  return { msg: '漂移证据：负数/漂移>检查项/字符串 全部 FAIL，合法仍 PASS' };
});
check('A02-4', () => {
  const diff = { files: [{ path: 'src/a.js', added: 1000, deleted: -1000 }] };
  const r = run('DISCIPLINE-C1', ctxOf({ cfg: { allowedPrefixes: ['src/'], maxDiffLines: 400 }, diff }));
  assert.equal(r.status, 'fail', `正负相消必须 FAIL，实际 ${r.status}`);
  return { msg: 'diff 正负相消 1000/-1000 被判 FAIL（旧实现报"0 行均在范围内"）' };
});
check('A02-5', () => {
  assert.equal(isNonNegInt(-1), false);
  assert.equal(isNonNegInt(1.5), false);
  assert.equal(isNonNegInt(true), false);
  assert.equal(isNonNegInt(0), true);
  assert.equal(isRatio(1.5), false);
  assert.equal(readCount({ a: -1 }, 'a', 'x').ok, false);
  return { msg: '值域原语：负数/小数/布尔/超界比例全被拒' };
});

// ─────────────────────────────────────────────────────────────
// A03 · 仓库路径基准：显式 repo 是唯一基准
// ─────────────────────────────────────────────────────────────
console.log('\n[A03] 仓库路径基准');
check('A03-1', () => {
  const repo = mk('r1');
  const cwd = mk('c1');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'outside.js'), 'export const x = 1;\n');
  const art = { files: { 'design.md': { text: '# D\n## 复用\n`src/outside.js`\n' } }, specs: [] };
  const ctx = { ...buildContext({ art, cfg: {}, changeDir: repo, repo, cwd }) };
  const r = run('DRY-D1', ctx);
  assert.equal(r.status, 'fail', `repo 下不存在的路径必须 FAIL（不得回落到 cwd），实际 ${r.status}`);
  return { msg: '只在 cwd 存在的路径不再冒充 repo 内路径' };
});
check('A03-2', () => {
  assert.equal(withinPrefix('src/../outside.js', 'src/'), false, '点段归一后越界必须判越界');
  assert.equal(withinPrefix('srcx/x.js', 'src/'), false, '前缀碰撞必须按段边界');
  assert.equal(withinPrefix('src/x.js', 'src/'), true);
  assert.equal(normalizeRel('src/../..'), null, '越出根返回 null');
  return { msg: '点段/前缀碰撞/段边界三态正确' };
});
check('A03-3', () => {
  const r = run(
    'DISCIPLINE-C1',
    ctxOf({ cfg: { allowedPrefixes: ['src/'] }, diff: { files: [{ path: 'src/../outside.js', added: 1, deleted: 0 }] } }),
  );
  assert.equal(r.status, 'fail', `点段逃逸必须 FAIL，实际 ${r.status}`);
  const ok = run(
    'DISCIPLINE-C1',
    ctxOf({ cfg: { allowedPrefixes: ['src/'] }, diff: { files: [{ path: 'src/real.js', added: 1, deleted: 0 }] } }),
  );
  assert.equal(ok.status, 'pass', '合法路径仍须 PASS');
  return { msg: 'allowedPrefixes：`src/../outside.js` FAIL、`src/real.js` PASS' };
});
check('A03-4', () => {
  assert.equal(resolveRepoRef('C:/abs/x.js').ok, false, '绝对路径不是仓库内引用');
  assert.equal(boundaryOfPath('srcx/x.js', { web: ['src/'] }), null, '前缀碰撞不得命中边界');
  return { msg: '绝对路径被拒、边界前缀按段匹配' };
});

// ─────────────────────────────────────────────────────────────
// A04 · KISS-C1 嵌套：左右配对 + 单行不漏
// ─────────────────────────────────────────────────────────────
console.log('\n[A04] 嵌套计数：对象不扣层、单行不漏计');
const quad = ['if (a) {', '  if (b) {', '    if (c) {', '      if (d) {', '        w();', '      }', '    }', '  }', '}'].join('\n');
const objThenDeep = ['if (a) {', '  if (b) {', '    if (c) {', '      const o = {', '        v: 1', '      };', '      if (d) {', '        w();', '      }', '    }', '  }', '}'].join('\n');
const compact = 'if (a) { if (b) { if (c) { if (d) { w(); } } } }';
const maxD = (t) => Math.max(0, ...nestingDepth('p.js', t).map((h) => h.depth));
check('A04-1', () => {
  assert.equal(maxD(quad), 4, '普通四层必须是 4');
  return { msg: '普通四层多行 = 4', evidence: `max=${maxD(quad)}` };
});
check('A04-2', () => {
  assert.equal(maxD(objThenDeep), 4, `对象右括号不得扣层，实际 ${maxD(objThenDeep)}`);
  return { msg: '三层 if + 对象字面量 + 第四层 = 4（旧实现报 3）', evidence: `max=${maxD(objThenDeep)}` };
});
check('A04-3', () => {
  assert.equal(maxD(compact), 4, `单行四层不得漏计，实际 ${maxD(compact)}`);
  return { msg: '单行四层 = 4（旧实现完全无命中）', evidence: `max=${maxD(compact)}` };
});
check('A04-4', () => {
  const pureObj = 'const c = { a: { b: { c: { d: 1 } } } };\n';
  assert.equal(maxD(pureObj), 0, `纯对象必须计 0，实际 ${maxD(pureObj)}`);
  return { msg: '纯对象字面量仍计 0（没把数据结构当逻辑复杂度）' };
});
check('A04-5', () => {
  // 词法状态：模板串 / 正则 / 块注释里的花括号不算代码括号
  const tricky = [
    'const s = `before ${ { a: 1 } } after`;',
    'const re = /\\{(?:x)\\}/;',
    '/* if (a) { if (b) { if (c) { if (d) {',
    '*/',
    'const n = 1;',
  ].join('\n');
  assert.equal(maxD(tricky), 0, `模板串/正则/块注释里的括号不得计层，实际 ${maxD(tricky)}`);
  return { msg: '模板串/正则字面量/块注释内的花括号不计层' };
});
check('A04-6', () => {
  // 本项目自己的所有源码必须 ≤ 3 层（自举）
  const scan = scanCodeRoots([join(ROOT, 'lib'), join(ROOT, 'tools'), join(ROOT, 'cli.mjs')]);
  const bad = [];
  for (const f of scan.files) for (const h of nestingDepth(f, readFileSync(f, 'utf8'))) if (h.depth > 3) bad.push(`${f}:${h.line}=${h.depth}`);
  assert.equal(bad.length, 0, `本项目自身超限: ${bad.slice(0, 5).join(', ')}`);
  return { msg: `自举：${scan.files.length} 个源码文件无一超过 3 层`, evidence: `扫描 ${scan.files.length} 文件` };
});

// ─────────────────────────────────────────────────────────────
// A05 · 文档解析：围栏隔离 + 格式间判据一致
// ─────────────────────────────────────────────────────────────
console.log('\n[A05] 文档解析与判据一致');
const prop = (text) => run('YAGNI-P1', ctxOf({ art: { files: { 'proposal.md': { text } }, specs: [] }, cfg: {} }));
check('A05-1', () => {
  const bare = '# P\n## 非目标\n- 导出\n- 缓存\n- 多端';
  const r = prop(bare);
  assert.equal(r.status, 'fail', `无理由列表必须 FAIL（与空理由表格一致），实际 ${r.status}`);
  return { msg: '无理由列表 FAIL（旧实现只看条数 ⇒ PASS）' };
});
check('A05-2', () => {
  const reasoned = '# P\n## 非目标\n- 导出 —— 无需\n- 缓存 —— 延后\n- 多端 —— 不需要';
  const r = prop(reasoned);
  assert.equal(r.status, 'pass', `带理由列表必须 PASS: ${r.reason}`);
  return { msg: '正控：带理由列表 PASS（不是一律判红）' };
});
check('A05-3', () => {
  const fenced = '# P\n\n```markdown\n## 非目标\n|事项|理由|\n|---|---|\n|A|r|\n|B|r|\n|C|r|\n```\n';
  const node = findTopSection(parseOutline(fenced), /非目标/);
  assert.equal(node, null, '围栏里的标题不得成为正式小节');
  const r = prop(fenced);
  assert.equal(r.status, 'fail', `围栏示例不得充当真实章节，实际 ${r.status}`);
  return { msg: '围栏代码块里的「非目标」不再被当成正式小节' };
});
check('A05-4', () => {
  const fencedRows = '## 非目标\n\n```md\n|a|b|\n|---|---|\n|c|d|\n```\n';
  assert.equal(tableRows(fencedRows).length, 0, '围栏里的表格行不得参与解析');
  assert.equal(bulletItems('```\n- x — y\n```').length, 0, '围栏里的列表不得参与解析');
  return { msg: 'tableRows / bulletItems 同样隔离围栏内容' };
});
const spec = (body) => ({ files: {}, specs: [{ name: 's.md', text: body }] });
check('A05-5', () => {
  const gwt = '### Requirement: X\n#### Scenario: one\n- GIVEN r\n- WHEN run\n- THEN a\nTHEN b';
  const r = run('KISS-S2', ctxOf({ art: spec(gwt) }));
  assert.equal(r.status, 'fail', `两行普通 THEN 必须 FAIL（与列表写法一致），实际 ${r.status}`);
  const one = run('KISS-S2', ctxOf({ art: spec('### Requirement: X\n#### Scenario: one\n- GIVEN r\n- WHEN run\n- THEN a') }));
  assert.equal(one.status, 'pass', '单 THEN 仍须 PASS');
  return { msg: '普通文本双 THEN FAIL、单 THEN PASS（列表/普通写法口径统一）' };
});

// ─────────────────────────────────────────────────────────────
// A13 · import 提取：注释不算依赖
// ─────────────────────────────────────────────────────────────
console.log('\n[A13] import 提取排除注释');
check('A13-1', () => {
  assert.deepEqual(importSpecifiers('p.js', '/*\nimport x from "../backend/private.js";\n*/\nexport const v = 1;'), [], '块注释里的 import 不算依赖');
  assert.deepEqual(importSpecifiers('p.js', '// import x from "../backend/private.js"\nexport const v = 1;'), [], '行注释里的 import 不算依赖');
  return { msg: '块注释/行注释里的 import 均被排除（旧实现报假红）' };
});
check('A13-2', () => {
  assert.deepEqual(importSpecifiers('p.js', 'import x from "../backend/private.js";'), ['../backend/private.js'], '真实 import 必须仍被抽出');
  return { msg: '正控：真实 import 仍被抽出（不是一律返回空）' };
});
check('A13-3', () => {
  const dir = mkdirp('decouple');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'backend'), { recursive: true });
  writeFileSync(join(dir, 'backend', 'private.js'), 'export const p = 1;\n');
  const f = join(dir, 'src', 'probe.js');
  const cfg = { boundaries: { front: ['src/'], back: ['backend/'] }, forbidImports: [['front', 'back']] };
  const mkctx = () => ({ ...buildContext({ art: { files: {}, specs: [] }, cfg, changeDir: dir, repo: dir, cwd: dir }), codeFiles: [f] });
  writeFileSync(f, 'import x from "../backend/private.js";');
  assert.equal(run('DECOUPLE-2', mkctx()).status, 'fail', '真实跨边界 import 必须 FAIL');
  writeFileSync(f, '/*\nimport x from "../backend/private.js";\n*/');
  const commented = run('DECOUPLE-2', mkctx());
  assert.notEqual(commented.status, 'fail', `注释里的 import 不得判 FAIL，实际 ${commented.status}`);
  return { msg: 'DECOUPLE-2：真实引用 FAIL、注释引用不 FAIL' };
});

// ─────────────────────────────────────────────────────────────
// A06 · 扫描收据：文件根不再贡献 0，收据字段有真值
// ─────────────────────────────────────────────────────────────
console.log('\n[A06] 扫描完整性收据');
check('A06-1', () => {
  const s = scanCodeRoots([join(ROOT, 'lib'), join(ROOT, 'tools'), join(ROOT, 'cli.mjs')]);
  const cli = s.report.roots.find((r) => r.root.endsWith('cli.mjs'));
  assert.ok(cli, 'cli.mjs 必须出现在收据里');
  assert.equal(cli.kind, 'file', 'cli.mjs 应被识别为 file 根');
  assert.equal(cli.files, 1, 'cli.mjs 必须贡献 1 个文件（旧实现贡献 0）');
  assert.ok(s.files.some((f) => f.endsWith('cli.mjs')), 'cli.mjs 必须在返回的文件集内');
  return { msg: 'cli.mjs 作为文件根贡献 1 个文件并进入文件集', evidence: `共 ${s.files.length} 文件` };
});
check('A06-2', () => {
  const s = scanCodeRoots([join(ROOT, 'lib'), join(ROOT, 'tools'), join(ROOT, 'cli.mjs')]);
  assert.equal(s.report.candidates, s.files.length, 'candidates 必须等于实际文件数（不得恒为 0）');
  assert.equal(s.report.scanned, s.files.length, 'scanned 必须等于实际文件数（不得恒为 0）');
  assert.ok(s.report.candidates > 0, 'candidates 不得为 0');
  return { msg: 'candidates/scanned 均为真值（t-gates 抓到的恒 0 假字段已修）', evidence: `candidates=${s.report.candidates}` };
});
check('A06-3', () => {
  const s = scanCodeRoots([join(TMP, 'does-not-exist')]);
  assert.ok(s.report.errors.length > 0, '不存在的根必须留痕');
  assert.equal(s.report.roots[0].kind, 'missing');
  return { msg: '不存在的根：kind=missing 且进 errors（不再静默贡献 0）' };
});

// ─────────────────────────────────────────────────────────────
// A14 · 参数分流：输入错误必须 exit 2
// ─────────────────────────────────────────────────────────────
console.log('\n[A14] 参数错误分流');
const cliRun = (args) => {
  const r = spawnSync(process.execPath, ['cli.mjs', ...args], { cwd: ROOT, stdio: 'ignore' });
  return r.status;
};
const changeDir = join(ROOT, 'changes', 'self-host-guard');
const emptyCfg = mk('empty.json');
writeFileSync(emptyCfg, '{}');
check('A14-1', () => {
  const code = cliRun(['check', '--change', changeDir, '--json', '--code']);
  assert.equal(code, 2, `裸 --code 必须 exit 2，实际 ${code}`);
  return { msg: '裸 --code ⇒ exit 2（旧实现 TypeError exit 1）', evidence: 'exit 2' };
});
check('A14-2', () => {
  const code = cliRun(['check', '--change', changeDir, '--min-coverage', '--only', 'DISCIPLINE-C2']);
  assert.equal(code, 2, `裸 --min-coverage 必须 exit 2，实际 ${code}`);
  return { msg: '裸 --min-coverage ⇒ exit 2（旧实现 Number(true)=1 静默）' };
});
check('A14-3', () => {
  const bad = mk('bad-config.json');
  writeFileSync(bad, JSON.stringify({ maxNesting: 'garbage' }));
  const code = cliRun(['check', '--change', changeDir, '--config', bad, '--code', join(ROOT, 'lib')]);
  assert.equal(code, 2, `非法配置必须 exit 2，实际 ${code}`);
  return { msg: '非法配置值域 ⇒ exit 2（旧实现 exit 0 且判 PASS）' };
});
check('A14-4', () => {
  const bad = mk('bad-type.json');
  writeFileSync(bad, '[1,2,3]');
  assert.equal(cliRun(['check', '--change', changeDir, '--config', bad]), 2, '顶层是数组的配置必须 exit 2');
  return { msg: '配置顶层非对象 ⇒ exit 2' };
});
check('A14-5', () => {
  assert.equal(cliRun(['check', '--change', changeDir, '--only', 'NOPE-1']), 2, '未知规则 id ⇒ exit 2');
  assert.equal(cliRun(['check']), 2, '缺 --change ⇒ exit 2');
  assert.equal(cliRun(['nosuchcmd']), 2, '未知子命令 ⇒ exit 2');
  return { msg: '未知 id / 缺必需项 / 未知子命令 全部 exit 2' };
});
check('A14-6', () => {
  // 合法调用必须 exit 0，证明上面的 2 不是"一律退 2"
  const code = cliRun(['check', '--change', changeDir, '--only', 'DISCIPLINE-C2', '--config', emptyCfg]);
  assert.equal(code, 0, `合法调用必须 exit 0，实际 ${code}`);
  return { msg: '正控：合法调用 exit 0（参数校验没把正常路径判死）' };
});

// ─────────────────────────────────────────────────────────────
// A11/A09/A10 · 证据链（委派给 t-evidence 的实现，这里做端到端断言）
// ─────────────────────────────────────────────────────────────
console.log('\n[A09/A10/A11] 证据链端到端');
check('A09-1', () => {
  const dir = mkdirp('dup-tap');
  // 生产者脚本自己输出双汇总（不依赖外部文件被删后的时序）
  const scriptPath = join(dir, 'prod.mjs');
  writeFileSync(
    scriptPath,
    "process.stdout.write(['\u2139 tests 999','\u2139 pass 999','\u2139 fail 0','\u2139 tests 2','\u2139 pass 1','\u2139 fail 1'].join('\\n'));",
  );
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      tests: { command: `node "${scriptPath}"` },
      mutation: { command: 'node test/mutation.mjs' },
      drift: { command: 'node tools/check-contract.mjs' },
    }),
  );
  const evOut = join(dir, 'ev.json');
  const r = spawnSync(process.execPath, ['tools/make-evidence.mjs', '--config', cfgPath, '--out', evOut, '--repo', ROOT], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  assert.notEqual(r.status, 0, '双汇总输出必须让 make-evidence 失败');
  assert.equal(existsSync(evOut), false, '失败时不得写出证据文件（旧证据不得冒充本次）');
  return { msg: '双 TAP 汇总 ⇒ make-evidence 非 0 且不写出证据', evidence: '不再取首个匹配拼出 999 全绿' };
});
check('A11-1', () => {
  /**
   * ★ 2026-11-13 六环境矩阵抓到：这条断言原来直接读仓库根的 `evidence.json`，
   * 而那个文件是 `self-check` 的 `make-evidence` 步才产出的 —— 在 `scripts.test` 里
   * 单独跑本文件时它**不存在** ⇒ 六环境全部 1 条红。
   *
   * 修法不是"跳过"，而是**本探针自己产一份证据**：探针要验的是
   * 「provenance 的 runId/tree/完整 64 位 sha256 齐全」，那就当场跑一次 make-evidence，
   * 用自己产出的文件断言。**不依赖外部前置产物，也不读别人跑过的旧文件。**
   */
  const evDir = mkdtempSync(join(writableTempRoot(), 'spec-ev-'));
  const evOut = join(evDir, 'evidence.json');
  const cfg = join(evDir, 'cfg.json');
  const producer = join(evDir, 'producer.mjs');
  writeFileSync(producer, "console.log('\u2139 tests 3');console.log('\u2139 pass 3');console.log('\u2139 fail 0');");
  writeFileSync(
    cfg,
    JSON.stringify({
      tests: { command: `node "${producer}"` },
      mutation: { command: 'node test/mutation.mjs' },
      drift: { command: 'node tools/check-contract.mjs' },
    }),
  );
  const fdOut = join(evDir, 'run.txt');
  const fd = openSync(fdOut, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, ['tools/make-evidence.mjs', '--config', cfg, '--out', evOut, '--repo', ROOT], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  assert.equal(r.status, 0, `make-evidence 必须成功（exit ${r.status}），日志: ${readFileSync(fdOut, 'utf8').slice(-300)}`);

  const ev = JSON.parse(readFileSync(evOut, 'utf8'));
  assert.ok(ev.meta && ev.meta.runId, 'evidence 必须带 meta.runId');
  assert.ok(ev.meta.tree, 'evidence 必须带代码树身份');
  assert.equal(typeof ev.meta.producers.tests.sha256, 'string');
  assert.equal(ev.meta.producers.tests.sha256.length, 64, `sha256 必须是完整 64 位，实际 ${ev.meta.producers.tests.sha256.length}`);
  rmSync(evDir, { recursive: true, force: true });
  return { msg: 'provenance：本探针当场产出的证据里 runId + tree + 完整 64 位 sha256 齐全', evidence: `sha256 长度 64` };
});

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
const bad = out.filter((o) => !o.ok);
console.log('\n=== 规格验收探针汇总 ===');
console.log(`  断言 ${out.filter((o) => o.ok).length}/${out.length} 成立`);
if (bad.length) {
  console.log(`\n  ✗ ${bad.length} 条规格未成立：`);
  for (const b of bad) console.log(`    - ${b.id}: ${b.msg}`);
}
console.log('\n未覆盖（本探针不证明）:');
console.log('  · 六环境矩阵（ubuntu × windows × Node 20/22/24）未跑');
console.log('  · 真实业务仓库（非 JS 语言）未跑');
console.log('  · git 不可用路径的降级未实证');
console.log('  · MANUAL 规则的语义正确性无法机器验证');
process.exit(bad.length ? 1 : 0);

