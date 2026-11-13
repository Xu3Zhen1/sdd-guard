// Q1 后门探针（评审包 §5 Q1）：逐个验证启发式能否吞掉真问题。
//
// 判定语义（每条探针都要输出其中之一，禁止只输出"通过/失败"）：
//   LEAK       = 绕过手法生效 —— 同一违规在"有绕过"时 PASS，在"去掉绕过"时 FAIL。
//                两个方向都必须被观测到，缺一个就不算 LEAK（可能是测试基建问题）。
//   HOLD       = 启发式未被攻破 —— 构造了输入，但规则仍然 FAIL 或无视该绕过。
//   UNEXECUTED = 未能构造 / 正控没变红 ⇒ 根本没有触达目标判据，必须显式报出，不得算作 HOLD。
//
// 纪律（沿用本项目既有教训）：
//   1. 规格期望写死为 FAIL；"实际观测"单独记录，二者不得混为一谈。
//   2. 每个 LEAK 必须配一个正控：去掉绕过手法后，同一违规必须 FAIL 且失败原因指向该路径。
//      没有正控的 PASS 无法区分"判据被绕过"与"判据压根没跑"。
//   3. 当前行为（PIN）写死为字面量，不引用被测代码常量。lib/ 变更后此处变红 ——
//      ★ 2026-11-13：R1–R6 修复落地后，8 条原 LEAK 已转为 HOLD，PIN 同步改为 'fail'。
//        这构成 Q1 报告「未做变异验证」的闭环：若 lib/ 回退，这些用例会立刻变红。

//      这是有意的：它迫使运行者重新核对本文件与 _work/q1-report.md，而不是让探针随实现漂移。
//   4. 只读 lib/：本文件不修改任何生产代码，只调用其导出函数与规则 run()。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { writableTempRoot } from '../lib/temp.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRules } from '../lib/runner.mjs';
import { looksLikePath, splitCommandPaths, extractPaths } from '../lib/rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BASE = resolve(HERE, 'fixtures/q1-base');

/** 规格期望：文档声明要改、实际没改 ⇒ 必须 FAIL。这是写死的规格值，不取自实现。 */
const SPEC_EXPECT = 'fail';

/** 合法基线 diff：只改了被声明的那一个文件。 */
const BASE_DIFF = ['src/export/handler.js'];

/** 反引号包裹（避免在模板串里混入裸反引号造成误读）。 */
const q = (s) => '\u0060' + s + '\u0060';

/** 一条列表项。 */
const item = (n, verb, path, tail = '') => `- [ ] T${n} ${verb} ${q(path)}${tail}\n`;

/** 基线任务项：声明要改 handler.js，且 diff 里确实改了它。 */
const BASE_TASK = item(1, '修改', 'src/export/handler.js', ' 增加空输入校验');

function runC3(root, tasksText, diffFiles = BASE_DIFF) {
  const cd = join(root, 'changes/q1');
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, 'tasks.md'), tasksText);
  const diff = { files: diffFiles.map((p) => ({ path: p, added: 3, deleted: 0 })) };
  const { results } = runRules({
    changeDir: cd,
    repo: root,
    cwd: root,
    cfg: {}, // 空配置 ⇒ codeScopes 走默认值，这正是 P6 要测的那条默认
    codeRoots: [],
    diff,
    evidence: null,
    only: ['DISCIPLINE-C3'],
  });
  const r = results[0];
  assert.ok(r, 'DISCIPLINE-C3 未出现在结果中');
  assert.notEqual(r.status, 'skip', 'DISCIPLINE-C3 被跳过 —— 跳过不等于任何结论，探针无效');
  return { status: r.status, reason: r.reason || '', detail: r.detail || '', items: r.items || [] };
}

/** 从肯定句式的 detail 里抠出"声明了几条路径"——被吞掉的路径会让这个数字变小。 */
function declaredCount(res) {
  const m = /声明 (\d+) 条路径/.exec(res.detail);
  return m ? Number(m[1]) : null;
}

/**
 * 判定纯函数：**不碰文件系统**，只吃两次运行结果。
 * 抽出来是为了让「探针本身会不会假绿」可以被负控验证（见 META 用例）。
 *
 * @param {{id:string, verdict:string, pin:string, controlKeyword:string}} spec
 * @param {{status:string, reason:string, detail:string, items:string[]}} control 去掉绕过手法的对照组
 * @param {{status:string, reason:string, detail:string, items:string[]}} bypass  带绕过手法的实验组
 */
