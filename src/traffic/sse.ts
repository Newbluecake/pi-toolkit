/**
 * SSE 广播：把录制事件实时推给该 engine 已连接的 Web 页面（客户端集合归 engine，无模块级状态）。
 */
import type { ServerResponse } from "node:http";

export function broadcast(owner: { sseClients: Set<ServerResponse> }, event: Record<string, unknown>): void {
  if (owner.sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of owner.sseClients) {
    try {
      res.write(data);
    } catch {
      owner.sseClients.delete(res);
    }
  }
}
