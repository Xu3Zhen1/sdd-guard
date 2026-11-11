// 规则表：每个原则拆成「可机械判定」与「必须人工判断」两类，绝不混为一谈。
// 状态语义是这套东西的核心：
//   pass   = 机器真的检查了，且通过
//   fail   = 机器真的检查了，且不通过
//   skip   = 输入不足/未提供，**不是通过**（空集不构成通过）
//   manual = 本质上不可机械判定，必须人来签字；机器永远不会把它算绿

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute, relative } from 'node:path';
import { parseOutline, flatten, findTopSection, tableRows, bulletItems, unquote, requirementsOf } from './spec.mjs';
import { walkCode, nestingDepth, duplicateBlocks, speculativeMarks, importSpecifiers, boundaryOfPath, resolveSpecifier } from './code.mjs';

/** GWT 三要素是否齐全（中英双写法）。 */
const GWT_PATTERNS = {
  GIVEN: [/\bGIVEN\b/gi, /给定/g],
  WHEN: [/\bWHEN\b/gi, /当(?:用户|收到|点击|触发)?/g],
  THEN: [/\bTHEN\b/gi, /那么/g],
};

function missingGwt(body) {
  const miss = [];
  for (const [key, res] of Object.entries(GWT_PATTERNS)) {
    const hit = res.some((re) => new RegExp(re.source, re.flags).test(body));
    if (!hit) miss.push(key);
  }
  return miss;
}

/** 从文本里抽取"看起来是路径"的片段（反引号包裹）。 */
export function extractPaths(text) {
  const out = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(text))) {
    const v = m[1].trim();
    if (!v || /\s{2,}/.test(v)) continue;
    if (/^[A-Za-z]:[\\/]/.test(v)) out.add(v);
    else if (v.startsWith('./') || v.startsWith('../')) out.add(v);
    else if (/^[\w.@-]+([\\/][\w.@-]+)*\.[A-Za-z0-9]{1,6}$/.test(v)) out.add(v);
  }
  return [...out];
}

function resolveFrom(base, p) {
  return isAbsolute(p) ? p : resolve(base, p);
}

