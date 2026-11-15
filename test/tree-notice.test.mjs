/**
 * 代码树身份提示（meta.tree）：验收档必须提示证据来自哪棵树。
 *
 * ★ 背景（2026-11-15 用户实测）：
 *   旧 evidence 记 head=eeba718、工作树脏 11 项；在当前 b6d00a4、工作树干净的仓库上
 *   跑 acceptance ⇒ ACCEPT-E1/E2/E3 全 PASS、EXIT=0。
 *   ICD §5.2 已声明「不认证来源、tree 仅供审计」，所以这不算 bug；
 *   但 `meta.tree` **写了却没有任何地方读**，属于「记了但不判」这一族缺陷。
 *
 * ★ 本文件的判据分两层，缺一不可：
 *   ① **提示必须出现**（stale / none / unknown 四态各有可区分文案）；
 *   ② **提示不得改变退出码**（否则就把"审计元数据"偷偷升级成了"认证"，
 *      越过了 ICD 已声明的边界 —— 那是另一种违约）。
 *
 *   只测 ① 会让实现朝"判红"漂移；只测 ② 会让实现朝"什么都不做"漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writableTempRoot } from '../lib/temp.mjs';
import { compareTree } from '../lib/tree.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

// ─────────────────────────────────────────────────────────────
// 1. 纯函数层：compareTree 的五种返回必须**互相可区分**
// ─────────────────────────────────────────────────────────────

test('compareTree：证据未记录树身份 ⇒ level=none 且文案说明无法判断', () => {
  const r = compareTree(null, { available: true, head: HEAD_A, dirty: false });
  assert.equal(r.level, 'none');
  assert.match(r.text, /未记录/);
});

test('compareTree：证据自称树身份不可用 ⇒ level=none 并带出原因', () => {
  const r = compareTree({ available: false, reason: '不是 git 仓库' }, { available: true, head: HEAD_A, dirty: false });
  assert.equal(r.level, 'none');
  assert.match(r.text, /不是 git 仓库/);
  assert.match(r.text, /未绑定/);
});

test('compareTree：当前树读不到 ⇒ level=unknown，不得假装一致', () => {
  const r = compareTree({ available: true, head: HEAD_A, dirty: false }, { available: false, reason: 'git 不可用' });
  assert.equal(r.level, 'unknown');
  assert.match(r.text, /无法判断/);
  // ★ 关键否定断言：不许出现"一致"
  assert.doesNotMatch(r.text, /一致/);
});

test('compareTree：head 不同 ⇒ level=stale 且两边提交都点名', () => {
  const r = compareTree(
    { available: true, head: HEAD_A, dirty: false },
    { available: true, head: HEAD_B, dirty: false },
  );
  assert.equal(r.level, 'stale');
  // 两个短号都必须出现（各取前 7 位），只写一个读者无法判断"谁的旧"
  assert.match(r.text, /a{7}/);
  assert.match(r.text, /b{7}/);
  assert.match(r.text, /旧树/);
});

test('compareTree：head 相同但脏度不同 ⇒ level=dirty-drift（不是 stale）', () => {
  const r = compareTree(
    { available: true, head: HEAD_A, dirty: true, dirtyCount: 11 },
    { available: true, head: HEAD_A, dirty: false },
  );
  assert.equal(r.level, 'dirty-drift');
  assert.match(r.text, /脏/);
  assert.match(r.text, /11/);
});

test('compareTree：完全一致 ⇒ level=same', () => {
  const r = compareTree(
    { available: true, head: HEAD_A, dirty: false },
    { available: true, head: HEAD_A, dirty: false },
  );
  assert.equal(r.level, 'same');
  assert.match(r.text, /一致/);
});

test('元判据：五种 level 两两不同，不存在"两种问题同一文案"', () => {
  const levels = [
    compareTree(null, { available: true, head: HEAD_A, dirty: false }),
    compareTree({ available: true, head: HEAD_A, dirty: false }, { available: false }),
    compareTree({ available: true, head: HEAD_A, dirty: false }, { available: true, head: HEAD_B, dirty: false }),
    compareTree({ available: true, head: HEAD_A, dirty: true }, { available: true, head: HEAD_A, dirty: false }),
    compareTree({ available: true, head: HEAD_A, dirty: false }, { available: true, head: HEAD_A, dirty: false }),
  ];
  const set = new Set(levels.map((l) => l.level));
  assert.equal(set.size, 5, `五种情况必须给出五个不同 level，实际: ${[...set].join(',')}`);
  // 文案也不许重复（否则人读时无法区分）
  const texts = new Set(levels.map((l) => l.text));
  assert.equal(texts.size, 5, '五种情况的文案必须互不相同');
});

// ─────────────────────────────────────────────────────────────
// 2. CLI 层：提示出现 + 退出码不变（★ 成对断言）
// ─────────────────────────────────────────────────────────────

/**
 * 造一个**真 git 仓库**的工作区。
 *
 * ★ 为什么必须真建仓：`compareTree` 要读到当前树的 head 才能比出 `stale`。
 *   用普通临时目录时当前树恒为 `unknown`，于是"stale 分支"**从未被执行**——
 *   这正是本项目反复踩过的假绿形态（测试绿着，但没测到它声称测的分支）。
 *   `git init` + 一次提交，让 stale/same 两条分支都真正跑到。
 */
