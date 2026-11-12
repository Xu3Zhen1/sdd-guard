
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRules } from '../../lib/runner.mjs';
import { looksLikePath, splitCommandPaths, extractPaths } from '../../lib/rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, 'probe-root2');
rmSync(ROOT, { recursive: true, force: true });
function mk(rel, text) { const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }

mk('src/export/handler.js', '// h\n');
mk('src/util/text.js', '// t\n');
mk('src/export/handler--v2.js', '// v2\n');
mk('tools/build.mjs', '// b\n');
mk('src/export/extless/index', '// e\n');

function runC3(tasksText, diffPaths) {
  const cd = join(ROOT, 'changes/c1');
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, 'tasks.md'), tasksText);
  const diff = { files: diffPaths.map((p) => ({ path: p, added: 3, deleted: 0 })) };
  const { results } = runRules({ changeDir: cd, repo: ROOT, cwd: ROOT, cfg: {}, codeRoots: [], diff, evidence: null, only: ['DISCIPLINE-C3'] });
  const r = results[0];
  return { status: r.status, reason: r.reason, detail: r.detail, items: r.items };
}

console.log('### 函数级观测');
for (const v of [
  'src/export/handler.js',
  'src/export/handler--v2.js',
  'src/export/extless/index',
  'src/export/handler v2.js',
  'node tools/build.mjs src/export/handler.js',
  'node tools/build.mjs "src/export/handler v2.js"',
  'node tools/build.mjs src/export/ghost--probe.js',
  'git diff -- src/export/ghost--probe.js',
  'src/export/ghost-probe.js',
]) {
  console.log(JSON.stringify(v).padEnd(52), 'looksLikePath=' + looksLikePath(v), 'split=' + JSON.stringify(splitCommandPaths(v)), 'extract=' + JSON.stringify(extractPaths('\u0060' + v + '\u0060')));
}

console.log('\n### C3 端到端');
const BASE = '- [ ] T1 修改 \u0060src/export/handler.js\u0060 增加校验\n';
const D = ['src/export/handler.js'];
const cases = {
  'P3 幽灵路径带双横线（命令行内）': [BASE + '- [ ] T11 执行 \u0060node tools/build.mjs src/export/ghost--probe.js\u0060 生成校验\n', D],
  'P3 对照：幽灵路径无双横线（命令行内）': [BASE + '- [ ] T11 执行 \u0060node tools/build.mjs src/export/ghost-probe.js\u0060 生成校验\n', D],
  'P3 幽灵路径直接反引号': [BASE + '- [ ] T11 修改 \u0060src/export/ghost-probe.js\u0060 生成校验\n', D],
  'P3c 无扩展名真实文件被声明要改': [BASE + '- [ ] T12 修改 \u0060src/export/extless/index\u0060 增加分支\n', D],
  'P1b NOT_CHANGING 极短局部修饰（不需要修改）': [BASE + '- [ ] T5 修改 \u0060src/util/text.js\u0060（函数签名不需要修改，只加导出）\n', D],
  'P1c NOT_CHANGING 跨行列表继续': [BASE + '- [ ] T5 修改 \u0060src/util/text.js\u0060 的归一化\n  - 注：日志格式不适用本次\n', D],
  'P5c toBlocks 列表项之间无续行（对照）': [BASE + '- [ ] T9 修改 \u0060src/util/text.js\u0060\n', D],
};
for (const [n, [t, d]] of Object.entries(cases)) {
  const r = runC3(t, d);
  console.log('--- ' + n);
  console.log('  status:', r.status, '|', r.reason || r.detail);
  if (r.items && r.items.length) console.log('  items:', JSON.stringify(r.items));
}
