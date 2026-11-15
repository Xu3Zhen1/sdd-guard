// 代码树身份（head + dirty）的唯一采集入口。
//
// 为什么单独成模块：
//   ① **必须只有一处实现** —— 生产和校验若各写一份，一定会漂移；
//      而漂移在这种"身份核对"上是致命的（校验用 A 规则、生产用 B 规则，
//      两者永不一致，于是提示永远亮或永远不亮）。
//   ② 判据侧（rules）与工具侧（make-evidence）都要看同一个字段 `meta.tree`，
//      它们必须按完全相同的语义读。
//
// ★ 纪律一：**只读取来比对，不据此判定**。
//   `meta.tree` 的定位是审计元数据，不是认证（见 ICD §5.2）。
//   本模块提供的是"证据记的是哪个树"这个事实，**是否因此判红由调用方决定**。
//   当前实现里没有任何判据因 tree 不一致而 FAIL —— 那是刻意的。
//
// ★ 纪律二：**拿不到就明说拿不到**。
//   git 不可用 / 不是仓库 / 输出不合形，一律返回 `{available:false, reason}`，
//   绝不返回"看起来像干净树"的默认值。这份证据有没有绑定到提交，
//   是一个可判定的事实，不能靠沉默掩盖。
//
// ★ 纪律三：**脏树也算身份的一部分**。
//   同一提交、工作树脏，与同一提交、工作树干净，跑出来的结论可能不同。
//   只比 head 而忽略 dirty，会让"在未提交的改动上跑出来的绿"冒充该提交的绿。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempSync } from './temp.mjs';

/** 提交号形状：40 位 SHA-1 或 64 位 SHA-256。 */
const SHA_RE = /^[0-9a-f]{40,64}$/;

function digestOfText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 跑 git 并把 stdout 收进临时文件。
 *
 * 为什么不用 `stdio:'pipe'`：在受限沙箱里，子进程拿不到命名管道，
 * 用 PIPE 捕获输出会得到 `spawn EPERM`，而 `spawnSync` 会返回
 * `status:null` + `error`。重定向到文件可以完全绕开这条限制，
 * 且行为在 Windows / Linux 上一致。
 *
 * @returns {{ok:true,text:string}|{ok:false,reason:string}}
 */
function gitToFile(repo, args, outFile) {
  // 参数全部由本模块构造，不含外部输入；git 子命令固定，无注入面。
  const cmd = `git ${args.map((a) => `"${a}"`).join(' ')}`;
  const r = spawnSync(`${cmd} > "${outFile}" 2>&1`, { cwd: repo, shell: true, stdio: 'inherit' });
  if (r.error) return { ok: false, reason: `git 不可用: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `git ${args.join(' ')} 退出码 ${r.status}` };
  let text;
  try {
    text = readFileSync(outFile, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读取 git 输出失败: ${e.message}` };
  }
  return { ok: true, text };
}

/**
 * 采集代码树身份。
 *
 * 返回结构（与 evidence.json 的 `meta.tree` 完全一致）：
 *   { available:true,  head, headShort, dirty, dirtyCount, statusSha256, statusSample }
 *   { available:false, reason }
 *
 * `statusSha256` 是**工作树状态**的指纹：即使 head 相同，
 * 两次脏的内容不同也会得到不同指纹。没有它，"脏"只是一个布尔值，
 * 无法区分"脏的是同一批文件"还是"脏的是另一批"。
 *
 * @param {string} repo 仓库根
 * @param {string} scratchDir 临时目录（调用方负责清理）
 */
export function treeIdentity(repo, scratchDir) {
  const headFile = join(scratchDir, 'git-head.txt');
  const statusFile = join(scratchDir, 'git-status.txt');

  const head = gitToFile(repo, ['rev-parse', 'HEAD'], headFile);
  if (!head.ok) return { available: false, reason: head.reason };

  const sha = head.text.trim();
  if (!SHA_RE.test(sha)) {
    return { available: false, reason: `git rev-parse HEAD 输出不像提交号: ${JSON.stringify(sha.slice(0, 80))}` };
  }

  const st = gitToFile(repo, ['status', '--porcelain'], statusFile);
  if (!st.ok) return { available: false, reason: `无法读取工作树状态: ${st.reason}` };

  const dirtyLines = st.text.split('\n').filter((l) => l.trim());
  return {
    available: true,
    head: sha,
    headShort: sha.slice(0, 7),
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    statusSha256: digestOfText(st.text),
    statusSample: dirtyLines.slice(0, 12),
  };
}

