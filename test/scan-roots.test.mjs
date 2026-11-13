// A06：扫描完整性收据。五种根输入的收据断言。
//
// 这个文件守的是审计 I-04 那一类缺陷：
//
//   `self-check` 的默认根里写了 `cli.mjs` 这个**文件**，而扫描器对每个根做 readdir。
//   文件根抛错被吞 ⇒ 该根贡献 **0** 个文件 ⇒ 整个 CLI 入口从未被代码级规则扫过，
//   而报告只说"扫描 14 个文件"。
//
//   报告里的数字是对的，覆盖的说法是错的。**"我没扫到"与"扫了没问题"症状同形** ——
//   这条判据的全部意义就是让两者不再同形。
//
// 五种输入（缺任何一种都会留下一类静默）：
//   dir        目录根：递归，命中后缀的都算
//   file       文件根：**必须贡献 1 个文件**（旧实现在这里贡献 0）
//   missing    不存在的根：kind=missing + 错误留痕
//   unreadable 不可读的根：kind=dir + 错误留痕（不能静默贡献 0）
//   no-code    目录可读但没有源码：错误留痕 + 与"不可读"可区分
//
// 关于 unreadable 的夹具（2026-11-13 独立复核后重做）：
//
// 原实现只列 Windows 系统目录（`C:\Windows\CSC` 等），在 Ubuntu CI 上一个都不存在，
// 用例要么失败、要么被当成"矩阵尚未跑"——**那其实是跨平台夹具缺陷**，不是环境问题。
//
// 现在的做法：**先用可移植手段自己造一个不可读目录**，造不出来才回落到系统目录：
//   ① POSIX：`chmod 000` 一个自建目录 —— 对非 root 有效。
//   ② Windows：`icacls <dir> /deny <user>:(R)` —— 在普通 token 下有效。
//   ③ 回落：系统上真实存在且确实不可读的目录（Windows 候选 + POSIX 候选）。
// 无论走哪条，**都必须在运行时自证"它真的读不了"**（stat 成功 + readdir 抛错）：
// 两个条件缺一不可，否则会把 missing 当成 unreadable。自证不成立就跳过并显式声明
// UNEXECUTED，绝不悄悄变成恒真。
const UNREADABLE_CANDIDATES = [
  'C:\\Windows\\CSC',
  'C:\\System Volume Information',
  'C:\\Recovery',
  '/root', // POSIX：非 root 用户通常不可读
  '/lost+found',
  '/.Trash', // macOS
];

/** 尝试用可移植手段造一个不可读目录；失败返回 null。 */
function makeUnreadableDir(parent) {
  const dir = join(parent, 'unreadable');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.js'), 'export const x = 1;\n');
  } catch {
    return null;
  }
  const attempts =
    process.platform === 'win32'
      ? [['icacls', [dir, '/deny', `${process.env.USERNAME}:(OI)(CI)(R)`]]]
      : [['chmod', ['000', dir]]];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status !== 0) continue;
    // 自证：stat 成功但 readdir 失败
    try {
      if (!statSync(dir).isDirectory()) continue;
      readdirSync(dir);
      // 仍可读 ⇒ 手段无效（例如以 root 运行）
      continue;
    } catch {
      return dir;
    }
  }
  return null;
}

/**
 * 找一个**实测确实不可读**的目录：stat 成功（路径存在且是目录）但 readdir 抛错。
 * 两个条件缺一不可 —— 只有 readdir 失败也可能是"路径不存在"，那是 missing 不是 unreadable。
 */
function findUnreadableRoot(parent) {
  const made = makeUnreadableDir(parent);
  if (made) return made;
  for (const p of UNREADABLE_CANDIDATES) {
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    try {
      readdirSync(p);
      // 能读 ⇒ 不是我们要的夹具（权限变了），换下一个
    } catch {
      return p;
    }
  }
  return null;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writableTempRoot } from '../lib/temp.mjs';
