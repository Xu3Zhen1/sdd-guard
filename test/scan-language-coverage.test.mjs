/**
 * 扫描面对账（2026-11-22 · 公开仓语料实测）。
 *
 * ★ 缺陷形态（本机实测，全部公开仓库、`--depth 1`）：
 *   · `laravel/framework`：**3,205 个 .php** → 扫描 **3 个 .js**（docs 里的脚本）
 *     ⇒ `KISS-C1` **pass**「扫描 3 个文件，无超限」，**exit 0**，`warnings` 空。
 *   · `Newtonsoft.Json`：**951 个 .cs** → 扫描 **0** ⇒ 两条判据都 skip。
 *   · `nlohmann/json`：524 个 `.cpp` + 109 个 `.hpp` → 扫描 40 个（29 py + 9 js + …）。
 *
 *   根因不是"某条判据写错"，而是**两套互相矛盾的语言名单**：
 *     `code.mjs` 的 `CODE_EXT`（决定扫谁）  = js/ts/py/go/rs/java  ← 10 个
 *     `arch.mjs` 的 `STRUCTURAL_EXT`（决定谁能做结构判定） = 上面 10 个 + c/cpp/h/hpp/cs/kt/swift/php
 *   ⇒ 后者支持的语言，前者根本不交给它。而且 **0 个可扫描文件时一句告警都没有**。
 *
 * 判据：**"支持什么语言"只能有一张表**；两张表迟早会对不上，而对不上的后果是静默假绿。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writableTempRoot } from '../lib/temp.mjs';
import { CODE_EXT, scanCodeRoots } from '../lib/code.mjs';
import { STRUCTURAL_EXT } from '../lib/arch.mjs';

/** 造一个只有指定后缀文件的临时仓。 */
function repoWith(exts) {
  const dir = mkdtempSync(join(writableTempRoot(), 'scan-ext-'));
  exts.forEach((e, i) => writeFileSync(join(dir, `f${i}${e}`), 'x\n', 'utf8'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('★ 元判据：CODE_EXT 必须覆盖 STRUCTURAL_EXT（支持结构判定的语言必须能被扫到）', () => {
  const missing = STRUCTURAL_EXT.filter((e) => !CODE_EXT.has(e));
  assert.deepEqual(missing, [],
    `这些后缀声明了支持结构判定，却不在 CODE_EXT 里 ⇒ 扫描器永远不会交给判据: ${JSON.stringify(missing)}`);
});

test('元判据：两份语言名单必须由同一张真源派生（不许各写一份字面量）', () => {
  const codeSrc = readFileSync(new URL('../lib/code.mjs', import.meta.url), 'utf8');
  const archSrc = readFileSync(new URL('../lib/arch.mjs', import.meta.url), 'utf8');
  assert.match(archSrc, /from '\.\/languages\.mjs'/, 'arch.mjs 必须从 languages.mjs 取语言集合');
  assert.doesNotMatch(codeSrc, /CODE_EXT\s*=\s*new Set\(\[/,
    'CODE_EXT 不得再写字面量数组 —— 真源在 languages.mjs');
  assert.doesNotMatch(archSrc, /STRUCTURAL_EXT\s*=\s*\[/,
    'STRUCTURAL_EXT 不得再写字面量数组 —— 真源在 languages.mjs');
});

test('★ 负控：只有 .php 的目录必须被扫到（旧实现在这里扫 0 个并静默通过）', () => {
  const r = repoWith(['.php', '.php', '.php']);
  try {
    const { files } = scanCodeRoots([r.dir], { repo: null });
    assert.equal(files.length, 3, `只有 .php 的目录应扫到 3 个文件，实际 ${files.length}`);
  } finally { r.cleanup(); }
});

test('★ 负控：.cs / .kt / .swift / .rb 也必须被扫到', () => {
  const exts = ['.cs', '.kt', '.swift', '.rb', '.c', '.h', '.hpp'];
  const r = repoWith(exts);
  try {
    const { files } = scanCodeRoots([r.dir], { repo: null });
    assert.equal(files.length, exts.length, `期望 ${exts.length} 个，实际 ${files.length}`);
  } finally { r.cleanup(); }
});

test('★ 负控：一个源码文件都没扫到时，收据必须说明"为什么"', () => {
  const dir = mkdtempSync(join(writableTempRoot(), 'scan-none-'));
  writeFileSync(join(dir, 'readme.md'), 'x', 'utf8');
  try {
    const { files, report } = scanCodeRoots([dir], { repo: null });
    assert.equal(files.length, 0);
    assert.ok(report.zeroScan, '必须给出 zeroScan 收据（否则 0 个文件与"没问题"不可区分）');
    assert.ok(report.zeroScan.extensions.length > 0, '必须说明支持哪些后缀');
    assert.ok(report.zeroScan.otherExtensions.length > 0, '必须说明目录里实际有哪些后缀');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});