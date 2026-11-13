// `real-diff-notice` 的归因判据负控。
//
// 这个文件守的是**我自己造的假绿**（2026-11-13 第三次独立复核抓到）：
//
//   原实现：`m ? '超预算' : txt.includes('"status": "fail"') ? '有判据判红' : '通过 C1/C3'`
//
// 复核用**不存在的 config** 做负控：真实 CLI 退 **2**（配置错误），输出里既没有
// "变更 N 行"也不含 `"status": "fail"` ⇒ 落到最后那个分支 ⇒ **打印"通过 C1/C3"**。
// 「无法判定」被报成了「通过」——正是本项目存在的理由所要防的形态。
//
// 根因是**用"没找到失败文本"倒推"通过"**。任何以"没发现坏消息"为依据的通过判定都是假的。
//
// 所以这组用例的核心不是"能不能识别失败"，而是：
// **凡是输入不足以下结论的，绝不能输出"通过"。**
//
// 六个分支每条都要有：
//   ① 无法判定（退出 2 / 退出 null / 退出 0 但 JSON 坏 / 规则 skip）
//   ② 有结论判红（退出 1 且有 results；退出 0 但 status=fail）
//   ③ 真通过（退出 0 + 两条都 pass）—— 正控，防"一律说无法判定"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRealDiff } from '../tools/self-check.mjs';
import { writableTempRoot } from '../lib/temp.mjs';

/** 造一段合法的 `--json` 输出。 */
const json = (results) => JSON.stringify({ exitCode: 0, results }, null, 2);

const PASS_C1_C3 = json([
  { id: 'DISCIPLINE-C1', status: 'pass', detail: '3 个文件、12 行，均在范围内' },
  { id: 'DISCIPLINE-C3', status: 'pass', detail: '绑定完整' },
]);

test('负控：CLI 退出 2（配置错误）⇒ 必须"无法判定"，绝不能出现"通过"', () => {
  const txt = '配置错误: 配置文件 不存在: …/NO-SUCH-CONFIG.json\n';
  const tail = classifyRealDiff(2, txt);
  assert.match(tail, /无法判定/, `退出 2 必须判为无法判定，实际: ${tail}`);
  assert.doesNotMatch(tail, /通过 C1\/C3/, `退出 2 绝不能出现"通过"，实际: ${tail}`);
});

test('负控：进程起不来（status=null 归一为 -1）⇒ 必须"无法判定"', () => {
  const tail = classifyRealDiff(-1, '');
  assert.match(tail, /无法判定/);
  assert.doesNotMatch(tail, /通过 C1\/C3/);
});

test('负控：退出 0 但 `--json` 不可解析 ⇒ 必须"无法判定"，不得靠"没找到失败"判通过', () => {
  const tail = classifyRealDiff(0, '这不是 JSON，只是一段人话输出。');
  assert.match(tail, /无法判定/, `JSON 坏必须判无法判定，实际: ${tail}`);
  assert.doesNotMatch(tail, /通过 C1\/C3/);
});

test('负控：退出 0 但某条规则 skip（未真正执行）⇒ 必须"无法判定"', () => {
  const txt = json([
    { id: 'DISCIPLINE-C1', status: 'pass' },
    { id: 'DISCIPLINE-C3', status: 'skip', reason: '未提供 diff' },
  ]);
  const tail = classifyRealDiff(0, txt);
  assert.match(tail, /无法判定/, `有 skip 必须判无法判定，实际: ${tail}`);
  assert.match(tail, /DISCIPLINE-C3/, '必须点名是哪条没执行');
  assert.doesNotMatch(tail, /通过 C1\/C3/);
});

test('负控：退出 0 但缺了某条 rule 的结果 ⇒ 必须"无法判定"', () => {
  const tail = classifyRealDiff(0, json([{ id: 'DISCIPLINE-C1', status: 'pass' }]));
  assert.match(tail, /无法判定/);
  assert.match(tail, /DISCIPLINE-C3/);
});

test('负控：退出 0 且 C1 fail ⇒ 必须明说"未通过"，并带出预算数字', () => {
  const txt =
    json([
      { id: 'DISCIPLINE-C1', status: 'fail', reason: '1 项越界/超预算' },
      { id: 'DISCIPLINE-C3', status: 'pass' },
    ]) + '\n· 变更 7793 行，超预算 400 行\n';
  const tail = classifyRealDiff(0, txt);
  assert.match(tail, /未通过/);
  assert.match(tail, /DISCIPLINE-C1/);
  assert.match(tail, /7793/, '必须带出真实行数');
  assert.doesNotMatch(tail, /^本次真实变更通过/);
});

test('负控：退出 1 且有 results ⇒ 判红（有结论），不是"无法判定"', () => {
  const txt = json([
    { id: 'DISCIPLINE-C1', status: 'fail' },
    { id: 'DISCIPLINE-C3', status: 'fail' },
  ]);
  const tail = classifyRealDiff(1, txt);
  assert.match(tail, /未通过/, `退出 1 且能解析 ⇒ 应判未通过，实际: ${tail}`);
  assert.doesNotMatch(tail, /无法判定/);
});

