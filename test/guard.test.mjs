// 负控测试：每条机器规则都必须能在一个"专门坏掉一处"的夹具上变红，
// 且失败原因指向那处，而不是因为崩溃/空集/无关规则。
//
// 纪律（来自本项目历史教训）：
//   1. 期望值写死，绝不从被测实现里取（不引用被测变量的派生值）
//   2. 每个用例先自证夹具"除目标缺陷外"其余部分能通过（正向夹具同源）
//   3. 空集合上不得断言"全绿"——显式断言规则真的执行了（status !== 'skip'）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRules, summarize } from '../lib/runner.mjs';
import { RULES } from '../lib/rules.mjs';
import { rulesForProfile } from '../lib/contract.mjs';

/** 判定某规则是否属于代码阶段（acceptance 档）——测试用，避免把手工 id 清单写死在用例里。 */
function byStageIsCode(id) {
  const r = RULES.find((x) => x.id === id);
  return Boolean(r) && r.stage === 'code';
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD = resolve(HERE, 'fixtures/good');
const CHANGE_REL = 'changes/add-empty-check';

const BASE_CFG = {
  maxNesting: 3,
  dupWindow: 6,
  dupMinChars: 40,
  yagniMinNonGoals: 3,
  dryMinReuse: 1,
  dependencies: {},
  allowedPrefixes: ['src/'],
  maxDiffLines: 400,
  boundaries: { web: ['web/'], server: ['src/'], shared: ['shared/'] },
  forbidImports: [
    { from: 'web', to: 'server' },
    { from: 'server', to: 'web' },
  ],
  contractPrefixes: ['shared/'],
};

/** 复制正向夹具到临时目录，返回 {root, changeDir, cfg}，供各用例局部改坏。 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'sdd-guard-'));
  cpSync(GOOD, root, { recursive: true });
  return {
    root,
    changeDir: join(root, CHANGE_REL),
    cfg: { ...BASE_CFG },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(ws, extra = {}) {
  const { results } = runRules({
    changeDir: ws.changeDir,
    repo: ws.root,
    cwd: ws.root,
    cfg: ws.cfg,
    codeRoots: [join(ws.root, 'src'), join(ws.root, 'web'), join(ws.root, 'shared')],
    diff: null,
    ...extra,
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return { results, byId, summary: summarize(results) };
}

/** 断言某条规则失败，且原因里出现指定关键词。 */
function assertFails(byId, id, keyword) {
  const r = byId[id];
  assert.ok(r, `规则 ${id} 未出现在结果中`);
  assert.notEqual(r.status, 'skip', `${id} 被跳过了 —— 跳过不等于失败，用例无效`);
  assert.equal(r.status, 'fail', `${id} 期望 fail，实际 ${r.status}（${r.reason || r.detail || ''}）`);
  if (keyword) {
    const blob = `${r.reason || ''} ${(r.items || []).join(' ')}`;
    assert.match(blob, new RegExp(keyword), `${id} 失败原因未指向「${keyword}」，实际: ${blob}`);
  }
}

function assertPasses(byId, id) {
  const r = byId[id];
  assert.ok(r, `规则 ${id} 未出现在结果中`);
  assert.equal(r.status, 'pass', `${id} 期望 pass，实际 ${r.status}（${r.reason || r.detail || ''}）`);
}

// ─────────────────────────────────────────────────────────────
// 0. 基线自证：正向夹具必须让全部机器规则通过，且样本非空
// ─────────────────────────────────────────────────────────────
test('基线：正向夹具让所有机器规则通过，且每条都真的执行了', () => {
  const ws = makeWorkspace();
  try {
    const { byId, summary } = run(ws);
    // 自证：机器规则样本非空（否则下面的"全过"毫无意义）
    const machineIds = Object.keys(byId).filter((k) => byId[k].decidability === 'machine');
    assert.ok(machineIds.length >= 10, `机器规则只有 ${machineIds.length} 条，样本异常`);

    for (const id of machineIds) {
      const r = byId[id];
      // 依赖**外部输入**的规则在无输入时必须 skip，不是 pass：
      // DISCIPLINE-C1 需要 --diff，ACCEPT-E* 需要 --evidence。
      if (id === 'DISCIPLINE-C1' || id.startsWith('ACCEPT-')) {
        assert.equal(r.status, 'skip', `${id} 无输入时应为 skip，实际 ${r.status}`);
        continue;
      }
      assert.equal(r.status, 'pass', `${id} 在正向夹具上失败: ${r.reason || ''} ${(r.items || []).join('; ')}`);
    }
    assert.equal(summary.fail, 0);
    // 跳过必须被计数，不能被当成通过
    assert.ok(summary.skip >= 1, 'skip 未被统计 —— 报告会把"没检查"读成"没问题"');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 1. YAGNI-P1：删掉非目标小节 → 必须红
// ─────────────────────────────────────────────────────────────
test('YAGNI-P1 负控：删除「非目标」小节后必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'proposal.md');
    writeFileSync(p, '# 提案\n\n## 问题\n\n空输入返回 200。\n\n## 变更范围\n\n只改 handler。\n');
    const { byId } = run(ws);
    assertFails(byId, 'YAGNI-P1', '非目标');
    // 其余 proposal 规则不应被连带打红（隔离性自证）
    assert.equal(byId['YAGNI-P2'].status, 'manual');
  } finally {
    ws.cleanup();
  }
});

test('YAGNI-P1 负控：非目标只有 2 条（阈值 3）→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'proposal.md');
    writeFileSync(
      p,
      '# 提案\n\n## 非目标\n\n| 不做的事 | 为什么不做 |\n| :-- | :-- |\n| A | 没第二处用到 |\n| B | 单次 40ms 不需要 |\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'YAGNI-P1', '需 ≥ 3');
  } finally {
    ws.cleanup();
  }
});

test('YAGNI-P1 负控：非目标缺「为什么不做」→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'proposal.md');
    writeFileSync(
      p,
      '# 提案\n\n## 非目标\n\n| 不做的事 | 为什么不做 |\n| :-- | :-- |\n| A | 理由1 |\n| B |  |\n| C | 理由3 |\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'YAGNI-P1', '缺');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. KISS-S1：Scenario 缺 THEN / 无 Scenario / 零 Requirement
// ─────────────────────────────────────────────────────────────
test('KISS-S1 负控：Scenario 缺 THEN → 必须失败并指出 THEN', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'specs/export/spec.md');
    writeFileSync(
      p,
      '# 规范\n\n### Requirement: 系统必须拒绝空输入\n\n#### Scenario: 空串\n- **GIVEN** 空 body\n- **WHEN** 收到请求\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'KISS-S1', 'THEN');
  } finally {
    ws.cleanup();
  }
});

test('KISS-S1 负控：Requirement 无任何 Scenario → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'specs/export/spec.md');
    writeFileSync(p, '# 规范\n\n### Requirement: 系统必须拒绝空输入\n\n就是拒绝。\n');
    const { byId } = run(ws);
    assertFails(byId, 'KISS-S1', '无 Scenario');
  } finally {
    ws.cleanup();
  }
});

