/**
 * 子进程类判据的变异探针（2026-11-16，第 1 项剩余部分）。
 *
 * ★ 为什么这类判据要单独验：文本判据的失效方式是"文档写错但没察觉"；
 *   子进程类判据的失效方式是"**探针本身坏了却仍报绿**"——
 *   期望值写错、把 `status` 读成别的字段、shell 引号写错导致命令没跑。
 *   **这类失败在文本上完全看不出来，只有变异能暴露。**
 *
 * ★ 本文件锁定的真实缺陷（体检实测发现并修复）：
 *   原实现 `r.status === null ? -1 : r.status` —— 那个 `null` 分支**几乎永远不命中**。
 *   实测：`cli.mjs` 不存在时，`shell:true` 与 `shell:false` 下 spawn 都返回 **status=1**，不是 null。
 *
 *   后果按期望值分岔：
 *     · 期望 ≠ 1（OK=0 / CONFIG=2 / INCOMPLETE=3）⇒ 侥幸红；
 *     · **期望 = 1（FAIL）⇒ 命令从未执行，判据却报 ok** ⇒ **假绿**。
 *
 *   实测复现（把 `cli.mjs` 改名藏起来）：输出里仍有 `ok  CLI 实测退出码 FAIL = 1`。
 *
 *   修法：**不判断 status 是否为 null，而是证明"命令真的执行了"** ——
 *   要求输出文件非空、且不含 `Cannot find module` / `ENOENT` / `command not found` 这类
 *   解释器级失败特征。因为**子进程失败与目标失败在退出码上同形**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writableTempRoot, REPO_ROOT } from '../lib/temp.mjs';

const TOOL = join(REPO_ROOT, 'tools', 'check-contract.mjs');
const CLI = join(REPO_ROOT, 'cli.mjs');
const OUT = join(REPO_ROOT, '.selfcheck-cc-subproc.txt');

/** 跑 check-contract，返回 `{drift, fails, text}`。 */
function runCheck() {
  spawnSync(`"${process.execPath}" "${TOOL}" > "${OUT}" 2>&1`, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: 'inherit',
  });
  const text = readFileSync(OUT, 'utf8');
  rmSync(OUT, { force: true });
  const m = text.match(/检查项\s*(\d+)\s*·\s*通过\s*(\d+)\s*·\s*漂移\s*(\d+)/);
  return {
    drift: m ? Number(m[3]) : -1,
    fails: text.split('\n').filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim()),
    text,
  };
}

