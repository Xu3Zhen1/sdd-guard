/**
 * 覆盖率下限的**分档默认值**（2026-11-22，用户裁定方案 B）。
 *
 * ★ 要解决的缺口：`--min-coverage` 默认关闭时，`laravel/framework`（3,205 个 .php）
 *   只扫到 3 个 .js，`KISS-C1` 给出 pass、**exit 0**；`covered 6/19 = 0.32` 也没人管。
 *
 * ★ 为什么不能直接全局改成 0.8：
 *   ICD §2 明确写着 process 档的用法是「边写边查」，文档没写完就 skip 是**合理状态**，
 *   判 fail 会打断正常流。那条设计是有意的，不是疏漏。
 *
 * ⇒ 方案 B：**只在 acceptance 档默认启用 0.8**。验收档本来就是「交付前跑一次」，
 *   覆盖率不足意味着「没检查完」，此时 exit 3（未跑完）是它的正确语义；
 *   process 档一个字不改。显式传 `--min-coverage` 永远优先于默认值。
 *
 * 判据：**改默认值不得改变任何既有档位的既有语义** —— 所以下面三条断言缺一不可：
 *   acceptance 默认 0.8 / process 默认不启用 / 显式传值覆盖默认。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceMinCoverage } from '../lib/coverage.mjs';

test('★ acceptance 档未显式指定时，默认覆盖率下限为 0.8', () => {
  const r = acceptanceMinCoverage({ profile: 'acceptance', explicit: null });
  assert.equal(r.value, 0.8, 'acceptance 档必须默认 0.8');
  assert.equal(r.source, 'profile-default', '必须标明来源是档位默认，不是用户显式指定');
});

test('★ process 档未显式指定时，仍然不启用（边写边查不许被打断）', () => {
  const r = acceptanceMinCoverage({ profile: 'process', explicit: null });
  assert.equal(r.value, null, 'process 档默认必须保持不启用');
  assert.equal(r.source, 'off');
});

test('★ all 档未显式指定时，仍然不启用（它同时含 process 判据，不能打断初稿）', () => {
  const r = acceptanceMinCoverage({ profile: 'all', explicit: null });
  assert.equal(r.value, null, 'all 档默认必须保持不启用');
});

test('★ 显式传值永远优先：acceptance 档传 0 必须真的关掉（显式选择不是缺省）', () => {
  const r = acceptanceMinCoverage({ profile: 'acceptance', explicit: 0 });
  assert.equal(r.value, 0, '显式 0 必须生效');
  assert.equal(r.source, 'explicit');
});

test('★ 显式传值优先：process 档传 0.5 也必须生效', () => {
  const r = acceptanceMinCoverage({ profile: 'process', explicit: 0.5 });
  assert.equal(r.value, 0.5);
  assert.equal(r.source, 'explicit');
});