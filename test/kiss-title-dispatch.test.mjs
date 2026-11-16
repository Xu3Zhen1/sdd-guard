/**
 * KISS-C1 标题按语言分派（2026-11-16，第 ④ 位）。
 *
 * ★ 修的是「标题承诺了它做不到的事」，不是修判定。
 *
 *   `.py` 走 `pyNesting()` —— 只有 8 行 `indent // 4`；
 *   JS/TS 走约 200 行的词法状态机（注释/字符串/模板串/正则/括号栈跨行维护）。
 *   **两者不在同一精度等级，却顶着同一句标题「嵌套深度不得超过 N 层」。**
 *
 *   实测（真实 Python 仓 `eda_skill`，30 文件）：工具报 827 处，
 *   用 Python 自己的 `ast` 核对 —— 真实超限仅 21 处，**虚报 97.5%**。
 *
 * ★ 本文件最重要的负控：**JS/TS 分支的标题不得出现"近似"**。
 *   那条分支是名副其实的（词法状态机真的在判控制流嵌套），
 *   把它也标成近似等于把准确的判据降级成不可信。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writableTempRoot, REPO_ROOT } from '../lib/temp.mjs';

const CLI = join(REPO_ROOT, 'cli.mjs');

/** 造一个临时仓并跑 CLI，返回解析后的 JSON。 */
function runOn(files, codeArgs = ['--code', '.']) {
  const dir = mkdtempSync(join(writableTempRoot(), 'title-'));
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body, 'utf8');
  }
  // --change 要一个存在的目录
  writeFileSync(join(dir, 'tasks.md'), '# t\n\n- [ ] T1\n');
  let out;
  try {
    out = execFileSync(process.execPath, [CLI, 'check', '--change', dir, '--repo', dir, ...codeArgs, '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });
  } catch (e) {
    // FAIL 时退出码非 0，但 stdout 仍是完整 JSON
    out = e.stdout || '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return JSON.parse(out);
}

/** 取 KISS-C1 的结果。 */
function kiss(j) {
  return j.results.find((r) => r.id === 'KISS-C1');
}

// ─────────────────────────────────────────────────────────────
// 1. 正控：.py ⇒ 标题声明近似
// ─────────────────────────────────────────────────────────────

test('纯 .py 仓 ⇒ 标题含「缩进近似」，且不含「控制流嵌套」作为承诺', () => {
  const j = runOn({
    'a.py': 'def f():\n    if x:\n        if y:\n            if z:\n                if w:\n                    pass\n',
  });
  const k = kiss(j);
  assert.ok(k, 'KISS-C1 必须出现在结果里');
  assert.match(k.title, /缩进近似/, `Python 分支标题必须声明"近似"，实际: ${k.title}`);
  assert.match(k.title, /≠ 控制流嵌套/, '必须明说它不是控制流嵌套');
});

test('Python 分支的 reason 也带说明（不只在标题里）', () => {
  const j = runOn({
    'a.py': 'def f():\n    if x:\n        if y:\n            if z:\n                if w:\n                    pass\n',
  });
  const k = kiss(j);
  assert.match(k.reason || k.detail || '', /按缩进估算/, 'reason/detail 必须带同一条说明');
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 负控：JS / Java 分支的标题**不得**出现"近似"
// ─────────────────────────────────────────────────────────────

test('★ 负控：纯 JS 仓 ⇒ 标题是「嵌套深度」，不得含「近似」', () => {
  const j = runOn({
    'a.mjs': 'export function f(x) {\n  if (x) {\n    if (x) {\n      if (x) {\n        if (x) {\n          return 1;\n        }\n      }\n    }\n  }\n}\n',
  });
  const k = kiss(j);
  assert.ok(k, 'KISS-C1 必须出现');
  assert.match(k.title, /嵌套深度/, `JS 分支标题应为"嵌套深度"，实际: ${k.title}`);
  assert.doesNotMatch(k.title, /近似/, `JS 分支是名副其实的，不得标近似，实际: ${k.title}`);
});

test('★ 负控：纯 Java 仓 ⇒ 标题是「嵌套深度」，不得含「近似」', () => {
  const j = runOn({
    'A.java':
      'class A {\n  void m() {\n    if (a) {\n      if (b) {\n        if (c) {\n          if (d) { x(); }\n        }\n      }\n    }\n  }\n}\n',
  });
  const k = kiss(j);
  assert.ok(k, 'KISS-C1 必须出现');
  assert.match(k.title, /嵌套深度/, `Java 分支标题应为"嵌套深度"，实际: ${k.title}`);
  assert.doesNotMatch(k.title, /近似/, `Java 分支不得标近似，实际: ${k.title}`);
});

// ─────────────────────────────────────────────────────────────
// 3. 元判据：标题里的阈值必须与配置一致（占位符必须被替换）
// ─────────────────────────────────────────────────────────────

test('★ 元判据：标题里的阈值必须被替换成实际值，不得印出 {maxNesting} 字面量', () => {
  const j = runOn({
    'a.py': 'def f():\n    if x:\n        if y:\n            if z:\n                if w:\n                    pass\n',
  });
  const k = kiss(j);
  assert.doesNotMatch(k.title, /\{maxNesting\}/, `标题里不许留占位符，实际: ${k.title}`);
  // 默认 maxNesting = 3
  assert.match(k.title, /3\s*层/, `标题应含实际阈值 3，实际: ${k.title}`);
});

test('★ 元判据：JS 分支的标题同样必须替换阈值（不许印占位符）', () => {
  const j = runOn({
    'a.mjs': 'export function f(x) {\n  if (x) {\n    return 1;\n  }\n}\n',
  });
  const k = kiss(j);
  assert.ok(!k.title.includes('{'), `JS 标题不许留占位符，实际: ${k.title}`);
});

// ─────────────────────────────────────────────────────────────
// 4. 混排：JS + py 同时存在时偏向声明近似
// ─────────────────────────────────────────────────────────────

test('★ 混排（JS + py）⇒ 偏保守，声明近似（不能让 py 的虚报冒充控制流嵌套）', () => {
  const j = runOn({
    'a.mjs': 'export const x = 1;\n',
    'b.py': 'y = 1\n',
  });
  const k = kiss(j);
  assert.match(k.title, /缩进近似/, `混排时必须声明近似，实际: ${k.title}`);
});
