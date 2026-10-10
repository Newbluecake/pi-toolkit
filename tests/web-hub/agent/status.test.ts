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
