#!/usr/bin/env node
/**
 * 从 git 生成 diff 数据，供 `DISCIPLINE-C1`（越界/预算）与 `DISCIPLINE-C3`（文档↔代码绑定）使用。
 *
 * 为什么需要它：没有 diff 时这两条判据都是 **skip**，而 skip 不是通过——
 * 也就是说"越界修改"和"文档说要做 A 但代码做了 B"这两类问题，
 * 在过去是**永远检不出来**的。这个工具把 skip 变成真判。
 *
 * 用法：
 *   node tools/make-diff.mjs --repo . --out diff.json                 # 工作树 vs HEAD（含 untracked）
 *   node tools/make-diff.mjs --repo . --base origin/main --out diff.json
 *   node tools/make-diff.mjs --repo . --staged --out diff.json
 *   node tools/make-diff.mjs --repo . --range HEAD~3..HEAD --out diff.json
 *   node tools/make-diff.mjs --repo . --no-untracked --out diff.json  # 显式排除未跟踪文件
 *
 * 产物格式（ICD §5.1，2026-11-13 扩）：
 *   { "files": [{ "path": "lib/x.mjs", "added": 10, "deleted": 2,
 *                 "renamedFrom": "lib/y.mjs", "untracked": true, "binary": true }],
 *     "total": 12, "binaryCount": 1, "untrackedCount": 2,
 *     "range": "HEAD~3..HEAD"|null, "base": "工作树 vs HEAD", "staged": false,
 *     "untrackedIncluded": true, "generatedAt": "…" }
 *
 * ── 三条边界（A12 修，全部有 test/make-diff.test.mjs 的真仓库正反例）──
 *
 * ① **未跟踪文件**：`git diff HEAD` **看不到**全新文件（它们还没进索引）。
 *    旧实现直接拿它就是"本次工作树所有新增源码"，于是新建未暂存的源码
 *    **完全不进入** DISCIPLINE-C1 的越界判定与行数预算。现在默认纳入
 *    （`git ls-files --others --exclude-standard`），并在产物里用
 *    `untrackedIncluded` 明确声明；要旧语义用 `--no-untracked`。
 *
 * ② **rename**：numstat 对改名输出的是 `{old => new}` 这种**展示用**的折叠路径
 *    （甚至 `a/{b => c}/d` 中段折叠）。原样当路径会得到含 `=>` 的假路径，
 *    于是 allowedPrefixes / CodeScopes 判定**永远不匹配**——越界改名被静默放行。
 *    现在用 `-z` 拿到真实的两段路径，归一成**目标路径**并标注 `renamedFrom`。
 *
 * ③ **binary**：numstat 对二进制输出 `-\t-\tpath`，按 0 行计。
 *    旧实现只标了 `binary:true`，没告诉人"预算里没算这些"。现在给 `binaryCount`。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, openSync, closeSync } from 'node:fs';
import { writableTempRoot } from '../lib/temp.mjs';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { toPosix } from '../lib/paths.mjs';

/**
 * 跑 git 并把 stdout 取回来。
 *
 * ★ **不要加 `shell: true`**（2026-11-12 在真实仓库上踩到）。
 *
 * 带 shell 时参数会先经过 cmd.exe（Windows）/ sh（POSIX）解析，而
 * **`^` 在 cmd 里是转义符**：`--range "HEAD^..HEAD"` 里的 `^` 被吃掉，
 * git 收到的是 `HEAD..HEAD` —— 于是 diff 恒为空、退出码 0、**静默给出空结果**。
 * 这类失败最危险：不报错，只是答案永远是"没有变更"。
 *
 * 不带 shell 时参数以 argv 数组直接传给进程，任何字符都不会被解释。
 *
 * ★ **不捕获 stdout，改用文件描述符 / `--output=<file>` 落盘再读回**（2026-11-13）。
 * 原实现用 `spawnSync(..., { encoding: 'utf8' })` 抓 stdout —— 那是 piped stdio，
 * 在受限沙箱里直接 `EPERM`，于是 make-diff 在沙箱里永远退 2，
 * DISCIPLINE-C1/C3 永远 SKIP。下面两种写法都不建立管道：
 *   · `git diff` 系：原生支持 `--output=<file>`；
 *   · `git ls-files` 系：**不支持** `--output`（实测 `error: unknown option 'output='`），
 *     改成把子进程 stdout 直接指向一个已打开的 fd（`stdio: ['ignore', fd, 'ignore']`）。
 */
