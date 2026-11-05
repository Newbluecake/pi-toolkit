/**
 * #30 reload-result plan §1/§3 — the reload-result tracker's state machine
 * (`src/web-hub/agent/reload-track.ts`): attribution (D1/Q1, A1–A3, A13), fact semantics
 * (D3, A5, A8, A10), boundary facts + handover validation (D4, A6, A7), store hygiene
 * (D5, U11), TTL (A12) and the publish discipline (D6/G3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReloadPhaseEvent } from "../../../src/reload/phase.js";
import {
  createReloadTracker,
  writeStore as writeStoreForTest,
  projectRec,
  readStore,
  readValidMarker,
  readValidRec,
  RELOAD_CMD_IDS_MAX,
  RELOAD_HANDOVER_TTL_MS,
  RELOAD_REC_TTL_CLOSED_MS,
  RELOAD_REC_TTL_OPEN_MS,
  resetReloadTrackStore,
  type ReloadTrackEnv,
  type ReloadTrackStore,
} from "../../../src/web-hub/agent/reload-track.js";

const TRACK_KEY = Symbol.for("pi-subagent:web-hub:reload-track");
afterEach(() => resetReloadTrackStore());

interface EnvOptions {
  now?: () => number;
  moduleInstance?: string;
  version?: () => string;
  session?: ReloadTrackEnv["session"];
}

function makeEnv(opts: EnvOptions = {}): ReloadTrackEnv {
  return {
    now: opts.now ?? (() => 1_000),
    moduleInstance: opts.moduleInstance ?? "M-cur",
    version: opts.version ?? (() => "1.2.3"),
    session: opts.session ?? (() => ({ sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" })),
  };
}

function makeTracker(env: ReloadTrackEnv) {
  const publish = vi.fn();
  const tracker = createReloadTracker(env, { publish: () => publish() });
  return { tracker, publish };
}

/** A phase event in tracker tests — only the fields the tracker reads. */
function ev(kind: string, over: Partial<ReloadPhaseEvent> = {}): ReloadPhaseEvent {
  return { life: "L1", execId: "X1", kind, ...over } as ReloadPhaseEvent;
}

const rec = () => readStore().rec;

describe("store hygiene (D5/U11/A7)", () => {
  it("an unknown v or corrupt structure reads as empty and the next write overwrites whole", () => {
    (globalThis as Record<symbol, unknown>)[TRACK_KEY] = { v: 2, rec: { state: "completed" } };
    const { tracker } = makeTracker(makeEnv());
    expect(tracker.projection()).toBeUndefined();
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs", activeRuns: 2 }));
    expect(rec()?.state).toBe("deferred");
    expect(rec()?.cmdIds).toEqual(["c1"]);
    // corrupt inner shape (state not a valid literal) reads as empty too
    (globalThis as Record<symbol, unknown>)[TRACK_KEY] = { v: 1, rec: { v: 1, life: "L1" } };
    expect(tracker.projection()).toBeUndefined();
  });

  it("a record whose at lies in the future (clock rollback) is invalid AND cleared immediately", () => {
    const clock = { v: 1_000 };
    const { tracker } = makeTracker(makeEnv({ now: () => clock.v }));
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs" }));
    expect(rec()).toBeDefined();
    clock.v = 999; // the clock rolls back — at=1000 now lies in the future
    expect(tracker.projection()).toBeUndefined(); // reads as empty
    tracker.onSessionShutdown("quit"); // the next mutating entry persists the clear (U11)
    expect(readStore().rec).toBeUndefined();
  });

  it("a marker whose startedAt lies in the future is cleared, never takeover-validated", () => {
    (globalThis as Record<symbol, unknown>)[TRACK_KEY] = {
      v: 1,
      handover: {
        v: 1,
        life: "L1",
        cmdIds: ["c1"],
        sessionId: "sess-1",
        sessionFile: "/tmp/sess-1.jsonl",
        originEpoch: "M-old",
        startedAt: 2_000,
      },
    };
    const { tracker } = makeTracker(makeEnv());
    tracker.onSessionStart("reload");
    expect(readStore().handover).toBeUndefined(); // cleared + persisted (sanitizeStore)
    expect(rec()?.state).toBeUndefined(); // no completed was written
  });

  it("TTL bounds are read-side only: closed 10min, open 40min (D5)", () => {
    const t = { v: 1_000 };
    const { tracker } = makeTracker(makeEnv({ now: () => t.v }));
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    tracker.onPhase(ev("cancel")); // parks first, then closes
    expect(rec()?.open).toBe(false);
    t.v += RELOAD_REC_TTL_CLOSED_MS - 1;
    expect(tracker.projection()).toBeDefined();
    t.v += 2;
    expect(tracker.projection()).toBeUndefined(); // closed TTL expired
    resetReloadTrackStore();
    t.v = 1_000;
    const open = makeTracker(makeEnv({ now: () => t.v }));
    open.tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    t.v += RELOAD_REC_TTL_OPEN_MS - 1;
    expect(open.tracker.projection()).toBeDefined();
    t.v += 2;
    expect(open.tracker.projection()).toBeUndefined(); // open TTL expired (> #23's 30min budget)
  });
});

