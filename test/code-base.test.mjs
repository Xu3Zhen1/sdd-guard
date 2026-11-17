/**
 * `--code` 的解析基准（2026-11-18）。
 *
 * ★ 为什么需要这一层（真实外仓库采纳时暴露，属"不报错但给错结论"）：
 *   旧实现对 `--code` 一律 `resolve(p)` —— **相对于 cwd**。
 *   于是下面这条命令会扫错仓库：
 *
 *     cd sdd-guard
 *     node cli.mjs check --repo ../dsh-session-compat --code . --json
 *
 *   `--code .` 被解析成 **sdd-guard 自己**，结果是：
 *     · ARCH-06 报「实检 206 个文件」，而目标仓库只有 76 个 .js
 *     · 报告里"未检查"的文件是 `sdd-guard/lib/rules.mjs`
 *   **全程零报错**，只有结论是错的。
 *
 *   这比"路径不存在直接报错"严重得多：使用者会拿这份报告当成目标仓库的体检结果。
 *
 * 判据：
 *   ① 给了 `--repo` 时，相对 `--code` 应相对 repo 解析（存在才采纳）
 *   ② 绝对路径不受影响
 *   ③ 相对 repo 不存在时退回 cwd（向后兼容既有用法）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/temp.mjs';

const CLI = join(REPO_ROOT, 'cli.mjs');

/** 建一个假仓库：<root>/src/a.js + <root>/other/b.js */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'codebase-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const a = 1;\n');
  writeFileSync(join(root, 'other', 'b.js'), 'const b = 2;\n');
  return root;
}

/** 跑 CLI 并把 JSON 报告解析回来（经文件，避免 stdout 编码问题）。 */
function runJson(args) {
  const out = join(tmpdir(), `gb-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  spawnSync(`"${process.execPath}" "${CLI}" ${args} --json > "${out}" 2>&1`, {
    cwd: REPO_ROOT, shell: true, stdio: 'inherit',
  });
  try {
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(out, { force: true });
  }
}

test('★★★ 命脉：`--repo <别处> --code .` 必须扫 repo，不许扫 cwd', () => {
  const repo = makeRepo();
  const change = mkdtempSync(join(tmpdir(), 'chg-'));
  writeFileSync(join(change, 'tasks.md'), '# t\n\n- [ ] T1\n');
  try {
    const j = runJson(`check --change "${change}" --repo "${repo}" --code .`);
    const arch = j.results.find((r) => r.id === 'ARCH-06');
    const detail = arch.detail || arch.reason || '';
    // 假仓库只有 2 个 .js，绝不可能是 sdd-guard 的几十上百个
    assert.match(detail, /实检 \d+ 个/, `detail 应含"实检 N 个"，实际: ${detail}`);
    const n = Number(detail.match(/实检 (\d+) 个/)[1]);
    assert.ok(n <= 2,
      `"--code ." 应只扫到假仓库的 2 个文件，实际 ${n} —— 说明它解析到了 cwd（sdd-guard 自己）`);
    assert.ok(!detail.includes(REPO_ROOT.replace(/\\/g, '/')),
      `报告里不该出现 sdd-guard 自己的路径，实际: ${detail}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(change, { recursive: true, force: true });
  }
});

test('★ `--code src`（相对 repo 的子目录）应解析到 repo 下的 src', () => {
  const repo = makeRepo();
  const change = mkdtempSync(join(tmpdir(), 'chg-'));
  writeFileSync(join(change, 'tasks.md'), '# t\n\n- [ ] T1\n');
  try {
    const j = runJson(`check --change "${change}" --repo "${repo}" --code src`);
    const arch = j.results.find((r) => r.id === 'ARCH-06');
    const detail = arch.detail || arch.reason || '';
    const n = Number((detail.match(/实检 (\d+) 个/) || [0, 0])[1]);
    assert.equal(n, 1, `repo/src 只有 1 个 .js，实际实检 ${n}：${detail}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(change, { recursive: true, force: true });
  }
});

test('★ 绝对路径 `--code` 不受 repo 影响（不能被 repo 前缀二次拼接）', () => {
  const repo = makeRepo();
  const abs = resolve(repo, 'other');
  const change = mkdtempSync(join(tmpdir(), 'chg-'));
  writeFileSync(join(change, 'tasks.md'), '# t\n\n- [ ] T1\n');
  try {
    assert.ok(existsSync(join(abs, 'b.js')), '夹具自证：绝对路径下确实有 b.js');
    const j = runJson(`check --change "${change}" --repo "${repo}" --code "${abs}"`);
    const arch = j.results.find((r) => r.id === 'ARCH-06');
    const detail = arch.detail || arch.reason || '';
    const n = Number((detail.match(/实检 (\d+) 个/) || [0, 0])[1]);
    assert.equal(n, 1, `绝对路径 other/ 只有 1 个 .js，实际实检 ${n}：${detail}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(change, { recursive: true, force: true });
  }
});
