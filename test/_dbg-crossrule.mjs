
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRules } from '../lib/runner.mjs';

const FIXTURE = new URL('./fixtures/q1-base/', import.meta.url).pathname.replace(/^\//, '');
const q = (s) => '\u0060' + s + '\u0060';

function run(design) {
  const root = mkdtempSync(join(tmpdir(), 'dbg-'));
  cpSync(FIXTURE, root, { recursive: true });
  const cd = join(root, 'changes/x');
  mkdirSync(cd, { recursive: true });
  writeFileSync(join(cd, 'design.md'), design);
  const { results } = runRules({
    changeDir: cd, repo: root,
    cfg: { contractPrefixes: ['shared/'] },
    art: { files: { 'design.md': { text: design } } },
    diff: null, code: {},
    existsProjectFile: (p) => existsSync(join(root, String(p).replace(/\\/g, '/'))),
  });
  rmSync(root, { recursive: true, force: true });
  return Object.fromEntries(results.map(r => [r.id, r]));
}

// X2: 不存在的无扩展名路径
const d1 = ['# 设计','','## 复用清单','','- ' + q('src/export/does-not-exist/index') + ' —— 幻想复用','','## 接口契约','','- ' + q('shared/api/export.json'),''].join('\n');
const r1 = run(d1);
console.log('X2 DRY-D1:', r1['DRY-D1'].status, '| reason:', r1['DRY-D1'].reason, '| items:', JSON.stringify(r1['DRY-D1'].items));

// X5: DECOUPLE-1 用 shared/ 下真实文件
const d2 = ['# 设计','','## 复用清单','','- ' + q('src/util/text.js'),'','## 接口契约','','- ' + q('shared/api/export.json'),''].join('\n');
const r2 = run(d2);
console.log('X5 DECOUPLE-1:', r2['DECOUPLE-1'].status, '| reason:', r2['DECOUPLE-1'].reason, '| items:', JSON.stringify(r2['DECOUPLE-1'].items), '| detail:', r2['DECOUPLE-1'].detail);
