import { describe, expect, it } from "vitest";
import { readStatus } from "../../../src/web-hub/agent/status.js";
import type { LoadPort, LoadVerdict } from "../../../src/sysload/types.js";

function verdict(overrides: Partial<LoadVerdict> = {}): LoadVerdict {
  return {
    level: "crit",
    gating: true,
    metrics: { cpu: { level: "crit" }, mem: { level: "ok" }, disk: [] },
    mono: 10_000,
    at: 1,
    ...overrides,
  };
}

const ctx = {
  sessionManager: { getLeafId: () => "leaf" },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => undefined,
} as never;

const tap = { costUsd: () => 0 } as never;

describe("web-hub status load gate projection", () => {
  it("uses the gate transition timestamp and reports a growing duration", () => {
    const port: LoadPort = {
      verdict: () => verdict({ mono: 20_000, gatingSinceMono: 5_000 }),
      top: () => undefined,
      refreshTop: () => undefined,
    };
    const status = readStatus(
      ctx,
      tap,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => port,
    );
    expect(status.loadGate).toMatchObject({ gating: true, level: "crit", sinceAgoMs: 15_000 });
  });

  it("clears the duration when recovery clears the gate", () => {
    const port: LoadPort = {
      verdict: () => verdict({ level: "warn", gating: false, mono: 20_000 }),
      top: () => undefined,
      refreshTop: () => undefined,
    };
    const status = readStatus(
      ctx,
      tap,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => port,
    );
    expect(status.loadGate).toMatchObject({ gating: false, level: "warn" });
    expect(status.loadGate?.sinceAgoMs).toBeUndefined();
  });
});

describe("web-hub status cacheKeepalive slot", () => {
  const wire = {
    v: 1 as const,
    at: 1,
    mode: "on",
    enabled: true,
    window: { pings: 1, max: 11 },
    session: {
      pings: 1,
      cacheReadTokens: 0,
      avoidedMissTokens: 0,
      loadBearingWindows: 0,
      unnecessaryWindows: 0,
      discardedWindows: 0,
    },
    lines: [],
  };
  const call = (ka?: () => typeof wire | undefined) =>
    readStatus(ctx, tap, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, ka);

  it("getter ⇒ status.cacheKeepalive set; undefined result or no getter ⇒ deepEqual the pre-feature shape", () => {
    expect(call(() => wire).cacheKeepalive).toEqual(wire);
    const base = call();
    expect("cacheKeepalive" in base).toBe(false);
    expect(call(() => undefined)).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// web-resume plan §2.7 — StatusInfo.features (the `resume.v1` capability signal).
// ---------------------------------------------------------------------------
describe("web-hub status features slot", () => {
  it("is absent without a features closure (byte-equal pre-feature shape)", () => {
    const status = readStatus(ctx, tap, []);
    expect(status.features).toBeUndefined();
  });

  it("carries resume.v1 when the closure reports it, clipped to the §2.7 bounds", () => {
    const status = readStatus(
      ctx,
      tap,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ["resume.v1"],
    );
    expect(status.features).toEqual(["resume.v1"]);
    const big = readStatus(
      ctx,
      tap,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ["resume.v1", ...Array.from({ length: 40 }, (_, i) => `x`.repeat(80 + i))],
    );
    expect(big.features).toHaveLength(32);
    expect(big.features![0]).toBe("resume.v1");
    expect(big.features!.every((t) => t.length <= 64)).toBe(true);
  });

  it("stays absent when the closure yields nothing (feature gated off)", () => {
    const status = readStatus(
      ctx,
      tap,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => undefined,
    );
    expect(status.features).toBeUndefined();
  });
});
