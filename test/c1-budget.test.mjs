/**
 * DISCIPLINE-C1 行数预算：取消隐式 400 的验收矩阵（A1–A12）。
 * ★ **不复用** `test/guard.test.mjs` 的 `BASE_CFG`（那里显式带 `maxDiffLines: 400`，
 *   拿它测「未启用」只会测到「已启用」）。
 * 规格：`_diag/P0-实施规格-取消隐式maxDiffLines-20261114.md` §一、§四。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writableTempRoot } from '../lib/temp.mjs';
import { RULES, buildContext } from '../lib/rules.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const C1 = RULES.find((r) => r.id === 'DISCIPLINE-C1');

function makeWs() {
  const dir = mkdtempSync(join(writableTempRoot(), 'c1-budget-'));
  const changeDir = join(dir, 'changes', 'x');
  mkdirSync(changeDir, { recursive: true });
  return { dir, changeDir };
}

/** 只跑 C1：验的是单条判据的分支语义，跑全套会引入无关噪声。 */
function runC1(cfg, diff) {
  const ws = makeWs();
  try {
    const ctx = buildContext({ art: { files: {}, specs: [] }, changeDir: ws.changeDir, repo: ws.dir, cwd: ws.dir, cfg, diff });
    return C1.run(ctx);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
}

/** 起真实 CLI。必须 **fd 重定向到文件**，不能走 PIPE：本机沙箱下捕获子进程 stdout 会 EPERM，
 *  `spawnSync` 返回 `status: null`，看起来像"被测代码不返回退出码"。 */
function cli(args, ws) {
  const outFile = join(ws.dir, `cli-${Math.random().toString(16).slice(2)}.txt`);
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, ['cli.mjs', ...args], { cwd: ROOT, shell: false, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  return { status: r.status, out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '' };
}

// A1–A3：预算未启用（配置里真的没有 maxDiffLines）
test('A1 缺省预算 + 范围内 3000 行 ⇒ PASS，且写明「行数预算未启用」', () => {
  const r = runC1({ allowedPrefixes: ['src/'] }, { files: [{ path: 'src/a.js', added: 3000, deleted: 0 }] });
  assert.equal(r.status, 'pass', `期望 pass，实际 ${r.status}：${r.reason || r.detail}`);
  assert.match(r.detail, /行数预算未启用/, '未启用必须写进 detail，否则「通过」会被读成「预算也查过了」');
  assert.doesNotMatch(r.detail, /超预算/, '不得因隐式 400 判超预算（3000 > 400 是反向断言）');
});

test('A2 缺省预算 + 越界 ⇒ FAIL，reason 含「越界」与「预算未启用」', () => {
  const r = runC1({ allowedPrefixes: ['src/'] }, { files: [{ path: 'docs/x.md', added: 5, deleted: 0 }] });
  assert.equal(r.status, 'fail', '预算关闭不能把范围检查一起关掉');
  assert.match(r.reason, /越界/);
  assert.match(r.reason, /预算未启用/, 'reason 要让读者看出预算没跑，而不是"查过且没超"');
});

test('A3 预算与范围均未配 ⇒ PASS，写明「范围检查与行数预算均未启用」', () => {
  const r = runC1({}, { files: [{ path: 'x.txt', added: 5000, deleted: 0 }] });
  assert.equal(r.status, 'pass');
  assert.match(r.detail, /范围检查与行数预算均未启用/);
  assert.doesNotMatch(r.detail, /均通过|都通过|均在范围内/, '不得把"未检查"说成"检查过"');
});

// A4–A7：显式预算（含 0 这个易被误当"未启用"的哨兵）
test('A4 显式预算，恰好 400 ⇒ PASS（补 DESIGN-RATIONALE 曾声称却缺失的边界正控）', () => {
  const r = runC1({ allowedPrefixes: ['src/'], maxDiffLines: 400 }, { files: [{ path: 'src/a.js', added: 400, deleted: 0 }] });
  assert.equal(r.status, 'pass', `恰好 400 必须 PASS，实际 ${r.status}：${r.reason || ''}`);
  assert.match(r.detail, /400/, '已启用时应回显预算值');
});

test('A5 显式预算，超 1 行 401 ⇒ FAIL，reason 含「超预算 400」', () => {
  const r = runC1({ allowedPrefixes: ['src/'], maxDiffLines: 400 }, { files: [{ path: 'src/a.js', added: 401, deleted: 0 }] });
  assert.equal(r.status, 'fail');
  assert.match(`${r.reason} ${(r.items || []).join(' ')}`, /超预算 400/);
});

test('A6 显式 0，零变更且 files 非空 ⇒ PASS（0 行预算允许零变更）', () => {
  const r = runC1({ allowedPrefixes: ['src/'], maxDiffLines: 0 }, { files: [{ path: 'src/a.js', added: 0, deleted: 0 }] });
  assert.equal(r.status, 'pass', `实际 ${r.status}：${r.reason || ''}`);
  assert.notEqual(r.status, 'skip', 'files 非空时不得 skip');
});

test('A7 显式 0，1 行变更 ⇒ FAIL（0 是"禁止任何变更"，绝不能被当成未启用）', () => {
  const r = runC1({ allowedPrefixes: ['src/'], maxDiffLines: 0 }, { files: [{ path: 'src/a.js', added: 1, deleted: 0 }] });
  assert.equal(r.status, 'fail', '若 pass 说明 0 被当成了缺省');
  assert.match(`${r.reason} ${(r.items || []).join(' ')}`, /超预算 0/);
});

// A8：非法配置 ⇒ exit 2，不得静默当未启用
test('A8 非法 maxDiffLines 六种取值均 ⇒ exit 2', () => {
  const ws = makeWs();
  try {
    writeFileSync(join(ws.changeDir, 'proposal.md'), '# 提案\n\n- 目标：t\n');
    const diffFile = join(ws.dir, 'diff.json');
    writeFileSync(diffFile, JSON.stringify({ files: [{ path: 'src/a.js', added: 1, deleted: 0 }] }));
    for (const bad of ['"400"', 'true', '-1', '1.5', 'null', '[]']) {
      const cfgFile = join(ws.dir, 'cfg.json');
      writeFileSync(cfgFile, `{"allowedPrefixes":["src/"],"maxDiffLines":${bad}}`);
      const r = cli(['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', cfgFile, '--diff', diffFile], ws);
      assert.equal(r.status, 2, `maxDiffLines=${bad} 必须 exit 2，实际 ${r.status}；输出尾: ${r.out.slice(-300)}`);
    }
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

// A9–A10：预算关闭后原有防线不得退化（同一组，都是"关掉预算不能顺手软化别的检查"）
test('A9/A10 预算关闭：非法计数仍 FAIL、src/../outside.js 仍越界', () => {
  const a9 = runC1({ allowedPrefixes: ['src/'] }, { files: [{ path: 'src/a.js', added: 'x', deleted: 0 }] });
  assert.equal(a9.status, 'fail', 'A9：非法计数必须 FAIL；若 pass 说明取消预算时把类型校验也软化了');
  assert.match(a9.reason, /计数非法/);

  const a10 = runC1({ allowedPrefixes: ['src/'] }, { files: [{ path: 'src/../outside.js', added: 1, deleted: 0 }] });
  assert.equal(a10.status, 'fail', 'A10：归一后是 outside.js 必须越界；若 pass 说明词法归一回退');
  assert.match(a10.reason, /越界/);
});

test('A11 JSON 的 detail 必须逐字出现在文本输出里，退出码一致', () => {
  const ws = makeWs();
  try {
    writeFileSync(join(ws.changeDir, 'proposal.md'), '# 提案\n\n- 目标：t\n');
    const diffFile = join(ws.dir, 'diff.json');
    writeFileSync(diffFile, JSON.stringify({ files: [{ path: 'src/a.js', added: 3000, deleted: 0 }] }));
    const cfgFile = join(ws.dir, 'cfg.json');
    writeFileSync(cfgFile, JSON.stringify({ allowedPrefixes: ['src/'] })); // 特意不含 maxDiffLines

    const common = ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', cfgFile, '--diff', diffFile, '--only', 'DISCIPLINE-C1'];
    const text = cli(common, ws);
    const json = cli([...common, '--json'], ws);
    assert.equal(text.status, json.status, `退出码必须一致：text=${text.status} json=${json.status}`);

    const parsed = JSON.parse(json.out.slice(json.out.indexOf('{'), json.out.lastIndexOf('}') + 1));
    const c1 = parsed.results.find((x) => x.id === 'DISCIPLINE-C1');
    assert.ok(c1, 'JSON 里必须有 DISCIPLINE-C1');
    assert.equal(c1.status, 'pass');
    assert.match(c1.detail, /行数预算未启用/);
    assert.ok(text.out.includes(c1.detail), `文本必须逐字含 JSON detail。\ndetail: ${c1.detail}\n文本尾: ${text.out.slice(-400)}`);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('A12 预算未启用时不得出现「预算通过」类措辞', () => {
  const r = runC1({ allowedPrefixes: ['src/'] }, { files: [{ path: 'src/a.js', added: 10, deleted: 0 }] });
  const blob = `${r.detail || ''} ${r.reason || ''}`;
  assert.match(blob, /未启用/);
  for (const forbidden of [/预算通过/, /通过预算/, /预算合规/, /未超限/]) {
    assert.doesNotMatch(blob, forbidden, `预算未启用时不得出现 ${forbidden}（那是把未检查说成已合规）`);
  }
});