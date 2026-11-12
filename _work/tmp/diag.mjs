
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRules } from '../../lib/runner.mjs';
import { RULES } from '../../lib/rules.mjs';

const FIX = 'F:/DSH/AIcode/sdd-guard/test/fixtures/q1-base';
function runC3(tasksText, diffFiles) {
  const root = mkdtempSync(join(tmpdir(), 'diag-'));
  cpSync(FIX, root, { recursive: true });
  const cd = join(root, 'changes/q1');
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, 'tasks.md'), tasksText);
  const diff = { files: diffFiles.map(p => ({ path: p, added: 3, deleted: 0 })) };
  const { results } = runRules({ changeDir: cd, repo: root, cfg: {}, art: { files: {} }, diff, code: {}, existsProjectFile: (p) => { try { return require('node:fs').existsSync(join(root,p)) } catch { return false } } });
  const r = results.find(x => x.id === 'DISCIPLINE-C3');
  rmSync(root, { recursive: true, force: true });
  return r;
}
const BASE = '- [ ] T1 修改 `src/export/handler.js` 增加空输入校验\n';
const BASE_DIFF = ['src/export/handler.js'];

const cases = [
  ['P1  NOT_CHANGING 局部修饰', BASE + '- [ ] T5 修改 `src/util/text.js` 的归一化（日志格式不适用本次封装）\n'],
  ['P1b NOT_CHANGING 不需要修改', BASE + '- [ ] T5 修改 `src/util/text.js` 的归一化（函数签名不需要修改）\n'],
  ['P2  RECON_HEAD 确认+需要改动', BASE + '- [ ] T7 确认 `src/util/text.js` 需要改动\n'],
  ['P5b toBlocks 续行不适用', BASE + '- [ ] T5 修改 `src/util/text.js`\n- [ ] T6 修改 `src/util/handler.js`\n'],
  ['P6  codeScopes tools/', BASE, ['src/export/handler.js', 'tools/ghost.mjs']],
];
for (const [name, tasks, diff] of cases) {
  const r = runC3(tasks, diff || BASE_DIFF);
  console.log(name, '=>', r.status, '|', (r.reason||'').slice(0,60), '|', JSON.stringify((r.items||[]).slice(0,2)));
}
