/**
 * Python import 区排除（2026-11-16，第 ③ 位）。
 *
 * ★ 修的是什么：Python 每个模块开头几乎都有同一套
 *   `from __future__ import annotations` + `import json` + `from dataclasses import …`
 *   + `from datetime import …` + `from pathlib import Path`。
 *   任意两个模块的 import 清单只要有 6 行重合，`DRY-C1` 就报重复 ——
 *   **那不是复制粘贴，是语言惯例**。
 *
 *   实测（一个真实 Python 仓的 `eda_skill`，30 个文件）：`DRY-C1` 报的 4 处
 *   **全部**是「docstring 结尾 + import 块」，没有一处业务代码复制。
 *   ⇒ 该判据在这个仓上**恒红且信息量为零**（恒红 = 判据消失）。
 *
 * ★ 本文件的核心是**负控**：排除 import 区是"减少信号"的操作，
 *   最容易顺手把**业务代码的真重复**也排掉。只测"排除了"会让实现朝"越排越多"漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { duplicateBlocks } from '../lib/code.mjs';

/** 造临时文件，返回路径列表。 */
function makeFiles(entries) {
  const dir = mkdtempSync(join(writableTempRoot(), 'py-import-'));
  const paths = [];
  for (const [name, body] of Object.entries(entries)) {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    paths.push(p);
  }
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 常见的 Python 文件头（import 区），各模块几乎一致。 */
const PY_HEAD = [
  'from __future__ import annotations',
  '',
  'import json',
  'import os',
  'from dataclasses import asdict, dataclass, field',
  'from datetime import UTC, datetime',
  'from pathlib import Path',
].join('\n');

/** 生成 N 行互不相同的业务代码。 */
function biz(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i} = transform(${i})`).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 1. 正控：只有 import 区重复 ⇒ 不报
// ─────────────────────────────────────────────────────────────

test('仅 import 区相同、业务代码不同 ⇒ 一处都不报', () => {
  const ws = makeFiles({
    'a.py': `${PY_HEAD}\n\n${biz('alpha', 10)}\n`,
    'b.py': `${PY_HEAD}\n\n${biz('beta', 10)}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.equal(dups.length, 0, `仅 import 相同的两个文件不该报重复，实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

test('docstring 在 import 之前时，import 区仍被正确识别并排除', () => {
  const doc = '"""Module docstring.\n\nIt spans multiple lines.\n"""\n';
  const ws = makeFiles({
    'a.py': `${doc}${PY_HEAD}\n\n${biz('alpha', 10)}\n`,
    'b.py': `${doc}${PY_HEAD}\n\n${biz('beta', 10)}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.equal(dups.length, 0, `docstring + import 相同也不该报，实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

test('括号续行的 import 整段被排除（尾部名字不算业务代码）', () => {
  const head = [
    'from __future__ import annotations',
    'from a import (',
    '    one,',
    '    two,',
    '    three,',
    '    four,',
    ')',
  ].join('\n');
  const ws = makeFiles({
    'a.py': `${head}\n\n${biz('alpha', 10)}\n`,
    'b.py': `${head}\n\n${biz('beta', 10)}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.equal(dups.length, 0, `括号续行 import 也应整段排除，实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 负控：业务代码的真重复必须仍然报出来（最重要）
// ─────────────────────────────────────────────────────────────

test('★ 负控：业务代码 8 行重复 ⇒ 必须报出来（不许被 import 排除顺手吞掉）', () => {
  const shared = biz('shared', 8);
  const ws = makeFiles({
    'a.py': `${PY_HEAD}\n\n${shared}\n\n${biz('alphaTail', 5)}\n`,
    'b.py': `${PY_HEAD}\n\n${shared}\n\n${biz('betaTail', 5)}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.ok(dups.length >= 1, `业务代码 8 行重复必须被报出，实际 ${dups.length} 处`);
    // 且命中的行号必须落在业务区（import 区之后），不是 import 行
    for (const d of dups) {
      assert.ok(d.a.line > 8, `命中行应落在 import 区之后，实际 a.line=${d.a.line}`);
    }
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：函数体内的局部 import 不被排除（只排文件头部）', () => {
  // 两处函数内的局部 import 块 + 相同的后续业务代码
  const fnBody = [
    'def handler():',
    '    import json',
    '    import os',
    '    from pathlib import Path',
    '    x = Path(".")',
    '    y = json.dumps({})',
    '    z = os.getcwd()',
    '    return x, y, z',
  ].join('\n');
  const ws = makeFiles({
    'a.py': `${fnBody}\n`,
    'b.py': `${fnBody}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.ok(dups.length >= 1, `函数体内的重复（含局部 import）必须被报出，实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：非 .py 文件完全不受 import 排除影响', () => {
  // 同一段 `import ...` 在 JS 里也是 import —— 但 JS 不该被这条规则影响
  const js = ['import a from "a";', 'import b from "b";', 'import c from "c";', 'import d from "d";', 'import e from "e";', 'import f from "f";'].join('\n');
  const ws = makeFiles({
    'a.mjs': `${js}\n`,
    'b.mjs': `${js}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.ok(dups.length >= 1, `JS 的 import 块重复仍应报出（规则只作用于 .py），实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：import 之后紧接的业务代码重复仍被报出（不因相邻而误排）', () => {
  const shared = biz('tight', 8);
  const ws = makeFiles({
    // 没有空行分隔，import 之后立刻是业务代码
    'a.py': `${PY_HEAD}\n${shared}\n`,
    'b.py': `${PY_HEAD}\n${shared}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.ok(dups.length >= 1, `紧邻 import 的业务重复必须被报出，实际 ${dups.length} 处`);
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 元判据
// ─────────────────────────────────────────────────────────────

test('元判据：排除只影响 .py，且不改变窗口大小语义', () => {
  const shared = biz('meta', 12);
  const ws = makeFiles({
    'a.py': `${PY_HEAD}\n\n${shared}\n`,
    'b.py': `${PY_HEAD}\n\n${shared}\n`,
  });
  try {
    const dups = duplicateBlocks(ws.paths, 6, { minChars: 40 });
    assert.equal(dups.length, 1, `12 行业务重复应合为 1 条，实际 ${dups.length} 条`);
    assert.ok(dups[0].span >= 12, `跨度应 ≥12，实际 ${dups[0].span}`);
  } finally {
    ws.cleanup();
  }
});
