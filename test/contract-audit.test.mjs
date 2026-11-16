/**
 * 契约体检（2026-11-16，"额外的那一条"）。
 *
 * 这个文件锁定两类东西：
 *   ① **变异探针**：把 ICD/README 里的正式定义改坏，check-contract 必须变红。
 *      不变红 ⇒ 那条判据是"文本出现过就行"，不是"文档定义了它"。
 *   ② **本次体检发现的真实缺陷**：`--strict-args` 契约承诺"宽松解析仍在 JSON
 *      结果里留 trace"，而实现里找不到相近拼写时**完全静默丢弃**。
 *
 * ★ 为什么 ① 要放进测试而不是只跑一次的脚本：
 *   变异探针是**唯一能证明"判据真的在判"的手段**。
 *   它一旦只跑一次，下次改了 check-contract 就没人知道判据是否还活着。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot, REPO_ROOT } from '../lib/temp.mjs';

const CLI = join(REPO_ROOT, 'cli.mjs');
const CHECK = join(REPO_ROOT, 'tools', 'check-contract.mjs');
const ICD = join(REPO_ROOT, 'docs', 'ICD.md');
const README = join(REPO_ROOT, 'README.md');

/**
 * 跑 CLI 并拿 `--json` 结果。
 *
 * ★ 为什么用 `spawnSync` + shell 重定向而不是 `execFileSync`：
 *   规则 FAIL 时 CLI 退出码非 0，而 `execFileSync` 会**抛错**，
 *   于是断言根本没跑到（第一版就是这么失败的）。
 *   重定向到文件 + `spawnSync` 完全不看退出码，只读内容。
 */
function runJson(changeDir, extraArgs = []) {
  const outFile = join(changeDir, 'out.json');
  const args = ['check', '--change', changeDir, '--repo', REPO_ROOT, '--code', 'lib', '--json', ...extraArgs];
  spawnSync(`${process.execPath} "${CLI}" ${args.map((a) => `"${a}"`).join(' ')} > "${outFile}" 2>&1`, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: 'inherit',
  });
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

/** 跑 check-contract，返回 {ok, fails}。 */
function runCheck() {
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [CHECK], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    ok = false;
  }
  const fails = out.split(/\r?\n/).filter((l) => /^\s*FAIL/.test(l)).map((l) => l.trim());
  return { ok, fails };
}

/**
 * 跑一个变异：改坏 `file`，跑检查，**无论结果如何都还原**。
 * 返回 {applied, red}。
 */
function mutate(file, fn) {
  const before = readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) return { applied: false, red: false };
  try {
    writeFileSync(file, after, 'utf8');
    return { applied: true, red: !runCheck().ok };
  } finally {
    writeFileSync(file, before, 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────
// ① 变异探针：文档定义被改坏时，检查必须变红
// ─────────────────────────────────────────────────────────────

const MUTATIONS = [
  ['退出码 `0` 被移除', ICD, (t) => t.replace(/`0`/g, '`zero`')],
  ['状态 `skip` 改名', ICD, (t) => t.replace(/`skip`/g, '`skpped`')],
  ['档位 `process` 改名', ICD, (t) => t.replace(/`process`/g, '`proc`')],
  ['证据键 `command` 改名', ICD, (t) => t.replace(/`command`/g, '`cmd`')],
  ['`make-evidence.mjs` 改名', ICD, (t) => t.replace(/make-evidence\.mjs/g, 'makeev.mjs')],
  ['README 移除 `--profile process`', README, (t) => t.replace(/--profile process/g, '--profile proX')],
  ['README 移除 `tools/self-check.mjs`', README, (t) => t.replace(/tools\/self-check\.mjs/g, 'tools/sc2.mjs')],

  // ★ 2026-11-16（第 3 项）：README 的**分档计数**此前从未核对过。
  //   这两处声明各自独立、且与总量无关 —— 总量对了不代表分档对了。
  ['README process 档机器数 7→8', README, (t) => t.replace('11 条 = 7 机器 + 4 人工', '11 条 = 8 机器 + 4 人工')],
  ['README acceptance 档机器数 10→9', README, (t) => t.replace('12 条 = 10 机器 + 2 人工', '12 条 = 9 机器 + 2 人工')],
  ['README 删掉 process 档计数声明', README, (t) => t.replace('**11 条 = 7 机器 + 4 人工**', '**若干条**')],
];

for (const [label, file, fn] of MUTATIONS) {
  test(`变异探针：${label} ⇒ check-contract 必须变红`, () => {
    const r = mutate(file, fn);
    assert.ok(r.applied, `变异未命中（pattern 没找到）：${label}`);
    assert.ok(r.red, `检查未察觉该变异 ⇒ 这条判据只判"文本出现过"，不判"定义了它"：${label}`);
  });
}

// ─────────────────────────────────────────────────────────────
// ② 本次发现的真实缺陷：未知参数必须留下 trace
// ─────────────────────────────────────────────────────────────

test('★ 未知参数（无相近拼写）必须进 --json 的 warnings', () => {
  const dir = mkdtempSync(join(writableTempRoot(), 'trace-'));
  try {
    writeFileSync(join(dir, 'tasks.md'), '# t\n\n- [ ] T1\n');
    // `--zzz-nonsense-flag` 与任何已知选项拼写都不同 ⇒ 必走"无相近建议"分支
    const j = runJson(dir, ['--zzz-nonsense-flag']);
    assert.ok(Array.isArray(j.warnings), 'warnings 必须是数组');
    assert.equal(j.warnings.length, 1, `未知参数必须留下 1 条 trace，实际 ${j.warnings.length} 条`);
    assert.match(j.warnings[0], /zzz-nonsense-flag/, 'trace 里必须点名那个参数');
    assert.match(j.warnings[0], /strict-args/, 'trace 必须告诉使用者怎么让它失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('★ 负控：有相近拼写时，trace 应给出"是否想写"的建议', () => {
  const dir = mkdtempSync(join(writableTempRoot(), 'trace2-'));
  try {
    writeFileSync(join(dir, 'tasks.md'), '# t\n\n- [ ] T1\n');
    // `--repos` 与 `--repo` 编辑距离 1 ⇒ 应给建议
    const j = runJson(dir, ['--repos']);
    assert.equal(j.warnings.length, 1, `应恰好 1 条，实际 ${j.warnings.length}`);
    assert.match(j.warnings[0], /是否想写/, `相近拼写时给建议，实际: ${j.warnings[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 负控：已知选项不产生 warnings（不许把正常调用报成"有问题"）', () => {
  const dir = mkdtempSync(join(writableTempRoot(), 'trace3-'));
  try {
    writeFileSync(join(dir, 'tasks.md'), '# t\n\n- [ ] T1\n');
    const j = runJson(dir);
    assert.equal(j.warnings.length, 0, `正常调用不该有 warning，实际 ${JSON.stringify(j.warnings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