import { spawnSync } from 'node:child_process';
import { scanCodeRoots } from '../lib/code.mjs';

const TMP_PARENT = writableTempRoot();

function withTemp(fn) {
  const root = mkdtempSync(join(TMP_PARENT, 'scan-roots-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 同上，但把 fn 的返回值带出来（用于"先造夹具、再在临时目录外断言"的用例）。 */
function withTempScoped(fn) {
  const root = mkdtempSync(join(TMP_PARENT, 'scan-roots-'));
  let kept = null;
  try {
    kept = fn(root);
    return kept;
  } finally {
    // 不可读目录在 Windows 下可能删不掉（ACL 拒绝）——清理失败不影响结论
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 造一棵有源码的小树。 */
function makeTree(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(root, 'src', 'notes.md'), '# 不是源码\n');
  mkdirSync(join(root, 'empty-dir'), { recursive: true });
  return root;
}

test('目录根：递归收集源码，且非源码后缀不计入', () => {
  withTemp((root) => {
    makeTree(root);
    const { files, report } = scanCodeRoots([join(root, 'src')]);
    assert.equal(files.length, 2, '两个源码文件必须都进集合');
    assert.equal(report.roots.length, 1);
    assert.equal(report.roots[0].kind, 'dir');
    assert.equal(report.roots[0].files, 2);
    assert.deepEqual(report.roots[0].errors, [], '正常目录根不该有错误留痕');
  });
});

test('文件根：必须贡献 1 个文件（旧实现在这里静默贡献 0 —— 审计 I-04 的原缺陷）', () => {
  withTemp((root) => {
    makeTree(root);
    const target = join(root, 'src', 'a.js');
    const { files, report } = scanCodeRoots([target]);
    // ★ 这是本文件的核心断言
    assert.equal(files.length, 1, '文件根必须真的被扫描，不能贡献 0 个文件');
    assert.equal(files[0], target);
    assert.equal(report.roots[0].kind, 'file');
    assert.equal(report.roots[0].files, 1);
  });
});

test('文件根：后缀不在可扫描集合内 ⇒ 留痕，且不计入文件集合', () => {
  withTemp((root) => {
    makeTree(root);
    const target = join(root, 'src', 'notes.md');
    const { files, report } = scanCodeRoots([target]);
    assert.equal(files.length, 0, '.md 不是源码，不得计入');
    assert.equal(report.roots[0].kind, 'file');
    assert.equal(report.roots[0].files, 0);
    assert.equal(report.roots[0].errors.length, 1, '必须留一条"后缀不支持"的痕');
    assert.match(report.roots[0].errors[0], /后缀不在可扫描集合内/);
  });
});

test('不存在的根：kind=missing 且留痕（不能与"空目录"混为一谈）', () => {
  withTemp((root) => {
    const missing = join(root, 'nope', 'ghost.js');
    const { files, report } = scanCodeRoots([missing]);
    assert.equal(files.length, 0);
    assert.equal(report.roots[0].kind, 'missing');
    assert.equal(report.roots[0].errors.length, 1);
    assert.match(report.roots[0].errors[0], /不可访问/);
    assert.ok(report.errors.length >= 1, '汇总层也必须留痕');
  });
});

test('不可读的根：留痕且与"空目录"可区分', (t) => {
  const target = withTempScoped((root) => findUnreadableRoot(root));
  // ★ 夹具自证（2026-11-13 独立复核后改）：找不到真正读不了的目录时，
  //   本用例**跳过并显式声明未执行**，而不是 assert 失败。
  //   区别在于归因：以 root 运行的容器里 `chmod 000` 不生效，此时红的原因是
  //   **夹具造不出来**，不是被测实现的"不可读留痕"坏了。
  //   但**跳过 ≠ 通过**：node:test 会把它计入 skipped，自检汇总里看得见，
  //   且这里明确打印原因，不会被读成"已验证"。
  if (!target) {
    t.skip('无法构造"stat 成功但 readdir 失败"的目录 ⇒ A06 不可读分支本次未执行（不是通过）');
    return;
  }

  const { files, report } = scanCodeRoots([target]);
  assert.equal(files.length, 0);
  const entry = report.roots[0];
  assert.equal(entry.kind, 'dir', '路径存在且是目录，kind 应为 dir（存在性成立，只是读不了）');
  assert.ok(entry.errors.length > 0, '不可读的根必须留痕，不能静默贡献 0 个文件');
  assert.match(entry.errors.join('\n'), /目录不可读/, `错误信息应说明是"不可读"而不是"没有源码": ${entry.errors.join(' | ')}`);
  assert.ok(
    report.errors.some((e) => e.includes('目录不可读')),
    '汇总 report.errors 里也必须有这条（调用方不一定逐个根遍历）',
  );
});

test('可读但无源码的目录：留痕，且措辞与"不可读"不同', () => {
  withTemp((root) => {
    makeTree(root);
    const { files, report } = scanCodeRoots([join(root, 'empty-dir')]);
    assert.equal(files.length, 0);
    const entry = report.roots[0];
    assert.equal(entry.kind, 'dir');
    assert.match(entry.errors.join('\n'), /没有可扫描的源码文件/);
    assert.doesNotMatch(entry.errors.join('\n'), /目录不可读/, '"空目录"不得被说成"不可读"');
  });
});

test('收据自洽：各根 files 之和 == candidates == scanned == 实际文件数', () => {
  withTemp((root) => {
    makeTree(root);
    // 一个会成功、一个会失败、一个文件根、一个空目录 —— 混合输入
    const roots = [
      join(root, 'src'),
      join(root, 'missing.js'),
      join(root, 'src', 'a.js'),
      join(root, 'empty-dir'),
    ];
    const { files, report } = scanCodeRoots(roots);
    const sum = report.roots.reduce((n, r) => n + r.files, 0);
    assert.equal(report.roots.length, 4, '每个根都要在收据里有一条，失败的也不例外');
    assert.equal(sum, files.length, '各根 files 之和必须等于实际文件数（口径不齐说明有根在偷偷丢文件）');
    // 这两个字段曾经初始化后从未赋值、恒为 0 —— "看着像数据、其实是没测"
    assert.equal(report.candidates, files.length, 'candidates 必须是真值，不能是初始化后的常量 0');
    assert.equal(report.scanned, files.length, 'scanned 必须是真值，不能是初始化后的常量 0');
    assert.ok(Array.isArray(report.excluded), 'excluded 必须存在（逐根解释用）');
  });
});

test('默认根（lib/tools/cli.mjs）：cli.mjs 必须真的进集合', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const roots = ['lib', 'tools', 'cli.mjs'].map((p) => join(ROOT, p));
  const { files, report } = scanCodeRoots(roots);
  const cliInSet = files.some((f) => f.endsWith(`cli.mjs`) && !f.includes(`tools`));
  // ★ 这就是审计 I-04 的原始缺陷：修复前这里恒为 false，而自检照样全绿。
  assert.ok(cliInSet, `cli.mjs 必须是 --code 根且真的被扫描到。收到的 ${files.length} 个文件里没有 cli.mjs`);
  for (const r of report.roots) {
    assert.ok(r.files > 0, `默认根 ${r.root} 贡献了 0 个文件（kind=${r.kind}）—— 默认枚举写错了`);
  }
  assert.equal(report.candidates, files.length);
});

test('负控：把只含非源码的目录当根 ⇒ files=0 且有痕（判据不是恒绿）', () => {
  withTemp((root) => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'x.md'), '#');
    writeFileSync(join(root, 'docs', 'y.json'), '{}');
    const { files, report } = scanCodeRoots([join(root, 'docs')]);
    assert.equal(files.length, 0);
    assert.ok(report.roots[0].errors.length > 0, '没有源码也要留痕，否则"0 个文件"又变成静默');
  });
});
