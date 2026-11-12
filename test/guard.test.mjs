// 负控测试：每条机器规则都必须能在一个"专门坏掉一处"的夹具上变红，
// 且失败原因指向那处，而不是因为崩溃/空集/无关规则。
//
// 纪律（来自本项目历史教训）：
//   1. 期望值写死，绝不从被测实现里取（不引用被测变量的派生值）
//   2. 每个用例先自证夹具"除目标缺陷外"其余部分能通过（正向夹具同源）
//   3. 空集合上不得断言"全绿"——显式断言规则真的执行了（status !== 'skip'）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRules, summarize } from '../lib/runner.mjs';
import { RULES } from '../lib/rules.mjs';
import { rulesForProfile } from '../lib/contract.mjs';
import { extractPaths } from '../lib/rules.mjs';

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
    /** 读正向夹具里的制品原文（给需要对齐内容的用例用）。 */
    readArt: (name) => {
      try {
        return readFileSync(join(root, CHANGE_REL, name), 'utf8');
      } catch {
        return null;
      }
    },
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
/**
 * 断言某条规则失败，且**失败原因必须指向指定关键词**。
 *
 * ★ keyword 现在是**必填**（2026-11-12 外部实测暴露的假用例）。
 *
 * 历史缺陷：keyword 曾是可选。不带 keyword 时这条断言退化成
 * 「只要 status === 'fail' 就算过」——于是**命中任何一条失败分支都算绿**。
 * 实测案例：一条标题为「killed > 有效分母」的用例，喂的数据
 * `killed=9 total=8 survived=[1]` 其实是 9+1≠8，先被"证据自相矛盾"拦下，
 * 那个不可达分支**从头到尾没被执行**，用例却一直是绿的 ⇒ 覆盖率虚高。
 *
 * 判据：**测试数据的实际执行路径必须与标题/注释声称的一致**，
 * 否则红和绿都不可信（红可能是"诊断红"，绿可能是"假覆盖"）。
 */
function assertFails(byId, id, keyword) {
  assert.ok(keyword, `${id}: assertFails 必须给出 keyword —— 否则任何失败分支都算过，无法证明测的是目标分支`);
  const r = byId[id];
  assert.ok(r, `规则 ${id} 未出现在结果中`);
  assert.notEqual(r.status, 'skip', `${id} 被跳过了 —— 跳过不等于失败，用例无效`);
  assert.equal(r.status, 'fail', `${id} 期望 fail，实际 ${r.status}（${r.reason || r.detail || ''}）`);
  const blob = `${r.reason || ''} ${(r.items || []).join(' ')}`;
  assert.match(blob, new RegExp(keyword), `${id} 失败原因未指向「${keyword}」，实际: ${blob}`);
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
      // DISCIPLINE-C1 / C3 需要 --diff，ACCEPT-E* 需要 --evidence。
      if (id === 'DISCIPLINE-C1' || id === 'DISCIPLINE-C3' || id.startsWith('ACCEPT-')) {
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
    const { byId } = run(ws, { evidence: { mutation: { killed: 5, total: 11, survived: ['M7 跨文件重复检测失效', 'M8 存活乙', 'M9 存活丙', 'M10 存活丁', 'M11 存活戊', 'M12 存活己'] } } });
    assertFails(byId, 'ACCEPT-E2', '0.45');
    assert.ok((byId['ACCEPT-E2'].items || []).some((s) => s.includes('M7')), '未回显存活变异体');
  } finally {
    ws.cleanup();
  }
});

// ── 回执缺陷②：等价变异豁免（硬阈值遇到物理不可杀的变异必然误红）──
test('ACCEPT-E2 正控：声明等价变异后从分母扣除 → 由红转绿', () => {
  const ws = makeWorkspace();
  try {
    // 10/14 = 0.71 < 0.8 ⇒ 红；扣除 2 个等价变异后 10/12 = 0.83 ⇒ 绿
    const mutation = { killed: 10, total: 14, survived: ['E1 恒真', 'E2 仅引用不同', 'E3 存活丙', 'E4 存活丁'] };
    const before = run(ws, { evidence: { mutation } }).byId;
    assertFails(before, 'ACCEPT-E2', '0.71');

    const after = run(ws, {
      cfg: { equivalentMutants: [{ id: 'E1', reason: 'String(s)===s 恒真' }, { id: 'E2', reason: '字节相同仅引用不同' }] },
      evidence: { mutation },
    }).byId;
    assertPasses(after, 'ACCEPT-E2');
    assert.match(after['ACCEPT-E2'].detail || '', /扣除等价变异 2/);
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：等价变异缺 reason → 必须失败（豁免不能静默）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 'E1' }, { id: 'E2', reason: '   ' }] },
      evidence: { mutation: { killed: 10, total: 14, survived: ['E1 甲', 'E2 乙'] } },
    });
    assertFails(byId, 'ACCEPT-E2', 'reason');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：豁免掉全部变异 → 分母为 0，必须失败（空集陷阱）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 'E1', reason: 'x' }, { id: 'E2', reason: 'y' }] },
      evidence: { mutation: { killed: 0, total: 2, survived: ['E1 甲', 'E2 乙'] } },
    });
    assertFails(byId, 'ACCEPT-E2', '分母为 0');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2：声明了但本次并未存活的豁免必须被提示（理由可能已过时）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 'E9', reason: '历史遗留' }] },
      evidence: { mutation: { killed: 11, total: 11 } },
    });
    assertPasses(byId, 'ACCEPT-E2');
    assert.match(byId['ACCEPT-E2'].detail || '', /未存活/);
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