function classify(spec, control, bypass) {
  // ① 正控（去掉绕过手法）必须红，且原因指向被声明的路径 —— 证明探针真的触达了目标判据
  assert.equal(
    control.status,
    SPEC_EXPECT,
    `${spec.id} 正控未变红（实际 ${control.status}）⇒ 探针没触达判据，本用例无效：${control.reason || control.detail}`,
  );
  // 失败原因关键词可能落在 reason（没落地的条数）或 items（具体路径）里，两处都要搜
  const controlBlob = `${control.reason} ${control.items.join(' ')}`;
  assert.ok(
    controlBlob.includes(spec.controlKeyword),
    `${spec.id} 正控失败原因未指向「${spec.controlKeyword}」，实际: ${controlBlob}`,
  );

  // ② 实际行为必须等于 PIN（写死），不引用被测常量
  assert.equal(
    bypass.status,
    spec.pin,
    `${spec.id} 当前行为已变化（实测 ${bypass.status}，PIN ${spec.pin}）——` +
      `lib/ 或夹具已改动，请复核 _work/q1-report.md 并更新 PIN：${bypass.reason || bypass.detail}`,
  );

  const verdict = bypass.status === 'pass' ? 'LEAK' : bypass.status === 'fail' ? 'HOLD' : 'UNEXECUTED';
  assert.equal(verdict, spec.verdict, `${spec.id} 结论应为 ${spec.verdict}，实测判定 ${verdict}`);
  return verdict;
}

/** 跑一对（绕过 + 正控），返回记录。正控不红即抛错。 */
function pair(root, spec) {
  const bypass = runC3(root, spec.bypassTasks, spec.bypassDiff || BASE_DIFF);
  const control = runC3(root, spec.controlTasks, spec.controlDiff || BASE_DIFF);
  const verdict = classify(spec, control, bypass);
  const rec = {
    id: spec.id,
    heuristic: spec.heuristic,
    verdict,
    bypass,
    control,
    mechanism: spec.mechanism,
    evidence: spec.evidence ? spec.evidence({ bypass, control }) : '',
    input: spec.input,
  };
  RECORDS.push(rec);
  return rec;
}

/** 运行时收集，供末尾汇总；每个用例各自断言，不依赖汇总。 */
const RECORDS = [];