describe("attribution (D1/Q1/A1–A3/A13)", () => {
  it("a web-sourced deferred establishes the record; a TUI fact with no record is ignored (Q1/G3)", () => {
    const { tracker, publish } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: undefined, waitingFor: "runs", activeRuns: 1 }));
    expect(rec()).toBeUndefined();
    expect(publish).not.toHaveBeenCalled(); // G3: no record ⇒ no publish at all
    tracker.onPhase(ev("deferred", { by: "cmd-aaaaaaaaaaaaaaaa", waitingFor: "runs", activeRuns: 1 }));
    expect(rec()?.cmdIds).toEqual(["cmd-aaaaaaaaaaaaaaaa"]);
    expect(rec()?.rev).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("TUI now/cancel on a TRACKED lifecycle is recorded (Q1: facts of the tracked request's life)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "cmd-aaaaaaaaaaaaaaaa", waitingFor: "idle" }));
    tracker.onPhase(ev("started", { by: undefined })); // e.g. a TUI `now` fired the reload
    expect(rec()?.state).toBe("started");
    tracker.onPhase(ev("cancel", { by: undefined }));
    expect(rec()).toMatchObject({ state: "cancelled", code: "user", open: false });
  });

  it("A1: a second web attempt merges its cmdId and becomes the current execution; the first's late facts die", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "cmd-aaaaaaaaaaaaaaaa", waitingFor: "idle" }));
    tracker.onPhase(ev("exec", { by: "cmd-bbbbbbbbbbbbbbbb", execId: "X2" }));
    expect(rec()).toMatchObject({ cmdIds: ["cmd-aaaaaaaaaaaaaaaa", "cmd-bbbbbbbbbbbbbbbb"], execId: "X2" });
    tracker.onPhase(ev("started", { execId: "X1" })); // the first attempt's late started
    expect(rec()?.state).toBe("deferred"); // dropped — not the current execution
    tracker.onPhase(ev("started", { execId: "X2" }));
    expect(rec()?.state).toBe("started");
    tracker.onPhase(ev("returned", { execId: "X1" })); // stale returned cannot overwrite
    expect(rec()?.state).toBe("started");
  });

  it("A2: a stale settle/returned cannot overwrite the newer execution's started", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "cmd-aaaaaaaaaaaaaaaa" }));
    tracker.onPhase(ev("exec", { execId: "X2" }));
    tracker.onPhase(ev("started", { execId: "X2" }));
    tracker.onPhase(ev("settle", { execId: "X1", open: true }));
    tracker.onPhase(ev("returned", { execId: "X1" }));
    expect(rec()).toMatchObject({ state: "started", execId: "X2" });
  });

  it("A13: a closed record accepts no continuation; the next web request replaces it wholesale", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "cmd-aaaaaaaaaaaaaaaa", waitingFor: "idle" }));
    tracker.onPhase(ev("cancel")); // closes the lifecycle
    tracker.onPhase(ev("started", { by: "cmd-aaaaaaaaaaaaaaaa", execId: "X1" })); // late, dropped
    expect(rec()).toMatchObject({ state: "cancelled", code: "user" });
    tracker.onPhase(ev("started", { by: "cmd-bbbbbbbbbbbbbbbb", life: "L2", execId: "X9" }));
    expect(rec()).toMatchObject({ life: "L2", state: "started", cmdIds: ["cmd-bbbbbbbbbbbbbbbb"], rev: 1 });
  });

  it("cmdIds capacity 4, FIFO beyond (D1): the oldest request falls back to inference", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "c-0000000000000001", waitingFor: "idle" }));
    for (let i = 2; i <= 5; i++) {
      tracker.onPhase(ev("exec", { by: `c-000000000000000${i}`, execId: `X${i}` }));
    }
    expect(rec()?.cmdIds).toEqual([
      "c-0000000000000002",
      "c-0000000000000003",
      "c-0000000000000004",
      "c-0000000000000005",
    ]);
    expect(RELOAD_CMD_IDS_MAX).toBe(4);
  });
});

