// 四制品解析：proposal / specs / design / tasks
// 解析失败一律抛错或显式报告，绝不给"空结果当通过"的机会。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseOutline, flatten, nodesAtLevel, findSection, findTopSection, tableRows, bulletItems, unquote } from './md.mjs';

export function readText(p) {
  if (!existsSync(p)) throw new Error(`文件不存在: ${p}`);
  return readFileSync(p, 'utf8');
}

/** 列出一个 change 目录下的制品清单（存在性与原文）。 */
export function listArtifacts(dir) {
  const names = ['proposal.md', 'design.md', 'tasks.md'];
  const files = {};
  for (const n of names) {
    const p = join(dir, n);
    files[n] = existsSync(p) ? { path: p, text: readFileSync(p, 'utf8') } : null;
  }
  const specs = collectSpecs(join(dir, 'specs'));
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, files, specs };
}

/**
 * specs/ 下的制品：直接放的 `*.md`，或 `子目录/spec.md`。
 * 两种布局都支持（拆函数是为了不超 KISS-C1 的嵌套上限）。
 */
function collectSpecs(specsDir) {
  if (!existsSync(specsDir)) return [];
  const out = [];
  for (const ent of readdirSync(specsDir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.md')) {
      const p = join(specsDir, ent.name);
      out.push({ name: ent.name, path: p, text: readFileSync(p, 'utf8') });
      continue;
    }
    if (!ent.isDirectory()) continue;
    const p = join(specsDir, ent.name, 'spec.md');
    if (existsSync(p)) out.push({ name: `${ent.name}/spec.md`, path: p, text: readFileSync(p, 'utf8') });
  }
  return out;
}

const REQ_RE = /^require?ment\s*[:：]/i;
const SCEN_RE = /^scenario\s*[:：]/i;

/** 抽出所有 Requirement 节点，每个附带其 Scenario 子节点。 */
export function requirementsOf(text) {
  const outline = parseOutline(text);
  const reqs = flatten(outline).filter((n) => REQ_RE.test(n.title));
  return reqs.map((r) => ({
    title: r.title,
    line: r.line,
    body: r.raw,
    scenarios: (r.children || []).filter((c) => SCEN_RE.test(c.title)).map((c) => ({
      title: c.title,
      line: c.line,
      body: c.raw,
    })),
  }));
}

export { parseOutline, flatten, nodesAtLevel, findSection, findTopSection, tableRows, bulletItems, unquote };