/**
 * 在任意仓库上采集身份（自建临时目录，用完即删）。
 * 给"我现在这个仓库是什么状态"用；不带任何写入语义。
 *
 * ★ 复用 `lib/temp.mjs` 的 `withTempSync` 而不是自己写 try/finally：
 *   第一版内联了同样的 rmSync 清理块，**当场被本项目自己的 DRY-C1 判红**
 *   （lib/temp.mjs:92 ↔ lib/tree.mjs:116 跨文件重复 6 行）。
 *   判据抓得对——临时目录的清理语义应该只有一处实现。
 */
export function readTreeIdentity(repo) {
  try {
    return withTempSync((dir) => treeIdentity(repo, dir), 'sdd-guard-tree-');
  } catch (e) {
    return { available: false, reason: `采集代码树身份失败: ${e.message}` };
  }
}

/**
 * 比对"证据记录的树"与"当前代码树"，返回一条**仅供人读**的提示。
 *
 * ★ 这个函数的返回值**不参与任何退出码计算**。
 *   它回答的是"你看的这份结论，是在哪棵树上得出的"，
 *   而不是"这份结论对不对"——后者是判据的事。
 *
 * 四种情况，每种都必须给出**可区分**的文案（不能统一说"可能过期"）：
 *   · 证据没有树身份         ⇒ 说清原因，不假装已绑定
 *   · 当前树不可读           ⇒ 说清无法比对，不假装一致
 *   · head 不一致            ⇒ 点名两边提交，提示结论属于旧树
 *   · head 一致但脏度不同    ⇒ 提示同一提交上工作树状态不同
 *
 * @param {object|null} recorded  evidence.meta.tree
 * @param {object} current        readTreeIdentity() 的结果
 * @returns {{level:'none'|'unknown'|'stale'|'dirty-drift'|'same', text:string}}
 */
export function compareTree(recorded, current) {
  if (!recorded || typeof recorded !== 'object') {
    return { level: 'none', text: '证据未记录代码树身份（旧格式或未生成 meta.tree），无法判断结论属于哪个提交' };
  }
  if (recorded.available !== true) {
    const why = recorded.reason ? `：${recorded.reason}` : '';
    return { level: 'none', text: `证据声明代码树身份不可用${why}，该结论未绑定任何提交` };
  }
  if (!current || current.available !== true) {
    const why = current && current.reason ? `：${current.reason}` : '';
    return { level: 'unknown', text: `当前代码树身份读取失败${why}，无法判断证据是否过期` };
  }

  const recHead = String(recorded.head || '');
  const curHead = String(current.head || '');
  if (recHead !== curHead) {
    return {
      level: 'stale',
      text:
        `证据产自 ${recHead.slice(0, 7)}，当前代码树为 ${curHead.slice(0, 7)} —— ` +
        '该结论属于旧树，不代表当前提交',
    };
  }

  const recDirty = recorded.dirty === true;
  const curDirty = current.dirty === true;
  if (recDirty !== curDirty) {
    const recState = recDirty ? `脏（${recorded.dirtyCount ?? '?'} 项）` : '干净';
    const curState = curDirty ? `脏（${current.dirtyCount ?? '?'} 项）` : '干净';
    return {
      level: 'dirty-drift',
      text: `证据与当前代码树同为 ${recHead.slice(0, 7)}，但工作树状态不同：证据时${recState}，当前${curState}`,
    };
  }

  return { level: 'same', text: `证据与当前代码树一致（${recHead.slice(0, 7)}，${recDirty ? '脏' : '干净'}）` };
}
