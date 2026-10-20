import { describe, expect, it } from "vitest";
import { RUN_CUSTOM_TYPE, seedRunStoreFromEntries, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import {
  interruptedFromJournal,
  journalSnapshotFromState,
  persistableWakeOrigin,
  withoutWakeSecrets,
} from "../../src/core/run-journal.js";
import type { MessageKey, WakeOrigin } from "../../src/core/message.js";
import { createInitialState } from "../../src/core/state-machine.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { RunDiagnostics, RunOutcome, RunSnapshot, RunState } from "../../src/core/types.js";
import { TombstoneStore } from "../../src/service/tombstone.js";

/**
 * fabric-cross-session plan v3 §4.1/§8-S0: the new wake diag fields round-trip through every persistence face —
 * non-terminal journal projection, restart-interrupted terminal rebuild (+ seed), terminal run-log entry and
 * tombstone — `wakeOrigin` never persists its `trigger.claimToken`, and a run without wake facts is untouched
 * (no key added, same object reference ⇒ byte-identical bytes).
 */
const key = "r_WAKER001:r_TARGET01:1:1" as MessageKey;
const origin = (claimToken?: string): WakeOrigin => ({
  by: "r_WAKER001",
  key,
  level: 1,
  via: "fabric",
  trigger: { key, ...(claimToken === undefined ? {} : { claimToken }) } as WakeOrigin["trigger"] & object,
});
const WAKE = {
  wakeLevel: 2,
  wakeExclusion: "none",
  inputAcceptedAt: 1_050,
  promptOutcome: "rejected_pre_accept",
  promptDispatchedAt: 1_020,
} as const satisfies Partial<RunDiagnostics>;

function state(over: Partial<RunDiagnostics> = {}): RunState {
  const base = createInitialState("r_wake", 1, 1_000, "r_parent");
  return {
    ...base,
    status: "running",
    phase: "model_turn",
    diag: { ...base.diag, createdAt: 1_000, sessionFile: "/tmp/wake-sess.jsonl", ...over },
  };
}
const WAKE_KEYS = ["wakeOrigin", "wakeLevel", "wakeExclusion", "inputAcceptedAt", "promptOutcome"] as const;

describe("journal projection", () => {
  it("retains all five wake fields; wakeOrigin loses claimToken; the live state is not mutated", () => {
    const live = state({ ...WAKE, wakeOrigin: origin("mailbox:secret") });
    const snap = journalSnapshotFromState(live, 2_000, { kind: "session_created" });
    for (const k of Object.keys(WAKE))
      expect(snap.diag[k as keyof RunDiagnostics]).toEqual(WAKE[k as keyof typeof WAKE]);
    expect(snap.diag.wakeOrigin).toEqual(origin());
    expect(JSON.stringify(snap)).not.toContain("secret");
    expect(live.diag.wakeOrigin?.trigger?.claimToken).toBe("mailbox:secret");
  });

  it("a wake-less run's journal entry gains no wake key (wake off ⇒ unchanged bytes)", () => {
    const snap = journalSnapshotFromState(state(), 2_000, { kind: "session_created" });
    for (const k of WAKE_KEYS) expect(snap.diag).not.toHaveProperty(k);
    expect(Object.keys(JSON.parse(JSON.stringify(snap.diag)))).not.toEqual(expect.arrayContaining([...WAKE_KEYS]));
  });
});

describe("restart-interrupted terminal rebuild + seed", () => {
  it("interruptedFromJournal / seedRunStoreFromEntries keep the wake facts (and still no claimToken)", () => {
    const journal = journalSnapshotFromState(state({ ...WAKE, wakeOrigin: origin("mailbox:secret") }), 2_000, {
      kind: "shutdown_flush",
      shutdownReason: "reload",
    });
    const direct = interruptedFromJournal(JSON.parse(JSON.stringify(journal)) as RunSnapshot);
    expect(direct.status).toBe("aborted");
    for (const k of Object.keys(WAKE))
      expect(direct.diag[k as keyof RunDiagnostics]).toEqual(WAKE[k as keyof typeof WAKE]);
    expect(direct.outcome?.diag.wakeLevel).toBe(2);

    const base = new MemoryRunStore();
    const seeded = seedRunStoreFromEntries(
      base,
      [{ type: "custom", customType: RUN_CUSTOM_TYPE, data: JSON.parse(JSON.stringify(journal)) }],
      () => true,
    );
    expect(seeded).toBe(1);
    const rebuilt = base.get("r_wake")!;
    expect(rebuilt.status).toBe("aborted");
    expect(rebuilt.diag).toMatchObject(WAKE);
    expect(rebuilt.diag.wakeOrigin).toEqual(origin());
    expect(JSON.stringify(rebuilt)).not.toContain("secret");
  });
});

describe("terminal run-log entry", () => {
  const terminal = (over: Partial<RunDiagnostics>): RunSnapshot => {
    const diag: RunDiagnostics = { ...state(over).diag, phase: "settled", settledAt: 3_000 };
    const outcome: RunOutcome = { runId: "r_wake", status: "completed", turns: 1, durationMs: 5, diag };
    return {
      runId: "r_wake",
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 1_000, deadlineAt: undefined, queueDeadlineAt: undefined } as RunSnapshot["deadlines"],
      diag,
      outcome,
      updatedAt: 3_000,
    };
  };
  const host = () => {
    const entries: Array<{ type: "custom"; customType: string; data: any }> = [];
    return {
      entries,
      pi: {
        appendEntry: (customType: string, data: unknown) =>
          entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
        sessionManager: { getEntries: () => entries },
      },
    };
  };

  it("persists wake facts on diag AND outcome.diag, strips claimToken from both; the in-memory store keeps its snapshot as-is", () => {
    const h = host();
    const base = new MemoryRunStore();
    const store = wrapWithRunLog(base, h.pi);
    const snap = terminal({ ...WAKE, wakeOrigin: origin("mailbox:secret") });
    store.put(snap);
    const entry = h.entries[0]!.data as RunSnapshot;
    expect(entry.diag).toMatchObject(WAKE);
    expect(entry.diag.wakeOrigin).toEqual(origin());
    expect(entry.outcome?.diag.wakeOrigin).toEqual(origin());
    expect(JSON.stringify(h.entries)).not.toContain("secret");
    expect(base.get("r_wake")).toBe(snap); // memory untouched
    expect(snap.diag.wakeOrigin?.trigger?.claimToken).toBe("mailbox:secret");
    // round-trips through the seed
    const seededBase = new MemoryRunStore();
    seedRunStoreFromEntries(seededBase, h.entries, () => true);
    expect(seededBase.get("r_wake")?.diag).toMatchObject(WAKE);
    expect(seededBase.get("r_wake")?.diag.wakeOrigin).toEqual(origin());
  });

  it("journal() strips too", () => {
    const h = host();
    const store = wrapWithRunLog(new MemoryRunStore(), h.pi);
    store.journal(
      journalSnapshotFromState(state({ wakeOrigin: origin("mailbox:secret") }), 1, { kind: "session_created" }),
    );
    expect(JSON.stringify(h.entries)).not.toContain("secret");
  });

  it("a snapshot without wake facts is written as the very same object (no clone, no new key)", () => {
    const snap = terminal({});
    expect(withoutWakeSecrets(snap)).toBe(snap);
    const withToken = terminal({ wakeOrigin: origin() }); // origin without any claimToken
    expect(withoutWakeSecrets(withToken)).toBe(withToken);
    const h = host();
    wrapWithRunLog(new MemoryRunStore(), h.pi).put(snap);
    expect(JSON.stringify(h.entries[0]!.data)).toBe(JSON.stringify(snap));
    for (const k of WAKE_KEYS) expect(JSON.stringify(h.entries[0]!.data)).not.toContain(`"${k}"`);
  });

  it("persistableWakeOrigin: origin without a trigger / token is returned unchanged; a token is dropped, rest kept", () => {
    const noTrigger: WakeOrigin = { by: "root", key, level: 0, via: "fabric" };
    expect(persistableWakeOrigin(noTrigger)).toBe(noTrigger);
    expect(persistableWakeOrigin(origin("t"))).toEqual(origin());
    expect(persistableWakeOrigin(origin("t")).trigger).toEqual({ key });
  });
});

