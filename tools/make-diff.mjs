#!/usr/bin/env node
/**
 * 从 git 生成 diff 数据，供 `DISCIPLINE-C1`（越界/预算）与 `DISCIPLINE-C3`（文档↔代码绑定）使用。
 *
 * 为什么需要它：没有 diff 时这两条判据都是 **skip**，而 skip 不是通过——
 * 也就是说"越界修改"和"文档说要做 A 但代码做了 B"这两类问题，
 * 在过去是**永远检不出来**的。这个工具把 skip 变成真判。
 *
 * 用法：
 *   node tools/make-diff.mjs --repo . --out diff.json                 # 工作树 vs HEAD
 *   node tools/make-diff.mjs --repo . --base origin/main --out diff.json
 *   node tools/make-diff.mjs --repo . --staged --out diff.json
 *   node tools/make-diff.mjs --repo . --range HEAD~3..HEAD --out diff.json
 *
 * 产物格式（ICD §5.1）：
 *   { "files": [{ "path": "lib/x.mjs", "added": 10, "deleted": 2 }], "total": 12 }
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { parseArgs } from '../lib/args.mjs';

/**
 * 执行 git。
 *
 * ★ **不要加 `shell: true`**（2026-11-12 在真实仓库上踩到）。
 *
 * 带 shell 时参数会先经过 cmd.exe（Windows）/ sh（POSIX）解析，而
 * **`^` 在 cmd 里是转义符**：`--range "HEAD^..HEAD"` 里的 `^` 被吃掉，
 * git 收到的是 `HEAD..HEAD` —— 于是 diff 恒为空、退出码 0、**静默给出空结果**。
 * 这类失败最危险：不报错，只是答案永远是"没有变更"。
 *
 * 不带 shell 时参数以 argv 数组直接传给进程，任何字符都不会被解释。
 * 这也是为什么本函数签名收的是数组而不是命令字符串。
 */
/**
 * 跑 git 并把 stdout 取回来。
 *
 * ★ **不捕获 stdout，改用 `git --output=<file>` 落盘再读回**（2026-11-13 实测）。
 *
 * 原实现用 `spawnSync(..., { encoding: 'utf8' })` 抓 stdout —— 那是 piped stdio。
 * 在受限沙箱里 piped stdio 会直接 EPERM：
 *
 *     git 执行失败: spawnSync git EPERM
 *
 * 于是 `make-diff` 在任何沙箱化环境里**永远退 2**，而它正是
 * `DISCIPLINE-C1`/`C3` 的唯一 diff 来源 ⇒ 这两条判据在沙箱里永远 SKIP。
 *
 * 修法：`git diff` 原生支持 `--output=<file>`，把结果直接写文件，
 * 全程不经过管道。保留 `shell: false`（不要 shell —— 见上方 `^` 被吃掉的历史缺陷）。
 *
 * 注意 `--output` 必须放在子命令之后、且 git 只在部分子命令支持它，
 * 因此这里按需追加，而不是无条件加。
 */
function git(repo, args, tmpFile) {
  const full = tmpFile ? [...args, `--output=${tmpFile}`] : args;
  const r = spawnSync('git', full, {
    cwd: repo,
    shell: false,
    stdio: 'inherit',
  });
  if (r.error) throw new Error(`git 执行失败: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${r.status}`);
  if (!tmpFile) return '';
  return readFileSync(tmpFile, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(args.repo && args.repo !== true ? args.repo : '.');
  const out = resolve(args.out && args.out !== true ? args.out : 'diff.json');

  // 选基线与目标：--range 优先，其次 --base，其次 --staged，最后工作树 vs HEAD。
  let gitArgs;
  let label;
  if (args.range && args.range !== true) {
    gitArgs = ['diff', '--numstat', String(args.range)];
    label = String(args.range);
  } else if (args.base && args.base !== true) {
    gitArgs = ['diff', '--numstat', String(args.base)];
    label = `vs ${args.base}`;
  } else if (args.staged === true) {
    gitArgs = ['diff', '--numstat', '--cached'];
    label = 'staged';
  } else {
    gitArgs = ['diff', '--numstat', 'HEAD'];
    label = '工作树 vs HEAD';
  }

  let raw;
  const tmpDir = mkdtempSync(join(tmpdir(), 'sdd-diff-'));
  const tmpFile = join(tmpDir, 'numstat.txt');
  try {
    raw = git(repo, gitArgs, tmpFile);
  } catch (e) {
    console.error(String(e.message));
    console.error('');
    console.error('提示：若仓库还没有提交，先 `git add -A && git commit -m init`，或用 --range 指定基线。');
    process.exit(2);
  } finally {
    // 临时目录必须清掉：它落在系统 tmp 下，失败了也不该留垃圾。
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }

  const files = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // numstat 格式：<added>\t<deleted>\t<path>
    // 二进制文件是 "-\t-\t<path>"，按 0 处理但要标出来。
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    files.push({
      path: m[3].replace(/\\/g, '/'),
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      ...(binary ? { binary: true } : {}),
    });
  }

  const total = files.reduce((s, f) => s + f.added + f.deleted, 0);
  const payload = { files, total, base: label, generatedAt: new Date().toISOString() };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`diff 基线: ${label}`);
  console.log(`变更文件 ${files.length} 个，合计 ${total} 行（+${files.reduce((s, f) => s + f.added, 0)} / -${files.reduce((s, f) => s + f.deleted, 0)}）`);
  for (const f of files.slice(0, 15)) console.log(`  ${String(f.added).padStart(5)}+ ${String(f.deleted).padStart(5)}-  ${f.path}`);
  if (files.length > 15) console.log(`  …另 ${files.length - 15} 个`);

  if (!files.length) {
    // 空 diff 不是"通过"：没有变更意味着这条 change 还没开始，或基线选错了。
    console.log('');
    console.log('注意：diff 为空。写出的文件里 files=[] —— 判据会按"空集不构成通过"处理，');
    console.log('      不会当成通过。请确认基线（--base / --range）是否选对。');
  }
  console.log(`\n已写出 ${out}`);
}

main();
