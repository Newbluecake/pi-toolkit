import { describe, expect, it } from "vitest";
import { TombstoneStore } from "../../src/service/tombstone.js";
import type { RunSnapshot } from "../../src/core/types.js";

/**
 * agent-explicit-timeout-extend plan §2.7 (P-tomb): the tombstone is the
 * last-resort persistence surface for `diag.timeoutPolicy` — once the
 * durable terminal record is evicted, a resume within the TTL must still
 * inherit the original run's policy from here. These tests pin the copy at
 * `register()` time and the old-entry (field-absent) compat behavior.
 */

const sessionFile = new URL("../../package.json", import.meta.url).pathname;

function snapshot(overrides: { timeoutPolicy?: "fixed" | "extendable" } = {}): RunSnapshot {
  return {
    runId: "r_TOMB0001",
    generation: 3,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: 1_000, queueDeadlineAt: undefined, hardDeadlineAt: 2_000 },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 3,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      sessionFile,
      ...(overrides.timeoutPolicy === undefined ? {} : { timeoutPolicy: overrides.timeoutPolicy }),
    },
    updatedAt: 1_000,
  };
}

describe("TombstoneStore.register (§2.7 timeoutPolicy copy)", () => {
  it("copies diag.timeoutPolicy from the evicted snapshot", () => {
    const store = new TombstoneStore();
    store.register(snapshot({ timeoutPolicy: "fixed" }));
    const tomb = store.get("r_TOMB0001");
    expect(tomb?.timeoutPolicy).toBe("fixed");
    // resolve() by session file reaches the same entry with the policy
    expect(store.resolve(sessionFile)?.timeoutPolicy).toBe("fixed");
  });

  it("copies extendable policies too", () => {
    const store = new TombstoneStore();
    store.register(snapshot({ timeoutPolicy: "extendable" }));
    expect(store.get("r_TOMB0001")?.timeoutPolicy).toBe("extendable");
  });

  it("old snapshots without the field stay absent on the tombstone (no undefined key)", () => {
    const store = new TombstoneStore();
    store.register(snapshot());
    const tomb = store.get("r_TOMB0001");
    expect(tomb).toBeDefined();
    expect(tomb).not.toHaveProperty("timeoutPolicy");
  });

  it("a snapshot without a session file is still ignored entirely", () => {
    const store = new TombstoneStore();
    const noFile = snapshot();
    delete noFile.diag.sessionFile;
    store.register(noFile);
    expect(store.has("r_TOMB0001")).toBe(false);
  });

  it("entries still expire by TTL; list() carries the policy", () => {
    let now = 1_000;
    const store = new TombstoneStore(60_000, () => now);
    store.register(snapshot({ timeoutPolicy: "fixed" }));
    now += 61_000;
    expect(store.has("r_TOMB0001")).toBe(false);

    const live = new TombstoneStore(60_000, () => 1_000);
    live.register(snapshot({ timeoutPolicy: "extendable" }));
    expect(live.list().map((t) => t.timeoutPolicy)).toEqual(["extendable"]);
  });
});