describe("tombstone", () => {
  const snap = (over: Partial<RunDiagnostics>): RunSnapshot => ({
    runId: "r_wake",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined } as RunSnapshot["deadlines"],
    diag: { ...state(over).diag, phase: "settled" },
    updatedAt: 1,
  });

  it("copies the final wakeLevel and the admission wakeExclusion when present", () => {
    const store = new TombstoneStore(60_000, () => 0);
    store.register(snap({ wakeLevel: 2, wakeExclusion: "consult_fork" }));
    expect(store.get("r_wake")).toMatchObject({ wakeLevel: 2, wakeExclusion: "consult_fork" });
    const none = new TombstoneStore(60_000, () => 0);
    none.register(snap({ wakeLevel: 0, wakeExclusion: "none" }));
    expect(none.get("r_wake")).toMatchObject({ wakeLevel: 0, wakeExclusion: "none" }); // 0 is a real value, not "absent"
  });

  it("never adds the keys for a run without wake facts (tombstone bytes unchanged)", () => {
    const store = new TombstoneStore(60_000, () => 0);
    store.register(snap({}));
    const t = store.get("r_wake")!;
    expect(Object.keys(t).sort()).toEqual(["createdAt", "expiresAt", "generation", "runId", "sessionFile"]);
  });
});