test('KISS-S1 负控：spec 里一条 Requirement 都没有 → 必须失败（空集不构成通过）', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'specs/export/spec.md');
    writeFileSync(p, '# 规范\n\n这里只是散文，没有任何 Requirement。\n');
    const { byId } = run(ws);
    assertFails(byId, 'KISS-S1', '空集');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. KISS-S2：单场景两个 THEN
// ─────────────────────────────────────────────────────────────
test('KISS-S2 负控：单场景两条 THEN → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'specs/export/spec.md');
    writeFileSync(
      p,
      [
        '# 规范',
        '',
        '### Requirement: 系统必须拒绝空输入',
        '',
        '#### Scenario: 空串',
        '- **GIVEN** 空 body',
        '- **WHEN** 收到请求',
        '- **THEN** 返回 400',
        '- **THEN** 记录日志',
        '',
      ].join('\n'),
    );
    const { byId } = run(ws);
    assertFails(byId, 'KISS-S2', '2 条 THEN');
    // 同时 S1 应仍然 pass（THEN 存在），证明两规则互不冒充
    assertPasses(byId, 'KISS-S1');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. KISS-D1：新增依赖未登记 / 缺理由
// ─────────────────────────────────────────────────────────────
test('KISS-D1 负控：配置新增依赖但 design 未登记 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    ws.cfg = { ...ws.cfg, dependencies: { 'left-pad': '^1.3.0' } };
    const { byId } = run(ws);
    assertFails(byId, 'KISS-D1', '未登记');
  } finally {
    ws.cleanup();
  }
});

