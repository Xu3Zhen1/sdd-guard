// 证明 --code 多根真的累积（不经过 CLI 进程，直接调用同一解析器 + runRules）
import { runRules } from '../lib/runner.mjs';
import { parseArgs } from '../lib/args.mjs';
import { resolve } from 'node:path';

const argv = ['check', '--change', 'test/fixtures/good/changes/add-empty-check', '--repo', 'test/fixtures/good', '--code', 'test/fixtures/good/src', '--code', 'lib'];
const args = parseArgs(argv);
const roots = args.code.map((p) => resolve(p));
const { ctx, results } = runRules({
  changeDir: resolve('test/fixtures/good/changes/add-empty-check'),
  repo: resolve('test/fixtures/good'),
  cwd: process.cwd(),
  cfg: {},
  codeRoots: roots,
  diff: null,
  only: ['KISS-C1'],
});
console.log('parsed --code =', JSON.stringify(args.code));
console.log('roots(绝对) =', JSON.stringify(roots));
console.log('实际扫描文件数 =', ctx.codeFiles.length);
console.log('文件 =', ctx.codeFiles.map((f) => ctx.rel(f)).join(', '));
console.log('KISS-C1 =', results[0].status, '|', results[0].detail || results[0].reason);

const one = runRules({
  changeDir: resolve('test/fixtures/good/changes/add-empty-check'),
  repo: resolve('test/fixtures/good'),
  cwd: process.cwd(),
  cfg: {},
  codeRoots: [resolve('lib')],
  diff: null,
  only: ['KISS-C1'],
});
const libCount = one.ctx.codeFiles.length;
const bothCount = ctx.codeFiles.length;
console.log('对照：仅 lib 根 =', libCount, '个文件');
console.log(
  '判据:',
  bothCount === libCount + 2 && libCount === 6 ? `✓ 两根累积成立（${libCount}+2=${bothCount}）` : `✗ 未累积（期望 ${libCount + 2}，实际 ${bothCount}）`,
);