function git(repo, args, outFile) {
  // 首选 `--output=<file>`：git 自己写文件，全程无管道。
  const withOutput = spawnSync('git', [...args, `--output=${outFile}`], {
    cwd: repo,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (!withOutput.error && withOutput.status === 0) return readFileSync(outFile, 'utf8');

  // 退路：把子进程 stdout 直接指向已打开的 fd（同样不建管道）。
  // ls-files 之类不认 --output 的子命令走这条。
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync('git', args, { cwd: repo, shell: false, stdio: ['ignore', fd, 'ignore'] });
  } finally {
    closeSync(fd);
  }
  if (r.error) throw new Error(`git 执行失败: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${r.status}`);
  return readFileSync(outFile, 'utf8');
}

/**
 * 解析 `git diff --numstat -z` 的输出。
 *
 * -z 的两种记录形态（实测，Windows git 2.4x）：
 *   · 普通/二进制：`<added>\t<deleted>\t<path>\0`
 *   · 改名/复制：  `<added>\t<deleted>\t\0<oldPath>\0<newPath>\0`
 *     —— 注意第三段是**空**的（路径被移到 NUL 之后单独给两段）。
 *     这就是为什么不能用 `{old => new}` 那种展示格式：它是折叠过的、不可逆的文本。
 *
 * @returns {Array<{path:string, added:number, deleted:number, binary?:true, renamedFrom?:string}>}
 */
export function parseNumstatZ(raw) {
  const files = [];
  const parts = String(raw).split('\u0000');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const m = head.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const added = binary ? 0 : Number(m[1]);
    const deleted = binary ? 0 : Number(m[2]);

    if (m[3] === '') {
      // 改名/复制：紧跟两段路径
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 2;
      if (!to) continue;
      files.push({
        path: toPosix(to),
        added,
        deleted,
        ...(binary ? { binary: true } : {}),
        // ★ 归一成**目标路径**，旧路径只作为标注保留。
        ...(from && from !== to ? { renamedFrom: toPosix(from) } : {}),
      });
    } else {
      files.push({ path: toPosix(m[3]), added, deleted, ...(binary ? { binary: true } : {}) });
    }
  }
  return files;
}

