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

      // 等价变异豁免：从分母扣除。硬阈值遇到物理不可杀的变异必然误红（实测：
      // `String(s) === s` 恒真、`toBuffer` 字节相同仅引用不同）。
      // 但豁免必须留痕：每条要 reason，理由空的直接判 FAIL，防止随手静音。
      const declared = Array.isArray(ctx.cfg.equivalentMutants) ? ctx.cfg.equivalentMutants : [];
      /**
       * 豁免必须留痕：id 与 reason 都要是**非空字符串**，且 id 要规范化。
       *
       * 为什么必须做类型校验（2026-11-12 外部实测暴露的绕过）：
       * 早期写成 `!String(e.reason).trim()`，它只能拦 null/undefined/空串/纯空白，
       * 拦不住非字符串 —— `{}`→"[object Object]"、`123`→"123"、`true`→"true"、
       * `[1,2]`→"1,2"，全都"非空"从而让豁免生效。
       * 实测：killed=7 total=8 只豁免 S1，reason 传 `{}` 就能把 ACCEPT-E2
       * 从 FAIL 翻成 PASS —— 留痕设计被绕过，等于"随便填个值就放行"。
       */
      const badDecl = declared.filter((e) => {
        if (!e || typeof e !== 'object') return true;
        if (typeof e.id !== 'string' || !e.id.trim()) return true;
        if (typeof e.reason !== 'string' || !e.reason.trim()) return true;
        return false;
      });
      if (badDecl.length) {
        return {
          status: 'fail',
          reason: `equivalentMutants 有 ${badDecl.length} 条 id/reason 不是非空字符串（豁免必须留痕，不能用对象/数字/布尔绕过）`,
          items: badDecl.slice(0, 10).map((e) => `无效声明: ${JSON.stringify(e)}`),
        };
      }
      // id 去空白后再比对，避免 {" S1 "} 这种写法悄悄失效或悄悄生效。
      const exemptIds = new Set(declared.map((e) => e.id.trim()));
      /**
       * 重复声明：trim 后重复的 id 只算一个。
       *
       * 从 Set 去重的行为是对的（绝不重复扣分母），但**不提示就是静默**——
       * 用户写了 2 条 [S1, "S1 "]，以为豁免了 2 个，实际只扣 1 个，
       * 而报告里只说"扣除 1 个"，看不出为什么。
       * 这里把合并掉的数量显式说出来（外部实测建议，2026-11-12）。
       */
      const dupMerged = declared.length - exemptIds.size;

      const survived = Array.isArray(m.survived) ? m.survived : [];
      // 存活项的 id 是首段（如 "M11" / "S3"）；只有真出现在 survived 里的豁免才算数。
      const survivedIds = survived.map((s) => String(s).trim().split(/[\s:：]/)[0]);
      const hitExempt = survivedIds.filter((id) => exemptIds.has(id));
      const notSurvived = [...exemptIds].filter((id) => !survivedIds.includes(id));

      /**
       * 证据自洽性：killed + survived 必须恰好等于 total。
       *
       * 不校验的后果（2026-11-12 自测发现）：killed=7 total=8 survived 只列 2 个时，
       * 扣掉 2 个等价变异后分母算成 6，得到 **7/6 = 1.17** —— 杀死率大于 1 这种
       * 数学上不可能的结论会被静默输出并判 PASS。
       *
       * ★ 不要写成 `survived.length && ...`（2026-11-12 外部实测指出）：
       * 那个短路让 survived=[] 时完全不校验，而"漏列"恰恰常在留空时发生。
       * 后果不是变绿（方向安全），而是**误导**——同时声明了豁免的 S1 时，
       * 报告会写「声明但未存活（理由可能已过时）: S1」，用户于是去删掉一个
       * 合理的豁免，而真正要修的是报告漏列。四种形态的判定：
       *   killed=8 total=8 survived=[]  → 不触发（全杀，8+0=8）✓
       *   killed=6 total=8 survived=[]  → 触发（漏列，6+0≠8）✓ 准确定位
       *   killed=8 total=8 survived=2   → 触发（多列，8+2>8）✓
       *   killed=10 total=14 survived=4 → 不触发（10+4=14）✓
       */
      if (killed + survived.length !== total) {
        return {
          status: 'fail',
          reason: `变异证据自相矛盾：killed(${killed}) + survived(${survived.length}) = ${killed + survived.length} ≠ total(${total})（survived 必须列全，否则分母算不准）`,
        };
      }

      const effectiveTotal = total - hitExempt.length;
      if (effectiveTotal <= 0) {
        return {
          status: 'fail',
          reason: `扣除等价变异后分母为 0（total=${total}，豁免命中=${hitExempt.length}）：空集不构成通过`,
        };
      }
      /**
       * `killed > effectiveTotal` 是**不可达分支**（已穷举验证，2026-11-12）。
       *
       * 前提：自洽性校验成立 ⇒ killed = total - survived.length；
       *       豁免命中数 hitExempt ≤ survived.length ⇒ effectiveTotal = total - hitExempt ≥ total - survived.length = killed。
       * 所以 killed ≤ effectiveTotal **恒成立**。枚举 total ≤ 12 的 454 组自洽组合，可达次数 0。
       *
       * 保留为防御性断言而非删除：判据算出的比率若 >1 属于"判据自己坏了"，
       * 静默输出比崩溃更危险。但它不计入任何测试形态 —— 测不到的分支不该假装被测过。
       */
      if (killed > effectiveTotal) {
        return {
          status: 'fail',
          reason: `内部不变量被破坏：killed(${killed}) > 有效分母(${effectiveTotal})，杀死率 > 1 不可能。这是判据缺陷，请报 issue`,
        };
      }

      const rate = killed / effectiveTotal;
      const notes = [];
      if (hitExempt.length) notes.push(`已按声明扣除等价变异 ${hitExempt.length} 个（${hitExempt.join(',')}）`);
      if (dupMerged > 0) notes.push(`重复声明已合并 ${dupMerged} 条（去空白后同名）`);
      // 声明了但本次并未存活 ⇒ 该理由已过时，提示而非阻断（不制造新的静默）。
      const stale = notSurvived.length ? `；声明但未存活（理由可能已过时）: ${notSurvived.join(',')}` : '';

      if (rate < min) {
        const realSurvivors = survived.filter((s, i) => !exemptIds.has(survivedIds[i]));
        return {
          status: 'fail',
          reason: `变异杀死率 ${rate.toFixed(2)} < ${min}（${killed}/${effectiveTotal}${hitExempt.length ? `，已扣等价变异 ${hitExempt.length}` : ''}）${stale}`,
          items: realSurvivors.slice(0, 20).map((s) => `存活: ${s}`),
        };
      }
      return {
        status: 'pass',
        detail: `${killed}/${effectiveTotal} = ${rate.toFixed(2)} ≥ ${min}${notes.length ? '；' + notes.join('；') : ''}${stale}`,
      };
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
    /**
     * ★ 2026-11-12 新增：把「四制品」与「实际代码变更」绑起来。
     *
     * **为什么必须有这条**（对方 8 片实测暴露，决定性实验）：
     *   同一份 change 目录，只改四制品不动代码：
     *     - 四制品完美 + 代码零改动      → process 档 7 绿 0 红
     *     - 四制品描述**另一件没做的事**  → **仍 7 绿 0 红**
     *   也就是说 process 档**不读代码**，它不知道 proposal 说要做的 A
     *   和代码实际做的 B 是否同一件事。8 片共跑 9 次 process 档，
     *   **0 次因"这片做得不对"而红**，只有 3 次因为文档格式不规范而红。
     *   它当时更接近 Markdown 链接检查器。
     *
     * 这条判据补的就是那个缺口：**文档里声明的文件路径，必须出现在真实 diff 里**。
     * 没有 diff 时仍然 skip（不假装通过），但一旦提供 diff，
     * 「文档说改 A、实际改了 B」就会被抓出来。
     */
    id: 'DISCIPLINE-C3',
    principle: 'DISCIPLINE',
    stage: 'code',
    decidability: 'machine',
    title: '文档声明的文件必须出现在实际变更里（文档↔代码绑定）',
    why: '四制品写得再漂亮，只要它描述的不是"实际做的这件事"，规范就退化成了作文检查。',
    run(ctx) {
      // 单行早返回：多行写法会让块嵌套多一层，本项目的 KISS-C1 会自己判自己红。
      if (!ctx.diff) return { status: 'skip', reason: '未提供 diff 数据（需 --diff <json>，可用 tools/make-diff.mjs 生成）' };
      const rows = ctx.diff.files || [];
      if (!rows.length) return { status: 'skip', reason: 'diff 为空：无法判断"声明"与"实际改动"是否一致（空集不构成通过）' };

      /**
       * ★ 只从 **tasks.md** 抽取"我要改"的声明，不从 design.md 抽。
       *
       * 2026-11-12 在 AMup 的 8 个真实切片上回放发现的设计缺陷：
       * design.md 里有「复用清单」表（列头是「现有模块路径 | 提供什么能力 | 本次如何复用」），
       * 表里**本来就包含"不适用 / 只读复用 / 不合并"的条目** —— 那些路径是
       * **明确不打算改**的，却被当成"声明要改"，于是 8 个切片全部误报 FAIL。
       * 实测证据：`lib/team-primitives.js` 那行的"本次如何复用"写的是
       * 「**不适用**：语义不同」，`lib/diag-throttle.js` 写的是「**不适用**：与传输键无关」。
       *
       * tasks.md 才是"要做的事"清单，它的路径基本等同于"要动的地方"。
       * 只认 tasks.md 后，若 tasks 里没有带目录路径则 skip（不假装通过）。
       */
      const arts = ['tasks.md'].map((n) => ctx.art.files[n]).filter(Boolean);
      if (!arts.length) {
        return { status: 'skip', reason: '未提供 tasks.md，无从判断"声明要改什么"' };
      }

      /**
       * 抽取"我要改"的声明 —— 但要排除**同义反复的复查条目**。
       *
       * 2026-11-12 在 8 个真实切片上回放后第二次修正：
       * 只认 tasks.md 之后仍有 6/8 误报，因为 tasks.md 里有「复用复查」这一类小节，
       * 写的是「检查是否与 `lib/x.js` 重复 —— **是，但语义不同/被钉死/刻意不并入**」。
       * 那里的路径语义是**"我看过了，决定不动它"**，恰恰是声明**不改**的文件。
       * 实测三例：`lib/team-primitives.js`（语义不同）、`lib/team-transport-http.js`（被 I4/I4b 钉死）、
       * `lib/index.js`（r26 哈希锁，刻意不并入）。
       *
       * 判据：**同一行里若出现"不改"语义的标记，该行内的路径不计入声明**。
       * 这是启发式，但方向安全——漏判只会让检查更宽松（少报），
       * 而误判会让用户去改一份本来就不该动的文档。
       */
      /**
       * 抽取"我要改"的声明 —— 排除三类**同义反复/取证句式**。
       *
       * 2026-11-12 在 8 个真实切片上回放，逐步收敛出这三类：
       *
       * ① **不改语义**：`不适用 / 不并入 / 不合并 / 不在本片范围 / 钉死 / 刻意不`。
       *    实测：「`lib/team-primitives.js` …**不适用**：语义不同」。
       * ② **取证/确认语义**：`检查 / 确认 / 核对 / 复核 / 实测 / grep`。
       *    实测：「检查 T3 是否与 `lib/shared-state-lock.js` 重复 —— 结论：不含这 4 个原语」、
       *          「确认既有行为测试：`tests/smoke/smoke-test-style-variants.mjs` 真跑 iter5ReadMode」。
       *    这些行是**"我去查过/会去确认"**，不是"我要改它"。
       * ③ **纯文件名**（无目录）：留在正向里会被当成"声明路径"，但实际歧义大。
       *
       * 共同点：这三类的路径**都不代表"要修改"**，误判会让用户去改一份本来不该动的文档。
       * 方向安全：宁可少报（放过真声明），也不制造"修错地方"的误导——
       * 因为真正的越界由 `DISCIPLINE-C1` 的 allowedPrefixes + 行数预算负责，那才是硬约束。
       */
      /**
       * ★ 只认**明确的"这条不做"声明**。
       *
       * 2026-11-12 负控暴露的坑：宽词 `不动` 会吞掉真修改——
       *    T4 `在 lib/shared-state-lock.js 末尾增加 export { claim }（实现不动）`
       * 这句的"不动"修饰的是**实现**（只加导出、不改实现），而它**确实要改这个文件**。
       * 用宽词过滤后 C3 变成永真：把 `lib/shared-state-lock.js` 改成不存在的
       * 文件名仍然 PASS ⇒ 假绿。**这是回放过程中我自己造出来的假绿。**
       *
       * 收紧原则：只有"这一整条都不做"的措辞才算；修饰局部的不算。
       * 去掉了 `不动` / `排除` / `保持原样` 这些既可修饰整体又可修饰局部的词。
       */
      const NOT_CHANGING = /(不适用|不并入|不合并|不在本片范围|不需要修改|无需修改|不修改此文件|刻意不并入|不属于本次|不纳入)/;
      /**
       * 取证/确认句式：**锚定在列表项的句首动词**，不做全段包含匹配。
       *
       * 2026-11-12 第 11 次回放发现的关键区别（负控暴露）：
       *
       *   T1 `确认 lib/config-lock.js 与 lib/shared-state-lock.js 逐字节相同` ← 取证，应过滤
       *   T4 `在 lib/shared-state-lock.js 末尾增加 export { claim }`          ← **真修改，必须保留**
       *
       * 两者同在一个 slices 的 tasks.md 里。若用"整段包含'确认'"来判断，
       * 段落级合并会把 T4 一起吞掉 ⇒ C3 变成永真。负控实测：把
       * `lib/shared-state-lock.js` 改成不存在的文件名，C3 仍 PASS —— 假绿。
       *
       * 修法：只剥掉列表符号与任务编号（`- [ ] T1 `），再看**紧跟的第一个词**是不是取证动词。
       */
      const RECON_HEAD =
        /^\s*(?:[-*+]|\d+\.)\s*(?:\[[ xX]\]\s*)?(?:[A-Z]{1,3}\d+[a-z]?\s+)?(检查|确认|核对|复核|实测|grep|记录|查看|取证|统计|复算|对拍)/;

      /**
       * 按**列表项段落**（而不是按行）切分来判断语义。
       *
       * 2026-11-12 第十次回放发现：Markdown 里一个列表项常折成两三行，
       * 「检查」这个动词在**首行**、而路径在**续行**：
       *
       *   - [ ] 检查 T3 是否与 `lib/shared-state-lock.js` / `lib/team-transport.js` 重复
       *         —— 结论：`lib/shared-state-lock.js` 不含这 4 个原语……
       *
       * 按行判断时，续行既没有"检查"也没有"不改"，于是它的两个路径被当成
       * "声明要改"⇒ 误报「声明了但没改」。按段落判断则整条一起被识别为取证句式。
       */
      const toBlocks = (text) => {
        const blocks = [];
        let cur = null;
        for (const line of text.split(/\r?\n/)) {
          const isItem = /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
          const isIndentedContinuation = /^\s{2,}\S/.test(line) && cur;
          if (isItem) {
            if (cur) blocks.push(cur);
            cur = line;
          } else if (isIndentedContinuation) {
            cur += '\n' + line;
          } else {
            if (cur) blocks.push(cur);
            cur = null;
          }
        }
        if (cur) blocks.push(cur);
        return blocks;
      };

      /**
       * 取证项（句首为「确认/检查/核对…」）不要求"必须被改"，
       * 但**它引用的路径必须真实存在**。
       *
       * ★ 2026-11-12 外部实测发现的第 5 个缺陷（`RECON_HEAD` 后门）。
       *
       * 我上一版对取证项是 `continue` —— **整条跳过**。后果：
       * 任何声明只要句首写「确认」，就脱离了 C3 的管辖。实测注入
       *
       *     - [ ] T99 确认 `lib/ZZZ-attack-via-recon-head.js` 需要改动
       *
       * 结果 **PASS**（盲区）；把句首改成「修改」则立刻 FAIL。
       * 五个动词都是后门：确认 / 检查 / 记录 / 复核 / 查看。
       *
       * **为什么比缺陷④更隐蔽**：④ 需要「宽词恰好修饰局部」这种巧合，
       * ⑤ 只要句首写个"确认"就行 —— 它是**故意设计出来的豁免面**。
       *
       * 修法（对方建议的 A 方案，采纳）：取证项仍不要求"被改"，
       * 但补上一条更基本的要求 —— **不能引用幻觉路径**。
       * 这样既不误伤真实取证项（它们引用的是真文件），又堵住注入。
       */
      const reconRefs = []; // 取证项引用的路径（只校验存在性）
      const declared = new Set();
      for (const a of arts) {
        for (const block of toBlocks(a.text)) {
          const isRecon = RECON_HEAD.test(block);
          // 整条"不做"的声明，路径一律不算数
          if (NOT_CHANGING.test(block)) continue;
          for (const p of extractPaths(block)) {
            const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
            if (!norm.includes('/')) continue; // 裸文件名跳过，避免误伤
            if (/^[A-Za-z]:\//.test(norm)) continue; // 本机绝对路径不是仓库内声明
            // 取证项：只查存在性，不查"是否被改"；其余：算作"声明要改"
            if (isRecon) reconRefs.push(norm);
            else declared.add(norm);
          }
        }
      }
      // 取证项不能引用幻觉路径（外部实测的注入攻击正是从这里进来的）
      const phantom = reconRefs.filter((p) => !ctx.existsProjectFile(p));
      if (phantom.length) {
        return {
          status: 'fail',
          reason: `取证项引用了 ${phantom.length} 个不存在的路径（取证可以不改文件，但不能引用幻觉路径）`,
          items: [...new Set(phantom)].slice(0, 20).map((p) => `取证项引用了不存在的路径: ${p}`),
        };
      }
      if (!declared.size) {
        return {
          status: 'fail',
          reason: '文档未声明任何带目录的源码路径（无法验证"说的和做的是同一件事"）；若确为仓库根级文件，请写成 ./文件名',
        };
      }

      const changed = new Set(rows.map((r) => String(r.path).replace(/\\/g, '/').replace(/^\.\//, '')));
      // 声明的路径必须在变更集里；不在的列出来。
      const missing = [...declared].filter((d) => !changed.has(d));

      /**
       * 反向：改了源码但文档一个字都没提 —— 这是"偷偷扩大范围"。
       *
       * ★ 匹配必须**同时看全路径与基名**（2026-11-12 第三次回放发现）。
       *
       * 历史缺陷：正向只收"带目录的路径"（裸文件名歧义大），但反向匹配时
       * 却要求 diff 里的路径能在 declared 里找到 —— 于是文档写
       * `smoke-test-r26-cross-layer`（短名，无目录）、diff 里是
       * `tests/smoke/smoke-test-r26-cross-layer.mjs`，两边对不上，
       * 被误报成"改了但文档没提"。实测 3 个切片都栽在这里
       * （fix-http 的 T7/T8/T9 明确写了要重钉这三个套件）。
       *
       * 修法：反向匹配也接受**文档里出现过的裸文件名**（去掉扩展名后比较，
       * 允许文档写短名、diff 带完整路径）。正向仍只认带目录路径 —— 那是为了
       * 避免"声明了却无法定位"，方向不同，标准可以不同。
       */
      const bareNames = new Set();
      for (const a of arts) {
        for (const block of toBlocks(a.text)) {
          if (NOT_CHANGING.test(block) || RECON_HEAD.test(block)) continue;
          for (const p of extractPaths(block)) {
            const base = String(p).replace(/\\/g, '/').split('/').pop();
            // 去掉扩展名：文档常写 `smoke-test-x`，实际文件是 `smoke-test-x.mjs`
            bareNames.add(base);
            bareNames.add(base.replace(/\.[A-Za-z0-9]{1,6}$/, ''));
          }
        }
      }
      const mentions = (p) => {
        const base = p.split('/').pop();
        const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
        return declared.has(p) || bareNames.has(base) || bareNames.has(stem);
      };
      /**
       * 反向检查的**语义**必须和正向不同（2026-11-12 第八次回放才定清）。
       *
       * 正向问的是：「文档说要改 A，A 改了吗？」—— 要求 A 落在 diff 里。
       * 反向问的应该是：「这个文件**在任何制品里出现过吗**？」——
       *   而不是「它在不在"我要改"的清单里」。
       *
       * 为什么这个区别致命：`flatten-iter5-mode-read` 的文档提了
       * `lib/client.js` **12 次**（"由生成器重建"、"不手改"、"51 行逐行核过"），
       * 但那些行不构成"声明要改"（有的带"不手改"，有的只是叙述），
       * 于是它被误报成"改了但文档没提"。实测两个切片栽在这里。
       *
       * 新语义：**文档全文（含 design/proposal/specs）都找不到这个文件名**才算"没提"。
       * 这样"由生成器重建"（间接改）、"逐行核过"（已审阅）都能正确匹配，
       * 而真正偷偷加的文件（文档一个字没提）照样被抓。
       *
       * 注意：这是**弱检查**，主要价值是提示"你可能加了计划外的文件"；
       * 真正的越界拦截由 DISCIPLINE-C1 的 allowedPrefixes + diff 预算负责，
       * 那条才是硬约束。C3 不该重复承担 C1 的职责。
       */
      const allArtText = Object.values(ctx.art.files || {})
        .map((f) => (f && f.text) || '')
        .join('\n');
      const mentionedAnywhere = (p) => {
        const base = p.split('/').pop();
        const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '');
        return allArtText.includes(base) || (stem.length >= 8 && allArtText.includes(stem));
      };
      const scopes = Array.isArray(ctx.cfg.codeScopes) ? ctx.cfg.codeScopes : ['lib/', 'src/', 'app/', 'packages/'];
      const inScope = (p) => (scopes.length ? scopes.some((s) => p.startsWith(s)) : true);
      const unexplained = [...changed].filter(
        (p) => /\.(mjs|cjs|js|ts|tsx|jsx|py|go|rs|java)$/.test(p) && inScope(p) && !mentionedAnywhere(p),
      );

      const problems = [
        ...missing.map((p) => `声明了但没改: ${p}`),
        ...unexplained.slice(0, 20).map((p) => `改了但文档没提: ${p}`),
      ];

      if (problems.length) {
        return {
          status: 'fail',
          reason: `文档与变更不对应：${missing.length} 条声明未落地、${unexplained.length} 个变更未声明`,
          items: problems.slice(0, 30),
        };
      }
      return {
        status: 'pass',
        detail: `声明 ${declared.size} 条路径全部落地；${changed.size} 个变更文件均可在文档中找到出处`,
      };
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