function makeWs() {
  const dir = mkdtempSync(join(writableTempRoot(), 'tree-notice-'));
  const changeDir = join(dir, 'changes', 'x');
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'tasks.md'), '# t\n\n- [ ] T1 改 `src/a.js`\n', 'utf8');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
  writeFileSync(
    join(dir, 'cfg.json'),
    JSON.stringify({ maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1 }),
    'utf8',
  );
  // ★ .gitignore 必须排除 evidence/输出文件，否则"写证据"这个动作本身会把
  //   当前工作树弄脏 ⇒ 测 dirty-drift 时两边都脏 ⇒ 判成 same（测不到目标分支）。
  writeFileSync(join(dir, '.gitignore'), 'evidence*.json\nout-*.txt\n', 'utf8');

  // 建仓并提交**全部**初始文件（含 cfg.json —— 它若留在提交后写，当前树恒为脏）。
  const git = (...a) => spawnSync('git', a, { cwd: dir, shell: false, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // 自证：此刻工作树必须干净，否则后面所有"当前干净"的前提都不成立。
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: dir, shell: false, encoding: 'utf8' });
  if (st.stdout.trim()) throw new Error(`测试夹具自证失败：建仓后工作树应干净，实际: ${st.stdout}`);

  return { dir, changeDir };
}

