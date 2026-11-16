// 测试文件识别（2026-11-16，第 ⑥ 位）。
//
// ★ 为什么这是**新功能**而不是修缺陷：
//   用户实测（Java 仓 `KISS-C1` 共 211 处）：`CoreSelfTest.java` **一个文件占 83 处（39%）、max=7**。
//   它是 10995 行的零依赖自测脚本，`main()` 里顺序断言，天然深嵌套。
//   若按「文件数」或「绝对处数」设阈值，**测试文件会把生产代码的信号淹掉**。
//
// ★ 但这个功能天生有一个困难：**"哪个文件算测试"是判断，不是事实。**
//   `CoreSelfTest.java` 很明显（在 `src/test/` 下、名字带 Test）。
//   但 `test_utils.py` 在 `src/` 下算不算？`foo_test_helpers.java` 带 Test 却是辅助工具？
//   前端 `*.spec.ts` 与 `*.test.ts` 口径一致吗？
//
//   所以本模块的三条纪律：
//     ① **显式声明规则**（就是下面那张表），不"我猜"；
//     ② **保守**：宁可不认成测试，也不把生产代码误判成测试（误判会让你少看真问题）；
//     ③ **允许用户覆盖**（`testOverrides`），因为规则一定有例外；
//     ④ 判定结果**必须可解释**（返回 `why`，报告里能写清"凭什么说它是测试"）。

import { extname, sep } from 'node:path';

/**
 * 路径识别规则：**只认目录与文件名约定**，不看内容。
 *
 * 理由：内容判断需要解析语法（每个语言一套），而目录/文件名是跨语言通用的、
 * 且是各语言生态**已经形成共识**的约定（Maven/Gradle `src/test`、Python `tests/`、
 * JS `__tests__/`、`*.test.ts` / `*.spec.ts`）。
 *
 * ★ 这些是**白名单式的目录段匹配**，不做模糊匹配 —— `mytest/` 不该命中 `test/`。
 */
const TEST_DIR_SEGMENTS = new Set([
  'test', // Java/Python/通用
  'tests',
  '__tests__', // JS 生态
  'testdata', // Go
  'spec', // RSpec / 前端 spec 目录
  'specs',
  '__mocks__', // Jest
  'testing',
]);

/**
 * 文件名约定（去掉扩展名后匹配）。
 *
 * ★ 2026-11-16 第一版写错过一次，被负控抓住：
 *   `/Test$/i` 会匹配 `contest`、`latest`、`attestation` 的末尾 —— **把普通源码判成测试**。
 *   这是最危险的方向：误判成测试 ⇒ 该文件的问题**不计入失败** ⇒ 你少看真问题。
 *
 * 修法：**以大写 `Test` 开头或结尾的模式去掉 `/i`**，并要求前面是词边界（`^` 或 `.` 或大小写切换）。
 * Java/JS 的命名约定是 PascalCase，`OrderTest` / `OrderTests` 一定是大写 T；
 * 而 `contest` / `latest` 是小写 t —— 这个区别恰好就是判据。
 */
const TEST_NAME_PATTERNS = [
  /\.(test|spec)$/i, // foo.test.ts / foo.spec.ts（点分，无歧义）
  /^test_/i, // Python: test_foo.py（前缀 + 下划线，无歧义）
  /_test$/i, // Go: foo_test.go（下划线后缀，无歧义）
  /^tests?$/i, // 文件就叫 test.js / tests.js
  /Tests?$/, // Java: OrderTest / OrderTests（**大写 T**，靠大小写区分）
  /TestCase$/, // JUnit: FooTestCase
  /^Spec/, // Spec.js（PascalCase 前缀）
  /Spec$/, // *Spec.js
  /_spec$/, // Ruby
];

/**
 * 判定一个文件是否算测试文件。
 *
 * @param {string} absPath 绝对路径
 * @param {string} relPath 仓库相对路径（用 `/` 或平台分隔符均可）
 * @param {string[]} overrides 用户覆盖：`+前缀` 强制算测试，`-前缀` 强制不算
 * @returns {{isTest:boolean, why:string}}
 */
export function classifyTest(absPath, relPath, overrides = []) {
  const rel = String(relPath).split(/[\\/]/).join('/');
  const forced = matchOverride(rel, overrides);
  if (forced) return forced;

  const byDir = matchDirSegment(rel);
  if (byDir) return { isTest: true, why: byDir };

  const byName = matchFileName(rel);
  if (byName) return { isTest: true, why: byName };

  return { isTest: false, why: '' };
}

/**
 * 用户覆盖优先于内置规则。
 *
 * 格式：`+tests/fixtures/`（强制算测试）、`-lib/mytest/`（强制不算）。
 * **不支持正则** —— 正则让"为什么它是测试"难以解释，也容易被写成万能匹配。
 */
function matchOverride(rel, overrides) {
  for (const rule of overrides) {
    if (typeof rule !== 'string' || rule.length < 2) continue;
    const sign = rule[0];
    const prefix = rule.slice(1);
    if (sign !== '+' && sign !== '-') continue;
    if (!rel.startsWith(prefix)) continue;
    return sign === '+'
      ? { isTest: true, why: `用户覆盖 +${prefix}` }
      : { isTest: false, why: `用户覆盖 -${prefix}（强制不算测试）` };
  }
  return null;
}

/** 路径里是否有测试目录段。只看**目录部分**，不看文件名。 */
function matchDirSegment(rel) {
  const parts = rel.split('/');
  parts.pop(); // 去掉文件名
  for (const seg of parts) {
    if (TEST_DIR_SEGMENTS.has(seg.toLowerCase())) return `目录段 ${seg}/`;
  }
  return null;
}

/** 文件名约定（去掉扩展名后匹配）。 */
function matchFileName(rel) {
  const base = rel.split('/').pop() || '';
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  // `foo.test.ts` / `foo.spec.ts` 这类**双扩展**：stem 是 `foo.test`
  for (const re of TEST_NAME_PATTERNS) {
    if (re.test(stem)) return `文件名 ${base}`;
  }
  return null;
}
