// 仓库路径的唯一解析基准（A03 的底座）。
//
// 审计实测的两个旁路：
//   ① `existsProjectFile()` 在 `--repo` 失败时**回落到 cwd**，于是
//      "声明的 src/outside.js 在 repo 下不存在、只在另一个 cwd 下存在" ⇒ DRY-D1 PASS。
//      **验证的是另一个目录的文件。**
//   ② `allowedPrefixes` 用**归一化之前的字符串**做 startsWith：
//      `src/../outside.js` 以 `src/` 开头 ⇒ 越界路径 PASS。
//
// 判据：
//   ① **显式 repo 是唯一解析基准**，不回落 cwd、不回落 change 目录；
//   ② 先做**词法归一**（折叠 `.` / `..` / 分隔符），再判前缀与段边界；
//   ③ 绝对路径与归一后越界的路径**显式拒绝**（给出原因），不静默通过。

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 统一分隔符为 `/`。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 是否"看起来是绝对路径"（POSIX `/`、Windows 盘符、UNC）。 */
export function isAbsoluteLike(p) {
  const s = toPosix(p);
  return s.startsWith('/') || /^[A-Za-z]:\//.test(s) || s.startsWith('//');
}

/**
 * 词法归一：折叠空段/`.`，处理 `..`。
 * **越出根时返回 null** —— 这是"仓库外路径"的可判定信号，不能悄悄钳到根。
 */
export function normalizeRel(p) {
  const out = [];
  for (const seg of toPosix(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/**
 * 把一处"文档/配置里声明的仓库相对路径"解析成归一化相对路径。
 * @returns {{ok:true, rel:string}|{ok:false, reason:string}}
 *
 * 拒绝的三类：绝对路径、归一后越界、空引用。
 * 三类都**给出可读原因**，因为"路径不存在"与"路径不该这么写"是两种修法。
 */
export function resolveRepoRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, reason: '空的路径引用' };
  if (isAbsoluteLike(ref)) return { ok: false, reason: `绝对路径不是仓库内引用: ${ref}` };
  const rel = normalizeRel(ref);
  if (!rel) return { ok: false, reason: `归一化后越出仓库根: ${ref}` };
  return { ok: true, rel };
}

/**
 * 仓库内是否存在该相对路径指向的**文件**。
 * @param {string} repo 唯一解析基准
 * @param {string} rel 已归一化的相对路径
 */
export function repoFileExists(repo, rel) {
  const abs = join(repo, ...rel.split('/'));
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * 路径是否落在某个前缀目录内 —— **段边界感知**，不是字符串前缀。
 *
 * 三个必测边界：
 *   withinPrefix('src/x.js',   'src')    ⇒ true
 *   withinPrefix('srcx/x.js',  'src')    ⇒ false（旧实现 startsWith 会误放行）
 *   withinPrefix('src/../out.js','src')  ⇒ 归一后 'out.js' ⇒ false
 */
export function withinPrefix(rel, prefix) {
  const r = normalizeRel(rel);
  const p = normalizeRel(prefix);
  if (!r || !p) return false;
  return r === p || r.startsWith(p + '/');
}

/** 仓库根是否可读（用于把"标错基准"与"仓库不可读"分开报）。 */
export function repoUsable(repo) {
  if (!repo || typeof repo !== 'string') return { ok: false, reason: '未指定仓库根' };
  if (!existsSync(repo)) return { ok: false, reason: `仓库根不存在: ${toPosix(repo)}` };
  return { ok: true };
}