/** 数一个文件的文本行数（untracked 文件没有 numstat，只能自己数）。二进制返回 null。 */
function countLines(absPath) {
  const buf = readFileSync(absPath);
  // 含 NUL 字节即按二进制处理：与 git 的判定同向，且此时"行数"没有意义。
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  if (text === '') return 0;
  // 末尾换行不再额外算一行（与 git numstat 的口径一致）。
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(args.repo && args.repo !== true ? args.repo : '.');
  const out = resolve(args.out && args.out !== true ? args.out : 'diff.json');
  // --no-untracked / --no-untracked true 都能关；默认开（明确声明而不是"碰巧没算"）。
  const untrackedIncluded = !(args['no-untracked'] === true || args['no-untracked'] === 'true' || args['include-untracked'] === false);

  // 选基线与目标：--range 优先，其次 --base，其次 --staged，最后工作树 vs HEAD。
  let gitArgs;
  let label;
  let rangeLabel = null;
  let staged = false;
  if (args.range && args.range !== true) {
    gitArgs = ['diff', '--numstat', '-z', String(args.range)];
    rangeLabel = String(args.range);
    label = rangeLabel;
  } else if (args.base && args.base !== true) {
    gitArgs = ['diff', '--numstat', '-z', String(args.base)];
    label = `vs ${args.base}`;
  } else if (args.staged === true) {
    gitArgs = ['diff', '--numstat', '-z', '--cached'];
    label = 'staged';
    staged = true;
  } else {
    gitArgs = ['diff', '--numstat', '-z', 'HEAD'];
    label = '工作树 vs HEAD';
  }

  const tmpDir = mkdtempSync(join(writableTempRoot(), 'sdd-diff-'));
  const tmpFile = join(tmpDir, 'numstat.bin');
  const untrackedFile = join(tmpDir, 'untracked.bin');
  let raw;
  let untrackedRaw = '';
  try {
    raw = git(repo, gitArgs, tmpFile);
    /**
     * untracked 只在"工作树 vs HEAD"这一模式下补：--staged 讲的是索引，
     * --range 讲的是两个提交之间，两者都没有"未跟踪"这个概念
     * （未跟踪文件不属于任何提交）。硬塞进去会让人以为提交里有这些文件。
     */
    const workspaceMode = !staged && !rangeLabel && !(args.base && args.base !== true);
    if (untrackedIncluded && workspaceMode) {
      untrackedRaw = git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], untrackedFile);
    }
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

  const files = parseNumstatZ(raw);

  // ── 未跟踪文件：numstat 里没有它们，自己数行数并标 untracked ──
  const untrackedList = String(untrackedRaw)
    .split('\u0000')
    .filter((p) => p && p.trim());
  for (const rel of untrackedList) {
    const abs = join(repo, ...toPosix(rel).split('/'));
    let lines;
    try {
      lines = countLines(abs);
    } catch {
      continue; // 读不到（权限/中途被删）就跳过，不编造行数
    }
    const entry = {
      path: toPosix(rel),
      // 二进制无法给行数：按 0 计但**标 binary**，让 binaryCount 把它数进去。
      added: lines ?? 0,
      deleted: 0,
      untracked: true,
      ...(lines === null ? { binary: true } : {}),
    };
    files.push(entry);
  }

  // 防御：同一路径重复（例如既在 numstat 又在 untracked，理论上不该发生）只保留第一条。
  const seen = new Set();
  const deduped = [];
  for (const f of files) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    deduped.push(f);
  }

  const total = deduped.reduce((s, f) => s + f.added + f.deleted, 0);
  const binaryCount = deduped.filter((f) => f.binary === true).length;
  const untrackedCount = deduped.filter((f) => f.untracked === true).length;
  const renamedCount = deduped.filter((f) => f.renamedFrom).length;

  const payload = {
    files: deduped,
    total,
    binaryCount,
    untrackedCount,
    renamedCount,
    // 精确标签：调用方不必再从中文 label 里猜模式（旧产物只有 base 一个自由文本）。
    range: rangeLabel,
    base: label,
    staged,
    untrackedIncluded,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`diff 基线: ${label}${rangeLabel ? `（range）` : staged ? '（staged）' : ''}`);
  console.log(
    `变更文件 ${deduped.length} 个，合计 ${total} 行（+${deduped.reduce((s, f) => s + f.added, 0)} / -${deduped.reduce((s, f) => s + f.deleted, 0)}）`,
  );
  console.log(
    `未跟踪 ${untrackedCount} 个（${untrackedIncluded ? '已纳入' : '已排除'}）· 二进制 ${binaryCount} 个（0 行计入预算）· 改名 ${renamedCount} 个`,
  );
  for (const f of deduped.slice(0, 15)) {
    const flags = [f.untracked ? 'U' : '', f.binary ? 'B' : '', f.renamedFrom ? `R←${f.renamedFrom}` : ''].filter(Boolean).join(' ');
    console.log(`  ${String(f.added).padStart(5)}+ ${String(f.deleted).padStart(5)}-  ${f.path}${flags ? `  [${flags}]` : ''}`);
  }
  if (deduped.length > 15) console.log(`  …另 ${deduped.length - 15} 个`);

  if (!deduped.length) {
    // 空 diff 不是"通过"：没有变更意味着这条 change 还没开始，或基线选错了。
    console.log('');
    console.log('注意：diff 为空。写出的文件里 files=[] —— 判据会按"空集不构成通过"处理，');
    console.log('      不会当成通过。请确认基线（--base / --range）是否选对。');
  }
  console.log(`\n已写出 ${out}`);
}

// 只有直接执行时才跑 main()：这样 test/make-diff.test.mjs 能 import parseNumstatZ 单测解析器。
// 判据用 fileURLToPath 而不是手拼 pathname —— Windows 上 pathname 带前导斜杠，
// 手写正则替换很容易在不同 git-bash/CI 环境下静默失配（那会让工具"什么都不做还退 0"）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

