import { cpSync, readdirSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, '_work/tmp/audit-integration-' + Date.now());
const copy = join(out, 'repo');
mkdirSync(copy, { recursive:true });
for (const name of readdirSync(root)) { if (['_work','.git','node_modules','.selfcheck','.evidence-raw','evidence.json'].includes(name)) continue; cpSync(join(root,name),join(copy,name),{recursive:true}); }
const results=[];
function run(id,args,cwd=copy,bin=process.execPath) {
 const log=join(out,id+'.log'); const fd=openSync(log,'w');
 const r=spawnSync(bin,args,{cwd,stdio:['ignore',fd,fd],env:{...process.env,TMP:join(root,'_work/tmp'),TEMP:join(root,'_work/tmp')}}); closeSync(fd);
 const text=readFileSync(log,'utf8'); const value={id,status:r.status,error:r.error?.message,tail:text.trim().split(/\r?\n/).slice(-8),log:relative(root,log).replaceAll('\\','/')}; results.push(value); console.log(JSON.stringify(value)); return {status:r.status,text};
}
const sc=join(copy,'tools/self-check.mjs'), cli=join(copy,'cli.mjs'), runner=join(copy,'lib/runner.mjs');
const sc0=readFileSync(sc,'utf8'), cli0=readFileSync(cli,'utf8'), runner0=readFileSync(runner,'utf8');
assert.equal(run('baseline-contract',['tools/check-contract.mjs']).status,0);
assert.equal(run('baseline-selfcheck',['tools/self-check.mjs']).status,0);
const changed=cli0.replace('if (coverageFail) process.exit(EXIT.INCOMPLETE);','if (coverageFail) process.exit(EXIT.FAIL);'); assert.notEqual(changed,cli0);writeFileSync(cli,changed); console.log('MUTATION_APPLIED=coverage-3-to-1');assert.equal(run('coverage-syntax',['--check','cli.mjs']).status,0);
assert.equal(run('coverage-mutant-selfcheck',['tools/self-check.mjs']).status,0);
assert.notEqual(run('coverage-mutant-q45',['test/q4-5-exit-signal.test.mjs']).status,0);writeFileSync(cli,cli0);
const sc1=sc0.replace("steps.push(run('publish', 'node tools/check-publish.mjs'));","// steps.push(run('publish', 'node tools/check-publish.mjs')); "); assert.notEqual(sc1,sc0);writeFileSync(sc,sc1);console.log('MUTATION_APPLIED=publish-call-commented');assert.equal(run('comment-syntax',['--check','tools/self-check.mjs']).status,0);assert.equal(run('comment-mutant-contract',['tools/check-contract.mjs']).status,0);const commentRun=run('comment-mutant-selfcheck',['tools/self-check.mjs']);assert.equal(commentRun.status,0);assert.ok(!commentRun.text.includes('PASS  publish'));writeFileSync(sc,sc0);
const r1=runner0.replace('INCOMPLETE: 3','INCOMPLETE: 1'); assert.notEqual(r1,runner0);writeFileSync(runner,r1);console.log('MUTATION_APPLIED=runner-incomplete-1');assert.equal(run('exit-syntax',['--check','lib/runner.mjs']).status,0);assert.equal(run('exit-mutant-contract',['tools/check-contract.mjs']).status,0);writeFileSync(runner,runner0);
assert.equal(run('restored-selfcheck',['tools/self-check.mjs']).status,0);
// True CLI process checks, with independent expected exit codes.
const empty=join(out,'empty'); mkdirSync(empty); 
const base=['cli.mjs','check','--change',empty,'--repo',empty,'--json'];
assert.equal(run('empty-default',base).status,0);assert.equal(run('empty-coverage',[...base,'--min-coverage','0.8']).status,3);
const missingCode=run('missing-code-value',[...base,'--code']); assert.equal(missingCode.status,1); assert.match(missingCode.text,/TypeError/);
// File root exclusion in self-check defaults.
const { runRules }=await import(new URL('../lib/runner.mjs',import.meta.url));
const defaultRoots=['lib','tools','cli.mjs'].map(p=>join(root,p));
const real=runRules({changeDir:empty,repo:root,cwd:root,codeRoots:defaultRoots,only:['KISS-C1']});
assert.ok(existsSync(join(root,'cli.mjs')));assert.ok(!real.ctx.codeFiles.includes(join(root,'cli.mjs')));console.log('SELF_CHECK_DEFAULT_CLI_SCANNED=false files='+real.ctx.codeFiles.length);
writeFileSync(join(out,'results.json'),JSON.stringify({results,cliScanned:false,codeFiles:real.ctx.codeFiles.map(p=>relative(root,p)),copyRestored:readFileSync(cli,'utf8')===cli0&&readFileSync(sc,'utf8')===sc0&&readFileSync(runner,'utf8')===runner0},null,2));
console.log('RESULT_DIR='+relative(root,out).replaceAll('\\','/'));
