#!/usr/bin/env node
/**
 * 变异自证（2026-11-13）。
 *
 * 为什么需要它：一个"修复"如果只是把判据改红，而没证明**判据依赖那段实现**，
 * 那就无法排除"它本来就是红的"或"它红在别处"。三个条件缺一不可：
 *
 *   ① **变异体语法必须有效**（`node --check` 通过）——
 *      否则"变红"可能只是语法崩溃，而不是判据发现。
 *   ② **必须因目标判据变红**（而非崩溃/其他判据）——所以每条都收窄到 `--only <id>`。
 *   ③ **还原后必须回到基线**——否则无法归因。
 *
 * 每条变异有两种合法方向，取决于被测判据的"健康方向"：
 *   · `expectBase:'green'`：基线绿、变异后红 ⇒ 判据抓住了变异引入的缺陷。
 *   · `expectBase:'red'`  ：基线红（判据正常拒收坏输入）、变异后绿 ⇒
 *     判据依赖被改坏的那段实现。**这才是"计数域校验"这类判据的正确形态**：
 *     它们的目标是"让坏输入变红"，所以基线必然是红的。
 *
 * 运行：node _work/mutation-selfproof.mjs
 */

import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { writableTempRoot } from '../../lib/temp.mjs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve('.');
const COPY = ['lib', 'tools', 'cli.mjs', 'changes', 'guard.config.json', 'evidence.config.json', 'package.json'];

function sandbox() {
  const d = mkdtempSync(join(writableTempRoot(), 'sdd-mut-'));
  for (const p of COPY) {
    try {
      cpSync(join(ROOT, p), join(d, p), { recursive: true });
    } catch {
      /* 缺就跳过 */
    }
  }
  return d;
}

/**
 * 跑 CLI 并把输出写文件再读回（本机沙箱禁止 PIPE 捕获子进程输出）。
 * 返回 {status, text}。
 */
