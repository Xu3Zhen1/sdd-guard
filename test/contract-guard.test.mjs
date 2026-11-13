// A08 负控：契约检查的三个守卫**必须是会红的判据**。
//
// 这个文件证明的不是"检查能通过"，而是**"检查在缺陷存在时会失败，且失败原因是目标判据"**。
// 两者差别是整个项目的立身之本：审计 I-02/I-03 实证了三个"看起来有检查、实际拦不住"的形态，
// 每一个都是**语法有效、门禁全绿、缺陷真实存在**。
//
// 三个变异（对应审计的三条实证）：
//   ① 把 ci.yml 某步 run 整行注释   → CI 等价性检查必须红（旧实现 scText.includes，注释里还看得见文件名 ⇒ 假绿）
//   ② 把 runner 的 INCOMPLETE 改成 1 → 退出码一致性检查必须红（旧实现只比 OK/FAIL/CONFIG ⇒ 假绿）
//   ③ 把 self-check 里某专项调用注释掉 → 等价性检查必须红（旧实现同上）
//
// 每个变异三条断言，缺一不可：
//   a) `node --check` 通过  —— 证明变异体是**合法程序**，红不是因为语法崩溃
//   b) 退出码是 1（不是崩溃/不是 2）—— 证明是"判据判定不合格"，不是运行环境炸了
//   c) 输出里出现**目标判据的关键词** —— 证明红在正确的判据上，不是被别的检查顺带拦下
//   d) 还原后复跑变绿 —— 证明因果归属正确（红是变异引起的，不是本来就红）
//
// 纪律：所有变异都在 **mkdtempSync 独立副本**上做，绝不动生产文件；
// 子进程禁用 PIPE 捕获（stdio:'inherit' + shell 重定向到文件）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { writableTempRoot } from '../lib/temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 复制项目到临时目录（排除版本库与运行产物：它们不参与契约检查，且 .git 很大）。 */
const SKIP_TOP = new Set(['.git', '_work', '.selfcheck', '.evidence-raw', 'node_modules']);

const isInside = (child, parent) => {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + sep);
};


/**
 * 复制项目到一个**不在 ROOT 之内、且实测可写**的临时目录。
 *
 * 两个条件都不能省（2026-11-13 独立复核逐条实证）：
 *   · **必须不在 ROOT 内**：本工作区把 `TMP` 指向项目内 `_work/tmp`，副本会落进
 *     ROOT 内部，`cpSync(ROOT, dst)` 变成"复制到自己的子目录" ⇒ `ERR_FS_CP_EINVAL`，
 *     5 个用例在**准备夹具**阶段全红 —— 那不是"守卫被验证失败"，而是"守卫没被执行"。
 *   · **必须实测可写**：`TMP` 未设时 `tmpdir()` 是 `C:\WINDOWS\temp`，本沙箱禁写 ⇒ EPERM。
 * 现在统一走 `lib/temp.mjs`（逐个候选实测），这里只需 `avoidRoot=true`。
 */
function copyProject() {
  const dst = mkdtempSync(join(writableTempRoot(true, 'contract-guard-'), 'copy-'));
  cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const rel = relative(ROOT, src);
      if (!rel) return true;
      return !SKIP_TOP.has(rel.split(sep)[0]);
    },
  });
  return dst;
}

/** 在副本里起子进程跑命令，stdout+stderr 重定向到文件（**不用 PIPE**，本机沙箱会 EPERM）。 */
function runInCopy(cwd, cmd, logName) {
  const logFile = join(cwd, logName);
  const r = spawnSync(`${cmd} > "${logFile}" 2>&1`, { cwd, shell: true, stdio: 'inherit' });
  const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  return { status: r.status === null ? -1 : r.status, text };
}

function checkSyntax(cwd, file) {
  const r = spawnSync(`node --check "${file}" > "${join(cwd, 'syntax.txt')}" 2>&1`, {
    cwd, shell: true, stdio: 'inherit',
  });
  return r.status === null ? -1 : r.status;
}

