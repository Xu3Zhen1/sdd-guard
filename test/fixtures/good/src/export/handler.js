// 导出 handler 的最小示例（供夹具使用）
import { normalize } from '../util/text.js';

export function exportHandler(body) {
  const ids = normalize(body);
  if (!ids) {
    return { status: 400, code: 'E_EMPTY_INPUT' };
  }
  return { status: 200, bytes: ids.length };
}
