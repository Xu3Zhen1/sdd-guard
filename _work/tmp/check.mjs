
import * as m from '../../lib/rules.mjs';
console.log('looksLikePath(ghost--probe.js) =', m.looksLikePath('src/export/ghost--probe.js'));
console.log('looksLikePath(extless/index)   =', m.looksLikePath('src/export/extless/index'));
console.log('extractPaths(extless/index)    =', JSON.stringify(m.extractPaths('`src/export/extless/index`')));
const cmd = 'node tools/build.mjs "src/export/ghost probe.js"';
console.log('splitCommandPaths(with space)  =', JSON.stringify(m.splitCommandPaths(cmd)));
