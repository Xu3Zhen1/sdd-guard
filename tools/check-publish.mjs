#!/usr/bin/env node
// check-publish —— 发布前判据：**脱敏 + 行尾 + 结构**。
//
// 为什么要有它：脱敏写成"注意不要提交敏感信息"就永远不会被执行。
// 判据只看**将要提交的字节**（即排除 .gitignore 命中项），所以它能给出确定的"可以/不可以发布"。
//
// 三条检查：
//   ① 脱敏：本机绝对路径、本机用户名、疑似凭证；
//   ② 行尾：不得出现 CRLF（仓库统一 LF）；
//   ③ 结构：package.json 可发布 + 敏感内部路径必须被 .gitignore 覆盖。
//
// 自查（避免判据自指）：本机用户名不写死在源码里，而是运行时从
// `git config user.name` 与环境变量推断——否则本文件自己会被判为"泄露"。

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix-lf');

/** 不参与扫描的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.selfcheck', '.evidence-raw']);
/** 必须被 .gitignore 覆盖的路径（内部拓扑 / 生成产物）。 */
const MUST_IGNORE = ['whoiam.md', 'evidence.json', '.selfcheck/', '.evidence-raw/'];
/** 允许出现作者身份的文件。 */
const AUTHOR_FILES = new Set(['package.json', 'LICENSE', 'CONTRIBUTING.md']);

const SECRET_PATTERNS = [
  { re: /[A-Za-z]:\\{1,2}(?:Users|DSH|Program Files)/, why: '本机绝对路径（盘符 + 系统目录）' },
  { re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, why: '本机绝对路径（POSIX 家目录）' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/, why: 'GitHub token' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, why: 'GitHub fine-grained token' },
  { re: /sk-[A-Za-z0-9]{20,}/, why: 'API key（sk- 前缀）' },
  { re: /AKIA[0-9A-Z]{16}/, why: 'AWS Access Key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥' },
];

const TEXT_EXT = new Set(['.mjs', '.cjs', '.js', '.json', '.md', '.yml', '.yaml', '.txt', '.ps1', '.sh', '.template', '.gitignore', '.gitattributes']);

/**
 * 本机身份：运行时推断，不写死在源码里（否则判据自指）。
 * 只保留**像个人用户名**的值：含数字/下划线且长度 ≥5。
 * 这条过滤是因为 CI 上 `USER=runner`——"runner" 会误伤 `lib/runner.mjs` 这类文件名与 import。
 */
function localIdentities() {
  const looksLikeHandle = (v) => Boolean(v) && v.length >= 5 && /[0-9_]/.test(v);
  const ids = new Set();
  for (const v of [process.env.USERNAME, process.env.USER, process.env.LOGNAME]) {
    if (looksLikeHandle(v)) ids.add(v);
  }
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (looksLikeHandle(name)) ids.add(name);
  } catch {
    // 没有 git 或没配 user.name：忽略，不阻断
  }
  return [...ids];
}

/** 读取 .gitignore → 简易匹配（目录前缀 / 通配后缀 / 精确名）。 */
function loadIgnore() {
  const p = join(ROOT, '.gitignore');
  if (!existsSync(p)) return { rules: [], exists: false };
  const rules = readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return { rules, exists: true };
}

function isIgnored(relPath, rules) {
  const r = relPath.replace(/\\/g, '/');
  const base = r.split('/').pop();
  return rules.some((rule) => {
    // 前导 `/` = 只锚定仓库根（GitHub 语义）：`/evidence.json` 只忽略根目录那个，
    // 不忽略 test/fixtures/good/evidence.json 这类夹具。
    if (rule.startsWith('/')) return r === rule.slice(1);
    if (rule.endsWith('/')) return r === rule.slice(0, -1) || r.startsWith(rule);
    if (rule.startsWith('*')) return base.endsWith(rule.slice(1));
    if (rule.includes('*')) return false; // 复杂通配不猜，交由 MUST_IGNORE 精确校验
    return r === rule || base === rule || r.startsWith(rule + '/');
  });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      out.push(p);
      continue;
    }
    if (!SKIP_DIRS.has(name)) walk(p, out);
  }
  return out;
}

const ignore = loadIgnore();
const identities = localIdentities();
const findings = { sensitive: [], crlf: [], structure: [] };
const fixed = [];

const all = walk(ROOT);
const toCommit = all.map((p) => ({ abs: p, rel: relative(ROOT, p).replace(/\\/g, '/') })).filter((f) => !isIgnored(f.rel, ignore.rules));

if (FIX) {
  for (const f of toCommit) {
    const buf = readFileSync(f.abs);
    if (!buf.includes(0x0d)) continue;
    writeFileSync(f.abs, buf.toString('utf8').replace(/\r\n/g, '\n'));
    fixed.push(f.rel);
  }
  console.log(`已把 ${fixed.length} 个文件的行尾转换为 LF`);
}

for (const f of toCommit) {
  const ext = extname(f.abs).toLowerCase();
  if (!TEXT_EXT.has(ext) && !f.rel.startsWith('.git')) continue;

  const raw = readFileSync(f.abs);
  if (raw.includes(0x0d)) findings.crlf.push(f.rel);

  const text = raw.toString('utf8').replace(/\r/g, '');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pat of SECRET_PATTERNS) {
      if (pat.re.test(lines[i])) findings.sensitive.push(`${f.rel}:${i + 1} ${pat.why}`);
    }
    if (!AUTHOR_FILES.has(f.rel)) {
      for (const id of identities) {
        if (lines[i].includes(id)) findings.sensitive.push(`${f.rel}:${i + 1} 本机身份 ${id}`);
      }
    }
  }
}

// 结构：package.json 可发布
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.private === true) findings.structure.push('package.json 仍是 "private": true（不可发布）');
  for (const k of ['name', 'version', 'description', 'license', 'bin', 'repository']) {
    if (!pkg[k]) findings.structure.push(`package.json 缺字段 ${k}`);
  }
  if (pkg.scripts?.test?.includes('--test')) {
    findings.structure.push('scripts.test 用了 `node --test`（受限沙箱会 spawn EPERM），改用显式文件列表');
  }
  if (!existsSync(join(ROOT, 'LICENSE'))) findings.structure.push('缺 LICENSE 文件（package.json 声明了 license 就得有实体）');
} catch (e) {
  findings.structure.push(`package.json 不可解析: ${e.message}`);
}

// 结构：内部/生成路径必须被 .gitignore 覆盖
if (!ignore.exists) {
  findings.structure.push('缺 .gitignore');
}
for (const path of MUST_IGNORE) {
  const norm = (s) => s.replace(/^\//, '').replace(/\/$/, '');
  const covered = ignore.rules.some((rule) => norm(rule) === norm(path));
  if (!covered) findings.structure.push(`.gitignore 未覆盖 ${path}`);
}

const blocks = [
  ['敏感信息', findings.sensitive],
  ['非 LF 行尾', findings.crlf],
  ['结构与发布前置', findings.structure],
];

let total = 0;
for (const [label, list] of blocks) {
  if (!list.length) {
    console.log(`  ok    ${label}: 0`);
    continue;
  }
  total += list.length;
  console.log(`  FAIL  ${label}: ${list.length} 项`);
  for (const it of list.slice(0, 20)) console.log(`          · ${it}`);
  if (list.length > 20) console.log(`          · …还有 ${list.length - 20} 项`);
}

console.log(`\n拟提交 ${toCommit.length} 个文件（本地共 ${all.length} 个，已忽略 ${all.length - toCommit.length}）· 阻断项 ${total}`);
process.exit(total ? 1 : 0);