export const RULES = [
  // ---------------- 提案阶段 ----------------
  {
    id: 'YAGNI-P1',
    principle: 'YAGNI',
    stage: 'proposal',
    decidability: 'machine',
    title: '提案必须显式声明「不做的事」，且每条带理由',
    why: '没有非目标就没有可反驳的范围，AI 会把所有"顺带做得到"的东西都塞进来。',
    run(ctx) {
      const f = ctx.art.files['proposal.md'];
      if (!f) return { status: 'skip', reason: '未提供 proposal.md' };
      const outline = parseOutline(f.text);
      // 按特异性从高到低找，避免「变更范围」这类泛标题把「非目标」抢走
      const sec =
        findTopSection(outline, /(非目标|不做(的)?事|out\s*of\s*scope|non-?goals?)/i) ||
        findTopSection(outline, /(不做什么|明确不做|excluded)/i);
      if (!sec) return { status: 'fail', reason: '缺少「非目标 / 不做的事」小节（只有"范围"不算，必须写明不做的事）' };
      const need = ctx.cfg.yagniMinNonGoals ?? 3;
      const rows = tableRows(sec.raw).filter((r) => r.length >= 2 && r[0]);
      if (rows.length) {
        if (rows.length < need) return { status: 'fail', reason: `非目标表格仅 ${rows.length} 行，需 ≥ ${need}` };
        const noReason = rows.filter((r) => !(r[1] && r[1].trim()));
        if (noReason.length) return { status: 'fail', reason: `${noReason.length} 条非目标缺「为什么不做」`, items: noReason.map((r) => r[0]) };
        return { status: 'pass', detail: `${rows.length} 条非目标，均带理由` };
      }
      const bullets = bulletItems(sec.raw);
      if (bullets.length >= need) return { status: 'pass', detail: `${bullets.length} 条非目标（列表）` };
      return { status: 'fail', reason: `非目标不足（表格 ${rows.length} 行 / 列表 ${bullets.length} 条），需 ≥ ${need}` };
    },
  },
  {
    id: 'YAGNI-P2',
    principle: 'YAGNI',
    stage: 'proposal',
    decidability: 'manual',
    title: '非目标是否真的被裁掉（而非只是没写）',
    why: '机器只能看"有没有写"，看不出"该砍的砍了没有"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 规范阶段 ----------------
  {
    id: 'KISS-S1',
    principle: 'KISS',
    stage: 'specs',
    decidability: 'machine',
    title: '每条 Requirement 至少一个 Scenario，且 GIVEN/WHEN/THEN 齐全',
    why: '写不出 Given/When/Then 的需求，就是测试写不出来的需求。',
    run(ctx) {
      if (!ctx.art.specs.length) return { status: 'skip', reason: '未提供 specs/*.md' };
      const problems = [];
      let reqCount = 0;
      let scenCount = 0;
      for (const sp of ctx.art.specs) {
        for (const req of requirementsOf(sp.text)) {
          reqCount++;
          if (!req.scenarios.length) {
            problems.push(`${sp.name}:「${req.title}」无 Scenario`);
            continue;
          }
          for (const sc of req.scenarios) {
            scenCount++;
            const miss = missingGwt(sc.body);
            if (miss.length) problems.push(`${sp.name}:「${req.title}」→「${sc.title}」缺 ${miss.join('/')}`);
          }
        }
      }
      // 零 Requirement 不等于通过
      if (reqCount === 0) return { status: 'fail', reason: '未解析到任何 Requirement（空集不构成通过）' };
      if (problems.length) return { status: 'fail', reason: `${problems.length} 处不合格`, items: problems };
      return { status: 'pass', detail: `${reqCount} 条 Requirement / ${scenCount} 个 Scenario 全部合格` };
    },
  },
  {
    id: 'KISS-S2',
    principle: 'KISS',
    stage: 'specs',
    decidability: 'machine',
    title: '单个 Scenario 只描述一个行为（禁止一个场景多条 THEN）',
    why: '一个场景多个 THEN，失败时无法定位是哪条行为坏了。',
    run(ctx) {
      if (!ctx.art.specs.length) return { status: 'skip', reason: '未提供 specs/*.md' };
      const problems = [];
      let n = 0;
      for (const sp of ctx.art.specs) {
        for (const req of requirementsOf(sp.text)) {
          for (const sc of req.scenarios) {
            n++;
            const thenLines = sc.body
              .split(/\r?\n/)
              .filter((l) => /^\s*[-*+]\s+/.test(l))
              .filter((l) => /\bTHEN\b|那么/i.test(l));
            if (thenLines.length > 1) problems.push(`${sp.name} →「${sc.title}」有 ${thenLines.length} 条 THEN`);
          }
        }
      }
      if (n === 0) return { status: 'fail', reason: '未解析到任何 Scenario（空集不构成通过）' };
      if (problems.length) return { status: 'fail', reason: `${problems.length} 处多断言场景`, items: problems };
      return { status: 'pass', detail: `${n} 个 Scenario 均为单断言` };
    },
  },

  // ---------------- 设计阶段 ----------------
  {
    id: 'KISS-D1',
    principle: 'KISS',
    stage: 'design',
    decidability: 'machine',
    title: '新增第三方依赖必须逐个登记「标准库为什么不行」',
    why: 'AI 引入依赖成本为零，审查成本全在你身上。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(依赖|dependenc)/i);
      const declared = Object.keys(ctx.cfg.dependencies || {});
      if (!sec) {
        if (declared.length === 0) return { status: 'pass', detail: '设计未声明新依赖，配置中也无新增依赖' };
        return {
          status: 'fail',
          reason: `配置声明了 ${declared.length} 个依赖（${declared.join(', ')}），design.md 缺少依赖小节`,
          items: declared.map((d) => `未登记: ${d}`),
        };
      }
      const rows = tableRows(sec.raw);
      if (declared.length && !rows.length) {
        return {
          status: 'fail',
          reason: `配置声明了 ${declared.length} 个依赖，但依赖小节没有表格逐一登记（未登记: ${declared.join(', ')}）`,
          items: declared.map((d) => `未登记: ${d}`),
        };
      }
      const covered = new Set(rows.map((r) => unquote(r[0] || '')));
      const missing = declared.filter((d) => !covered.has(d));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 个依赖未登记理由`, items: missing.map((d) => `未登记: ${d}`) };
      const noWhy = rows.filter((r) => !(r[1] && r[1].trim()));
      if (noWhy.length) return { status: 'fail', reason: `${noWhy.length} 行依赖缺「标准库为什么不行」`, items: noWhy.map((r) => r[0]) };
      return { status: 'pass', detail: declared.length ? `${declared.length} 个依赖均已登记` : '无新增依赖，小节存在且为空表' };
    },
  },
  {
    id: 'DRY-D1',
    principle: 'DRY',
    stage: 'design',
    decidability: 'machine',
    title: '复用清单必须是真实存在的路径，不能只写「已检索」',
    why: '"我检索过现有代码" 无法验证；可验证的是：列出的文件真的在仓库里。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(复用|reuse)/i);
      if (!sec) return { status: 'fail', reason: '缺少「复用清单」小节（DRY 前置动作未执行）' };
      const paths = extractPaths(sec.raw);
      const need = ctx.cfg.dryMinReuse ?? 1;
      if (paths.length < need) return { status: 'fail', reason: `复用清单仅 ${paths.length} 条路径，需 ≥ ${need}` };
      // 路径基准是**项目根**：design/tasks 里的路径都相对仓库根写，不是相对 change 目录
      const missing = paths.filter((p) => !ctx.existsProjectFile(p));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 条复用路径不存在（基准: ${ctx.repo}）`, items: missing };
      return { status: 'pass', detail: `${paths.length} 条复用路径全部真实存在` };
    },
  },
  {
    id: 'KISS-D2',
    principle: 'KISS',
    stage: 'design',
    decidability: 'manual',
    title: '架构是否过度设计（模式、分层、抽象是否被任务真正需要）',
    why: '机器分不清"合理分层"与"炫技分层"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 任务阶段 ----------------
  {
    id: 'DRY-T1',
    principle: 'DRY',
    stage: 'tasks',
    decidability: 'machine',
    title: '任务引用的文件路径必须存在，或显式标注为新建',
    why: '路径写错会让 AI 去创造重复文件——这是重复劳动最常见的来源。',
    run(ctx) {
      const f = ctx.art.files['tasks.md'];
      if (!f) return { status: 'skip', reason: '未提供 tasks.md' };
      const paths = extractPaths(f.text);
      if (!paths.length) return { status: 'fail', reason: 'tasks.md 未给出任何具体文件路径（无法执行，也无法查重）' };
      const problems = [];
      for (const p of paths) {
        if (ctx.existsProjectFile(p)) continue;
        const line = f.text.split(/\r?\n/).find((l) => l.includes(p)) || '';
        if (!/(新建|新增|create|new file)/i.test(line)) problems.push(`${p}（不存在，且未标注新建）`);
      }
      if (problems.length) return { status: 'fail', reason: `${problems.length} 条路径无法定位（基准: ${ctx.repo}）`, items: problems };
      return { status: 'pass', detail: `${paths.length} 条路径均可定位或已标注新建` };
    },
  },
  {
    id: 'DRY-T2',
    principle: 'DRY',
    stage: 'tasks',
    decidability: 'manual',
    title: '任务拆解是否需要先抽公共函数再继续',
    why: '依赖任务语义，机器无法可靠判断"这两个任务在造同一个轮子"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 前后端解耦 ----------------
  {
    id: 'DECOUPLE-1',
    principle: 'DECOUPLING',
    stage: 'design',
    decidability: 'machine',
    title: '设计必须声明「接口契约真源」，且路径真实存在',
    why: '前后端解耦的落点是**契约单一真源**：类型/字段/错误码只写一处，两侧各自生成或引用。只写"前后端分离"不算。',
    run(ctx) {
      const f = ctx.art.files['design.md'];
      if (!f) return { status: 'skip', reason: '未提供 design.md' };
      const sec = findTopSection(parseOutline(f.text), /(接口契约|API\s*契约|contract|schema|dto)/i);
      if (!sec) return { status: 'fail', reason: '缺少「接口契约」小节（前后端解耦没有声明契约真源）' };
      const paths = extractPaths(sec.raw);
      if (!paths.length) return { status: 'fail', reason: '「接口契约」小节没有给出任何具体文件路径（无法验证单一真源）' };
      const missing = paths.filter((p) => !ctx.existsProjectFile(p));
      if (missing.length) return { status: 'fail', reason: `${missing.length} 条契约路径不存在`, items: missing };
      // 契约文件若同时被两侧各自定义，等于没有真源：要求契约路径落在共享/契约目录
      const sharedPrefixes = ctx.cfg.contractPrefixes || [];
      if (sharedPrefixes.length) {
        const outside = paths.filter((p) => !sharedPrefixes.some((pre) => p.replace(/\\/g, '/').startsWith(pre)));
        if (outside.length) {
          return {
            status: 'fail',
            reason: `${outside.length} 条契约路径不在契约目录（应位于 ${sharedPrefixes.join(' / ')}）`,
            items: outside,
          };
        }
      }
      return { status: 'pass', detail: `${paths.length} 条契约路径真实存在${sharedPrefixes.length ? '且在契约目录内' : ''}` };
    },
  },
  {
    id: 'DECOUPLE-2',
    principle: 'DECOUPLING',
    stage: 'code',
    decidability: 'machine',
    title: '前后端不得直接引用对方内部路径（import 边界）',
    why: '一旦前端 import 后端内部模块，两侧就无法独立部署与替换；解耦退化成"同一个进程里的两堆文件"。',
    run(ctx) {
      const boundaries = ctx.cfg.boundaries || {};
      const forbids = ctx.cfg.forbidImports || [];
      if (!Object.keys(boundaries).length) return { status: 'skip', reason: '未配置 boundaries（无法判定边界）' };
      if (!forbids.length) return { status: 'skip', reason: '未配置 forbidImports（无禁止规则）' };
      if (!ctx.codeFiles.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };

      const violations = [];
      let checkedImports = 0;
      // 边界前缀按 **repo 相对路径** 匹配，不能按 cwd 相对路径——
      // 否则 `--repo` 指向别处（如夹具目录）时，所有文件都会落到边界之外，检查静默变成空集。
      const relRepo = (p) => relative(ctx.repo, p).replace(/\\/g, '/');
      for (const f of ctx.codeFiles) {
        const fromRel = relRepo(f);
        const fromBoundary = boundaryOfPath(fromRel, boundaries);
        if (!fromBoundary) continue;
        const text = ctx.readFile(f);
        for (const spec of importSpecifiers(f, text)) {
          const r = resolveSpecifier(spec, f, ctx.repo);
          let toRel = null;
          if (r.kind === 'relative') toRel = relRepo(r.abs);
          else if (r.kind === 'absolute') toRel = r.abs.replace(/\\/g, '/');
          const toBoundary = toRel ? boundaryOfPath(toRel, boundaries) : boundaryOfPath(spec, boundaries);
          if (!toBoundary) continue;
          checkedImports++;
          const banned = forbids.some((p) => (Array.isArray(p) ? p[0] === fromBoundary && p[1] === toBoundary : p.from === fromBoundary && p.to === toBoundary));
          if (banned) violations.push(`${fromRel} → ${toBoundary}: ${spec}`);
        }
      }
      if (checkedImports === 0) {
        return { status: 'skip', reason: `扫描 ${ctx.codeFiles.length} 个文件，但没有任何跨边界 import（空集不构成通过）` };
      }
      if (violations.length) {
        return { status: 'fail', reason: `${violations.length} 处跨边界直接引用`, items: violations.slice(0, 30) };
      }
      return { status: 'pass', detail: `${checkedImports} 处跨边界引用，均未命中禁止规则` };
    },
  },
  {
    id: 'DECOUPLE-3',
    principle: 'DECOUPLING',
    stage: 'design',
    decidability: 'manual',
    title: '契约是否覆盖了所有跨端通道（字段/错误码/分页/枚举/空值语义）',
    why: '机器能查"有没有契约文件"，查不出"契约是否完整到足以让两侧独立开发"。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 验收证据（acceptance 档）----------------
  // 与上面所有判据的区别：这些判据**不自己生产证据**，只读外部提交的 evidence。
  // 自己跑测试再去判自己跑的结果 = 用被测对象的成绩单判自己合格。
  {
    id: 'ACCEPT-E1',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '测试证据：全绿且样本非空',
    why: 'passed=0 的"全绿"与"没跑"同形；只有 passed>0 且 failed=0 才是证据。',
    run(ctx) {
      const t = ctx.evidence && ctx.evidence.tests;
      if (!t) return { status: 'skip', reason: '未提供 evidence.tests（验收档必须给证据）' };
      const passed = Number(t.passed);
      const failed = Number(t.failed);
      if (!Number.isFinite(passed) || !Number.isFinite(failed)) {
        return { status: 'fail', reason: 'evidence.tests 的 passed/failed 不是数字' };
      }
      if (failed > 0) return { status: 'fail', reason: `${failed} 个测试失败` };
      if (passed === 0) return { status: 'fail', reason: 'passed=0：空样本不构成通过' };
      return { status: 'pass', detail: `${passed} 通过 / 0 失败${t.skipped ? ` / ${t.skipped} 跳过` : ''}` };
    },
  },
  {
    id: 'ACCEPT-E2',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '变异证据：杀死率 ≥ {minMutationRatio}',
    why: '测试全绿不等于判据有判别力；变异杀不死说明测试没测到那段实现。',
    run(ctx) {
      const m = ctx.evidence && ctx.evidence.mutation;
      if (!m) return { status: 'skip', reason: '未提供 evidence.mutation' };
      const killed = Number(m.killed);
      const total = Number(m.total);
      const min = ctx.cfg.minMutationRatio ?? 0.8;
      if (!Number.isFinite(killed) || !Number.isFinite(total)) {
        return { status: 'fail', reason: 'evidence.mutation 的 killed/total 不是数字' };
      }
      if (total === 0) return { status: 'fail', reason: 'total=0：没有变异体，空集不构成通过' };
      const rate = killed / total;
      if (rate < min) {
        return {
          status: 'fail',
          reason: `变异杀死率 ${rate.toFixed(2)} < ${min}（${killed}/${total}）`,
          items: Array.isArray(m.survived) ? m.survived.slice(0, 20).map((s) => `存活: ${s}`) : [],
        };
      }
      return { status: 'pass', detail: `${killed}/${total} = ${rate.toFixed(2)} ≥ ${min}` };
    },
  },
  {
    id: 'ACCEPT-E3',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '契约漂移证据：零漂移',
    why: '接口文档与实现不一致时，"文档写的"不能作为验收依据。',
    run(ctx) {
      const d = ctx.evidence && ctx.evidence.drift;
      if (!d) return { status: 'skip', reason: '未提供 evidence.drift' };
      const findings = Number(d.findings);
      if (!Number.isFinite(findings)) return { status: 'fail', reason: 'evidence.drift.findings 不是数字' };
      if (!Number.isFinite(Number(d.checks)) || Number(d.checks) === 0) {
        return { status: 'fail', reason: 'evidence.drift.checks=0：漂移检测没跑过，空集不构成通过' };
      }
      if (findings > 0) {
        return {
          status: 'fail',
          reason: `${findings} 处契约漂移`,
          items: Array.isArray(d.items) ? d.items.slice(0, 20) : [],
        };
      }
      return { status: 'pass', detail: `${d.checks} 项检查，0 漂移` };
    },
  },
  {
    id: 'ACCEPT-E4',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'manual',
    title: '未被执行的分支是否已显式报告（自曝）',
    why: '所有机器断言都绿时，唯一能暴露"跳过一半规格"的只有实现者主动报告。',
    run() {
      return { status: 'manual' };
    },
  },

  // ---------------- 代码阶段 ----------------
  {
    id: 'KISS-C1',
    principle: 'KISS',
    stage: 'code',
    decidability: 'machine',
    title: '嵌套深度不得超过 {maxNesting} 层',
    why: '深嵌套是可测性最直接的敌人，也是最容易机械检查的一条。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (!files.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const max = ctx.cfg.maxNesting ?? 3;
      const bad = [];
      for (const f of files) {
        for (const h of nestingDepth(f, ctx.readFile(f))) {
          if (h.depth > max) bad.push(`${ctx.rel(f)}:${h.line} 深度 ${h.depth} > ${max}`);
        }
      }
      if (bad.length) return { status: 'fail', reason: `${bad.length} 处超过 ${max} 层`, items: bad.slice(0, 30) };
      return { status: 'pass', detail: `扫描 ${files.length} 个文件，无超限` };
    },
  },
  {
    id: 'DRY-C1',
    principle: 'DRY',
    stage: 'code',
    decidability: 'machine',
    title: '跨文件连续 {dupWindow} 行规范化重复',
    why: '抓真复制粘贴，且只在跨文件时报警——同文件内的重复常是合理的数据表。',
    run(ctx) {
      const files = ctx.codeFiles;
      if (files.length < 2) return { status: 'skip', reason: `仅 ${files.length} 个源码文件，跨文件重复不可判定` };
      const win = ctx.cfg.dupWindow ?? 6;
      const dups = duplicateBlocks(files, win, { minChars: ctx.cfg.dupMinChars ?? 40 });
      if (dups.length) {
        return {
          status: 'fail',
          reason: `${dups.length} 处跨文件重复块（≥${win} 行）`,
          items: dups.slice(0, 30).map((d) => `${ctx.rel(d.a.file)}:${d.a.line} ↔ ${ctx.rel(d.b.file)}:${d.b.line}`),
        };
      }
      return { status: 'pass', detail: `扫描 ${files.length} 个文件，无 ≥${win} 行跨文件重复` };
    },
  },
  {
    id: 'YAGNI-C1',
    principle: 'YAGNI',
    stage: 'code',
    decidability: 'machine',
    title: '代码中不得出现投机性标记（预留 / 将来扩展 / 暂未使用等）',
    why: '这是 YAGNI 唯一能可靠机械判定的信号：作者自己标注了"当前无用、留待以后"。',
    run(ctx) {
      if (!ctx.codeFiles.length) return { status: 'skip', reason: '提供的前缀下未找到源码文件' };
      const marks = [];
      for (const f of ctx.codeFiles) marks.push(...speculativeMarks(f, ctx.readFile(f)));
      if (marks.length) {
        return {
          status: 'fail',
          reason: `${marks.length} 处投机性标记`,
          items: marks.slice(0, 30).map((m) => `${ctx.rel(m.file)}:${m.line} [${m.why}] ${m.text}`),
        };
      }
      return { status: 'pass', detail: `扫描 ${ctx.codeFiles.length} 个文件，无投机标记` };
    },
  },
  {
    id: 'DISCIPLINE-C1',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '变更必须落在声明范围内，且行数不超过预算',
    why: '越权修改是"规范包装下的屎山"的主要通道。',
    run(ctx) {
      if (!ctx.diff) return { status: 'skip', reason: '未提供 diff 数据（需 --diff <json>）' };
      const rows = ctx.diff.files || [];
      if (!rows.length) return { status: 'skip', reason: 'diff 为空（空集不构成通过）' };
      const allowed = ctx.cfg.allowedPrefixes || [];
      const total = rows.reduce((s, r) => s + (r.added || 0) + (r.deleted || 0), 0);
      const budget = ctx.cfg.maxDiffLines ?? 400;
      const problems = [];
      if (allowed.length) {
        for (const r of rows) {
          const p = String(r.path).replace(/\\/g, '/');
          if (!allowed.some((a) => p.startsWith(a))) problems.push(`越界修改: ${r.path}`);
        }
      }
      if (total > budget) problems.push(`变更 ${total} 行，超预算 ${budget} 行`);
      if (problems.length) return { status: 'fail', reason: `${problems.length} 项越界/超预算`, items: problems.slice(0, 30) };
      return { status: 'pass', detail: `${rows.length} 个文件、${total} 行，均在范围内` };
    },
  },
  {
    id: 'DISCIPLINE-C2',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '工作区根不得堆积临时产物（pip-* / 随机 tmp* / cdp-profile-* / diag-*）',
    why: '临时目录落在项目根而不是临时目录，是"当前工作目录回退"的典型后果；它还会挤占按一级目录扫描的工具（如身份卡扫描上限 200）。',
    run(ctx) {
      if (!existsSync(ctx.repo)) return { status: 'skip', reason: `仓库根不存在: ${ctx.repo}` };
      let ents;
      try {
        ents = readdirSync(ctx.repo, { withFileTypes: true });
      } catch (e) {
        return { status: 'skip', reason: `仓库根不可读: ${e.message}` };
      }
      const junk = [];
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        if (/^pip-/.test(e.name) || /^tmp[a-z0-9_]{5,}$/i.test(e.name) || /^cdp-profile-/.test(e.name) || /^diag-[a-z0-9_]{5,}$/i.test(e.name)) {
          junk.push(e.name);
        }
      }
      if (junk.length) {
        return {
          status: 'fail',
          reason: `${junk.length} 个临时目录残留在仓库根`,
          items: junk.slice(0, 30),
        };
      }
      return { status: 'pass', detail: `仓库根 ${ents.filter((e) => e.isDirectory()).length} 个一级目录中无临时产物` };
    },
  },
  {
    id: 'KISS-C2',
    principle: 'KISS',
    stage: 'code',
    decidability: 'manual',
    title: '现有依赖是否可替代本次新增的抽象',
    why: '需要读项目历史与依赖语义，机器裁决会误伤。',
    run() {
      return { status: 'manual' };
    },
  },
];

