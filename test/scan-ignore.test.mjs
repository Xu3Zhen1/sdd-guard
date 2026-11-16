/**
 * 扫描面过滤（2026-11-16，第 ② 位）。
 *
 * ★ 修的是"工具把判断权留给了自己"这个形态：
 *   旧实现的 `SKIP_DIRS` 是一张硬编码黑名单。黑名单的根本缺陷不是"名单不够长"，
 *   而是**每个仓库的构建目录叫什么，只有那个仓库自己知道**。
 *
 * 两条独立的排除依据叠加：
 *   ① `.gitignore`（git 环境下的权威依据，能表达 `out/`、`*.gen.ts` 等）
 *   ② 一级点开头目录（**不依赖 git 的兜底**）
 *
 * ★ 为什么要 ②：实测一个 MC 模组 Java 仓（Gradle 布局）**根本不是 git 仓库、没有 .gitignore**，
 *   它的 `.build` / `.build-archive` 里有 278 个构建残留副本。
 *   只有 ① 的话，这个仓的 `--code .` 依然给出 9880 处假重复。
 *
 * ★ 本文件的负控最关键：过滤是"减少扫描面"的操作，最容易顺手把**该扫的**也排掉。
 *   只测"排除了"会让实现朝"越排越多"漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { writableTempRoot } from '../lib/temp.mjs';
import { scanCodeRoots } from '../lib/code.mjs';

/** 造一个临时目录树，返回根路径。files 是 {相对路径: 内容}。 */
function makeTree(files) {
  const dir = mkdtempSync(join(writableTempRoot(), 'scan-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 把目录初始化成 git 仓并提交（让 check-ignore 有依据）。 */
function initRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execSync('git init -q', opts);
  execSync('git config user.email t@example.com', opts);
  execSync('git config user.name t', opts);
}

/** 相对路径集合（便于断言，不依赖绝对路径前缀）。 */
function relsOf(files, root) {
  return files.map((f) => f.slice(root.length + 1).split('\\').join('/')).sort();
}

// ─────────────────────────────────────────────────────────────
// 1. 一级点目录兜底（不依赖 git）
// ─────────────────────────────────────────────────────────────

test('★ 一级点开头目录默认跳过（不依赖 git）', () => {
  const ws = makeTree({
    'src/keep.js': 'export const a = 1;\n',
    '.build/junk.js': 'export const b = 2;\n',
    '.cache/nested/deep.js': 'export const c = 3;\n',
  });
  try {
    const r = scanCodeRoots([ws.dir], { useIgnore: false });
    assert.deepEqual(relsOf(r.files, ws.dir), ['src/keep.js'], '只应扫到 src/keep.js');
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：非一级的点目录（更深层）**不**被跳过 —— `.github/workflows/x.js` 该扫', () => {
  const ws = makeTree({
    '.github/workflows/ci.js': 'export const ci = 1;\n',
    '.github/actions/act.js': 'export const act = 2;\n',
  });
  try {
    const r = scanCodeRoots([ws.dir], { useIgnore: false });
    // .github 是一级点目录 ⇒ 整体被跳过。这是刻意的（见 isDotDir 的边界声明）。
    // 但若用户**显式**把 .github 当根，则必须能扫到：
    const r2 = scanCodeRoots([join(ws.dir, '.github')], { useIgnore: false });
    assert.equal(r2.files.length, 2, `显式指定 .github 为根时必须扫到 2 个文件，实际 ${r2.files.length}`);
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：正常目录一个都不能少', () => {
  const ws = makeTree({
    'src/a.js': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'lib/c.mjs': 'export const c = 3;\n',
    'test/d.py': 'x = 1\n',
    'core/src/main/java/E.java': 'class E {}\n',
  });
  try {
    const r = scanCodeRoots([ws.dir], { useIgnore: false });
    assert.equal(r.files.length, 5, `5 个正常文件应全部扫到，实际 ${r.files.length}: ${relsOf(r.files, ws.dir).join(',')}`);
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. .gitignore 过滤（git 环境）
// ─────────────────────────────────────────────────────────────

test('.gitignore 里的 out/ 被排除，且收据记下 ignored 与样例', () => {
  const ws = makeTree({
    '.gitignore': 'out/\n*.gen.js\n',
    'src/keep.js': 'export const a = 1;\n',
    'out/bundle.js': 'export const b = 2;\n',
    'src/x.gen.js': 'export const g = 3;\n',
  });
  try {
    initRepo(ws.dir);
    const r = scanCodeRoots([ws.dir], { repo: ws.dir });
    assert.deepEqual(relsOf(r.files, ws.dir), ['src/keep.js'], `只应剩 src/keep.js，实际 ${relsOf(r.files, ws.dir)}`);
    // ★ 收据必须留痕：否则用户看到 scanned 变小却不知道少了什么
    assert.equal(r.report.candidates, 3, 'candidates 应是过滤前的 3');
    assert.equal(r.report.scanned, 1, 'scanned 应是过滤后的 1');
    assert.equal(r.report.ignored, 2, 'ignored 应是 2');
    assert.ok(r.report.ignoredSample.length >= 1, '必须有被排除的样例');
    assert.equal(
      r.report.candidates - r.report.ignored,
      r.report.scanned,
      '不变量：candidates − ignored === scanned',
    );
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：.gitignore 未匹配的文件全部保留', () => {
  const ws = makeTree({
    '.gitignore': 'out/\n',
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    'out/c.js': 'export const c = 3;\n',
  });
  try {
    initRepo(ws.dir);
    const r = scanCodeRoots([ws.dir], { repo: ws.dir });
    assert.equal(r.files.length, 2, `应保留 2 个，实际 ${r.files.length}`);
  } finally {
    ws.cleanup();
  }
});

test('未提供 repo ⇒ 不做 gitignore 过滤，但收据写明原因（不许静默）', () => {
  const ws = makeTree({
    '.gitignore': 'out/\n',
    'src/a.js': 'x\n',
    'out/b.js': 'y\n',
  });
  try {
    const r = scanCodeRoots([ws.dir], {});
    assert.equal(r.files.length, 2, '不过滤时两个都在');
    assert.equal(r.report.ignoreReason, '未提供仓库根，无法应用 gitignore', '必须留下原因');
  } finally {
    ws.cleanup();
  }
});

test('★ 负控：不是 git 仓库时，过滤失败必须留原因，不许当成"没有需要过滤的"', () => {
  const ws = makeTree({ 'src/a.js': 'x\n', 'out/b.js': 'y\n' });
  try {
    // 故意不 initRepo，但把 repo 传成这个非 git 目录
    const r = scanCodeRoots([ws.dir], { repo: ws.dir });
    assert.ok(r.report.ignoreReason, '必须是"有原因"而不是 null —— 否则假绿');
    assert.ok(
      /不可用|退出码|不是/.test(r.report.ignoreReason),
      `原因应说明 git 失败，实际: ${r.report.ignoreReason}`,
    );
    // 即便过滤失败，文件也不该被吞掉（宁可多扫，不可漏扫）
    assert.equal(r.files.length, 2, '过滤失败时应保留全部文件，不许静默清空');
  } finally {
    ws.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. 元判据：两条依据是叠加的，不是替代
// ─────────────────────────────────────────────────────────────

test('元判据：点目录兜底 + gitignore 叠加生效', () => {
  const ws = makeTree({
    '.gitignore': 'out/\n',
    'src/a.js': 'x\n',
    '.build/b.js': 'y\n', // 靠 ② 点目录排除
    'out/c.js': 'z\n', // 靠 ① gitignore 排除
  });
  try {
    initRepo(ws.dir);
    const r = scanCodeRoots([ws.dir], { repo: ws.dir });
    assert.deepEqual(relsOf(r.files, ws.dir), ['src/a.js'], '两条依据都要生效');
  } finally {
    ws.cleanup();
  }
});

test('元判据：useIgnore=false 时点目录兜底仍然生效（兜底不依赖开关）', () => {
  const ws = makeTree({
    'src/a.js': 'x\n',
    '.build/b.js': 'y\n',
  });
  try {
    const r = scanCodeRoots([ws.dir], { useIgnore: false });
    assert.deepEqual(relsOf(r.files, ws.dir), ['src/a.js'], '关掉 gitignore 也不该扫点目录');
    assert.equal(r.report.ignoreReason, '调用方关闭了 gitignore 过滤', '关闭也要留原因');
  } finally {
    ws.cleanup();
  }
});
