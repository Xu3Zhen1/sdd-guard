
import { extractPaths } from '../lib/rules.mjs';
const q = (s) => '\u0060' + s + '\u0060';
const design = ['# 设计','','## 复用清单','','- ' + q('src/export/does-not-exist/index') + ' —— 幻想复用','','## 接口契约','','- ' + q('shared/api/export.json'),''].join('\n');
console.log('extractPaths all:', JSON.stringify(extractPaths(design)));
const sec = design.split('## 复用清单')[1].split('## 接口契约')[0];
console.log('clause:', JSON.stringify(sec));
console.log('extractPaths clause:', JSON.stringify(extractPaths(sec)));