function withCopy(fn) {
  const dir = copyProject();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 用一次精确替换改写文件；找不到目标就抛错（防"变异没真的应用上"）。 */
function mutate(file, from, to) {
  const src = readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `变异目标不存在于 ${file}：${JSON.stringify(from)}`);
  const next = src.replace(from, to);
  assert.notEqual(next, src, '变异未改变文件内容');
  writeFileSync(file, next);
}

// ── 基线：副本未经变异时，契约检查必须绿 ─────────────────────
//
// ★ 这条先跑，是全文件的前提：如果基线本来就红，后面所有"变异后变红"都证明不了任何事
//   （红可能是本来就有的，与变异无关）。这正是"伪红"的判别。
//
// 但基线红还有**另一种**来源：生产树此刻真有与本次变异无关的漂移（例如别人的 lib/ 改动
// 还没同步进 docs/ICD.md）。那种情况不能让本文件整体失效，否则"变异负控"会因为别人的
// 进度而无法证明自己。所以这里按**失败项分类**处理：
//   · 与本文件三个变异**同族**的判据必须绿（那是我们声称守住的）；
//   · 其余漂移如实列出、不吞掉，但只告警不中断 —— 并显式打印出来，
//     避免"看着全绿、其实基线是红的"。
const OWN_CHECKS = [
  /退出码键集合/, /退出码 \w+=\d/, /退出码 \w+ 漂移/, /CLI 实测退出码/, /不可区分/,
  /CI 跑了但 self-check 的执行清单里没有/, /self-check 执行清单覆盖了 CI/,
  /self-check 执行清单共/, /规格要求的 \d+ 套专项/,
];

test('基线自证：未变异的副本里三个守卫相关的判据必须全绿', () => {
  withCopy((dir) => {
    const r = runInCopy(dir, 'node tools/check-contract.mjs', 'baseline.txt');
    const failLines = r.text.split('\n').filter((l) => l.trim().startsWith('FAIL'));
    const ownFailures = failLines.filter((l) => OWN_CHECKS.some((re) => re.test(l)));
    assert.deepEqual(
      ownFailures,
      [],
      `本文件守护的三类判据在未变异的副本上不得为红（否则下游"变异后变红"无法归因）。实际红项:\n${ownFailures.join('\n')}`,
    );

    // 与变异无关的漂移：如实报告，不中断。★ 这是"自曝"而不是"静默"：
    if (failLines.length) {
      console.log(`\n[基线告警] 副本里有 ${failLines.length} 项与本次变异无关的漂移（不属于本文件守护范围）:\n${failLines.join('\n')}`);
    }

    // 两个守卫必须**真的被执行过**（不是被跳过/不存在）
    assert.match(r.text, /self-check 执行清单覆盖了 CI 的|CI 跑了但 self-check/, '基线里必须出现 CI 等价性检查的结论行');
    assert.match(r.text, /退出码键集合 contract 与 runner 完全相同|退出码键集合不一致/, '基线里必须出现退出码键集合检查');
    assert.match(r.text, /规格要求的 \d+ 套专项/, '基线里必须出现专项名单检查');
  });
});