test('KISS-D1 负控：依赖有名字但没有「标准库为什么不行」→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    ws.cfg = { ...ws.cfg, dependencies: { 'left-pad': '^1.3.0' } };
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(
      p,
      '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/text.js` | 归一化 |\n\n## 新增依赖\n\n| 依赖名 | 标准库为什么不行的理由 |\n| :-- | :-- |\n| left-pad |  |\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'KISS-D1', '缺');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 5. DRY-D1：复用清单路径不存在
// ─────────────────────────────────────────────────────────────
test('DRY-D1 负控：复用清单写了不存在的路径 → 必须失败并回显该路径', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(
      p,
      '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/imaginary.js` | 凭空捏造 |\n\n## 新增依赖\n\n无。\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'DRY-D1', '不存在');
    assert.ok(
      (byId['DRY-D1'].items || []).some((s) => s.includes('imaginary.js')),
      '失败项未回显具体路径，无法定位',
    );
  } finally {
    ws.cleanup();
  }
});

test('DRY-D1 负控：删除复用清单小节 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(p, '# 设计\n\n## 新增依赖\n\n无。\n');
    const { byId } = run(ws);
    assertFails(byId, 'DRY-D1', '复用清单');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 6. DRY-T1：任务里的路径不存在且未标注新建
// ─────────────────────────────────────────────────────────────
test('DRY-T1 负控：tasks 引用不存在路径且未标新建 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'tasks.md');
    writeFileSync(p, '# 任务\n\n- [ ] T1 在 `src/export/nonexistent.js` 中加校验\n');
    const { byId } = run(ws);
    assertFails(byId, 'DRY-T1', '不存在');
  } finally {
    ws.cleanup();
  }
});

test('DRY-T1 正控：同样路径标注「新建」后必须通过（避免过度拦截）', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'tasks.md');
    writeFileSync(p, '# 任务\n\n- [ ] T1 新建 `src/export/nonexistent.js` 加校验\n');
    const { byId } = run(ws);
    assertPasses(byId, 'DRY-T1');
  } finally {
    ws.cleanup();
  }
});

test('DRY-T1 负控：tasks 完全不给路径 → 必须失败（无法查重）', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'tasks.md');
    writeFileSync(p, '# 任务\n\n- [ ] T1 改一下那部分逻辑\n');
    const { byId } = run(ws);
    assertFails(byId, 'DRY-T1', '路径');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 7. KISS-C1：深嵌套
// ─────────────────────────────────────────────────────────────
test('KISS-C1 负控：5 层嵌套 → 必须失败并回显行号', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.root, 'src/export/deep.js');
    writeFileSync(
      p,
      ['export function f(a) {', '  if (a) {', '    if (a.b) {', '      if (a.b.c) {', '        if (a.b.c.d) {', '          return 1;', '        }', '      }', '    }', '  }', '}', ''].join('\n'),
    );
    const { byId } = run(ws);
    assertFails(byId, 'KISS-C1', '深度');
    assert.ok((byId['KISS-C1'].items || []).some((s) => /deep\.js:\d+/.test(s)), '失败项未给出行号');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 8. DRY-C1：跨文件复制粘贴
// ─────────────────────────────────────────────────────────────
test('DRY-C1 负控：两个文件各粘同样 7 行 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const block = [
      'const a = computeAlpha(input);',
      'const b = computeBeta(a, options);',
      'if (!b) {',
      '  throw new Error("beta failed");',
      '}',
      'const c = finalize(b, ctx);',
      'return { a, b, c };',
    ].join('\n');
    writeFileSync(join(ws.root, 'src/util/dupA.js'), `export function one(input, options, ctx) {\n${block}\n}\n`);
    writeFileSync(join(ws.root, 'src/util/dupB.js'), `export function two(input, options, ctx) {\n${block}\n}\n`);
    const { byId } = run(ws);
    assertFails(byId, 'DRY-C1', '重复');
  } finally {
    ws.cleanup();
  }
});

