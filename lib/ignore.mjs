// 扫描面过滤：用 `.gitignore` 判定"哪些文件不属于用户源码"。
//
// ★ 为什么需要单独一个模块，而不是在 code.mjs 里加几个目录名：
//
//   旧实现的 `SKIP_DIRS` 是一张**硬编码黑名单**
//   （`node_modules/.git/dist/build/vendor/venv/.venv/__pycache__/target`）。
//   黑名单的根本缺陷不是"名单不够长"，而是**它把判断权留在了工具里**：
//   每个仓库的构建目录叫什么，只有那个仓库自己知道。
//
//   实测代价（三个独立仓，同一形态）：
//     · Java 仓 `.build` / `.build-archive` ⇒ 308/343 是构建残留，
//       `DRY-C1` 报 55144 处，其中真实源码之间 ≈ 0
//     · Python 仓 `.cache/` ⇒ 3236/3436，贡献 KISS-C1 命中的 96.8%
//     · 本仓 `_work/tmp/*/repo` ⇒ 144/198，全是整仓复制品
//
//   `.gitignore` 是**仓库自己声明的判断**：它已经写明了"哪些不是我要发布的源码"。
//   用它比维护黑名单可靠得多 —— 而且不需要工具去猜。
//
// ★ 纪律一：**git 不可用时不许当成"没有 ignore 规则"而静默放行**。
//   必须把原因写进收据（`reason`），由调用方决定怎么呈现。
//   否则"没过滤"会被读成"过滤后没有命中"，与 A06 同族。
//
// ★ 纪律二：**过滤必须留痕**。
//   收据里要有 `ignored` 桶记录被排除的数量与样例，
//   否则用户看到 `scanned` 变小却不知道少了什么。
//
// ★ 纪律三：**只排除，不判定**。
//   本模块只回答"这个路径是否被 gitignore"，不回答"它是不是坏代码"。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 用 `git check-ignore --stdin` **一次性**判定一批路径。
 *
 * 为什么批量：实测 3400 个路径走 `--stdin` 约 89ms；
 * 逐个起子进程会慢到不可用（3400 × ~30ms ≈ 100 秒）。
 *
 * @param {string} repo 仓库根（`git check-ignore` 在此目录下运行）
 * @param {string[]} paths 绝对路径列表
 * @param {string} scratchDir 临时目录（调用方负责清理）
 * @returns {{ok:true, ignored:Set<string>, sample:string[]}|{ok:false, reason:string}}
 */
export function ignoredPaths(repo, paths, scratchDir) {
  if (!paths.length) return { ok: true, ignored: new Set(), sample: [] };

  // git check-ignore 只接受相对于 cwd 的路径；用绝对路径在 Windows 上会被当作
  // 盘符路径而匹配失败（`F:` 被当成 revision）。所以统一转成相对路径。
  const rels = paths.map((p) => relative(repo, p).split('\\').join('/'));
  const inFile = join(scratchDir, 'ignore-in.txt');
  const outFile = join(scratchDir, 'ignore-out.txt');

  try {
    writeFileSync(inFile, rels.join('\n'), 'utf8');
  } catch (e) {
    return { ok: false, reason: `无法写入 check-ignore 输入: ${e.message}` };
  }

  // 重定向到文件而不是 PIPE：受限沙箱里子进程拿不到命名管道，
  // `stdio:'pipe'` 会得到 `spawn EPERM` + `status:null`（lib/tree.mjs 有同样记录）。
  const cmd = `git check-ignore --stdin < "${inFile}" > "${outFile}" 2>&1`;
  const r = spawnSync(cmd, { cwd: repo, shell: true, stdio: 'inherit' });

  if (r.error) return { ok: false, reason: `git 不可用: ${r.error.message}` };
  // ★ 退出码语义与常规相反：1 = **没有任何路径被忽略**（正常结果），
  //   0 = 有路径被忽略，128 = 致命错误（不是仓库等）。
  //   把 1 当成失败会让"这个仓没有 ignore 规则"被读成"过滤崩了"。
  if (r.status !== 0 && r.status !== 1) {
    return { ok: false, reason: `git check-ignore 退出码 ${r.status}` };
  }

  let text;
  try {
    text = readFileSync(outFile, 'utf8');
  } catch {
    // 退出码 1 时 git 不写输出文件内容，读不到属于正常。
    return { ok: true, ignored: new Set(), sample: [] };
  }

  const ignoredRels = text.split(/\r?\n/).filter((l) => l.trim());
  const ignored = new Set(ignoredRels.map((rel) => resolve(repo, rel)));
  return { ok: true, ignored, sample: ignoredRels.slice(0, 10) };
}
