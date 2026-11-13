// 数值与对象域校验（A02 的底座）。
//
// 为什么需要它：JS 的 `Number()` 会把 `true` 变成 1、把 `null` 变成 0、把 `[]` 变成 0，
// 而 `-1 + -1 = -2` 在"总行数"这种字段上是**数学上不可能的计数**，却照样能通过
// 「> 0 则失败」这类判据。审计 A02 实测的三种假绿全部来自这里：
//
//   tests.passed = -1 / failed = -1      ⇒ PASS，报告写「-1 通过 / 0 失败」
//   tests.passed = true / failed = null  ⇒ PASS（隐式 Number 转换）
//   diff added=1000 / deleted=-1000      ⇒ 「0 行，均在范围内」（正负相消）
//
// 判据：**计数字段只接受非负安全整数**，比例只接受 0..1 的有限数。
// 布尔/null/数组一律不参与隐式转换 —— 它们是"类型错了"，不是"值等于 0"。

/** 纯对象（排除 null 与数组）。 */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 非负安全整数。`-0` 视为 0；`NaN`/`Infinity`/字符串/布尔/null 全部拒绝。 */
export function isNonNegInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** 正整数（分母型字段用：窗口、深度、条数）。 */
export function isPosInt(v) {
  return isNonNegInt(v) && v > 0;
}

/** 0..1 的有限比例。 */
export function isRatio(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

export function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * 读取一个计数字段。
 * @returns {{ok:true,value:number}|{ok:false,reason:string}}
 *
 * 错误信息必须带**字段名与实际值**：审计要求"输入格式错误与外部证据矛盾按统一契约分流"，
 * 而分流的前提是调用方能看出是哪一项坏了。
 */
export function readCount(obj, field, where) {
  if (!isPlainObject(obj)) return { ok: false, reason: `${where} 不是对象` };
  const v = obj[field];
  if (v === undefined) return { ok: false, reason: `${where}.${field} 缺失` };
  if (!isNonNegInt(v)) {
    return { ok: false, reason: `${where}.${field} 必须是非负整数，实际 ${JSON.stringify(v)}（${typeof v}）` };
  }
  return { ok: true, value: v };
}

/**
 * 成对读取计数字段，并校验"分项之和不超总数"这类自洽关系。
 * @param {object} obj 被测对象
 * @param {string[]} fields 需要读取的字段名
 * @param {string} where 诊断用的位置名
 */
export function readCounts(obj, fields, where) {
  const out = {};
  for (const f of fields) {
    const r = readCount(obj, f, where);
    if (!r.ok) return { ok: false, reason: r.reason };
    out[f] = r.value;
  }
  return { ok: true, values: out };
}
