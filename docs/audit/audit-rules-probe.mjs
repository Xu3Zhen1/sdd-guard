import assert from 'node:assert/strict';
import { RULES, buildContext } from '../lib/rules.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { nestingDepth } from '../lib/code.mjs';
import { parseOutline, findTopSection, bulletItems } from '../lib/md.mjs';

const rule = (id) => RULES.find((r) => r.id === id);
const proposal = (text) => rule('YAGNI-P1').run({ art: { files: { 'proposal.md': { text } } }, cfg: {} });
const validTable = "# P\n## 非目标\n|事项|理由|\n|---|---|\n|导出|无需|\n|缓存|延后|\n|多端|不需要|";
const blankReasonTable = "# P\n## 非目标\n|事项|理由|\n|---|---|\n|导出||\n|缓存||\n|多端||";
const bareBullets = "# P\n## 非目标\n- 导出\n- 缓存\n- 多端";
const fencedSection = "# P\n\n```markdown\n## 非目标\n|事项|理由|\n|---|---|\n|导出|无需|\n|缓存|延后|\n|多端|不需要|\n```";

const valid = proposal(validTable);
const invalidTable = proposal(blankReasonTable);
const unreasoned = proposal(bareBullets);
const fenced = proposal(fencedSection);
assert.equal(valid.status, 'pass');
assert.equal(invalidTable.status, 'fail');
assert.equal(unreasoned.status, 'pass');
const fencedSectionNode = findTopSection(parseOutline(fencedSection), /非目标/);
assert.ok(fencedSectionNode, 'heading inside fenced code is treated as a real section');
assert.equal(fenced.status, 'pass');

const nested4 = [
  'if (a) {', '  if (b) {', '    if (c) {', '      if (d) {',
  '        work();', '      }', '    }', '  }', '}',
].join('\n');
const objectUnderflow = [
  'if (a) {', '  if (b) {', '    if (c) {', '      const data = {',
  '        value: true', '      };', '      if (d) {', '        work();',
  '      }', '    }', '  }', '}',
].join('\n');
const compact4 = 'if (a) { if (b) { if (c) { if (d) { work(); } } } }';
const depthResult = (text) => nestingDepth('probe.js', text);
const regularHits = depthResult(nested4);
const objectHits = depthResult(objectUnderflow);
const compactHits = depthResult(compact4);
assert.ok(regularHits.some((h) => h.depth > 3), 'normal multiline four-level control nesting is detected');
assert.equal(objectHits.filter((h) => h.depth > 3).length, 0);
assert.equal(compactHits.filter((h) => h.depth > 3).length, 0);