/** 建上下文：统一管理文件读取缓存、路径基准与路径显示。 */
export function buildContext({ art, changeDir, repo, cwd, cfg = {}, codeRoots = [], diff = null, evidence = null }) {
  const cache = new Map();
  const rawRead = (f) => {
    if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8'));
    return cache.get(f);
  };
  const files = [];
  for (const root of codeRoots) for (const f of walkCode(root)) files.push(f);

  // 路径基准：显式 --repo 优先；否则用 --code 的首个根，再否则用 change 目录
  const repoRoot = resolve(repo || codeRoots[0] || changeDir);

  return {
    art,
    changeDir,
    repo: repoRoot,
    cwd,
    cfg,
    diff,
    evidence,
    codeFiles: [...new Set(files)].sort(),
    readFile: rawRead,
    /** 项目内路径是否存在：按仓库根解析，另兼容绝对路径。 */
    existsProjectFile(p) {
      if (isAbsolute(p)) return existsSync(p);
      return existsSync(resolve(repoRoot, p)) || existsSync(resolve(cwd, p));
    },
    rel(f) {
      const norm = resolve(f).replace(/\\/g, '/');
      const cnorm = resolve(cwd).replace(/\\/g, '/');
      return norm.startsWith(cnorm + '/') ? norm.slice(cnorm.length + 1) : norm;
    },
  };
}