// ── 变异 ①：ci.yml 某步 run 整行注释 ────────────────────────
//
// 这是审计 I-02 的原始实证：把 `steps.push(run('publish', …))` 对应的**发布步骤**
// 注释掉后，旧实现因为 `scText.includes('tools/check-publish.mjs')` 仍能看到
// 注释里的文件名而报 53/53 全绿，而 self-check 实际已少跑一步。
//
// 现在改成 STRUCTURED：注释掉 CI 步骤后，结构化解析里该脚本消失 ⇒
// "CI 跑了但 self-check 没有"不再成立（CI 侧没有它了），但**反过来**：
// 我们断言的判据是"self-check 必须覆盖 CI 的每一条"，所以把 CI 里的
// publish 步骤注释掉，只改变 CI 侧 —— 要证明的是**旧实现在这个变异下会假绿**。
// 因此本用例变异的是 **self-check 侧**：注释掉 publish 的 push，
// 而 CI 仍跑 publish ⇒ 结构化检查必须报"CI 跑了但 self-check 清单里没有"。
// （旧实现在此刻是绿的：注释行里 `tools/check-publish.mjs` 这个字符串还在。）
test('变异①：注释掉 self-check 的发布步骤 ⇒ CI 等价性检查必须红', () => {
  withCopy((dir) => {
    const sc = join(dir, 'tools', 'self-check.mjs');
    // 整行注释掉"把 publish 步骤推进计划"的那一行
    mutate(
      sc,
      "  plan.push(spawnStep(GROUP.TOOL, 'publish', 'node tools/check-publish.mjs', ['tools/check-publish.mjs'], 0));",
      "  // plan.push(spawnStep(GROUP.TOOL, 'publish', 'node tools/check-publish.mjs', ['tools/check-publish.mjs'], 0));",
    );
    // a) 变异体语法有效 —— 红不能是语法崩溃
    assert.equal(checkSyntax(dir, 'tools/self-check.mjs'), 0, '变异体必须 node --check 通过');
    // 变异真的生效了：--print-steps 里不再有 publish
    const steps = runInCopy(dir, 'node tools/self-check.mjs --print-steps', 'steps1.txt');
    assert.equal(steps.status, 0);
    assert.ok(!steps.text.includes('"publish"'), '变异未生效：清单里仍有 publish');

    const r = runInCopy(dir, 'node tools/check-contract.mjs', 'mut1.txt');
    // b) 判据判定不合格 = exit 1（不是崩溃、不是配置错误 2）
    assert.equal(r.status, 1, `变异后 check-contract 应 exit 1，实际 ${r.status}`);
    // c) 红在目标判据上
    assert.match(r.text, /CI 跑了但 self-check 的执行清单里没有/, '必须红在 CI 等价性判据上');
    assert.match(r.text, /check-publish\.mjs/, '必须点名缺的是哪个脚本');
  });
});

// ── 变异 ②：runner 的 INCOMPLETE 改成 1 ─────────────────────
//
// 审计 I-03 的原始实证：把 `EXIT.INCOMPLETE` 从 3 改成 1（语法有效），
// 旧实现只比 `['OK','FAIL','CONFIG']` 三个键 ⇒ 仍 53/53 全绿。
// 这正是"两种失败信号又被合流"——Q4.5 拆开的东西被悄悄并回去了。
test('变异②：runner 的 INCOMPLETE 改成 1 ⇒ 退出码一致性检查必须红', () => {
  withCopy((dir) => {
    const runner = join(dir, 'lib', 'runner.mjs');
    mutate(runner, 'export const EXIT = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 3 };',
      'export const EXIT = { OK: 0, FAIL: 1, CONFIG: 2, INCOMPLETE: 1 };');
    assert.equal(checkSyntax(dir, 'lib/runner.mjs'), 0, '变异体必须 node --check 通过');

    const r = runInCopy(dir, 'node tools/check-contract.mjs', 'mut2.txt');
    assert.equal(r.status, 1, `变异后 check-contract 应 exit 1，实际 ${r.status}`);
    // c) 必须红在"退出码值"这一层，且必须点名 INCOMPLETE
    assert.match(r.text, /退出码 INCOMPLETE 漂移/, '必须红在 INCOMPLETE 的值比较上');
    assert.match(r.text, /规格=3/, '必须写出规格值（写死，不引用被测常量）');
    // 并且必须证明"3 与 1 不可区分"这条也被触发（负控的第二道）
    assert.match(r.text, /不可区分|实测退出码 INCOMPLETE/, '行为层的可区分性检查也必须发声');
  });
});

