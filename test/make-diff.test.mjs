// make-diff 的边界行为测试（A12）。
//
// 为什么必须用**真实临时 git 仓库**而不是手写 numstat 文本：
// 本工具的价值全在"git 到底吐什么"，手写夹具会把真实格式（尤其 -z 下
// rename 的 `<n>\t<n>\t\0<old>\0<new>\0` 这种三段式）掩盖掉，
// 判据于是永远绿。这里每个用例都 `git init` + 真 commit + 真改动。
//
// 纪律：所有子进程 **禁止 PIPE 捕获**（本机沙箱里 piped stdio 直接 EPERM）。
// 本文件只 spawnSync 我们自己的工具，且 `stdio: 'ignore'`，输出落在临时文件里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { writableTempRoot } from '../lib/temp.mjs';
import { join, dirname, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNumstatZ } from '../tools/make-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TOOL = join(ROOT, 'tools/make-diff.mjs');

/** 跑 git（stdio 全 ignore —— 绝不用管道捕获）。 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (r.error) throw new Error(`git 不可用: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${r.status}`);
  return r;
}

/** 跑 make-diff，返回解析后的 payload。 */
function runDiff(repo, extraArgs = []) {
  const out = join(repo, '.diff-out.json');
  const log = join(repo, '.diff-log.txt');
  const r = spawnSync(process.execPath, [TOOL, '--repo', repo, '--out', out, ...extraArgs], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  if (r.error) throw new Error(`无法启动 make-diff: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = (() => {
      try { return readFileSync(log, 'utf8').slice(-400); } catch { return '(无日志)'; }
    })();
    throw new Error(`make-diff 退出码 ${r.status} ${tail}`);
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}

const TMP_PARENT = writableTempRoot();

/** 建一个已提交的临时仓库；返回 {dir, cleanup}。 */
function makeRepo() {
  const dir = mkdtempSync(join(TMP_PARENT, 'sdd-mkdiff-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  // Windows 上 autocrlf 默认 true 会让"行数"断言随平台漂移，这里钉死。
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

function commitAll(dir, msg = 'init') {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

/** 把文件写到仓库里（自动建父目录），统一 LF。 */
function write(dir, rel, text) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text.replace(/\r\n/g, '\n'), 'utf8');
}

// ── ① untracked：默认纳入，--no-untracked 排除 ──────────────────
// 审计 A12 的核心：`git diff HEAD` 看不到全新文件。旧实现只做这一个命令，
// 于是"本次新建的源码"完全不进 DISCIPLINE-C1 的越界判定与行数预算。
test('make-diff：未跟踪的新文件默认纳入（纳入后才知道本次新增了什么）', () => {
  const dir = makeRepo();
  try {
    write(dir, 'base.txt', 'a\nb\n');
    commitAll(dir);
    write(dir, 'src/new-file.js', 'l1\nl2\nl3\n');

    const p = runDiff(dir);
    const f = p.files.find((x) => x.path === 'src/new-file.js');
    assert.ok(f, `未跟踪文件没进 diff。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(f.untracked, true, '未跟踪文件必须被标 untracked（否则无法与已跟踪改动区分）');
    assert.equal(f.added, 3, '行数必须是文件真实行数');
    assert.equal(f.deleted, 0);
    assert.equal(p.untrackedIncluded, true, '产物必须显式声明"纳入了未跟踪"');
    assert.equal(p.untrackedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('make-diff 负控：--no-untracked 时新文件必须消失，且产物声明"未纳入"', () => {
  const dir = makeRepo();
  try {
    write(dir, 'base.txt', 'a\n');
    commitAll(dir);
    write(dir, 'src/new-file.js', 'l1\nl2\n');

    const p = runDiff(dir, ['--no-untracked']);
    assert.equal(
      p.files.some((x) => x.path === 'src/new-file.js'),
      false,
      '--no-untracked 之后未跟踪文件仍然出现 —— 开关没生效',
    );
    assert.equal(p.untrackedIncluded, false, '排除时必须在产物里显式写 false，不能静默');
    assert.equal(p.untrackedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ② rename：必须归一成目标路径 ────────────────────────────────
// 旧实现把 numstat 的 `{old => new}` 展示格式原样当路径，
// 于是路径里带 `=>`，allowedPrefixes / CodeScopes 判定永远不匹配 ⇒ 越界改名被放行。
test('make-diff：rename 归一成目标路径并标注 renamedFrom（不得留下 => 假路径）', () => {
  const dir = makeRepo();
  try {
    write(dir, 'lib/old-name.mjs', 'x\ny\n');
    commitAll(dir);
    git(dir, ['mv', 'lib/old-name.mjs', 'lib/new-name.mjs']);

    const p = runDiff(dir);
    const renamed = p.files.find((f) => f.renamedFrom);
    assert.ok(renamed, `没解析出改名。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(renamed.path, 'lib/new-name.mjs', '路径必须是**目标**路径（否则前缀判定不匹配）');
    assert.equal(renamed.renamedFrom, 'lib/old-name.mjs');
    assert.equal(
      p.files.some((f) => f.path.includes('=>')),
      false,
      '产物里出现了含 "=>" 的假路径 —— 正是本次要修的那个缺陷',
    );
    assert.equal(p.renamedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 中段折叠形态：`a/{b => c}/d`。这是 numstat 展示格式最爱折叠的写法，
// 也最容易被"按 / 切分"的朴素实现拼错。
test('make-diff：目录中段改名的折叠形态 a/{b => c}/d 也要还原成两个真实路径', () => {
  const dir = makeRepo();
  try {
    write(dir, 'pkg/olddir/deep.txt', 'content\n');
    commitAll(dir);
    git(dir, ['mv', 'pkg/olddir', 'pkg/newdir']);

    const p = runDiff(dir);
    const renamed = p.files.find((f) => f.renamedFrom);
    assert.ok(renamed, `没解析出中段改名。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(renamed.path, 'pkg/newdir/deep.txt');
    assert.equal(renamed.renamedFrom, 'pkg/olddir/deep.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ③ binary：按 0 行计但必须标出来 + 给 binaryCount ────────────
test('make-diff：二进制文件标 binary:true 且计入 binaryCount（预算没算它，人得知道）', () => {
  const dir = makeRepo();
  try {
    write(dir, 'readme.txt', 'hi\n');
    commitAll(dir);
    // 真二进制：含 NUL 字节
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));

    const p = runDiff(dir);
    const bin = p.files.find((f) => f.path === 'logo.bin');
    assert.ok(bin, `二进制文件没进 diff。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(bin.binary, true);
    assert.equal(bin.added, 0, '二进制没有"行数"，必须按 0 计而不是编造');
    assert.equal(bin.deleted, 0);
    assert.equal(p.binaryCount, 1, 'payload 必须给出 binaryCount，让人知道预算漏算了几个文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ④ staged 与 range 两种模式 ──────────────────────────────────
test('make-diff：--staged 只看索引，且产物 staged=true（工作树改动不得混入）', () => {
  const dir = makeRepo();
  try {
    write(dir, 'a.txt', '1\n');
    commitAll(dir);
    write(dir, 'a.txt', '1\n2\n');     // 工作树改动（未暂存）
    write(dir, 'b.txt', 'new\n');      // 新文件
    git(dir, ['add', 'b.txt']);        // 只暂存 b.txt

    const p = runDiff(dir, ['--staged']);
    assert.equal(p.staged, true, '产物必须标 staged=true');
    assert.equal(p.range, null);
    assert.equal(p.files.some((f) => f.path === 'b.txt'), true, '已暂存的新文件必须出现');
    assert.equal(
      p.files.some((f) => f.path === 'a.txt'),
      false,
      '未暂存的工作树改动混进了 --staged 结果 —— 两种模式被搞混了',
    );
    assert.equal(p.untrackedIncluded, true, '开关值照实反映（未跟踪在 staged 模式下不适用）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('make-diff：--range 的标签必须精确回显，且只算该区间', () => {
  const dir = makeRepo();
  try {
    write(dir, 'a.txt', '1\n');
    commitAll(dir, 'c1');
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    assert.equal(baseSha.status, 0);
    write(dir, 'a.txt', '1\n2\n');
    commitAll(dir, 'c2');

    const p = runDiff(dir, ['--range', `${'HEAD~1'}..HEAD`]);
    assert.equal(p.range, 'HEAD~1..HEAD', 'range 标签必须原样回显（调用方据此知道基线）');
    assert.ok(p.files.length >= 1, 'range 内确实有改动，却是空集');
    // range 模式不该掺进未跟踪文件（它们不属于任何提交区间）
    assert.equal(p.untrackedCount, 0, 'range 模式下混进了未跟踪文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑤ 路径含空格 ────────────────────────────────────────────────
// numstat 是 tab 分隔的，路径里的空格不该被切开；而很多人会按空白切分。
test('make-diff：路径含空格的已跟踪与未跟踪文件都必须完整保留', () => {
  const dir = makeRepo();
  try {
    write(dir, 'base.txt', 'a\n');
    write(dir, 'sub dir/tracked file.txt', 'x\n');
    commitAll(dir);
    write(dir, 'sub dir/tracked file.txt', 'x\ny\n');
    write(dir, 'sub dir/brand new file.txt', 'n1\nn2\n');

    const p = runDiff(dir);
    const tracked = p.files.find((f) => f.path === 'sub dir/tracked file.txt');
    assert.ok(tracked, `含空格的已跟踪路径被切坏了。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(tracked.added, 1);

    const fresh = p.files.find((f) => f.path === 'sub dir/brand new file.txt');
    assert.ok(fresh, `含空格的未跟踪路径被切坏了。实际 files=${JSON.stringify(p.files)}`);
    assert.equal(fresh.added, 2);
    assert.equal(fresh.untracked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑥ 解析器单测（不依赖 git，纯函数）────────────────────────────
test('parseNumstatZ：普通/二进制/改名三段式三种记录都要解析对', () => {
  const raw = ['3\t1\tlib/x.mjs\u0000', '-\t-\timg.png\u0000', '0\t0\t\u0000a.txt\u0000b.txt\u0000'].join('');
  const got = parseNumstatZ(raw);
  assert.deepEqual(got, [
    { path: 'lib/x.mjs', added: 3, deleted: 1 },
    { path: 'img.png', added: 0, deleted: 0, binary: true },
    { path: 'b.txt', added: 0, deleted: 0, renamedFrom: 'a.txt' },
  ]);
});

test('parseNumstatZ 负控：空输入返回空数组（不得凭空造出条目）', () => {
  assert.deepEqual(parseNumstatZ(''), []);
});

// ── ⑦ 空 diff 必须是空集而不是"通过" ───────────────────────────
test('make-diff：没有变更时 files=[] 且 total=0（空集交给判据按"不构成通过"处理）', () => {
  const dir = makeRepo();
  try {
    write(dir, 'a.txt', '1\n');
    commitAll(dir);
    const p = runDiff(dir);
    assert.deepEqual(p.files, []);
    assert.equal(p.total, 0);
    assert.equal(p.untrackedIncluded, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ⑧ git 不可用路径（负控：必须退 2 而不是给出空结果）──────────
// 这是 A12 里唯一"无法用真仓库证明"的分支的**最近替代**：
// 用不存在的 repo 目录，让 git 自己失败。真正的"git 未安装"没法在本机伪造
// （PATH 里摘掉 git 会同时打断本文件自己的 git() 辅助函数）。
//
// ★ 夹具必须真的"不在任何 git 仓库里"（2026-11-13 独立复核抓到）：
//   原实现用 `mkdtempSync(join(tmpdir(), …))`。本工作区把 TMP 指向项目内的
//   `_work/tmp`，于是夹具目录**落在 git 仓库内部**，`git diff` 向上发现父仓库
//   ⇒ 实际退 0（成功、空 diff），而断言要求 2。
//   **那是夹具错了，不是工具错了** —— 但红的样子一模一样，所以必须修夹具，
//   不能改断言去迎合。
//   修法：显式从一个**已确认不在仓库内**的父目录建夹具，并在建好后
//   用 `git rev-parse --show-toplevel` 自证"它确实不是仓库的一部分"；
//   自证不成立就跳过该用例并明确报 UNEXECUTED，而不是假绿/假红。
function isInsideRepo(dir) {
  const out = join(dir, '.toplevel.txt');
  const fd = openSync(out, 'w');
  let r;
  try {
    r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, shell: false, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const text = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';
  try {
    rmSync(out, { force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  return r.status === 0 && text !== '';
}

test('make-diff 负控：repo 不是 git 仓库 → 退出码 2（不得静默给出空 diff）', (t) => {
  const parent = outsideRepoParent();
  if (!parent) {
    t.skip('找不到"不在任何 git 仓库内"的父目录 ⇒ 本用例未执行（不是通过）');
    return;
  }
  const dir = mkdtempSync(join(parent, 'sdd-nogit-'));
  try {
    // 夹具自证：建出来的目录必须真的不在仓库里，否则这条负控测的是别的东西。
    assert.equal(isInsideRepo(dir), false, `夹具自证失败：${dir} 仍在 git 仓库内 ⇒ 本用例无法验证"非仓库"分支`);
    const out = join(dir, 'diff.json');
    const r = spawnSync(process.execPath, [TOOL, '--repo', dir, '--out', out], { cwd: ROOT, stdio: 'ignore' });
    assert.equal(r.status, 2, `非 git 目录应当退 2，实际 ${r.status}`);
    // 关键：不能"退 2 但顺手写了个空 diff"，那会让下游读到 files=[] 当成"没有变更"。
    assert.equal(existsSync(out), false, '失败时不得写出 diff 文件 —— 空产物会被读成"没有变更"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 找一个**不在任何 git 仓库内**的父目录（用于造"非仓库"夹具）。
 *
 * 系统 tmp 在本工作区被指向项目内 _work/tmp（在仓库内部），因此按
 * ROOT 兄弟目录 → 共享临时根 → homedir → 盘根 依次**实测**（git rev-parse 判），
 * 第一个自证成立的就用。全都失败返回 null，由调用方 skip 并声明未执行。
 *
 * 为什么把兄弟目录排最前：沙箱通常只允许写工作区（ROOT 的父目录），
 * 而 ROOT 的兄弟位置既**可写**又**不在** sdd-guard 仓库内。
 */
function outsideRepoParent() {
  const candidates = [
    join(dirname(ROOT), '.sdd-guard-nogit'),
    writableTempRoot(),
    join(homedir(), '.sdd-guard-nogit'),
    join(parse(resolve(ROOT)).root, 'sdd-guard-nogit'),
  ];
  for (const p of candidates) {
    try {
      mkdirSync(p, { recursive: true });
    } catch {
      continue;
    }
    if (!isInsideRepo(p)) return p;
  }
  return null;
}