test('DRY-C1 负控：同样内容放在同一文件里 → 不应报警（避免误伤数据表）', () => {
  const ws = makeWorkspace();
  try {
    const block = [
      'const a = computeAlpha(input);',
      'const b = computeBeta(a, options);',
      'if (!b) {',
      '  throw new Error("beta failed");',
      '}',
      'const c = finalize(b, ctx);',
      'return { a, b, c };',
    ].join('\n');
    writeFileSync(join(ws.root, 'src/util/same.js'), `export function one(input, options, ctx) {\n${block}\n}\nexport function two(input, options, ctx) {\n${block}\n}\n`);
    const { byId } = run(ws);
    // 同文件重复不判红 —— 这条是"防误报"的反向断言
    assertPasses(byId, 'DRY-C1');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 9. YAGNI-C1：投机性标记
// ─────────────────────────────────────────────────────────────
test('YAGNI-C1 负控：代码里写「预留接口，未来可能用到」→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      join(ws.root, 'src/util/legacy.js'),
      '// 预留接口，未来可能用到，暂时不调用\nexport function unused() {\n  return 1;\n}\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'YAGNI-C1', '投机');
  } finally {
    ws.cleanup();
  }
});

test('YAGNI-C1 正控：普通注释不误伤', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      join(ws.root, 'src/util/plain.js'),
      '// 把输入归一化后返回\nexport function plain(v) {\n  return String(v).trim();\n}\n',
    );
    const { byId } = run(ws);
    assertPasses(byId, 'YAGNI-C1');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 10. DISCIPLINE-C1：越界修改 / 超预算
// ─────────────────────────────────────────────────────────────
test('DISCIPLINE-C1 负控：改了 allowedPrefixes 之外的目录 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      diff: { files: [{ path: 'src/export/handler.js', added: 5, deleted: 1 }, { path: 'docs/README.md', added: 3, deleted: 0 }] },
    });
    assertFails(byId, 'DISCIPLINE-C1', '越界');
    assert.ok((byId['DISCIPLINE-C1'].items || []).some((s) => s.includes('docs/README.md')));
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C1 负控：行数超预算 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { diff: { files: [{ path: 'src/export/handler.js', added: 500, deleted: 1 }] } });
    assertFails(byId, 'DISCIPLINE-C1', '超预算');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C1 正控：范围内且未超预算 → 通过', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { diff: { files: [{ path: 'src/export/handler.js', added: 5, deleted: 1 }] } });
    assertPasses(byId, 'DISCIPLINE-C1');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 11. DISCIPLINE-C2：仓库根临时产物
// ─────────────────────────────────────────────────────────────
test('DISCIPLINE-C2 正控：仓库根干净时通过', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws.root, 'src/deep'), { recursive: true });
    const { byId } = run(ws);
    assertPasses(byId, 'DISCIPLINE-C2');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C2 负控：根目录出现 pip-unpack-xxxx → 必须失败并回显该名字', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws.root, 'pip-unpack-03m2_vzm'));
    const { byId } = run(ws);
    assertFails(byId, 'DISCIPLINE-C2', '临时目录');
    assert.ok(
      (byId['DISCIPLINE-C2'].items || []).some((s) => s.includes('pip-unpack-03m2_vzm')),
      '失败项未回显具体目录名，无法定位',
    );
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C2 负控：随机 tmp*/cdp-profile-*/diag-* 也要抓（不能只认 pip 前缀）', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws.root, 'tmpcz1zz_b1'));
    mkdirSync(join(ws.root, 'cdp-profile-35u8x7y1'));
    mkdirSync(join(ws.root, 'diag-0mvc_ege'));
    const { byId } = run(ws);
    assertFails(byId, 'DISCIPLINE-C2', '3 个');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C2 正控：名字像但不是临时产物的目录不误伤', () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(join(ws.root, 'pipelines'));   // 以 pip 开头但不是 pip-
    mkdirSync(join(ws.root, 'templates'));   // 以 tmp 无关
    mkdirSync(join(ws.root, 'diagnostics')); // 以 diag 开头但不是 diag-
    const { byId } = run(ws);
    assertPasses(byId, 'DISCIPLINE-C2');
  } finally {
    ws.cleanup();
  }
});