// ─────────────────────────────────────────────────────────────
// P0 基线自证：探针夹具本身必须能过（否则后面所有 PASS 都无意义）
// ─────────────────────────────────────────────────────────────
test('P0 基线自证：夹具 + 合法声明 ⇒ PASS，且声明了 1 条路径', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const r = runC3(root, BASE_TASK);
    assert.equal(r.status, 'pass', `夹具基线不通过，后续 PASS 不可信: ${r.reason} ${JSON.stringify(r.items)}`);
    // 自证样本非空：确认规则真的走到了"声明 N 条路径全部落地"这条分支
    assert.equal(declaredCount(r), 1, '基线应恰好声明 1 条路径');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P1 NOT_CHANGING：'不适用' 等词做**整条块**包含匹配 ⇒ 能局部修饰真修改
// ─────────────────────────────────────────────────────────────
test('P1 NOT_CHANGING：局部修饰词吞掉整条真修改（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P1-a',
      heuristic: 'NOT_CHANGING',
      input: '「修改 `src/util/text.js` 的归一化（日志格式不适用本次封装）」',
      mechanism: 'lib/rules.mjs:964  `if (NOT_CHANGING.test(block)) continue;` —— 整块包含匹配，无修饰范围判断',
      bypassTasks: BASE_TASK + item(5, '修改', 'src/util/text.js', ' 的归一化（日志格式不适用本次封装）'),
      controlTasks: BASE_TASK + item(5, '修改', 'src/util/text.js', ' 的归一化（日志格式沿用现有封装）'),
      controlKeyword: 'src/util/text.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) =>
        `detail 自报「${bypass.detail}」⇒ 被吞掉后 declared 只剩 1 条，text.js 从未进入"声明要改"集合`,
    });
    // 2026-11-13 修复后（R1 修正）：豁免词不再把路径移出 declared，
    // text.js 与基线的 handler.js 一并计入 ⇒ declared = 2，且必须 FAIL。
    // 2026-11-13 修复后：该块返回 fail，detail 为空 ⇒ 不再用 declaredCount 探数字，
    // 改为直接断言「必须失败」且「失败信息点名被漏报的路径」。这是更强的判据。
    assert.equal(rec.bypass.status, 'fail', 'P1-a：修复后必须 FAIL');
    assert.ok(
      `${rec.bypass.reason || ''} ${(rec.bypass.items || []).join(' ')}`.includes('src/util/text.js'),
      'P1-a：失败信息应点名 src/util/text.js',
    );
    assert.equal(rec.bypass.status, 'fail', 'P1-a：修复后"局部修饰词"不能吞掉真修改');

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1 NOT_CHANGING：更短的局部修饰「不需要修改」同样生效（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P1-b',
      heuristic: 'NOT_CHANGING',
      input: '「修改 `src/util/text.js`（函数签名不需要修改，只加导出）」',
      mechanism: 'lib/rules.mjs:861  NOT_CHANGING 含「不需要修改」，而该词修饰的是"签名"不是"整条"',
      bypassTasks: BASE_TASK + item(6, '修改', 'src/util/text.js', '（函数签名不需要修改，只加导出）'),
      controlTasks: BASE_TASK + item(6, '修改', 'src/util/text.js', '（函数签名保持不变，只加导出）'),
      controlKeyword: 'src/util/text.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) => `detail「${bypass.detail}」⇒ 声明数被压到 1`,
    });
    // 2026-11-13 修复后：该块返回 fail，detail 为空 ⇒ 不再用 declaredCount 探数字，
    // 改为直接断言「必须失败」且「失败信息点名被漏报的路径」。这是更强的判据。
    assert.equal(rec.bypass.status, 'fail', 'P1-b：修复后必须 FAIL');
    assert.ok(
      `${rec.bypass.reason || ''} ${(rec.bypass.items || []).join(' ')}`.includes('src/util/text.js'),
      'P1-b：失败信息应点名 src/util/text.js',
    );
    assert.equal(rec.bypass.status, 'fail', 'P1-b：「不需要修改」不能吞掉真修改');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P2 RECON_HEAD：句首动词决定"是否要求被改"，兜底只查路径存在性
