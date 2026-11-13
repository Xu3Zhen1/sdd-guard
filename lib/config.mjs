// 配置值域校验（A01 的修复）。
//
// 审计实测：`maxNesting: "garbage"` ⇒ 四层嵌套的合法代码 PASS，真实 CLI exit 0，
// 报告还印出「不得超过 garbage 层」。根因是 `depth > max` 里 max 是字符串，
// 比较产生 NaN，而 NaN 参与的任何 `>` 都是 false ⇒ **全部超限条件为假**。
//
// 判据（这条比"给某个字段打补丁"重要）：
//   配置**先过一遍完整值域校验**再执行。任一键形态/类型/范围不合法 ⇒ 退出码 2，
//   不做"能跑就先跑"的容错。JSON 可解析 ≠ 配置合法。
//
// 校验表从 lib/contract.mjs 的 CONFIG_SCHEMA 读取（单一真源），
// 本文件只实现"按 kind 校验"的机械部分 —— 新增配置键只改契约，不改这里。

import { isPlainObject, isNonNegInt, isPosInt, isRatio, isStringArray, isNonEmptyString } from './values.mjs';
import { normalizeRel, isAbsoluteLike } from './paths.mjs';

/** 逐 kind 的校验器。每个返回 错误信息数组（空 = 通过）。 */
const CHECK = {
  /** 正整数：窗口、深度、条数。0 与小数一律拒绝（"0 层嵌套"不是一个阈值，是关闭判据）。 */
  posInt: (v, key) =>
    isPosInt(v) ? [] : [`${key} 必须是正整数，实际 ${JSON.stringify(v)}`],

  /** 非负整数：行数预算。"0 行预算"语义明确（禁止任何变更），允许。 */
  nonNegInt: (v, key) =>
    isNonNegInt(v) ? [] : [`${key} 必须是非负整数，实际 ${JSON.stringify(v)}`],

  /** 0..1 比例。 */
  ratio: (v, key) =>
    isRatio(v) ? [] : [`${key} 必须是 0..1 之间的有限数，实际 ${JSON.stringify(v)}`],

  /** 字符串数组（前缀表）。元素必须是字符串，且不得为空串。 */
  stringArray: (v, key) => {
    if (!isStringArray(v)) return [`${key} 必须是字符串数组，实际 ${JSON.stringify(v)}`];
    const bad = v.filter((s) => !s.trim());
    return bad.length ? [`${key} 含空字符串元素`] : [];
  },

  /** 仓库相对路径前缀表：在 stringArray 基础上拒绝绝对路径与越界点段。 */
  pathPrefixArray: (v, key) => {
    if (!isStringArray(v)) return [`${key} 必须是字符串数组，实际 ${JSON.stringify(v)}`];
    const errs = [];
    for (const s of v) {
      if (!s.trim()) errs.push(`${key} 含空字符串元素`);
      else if (isAbsoluteLike(s)) errs.push(`${key} 含绝对路径: ${s}（必须是仓库相对前缀）`);
      else if (!normalizeRel(s)) errs.push(`${key} 含越界点段: ${s}`);
    }
    return errs;
  },

  /** { 名称: 字符串值 } 映射（dependencies）。 */
  stringMap: (v, key) => {
    if (!isPlainObject(v)) return [`${key} 必须是对象，实际 ${JSON.stringify(v)}`];
    const errs = [];
    for (const [k, val] of Object.entries(v)) {
      if (!k.trim()) errs.push(`${key} 含空键名`);
      if (!isNonEmptyString(val)) errs.push(`${key}.${k} 必须是非空字符串（说明版本或理由），实际 ${JSON.stringify(val)}`);
    }
    return errs;
  },

  /** { 名称: [前缀…] } 映射（boundaries）。 */
  prefixMap: (v, key) => {
    if (!isPlainObject(v)) return [`${key} 必须是对象（边界名 → 前缀数组），实际 ${JSON.stringify(v)}`];
    const errs = [];
    for (const [name, prefixes] of Object.entries(v)) {
      if (!name.trim()) errs.push(`${key} 含空边界名`);
      if (typeof prefixes === 'string') {
        errs.push(`${key}.${name} 必须是数组（单前缀也要写成 ["a/b/"]），实际是字符串`);
        continue;
      }
      errs.push(...CHECK.pathPrefixArray(prefixes, `${key}.${name}`));
    }
    return errs;
  },

  /** 禁止引用表：接受 [{from,to}] 或 [[from,to]]，两者都要求两个非空字符串。 */
  forbidImports: (v, key) => {
    if (!Array.isArray(v)) return [`${key} 必须是数组，实际 ${JSON.stringify(v)}`];
    const errs = [];
    v.forEach((item, i) => {
      const pair = Array.isArray(item) ? item : isPlainObject(item) ? [item.from, item.to] : null;
      if (!pair || pair.length !== 2) {
        errs.push(`${key}[${i}] 必须是 {from,to} 或 [from,to]，实际 ${JSON.stringify(item)}`);
        return;
      }
      if (!pair.every((s) => typeof s === 'string' && s.trim())) {
        errs.push(`${key}[${i}] 的 from/to 必须都是非空字符串，实际 ${JSON.stringify(item)}`);
      }
    });
    return errs;
  },

  /**
   * 等价变异声明表：每条 {id, reason} 都是非空字符串。
   *
   * 这里是**提前**校验（A02 所要求的"输入格式错误在执行前分流"）。
   * 规则层仍保留同一校验 —— 规则层是纯函数，不能被绕过；
   * 而 CLI 层提前失败能给出"配置第几行错了"，比执行后才红好定位。
   */
  exemptArray: (v, key) => {
    if (!Array.isArray(v)) return [`${key} 必须是数组，实际 ${JSON.stringify(v)}`];
    const errs = [];
    v.forEach((e, i) => {
      if (!isPlainObject(e)) return errs.push(`${key}[${i}] 必须是对象，实际 ${JSON.stringify(e)}`);
      if (!isNonEmptyString(e.id)) errs.push(`${key}[${i}].id 必须是非空字符串，实际 ${JSON.stringify(e.id)}`);
      if (!isNonEmptyString(e.reason)) errs.push(`${key}[${i}].reason 必须是非空字符串（豁免必须留痕），实际 ${JSON.stringify(e.reason)}`);
    });
    return errs;
  },
};