// ── KISS-C1 的正控：对象字面量不得算作"嵌套" ──────────────────
// 自举时发现：旧实现数全部花括号，`{ a: { b: { c: { d: 1 } } } }` 被误判 4 层。
// 那是数据结构长这样，不是逻辑复杂 —— 误报一次就会失去信任。
test('KISS-C1 正控：5 层嵌套的对象字面量不得报警（不算控制流嵌套）', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      join(ws.root, 'src', 'config.js'),
      ['export const cfg = {', '  a: {', '    b: {', '      c: {', '        d: 1,', '      },', '    },', '  },', '};', ''].join('\n'),
    );
    const { byId } = run(ws);
    assertPasses(byId, 'KISS-C1');
  } finally {
    ws.cleanup();
  }
});

test('KISS-C1 负控：控制流 4 层仍必须报警（改语义不能把真问题一起放过）', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      join(ws.root, 'src', 'deep.js'),
      [
        'export function f(xs) {',
        '  for (const x of xs) {',
        '    if (x) {',
        '      while (x) {',
        '        x--;',
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const { byId } = run(ws);
    assertFails(byId, 'KISS-C1', '超过 3 层');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 13. 前后端解耦（DECOUPLE-1 / DECOUPLE-2 / DECOUPLE-3）
// ─────────────────────────────────────────────────────────────
test('DECOUPLE-1 负控：删掉「接口契约」小节 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(p, '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/text.js` | 归一化 |\n\n## 新增依赖\n\n无。\n');
    const { byId } = run(ws);
    assertFails(byId, 'DECOUPLE-1', '接口契约');
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-1 负控：契约路径不存在 → 必须失败并回显路径', () => {
  const ws = makeWorkspace();
  try {
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(
      p,
      '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/text.js` | 归一化 |\n\n## 新增依赖\n\n无。\n\n## 接口契约\n\n| 契约文件 | 内容 |\n| :-- | :-- |\n| `shared/api/missing.json` | 凭空捏造 |\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'DECOUPLE-1', '不存在');
    assert.ok((byId['DECOUPLE-1'].items || []).some((s) => s.includes('missing.json')));
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-1 负控：契约文件不在契约目录（两侧各自定义 = 假契约）→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    // 放一个真实存在但不在 shared/ 下的契约文件
    writeFileSync(join(ws.root, 'src', 'api.json'), '{}\n');
    const p = join(ws.changeDir, 'design.md');
    writeFileSync(
      p,
      '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/text.js` | 归一化 |\n\n## 新增依赖\n\n无。\n\n## 接口契约\n\n| 契约文件 | 内容 |\n| :-- | :-- |\n| `src/api.json` | 只有后端侧有 |\n',
    );
    const { byId } = run(ws);
    assertFails(byId, 'DECOUPLE-1', '契约目录');
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-2 负控：前端 import 后端内部路径 → 必须失败并回显该 import', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(join(ws.root, 'web', 'leaky.js'), "import { exportHandler } from '../src/export/handler.js';\n");
    const { byId } = run(ws);
    assertFails(byId, 'DECOUPLE-2', '跨边界');
    assert.ok(
      (byId['DECOUPLE-2'].items || []).some((s) => s.includes('leaky.js') && s.includes('src/export/handler.js')),
      '失败项未回显具体 import',
    );
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-2 负控：后端 import 前端 → 同样失败（双向都要拦）', () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(join(ws.root, 'src', 'bad.js'), "import { buildRequest } from '../web/app.js';\nexport const x = buildRequest;\n");
    const { byId } = run(ws);
    assertFails(byId, 'DECOUPLE-2', '跨边界');
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-2 正控：前端 import 共享契约 → 通过（共享不算越界）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws);
    assertPasses(byId, 'DECOUPLE-2');
  } finally {
    ws.cleanup();
  }
});