test('正控：退出 0 且 C1/C3 都 pass ⇒ 才能说"通过"', () => {
  const tail = classifyRealDiff(0, PASS_C1_C3);
  assert.match(tail, /通过 C1\/C3/, `正控：全绿时必须能说通过，实际: ${tail}`);
  assert.doesNotMatch(tail, /无法判定/);
});

test('负控：状态缺失 / unknown / null / 空串 / 数字 / 拼错 ⇒ 全部"无法判定"', () => {
  // ★ 这一组是 2026-11-13 第四次复核抓到的**排除法漏洞**：
  //   上一版只排除 skip/manual/fail，剩余怪值全落到"通过"分支。
  //   判据要的不是"没有坏消息"，而是**必须有正面好消息** —— 所以改成状态白名单。
  const malformed = [
    ['缺 status', [{ id: 'DISCIPLINE-C1' }, { id: 'DISCIPLINE-C3' }]],
    ['unknown', [{ id: 'DISCIPLINE-C1', status: 'unknown' }, { id: 'DISCIPLINE-C3', status: 'unknown' }]],
    ['null', [{ id: 'DISCIPLINE-C1', status: null }, { id: 'DISCIPLINE-C3', status: null }]],
    ['空串', [{ id: 'DISCIPLINE-C1', status: '' }, { id: 'DISCIPLINE-C3', status: '' }]],
    ['数字 1', [{ id: 'DISCIPLINE-C1', status: 1 }, { id: 'DISCIPLINE-C3', status: 1 }]],
    ['拼错 passed', [{ id: 'DISCIPLINE-C1', status: 'passed' }, { id: 'DISCIPLINE-C3', status: 'passed' }]],
    ['布尔 true', [{ id: 'DISCIPLINE-C1', status: true }, { id: 'DISCIPLINE-C3', status: true }]],
    ['对象', [{ id: 'DISCIPLINE-C1', status: {} }, { id: 'DISCIPLINE-C3', status: {} }]],
  ];
  for (const [label, results] of malformed) {
    const tail = classifyRealDiff(0, json(results));
    assert.match(tail, /无法判定/, `${label} 必须判无法判定，实际: ${tail}`);
    assert.doesNotMatch(tail, /通过 C1\/C3/, `${label} 绝不能宣称通过，实际: ${tail}`);
  }
});

test('负控：只有一条状态合法、另一条畸形 ⇒ 也必须"无法判定"', () => {
  const tail = classifyRealDiff(
    0,
    json([
      { id: 'DISCIPLINE-C1', status: 'pass' },
      { id: 'DISCIPLINE-C3', status: 'unknown' },
    ]),
  );
  assert.match(tail, /无法判定/);
  assert.match(tail, /DISCIPLINE-C3/, '必须点名是哪条不可承认');
  assert.doesNotMatch(tail, /通过 C1\/C3/);
});

test('元判据：覆盖所列输入类别，只有"两条都明确 pass"才允许出现"通过"', () => {
  // ★ 措辞纪律（第四次复核算）：这**不是**"穷举所有输入"——
  //   它只覆盖下面列出的类别。缺失/未知状态是第 8 条补齐的，将来还可能有别的形态。
  //   所以断言写的是"以下类别内，只有唯一合法情形允许说通过"。
  const cases = [
    [2, '配置错误'],
    [-1, ''],
    [0, '不是 JSON'],
    [0, json([{ id: 'DISCIPLINE-C1', status: 'pass' }, { id: 'DISCIPLINE-C3', status: 'skip' }])],
    [0, json([{ id: 'DISCIPLINE-C1', status: 'pass' }])],
    [0, json([{ id: 'DISCIPLINE-C1', status: 'pass' }, { id: 'DISCIPLINE-C3' }])],
    [0, json([{ id: 'DISCIPLINE-C1', status: 'pass' }, { id: 'DISCIPLINE-C3', status: 'unknown' }])],
    [0, json([{ id: 'DISCIPLINE-C1', status: 'fail' }, { id: 'DISCIPLINE-C3', status: 'pass' }])],
    [1, json([{ id: 'DISCIPLINE-C1', status: 'fail' }, { id: 'DISCIPLINE-C3', status: 'fail' }])],
  ];
  for (const [status, txt] of cases) {
    const tail = classifyRealDiff(status, txt);
    assert.doesNotMatch(
      tail,
      /通过 C1\/C3/,
      `这些输入都不够格说"通过"，却说了。status=${status} txt=${txt.slice(0, 60)} → ${tail}`,
    );
  }
  // 唯一合法情形
  assert.match(classifyRealDiff(0, PASS_C1_C3), /通过 C1\/C3/);
});

test('有真实临时目录也不影响（本文件不写盘，仅自证 tmp 可用）', () => {
  // 这条是给"夹具能不能建起来"留一个显式检查点：
  // 若 temp 不可用，本文件其它用例仍能跑（纯函数），但在这里显式暴露环境问题。
  assert.ok(writableTempRoot().length > 0);
});
