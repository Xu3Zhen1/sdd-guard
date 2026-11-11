// 前端侧对契约的使用：只 import 共享契约与自身模块，不碰 server/ 内部路径。
import contract from '../shared/api/export.json' with { type: 'json' };

export function buildRequest(ids) {
  return { endpoint: contract.endpoint, body: { ids } };
}