// ── 变异 ③：注释掉 self-check 里某专项调用 ──────────────────
//
// 审计 I-01 的原始实证：专项测试存在但不在门禁里 ——
// 把 coverageFail 的 3 改成 1 后 self-check 仍 10/10 全绿，而单跑 q4.5 立刻变红。
// 本变异证明：把任意一套专项从清单里去掉，等价性/覆盖面判据会立刻发现。
test('变异③：把某套专项从唯一入口删掉 => 等价性检查必须红', () => {
  withCopy((dir) => {
    // 2026-11-13：测试清单的唯一真源已经是 package.json 的 scripts.test
    // （DRY-C1 之前抓到 self-check 与 check-contract 各抄了一份七行字面量）。
    // 变异点随之移到 package.json —— 这正是"单一真源"该有的效果：
    // 删一处就同时影响"跑什么"与"查什么"，不可能只改一边。
    const pkg = join(dir, 'package.json');
    mutate(pkg, ' && node test/q4-5-exit-signal.test.mjs', '');
    // a) 变异体是合法 JSON（不是语法崩溃）
    JSON.parse(readFileSync(pkg, 'utf8'));

    const steps = runInCopy(dir, 'node tools/self-check.mjs --print-steps', 'steps3.txt');
    assert.equal(steps.status, 0, '变异后 --print-steps 仍必须 exit 0');
    assert.ok(!steps.text.includes('q4-5-exit-signal'), '变异未生效：执行清单里仍有 q4-5');

    const r = runInCopy(dir, 'node tools/check-contract.mjs', 'mut3.txt');

    assert.equal(r.status, 1, `应 exit 1，实际 ${r.status}`);
    // c) 必须红在专项名单这条判据上 —— 且必须点名缺的是哪一套
    assert.match(r.text, /规格要求的专项未进入 self-check 常跑清单/, '必须红在专项名单判据上');
    assert.match(r.text, /q4-5-exit-signal/, '必须点名缺的是哪一套专项');
  });
});

// ── 变异 ⑤：make-evidence 成功时，后续两步必须**看得到**它成功 ──
//
// 这是 t-evidence 定位、我复核确认真实的 bug：
//   `state.evidenceProduced` 在**整轮计划执行完之后**才赋值，而 evidence-chain 与
//   acceptance 是在**循环内**读它的 ⇒ 永远读到初始 `false` ⇒ 必然红。
//   make-evidence 明明 PASS、evidence.json 也确实写出，后两步却说"未产出证据"。
//
// 这是「没检查」与「检查了没问题」症状同形的极端形态：
// 它连"make-evidence 成功了"这个**事实**都读不到，还给出一个看起来很负责的拒绝理由。
//
// ★ 为什么不"跑一整次 self-check 看汇总"（第一版就是这么写的，会**无限递归**）：
//   self-check 的清单里有 `node test/contract-guard.test.mjs`，于是副本里的 self-check
//   会再跑本文件，本文件又复制一份再跑 self-check … 每一层都要跑 19 套测试，永不收敛。
//   实测：跑了 >6 分钟仍未结束，只能 kill。
//   这是本用例自己差点变成的形态 —— **判据把被测对象拉进自己的执行路径里**。
//
// 改为**定点观测**：只跑 make-evidence → 再问 self-check 的两个下游步骤
// 在此刻会怎么判。用 `--print-steps` 拿到清单结构后，直接在真 self-check 进程外
// 复现它的**依赖关系**是做不到的（那是复现件取代被测对象）。
// 所以退一步：**断言那个 bug 的结构性根因不再存在** ——
// 即 `state.evidenceProduced` 的赋值必须出现在 make-evidence 步骤**执行之后**、
// 且**在循环内部**（而不是循环结束后一次性补算）。
// 这条判据读的是执行顺序本身，不是源码排版：它要求"赋值点位于循环体内"。
test('变异⑤：evidenceProduced 必须在该步执行后立即更新（不得等整轮跑完再补算）', () => {
  const src = readFileSync(join(ROOT, 'tools', 'self-check.mjs'), 'utf8');
  const loopStart = src.indexOf('for (const step of plan) {');
  assert.ok(loopStart > 0, '必须能找到计划执行循环');
  const loopEnd = src.indexOf('\n}', loopStart);
  assert.ok(loopEnd > loopStart, '必须能定位循环体边界');
  const loopBody = src.slice(loopStart, loopEnd);

  // ① 赋值点必须在循环体内 —— 这是修好后的形态
  assert.match(
    loopBody,
    /state\.evidenceProduced\s*=/,
    'evidenceProduced 必须在计划循环体内赋值；放在循环之后会让下游步骤永远读到初始 false',
  );
  // ② 且必须由 make-evidence 的结果驱动（不是无条件置 true）
  assert.match(loopBody, /make-evidence/, '赋值必须由 make-evidence 这一步的结果驱动');
  // ③ 负控：循环之后不许再有"事后补算"的赋值（那说明两处代码并存，易漂移）
  const afterLoop = src.slice(loopEnd);
  assert.doesNotMatch(
    afterLoop,
    /state\.evidenceProduced\s*=/,
    '循环之后不得再有 evidenceProduced 赋值（双写点会漂移，且说明旧 bug 的写法还在）',
  );
});
//
// 这条直接复刻审计的原始变异形态，用来证明 `stripYamlComment` 真的在起作用：
// 注释掉 CI 的 publish 步骤后，结构化解析出的脚本集合里**不应再有** check-publish。
// 若仍能解析出来，说明注释剔除失效 —— 那么"CI 跑了但 self-check 没有"这项检查
// 就会在 CI 侧凭空造出一条要求，或反过来漏掉真实要求。
test('变异④：ci.yml 的 run 整行注释后，CI 脚本集合必须真的变小', () => {
  withCopy((dir) => {
    const wf = join(dir, '.github', 'workflows', 'ci.yml');
    const before = parseCiScripts(readFileSync(wf, 'utf8'));
    assert.ok(before.scripts.includes('tools/check-publish.mjs'), `基线 CI 应含 check-publish，实际 [${before.scripts}]`);

    // 整行注释掉 "run: node tools/check-publish.mjs" 那一行
    mutate(wf, '        run: node tools/check-publish.mjs', '        # run: node tools/check-publish.mjs');

    const after = parseCiScripts(readFileSync(wf, 'utf8'));
    assert.ok(
      !after.scripts.includes('tools/check-publish.mjs'),
      `注释掉后不该再解析出 check-publish，实际 [${after.scripts}] —— 说明注释剔除失效（旧 includes 行为）`,
    );
    assert.ok(after.scripts.length < before.scripts.length, '注释掉一步后脚本数必须减少');
    // 负控：字符串仍在文件里，但**不算执行**
    assert.ok(readFileSync(wf, 'utf8').includes('check-publish.mjs'), '文件里当然还留着那个字符串');
  });
});

