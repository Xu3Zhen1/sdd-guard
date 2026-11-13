// 评审包 §5 Q2 价值实测：C3 的反向检查（"改了但文档没提"）到底还有多少判别力？
//
// 背景：第 7 轮把该检查降级为**弱检查**——只要文档全文（proposal/design/specs/tasks）
// 任意一处出现该文件名即算"提过"。理由是不该重复承担 C1（allowedPrefixes + 行数预算）的职责。
//
// Q2 的问题：「是否意味着 C3 的反向检查已经弱到没有价值？」
//
// 本文件不谈立场，只做实测：构造 8 类"文档里出现过该名字"的真实形态，
// 逐一看 C3 是否放过。放过的是假阴性（漏报），抓住的才是它的剩余价值。
//
// 判据统一：每条都要有**正控**（文档完全没提 ⇒ 必须 FAIL），
// 否则"这次没报"可能是 C3 根本没跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { runRules } from '../lib/runner.mjs';

const FIXTURE = new URL('./fixtures/q1-base/', import.meta.url).pathname.replace(/^\//, '');

/** 跑 C3：change 目录里放给定制品，diff 里放给定变更文件。 */
function runC3({ proposal, design, tasks, specs, diffFiles }) {
  const root = mkdtempSync(join(writableTempRoot(), 'q2v-'));
  cpSync(FIXTURE, root, { recursive: true });
  const cd = join(root, 'changes/x');
  mkdirSync(cd, { recursive: true });
  if (proposal !== undefined) writeFileSync(join(cd, 'proposal.md'), proposal);
  if (design !== undefined) writeFileSync(join(cd, 'design.md'), design);
  if (tasks !== undefined) writeFileSync(join(cd, 'tasks.md'), tasks);
  if (specs !== undefined) {
    mkdirSync(join(cd, 'specs'), { recursive: true });
    writeFileSync(join(cd, 'specs/spec.md'), specs);
  }
  try {
    const { results } = runRules({
      changeDir: cd,
      repo: root,
      cwd: root,
      cfg: {},
      diff: { files: diffFiles.map((p) => ({ path: p, added: 3, deleted: 0 })) },
    });
    return results.find((r) => r.id === 'DISCIPLINE-C3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TASKS_BASE = '- [ ] T1 修改 `src/export/handler.js` 增加校验\n';
const GHOST = 'src/export/ghost.js';

/** 正控：文档完全没提该文件 ⇒ C3 必须 FAIL（证明反向检查确实在跑）。 */
test('P0 正控：文档完全未提 ⇒ 必须 FAIL 且点名该文件', () => {
  const r = runC3({
    proposal: '# 提案\n\n做点事。\n',
    design: '# 设计\n\n随便写写。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', GHOST],
  });
  assert.equal(r.status, 'fail', 'C3 反向检查未生效 —— 后续所有"没报"都不能当作结论');
  assert.match(
    `${r.reason || ''} ${(r.items || []).join(' ')}`,
    /ghost\.js/,
    '失败信息必须点名该文件',
  );
});

/** 场景 1：文件名出现在**一句"不改它"的说明**里。 */
test('S1 文档写了「不修改 ghost.js」⇒ 是否仍算"提过"？', () => {
  const r = runC3({
    proposal: '# 提案\n\n本次不修改 ghost.js，保持现状。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', GHOST],
  });
  // PIN 写死实测结论：文档说"不改"仍算"提过" ⇒ 假阴性。
  // 这不是 bug 修复目标（判据是名称匹配，做不到语义判断），而是**已记录的局限**。
  // 若哪天它变 fail，说明有人加强了判据，必须同步更新 _work/q2-value-report.md。
  assert.equal(r.status, 'pass', 'S1 实测为假阴性（文档说不改仍算提过）；若变 fail 请更新报告与 PIN');
});

/** 场景 2：文件名出现在**历史/无关的段落**里（如"从前的实现"）。 */
test('S2 文档在一段无关叙述里提到该名字 ⇒ 是否算"提过"？', () => {
  const r = runC3({
    proposal: '# 提案\n\n背景：上一版本的 ghost.js 曾承担过类似职责，后已废弃。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', GHOST],
  });
  assert.equal(r.status, 'pass', 'S2 实测为假阴性（历史叙述也算提过）');
});

/** 场景 3：只提到 stem（无扩展名）且长度 ≥8 ⇒ 当前实现算"提过"。 */
test('S3 文档只提 stem（长度≥8）不写扩展名 ⇒ 算不算提过？', () => {
  const r = runC3({
    proposal: '# 提案\n\nghost 这个名字在讨论里出现过（注意这里不含 .js）。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', GHOST],
  });
  // ghost 长度 5 < 8 ⇒ 按当前实现不应匹配 stem 分支 ⇒ 必须 FAIL
  assert.equal(r.status, 'fail', 'S3：短 stem 不应被当作已披露');
});

/** 场景 4：名字只在 specs 里出现一次（合规路径：确实披露了）。 */
test('S4 名字在 specs 里被正常披露 ⇒ 应 PASS（这是弱检查的正当价值）', () => {
  const r = runC3({
    proposal: '# 提案\n\n略。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    specs: '# 规格\n\n- 新增 ghost.js 用于占位校验。\n',
    diffFiles: ['src/export/handler.js', GHOST],
  });
  // ★ 修复前此用例 FAIL：listArtifacts 把 specs 放在 art.specs，
  //   而 C3 的 allArtText 只遍历 art.files，**根本没读 specs**（注释却写着含 specs）。
  //   这是 Q2 价值实测抓到的真实缺陷，已修。
  assert.equal(r.status, 'pass', '正常披露应放行（修复前因未读 specs 而误判 fail）');
});

/** 场景 5：文件名相同但**目录不同**（同名文件混淆）。 */
test('S5 文档提的是另一个目录下的同名文件 ⇒ 是否被误认为已披露？', () => {
  const r = runC3({
    proposal: '# 提案\n\n注意 test/ghost.js 是测试夹具。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', GHOST],
  });
  // 当前实现只看 basename，不看完整路径 ⇒ 同名即算提过（假阴性）
  assert.equal(r.status, 'pass', 'S5 实测为假阴性（同名不同目录被误认为已披露）');
});

/** 场景 6：路径在 diff 里但完全不在 codeScopes 默认范围内（tools/）。 */
test('S6 tools/ 下的变更文档未提 ⇒ 应 FAIL（Q1 R6 修复后默认全查）', () => {
  const r = runC3({
    proposal: '# 提案\n\n略。\n',
    design: '# 设计\n\n略。\n',
    tasks: TASKS_BASE,
    diffFiles: ['src/export/handler.js', 'tools/build-extra.mjs'],
  });
  assert.equal(r.status, 'fail', 'tools/ 下的未披露变更必须被抓');
  assert.match(`${r.reason} ${(r.items || []).join(' ')}`, /build-extra/);
});
