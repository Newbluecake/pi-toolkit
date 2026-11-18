/** Single allocation set projections; no secondary slot counter and no auth authority. */
import type {
  AllocationV2,
  TerminalMachineLimitsV2,
  TerminalTargetLimitsV2,
  TerminalQuotaV2,
} from "../../../protocol/terminal-v2.js";
import { TERMINAL_V2_LIMITS as L } from "../../../protocol/terminal-v2-values.js";
import { TerminalFaultV2 } from "./timing.js";
export const DEFAULT_TERMINAL_LIMITS_V2: Readonly<TerminalMachineLimitsV2> = Object.freeze({
  maxPerSession: L.maxPerSession,
  maxPerPrincipal: L.maxPerPrincipal,
  maxTotal: L.maxTotal,
  inputIdleMs: L.inputIdleMs,
  maxLifetimeMs: L.maxLifetimeMs,
});
export function effectiveLimitsV2(
  machine: TerminalMachineLimitsV2,
  target: TerminalTargetLimitsV2,
): TerminalMachineLimitsV2 {
  return {
    ...machine,
    maxPerSession: Math.min(machine.maxPerSession, target.maxPerSession),
    inputIdleMs: Math.min(machine.inputIdleMs, target.inputIdleMs),
    maxLifetimeMs: Math.min(machine.maxLifetimeMs, target.maxLifetimeMs),
  };
}
export function quotaV2(
  allocations: Iterable<AllocationV2>,
  hot: ReadonlySet<string>,
  session: string,
  principal: string,
  limits: TerminalMachineLimitsV2,
): TerminalQuotaV2 {
  const all = [...allocations];
  const dimension = (rows: AllocationV2[], limit: number) => ({
    used: rows.length,
    unknown: rows.filter((a) => !hot.has(a.allocationId)).length,
    limit,
  });
  return {
    total: dimension(all, Math.min(L.hardTotal, limits.maxTotal)),
    session: dimension(
      all.filter((a) => a.quotaSessionKey === session),
      limits.maxPerSession,
    ),
    principal: dimension(
      all.filter((a) => a.principalKey === principal),
      limits.maxPerPrincipal,
    ),
  };
}
export function assertQuotaV2(quota: TerminalQuotaV2): void {
  if (Object.values(quota).some((d) => d.used >= d.limit)) throw new TerminalFaultV2("E_LIMIT");
}
/** Fixed-size raw ring. Reads atomically capture a bounded suffix, never future bytes. */
export class TerminalRingV2 {
  private bytes = Buffer.alloc(L.ringBytes);
  private end = 0;
  get start(): number {
    return Math.max(0, this.end - this.bytes.length);
  }
  snapshot() {
    return { start: this.start, end: this.end };
  }
  append(data: Buffer): void {
    if (!Number.isSafeInteger(this.end + data.length)) throw new TerminalFaultV2("E_LIMIT");
    for (let offset = 0; offset < data.length;) {
      const pos = (this.end + offset) % this.bytes.length;
      const count = Math.min(data.length - offset, this.bytes.length - pos);
      data.copy(this.bytes, pos, offset, offset + count);
      offset += count;
    }
    this.end += data.length;
  }
  read(offset: number, maxBytes: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.end ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    )
      throw new TerminalFaultV2("E_BAD_REQUEST");
    const end = this.end;
    const start = Math.max(this.start, offset, end - Math.min(maxBytes, L.ringBytes));
    const chunks: Array<{ offset: number; bytesB64: string }> = [];
    for (let at = start; at < end;) {
      const count = Math.min(L.outputChunkBytes, end - at);
      const b = Buffer.alloc(count),
        pos = at % this.bytes.length;
      const first = Math.min(count, this.bytes.length - pos);
      this.bytes.copy(b, 0, pos, pos + first);
      if (first < count) this.bytes.copy(b, first, 0, count - first);
      chunks.push({ offset: at, bytesB64: b.toString("base64") });
      at += count;
    }
    return { start, end, chunks };
  }
  clear(): void {
    this.bytes.fill(0);
  }
}