// ─────────────────────────────────────────────────────────────
test('P2 RECON_HEAD：句首写「确认」即脱离"必须被改"管辖（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P2',
      heuristic: 'RECON_HEAD',
      input: '「确认 `src/util/text.js` 需要改动」——文件真实存在但 diff 里没有它',
      mechanism:
        'lib/rules.mjs:877 RECON_HEAD 命中 ⇒ 路径进 reconRefs（只查存在性）；' +
        'lib/rules.mjs:1000 phantom 只拦"不存在"，真实文件永远过',
      bypassTasks: BASE_TASK + item(7, '确认', 'src/util/text.js', ' 需要改动'),
      controlTasks: BASE_TASK + item(7, '修改', 'src/util/text.js', ' 需要改动'),
      controlKeyword: 'src/util/text.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) =>
        `语义完全相同的两句话，仅句首动词不同：「确认」⇒ PASS（${bypass.detail}），「修改」⇒ FAIL。` +
        `⇒ 判定被一个可自由选择的动词开关`,
    });
    // 2026-11-13 修复后：句首「确认」+ 含"需要改动" ⇒ 按**声明**处理（R2 双条件），
    // 因此 text.js 进入 declared，声明数比修复前多 1。
    // 2026-11-13 修复后：该块返回 fail，detail 为空 ⇒ 不再用 declaredCount 探数字，
    // 改为直接断言「必须失败」且「失败信息点名被漏报的路径」。这是更强的判据。
    assert.equal(rec.bypass.status, 'fail', 'P2：修复后必须 FAIL');
    assert.ok(
      `${rec.bypass.reason || ''} ${(rec.bypass.items || []).join(' ')}`.includes('src/util/text.js'),
      'P2：失败信息应点名 src/util/text.js',
    );
    assert.equal(rec.bypass.status, 'fail', 'P2：修复后"确认…需要改动"必须 FAIL（双条件生效）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P3 looksLikePath
// ─────────────────────────────────────────────────────────────
test('P3-a looksLikePath：路径含「--」被判成命令行 flag ⇒ 幽灵路径完全免检（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P3-a',
      heuristic: 'looksLikePath',
      input: '「执行 `node tools/build.mjs src/export/ghost--probe.js` 生成校验」：一个**不存在**的文件',
      mechanism:
        'lib/rules.mjs:89  `if (v.includes("--")) return false;` ⇒ 整串不算路径；' +
        'splitCommandPaths 逐 token 再判，该 token 仍含「--」⇒ 也返回 false ⇒ 三条通道全哑',
      bypassTasks: BASE_TASK + `- [ ] T8 执行 ${q('node tools/build.mjs src/export/ghost--probe.js')} 生成校验\n`,
      controlTasks: BASE_TASK + `- [ ] T8 执行 ${q('node tools/build.mjs src/export/ghost-probe.js')} 生成校验\n`,
      controlKeyword: '不存在的路径',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass, control }) =>
        `函数级：looksLikePath("src/export/ghost--probe.js")=${looksLikePath('src/export/ghost--probe.js')}，` +
        `splitCommandPaths(...)=${JSON.stringify(splitCommandPaths('node tools/build.mjs src/export/ghost--probe.js'))}；` +
        `端到端：绕过 ${bypass.status} / 正控 ${control.status}（${control.reason}）`,
    });
    // 2026-11-13 修复后（R3-a）：`--` 不再一刀切否定路径，
    // 含分隔符的 ghost--probe.js 应被识别为路径候选并进入校验。
    assert.equal(looksLikePath('src/export/ghost--probe.js'), true, 'P3-a 机制：修复后含 -- 的路径仍应被识别');
    assert.ok(
      splitCommandPaths('node tools/build.mjs src/export/ghost--probe.js').includes('src/export/ghost--probe.js'),
      'P3-a 机制：修复后幽灵 token 应被 splitCommandPaths 保留',
    );
    assert.equal(rec.bypass.status, 'fail', 'P3-a：修复后幽灵路径必须导致 FAIL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P3-b looksLikePath：无扩展名的真实文件声明要改却不改 ⇒ PASS（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P3-b',
      heuristic: 'looksLikePath',
      input: '「修改 `src/export/extless/index`（真实存在、无扩展名）增加分支」，diff 里没有它',
      mechanism:
        'lib/rules.mjs:92  `/\.[A-Za-z0-9]{1,6}$/` —— 无扩展名的路径永远不算路径；' +
        'extractPaths（:141）同样要求扩展名 ⇒ 该文件既不可被声明、也不进 skipped 提示',
      bypassTasks: BASE_TASK + item(9, '修改', 'src/export/extless/index', ' 增加分支'),
      controlTasks: BASE_TASK + item(9, '修改', 'src/export/handler2.js', ' 增加分支'),
      controlKeyword: 'src/export/handler2.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) =>
        `extractPaths(...)=${JSON.stringify(extractPaths(q('src/export/extless/index')))}；` +
        `detail「${bypass.detail}」——声明数仍是 1，第二条既没校验也没出现在 skipped 提示里`,
    });
    // 2026-11-13 修复后（R3-b）：无扩展名路径也应被抽出并参与校验。
    assert.ok(
      extractPaths(q('src/export/extless/index')).length > 0,
      'P3-b 机制：修复后无扩展名路径应能抽出来',
    );
    assert.equal(rec.bypass.status, 'fail', 'P3-b：修复后无扩展名声明未落地必须 FAIL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P3-c 原构造未生效：第 91 行确实返回 false，但被 splitCommandPaths 兜住 ⇒ 不计为 HOLD', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const cmd = 'node tools/build.mjs src/util/ghost-91.js';
    // 先证第 91 行的判定确实发生（否则这条观测测的是别的行）
    assert.equal(looksLikePath(cmd), false, 'P3-c：整串应被判为非路径（第 91 行生效）');
    // 再证它没能形成后门 —— 子路径被兜住了
    assert.deepEqual(
      splitCommandPaths(cmd),
      ['tools/build.mjs', 'src/util/ghost-91.js'],
      'P3-c：第 91 行返回 false，但 splitCommandPaths 应把子路径捞回来',
    );
    const r = runC3(root, BASE_TASK + `- [ ] T10 执行 ${q(cmd)} 重跑\n`);
    assert.equal(r.status, 'fail', 'P3-c：幽灵子路径应被抓，实际未抓');
    assert.match(`${r.reason} ${r.items.join(' ')}`, /不存在的路径/, 'P3-c：失败原因应指向幻影路径');

    // ★ 显式登记为"未执行"：本条**没有**做出一个能吞掉真问题的绕过输入，
    //   因此既不是 LEAK 也不是 HOLD —— HOLD 的语义是"构造成功但没攻破"，
    //   而这里根本没构造出来。混为一谈会把 6 条全部标成"测过且安全"。
    RECORDS.push({
      id: 'P3-c',
      heuristic: 'looksLikePath',
      verdict: 'UNEXECUTED',
      input: '「执行 `node tools/build.mjs src/util/ghost-91.js`」——专门去掉「--」，只让第 91 行的首词判定生效',
      mechanism: 'lib/rules.mjs:91  首词 "node" 无 / 无 . ⇒ 返回 false',
      evidence: () => '',
      evidenceText:
        `函数级 looksLikePath=false（第 91 行确已生效），但 splitCommandPaths 立刻把 'src/util/ghost-91.js' 捞回，` +
        `端到端 fail（${r.reason}）⇒ 该行不构成独立后门。**未能构造出绕过**，故记 UNEXECUTED 而非 HOLD。` +
        `第 91 行要真正危险，需同时让 splitCommandPaths 也失效；目前可见的联合条件是 P3-a/P4（见那两条）。`,
      bypass: r,
      control: r,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P4 splitCommandPaths：按空白切分，不做引号感知
// ─────────────────────────────────────────────────────────────
test('P4 splitCommandPaths：含空格的幽灵路径三处通道全哑（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P4',
      heuristic: 'splitCommandPaths',
      input: '「执行 `node tools/build.mjs "src/export/ghost probe.js"`」——注意这个文件不存在，且带空格',
      mechanism:
        'lib/rules.mjs:108 `v.split(/\s+/)` 无引号感知 ⇒ 被拆成 "src/export/ghost" 与 "probe.js" 两个残片，' +
        '两片都不满足 looksLikePath（一片无扩展名、一片无斜杠）⇒ 无任何提示',
      bypassTasks: BASE_TASK + `- [ ] T11 执行 ${q('node tools/build.mjs "src/export/ghost probe.js"')} 生成\n`,
      controlTasks: BASE_TASK + `- [ ] T11 执行 ${q('node tools/build.mjs "src/export/ghost-probe.js"')} 生成\n`,
      controlKeyword: '不存在的路径',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass, control }) =>
        `函数级：splitCommandPaths(带空格) = ${JSON.stringify(splitCommandPaths('node tools/build.mjs "src/export/ghost probe.js"'))};` +
        `端点：绕过 ${bypass.status}（items=${JSON.stringify(bypass.items)}）/ 正控 ${control.status}（${control.reason}）` +
        `——仅"空格"一个变量之差`,
    });
    // 2026-11-13 修复后（R4）：引号感知切分 ⇒ 整串路径被保留，参与存在性校验。
    assert.deepEqual(
      splitCommandPaths('node tools/build.mjs "src/export/ghost probe.js"'),
      ['tools/build.mjs', 'src/export/ghost probe.js'],
      'P4 机制：修复后含空格路径应被整体保留',
    );
    assert.equal(rec.bypass.status, 'fail', 'P4：修复后带空格的幽灵路径必须导致 FAIL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P5 toBlocks：列表项续行只认"两个空格"，单 Tab 直接丢行
// ─────────────────────────────────────────────────────────────
test('P5-a toBlocks：单 Tab 续行整行被丢弃 ⇒ 续行里的声明消失（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P5-a',
      heuristic: 'toBlocks',
      input: '列表项写 `src/export/handler.js`，续行（Tab 缩进）写「同时需要改 `src/util/text.js`」，diff 只改 handler.js',
      mechanism:
        'lib/rules.mjs:896 `/^\s{2,}\S/` 只认 ≥2 个空格；制表符算 1 个字符 ⇒ 续行既不并入当前块、' +
        '又因为 "\t（" 不是列表项而**整行丢弃**（:902-905 把 cur 结算后置空）',
      bypassTasks: BASE_TASK + '- [ ] T12 修改 ' + q('src/export/handler.js') + ' 增加空输入校验\n\t（同时需要改 ' + q('src/util/text.js') + ' 的归一化）\n',
      controlTasks: BASE_TASK + '- [ ] T12 修改 ' + q('src/export/handler.js') + ' 增加空输入校验\n  （同时需要改 ' + q('src/util/text.js') + ' 的归一化）\n',
      controlKeyword: 'src/util/text.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) => `detail「${bypass.detail}」⇒ Tab 续行里的 text.js 从未被抽出；对照两空格版本则 FAIL`,
    });
    // 2026-11-13 修复后（R5-a）：Tab 续行与 ≥2 空格等价，续行里的声明被抽出 ⇒ FAIL。
    assert.equal(rec.bypass.status, 'fail', 'P5-a：修复后 Tab 续行里的声明必须被校验');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P5-b toBlocks：续行里的「不适用」会连带吞掉父项的真修改（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P5-b',
      heuristic: 'toBlocks',
      input: '主项「修改 `src/util/text.js` 的归一化」，两个空格缩进的续行写「（接口签名不适用本次改动）」',
      mechanism:
        'lib/rules.mjs:891-909 把续行并入同一 block ⇒ NOT_CHANGING 的**整块**匹配（:964）命中续行里的「不适用」' +
        '⇒ 父项的路径一并被 continue 掉。这是 P1 与 P5 的**组合放大**：两个启发式叠加让跳过的粒度从"子句"变成"整条任务"',
      bypassTasks: BASE_TASK + item(13, '修改', 'src/util/text.js', ' 的归一化') + '  （接口签名不适用本次改动）\n',
      controlTasks: BASE_TASK + item(13, '修改', 'src/util/text.js', ' 的归一化'),
      controlKeyword: 'src/util/text.js',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass }) => `detail「${bypass.detail}」⇒ 父项声明被续行的豁免词吞掉`,
    });
    // 2026-11-13 修复后（R1 修正）：续行豁免不再连带吞掉父项 ⇒ 必须 FAIL 且点名真修改的路径。
    assert.equal(rec.bypass.status, 'fail', 'P5-b：修复后续行里的豁免词不能吞掉父项真修改');
    assert.ok(
      `${rec.bypass.reason || ''} ${(rec.bypass.items || []).join(' ')}`.includes('src/util/text.js'),
      'P5-b：失败信息应点名被吞的真修改路径',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// P6 codeScopes 反向检查：默认白名单之外的目录，新增文件完全不查
// ─────────────────────────────────────────────────────────────
test('P6 codeScopes：默认白名单外的目录偷偷加文件不报（FIXED · 2026-11-13 修复后应 HOLD）', () => {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q1-'));
  cpSync(FIXTURE_BASE, root, { recursive: true });
  try {
    const rec = pair(root, {
      id: 'P6',
      heuristic: 'codeScopes',
      input: 'diff 里凭空多出 `tools/ghost.mjs`（文档只字未提），其余不变；配置留空以验证默认值',
      mechanism:
        'lib/rules.mjs:1080 `const scopes = ... : ["lib/", "src/", "app/", "packages/"]` ⇒ ' +
        'inScope 对 tools/ tests/ scripts/ bin/ docs 一律 false ⇒ unexplained 过滤掉，反向检查形同虚设',
      bypassTasks: BASE_TASK,
      bypassDiff: ['src/export/handler.js', 'tools/ghost.mjs'],
      controlTasks: BASE_TASK,
      controlDiff: ['src/export/handler.js', 'src/ghost.mjs'],
      controlKeyword: '改了但文档没提',
      pin: 'fail',
      verdict: 'HOLD',
      evidence: ({ bypass, control }) =>
        `同一份文档、同样的"未提及"：src/ 下 ${control.status}（${control.reason}），` +
        `tools/ 下 ${bypass.status}（${bypass.detail}）⇒ 白名单外的目录整段不受反向检查`,
    });
    // 2026-11-13 修复后（R6）：默认全查 ⇒ tools/ 不再豁免，必须报"改了但文档没提"。
    assert.equal(rec.bypass.status, 'fail', 'P6：修复后 tools/ 下的幽灵文件必须被抓');
    const p6text = `${rec.bypass.reason || ''} ${(rec.bypass.items || []).join(' ')}`;
    assert.match(p6text, /tools\/ghost\.mjs/, 'P6：失败信息必须点名 tools/ghost.mjs');
    assert.match(p6text, /改了但文档没提|未声明/, 'P6：应报"改了但文档没提"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
test('汇总：打印每条探针结论 + 命中分支 + 对照组结果', () => {
  assert.equal(RECORDS.length, 10, `应收集到 10 条探针记录，实际 ${RECORDS.length}`);
  const byVerdict = (v) => RECORDS.filter((r) => r.verdict === v).length;
  const lines = [];
  lines.push('');
  lines.push('══ Q1 后门探针结论 ══════════════════════════════════════════');
  for (const r of RECORDS) {
    lines.push(`[${r.verdict.padEnd(10)}] ${r.id.padEnd(6)} ${r.heuristic}`);
    lines.push(`    输入   : ${r.input}`);
    lines.push(`    命中   : ${r.mechanism}`);
    lines.push(`    证据   : ${r.evidenceText || r.evidence}`);
    lines.push(
      `    对照   : 绕过=${r.bypass.status} / 正控=${r.control.status}（${r.control.reason.slice(0, 60)}）`,
    );
  }
  lines.push('────────────────────────────────────────────────────────────');
  lines.push(
    `合计：LEAK ${byVerdict('LEAK')} · HOLD ${byVerdict('HOLD')} · 未执行 ${byVerdict('UNEXECUTED')}（共 ${RECORDS.length} 条探针，覆盖 6 个启发式）`,
  );
  // 每个启发式至少被覆盖到一次，否则"6 条全测过"是空话
  const covered = new Set(RECORDS.map((r) => r.heuristic));
  assert.deepEqual(
    [...covered].sort(),
    ['NOT_CHANGING', 'RECON_HEAD', 'codeScopes', 'looksLikePath', 'splitCommandPaths', 'toBlocks'],
    '6 个启发式未全部覆盖',
  );
  lines.push(`覆盖启发式：${[...covered].join(' / ')}`);
  console.log(lines.join('\n'));
});

// ─────────────────────────────────────────────────────────────
// META 负控：验证「探针自己」会不会假绿
//
// 上面的 P1..P6 全绿只证明"实现行为如 PIN 所述"，**不证明这套判定本身有判别力**。
// 若 classify 是个恒真的空壳，10 条探针照样全绿。所以这里直接喂它伪造结果，
// 强制它在四种坏探针形态下变红，并用一条正例证明它不会恒抛。
// ─────────────────────────────────────────────────────────────
const OK_SPEC = { id: 'META', verdict: 'LEAK', pin: 'pass', controlKeyword: 'src/util/text.js' };
const OK_CONTROL = { status: 'fail', reason: '文档与变更不对应：1 条声明未落地', detail: '', items: ['声明了但没改: src/util/text.js'] };
const OK_BYPASS = { status: 'pass', reason: '', detail: '声明 1 条路径全部落地', items: [] };

function expectThrow(fn, needle, label) {
  assert.throws(
    fn,
    (e) => String(e.message).includes(needle),
    label + '：应当因「' + needle + '」而抛错，实际没有',
  );
}

test('META-1 负控：正控没变红（status=pass）⇒ 判定必须判探针无效', () => {
  expectThrow(
    () => classify(OK_SPEC, { ...OK_CONTROL, status: 'pass' }, OK_BYPASS),
    '正控未变红',
    'META-1',
  );
});

test('META-2 负控：正控红了但原因不指向目标路径 ⇒ 必须判探针无效', () => {
  expectThrow(
    () => classify(OK_SPEC, { ...OK_CONTROL, reason: '反引号未闭合', items: [] }, OK_BYPASS),
    '正控失败原因未指向',
    'META-2',
  );
});

test('META-3 负控：实测行为与 PIN 不符 ⇒ 必须抛错（PIN 是硬回执而非装饰）', () => {
  expectThrow(
    () => classify({ ...OK_SPEC, pin: 'fail', verdict: 'HOLD' }, OK_CONTROL, OK_BYPASS),
    '当前行为已变化',
    'META-3',
  );
});

test('META-4 负控：实测行为与声明的 verdict 不符 ⇒ 必须抛错（方向不能自说自话）', () => {
  expectThrow(
    () => classify({ ...OK_SPEC, verdict: 'HOLD' }, OK_CONTROL, OK_BYPASS),
    '结论应为 HOLD',
    'META-4',
  );
});

test('META-5 正例：合法输入必须返回 LEAK（证明 classify 不恒抛，否则上面 4 条恒真）', () => {
  const v = classify(OK_SPEC, OK_CONTROL, OK_BYPASS);
  assert.equal(v, 'LEAK');
  const v2 = classify({ ...OK_SPEC, pin: 'fail', verdict: 'HOLD' }, OK_CONTROL, { ...OK_BYPASS, status: 'fail' });
  assert.equal(v2, 'HOLD');
});