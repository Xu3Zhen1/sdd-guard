/**
 * KISS-C1 的语言适用范围（2026-11-22 · 用户裁定方案 B）。
 *
 * ★ 缺口形态（17 个公开仓全量回归时发现）：
 *   `.go` / `.rs` / `.rb` 进了扫描面，但 `nestingDepth()` 里只有
 *     `if (file.endsWith('.py')) return pyNesting(...)`，**其余一律走 jsNesting（JS 词法器）**。
 *   Ruby 的 `if...end` 不产生 `{` ⇒ 深度恒算不出来。实测 `fzf-go/test/test_core.rb`：
 *   3 处命中、最大深度 **1** —— 不是"没有深嵌套"，是**判据根本没在工作**。
 *
 *   这与 laravel 的假绿同族：一个语言进了扫描面、走的是别的语言的词法器时，
 *   它的结论就是"看起来算了"。按 ICD 的口径，**"没检查"必须显示为 skip，不许显示为 pass**。
 *
 * ⇒ 方案 B：这三种语言从 KISS-C1 的**输入**里排除（它们仍进 DRY-C1 / YAGNI-C1），
 *   并在 reason 里显式说明"未判嵌套深度"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { runRules } from '../lib/runner.mjs';
import { RULES } from '../lib/rules.mjs';

/** 造一个最小 change 目录 + 代码根。 */
function makeWorkspace(files) {
  const dir = mkdtempSync(join(writableTempRoot(), 'kiss-lang-'));
  const changeDir = join(dir, 'changes', 'c1');
  mkdirSync(changeDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return { dir, changeDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const DEEP_JS = Array(8).fill("if (a) {").join("\n") + "\n".repeat(1);
const RUBY_DEEP = [
  "class A",
  "  def m",
  "    if a",
  "      if b",
  "        if c",
  "          if d",
  "            puts 1",
  "          end",
  "        end",
  "      end",
  "    end",
  "  end",
  "end",
].join('\n');

test('★ .rb / .go / .rs 不得进 KISS-C1 的输入（JS 词法器对它们无效）', () => {
  const ws = makeWorkspace({
    'a.rb': RUBY_DEEP,
    'b.go': 'package main\nfunc main() { if a { if b { if c { } } } }\n',
    'c.rs': 'fn main() { if a { if b { if c { } } } }\n',
  });
  try {
    const results = runRules({
      changeDir: ws.changeDir,
      repo: ws.dir,
      cwd: ws.dir,
      cfg: {},
      codeRoots: [ws.dir],
      diff: null,
      evidence: null,
      profile: 'all',
      rules: RULES.filter((r) => r.id === 'KISS-C1'),
      codeFilesIn: [join(ws.dir, 'a.rb'), join(ws.dir, 'b.go'), join(ws.dir, 'c.rs')],
    });
    const r = results.results[0];
    assert.equal(r.status, 'skip', `只有这几种语言时 KISS-C1 必须 skip，实际 ${r.status}: ${r.reason || r.detail}`);
    assert.match(r.reason, /未判嵌套深度|不含可判嵌套深度的/, `reason 必须说清为什么没判，实际: ${r.reason}`);
  } finally { ws.cleanup(); }
});

test('★ 正控：同一批里混有 .js 时仍要判，且只在 .js 上判', () => {
  const ws = makeWorkspace({ 'a.rb': RUBY_DEEP, 'b.js': DEEP_JS });
  try {
    const results = runRules({
      changeDir: ws.changeDir,
      repo: ws.dir,
      cwd: ws.dir,
      cfg: {},
      codeRoots: [ws.dir],
      diff: null,
      evidence: null,
      profile: 'all',
      rules: RULES.filter((r) => r.id === 'KISS-C1'),
      codeFilesIn: [join(ws.dir, 'a.rb'), join(ws.dir, 'b.js')],
    });
    const r = results.results[0];
    assert.equal(r.status, 'fail', '含 .js 时必须照常判定');
    const items = (r.items || []).join('\n');
    assert.ok(!items.includes('.rb'), `.rb 不得出现在命中里，实际: ${items}`);
    assert.ok(items.includes('.js'), `.js 必须被判定，实际: ${items}`);
  } finally { ws.cleanup(); }
});

test('★ DRY-C1 不受影响：.rb 仍参与跨文件重复检测', () => {
  const dup = Array.from({ length: 8 }, (_, i) => `value_${i} = compute_${i}(input)`).join('\n') + '\n';
  const ws = makeWorkspace({ 'a.rb': dup, 'b.rb': dup });
  try {
    const results = runRules({
      changeDir: ws.changeDir,
      repo: ws.dir,
      cwd: ws.dir,
      cfg: {},
      codeRoots: [ws.dir],
      diff: null,
      evidence: null,
      profile: 'all',
      rules: RULES.filter((r) => r.id === 'DRY-C1'),
      codeFilesIn: [join(ws.dir, 'a.rb'), join(ws.dir, 'b.rb')],
    });
    const r = results.results[0];
    assert.equal(r.status, 'fail', `.rb 之间真重复必须被 DRY-C1 抓到，实际 ${r.status}: ${r.reason || r.detail}`);
  } finally { ws.cleanup(); }
});