/** 临时改工具源码 → 跑 → 无论结果如何都还原。 */
function withTool(transform) {
  const before = readFileSync(TOOL, 'utf8');
  const after = transform(before);
  if (after === before) return { applied: false };
  try {
    writeFileSync(TOOL, after, 'utf8');
    return { applied: true, ...runCheck() };
  } finally {
    writeFileSync(TOOL, before, 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 四个退出码必须真的对得上（正控）
// ─────────────────────────────────────────────────────────────

test('正控：四个退出码的实测值必须与契约一致', () => {
  const tmp = mkdtempSync(join(writableTempRoot(), 'ec-'));
  try {
    const change = join(tmp, 'changes', 'empty-one');
    mkdirSync(change, { recursive: true });
    const cfg = join(tmp, 'guard.config.json');
    writeFileSync(cfg, JSON.stringify({ maxNesting: 3, dupWindow: 6, dupMinChars: 40, yagniMinNonGoals: 3, dryMinReuse: 1 }));
    const cases = [
      ['OK', 0, ['check', '--change', change, '--repo', tmp, '--config', cfg]],
      ['FAIL', 1, ['check', '--change', change, '--repo', tmp, '--config', cfg, '--profile', 'process', '--strict']],
      ['CONFIG', 2, ['nosuchsubcommand']],
      ['INCOMPLETE', 3, ['check', '--change', change, '--repo', tmp, '--config', cfg, '--min-coverage', '0.8']],
    ];
    for (const [label, want, args] of cases) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, stdio: 'ignore' });
      assert.equal(r.status, want, `${label} 退出码应为 ${want}，实际 ${r.status}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('★ 负控：CONFIG 必须因「未知子命令」退出，而不是因缺参数', () => {
  // 若它因缺 --change 就退出，那这条判据测的是**错的原因**（同样退出码 2，但语义不同）
  const r = spawnSync(process.execPath, [CLI, 'nosuchsubcommand'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const first = (r.stderr || r.stdout || '').trim().split('\n')[0] || '';
  assert.match(first, /未知子命令/, `CONFIG 用例必须是"未知子命令"，实际首行: ${first}`);
});

// ─────────────────────────────────────────────────────────────
// 2. ★ 核心：命令没跑起来时必须报"无法测得"，不能报 ok
// ─────────────────────────────────────────────────────────────

test('★★ 命脉：cli.mjs 不存在时，四条退出码判据都必须「无法测得」，不得有任何 ok', () => {
  const bak = CLI + '.hidden-for-test';
  let moved = false;
  try {
    renameSync(CLI, bak);
    moved = true;
    const r = runCheck();

    // ① 不许出现 `ok CLI 实测退出码 …`（这正是修复前的假绿）
    const falseGreens = r.text
      .split('\n')
      .filter((l) => /^\s*ok\s+CLI 实测退出码/.test(l));
    assert.deepEqual(
      falseGreens,
      [],
      `命令未执行却报 ok（假绿）：\n${falseGreens.join('\n')}`,
    );

    // ② 四条都必须报"无法测得"
    for (const label of ['OK', 'FAIL', 'CONFIG', 'INCOMPLETE']) {
      assert.ok(
        r.fails.some((f) => f.includes(`CLI 实测退出码 ${label} 无法测得`)),
        `${label} 应报「无法测得」，实际 fails=${JSON.stringify(r.fails)}`,
      );
    }

    // ③ 诊断必须说清原因，不能只说"不符"
    assert.ok(
      r.fails.some((f) => /解释器\/命令未找到|未真正执行|输出文件未生成/.test(f)),
      '诊断必须指出是"命令没跑起来"，而不是退出码不符',
    );
  } finally {
    if (moved) renameSync(bak, CLI);
  }
});

test('★ 正常状态下不得出现「无法测得」（不许把正常误报成探针失效）', () => {
  const r = runCheck();
  const unable = r.fails.filter((f) => /无法测得/.test(f));
  assert.deepEqual(unable, [], `正常状态不该有「无法测得」，实际: ${unable.join(' | ')}`);
});

// ─────────────────────────────────────────────────────────────
// 3. 期望值写错必须红（防止"漏判"类变异）
// ─────────────────────────────────────────────────────────────

test('★ 变异：CONFIG 期望值 2→0 ⇒ 必须变红', () => {
  const r = withTool((t) => t.replace("one('CONFIG', 2, 'nosuchsubcommand')", "one('CONFIG', 0, 'nosuchsubcommand')"));
  assert.ok(r.applied, '变异未命中');
  assert.ok(r.drift > 0, '期望值写错却没红 ⇒ 这条判据没在判');
});

test('★ 变异：让两条命令实测出同一退出码 ⇒ 可区分性负控必须红', () => {
  // ★ 第一版把 INCOMPLETE 的**期望值**改成 1 —— 那不会触发"不可区分"。
  //   实测：期望改 1 后，实际仍是 3，所以 `INCOMPLETE(3) 与 FAIL(1) 可区分` 仍然 ok，
  //   红的只是"期望不符"那一条。**判据本身是对的，是我的测试期望写错了。**
  //
  //   要真正触发"不可区分"，必须让两条命令**实测出同一个码**。
  //   做法：把 INCOMPLETE 那条的参数改成与 FAIL 完全相同（去掉 --min-coverage），
  //   于是它也会因 --strict 返回 1 ⇒ 与 FAIL 同为 1 ⇒ 负控必须报"不可区分"。
  const r = withTool((t) =>
    t.replace(
      "one('INCOMPLETE', 3, `${base} --min-coverage 0.8`)",
      "one('INCOMPLETE', 3, `${base} --profile process --strict`)",
    ),
  );
  assert.ok(r.applied, '变异未命中（源码结构已变，需更新本探针）⇒ 这条断言等于没测');
  assert.ok(
    r.fails.some((f) => /不可区分|两种失败信号又被合流/.test(f)),
    `两信号实测同码时必须报"不可区分"，实际 fails=${JSON.stringify(r.fails)}`,
  );
});

// ─────────────────────────────────────────────────────────────
// 4. 元判据：这条判据的边界要显式记录
// ─────────────────────────────────────────────────────────────

test('元判据：本判据防不住"探针自己造假"（边界如实记录，不假装能防）', () => {
  // 把 probeExitCodes 换成"直接返回期望值"的假实现 —— 它会通过。
  // 这不是缺陷，是任何判据都无法自证其执行体诚实性。
  // 真正的防线是"期望值与 contract 常量交叉核对"（check-contract L96-100 已做）。
  const r = withTool((t) =>
    t.replace(
      /const cases = \[\s*one\('OK'[\s\S]*?one\('INCOMPLETE'[^\]]*?\];/,
      "const cases = [{label:'OK',want:0,code:0,why:''},{label:'FAIL',want:1,code:1,why:''},{label:'CONFIG',want:2,code:2,why:''},{label:'INCOMPLETE',want:3,code:3,why:''}];",
    ),
  );
  if (!r.applied) {
    // 变异没命中说明源码结构变了，给出提示但不当失败（结构确实可能演进）
    assert.ok(true, '变异未命中（probeExitCodes 结构已变化，需更新本探针）');
    return;
  }
  // 我们**断言它能通过** —— 把这条边界写成测试，防止有人误以为它防住了
  assert.equal(r.drift, 0, '假实现应当能通过 ⇒ 证明本判据无法自证执行体诚实性（这是边界，不是缺陷）');
});
