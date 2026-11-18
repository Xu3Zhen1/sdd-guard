/**
 * 「其他项目如何调用本工具」—— 分发包路径的回归（2026-11-18）。
 *
 * ★ 为什么需要这一层（实测暴露，属**最坏失败形态**）：
 *   `package.json` 声明了 `bin: { "sdd-guard": "cli.mjs" }`，所以其他项目的
 *   正常用法是 `npm install <本仓库>` 或 `npm link`，然后 `npx sdd-guard`。
 *
 *   实测：`npm install file:<本仓库>` 在 Windows 上建的是 **Junction**，于是
 *     process.argv[1] = C:\…\node_modules\sdd-guard\cli.mjs   （联接路径）
 *     import.meta.url = F:\…\sdd-guard\cli.mjs                （真实路径）
 *
 *   旧判据用 `resolve()` 比较 —— `resolve()` **不解析符号链接** ⇒ 永不相等
 *   ⇒ `isMain=false` ⇒ `main()` 不执行 ⇒ **零输出、零报错、退出码 0**。
 *
 *   使用者会把它当成"检查通过"，而实际上是"检查没跑"。
 *   这类"看起来成功、其实没做"正是本工具存在的理由所要反对的。
 *
 * 判据（两条缺一不可）：
 *   ① 经由**符号链接/联接**路径调用时，必须真正执行（有输出）
 *   ② 正常路径调用仍必须执行（不能为了修 ① 把 ② 弄坏）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/temp.mjs';

const CLI = join(REPO_ROOT, 'cli.mjs');

/** 跑 CLI，返回 `{status, out}`（out 为合并后的文本）。 */
function run(cliPath, args, cwd) {
  const r = spawnSync(`"${process.execPath}" "${cliPath}" ${args} 2>&1`, {
    cwd: cwd || REPO_ROOT, shell: true, encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout || '' };
}

/** 建一个最小可运行场景：change 目录 + 一个源文件。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dist-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'x.js'), 'const a = 1;\n');
  mkdirSync(join(root, 'changes', 'demo'), { recursive: true });
  writeFileSync(join(root, 'changes', 'demo', 'tasks.md'), '# t\n\n- [ ] src/x.js\n');
  return root;
}

test('★★ 命脉：正常路径调用必须真正执行（有输出）', () => {
  const root = fixture();
  try {
    const { status, out } = run(CLI, `check --change "${join(root, 'changes', 'demo')}" --repo "${root}" --code src`, root);
    assert.ok(out.trim().length > 0,
      `正常调用不该零输出（那意味着 main() 没执行），status=${status}`);
    assert.match(out, /sdd-guard @/, `应打印报告头，实际: ${out.slice(0, 120)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('★★★ 命脉：经由符号链接/联接路径调用，必须真正执行（旧实现在此零输出）', () => {
  const root = fixture();
  const linkParent = mkdtempSync(join(tmpdir(), 'lnk-'));
  const link = join(linkParent, 'sdd-guard-linked');
  try {
    // Windows 上做目录联接需要权限；用 junction 类型（Node 支持）
    symlinkSync(REPO_ROOT, link, 'junction');
    // 夹具自证：该路径确实是链接，且真实路径不同
    assert.notEqual(realpathSync(link), link, '夹具自证：链接必须解析到不同路径');

    const linkedCli = join(link, 'cli.mjs');
    const { status, out } = run(linkedCli, `check --change "${join(root, 'changes', 'demo')}" --repo "${root}" --code src`, root);
    assert.ok(out.trim().length > 0,
      `经链接路径调用时零输出 —— main() 没执行（isMain 判定用了不解析链接的 resolve）；status=${status}`);
    assert.match(out, /sdd-guard @/, `经链接也要打印报告头，实际: ${out.slice(0, 120)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test('★ `--help` 经链接路径也必须输出（帮助不能静默消失）', () => {
  const linkParent = mkdtempSync(join(tmpdir(), 'lnk-'));
  const link = join(linkParent, 'sg');
  try {
    symlinkSync(REPO_ROOT, link, 'junction');
    const { out } = run(join(link, 'cli.mjs'), '--help', linkParent);
    assert.match(out, /用法|usage/i, `--help 必须打印用法，实际: ${out.slice(0, 120)}`);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test('元判据：isMain 判定必须走 realpath（不能退回只比 resolve）', () => {
  const src = readTextCli();
  assert.match(src, /realpathSync/, 'isMain 判定必须解析符号链接，否则经链接调用会静默不执行');
  // 反向：不得出现"只用 resolve 比较"的旧写法
  assert.ok(!/isMain\s*=\s*process\.argv\[1\]\s*&&\s*resolve\(process\.argv\[1\]\)\s*===/.test(src),
    '不得退回「resolve 直接比较」的旧实现');
});

/** 读 cli.mjs 源码（元判据用）。 */
function readTextCli() {
  return readFileSync(CLI, 'utf8');
}