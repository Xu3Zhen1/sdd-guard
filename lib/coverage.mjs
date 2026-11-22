// 覆盖率下限的**分档默认值**（2026-11-22，用户裁定方案 B）。
//
// ★ 要解决的缺口：--min-coverage 默认关闭时，laravel/framework（3,205 个 .php）
//   只扫到 3 个 .js，KISS-C1 给出 pass、exit 0；covered 6/19 = 0.32 也没人管。
//
// ★ 为什么不能直接全局改成 0.8：
//   ICD §2 明确写着 process 档的用法是「边写边查」，文档没写完就 skip 是**合理状态**，
//   判 fail 会打断正常流。那条设计是有意的，不是疏漏。
//
// ⇒ 方案 B：**只在 acceptance 档默认启用 0.8**。验收档本来就是「交付前跑一次」，
//   覆盖率不足意味着「没检查完」，此时 exit 3（未跑完）是它的正确语义；
//   process 档一个字不改。显式传 --min-coverage 永远优先于默认值。
//
// 判据：**改默认值不得改变任何既有档位的既有语义** ——
//   所以 acceptance 默认 0.8 / process 与 all 默认不启用 / 显式传值覆盖默认，三条缺一不可。

/** acceptance 档的默认覆盖率下限。 */
export const ACCEPTANCE_DEFAULT_MIN_COVERAGE = 0.8;

/**
 * 解析本次生效的覆盖率下限。
 *
 * @param {object} p
 * @param {string} p.profile  档位（process / acceptance / all）
 * @param {number|null} p.explicit  命令行显式传入的值；null 表示没传
 * @returns {{value: number|null, source: 'explicit'|'profile-default'|'off'}}
 *
 * ★ 返回 source 而不是只返回值：报告里要说清「这个 0.8 是档位给的还是你给的」。
 *   两者在审计上不同 —— 后者是人的选择，前者是工具的默认立场。
 */
export function acceptanceMinCoverage({ profile, explicit }) {
  if (explicit !== null && explicit !== undefined) return { value: explicit, source: 'explicit' };
  if (profile === 'acceptance') return { value: ACCEPTANCE_DEFAULT_MIN_COVERAGE, source: 'profile-default' };
  return { value: null, source: 'off' };
}
