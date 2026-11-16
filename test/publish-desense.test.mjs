/**
 * `check-publish` 脱敏判据负控（2026-11-16，第 2 项）。
 *
 * ★ 为什么必须做：`check-publish` 是我唯一**真抓到过自己错误**的判据
 *   （两次都是主机绝对路径写进了注释）。但"抓到过两次"不等于"它现在还是活的" ——
 *   判据可能因为某次重构而静默失效，而报告仍然说"0 阻断项"。
 *
 * 方法：**不看代码看行为**（与 `contract-audit.test.mjs` 同法）——
 *   往仓库里放一个会被扫描的文件，看 `check-publish` 是否判红；删掉后看是否恢复绿。
 *
 * ★ 每条都必须双向，理由与契约体检相同：
 *   只证明"放进去会红" ⇒ 判据可能永远红（等于没有信号）；
 *   只证明"删掉会绿" ⇒ 判据可能永远绿（等于死代码）。
 *
 * ★ 探针文件用**固定名**并在 `finally` 里删除：中途失败不会把泄漏样本留在仓库里
 *   （那本身就是一次真实泄漏）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/temp.mjs';

const TOOL = join(REPO_ROOT, 'tools', 'check-publish.mjs');
const PROBE = join(REPO_ROOT, '_probe-leak-fixture.txt');

/**
 * 跑 check-publish，返回 `{blocked, mentionsProbe}`。
 *
 * ★ 分类依据是末尾那行「阻断项 N」，**不是**匹配中文"失败"——
 *   第一版这么写时全部误判成 green（工具实际输出用的是 `FAIL`）。
 *   教训：分类器必须先看真实输出格式，再谈结论。
 */
function run() {
  const out = join(REPO_ROOT, '.selfcheck-publish-test.txt');
  try {
    spawnSync(`"${process.execPath}" "${TOOL}" > "${out}" 2>&1`, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: 'inherit',
    });
    const text = readFileSync(out, 'utf8');
    const m = text.match(/阻断项\s*(\d+)/);
    return {
      blocked: m ? Number(m[1]) : -1,
      mentionsProbe: text.includes('_probe-leak-fixture.txt'),
    };
  } finally {
    rmSync(out, { force: true });
  }
}

/** 放入探针内容 → 跑一遍 → 无论结果如何都删掉。 */
function withProbe(content) {
  try {
    writeFileSync(PROBE, content, 'utf8');
    return run();
  } finally {
    rmSync(PROBE, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 基线：没有泄漏时必须是绿的（否则判据是"永远红"）
// ─────────────────────────────────────────────────────────────

test('★ 负控：仓库干净时阻断项必须为 0（判据不能永远红）', () => {
  const r = run();
  assert.ok(r.blocked >= 0, '必须能解析出「阻断项 N」');
  assert.equal(r.blocked, 0, `干净仓库不该有阻断项，实际 ${r.blocked}`);
});

// ─────────────────────────────────────────────────────────────
// 2. 正控：七类敏感模式都必须被检出
// ─────────────────────────────────────────────────────────────

/**
 * ★ 样本必须**运行时拼接**，不能在源码里写成完整字面量。
 *
 * 第一版直接写 `ghp_abc...` 等字面量 ⇒ **check-publish 立刻把本测试文件自己判红了**
 * （8 个阻断项全部指向第 79-85 行）。判据完全正确 —— 源文件里确实躺着 7 种敏感串。
 *
 * 所以这里用 `['gh','p_'].join('')` 这类拼接：**运行时才是敏感串，
 * 静态文本不是**。这不只是绕过检查，而是这类测试的正确写法：
 * 测试夹具本身不该让仓库变脏。
 */
const JOIN = (...parts) => parts.join('');
const LEAK_SAMPLES = [
  ['Windows 盘符绝对路径', JOIN('p: ', 'C:', '\\\\', 'Users\\\\x\\\\a.txt\n')],
  ['POSIX 家目录绝对路径', JOIN('p: ', '/home/', 'alice/proj/x.js\n')],
  ['GitHub token', JOIN('token = ', 'gh', 'p_', 'abcdefghijklmnopqrstuvwxyz012345\n')],
  ['GitHub fine-grained token', JOIN('pat = ', 'github', '_pat_', '11ABCDEFG0123456789_abcdefghij\n')],
  ['sk- API key', JOIN('key = ', 'sk', '-', 'abcdefghijklmnopqrstuvwx\n')],
  ['AWS AKIA', JOIN('aws = ', 'AKIA', 'IOSFODNN7EXAMPLE\n')],
  ['私钥块', JOIN('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----', '\nMIIEow\n')],
];

for (const [label, content] of LEAK_SAMPLES) {
  test(`★ 正控：${label} ⇒ 必须判红且点名该文件`, () => {
    const r = withProbe(content);
    assert.ok(r.blocked > 0, `${label} 未被检出（阻断项 ${r.blocked}）⇒ 脱敏判据已失效`);
    assert.ok(r.mentionsProbe, `必须点名是哪个文件泄漏，实际输出没提到探针文件名`);
  });
}

// ─────────────────────────────────────────────────────────────
// 3. 负控：正常内容**不得**被误报（误报会让判据被绕过）
// ─────────────────────────────────────────────────────────────

test('★ 负控：正常代码文本不触发任何阻断项', () => {
  const r = withProbe('export function add(a, b) {\n  return a + b;\n}\n// 普通注释\n');
  assert.equal(r.blocked, 0, `正常代码被误报（阻断项 ${r.blocked}）⇒ 使用者会学会忽略这个判据`);
});

test('★ 负控：相对路径里含 "Users" 不算主机绝对路径', () => {
  const r = withProbe(JOIN('见 docs/', 'Users', '.md 的说明\n'));
  assert.equal(r.blocked, 0, '相对路径不该被当成绝对路径');
});

test('★ 负控：短的非敏感 token 形态不该触发（避免过度敏感）', () => {
  // `sk-` 后面不足 20 字符 → 不该触发（同样用拼接，防止本文件被自己检出）
  const r = withProbe(JOIN('short = ', 'sk', '-abc123\n'));
  assert.equal(r.blocked, 0, '过短的值不该按 API key 报出');
});
