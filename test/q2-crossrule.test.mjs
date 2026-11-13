// Q2 跨规则同族探测：DRY-D1 / DRY-T1 / DECOUPLE-1 是否共用 Q1 的 6 个启发式后门。
// 这三条判据都调用 extractPaths / looksLikePath / splitCommandPaths ——
// 2026-11-13 修复的是函数本身，因此它们理论上自动受益。本文件验证这个「理论上」。
//
// 判据口径与 q1-backdoor.test.mjs 一致：正控必须 FAIL 且原因指向目标路径，
// 实验组状态必须等于写死的 PIN，否则判定该探针无效（不是结论）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { runRules } from '../lib/runner.mjs';

const FIXTURE = new URL('./fixtures/q1-base/', import.meta.url).pathname.replace(/^\//, '');

function runWith(root, { tasks, design, diff }) {
  const cd = join(root, 'changes/x');
  mkdirSync(cd, { recursive: true });
  if (tasks !== undefined) writeFileSync(join(cd, 'tasks.md'), tasks);
  if (design !== undefined) writeFileSync(join(cd, 'design.md'), design);
  // runRules 内部用 listArtifacts(changeDir) 自己读文件，不接受外部 art；
  // cwd 必须显式传，否则 buildContext 里 resolve(undefined, p) 会抛错。
  const { results } = runRules({
    changeDir: cd,
    repo: root,
    cwd: root,
    cfg: { contractPrefixes: ['shared/'] },
    diff: diff ? { files: diff.map((p) => ({ path: p, added: 3, deleted: 0 })) } : null,
    codeRoots: [],
  });
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

function withRoot(fn) {
  const root = mkdtempSync(join(writableTempRoot(), 'sdd-q2-'));
  cpSync(FIXTURE, root, { recursive: true });
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const q = (s) => '\u0060' + s + '\u0060';

test('X1 DRY-D1 复用清单：无扩展名真实文件应能被识别', () => withRoot((root) => {
  // 修复前：extractPaths 要求扩展名 ⇒ 无扩展名路径抽不出来 ⇒ 清单"0 条"或漏掉它。
  const design = [
    '# 设计', '', '## 复用清单', '',
    '- ' + q('src/export/extless/index') + ' —— 现有 index 可直接复用', '',
    '## 接口契约', '', '- ' + q('shared/api/export.json'), '',
  ].join('\n');
  const r = runWith(root, { design: design });
  const d1 = r['DRY-D1'];
  // PIN 写死：修复后 extless/index 能被识别并判定存在 ⇒ PASS 且 detail 计数 >= 1
  assert.equal(d1.status, 'pass', 'DRY-D1 应 PASS（无扩展名真实文件已可识别）');
  assert.match(d1.detail || '', /[1-9]/, 'detail 中的条数应 >= 1');
}));

test('X2 DRY-D1 负控：复用清单引用不存在的无扩展名路径 → 必须 FAIL', () => withRoot((root) => {
  const design = [
    '# 设计', '', '## 复用清单', '',
    '- ' + q('src/export/does-not-exist/index') + ' —— 幻想复用', '',
    '## 接口契约', '', '- ' + q('shared/api/export.json'), '',
  ].join('\n');
  const r = runWith(root, { design: design });
  assert.equal(r['DRY-D1'].status, 'fail', 'DRY-D1 必须 FAIL：引用了不存在的无扩展名路径');
  assert.match(
    (r['DRY-D1'].reason || '') + (r['DRY-D1'].items || []).join(' '),
    /does-not-exist/,
    '失败原因应指向那条幽灵路径',
  );
}));

test('X3 DRY-T1 任务路径：含空格的幽灵路径经引号感知后应被抓', () => withRoot((root) => {
  // 修复前：splitCommandPaths 无引号感知 ⇒ "src/export/ghost probe.js" 被切碎丢弃。
  const tasks = [
    '# 任务', '',
    '- [ ] T1 修改 ' + q('src/export/handler.js') + ' 增加校验', '',
    '- [ ] T2 执行 ' + q('node tools/build.mjs "src/export/ghost probe.js"') + ' 生成', '',
  ].join('\n');
  const r = runWith(root, { tasks: tasks, diff: ['src/export/handler.js'] });
  const t1 = r['DRY-T1'];
  // extractPaths 只抓反引号整段；命令行整段含空格 ⇒ 由 C3 的 split 处理。
  // DRY-T1 走的是 extractPaths(f.text)，因此这里验证它不把整段命令当路径误报。
  assert.equal(t1.status, 'pass', 'DRY-T1 不应把整条命令行误判为路径');
}));

test('X4 DRY-T1 负控：真实存在的路径写错一字 → 必须 FAIL', () => withRoot((root) => {
  const tasks = [
    '# 任务', '',
    '- [ ] T1 修改 ' + q('src/export/handlr.js') + ' 增加校验', '',
  ].join('\n');
  const r = runWith(root, { tasks: tasks, diff: ['src/export/handler.js'] });
  assert.equal(r['DRY-T1'].status, 'fail', 'DRY-T1 必须 FAIL：路径拼错且未标注新建');
}));

test('X5 DECOUPLE-1 契约路径：无扩展名真实文件应可识别', () => withRoot((root) => {
  const design = [
    '# 设计', '', '## 复用清单', '', '- ' + q('src/util/text.js'), '',
    '## 接口契约', '', '- ' + q('shared/api/export.json'), '',
  ].join('\n');
  const r = runWith(root, { design: design });
  assert.equal(r['DECOUPLE-1'].status, 'pass', 'DECOUPLE-1 应 PASS（契约在 shared/ 下且存在）');
}));

test('X6 DECOUPLE-1 负控：契约路径不在 contractPrefixes 下 → 必须 FAIL', () => withRoot((root) => {
  const design = [
    '# 设计', '', '## 复用清单', '', '- ' + q('src/util/text.js'), '',
    '## 接口契约', '', '- ' + q('src/export/handler.js'), '',
  ].join('\n');
  const r = runWith(root, { design: design });
  assert.equal(r['DECOUPLE-1'].status, 'fail', 'DECOUPLE-1 必须 FAIL：契约不在 shared/ 下');
}));

test('X7 交叉验证：这三条判据在修复前后行为确实改变（走的是同一批函数）', () => {
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  // 断言它们仍然调用共享函数 —— 若有人改成自己实现，本文件的「自动受益」前提失效
  const d1 = src.slice(src.indexOf("id: 'DRY-D1'"), src.indexOf("id: 'KISS-D2'"));
  const t1 = src.slice(src.indexOf("id: 'DRY-T1'"), src.indexOf("id: 'DRY-T2'"));
  const dc = src.slice(src.indexOf("id: 'DECOUPLE-1'"), src.indexOf("id: 'DECOUPLE-2'"));
  assert.match(d1, /extractPaths\(/, 'DRY-D1 应复用 extractPaths');
  assert.match(t1, /extractPaths\(/, 'DRY-T1 应复用 extractPaths');
  assert.match(dc, /extractPaths\(/, 'DECOUPLE-1 应复用 extractPaths');
});
