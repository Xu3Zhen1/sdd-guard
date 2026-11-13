/**
 * 可写的临时目录（测试与工具的**唯一**临时目录来源）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-11-13 独立复核暴露了一整类"环境假设"缺陷：12 个文件里散着
 * `mkdtempSync(join(tmpdir(), …))`。它在本机三种配置下**行为完全不同**：
 *
 * | 环境 | `tmpdir()` 返回 | 结果 |
 * |---|---|---|
 * | 工作区约定 TMP=项目内 `_work/tmp` | `…/sdd-guard/_work/tmp` | 副本落进 ROOT 内部 ⇒ `cpSync` 报 `Cannot copy … to a subdirectory of self`；且被 `check-publish` 判"本机绝对路径" |
 * | `TMP` 未设（系统默认） | `C:\WINDOWS\temp` | 该目录在本沙箱**不可写** ⇒ `mkdtemp` EPERM ⇒ 测试在**准备夹具**阶段全红 |
 * | 正常 Linux CI | `/tmp` | 可用 |
 *
 * 三者里前两种都会让"判据没被执行"伪装成"判据判定失败"——**症状同形**，
 * 而这正是本项目立身之本要防的形态。所以临时目录不能靠约定，要**实测**。
 *
 * ## 判据
 *
 * 候选按顺序**实测**：`mkdir -p` 成功**且**能在其中 `mkdtemp` 一个 probe 再删掉，
 * 才算可用。只测 `mkdir` 不够（某些 ACL 允许建目录但不允许往里写）。
 *
 * 顺序刻意**先项目周边、后系统 tmp**：沙箱与 CI 通常允许写工作区，
 * 而系统临时目录可能被禁。反过来排会让这个工具在干净环境下不可用。
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

/** 仓库根（本文件在 `<root>/lib/` 下）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 返回一个**实测可写**的临时父目录（绝对路径）。
 *
 * @param {{inside?: boolean, avoidRepo?: boolean, preferSibling?: boolean}} [opts]
 *   `inside: true` 时**允许**落在仓库内（默认也允许——只是候选顺序不同）：
 *   只有需要"绝对不能是 ROOT 子目录"的场景（如整仓复制）才必须传 `inside: false` 语义。
 *   这里用 `avoidRoot` 更直白，故不设 `inside`；见下。
 * @param {boolean} [avoidRoot] 若为 true，**跳过**任何位于仓库内的候选。
 *   整仓 `cpSync(ROOT, dst)` 必须用它，否则会复制进自己的子目录。
 * @param {string} [prefix] 建 probe 时用的前缀（仅用于排错时辨认来源）。
 * @returns {string}
 */
export function writableTempRoot(avoidRoot = false, prefix = 'probe-') {
  const root = ROOT;
  const candidates = [
    join(dirname(root), '.sdd-guard-tmp'), // 兄弟目录：仓库外、通常可写
    tmpdir(), // 系统临时目录
    join(homedir(), '.sdd-guard-tmp'),
    join(resolve(root).split(':')[0] + ':', 'sdd-guard-tmp'), // 盘根（Windows）
  ];
  const tried = [];
  for (const p of candidates) {
    tried.push(p);
    if (avoidRoot && isInside(p, root)) continue;
    try {
      mkdirSync(p, { recursive: true });
      const probe = mkdtempSync(join(p, prefix));
      rmSync(probe, { recursive: true, force: true });
      return p;
    } catch {
      /* 下一个候选 */
    }
  }
  throw new Error(`找不到可写的临时目录（已试：${tried.join(' / ')}）`);
}

/** `child` 是否等于 `parent` 或在其内部（大小写不敏感，跨平台安全）。 */
export function isInside(child, parent) {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + (process.platform === 'win32' ? '\\' : '/'));
}

/** 仓库根（供测试计算相对路径）。 */
export const REPO_ROOT = ROOT;

/**
 * 建一个临时目录并保证清理。
 *
 * 用法：`await withTempSync((dir) => { … })`，返回 fn 的返回值。
 * 清理失败不抛（Windows 下 ACL 拒绝删除是正常现象），但不吞掉 fn 的错误。
 */
export function withTempSync(fn, prefix = 'tmp-', avoidRoot = false) {
  const dir = mkdtempSync(join(writableTempRoot(avoidRoot, prefix), prefix));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
