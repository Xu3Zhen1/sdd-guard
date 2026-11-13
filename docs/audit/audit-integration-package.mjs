import {mkdirSync,openSync,closeSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const dir=resolve(process.argv[2]); const unpack=join(dir,'unpack');mkdirSync(unpack,{recursive:true});
function run(id,exe,args,cwd){const log=join(dir,id+'.log');const fd=openSync(log,'w');const r=spawnSync(exe,args,{cwd,stdio:['ignore',fd,fd]});closeSync(fd);const text=readFileSync(log,'utf8');console.log(JSON.stringify({id,status:r.status,tail:text.trim().split(/\r?\n/).slice(-6)}));return r.status;}
if(run('unpack','tar',['-xzf',join(dir,'sdd-guard-0.1.0.tgz'),'-C',unpack],dir)!==0)process.exit(1);
const pkg=join(unpack,'package');const present={test:existsSync(join(pkg,'test')),changes:existsSync(join(pkg,'changes')),workflow:existsSync(join(pkg,'.github/workflows/ci.yml'))};console.log(JSON.stringify(present));
run('packed-help',process.execPath,['cli.mjs','--help'],pkg);
run('packed-contract',process.execPath,['tools/check-contract.mjs'],pkg);
run('packed-selfcheck',process.execPath,['tools/self-check.mjs'],pkg);
writeFileSync(join(dir,'package-presence.json'),JSON.stringify(present,null,2));