// ─────────────────────────────────────────────────────────────
// DISCIPLINE-C3：文档声明 ↔ 实际变更 绑定
// 回执结论一的核心：process 档原来不读代码，四制品描述"另一件没做的事"仍 7 绿。
// ─────────────────────────────────────────────────────────────
test('DISCIPLINE-C3 负控：「文档说改 A、实际改了 B」必须失败', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      diff: { files: [{ path: 'src/other.mjs', added: 10, deleted: 2 }], total: 12 },
    });
    assertFails(byId, 'DISCIPLINE-C3', '不对应');
    const items = byId['DISCIPLINE-C3'].items || [];
    assert.ok(items.some((s) => s.includes('改了但文档没提')), '未指出"改了但文档没提"');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C3 正控：声明的路径全部出现在变更集 → 通过', () => {
  const ws = makeWorkspace();
  try {
    // 与规则口径一致：只取带目录、非本机绝对路径的声明，全部放进 diff。
    const declared = extractPaths(
      [ws.readArt('tasks.md'), ws.readArt('design.md')].filter(Boolean).join('\n'),
    ).filter((p) => p.includes('/') && !/^[A-Za-z]:/.test(p));
    assert.ok(declared.length >= 2, `正向夹具声明路径太少（${declared.length}），用例不够有判别力`);
    const files = declared.map((p) => ({ path: p.replace(/\\/g, '/'), added: 5, deleted: 1 }));
    const { byId } = run(ws, { diff: { files, total: files.length * 6 } });
    assertPasses(byId, 'DISCIPLINE-C3');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C3 负控：无 diff 时必须是 skip，不能算通过', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { diff: null });
    assert.equal(byId['DISCIPLINE-C3'].status, 'skip');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C3：裸文件名不参与比对（避免误伤 —— 回执实测被误伤 3 次）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      diff: { files: [{ path: 'src/x.mjs', added: 1, deleted: 0 }], total: 1 },
    });
    const items = byId['DISCIPLINE-C3'].items || [];
    assert.ok(
      !items.some((s) => /声明了但没改: [^/\n]+\.js/.test(s)),
      '裸文件名被当成带目录路径了',
    );
  } finally {
    ws.cleanup();
  }
});

// ── 回执②的绕过缺口：reason 类型校验（`String(x).trim()` 拦不住非字符串）──
// 实测攻击面：reason = {} / 123 / true / [1,2] 全部"非空"从而让豁免生效，
// 等于"随便填个值就放行"，留痕设计被绕过。必须类型严格。
test('ACCEPT-E2 负控：reason 传非字符串（{} / 123 / true / [1,2]）→ 必须失败', () => {
  const bads = [{}, 123, true, [1, 2], null];
  for (const reason of bads) {
    const ws = makeWorkspace();
    try {
      const { byId } = run(ws, {
        cfg: { equivalentMutants: [{ id: 'S1', reason }] },
        evidence: { mutation: { killed: 7, total: 8, survived: ['S1 a'] } },
      });
      assertFails(byId, 'ACCEPT-E2', 'equivalentMutants');
    } finally {
      ws.cleanup();
    }
  }
});

test('ACCEPT-E2 负控：id 传非字符串 → 必须失败（类型意图明确化）', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 123, reason: '数字 id' }] },
      evidence: { mutation: { killed: 7, total: 8, survived: ['123 a'] } },
    });
    assertFails(byId, 'ACCEPT-E2', 'equivalentMutants');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 正控：合法字符串 reason 仍能正常豁免（类型收紧不能误伤）', () => {
  const ws = makeWorkspace();
  try {
    // 10/14=0.71 红；扣掉 4 个等价变异后 10/10=1.00 绿
    const { byId } = run(ws, {
      cfg: {
        equivalentMutants: [
          { id: 'M11', reason: 'legacy 恒 null，语言层面不可杀' },
          { id: 'M12', reason: 'String(s)===s 恒真' },
          { id: 'M13', reason: '同机 host 恒等' },
          { id: 'M14', reason: 'Buffer 字节等价' },
        ],
      },
      evidence: { mutation: { killed: 10, total: 14, survived: ['M11 a', 'M12 b', 'M13 c', 'M14 d'] } },
    });
    assertPasses(byId, 'ACCEPT-E2');
    assert.match(byId['ACCEPT-E2'].detail || '', /扣除等价变异 4 个/);
  } finally {
    ws.cleanup();
  }
});

