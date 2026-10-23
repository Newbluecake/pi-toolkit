/**
 * 关联辅助（纯函数）。
 *
 * T2b（plan §5.3）：holder / pendingSlot / 唯一候选 / 正文探针的**推断式**关联层（原 `createCorrelator`）
 * 整体退役——请求归属只由票据（ticket.ts）证明，无法证明即 unattributed，绝不推断。这里只留无状态工具函数。
 */
const RESPONSE_KEYS = ["request-id", "x-request-id", "x-amzn-requestid", "cf-ray", "x-ms-request-id"] as const;

/** 中段 128 字符指纹（诊断用；T2b 起不再参与任何归属判定）。 */
export function makeProbe(payloadText: string): string | null {
  if (payloadText.length < 24) return null;
  const mid = Math.floor(payloadText.length / 2);
  return payloadText.slice(Math.max(0, mid - 64), mid + 64);
}

export function urlMatchesBase(url: URL | string, baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const b = new URL(baseUrl);
    const u = typeof url === "string" ? new URL(url) : url;
    if (b.origin !== u.origin) return false;
    const basePath = b.pathname.replace(/\/+$/, "");
    return basePath === "" || u.pathname === basePath || u.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

export function respKeyOf(headers: Record<string, string> | Headers): string | null {
  for (const key of RESPONSE_KEYS) {
    const value =
      headers instanceof Headers
        ? headers.get(key)
        : (headers[key] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === key) ?? ""]);
    if (value) return value;
  }
  return null;
}
