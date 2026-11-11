// 命令行参数解析（契约层）。抽出来是为了能单测。
//
// `--code` 可重复出现并累积成数组，其余选项重复出现后者覆盖前者。
// 可重复键列表**从 lib/contract.mjs 引用**，不在此重复声明——两套口径必然漂移。
//
// 历史缺陷（2026-11-11 修）：早期实现每个 `--key value` 都直接赋值，
// `--code a --code b` 只保留 b，而 HELP 写着「可重复」。

import { REPEATABLE_KEYS } from './contract.mjs';

export { REPEATABLE_KEYS };

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (REPEATABLE_KEYS.has(key)) {
      out[key] = Array.isArray(out[key]) ? [...out[key], val] : [val];
    } else {
      out[key] = val;
    }
  }
  return out;
}