/** 读该工作区的真实 HEAD（用于伪造"同树"证据，避免写死提交号）。 */
function headOf(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, shell: false, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 造一份"三键齐全、计数合法"的证据，tree 由参数决定。 */
function writeEvidence(ws, tree) {
  const ev = {
    tests: { passed: 5, failed: 0, skipped: 0, todo: 0, total: 5 },
    mutation: { killed: 4, total: 4, survived: [], completeness: 'complete', completenessReason: '声明 4 与实测一致' },
    drift: { checks: 10, passed: 10, findings: 0, items: [] },
    meta: { runId: 'r1', generatedAt: '2026-01-01T00:00:00Z', cwd: ws.dir, producers: {}, tree },
  };
  const p = join(ws.dir, 'evidence.json');
  writeFileSync(p, JSON.stringify(ev), 'utf8');
  return p;
}

/** 起真实 CLI。fd 重定向，不走 PIPE（本机沙箱下 PIPE 会 EPERM）。 */
function cli(args, ws) {
  const outFile = join(ws.dir, `out-${Math.random().toString(16).slice(2)}.txt`);
  const fd = openSync(outFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, ['cli.mjs', ...args], { cwd: ROOT, shell: false, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  return { status: r.status, out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '' };
}

test('CLI：证据树与当前树不一致 ⇒ 报告出现 stale 提示，但退出码仍为 0', () => {
  const ws = makeWs();
  try {
    const ev = writeEvidence(ws, { available: true, head: HEAD_A, dirty: false });
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', ev],
      ws,
    );
    // ① 提示必须出现
    assert.match(r.out, /代码树/);
    assert.match(r.out, /旧树/, '必须明确说结论属于旧树');
    // ② 退出码不得因此改变（acceptance 三键齐全 ⇒ 0）
    assert.equal(r.status, 0, `树不一致不得改变退出码；实际 ${r.status}`);
    // ③ 必须明说这条提示不改退出码，否则读者会以为已经判过了
    assert.match(r.out, /不改变退出码/);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CLI：--json 带 treeNotice，且 exitCode 字段与真实退出码一致', () => {
  const ws = makeWs();
  try {
    const ev = writeEvidence(ws, { available: true, head: HEAD_A, dirty: false });
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', ev, '--json'],
      ws,
    );
    const j = JSON.parse(r.out);
    assert.ok(j.treeNotice, 'JSON 必须带 treeNotice');
    assert.equal(j.treeNotice.level, 'stale');
    assert.match(j.treeNotice.text, /旧树/);
    // JSON 里声明的退出码必须等于进程真实退出码（A14 的可察觉性要求）
    assert.equal(j.exitCode, r.status, `JSON 声明 ${j.exitCode} 与进程 ${r.status} 不一致`);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CLI：process 档不产生 treeNotice（没有证据可核对，不能凭空造提示）', () => {
  const ws = makeWs();
  try {
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'process', '--json'],
      ws,
    );
    const j = JSON.parse(r.out);
    assert.equal(j.treeNotice, null, 'process 档不该有树提示');
    assert.doesNotMatch(r.out, /代码树:/);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CLI：证据未记录 meta.tree ⇒ 明确提示"无法判断"，不静默', () => {
  const ws = makeWs();
  try {
    const ev = writeEvidence(ws, undefined); // 不留 tree 字段
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', ev],
      ws,
    );
    assert.match(r.out, /代码树/);
    assert.match(r.out, /未记录/, '旧格式证据必须被点名，不能当作"已绑定"');
    assert.equal(r.status, 0);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// 3. ★ 反向断言：树一致时不许误报
//    只测"不一致会提示"会让实现朝"永远提示"漂移 —— 那提示就没人看了。
// ─────────────────────────────────────────────────────────────

test('CLI 反向：证据树与当前树一致 ⇒ 必须显示一致，且不得出现"旧树"', () => {
  const ws = makeWs();
  try {
    const head = headOf(ws.dir);
    assert.ok(head, '测试工作区必须是可用 git 仓库，否则 same 分支测不到');

    // 先用一份"同树、干净"的证据。注意 git init 后文件已提交，工作树应为干净。
    const ev = writeEvidence(ws, { available: true, head, dirty: false });
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', ev, '--json'],
      ws,
    );
    const j = JSON.parse(r.out);

    // ★ 这个目录随后会被 evidence.json 写入变成"脏"。
    //   所以这里允许 same 或 dirty-drift，但**绝不允许** stale / none / unknown。
    assert.ok(
      ['same', 'dirty-drift'].includes(j.treeNotice.level),
      `同树证据不该被判成 ${j.treeNotice.level}（说明 ${j.treeNotice.text}）`,
    );
    assert.doesNotMatch(j.treeNotice.text, /旧树/, '同树证据不得出现"旧树"');
    assert.equal(j.exitCode, r.status);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CLI 反向：head 相同、脏度不同 ⇒ dirty-drift，不是 stale', () => {
  const ws = makeWs();
  try {
    const head = headOf(ws.dir);
    /**
     * ★ 前提必须控制住：证据文件本身会写进仓库目录，从而把**当前**工作树也弄脏。
     *   两边都脏 ⇒ `same`（这是正确行为，不是缺陷）。
     *   要测 dirty-drift，必须让"当前干净"，所以证据写到仓库**外**。
     */
    const outside = mkdtempSync(join(writableTempRoot(), 'tree-evidence-outside-'));
    try {
      const evPath = join(outside, 'evidence.json');
      const ev = {
        tests: { passed: 5, failed: 0, skipped: 0, todo: 0, total: 5 },
        mutation: { killed: 4, total: 4, survived: [], completeness: 'complete', completenessReason: '声明 4 与实测一致' },
        drift: { checks: 10, passed: 10, findings: 0, items: [] },
        // 证据声称同一提交、但工作树"脏 11 项"；当前仓库此时是干净的。
        meta: { runId: 'r1', generatedAt: '2026-01-01T00:00:00Z', cwd: ws.dir, producers: {}, tree: { available: true, head, dirty: true, dirtyCount: 11 } },
      };
      writeFileSync(evPath, JSON.stringify(ev), 'utf8');

      const r = cli(
        ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', evPath, '--json'],
        ws,
      );
      const j = JSON.parse(r.out);
      assert.equal(j.treeNotice.level, 'dirty-drift', `期望 dirty-drift，实际 ${j.treeNotice.level}: ${j.treeNotice.text}`);
      assert.match(j.treeNotice.text, /11/, '必须带出证据侧的脏项数');
      // head 相同 ⇒ 不得说"旧树"
      assert.doesNotMatch(j.treeNotice.text, /旧树/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CLI 自证：两边都脏 ⇒ same（脏度相同不算漂移）', () => {
  const ws = makeWs();
  try {
    const head = headOf(ws.dir);
    // ★ 必须**显式**制造一个脏文件：.gitignore 已排除 evidence/输出文件，
    //   所以"写证据"不再把工作树弄脏。不显式制造就测不到"两边都脏"这个分支。
    writeFileSync(join(ws.dir, 'src', 'dirty.js'), '// 未提交\n', 'utf8');
    const ev = writeEvidence(ws, { available: true, head, dirty: true, dirtyCount: 1 });
    const r = cli(
      ['check', '--change', ws.changeDir, '--repo', ws.dir, '--config', join(ws.dir, 'cfg.json'), '--code', join(ws.dir, 'src'), '--profile', 'acceptance', '--evidence', ev, '--json'],
      ws,
    );
    const j = JSON.parse(r.out);
    assert.equal(j.treeNotice.level, 'same', `两边都脏应判 same，实际 ${j.treeNotice.level}: ${j.treeNotice.text}`);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
