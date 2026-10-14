/**
 * cache-keepalive-web plan §2 (P0 freeze): `StatusInfo.cacheKeepalive` wire schema. Open posture —
 * unknown fields pass, old frames without the field pass, structural violations are rejected.
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  CacheKeepaliveWireSchema,
  decodeAgentFrame,
  type CacheKeepaliveWire,
} from "../../../src/web-hub/protocol/messages.js";

const valid = (): CacheKeepaliveWire => ({
  v: 1,
  at: 1790000000000,
  mode: "auto",
  enabled: true,
  ping: { text: "ping 2/11", state: "future-state", retryAt: 1790000005000 },
  window: { pings: 2, max: 11 },
  session: {
    pings: 5,
    cacheReadTokens: 1000,
    costUsd: 0.01,
    avoidedMissTokens: 900,
    loadBearingWindows: 1,
    unnecessaryWindows: 0,
    discardedWindows: 0,
  },
  lastPing: { at: 1790000000000, kind: "http", status: 429, transient: true, attempts: 2 },
  lines: [{ label: "anthropic/x@h", open: true, status: 429, trips: 1, current: true }],
});

const status = { t: "status", leafId: "abc", busy: false, pending: false };

describe("CacheKeepaliveWireSchema", () => {
  it("accepts a valid body", () => {
    expect(Value.Check(CacheKeepaliveWireSchema, valid())).toBe(true);
  });
  it("accepts unknown fields at every level", () => {
    const w: any = valid();
    w.extra = 1;
    w.session.extra = 1;
    w.lines[0].extra = 1;
    w.lastPing.extra = 1;
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
  });
  it("rejects more than 32 lines, accepts exactly 32", () => {
    const l = valid().lines[0]!;
    const w = valid();
    w.lines = Array.from({ length: 32 }, () => l);
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(true);
    w.lines = Array.from({ length: 33 }, () => l);
    expect(Value.Check(CacheKeepaliveWireSchema, w)).toBe(false);
  });
  it("rejects wrong v and over-long strings", () => {
    expect(Value.Check(CacheKeepaliveWireSchema, { ...valid(), v: 2 })).toBe(false);
    expect(Value.Check(CacheKeepaliveWireSchema, { ...valid(), mode: "x".repeat(257) })).toBe(false);
  });
});

describe("StatusFrame passthrough", () => {
  it("old frame without cacheKeepalive still decodes", () => {
    const r = decodeAgentFrame(status);
    expect(r).toBeDefined();
  });
  it("carries cacheKeepalive through", () => {
    const r: any = decodeAgentFrame({ ...status, cacheKeepalive: valid() });
    expect(r).toBeDefined();
    expect(r.cacheKeepalive.lines[0].label).toBe("anthropic/x@h");
  });
  it("rejects a frame whose cacheKeepalive is malformed", () => {
    const r = decodeAgentFrame({ ...status, cacheKeepalive: { ...valid(), v: 9 } } as any);
    expect(r).toBeUndefined();
  });
});
