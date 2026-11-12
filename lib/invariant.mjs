// 运行时不变量的调用账本（评审包 §5 Q3）。
//
// 为什么单独成文件：lib/rules.mjs 被 lib/runner.mjs 导入，若 rules 反过来
// 从 runner 导入 assertInvariant 就形成循环依赖（ESM 下会拿到未初始化的绑定）。
//
// 被解决的问题：判为「不可达」的防御性分支若写成 `if (bad) return fail`，
// 它永不执行 —— 与「根本不存在」在可观测行为上完全等价，既测不到、
// 也无法证明它还能工作。本模块把它变成**每次运行都求值**的活检查点。

const CALLS = new Map();

/**
 * 断言一条不变量。**每次调用都求值并记账**，不是只在失败时才做事。
 * 失败时抛错 —— 由 runRules 捕获并标记 signal:'untrusted'（判据自身不可信）。
 */
export function assertInvariant(condition, messageFn, id) {
  const key = id || 'anonymous';
  const prev = CALLS.get(key) || { id: key, calls: 0, failures: 0 };
  prev.calls += 1;
  if (!condition) prev.failures += 1;
  CALLS.set(key, prev);
  if (!condition) {
    const msg = typeof messageFn === 'function' ? messageFn() : messageFn;
    throw new Error(msg || `不变量被破坏: ${key}`);
  }
  return condition;
}

/** 读取账本。测试用它证明断言真的被执行过 —— 只看「没抛错」与「没调用」同形。 */
export function invariantStats() {
  return [...CALLS.values()].map((v) => ({ ...v }));
}

/** 仅测试隔离用。 */
export function resetInvariantStats() {
  CALLS.clear();
}