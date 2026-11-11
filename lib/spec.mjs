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
  const specs = [];
  const specsDir = join(dir, 'specs');
  if (existsSync(specsDir)) {
    for (const ent of readdirSync(specsDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.md')) {
        const p = join(specsDir, ent.name);
        specs.push({ name: ent.name, path: p, text: readFileSync(p, 'utf8') });
      } else if (ent.isDirectory()) {
        const p = join(specsDir, ent.name, 'spec.md');
        if (existsSync(p)) specs.push({ name: `${ent.name}/spec.md`, path: p, text: readFileSync(p, 'utf8') });
      }
    }
  }
  specs.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, files, specs };
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