// ── 回执第三轮：重复声明提示 + 证据自洽性 ─────────────────────
test('ACCEPT-E2：重复声明（去空白后同名）必须提示「已合并」，不能静默', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      cfg: {
        equivalentMutants: [
          { id: 'S1', reason: '甲' },
          { id: 'S1 ', reason: '乙' },   // trim 后与上一条同名
        ],
      },
      evidence: { mutation: { killed: 6, total: 8, survived: ['S1 a', 'S2 b'] } },
    });
    assertPasses(byId, 'ACCEPT-E2');
    const blob = `${byId['ACCEPT-E2'].detail || ''}`;
    assert.match(blob, /重复声明已合并 1 条/, '重复声明被静默合并了 —— 用户会以为自己豁免了 2 个');
    // 分母只扣真实命中的 1 个：6/(8-1)=0.86，不是 6/(8-2)=1.00
    assert.match(blob, /6\/7/);
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：killed + survived ≠ total → 必须失败（否则能算出杀死率 > 1）', () => {
  const ws = makeWorkspace();
  try {
    // 不校验时：killed=7 total=8 survived=2，扣掉 2 个等价变异 → 7/6 = 1.17 静默 PASS
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 'S1', reason: 'x' }, { id: 'S2', reason: 'y' }] },
      evidence: { mutation: { killed: 7, total: 8, survived: ['S1 a', 'S2 b'] } },
    });
    assertFails(byId, 'ACCEPT-E2', '自相矛盾');
    const blob = `${byId['ACCEPT-E2'].reason || ''}`;
    assert.match(blob, /killed\(7\) \+ survived\(2\) = 9 ≠ total\(8\)/);
  } finally {
    ws.cleanup();
  }
});

// ★ 已删除一条**假用例**（2026-11-12 外部实测揭发）。
//
// 原用例：标题「killed > 有效分母 → 必须失败」，注释称「survived 给全（自洽通过第一关）」，
// 数据却是 killed=9 total=8 survived=[1]（9+1≠8）——它连第一关都没过，
// 命中的是「证据自相矛盾」，那个不可达分支**从未被执行**，而用例一直是绿的。
// 更糟的是我曾声称"已据此改写"，实际没改：**声称修了而没修，比没修更坏**。
//
// 现在该不可达分支由 lib/rules.mjs 的注释与穷举证据（454 组，可达 0）说明，
// **不挂任何测试** —— 测不到的分支不该假装被测过。
// 同时 assertFails 的 keyword 已改为必填，杜绝同类假覆盖再发生。

// ── 回执第四轮：去掉 survived 短路 + 不可达分支 ───────────────
test('ACCEPT-E2 负控：survived=[] 但 killed < total → 必须 FAIL 且准确归因「漏列」', () => {
  const ws = makeWorkspace();
  try {
    // 去掉短路后才能抓住这一格。旧实现（survived.length && ...）在这里会漏校验。
    const { byId } = run(ws, { evidence: { mutation: { killed: 6, total: 8, survived: [] } } });
    assertFails(byId, 'ACCEPT-E2', '自相矛盾');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：漏列 + 同时声明了豁免 → 归因必须是「漏列」而不是「理由过时」', () => {
  const ws = makeWorkspace();
  try {
    // 这是外部实测指出的误导场景：若漏列不被抓住，报告会说
    // 「声明但未存活（理由可能已过时）: S1」，用户于是删掉一个合理的豁免。
    const { byId } = run(ws, {
      cfg: { equivalentMutants: [{ id: 'S1', reason: '合理理由' }] },
      evidence: { mutation: { killed: 6, total: 8, survived: [] } },
    });
    assertFails(byId, 'ACCEPT-E2', '自相矛盾');
    const blob = `${byId['ACCEPT-E2'].reason || ''} ${(byId['ACCEPT-E2'].items || []).join(' ')}`;
    assert.ok(!/理由可能已过时/.test(blob), '归因错了：应指向"漏列"，不应把责任推给豁免声明');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 正控：全杀且 survived 为空（8/8）→ 仍 PASS，不被自洽校验误伤', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { mutation: { killed: 8, total: 8, survived: [] } } });
    assertPasses(byId, 'ACCEPT-E2');
  } finally {
    ws.cleanup();
  }
});

test('ACCEPT-E2 负控：survived 多列（killed + survived > total）→ 必须 FAIL', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, { evidence: { mutation: { killed: 8, total: 8, survived: ['a 甲', 'b 乙'] } } });
    assertFails(byId, 'ACCEPT-E2', '自相矛盾');
  } finally {
    ws.cleanup();
  }
});

