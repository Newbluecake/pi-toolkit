/**
 * SSE 广播：把录制事件实时推给所有已连接的 Web 页面。
 */
import { state } from "./state.js";

export function broadcast(event: Record<string, unknown>): void {
  if (state.sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.sseClients) {
    try {
      res.write(data);
    } catch {
      state.sseClients.delete(res);
    }
  }
}