test('DECOUPLE-2 跳过语义：未配置 boundaries ⇒ skip，且不算通过', () => {
  const ws = makeWorkspace();
  try {
    ws.cfg = { ...ws.cfg, boundaries: {}, forbidImports: [] };
    const { byId } = run(ws);
    assert.equal(byId['DECOUPLE-2'].status, 'skip', '未配置边界时必须 skip 而不是 pass');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 15. 两套档位：开发流程 ≠ 验收标准
// ─────────────────────────────────────────────────────────────
test('档位划分完备且互斥：process + acceptance = 全部规则，无交集', () => {
  const proc = rulesForProfile(RULES, 'process');
  const acc = rulesForProfile(RULES, 'acceptance');
  assert.equal(proc.length + acc.length, RULES.length);
  assert.equal(proc.filter((r) => acc.some((a) => a.id === r.id)).length, 0);
  assert.ok(proc.length > 0 && acc.length > 0, '两档都不能为空');
  // 流程档不得混入代码级判据，验收档不得混入四制品判据
  assert.ok(proc.every((r) => r.stage !== 'code'), 'process 档混入了 code 阶段规则');
  assert.ok(acc.every((r) => r.stage === 'code'), 'acceptance 档混入了非 code 阶段规则');
});

test('--profile process 不跑验收规则，--profile acceptance 不跑流程规则', () => {
  const ws = makeWorkspace();
  try {
    const proc = run(ws, { profile: 'process' }).results.map((r) => r.id);
    const acc = run(ws, { profile: 'acceptance' }).results.map((r) => r.id);
    assert.ok(proc.every((id) => !id.startsWith('ACCEPT-')), 'process 档不该出现 ACCEPT-E*');
    assert.ok(acc.every((id) => id.startsWith('ACCEPT-') || byStageIsCode(id)), 'acceptance 档混入流程规则');
    assert.ok(acc.length > 0 && proc.length > 0);
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 16. 验收证据（acceptance 档）：只读外部证据，空集不构成通过
// ─────────────────────────────────────────────────────────────
test('ACCEPT-E1 正控：passed>0 且 failed=0 → 通过', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { tests: { passed: 35, failed: 0, skipped: 1 } } });
    assertPasses(byId, 'ACCEPT-E1');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E1 负控：passed=0（空样本"全绿"）→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { tests: { passed: 0, failed: 0 } } });
    assertFails(byId, 'ACCEPT-E1', '空样本');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E1 负控：failed>0 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { tests: { passed: 30, failed: 2 } } });
    assertFails(byId, 'ACCEPT-E1', '2 个测试失败');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 正控：11/11 ≥ 0.8 → 通过', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { mutation: { killed: 11, total: 11 } } });
    assertPasses(byId, 'ACCEPT-E2');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：total=0（没有变异体）→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { mutation: { killed: 0, total: 0 } } });
    assertFails(byId, 'ACCEPT-E2', '空集');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：杀死率不足 → 必须失败并回显存活项', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { mutation: { killed: 5, total: 11, survived: ['M7 跨文件重复检测失效'] } } });
    assertFails(byId, 'ACCEPT-E2', '0.45');
    assert.ok((byId['ACCEPT-E2'].items || []).some((s) => s.includes('M7')), '未回显存活变异体');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E3 负控：checks=0（漂移检测没跑过）→ 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { drift: { checks: 0, findings: 0 } } });
    assertFails(byId, 'ACCEPT-E3', '空集')
    ;
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E3 负控：存在漂移 → 必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { drift: { checks: 27, findings: 2, items: ['ICD 里 maxNesting 默认值未写成 3'] } } });
    assertFails(byId, 'ACCEPT-E3', '2 处契约漂移');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 17. skip 语义：缺制品时必须 skip，绝不能算 pass
// ─────────────────────────────────────────────────────────────
test('缺 design.md 时，依赖与复用规则必须 skip 而不是 pass', () => {
  const ws = makeWorkspace();
  try {
    rmSync(join(ws.changeDir, 'design.md'));
    const { byId, summary } = run(ws);
    assert.equal(byId['KISS-D1'].status, 'skip');
    assert.equal(byId['DRY-D1'].status, 'skip');
    assert.ok(summary.skip >= 2, 'skip 计数未增加');
    assert.ok(summary.covered < summary.machineTotal, '覆盖率应反映"有规则没执行"');
  } finally {
    ws.cleanup();
  }
});