for (const source of [nested4, objectUnderflow, compact4]) new Script(source);
const root = resolve('_work/tmp/audit-rules-fixture');
const put = (path, text) => { const dest = resolve(root, path); mkdirSync(resolve(dest, '..'), { recursive: true }); writeFileSync(dest, text); return dest; };
put('shared/types.js', 'export const version = 1;');
put('src/base.js', 'export const base = 1;');
const file = put('src/probe.js', 'export const x = 1;');
const second = put('src/second.js', 'export const y = 2;');
const textArt = (name, text) => ({ files: { [name]: { text } }, specs: [] });
const make = (art = { files: {}, specs: [] }, cfg = {}, diff = null, codeFiles = []) => ({ ...buildContext({ art, cfg, diff, changeDir: root, repo: root, cwd: root }), codeFiles });
const cases = [];
const check = (name, id, ctx, expected) => { const out = rule(id).run(ctx); assert.equal(out.status, expected, name); cases.push({ name, id, status: out.status, reason: out.reason || out.detail }); return out; };
const spec = (body) => ({ files: {}, specs: [{ name: 'main.md', text: body }] });
const gwt = '### Requirement: X\n#### Scenario: one\n- GIVEN ready\n- WHEN run\n- THEN done';
check('GWT complete', 'KISS-S1', make(spec(gwt)), 'pass');
check('GWT missing', 'KISS-S1', make(spec(gwt.replace('- WHEN run', ''))), 'fail');
check('single THEN', 'KISS-S2', make(spec(gwt)), 'pass');
check('two bullet THEN', 'KISS-S2', make(spec(gwt + '\n- THEN other')), 'fail');
check('two plain THEN bypass', 'KISS-S2', make(spec(gwt.replace('- THEN done', 'THEN done\nTHEN other'))), 'pass');
check('dependency registered', 'KISS-D1', make(textArt('design.md', '## 依赖\n|包|理由|\n|---|---|\n|foo|标准库无功能|'), { dependencies: { foo: '1' } }), 'pass');
check('dependency missing', 'KISS-D1', make(textArt('design.md', '## 设计'), { dependencies: { foo: '1' } }), 'fail');
check('reuse exists', 'DRY-D1', make(textArt('design.md', '## 复用\n`src/base.js`')), 'pass');
check('reuse ghost', 'DRY-D1', make(textArt('design.md', '## 复用\n`src/ghost.js`')), 'fail');
check('task new file', 'DRY-T1', make(textArt('tasks.md', '- 新建 `src/new.js`')), 'pass');
check('task missing file', 'DRY-T1', make(textArt('tasks.md', '- 修改 `src/new.js`')), 'fail');
check('contract exists', 'DECOUPLE-1', make(textArt('design.md', '## 接口契约\n`shared/types.js`'), { contractPrefixes: ['shared/'] }), 'pass');
check('contract ghost', 'DECOUPLE-1', make(textArt('design.md', '## 接口契约\n`shared/missing.js`')), 'fail');
const boundaryCfg = { boundaries: { front: ['src/'], back: ['backend/'], shared: ['shared/'] }, forbidImports: [['front','back']] };
writeFileSync(file, 'import x from "../backend/private.js";');
check('banned import', 'DECOUPLE-2', make(undefined, boundaryCfg, null, [file]), 'fail');
writeFileSync(file, 'import x from "../shared/types.js";');
check('allowed import', 'DECOUPLE-2', make(undefined, boundaryCfg, null, [file]), 'pass');
writeFileSync(file, '/*\nimport x from "../backend/private.js";\n*/');
check('comment import false positive', 'DECOUPLE-2', make(undefined, boundaryCfg, null, [file]), 'fail');
const kiss = (text) => { writeFileSync(file, text); return make(undefined, {}, null, [file]); };
check('normal nesting over limit', 'KISS-C1', kiss(nested4), 'fail');
check('object close undercounts', 'KISS-C1', kiss(objectUnderflow), 'pass');
check('single line undercounts', 'KISS-C1', kiss(compact4), 'pass');
const dup = Array.from({length:6}, (_,i) => 'console.log("duplicate line ' + i + '");').join('\n');
writeFileSync(file, dup); writeFileSync(second, dup);
check('duplicate blocks', 'DRY-C1', make(undefined, {}, null, [file, second]), 'fail');
writeFileSync(second, 'export const unique = 999;');
check('distinct files', 'DRY-C1', make(undefined, {}, null, [file, second]), 'pass');
check('speculative marker', 'YAGNI-C1', kiss('// TODO: later'), 'fail');
check('no marker', 'YAGNI-C1', kiss('export const active = true;'), 'pass');
check('budget exact', 'DISCIPLINE-C1', make(undefined, {maxDiffLines:10}, {files:[{path:'src/a.js',added:10,deleted:0}]}), 'pass');
check('budget over', 'DISCIPLINE-C1', make(undefined, {maxDiffLines:10}, {files:[{path:'src/a.js',added:11,deleted:0}]}), 'fail');
check('clean root', 'DISCIPLINE-C2', make(), 'pass');
mkdirSync(resolve(root, 'pip-junk'), {recursive:true});
check('junk root', 'DISCIPLINE-C2', make(), 'fail');
// Restore only this task-owned fixture for repeatable execution.
const { rmdirSync } = await import('node:fs'); rmdirSync(resolve(root, 'pip-junk'));
const diff = {files:[{path:'src/base.js',added:1,deleted:0}]};
check('C3 matched', 'DISCIPLINE-C3', make(textArt('tasks.md','- 修改 `src/base.js`'),{},diff), 'pass');
check('C3 missing declared', 'DISCIPLINE-C3', make(textArt('tasks.md','- 修改 `src/ghost.js`'),{},diff), 'fail');
check('C3 codeScopes explicit', 'DISCIPLINE-C3', make(textArt('tasks.md','- 修改 `src/base.js`'),{codeScopes:['src/']},{files:[...diff.files,{path:'tools/extra.js'}]}), 'pass');
const evidenceCtx = (evidence) => ({...make(), evidence});
check('nonempty tests', 'ACCEPT-E1', evidenceCtx({tests:{passed:1,failed:0}}), 'pass');
check('empty tests', 'ACCEPT-E1', evidenceCtx({tests:{passed:0,failed:0}}), 'fail');
check('all mutants killed', 'ACCEPT-E2', evidenceCtx({mutation:{killed:8,total:8,survived:[]}}), 'pass');
check('mutation under threshold', 'ACCEPT-E2', evidenceCtx({mutation:{killed:6,total:8,survived:['S1','S2']}}), 'fail');
check('zero drift', 'ACCEPT-E3', evidenceCtx({drift:{checks:1,findings:0}}), 'pass');
check('nonzero drift', 'ACCEPT-E3', evidenceCtx({drift:{checks:1,findings:1}}), 'fail');
for (const r of RULES.filter((r) => r.decidability === 'manual')) { const out = r.run(make()); assert.equal(out.status, 'manual'); cases.push({name:'manual remains manual',id:r.id,status:out.status}); }
console.log(JSON.stringify({
  cases,
  ruleCount: RULES.length,
  yagni: { validTable: valid.status, blankReasonTable: invalidTable.status, bareBullets: unreasoned.status, fencedHeading: fenced.status, fencedDetectedAsSection: Boolean(fencedSectionNode), bareBulletCount: bulletItems(bareBullets).length },
  nesting: { normalFourLevelMax: Math.max(...regularHits.map((h) => h.depth)), objectCloseOverLimitHits: objectHits.filter((h) => h.depth > 3).length, objectCloseReportedDepths: objectHits.map((h) => h.depth), compactLineHits: compactHits.length },
}, null, 2));