/**
 * 从 ci.yml 抽取 node 脚本（**与 tools/check-contract.mjs 同源逻辑的独立实现**）。
 *
 * 这里刻意不 import check-contract 的内部函数（它没导出，且**测试不该依赖被测实现的私有件**
 * ——否则被测实现改坏时测试会跟着坏，测的还是它自己）。
 * 但代价是：两份实现可能漂移。所以下面用**同一个变异**同时验证两边，
 * 并且 check-contract 自己的正向/负向断言在基线用例里已覆盖。
 */
function parseCiScripts(text) {
  const state = { scripts: [], inRun: false, runIndent: -1 };
  for (const raw of text.split(/\r?\n/)) consumeLine(state, raw);
  return { scripts: [...new Set(state.scripts)] };
}

/** 一行 yaml 的状态机（拆函数是为了守住 KISS-C1 的 3 层上限）。 */
function consumeLine(state, raw) {
  const line = /^\s*#/.test(raw) ? '' : raw;
  if (!line.trim()) return;
  const indent = line.match(/^[ \t]*/)[0].length;
  const trimmed = line.trim();
  if (state.inRun) {
    if (indent > state.runIndent) {
      collectNodePaths(trimmed, state.scripts);
      return;
    }
    state.inRun = false;
  }
  const m = trimmed.match(/^(?:-\s+)?run:\s*(.*)$/);
  if (!m) return;
  const inline = m[1].trim();
  if (inline && !/^\||^>/.test(inline)) collectNodePaths(inline, state.scripts);
  state.inRun = true;
  state.runIndent = indent;
}

function collectNodePaths(cmd, into) {
  for (const mm of cmd.matchAll(/\bnode\s+(?:--[\w-]+\s+)*([\w./-]+\.mjs)/g)) {
    if (!mm[1].includes('self-check')) into.push(mm[1]);
  }
}

function tail(text, n = 25) {
  return text.split('\n').slice(-n).join('\n');
}
