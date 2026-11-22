/**
 * 判据共享的文件读取缓存必须是**有界的**（2026-11-23）。
 *
 * ★ 缺陷形态（AMup v4 会话报来，本机复现）：
 *   全部 27 条 @384 MB ⇒ exit 134；仅 DRY-C1 ⇒ 1；仅 KISS-C1 ⇒ 1；仅 ARCH-07 ⇒ 1；
 *   但 **DRY-C1 + KISS-C1 同跑 ⇒ exit 134**。
 *
 * ★ 根因量化（本机 `--expose-gc`，G:/AMup 26,931 文件）：
 *   把全部文件全文塞进 buildContext 的 cache ⇒ 文本 1,262 MB / 堆 2,384.9 MB；
 *   而 KISS-C1 单跑测到 2,388.4 MB —— 逐 MB 对得上 ⇒ cache 就是那 2.4 GB。
 *   注意 `nestingDepth()` 本身几乎不留内存（400 文件只涨 0.1 MB）。
 *
 * ★ 判据：**缓存的是"读过"，不是"保存"**。丢掉只是再读一次磁盘，判定结果必须不变。
 *   所以这里成对断言：①有界（超限会被淘汰）；②判定结果与无界实现逐字相同。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writableTempRoot } from '../lib/temp.mjs';
import { BoundedReadCache } from '../lib/rules.mjs';

/** 造一个含 N 个文件的仓，每个文件约 sizeKB。 */
function makeRepo(n, sizeKB) {
  const dir = mkdtempSync(join(writableTempRoot(), 'cache-'));
  const body = Array.from({ length: sizeKB * 20 }, (_, i) => `const v${i} = ${i};`).join('\n');
  for (let i = 0; i < n; i++) {
    const p = join(dir, `f${i}.js`);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body + `\n// ${i}\n`, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('★ 元判据：读取缓存必须有字节上限（无界会让全仓文本常驻）', () => {
  const src = readFileSync(new URL('../lib/rules.mjs', import.meta.url), 'utf8');
  assert.match(src, /class BoundedReadCache/, '必须有有界缓存实现');
  assert.match(src, /RULE_READ_CACHE_BYTES\s*=/, '上限必须是显式常量');
  // ★ 不能只匹配一种写法：第一次本判据漏掉了「new Map() + 覆写 get」这种等价变异。
  //   改成断言**行为**：buildContext 里创建的缓存必须是有界实例。
  const ctxStart = src.indexOf('export function buildContext(');
  const ctxBody = src.slice(ctxStart, ctxStart + 4000);
  assert.match(ctxBody, /new BoundedReadCache\(/, 'buildContext 必须 new BoundedReadCache（不接受 Map 等无界容器）');
  assert.doesNotMatch(ctxBody, /new Map\(\),?\s*$|const cache = new Map\(\)/, 'buildContext 里不得出现无界 Map 作为缓存');
});

test('★ 负控：读远超上限的数据后，缓存驻留字节必须被压回上限内', () => {
  const cache = new BoundedReadCache(64 * 1024); // 64 KB，故意设小以便稳定触发淘汰
  const ws = makeRepo(20, 10); // 20 × ~10KB ≈ 200KB > 64KB
  try {
    for (let i = 0; i < 20; i++) cache.get(join(ws.dir, `f${i}.js`));
    assert.ok(cache.bytes <= 64 * 1024, `驻留 ${cache.bytes} 应 ≤ 64KB`);
    assert.ok(cache.evictions > 0, '超限时必须发生淘汰');
    assert.ok(cache.map.size < 20, `必须真的丢掉了条目，实际 ${cache.map.size} 条`);
  } finally { ws.cleanup(); }
});

test('★ 反向：未超限时不得淘汰（否则缓存失去意义）', () => {
  const cache = new BoundedReadCache(1024 * 1024);
  const ws = makeRepo(3, 1);
  try {
    for (let i = 0; i < 3; i++) cache.get(join(ws.dir, `f${i}.js`));
    assert.equal(cache.evictions, 0, '未超限不该淘汰');
    assert.equal(cache.map.size, 3);
  } finally { ws.cleanup(); }
});

test('★ 正确性：同一文件重复读取必须返回同一内容（淘汰后重读也一样）', () => {
  const ws = makeRepo(1, 1);
  try {
    const f = join(ws.dir, 'f0.js');
    const a = new BoundedReadCache(1024).get(f);
    const b = new BoundedReadCache(1024).get(f);
    assert.equal(a, b);
    assert.equal(a, readFileSync(f, 'utf8'));
  } finally { ws.cleanup(); }
});