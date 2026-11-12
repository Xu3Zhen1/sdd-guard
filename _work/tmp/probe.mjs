
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRules } from '../../lib/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, 'probe-root');
rmSync(ROOT, { recursive: true, force: true });

function mk(rel, text) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

// 真实存在的文件（供 recon 存在性校验通过）
mk('src/export/handler.js', '// handler\n');
mk('src/util/text.js', '// text\n');
mk('src/export/handler--v2.js', '// v2\n');
mk('src/export/legacy.js', '// legacy\n');
mk('src/export/handler v2.js', '// spaced\n');
mk('tools/build.mjs', '// build\n');
mk('src/export/extless/index', '// extensionless\n');
mk('src/export/handler2.js', '// h2\n');

function runC3(tasksText, diffPaths) {
  const cd = join(ROOT, 'changes/c1');
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, 'tasks.md'), tasksText);
  const diff = { files: diffPaths.map((p) => ({ path: p, added: 3, deleted: 0 })) };
  const { results } = runRules({
    changeDir: cd, repo: ROOT, cwd: ROOT,
    cfg: { codeScopes: ['lib/', 'src/', 'app/', 'packages/'] },
    codeRoots: [], diff, evidence: null, only: ['DISCIPLINE-C3'],
  });
  const r = results[0];
  return { status: r.status, reason: r.reason, detail: r.detail, items: r.items };
}

const BASE = '- [ ] T1 修改 \`src/export/handler.js\` 增加校验\n';
const DIFF1 = ['src/export/handler.js'];

const cases = {
  'baseline': [BASE, DIFF1],

  'P1 NOT_CHANGING 局部修饰吞整条': [
    BASE + '- [ ] T5 修改 \`src/util/text.js\` 的归一化（日志格式不适用统一封装）\n', DIFF1],
  'P1 control 去掉不适用': [
    BASE + '- [ ] T5 修改 \`src/util/text.js\` 的归一化（日志格式统一封装）\n', DIFF1],

  'P2 RECON_HEAD 句首确认': [
    BASE + '- [ ] T6 确认 \`src/util/text.js\` 需要改动\n', DIFF1],
  'P2 control 句首修改': [
    BASE + '- [ ] T6 修改 \`src/util/text.js\` 需要改动\n', DIFF1],

  'P3a looksLikePath 双横线文件名': [
    BASE + '- [ ] T7 修改 \`src/export/handler--v2.js\` 增加分支\n', DIFF1],
  'P3b looksLikePath 无扩展名路径': [
    BASE + '- [ ] T7 修改 \`src/export/extless/index\` 增加分支\n', DIFF1],
  'P3b control 有扩展名': [
    BASE + '- [ ] T7 修改 \`src/export/handler2.js\` 增加分支\n', DIFF1],

  'P4 splitCommandPaths 带空格路径': [
    BASE + '- [ ] T8 执行 \`node tools/build.mjs "src/export/handler v2.js"\` 重写校验\n', DIFF1],
  'P4 control 无空格路径': [
    BASE + '- [ ] T8 修改 \`src/export/handler2.js\` 重写校验\n', DIFF1],

  'P5a toBlocks 单 Tab 续行': [
    BASE + '- [ ] T9 修改 \`src/export/handler.js\` 增加校验\n\t（同时需要改 \`src/util/text.js\` 的归一化）\n', DIFF1],
  'P5a control 两空格续行': [
    BASE + '- [ ] T9 修改 \`src/export/handler.js\` 增加校验\n  （同时需要改 \`src/util/text.js\` 的归一化）\n', DIFF1],
  'P5b toBlocks 续行含不适用吞父项': [
    BASE + '- [ ] T10 修改 \`src/util/text.js\` 的归一化\n  （接口签名不适用本次改动）\n', DIFF1],
  'P5b control 删掉续行': [
    BASE + '- [ ] T10 修改 \`src/util/text.js\` 的归一化\n', DIFF1],

  'P6 codeScopes tools/ 越界': [
    BASE, ['src/export/handler.js', 'tools/ghost.mjs']],
  'P6 control src/ 越界': [
    BASE, ['src/export/handler.js', 'src/ghost.mjs']],
};

for (const [name, [tasks, diff]] of Object.entries(cases)) {
  const r = runC3(tasks, diff);
  console.log('--- ' + name);
  console.log('  status:', r.status);
  if (r.reason) console.log('  reason:', r.reason);
  if (r.detail) console.log('  detail:', r.detail);
  if (r.items && r.items.length) console.log('  items:', JSON.stringify(r.items));
}