// ── 结构审计：ACCEPT-E2 的每个 fail 分支都必须「可达或有明确不可达声明」──
// 2026-11-12：这条审计的由来是一条假用例——标题声称测某个分支，
// 实际被更早的分支拦下。核对方式不是看颜色，是**看实际命中的 reason 文案**。
test('审计：ACCEPT-E2 的 fail 分支中，除已声明不可达者外，每条都必须有用例能命中', () => {
  const base = { maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1 };
  const go = (extraCfg, ev) => {
    const { results } = runRules({
      changeDir: ws.changeDir,
      repo: ws.root,
      cwd: ws.root,
      cfg: { ...base, ...extraCfg },
      codeRoots: [join(ws.root, 'src')],
      diff: null,
      evidence: { mutation: ev },
    });
    return results.find((r) => r.id === 'ACCEPT-E2');
  };
  const ws = makeWorkspace();
  try {
    // 每条：期望命中的 reason 片段 + 触发它的数据
    const reachable = [
      ['killed/total 不是数字', { killed: 'x', total: 8 }],
      ['total=0', { killed: 0, total: 0 }],
      ['不是非空字符串', { killed: 6, total: 8, survived: ['S1 a', 'S2 b'] }, { equivalentMutants: [{ id: 'S1', reason: {} }] }],
      ['自相矛盾', { killed: 6, total: 8, survived: ['S1 a'] }],
      ['分母为 0', { killed: 0, total: 2, survived: ['S1 a', 'S2 b'] }, { equivalentMutants: [{ id: 'S1', reason: 'x' }, { id: 'S2', reason: 'y' }] }],
      ['杀死率', { killed: 6, total: 8, survived: ['S1 a', 'S2 b'] }],
    ];
    for (const [needle, ev, cfg] of reachable) {
      const r = go(cfg || {}, ev);
      assert.equal(r.status, 'fail', `分支「${needle}」未触发失败`);
      assert.match(r.reason || '', new RegExp(needle), `分支「${needle}」实际命中: ${r.reason}`);
    }

    // 已声明不可达的分支：穷举验证它确实到不了（不是"没测"，是"测不到"）
    let invariantHits = 0;
    for (let total = 1; total <= 10; total++) {
      for (let svLen = 0; svLen <= total; svLen++) {
        const killed = total - svLen;
        const survived = Array.from({ length: svLen }, (_, i) => `X${i + 1} d`);
        for (let hit = 0; hit <= svLen; hit++) {
          const eq = survived.slice(0, hit).map((s) => ({ id: s.split(' ')[0], reason: 'r' }));
          const r = go({ equivalentMutants: eq }, { killed, total, survived });
          if (/内部不变量被破坏/.test(r.reason || '')) invariantHits++;
        }
      }
    }
    assert.equal(invariantHits, 0, '「内部不变量被破坏」分支竟然可达 —— 说明代数推导有误，需重新审视');
  } finally {
    ws.cleanup();
  }
});

// ── C3 的真实形态回归（2026-11-12 在 8 个切片上回放后固化）─────────
// 这些用例都来自真实 change 目录的原文，不是构造的。
test('DISCIPLINE-C3：取证句式（句首「确认/检查」）不参与正向声明', () => {
  const ws = makeWorkspace();
  try {
    const { byId } = run(ws, {
      diff: { files: [{ path: 'src/other.mjs', added: 5, deleted: 1 }], total: 6 },
    });
    // 真实原文：`- [ ] T4 在 \`lib/x.js\` 末尾增加 export（实现不动）`
    // 「实现不动」修饰的是实现，不是"这个文件不动" —— 它必须仍被算作声明。
    assert.equal(byId['DISCIPLINE-C3'].status, 'fail');
  } finally {
    ws.cleanup();
  }
});

test('DISCIPLINE-C3：无 diff / 空 diff 都必须是 skip（不假装通过）', () => {
  const ws = makeWorkspace();
  try {
    assert.equal(run(ws, { diff: null }).byId['DISCIPLINE-C3'].status, 'skip');
    assert.equal(run(ws, { diff: { files: [], total: 0 } }).byId['DISCIPLINE-C3'].status, 'skip');
  } finally {
    ws.cleanup();
  }
});
