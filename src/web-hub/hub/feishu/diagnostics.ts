/** Body-free, bounded diagnostics. Never log arbitrary provider messages: they can echo card text. */
export interface FeishuDiagnostic {
  event: string;
  reason?: string;
  code?: string | number;
  msg?: string;
}
export function createFeishuDiagnostics(log: ((event: FeishuDiagnostic) => void) | undefined, now: () => number) {
  const sampled = new Map<string, number>();
  let windowAt = now(),
    count = 0;
  return (event: FeishuDiagnostic) => {
    const at = now();
    if (at - windowAt >= 60_000) {
      windowAt = at;
      count = 0;
    }
    const key = `${event.event}:${event.reason ?? ""}`;
    const last = sampled.get(key);
    if (count >= 20 || (last !== undefined && at - last < 60_000)) return;
    if (!sampled.has(key) && sampled.size >= 64) sampled.delete(sampled.keys().next().value!);
    sampled.set(key, at);
    count++;
    try {
      log?.(event);
    } catch {
      /* diagnostic only */
    }
  };
}
/** Preserve useful platform error codes/messages without reflecting ErrorValue, JSON or user labels. */
export function feishuPatchMessage(msg: string | undefined): string {
  const code = /\bErrCode:\s*(\d{1,10})\b/.exec(msg ?? "")?.[1];
  const known = [
    "max_length exceed the default maximum 1000",
    "there is no submit button in the form container, at least one",
  ].find((text) => msg?.includes(text));
  return `${code ? `ErrCode: ${code}; ` : ""}${known ?? "platform message omitted (may contain card content)"}`;
}
