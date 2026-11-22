// 语言清单的**唯一真源**。
//
// ★ 为什么必须只有一张表（2026-11-22，13 个公开仓实测）：
//   原先有两份互不相干的字面量：
//     lib/code.mjs  CODE_EXT        —— 决定"扫谁"            = 10 个后缀
//     lib/arch.mjs  STRUCTURAL_EXT  —— 决定"谁能做结构判定"  = 18 个后缀
//   后者支持的 .cs/.c/.cpp/.h/.hpp/.kt/.swift/.php 从来不在这份扫描清单里，
//   于是 ARCH-07 的提示语写着"支持 .php"，实际一个 .php 都收不到。
//
//   实测后果（公开仓，--depth 1）：
//     · laravel/framework  3,205 个 .php  → 扫描 3 个 .js ⇒ KISS-C1 pass、exit 0
//     · Newtonsoft.Json      951 个 .cs   → 扫描 0 个       ⇒ 判据 skip
//     · nlohmann/json    524 .cpp + 109 .hpp → 扫描 40 个（29 py + 9 js …）
//
//   两张表迟早会对不上，而对不上的后果不是报错，是**静默假绿**。
//   ⇒ 只留一张表；谁能扫、谁能做结构判定都从它派生。
//
// ★ 判据：**同一个事实不要写两遍。** 写两遍的那一刻，就多了一个只能靠人记住的同步义务。

/** 结构化分析支持的语言（能做 ARCH-06 / ARCH-07 的嵌套与 catch 判定）。 */
export const STRUCTURAL_EXT = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.kt', '.swift', '.php',
];

/**
 * 只做**词法级**统计的语言（KISS-C1 / DRY-C1 / YAGNI-C1）：
 * 不参与结构判定，但仍是源码，必须进候选。
 */
export const LEXICAL_ONLY_EXT = ['.py', '.go', '.rs', '.rb'];

/** 全部被扫描的源码后缀 = 结构可判 + 仅词法。 */
export const CODE_EXT = new Set([...STRUCTURAL_EXT, ...LEXICAL_ONLY_EXT]);

/**
 * 明确"不支持结构判定"的扩展名（报告的诚实计数用）。
 *
 * = 进扫描面、但不进 STRUCTURAL_EXT 的那些。
 */
export const UNSUPPORTED_EXT = LEXICAL_ONLY_EXT;

/** 该文件能否做结构判定。 */
export function structuralSupported(file) {
  return STRUCTURAL_EXT.some((e) => file.endsWith(e));
}
