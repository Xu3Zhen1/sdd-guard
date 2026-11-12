// 正向夹具的配套测试文件。
// 为什么需要它：DISCIPLINE-C3 现在会校验"命令行里引用的路径必须真实存在"
// （2026-11-12 外部实测的 A 缺陷：命令行里的幽灵路径会绕过所有校验）。
// tasks.md 的 T4 写的是 `node --test test/handler.test.js`，
// 若该文件不存在，C3 会正确报错 —— 所以夹具必须自洽。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleExport } from '../src/export/handler.js';

test('空 body 返回 400', () => {
  assert.equal(handleExport({ body: '' }).status, 400);
});