/**
 * 校验配置对象。
 *
 * @param {unknown} raw 解析后的配置（可以是 {}）
 * @param {Record<string, {kind:string, desc:string}>} schema 来自 contract.CONFIG_SCHEMA
 * @returns {{ok:boolean, errors:string[]}}
 *
 * 三条超出"逐字段类型检查"的要求：
 *   ① **未知键报错**：拼错的 `maxNestingg` 会静默失效 ⇒ 用户以为设了阈值。
 *   ② **errors 全量收集**：一次列出所有问题，不让人修一个跑一次。
 *   ③ 消息带键名与实际值：分流的前提是能看出是哪一项坏了。
 */
export function validateConfig(raw, schema) {
  if (raw === undefined || raw === null) return { ok: true, errors: [] };
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`配置必须是 JSON 对象，实际 ${Array.isArray(raw) ? '数组' : typeof raw}`] };
  }
  const errors = [];
  const known = new Set(Object.keys(schema));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`未知配置键: ${key}（拼写错误会让设置静默失效；可用键: ${[...known].join(', ')}）`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const check = CHECK[spec.kind];
    if (!check) {
      errors.push(`内部错误: 配置键 ${key} 声明了未知校验类型 ${spec.kind}`);
      continue;
    }
    errors.push(...check(raw[key], key));
  }
  return { ok: errors.length === 0, errors };
}
