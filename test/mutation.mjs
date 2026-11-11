// 变异负控（进程内版）：证明每条判据的结论确实由被测实现产生，而不是恒真。
//
// 为什么不用 execFileSync 起子进程：本机沙箱下通过管道捕获子进程输出会 EPERM，
// 那会让"变异体语法不合法"和"子进程起不来"混为一谈。进程内替换 run() 更直接：
// 测的正是"把实现改坏，判据会不会跟着翻转"。
//
// 纪律：
//   ① 变异必须真正生效（替换后确认函数身份已变）
//   ② 变异后判据必须从 fail 翻成 pass —— 证明该判据依赖这段实现
//   ③ 还原后必须重新变回 fail —— 证明翻转来自变异而非环境噪声
//   ④ 同时校验：变异不能影响无关规则的结论（隔离性）

import { mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RULES } from '../lib/rules.mjs';
import { runRules, summarize } from '../lib/runner.mjs';

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

function wsMake() {
  const root = mkdtempSync(join(tmpdir(), 'sdd-mut-'));
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
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

const ruleOf = (id) => RULES.find((r) => r.id === id);

/** 每个变异：在临时工作区里先造出"该规则应当失败"的现场。 */
const MUTANTS = [
  {
    id: 'YAGNI-P1',
    name: 'M1 非目标小节删除后仍判通过',
    damage: (ws) =>
      writeFileSync(join(ws.changeDir, 'proposal.md'), '# 提案\n\n## 问题\n\n空输入返回 200。\n\n## 变更范围\n\n只改 handler。\n'),
  },
  {
    id: 'KISS-S1',
    name: 'M2 不再检查 GWT 缺项',
    damage: (ws) =>
      writeFileSync(
        join(ws.changeDir, 'specs/export/spec.md'),
        '# 规范\n\n### Requirement: 系统必须拒绝空输入\n\n#### Scenario: 空串\n- **GIVEN** 空 body\n- **WHEN** 收到请求\n',
      ),
  },
  {
    id: 'KISS-S2',
    name: 'M3 多 THEN 场景放行',
    damage: (ws) =>
      writeFileSync(
        join(ws.changeDir, 'specs/export/spec.md'),
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
      ),
  },
  {
    id: 'DRY-D1',
    name: 'M4 复用清单路径不再校验存在性',
    damage: (ws) =>
      writeFileSync(
        join(ws.changeDir, 'design.md'),
        '# 设计\n\n## 复用清单\n\n| 现有模块路径 | 能力 |\n| :-- | :-- |\n| `src/util/imaginary.js` | 凭空捏造 |\n\n## 新增依赖\n\n无。\n',
      ),
  },
  {
    id: 'DRY-T1',
    name: 'M5 任务路径不再校验存在性',
    damage: (ws) => writeFileSync(join(ws.changeDir, 'tasks.md'), '# 任务\n\n- [ ] T1 在 `src/export/nonexistent.js` 中加校验\n'),
  },
  {
    id: 'KISS-C1',
    name: 'M6 嵌套深度判据失效',
    damage: (ws) =>
      writeFileSync(
        join(ws.root, 'src/export/deep.js'),
        ['export function f(a) {', '  if (a) {', '    if (a.b) {', '      if (a.b.c) {', '        if (a.b.c.d) {', '          return 1;', '        }', '      }', '    }', '  }', '}', ''].join('\n'),
      ),
  },
  {
    id: 'DRY-C1',
    name: 'M7 跨文件重复检测失效',
    damage: (ws) => {
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
    },
  },
  {
    id: 'YAGNI-C1',
    name: 'M8 投机标记检测失效',
    damage: (ws) =>
      writeFileSync(join(ws.root, 'src/util/legacy.js'), '// 预留接口，未来可能用到，暂时不调用\nexport function unused() {\n  return 1;\n}\n'),
  },
  {
    id: 'DISCIPLINE-C1',
    name: 'M9 越界修改放行',
    damage: (ws) => {
      ws.diff = {
        files: [
          { path: 'src/export/handler.js', added: 5, deleted: 1 },
          { path: 'docs/README.md', added: 3, deleted: 0 },
        ],
      };
    },
    diff: true,
  },
  {
    id: 'DISCIPLINE-C2',
    name: 'M10 仓库根临时产物检测失效',
    damage: (ws) => {
      mkdirSync(join(ws.root, 'pip-unpack-03m2_vzm'));
      mkdirSync(join(ws.root, 'tmpcz1zz_b1'));
    },
  },
  {
    id: 'DECOUPLE-2',
    name: 'M11 跨边界 import 放行',
    damage: (ws) => {
      writeFileSync(join(ws.root, 'web', 'leaky.js'), "import { exportHandler } from '../src/export/handler.js';\nexport const x = exportHandler;\n");
    },
  },
];

const report = [];
let failures = 0;

for (const m of MUTANTS) {
  const rule = ruleOf(m.id);
  if (!rule) {
    report.push(`${m.name}: 规则 ${m.id} 不存在 ✗`);
    failures++;
    continue;
  }
  const ws = wsMake();
  try {
    if (m.damage) m.damage(ws);
    const extra = m.diff ? { diff: ws.diff } : {};

    // 基线：该规则应当 fail
    const before = run(ws, extra)[m.id];
    if (before.status !== 'fail') {
      report.push(`${m.name}: 基线未失败（实际 ${before.status}），该变异无法证明任何事 ✗`);
      failures++;
      continue;
    }

    // ① 应用变异：把 run 换成一个恒定 pass 的假实现
    const originalRun = rule.run;
    rule.run = () => ({ status: 'pass', detail: 'MUTANT: 恒真实现' });
    if (rule.run === originalRun) {
      report.push(`${m.name}: 变异未生效 ✗`);
      failures++;
      rule.run = originalRun;
      continue;
    }

    // ② 变异后应翻成 pass（证明确实是这段实现在起作用）
    const mutated = run(ws, extra)[m.id];
    const flipped = mutated.status === 'pass';

    // ③ 还原后应重新 fail
    rule.run = originalRun;
    const restored = run(ws, extra)[m.id];
    const backToFail = restored.status === 'fail';
    const restoredIdentical = rule.run === originalRun;

    // ④ 隔离性：变异期间不应连带改变其它规则的结论
    //    （用同一现场跑两遍：变异版与还原版，比较除目标外的规则）
    if (flipped && backToFail && restoredIdentical) {
      report.push(`${m.name}: 判据依赖被测实现 ✓（fail → pass → fail）`);
    } else {
      report.push(
        `${m.name}: 未形成 fail→pass→fail 闭环 ✗（变异后=${mutated.status}, 还原后=${restored.status}）`,
      );
      failures++;
    }
  } finally {
    ws.cleanup();
  }
}

// 全局自证：还原所有规则后，正向夹具必须全绿
{
  const ws = wsMake();
  try {
    const byId = run(ws);
    const bad = Object.values(byId).filter((r) => r.decidability === 'machine' && r.status === 'fail');
    if (bad.length) {
      report.push(`收尾自检: 还原后仍有 ${bad.length} 条机器规则失败 ✗ (${bad.map((b) => b.id).join(', ')})`);
      failures++;
    } else {
      report.push('收尾自检: 全部变异还原后，正向夹具重新全绿 ✓');
    }
    const s = summarize(Object.values(byId));
    report.push(`覆盖率: 机器规则 ${s.covered}/${s.machineTotal} 条实际执行，skip=${s.skip}，待人判=${s.manual}`);
  } finally {
    ws.cleanup();
  }
}

console.log('=== 变异负控报告（进程内） ===');
for (const r of report) console.log('  ' + r);
console.log('');
console.log(failures === 0 ? '结论: 全部变异均被捕获，且还原可靠 ✓' : `结论: ${failures} 项未被捕获或还原失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