function runCaptured(dir, args, tag) {
  const of = join(dir, `${tag}.out.txt`);
  const fd = openSync(of, 'w');
  let r;
  try {
    // shell:false + fd 重定向：不经管道，也不经 cmd.exe 的参数转义
    r = spawnSync(process.execPath, args, { cwd: dir, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  return { status: r.status, text: readFileSync(of, 'utf8') };
}

const syntaxOk = (dir, f) => spawnSync(process.execPath, ['--check', f], { cwd: dir, stdio: 'ignore' }).status === 0;

/**
 * 变异规格。
 *
 * `probe` 返回 `{status, text}`；判定用 **诊断文案** 而不是只看退出码 ——
 * 因为两种失败可能都退 1，但**理由不同**。只看退出码会把
 * "判据按正确理由拒绝" 与 "判据因另一条守卫拒绝" 混为一谈。
 */
const MUTANTS = [
  {
    name: 'M1 配置值域退回不校验',
    file: 'lib/config.mjs',
    from: 'return { ok: errors.length === 0, errors };',
    to: 'return { ok: true, errors };',
    probe: (d, tag) => {
      writeFileSync(join(d, 'bad.json'), JSON.stringify({ maxNesting: 'garbage' }));
      return runCaptured(d, ['cli.mjs', 'check', '--change', 'changes/self-host-guard', '--config', 'bad.json', '--code', 'lib', '--only', 'KISS-C1'], tag);
    },
    /** 基线必须**提到配置非法**；变异后不再提（因为不校验了）。 */
    baseText: /配置文件有|maxNesting 必须是正整数/,
    mutatedText: /配置文件有|maxNesting 必须是正整数/,
    expectFlip: 'base matches, mutated does NOT',
    why: '非法配置基线被配置校验拦下并指明 maxNesting；变异后该校验消失 ⇒ 非法阈值放行（真实四层嵌套会被读成 PASS）',
  },
  {
    name: 'M2 drift 计数退回 Number() 隐式转换',
    file: 'lib/rules.mjs',
    from: "const cv = readCount(d, 'checks', 'evidence.drift');",
    to: 'const cv = { ok: true, value: Number(d.checks) };',
    probe: (d, tag) => {
      writeFileSync(
        join(d, 'ev.json'),
        JSON.stringify({
          tests: { passed: 1, failed: 0 },
          mutation: { killed: 1, total: 1, survived: [] },
          drift: { checks: -1, findings: 0 },
        }),
      );
      return runCaptured(
        d,
        ['cli.mjs', 'check', '--change', 'changes/self-host-guard', '--profile', 'acceptance', '--evidence', 'ev.json', '--repo', '.', '--only', 'ACCEPT-E3', '--code', 'lib'],
        tag,
      );
    },
    /** 基线必须报**计数域**错误；变异后变成**自洽性**错误 —— 理由变了，说明那道校验没了。 */
    baseText: /必须是非负整数/,
    mutatedText: /必须是非负整数/,
    expectFlip: 'base matches, mutated does NOT',
    why: 'checks=-1 基线由「必须是非负整数」拦下；变异后该理由消失、退化成「findings>checks」⇒ 证明计数域校验真在起作用',
  },
  {
    name: 'M3 嵌套退回"数所有花括号"（对象也计层）',
    file: 'lib/code.mjs',
    from: "if (kind !== 'obj') state.ctrl += 1;",
    to: 'state.ctrl += 1;',
    probe: (d, tag) =>
      runCaptured(d, ['cli.mjs', 'check', '--change', 'changes/self-host-guard', '--code', 'lib', '--only', 'KISS-C1'], tag),
    baseText: /深度 [4-9] > 3/,
    mutatedText: /深度 [4-9] > 3/,
    expectFlip: 'base does NOT match, mutated DOES',
    why: '本项目源码基线无超限嵌套；把对象也计层后出现大量「深度 N > 3」误红 ⇒ 证明"对象不计层"这条语义真在起作用',
  },
  {
    name: 'M4 import 提取退回不算注释',
    file: 'lib/code.mjs',
    from: 'const code = stripComments(text);',
    to: 'const code = text;',
    probe: (d, tag) => {
      writeFileSync(join(d, 'lib', 'probe-decouple.js'), '/*\nimport x from "../backend/private.js";\n*/\n');
      writeFileSync(
        join(d, 'g.json'),
        JSON.stringify({ boundaries: { front: ['lib/'], back: ['backend/'] }, forbidImports: [['front', 'back']] }),
      );
      return runCaptured(
        d,
        ['cli.mjs', 'check', '--change', 'changes/self-host-guard', '--config', 'g.json', '--repo', '.', '--code', 'lib', '--only', 'DECOUPLE-2'],
        tag,
      );
    },
    baseText: /处跨边界直接引用/,
    mutatedText: /处跨边界直接引用/,
    expectFlip: 'base does NOT match, mutated DOES',
    why: '注释里的 import 基线不得报跨边界引用；变异后出现「1 处跨边界直接引用」假红 ⇒ 证明注释剔除真在生效',
  },
];

let bad = 0;
for (const m of MUTANTS) {
  const d = sandbox();
  try {
    const target = join(d, m.file);
    const orig = readFileSync(target, 'utf8');
    if (!orig.includes(m.from)) {
      console.log(`  UNEXECUTED ${m.name}\n        找不到注入点（源码已变）：${m.from.slice(0, 60)}`);
      bad++;
      continue;
    }
    const base = m.probe(d, 'base');
    writeFileSync(target, orig.replace(m.from, m.to));
    const synOk = syntaxOk(d, m.file);
    const mutated = m.probe(d, 'mut');
    writeFileSync(target, orig);
    const restored = m.probe(d, 'restore');

    const baseHit = m.baseText.test(base.text);
    const mutHit = m.mutatedText.test(mutated.text);
    const restoreHit = m.baseText.test(restored.text);
    // 翻转方向：green→red 是"基线不匹配、变异匹配"；red→green 反之。
    const flipped = m.expectFlip.startsWith('base matches') ? baseHit && !mutHit : !baseHit && mutHit;
    const restoreOk = restored.status === base.status && restoreHit === baseHit;
    const ok = synOk && flipped && restoreOk;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m.name}`);
    console.log(`        语法有效=${synOk} 基线命中理由=${baseHit}(exit ${base.status}) 变异后命中=${mutHit}(exit ${mutated.status}) 还原后命中=${restoreHit}(exit ${restored.status})`);
    console.log(`        ${m.why}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('');
if (bad) {
  console.log(`${bad}/${MUTANTS.length} 个变异未通过自证（语法有效 / 理由翻转 / 还原复归 三项须同时成立）`);
} else {
  console.log(`全部 ${MUTANTS.length} 个变异：语法有效 → 诊断理由按目标判据翻转 → 还原复归  ✓`);
}
process.exit(bad ? 1 : 0);