describe("fact semantics (D2/D3, A5/A8/A10/A11)", () => {
  it("IDLE_WAIT fails open:true; later started/completed still land (A5)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    tracker.onPhase(ev("idleWait"));
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_IDLE_WAIT", open: true });
    tracker.onPhase(ev("exec", { execId: "X2" }));
    tracker.onPhase(ev("started", { execId: "X2" }));
    expect(rec()?.state).toBe("started"); // failed→started (not ignored — open was true)
  });

  it("IDLE_WAIT then cancel ⇒ failed→cancelled (A5)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    tracker.onPhase(ev("idleWait"));
    tracker.onPhase(ev("cancel"));
    expect(rec()).toMatchObject({ state: "cancelled", code: "user", open: false });
  });

  it("settle carries the collector-side open flag (still parked or not)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("settle", { by: "c1", open: true }));
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_SETTLE", open: true });
    tracker.onPhase(ev("settle", { by: "c2", life: "L2", execId: "X2", open: false }));
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_SETTLE", open: false });
  });

  it("A8: returned without a reload-shutdown ⇒ E_RELOAD_REFUSED", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    tracker.onPhase(ev("returned"));
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_REFUSED", open: false });
  });

  it("returned AFTER a reload-shutdown leaves the record started (the takeover path owns it)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    tracker.onSessionShutdown("reload");
    tracker.onPhase(ev("returned"));
    expect(rec()?.state).toBe("started");
    expect(rec()?.open).toBe(true);
  });

  it("A10: threw without a reload-shutdown ⇒ E_RELOAD_THREW with a 256-byte UTF-8-safe message", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    const long = "τ".repeat(300); // 2 bytes each — the cut must not split a codepoint
    tracker.onPhase(ev("threw", { message: long }));
    const message = rec()?.message;
    expect(message).toBeDefined();
    expect(Buffer.byteLength(message!, "utf8")).toBeLessThanOrEqual(256);
    expect(message!.endsWith("…")).toBe(true);
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_THREW", open: false });
  });

  it("threw after a reload-shutdown is uncollectable — the record stays started (UI infers LOST)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    tracker.onSessionShutdown("reload");
    tracker.onPhase(ev("threw", { message: "load failed after shutdown" }));
    expect(rec()?.state).toBe("started");
  });

  it("unavailable establishes a closed failure (D3)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("unavailable", { by: "c1" }));
    expect(rec()).toMatchObject({ state: "failed", code: "E_RELOAD_UNAVAILABLE", open: false });
  });

  it("deferred-only fields clear on other states; code/message/version ride only theirs (D2)", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs", activeRuns: 3 }));
    expect(projectRec(rec()!)).toMatchObject({ waitingFor: "runs", activeRuns: 3 });
    tracker.onPhase(ev("started"));
    const view = projectRec(rec()!);
    expect("waitingFor" in view).toBe(false);
    expect("activeRuns" in view).toBe(false);
    expect("code" in view).toBe(false);
  });

  it("an identical fact is not a change: no rev bump, no publish (D6/G3)", () => {
    const t = { v: 1_000 };
    const { tracker, publish } = makeTracker(makeEnv({ now: () => t.v }));
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs", activeRuns: 1 }));
    const rev = rec()!.rev;
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs", activeRuns: 1 })); // same content, same clock
    expect(rec()!.rev).toBe(rev);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("boundary facts and handover validation (D4, A6/A7/A11)", () => {
  function armedStarted(tracker: ReturnType<typeof makeTracker>["tracker"], by = "c1"): void {
    tracker.onPhase(ev("deferred", { by, waitingFor: "idle" }));
    tracker.onPhase(ev("exec", { execId: "X2" }));
    tracker.onPhase(ev("started", { execId: "X2" }));
  }

  it("A6: shutdown{reload} on a parked (not started) record ⇒ cancelled superseded, never completed", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "runs", activeRuns: 2 }));
    tracker.onSessionShutdown("reload");
    expect(rec()).toMatchObject({ state: "cancelled", code: "superseded", open: false });
  });

  it("shutdown{reload} on a started record only completes the marker — no record change, no publish", () => {
    const { tracker, publish } = makeTracker(makeEnv());
    armedStarted(tracker);
    const rev = rec()!.rev;
    publish.mockClear();
    tracker.onSessionShutdown("reload");
    expect(readStore().handover).toMatchObject({ life: "L1", shutdownAt: 1_000 });
    expect(rec()!.rev).toBe(rev);
    expect(rec()!.state).toBe("started");
    expect(publish).not.toHaveBeenCalled(); // the marker never rides the wire
  });

  it("non-reload shutdowns cancel an open record as session|quit", () => {
    const a = makeTracker(makeEnv());
    a.tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    a.tracker.onSessionShutdown("new");
    expect(rec()).toMatchObject({ state: "cancelled", code: "session", open: false });
    resetReloadTrackStore();
    const b = makeTracker(makeEnv());
    b.tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    b.tracker.onSessionShutdown("quit");
    expect(rec()).toMatchObject({ state: "cancelled", code: "quit", open: false });
  });

  it("takeover validation passes ⇒ completed carries version + the taking epoch (D4)", () => {
    const { tracker } = makeTracker(makeEnv({ moduleInstance: "M-new" }));
    tracker.onPhase(ev("started", { by: "c1" }));
    // rewrite the marker's originEpoch to a foreign module instance (the real flow: the OLD
    // activation wrote it with ITS MODULE_INSTANCE) — persisted through the global slot
    const store = readStore();
    store.handover = { ...store.handover!, originEpoch: "M-old" };
    writeStoreForTest(store);
    tracker.onSessionShutdown("reload");
    tracker.onSessionStart("reload");
    expect(rec()).toMatchObject({
      state: "completed",
      open: false,
      version: "1.2.3",
      epoch: "M-new",
    });
  });

  it("A11: version 0.0.0 ⇒ completed WITHOUT a version field (unknown, not no-upgrade)", () => {
    const { tracker } = makeTracker(makeEnv({ moduleInstance: "M-new", version: () => "0.0.0" }));
    tracker.onPhase(ev("started", { by: "c1" }));
    const store = readStore();
    store.handover = { ...store.handover!, originEpoch: "M-old" };
    writeStoreForTest(store);
    tracker.onSessionShutdown("reload");
    tracker.onSessionStart("reload");
    expect(rec()?.state).toBe("completed");
    expect("version" in projectRec(rec()!)).toBe(false);
  });

  it.each([
    ["sessionId mismatch", (m: ReloadTrackStore["handover"] & object) => ({ ...m!, sessionId: "sess-other" })],
    ["sessionFile mismatch", (m: ReloadTrackStore["handover"] & object) => ({ ...m!, sessionFile: "/other.jsonl" })],
    ["same epoch (no reload)", (m: ReloadTrackStore["handover"] & object) => ({ ...m!, originEpoch: "M-cur" })],
    ["no shutdownAt", (m: ReloadTrackStore["handover"] & object) => ({ ...m!, shutdownAt: undefined })],
    ["life mismatch vs record", (m: ReloadTrackStore["handover"] & object) => ({ ...m!, life: "L-other" })],
    [
      "beyond 120s",
      (m: ReloadTrackStore["handover"] & object) => ({ ...m!, startedAt: 1_000 - (RELOAD_HANDOVER_TTL_MS + 1) }),
    ],
  ])("A7: %s ⇒ no completed, record stays started, marker consumed", (_label, mutate) => {
    const { tracker } = makeTracker(makeEnv({ now: () => 2_000 }));
    tracker.onPhase(ev("started", { by: "c1" }));
    const store = readStore();
    // `mutate` breaks exactly one condition; shutdownAt is completed like a real shutdown did
    store.handover = {
      ...store.handover!,
      shutdownAt: 1_500,
      originEpoch: "M-old",
      ...mutate(store.handover!),
    };
    writeStoreForTest(store);
    tracker.onSessionStart("reload");
    expect(rec()?.state).toBe("started");
    expect(readStore().handover).toBeUndefined(); // read-then-delete on EVERY session start
  });

  it("A7: non-reload reason never completes; a corrupt marker is treated as absent", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    (globalThis as Record<symbol, unknown>)[TRACK_KEY] = {
      v: 1,
      rec: readStore().rec,
      handover: { garbage: true },
    };
    tracker.onSessionStart("reload");
    expect(rec()?.state).toBe("started");
  });

  it("readValidMarker exposes the marker for wiring tests", () => {
    const { tracker } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: "c1" }));
    expect(readValidMarker(readStore(), 1_000)).toMatchObject({ life: "L1", originEpoch: "M-cur" });
  });
});

describe("publish discipline + tick (D5/D6, A12/G3)", () => {
  it("G3: events with no record, or a projection that does not change, never publish", () => {
    const { tracker, publish } = makeTracker(makeEnv());
    tracker.onPhase(ev("started", { by: undefined })); // TUI fact, no record
    tracker.onPhase(ev("returned", { by: undefined }));
    expect(publish).not.toHaveBeenCalled();
    expect(tracker.projection()).toBeUndefined();
  });

  it("A12: an expired record retracts through tick() exactly once; later ticks stay silent", () => {
    const t = { v: 1_000 };
    const { tracker } = makeTracker(makeEnv({ now: () => t.v }));
    tracker.onPhase(ev("deferred", { by: "c1", waitingFor: "idle" }));
    expect(tracker.tick()).toBe(false); // current projection already observed at apply time
    t.v += RELOAD_REC_TTL_OPEN_MS + 1;
    expect(tracker.tick()).toBe(true); // expiry ⇒ one retraction publish
    expect(tracker.tick()).toBe(false); // …and never again (projection stays undefined)
    t.v += 5_000;
    expect(tracker.tick()).toBe(false);
  });
});
