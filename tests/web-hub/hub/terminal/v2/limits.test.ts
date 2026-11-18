import { describe, it, expect } from "vitest";
import {
  TerminalRingV2,
  quotaV2,
  assertQuotaV2,
  DEFAULT_TERMINAL_LIMITS_V2,
  effectiveLimitsV2,
} from "../../../../../src/web-hub/hub/terminal/v2/limits.js";
import { TERMINAL_V2_LIMITS as L } from "../../../../../src/web-hub/protocol/terminal-v2-values.js";
import type { AllocationV2 } from "../../../../../src/web-hub/protocol/terminal-v2.js";
const row = (session: string, principal: string, n: number): AllocationV2 => ({
  allocationId: String(n),
  termId: `t${n}`,
  kernelBootId: "fixture",
  hubInstance: "fixture",
  scope: { agentKey: "a", sessionId: session, epoch: "e" },
  quotaSessionKey: session,
  principalKey: principal,
  creatorSidTag: "fixture",
});
describe("v2 exact quotas and bounded suffix ring", () => {
  it("never transfers deleted-user/old epoch resources to another principal", () => {
    const rows = [row("s", "lan:u1", 1), row("s", "loopback:oldsid", 2), row("other", "lan:deleted", 3)];
    const q = quotaV2(rows, new Set(["1"]), "s", "loopback:newsid", DEFAULT_TERMINAL_LIMITS_V2);
    expect(q).toEqual({
      session: { used: 2, unknown: 1, limit: 2 },
      principal: { used: 0, unknown: 0, limit: 2 },
      total: { used: 3, unknown: 2, limit: 8 },
    });
    expect(() => assertQuotaV2(q)).toThrow("E_LIMIT");
  });
  it("unknown and hot same authoritative set only count once, limits only intersect target dimensions", () => {
    const q = quotaV2([row("s", "lan:u1", 1)], new Set(["1"]), "s", "lan:u1", DEFAULT_TERMINAL_LIMITS_V2);
    expect(q.session.used).toBe(1);
    expect(q.total.used).toBe(1);
    expect(q.total.unknown).toBe(0);
    expect(
      effectiveLimitsV2(DEFAULT_TERMINAL_LIMITS_V2, { maxPerSession: 1, inputIdleMs: 300000, maxLifetimeMs: 900000 }),
    ).toEqual({ maxPerSession: 1, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 300000, maxLifetimeMs: 900000 });
  });
  it("overflow wraps exactly, retains bounded suffix with <=8KiB chunks", () => {
    const ring = new TerminalRingV2();
    const data = Buffer.alloc(L.ringBytes + 123);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    ring.append(data);
    expect(ring.snapshot()).toEqual({ start: 123, end: data.length });
    const read = ring.read(0, 16384);
    expect(read.start).toBe(data.length - 16384);
    expect(read.end).toBe(data.length);
    expect(Buffer.concat(read.chunks.map((c) => Buffer.from(c.bytesB64, "base64")))).toEqual(data.subarray(-16384));
    expect(read.chunks.every((c) => Buffer.from(c.bytesB64, "base64").length <= 8192)).toBe(true);
    ring.append(Buffer.from("tail"));
    expect(read.end).toBe(data.length);
    expect(ring.snapshot().end).toBe(data.length + 4);
  });
  it("rejects invalid offsets/bounds, zero budget reads zero bytes", () => {
    const ring = new TerminalRingV2();
    ring.append(Buffer.from("abc"));
    expect(ring.read(0, 0)).toEqual({ start: 3, end: 3, chunks: [] });
    for (const offset of [-1, 4, NaN, 0.1]) expect(() => ring.read(offset, 1)).toThrow("E_BAD_REQUEST");
    expect(() => ring.read(0, -1)).toThrow("E_BAD_REQUEST");
  });
});
