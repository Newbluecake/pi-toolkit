import { describe, expect, it } from "vitest";
import type { ConsultCacheDiagnostics, RunDiagnostics, RunSnapshot } from "../../../src/core/types.js";
import { fleetFingerprint, projectFleet } from "../../../src/web-hub/agent/status.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";

/**
 * cache-thread plan §5.3 (U): the web fleet frame's consult cache fields —
 * `cacheMark` (precomputed compact token) + `consultCache` (structured facts)
 * — projected agent-side from the run's own diag; rows without the fields
 * stay byte-identical (no keys), and the fingerprint flips on real changes.
 */

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r_CONSULT1",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}

const cache = (
  predicted: ConsultCacheDiagnostics["predicted"]["state"],
  first?: ConsultCacheDiagnostics["first"],
): ConsultCacheDiagnostics => ({ v: 1, predicted: { state: predicted }, ...(first ? { first } : {}) });

describe("projectFleet consult cache fields (§5.3 U)", () => {
  it("projects cacheMark and the structured consultCache for a consult run", () => {
    const rows = projectFleet(
      [
        snapshot({
          diag: diag({
            consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 5 }),
            consultThread: { threadId: "c7k9q2mx", seq: 2 },
          }),
        }),
      ],
      10_000,
    );
    const row = rows[0]! as FleetRowWire;
    expect(row.cacheMark).toBe("t#2 warm·hit 96%");
    expect(row.consultCache).toEqual({ state: "warm", first: { label: "hit", readShare: 0.962, anchor: "added" } });
  });

  it("omits `first` while pending and carries degraded/skip facts when measured", () => {
    const pending = projectFleet(
      [snapshot({ diag: diag({ consultCache: cache("cold") }) })],
      10_000,
    )[0]! as FleetRowWire;
    expect(pending.cacheMark).toBe("cold·…");
    expect(pending.consultCache).toEqual({ state: "cold" });

    const degraded = projectFleet(
      [
        snapshot({
          diag: diag({
            consultCache: cache("unknown", {
              v: 1,
              readShare: 0.41,
              label: "partial",
              anchor: "skipped:limit",
              degraded: true,
              at: 5,
            }),
          }),
        }),
      ],
      10_000,
    )[0]! as FleetRowWire;
    expect(degraded.cacheMark).toBe("?·partial 41%·degraded");
    expect(degraded.consultCache).toEqual({
      state: "unknown",
      first: { label: "partial", readShare: 0.41, anchor: "skipped:limit", degraded: true },
    });
  });

  it("rows without the diag fields carry none of the new keys (byte-identical wire)", () => {
    const rows = projectFleet([snapshot()], 10_000);
    const row = rows[0]! as FleetRowWire;
    expect("cacheMark" in row).toBe(false);
    expect("consultCache" in row).toBe(false);
    // and the wire row equals the exact pre-feature key set
    expect(Object.keys(row).sort()).toEqual(
      ["elapsedMs", "highlight", "phaseLabel", "phaseMs", "runId", "status", "terminal"].sort(),
    );
  });

  it("malformed persisted values degrade instead of poisoning the row", () => {
    const rows = projectFleet(
      [
        snapshot({
          diag: diag({
            consultCache: {
              v: 1,
              predicted: { state: "warm" },
              first: { v: 1, readShare: "lots", label: "hit", anchor: "added", at: 5 },
            } as never,
          }),
        }),
      ],
      10_000,
    );
    const row = rows[0]! as FleetRowWire;
    expect(row.cacheMark).toBe("warm·hit");
    expect(row.consultCache).toEqual({ state: "warm", first: { label: "hit", readShare: null, anchor: "added" } });
  });

  it("the fingerprint keeps the mark (flips on a real cache-result change, not on per-second jitter)", () => {
    const pending = projectFleet([snapshot({ diag: diag({ consultCache: cache("warm") }) })], 10_000);
    const measured = projectFleet(
      [
        snapshot({
          diag: diag({
            consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 5 }),
          }),
        }),
      ],
      10_000,
    );
    expect(fleetFingerprint(pending)).not.toBe(fleetFingerprint(measured));
    // elapsedMs jitter alone never flips it (pre-existing behavior, restated)
    const a = projectFleet([snapshot({ diag: diag({ consultCache: cache("warm") }) })], 10_000);
    const b = projectFleet([snapshot({ diag: diag({ consultCache: cache("warm") }) })], 11_000);
    expect(fleetFingerprint(a)).toBe(fleetFingerprint(b));
  });
});
