/**
 * Hold phase machine unit tests (plan §4.3 A2, §5, §9 anchor `hold-driver.test.ts`), updated for
 * v4.3's Y1 override: B1 is lifted ONLY by `onConsumed` (E2); `onObserved` (E1) is display-only.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHoldBuffer, type HoldBuffer, type HoldItem } from "../../../src/web-hub/agent/hold.js";
import {
  createHoldDriver,
  HANDOFF_CONFIRM_MS,
  HOLD_CAP_GRACE_MS,
  type DispatchOutcome,
  type HoldDriverDeps,
  type HoldRequest,
} from "../../../src/web-hub/agent/hold-driver.js";
import type { CmdOrigin } from "../../../src/web-hub/protocol/messages.js";

const ORIGIN: CmdOrigin = { listener: "loopback", ip: "127.0.0.1", reqId: "r1" };

function req(cmdId: string, overrides: Partial<HoldRequest> = {}): HoldRequest {
  return { cmdId, text: overrides.text ?? `text-${cmdId}`, deliver: overrides.deliver ?? "steer", origin: ORIGIN };
}

interface FakeCtx extends ExtensionContext {
  setPending(v: boolean): void;
  setAborted(v: boolean): void;
}

function makeCtx(opts: { aborted?: boolean; idle?: boolean; pending?: boolean; sessionId?: string } = {}): FakeCtx {
  let pending = opts.pending ?? false;
  let aborted = opts.aborted ?? false;
  const ctx = {
    get signal() {
      return aborted ? ({ aborted: true } as AbortSignal) : undefined;
    },
    isIdle: () => opts.idle ?? false,
    hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => opts.sessionId ?? "s1" },
    setPending: (v: boolean) => {
      pending = v;
    },
    setAborted: (v: boolean) => {
      aborted = v;
    },
  };
  return ctx as unknown as FakeCtx;
}

/** Stand-in for the REF'd confirm-phase timer: `setImmediate`-based so tests don't burn real wall
 * clock on the 200 ms/2 ms bounds, while still exercising genuinely async control flow. Tracks
 * every timer created/cancelled for leak assertions (Y6.4). */
function makeTimerHarness() {
  const live = new Set<NodeJS.Immediate>();
  let created = 0;
  let cancelled = 0;
  return {
    setRefTimer(_ms: number, fn: () => void) {
      created += 1;
      const handle = setImmediate(() => {
        live.delete(handle);
        fn();
      });
      live.add(handle);
      return {
        cancel() {
          if (live.delete(handle)) {
            cancelled += 1;
            clearImmediate(handle);
          }
        },
      };
    },
    nextMacrotask: () => new Promise<void>((r) => setImmediate(r)),
    get liveCount() {
      return live.size;
    },
    get created() {
      return created;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function makeDeps(
  opts: {
    buffer?: HoldBuffer;
    sessionId?: string;
    holdCap?: boolean;
    dispatch?: (item: HoldItem) => DispatchOutcome;
  } = {},
) {
  const buffer = opts.buffer ?? createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
  const timers = makeTimerHarness();
  const onReturned = vi.fn();
  const publish = vi.fn();
  const dispatchToPi = vi.fn(opts.dispatch ?? (() => "sent" as DispatchOutcome));
  // Real wall clock + a manual offset: the confirm() phase's polling loop bounds itself against
  // `deps.now() < deadline`, which would spin forever under a frozen clock whenever
  // `ctx.hasPendingMessages()` never flips true in a test (no real pi underneath to flip it).
  let offset = 0;
  const deps: HoldDriverDeps = {
    buffer,
    owner: "owner-1",
    getSessionId: () => opts.sessionId ?? "s1",
    holdCap: () => opts.holdCap ?? true,
    dispatchToPi,
    onReturned,
    publish,
    now: () => Date.now() + offset,
    setRefTimer: timers.setRefTimer,
    nextMacrotask: timers.nextMacrotask,
  };
  return {
    deps,
    buffer,
    timers,
    onReturned,
    publish,
    dispatchToPi,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

describe("createHoldDriver — canHold", () => {
  it("true when every condition holds", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    expect(drv.canHold(req("a"), ctx)).toBe(true);
  });

  it("false when holdCap() is false", () => {
    const { deps } = makeDeps({ holdCap: false });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });

  it("false outside the 'armed' phase", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    expect(drv.phase()).toBe("idle");
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });

  it("false when ctx.isIdle()", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx({ idle: true });
    drv.onContext(ctx);
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });

  it("false when the signal is aborted", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    ctx.setAborted(true);
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });

  it("false after onWebAbort latches abort", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.onWebAbort();
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });

  it("false for text starting with '@' (bypass)", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    expect(drv.canHold(req("a", { text: "@label hi" }), ctx)).toBe(false);
    expect(drv.canHold(req("a", { text: "  @label hi" }), ctx)).toBe(false);
  });

  it("false once the session reaches HOLD_MAX_ITEMS", () => {
    const { deps, buffer } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    for (let i = 0; i < 16; i++) expect(drv.hold(req(`h${i}`))).toBe(true);
    expect(buffer.countHeld("s1")).toBe(16);
    expect(drv.canHold(req("overflow"), ctx)).toBe(false);
  });

  it("false when ctx's session differs from the driver's session", () => {
    const { deps } = makeDeps({ sessionId: "s1" });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx({ sessionId: "other" });
    drv.onContext(ctx);
    expect(drv.canHold(req("a"), ctx)).toBe(false);
  });
});

describe("createHoldDriver — arming", () => {
  it("onContext arms from idle", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    expect(drv.phase()).toBe("armed");
  });

  it("onContext does not arm when the signal is already aborted", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx({ aborted: true }));
    expect(drv.phase()).toBe("idle");
  });

  it("onAssistantMessageStart arms as a fallback from idle/between", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onAssistantMessageStart(makeCtx());
    expect(drv.phase()).toBe("armed");
  });
});

describe("createHoldDriver — hold/recall delegate to the buffer", () => {
  it("hold() stores an item owned by this driver's `owner`", () => {
    const { deps, buffer } = makeDeps();
    const drv = createHoldDriver(deps);
    expect(drv.hold(req("a"))).toBe(true);
    expect(buffer.held("s1")[0]).toMatchObject({ cmdId: "a", owner: "owner-1", sessionId: "s1" });
  });

  it("recall() delegates to buffer.recall()", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.hold(req("a"));
    expect(drv.recall("a")).toMatchObject({ kind: "recalled", from: "held" });
    expect(drv.recall("a")).toEqual({ kind: "unknown" });
  });
});

describe("createHoldDriver — onTurnEnd / onAgentEnd dispatch (§5.2)", () => {
  it("dispatches the first held steer, moves to 'between' before any await, and returns a promise", async () => {
    const { deps, dispatchToPi, publish } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const result = drv.onTurnEnd({ outcome: "completed" }, ctx);
    // I-SYNC: phase flips to 'between' synchronously, before the confirm() await settles.
    expect(drv.phase()).toBe("between");
    expect(dispatchToPi).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalled();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it("empty buffer: turn_end is a synchronous no-op (zero overhead) and returns undefined", () => {
    const { deps, dispatchToPi } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    const result = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(result).toBeUndefined();
    expect(dispatchToPi).not.toHaveBeenCalled();
    expect(drv.phase()).toBe("between");
  });

  it("aborted turn_end returns every held item instead of dispatching", () => {
    const { deps, buffer, dispatchToPi, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.hold(req("b"));
    ctx.setAborted(true);
    const result = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(result).toBeUndefined();
    expect(dispatchToPi).not.toHaveBeenCalled();
    expect(buffer.held("s1")).toHaveLength(0);
    expect(onReturned).toHaveBeenCalledTimes(1);
    const returnedIds = (onReturned.mock.calls[0]?.[0] as HoldItem[]).map((h) => h.cmdId).sort();
    expect(returnedIds).toEqual(["a", "b"]);
  });

  it("allowFU: a followUp is only dispatched on a non-tool, no-pending, steer-free stopping turn", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("fu", { deliver: "followUp" }));
    // a tool-call turn never dispatches a followUp.
    const toolTurn = drv.onTurnEnd({ outcome: "completed", message: { content: [{ type: "toolCall" }] } }, ctx);
    expect(toolTurn).toBeUndefined();
    expect(drv.heldCount()).toBe(1);
  });

  it("onAgentEnd: allowFU is always true", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("fu", { deliver: "followUp" }));
    const result = drv.onAgentEnd(ctx);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(drv.heldCount()).toBe(0);
  });

  it("onAgentEnd while blocked (B1) returns all remaining held items instead of waiting (R-A/Y7.1)", async () => {
    const { deps, buffer, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("first"));
    drv.hold(req("second"));
    const turnEnd = drv.onTurnEnd({ outcome: "completed" }, ctx);
    // "first" is now inflight (B1 blocked — no onConsumed yet).
    expect(drv.inflightCmdId()).toBe("first");
    expect(buffer.held("s1").map((h) => h.cmdId)).toEqual(["second"]);
    const agentEnd = drv.onAgentEnd(ctx);
    expect(agentEnd).toBeUndefined(); // never dispatches while blocked — returns synchronously
    expect(buffer.held("s1")).toHaveLength(0);
    expect(onReturned).toHaveBeenCalled();
    const returnedIds = (onReturned.mock.calls.at(-1)?.[0] as HoldItem[]).map((h) => h.cmdId);
    expect(returnedIds).toEqual(["second"]);
    await turnEnd;
  });
});

describe("createHoldDriver — B1 / Y1 (E2-only lift)", () => {
  it("a second held item stays blocked until onConsumed fires for the inflight cmdId", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("first"));
    drv.hold(req("second"));
    const firstTurnEnd = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.inflightCmdId()).toBe("first");
    await firstTurnEnd;
    // confirm() (E1-only) has fully settled, but inflight must still be "first" (Y1: E1 never lifts B1).
    expect(drv.inflightCmdId()).toBe("first");
    drv.onContext(ctx); // next turn's arm
    const secondTurnEndBlocked = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(secondTurnEndBlocked).toBeUndefined(); // blocked — nothing dispatched this hook
    expect(drv.heldCount()).toBe(1); // "second" is still sitting held, untouched
    drv.onConsumed("first"); // E2: the ONLY lift of B1
    expect(drv.inflightCmdId()).toBeUndefined();
    drv.onContext(ctx);
    const thirdTurnEnd = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(thirdTurnEnd).toBeInstanceOf(Promise);
    expect(drv.inflightCmdId()).toBe("second");
    await thirdTurnEnd;
  });

  it("onObserved (E1) never clears inflight by itself", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    drv.onObserved("a"); // E1 — display-only
    await p;
    expect(drv.inflightCmdId()).toBe("a");
  });

  it("onConsumed for a cmdId that is not the current inflight item is a no-op", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    void drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.inflightCmdId()).toBe("a");
    drv.onConsumed("some-other-cmdid");
    expect(drv.inflightCmdId()).toBe("a");
  });
});

describe("createHoldDriver — Y8.1 stale-B1 liveness degrade (verifier r_KRNMK1YR)", () => {
  /** Lead-in: run 1 dispatches "s1" at a turn_end and ends (agent_end) without E2 ever arriving
   * for it — the canonical stale case (e.g. a third-party input handler swallowed the send). */
  async function leadStale(drv: ReturnType<typeof createHoldDriver>, ctx: FakeCtx): Promise<void> {
    drv.onContext(ctx);
    drv.hold(req("s1"));
    await drv.onTurnEnd({ outcome: "completed" }, ctx); // dispatch "s1" in run 1
    expect(drv.inflightCmdId()).toBe("s1");
    drv.onAgentEnd(ctx); // run 1 ends — no onConsumed ever fires for "s1"
    drv.onContext(ctx); // run 2 arms
  }

  it("a prompt arriving in a LATER run (previous agent_end passed without E2) is refused — commands.ts must deliver it natively — while B1 itself is never lifted", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    await leadStale(drv, ctx);
    expect(drv.canHold(req("s2"), makeCtx())).toBe(false); // Y8.1: degrade ⇒ native path
    expect(drv.inflightCmdId()).toBe("s1"); // B1 NEVER lifted by agent_end or any timer
  });

  it("same-run blocking is unchanged: while the inflight item's run is STILL running, prompts are held (canHold true)", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("s1"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx); // dispatched in the CURRENT run
    drv.onContext(ctx); // a later point of the SAME run (no agent_end has fired)
    expect(drv.canHold(req("s2"), ctx)).toBe(true); // held, not degraded
    await p;
  });

  it("an item dispatched BY an agent_end hook gets its consumption run: not stale until THAT run's agent_end also passes without E2", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("last"));
    const p = drv.onAgentEnd(ctx); // run 1's final hook dispatches "last" — queued for run 2
    expect(drv.inflightCmdId()).toBe("last");
    await p;
    drv.onContext(ctx); // run 2 ("last"'s first consumption opportunity) — hold normally
    expect(drv.canHold(req("s2"), ctx)).toBe(true);
    drv.onAgentEnd(ctx); // run 2 ALSO ends without E2 for "last"
    drv.onContext(ctx); // run 3
    expect(drv.canHold(req("s3"), ctx)).toBe(false); // NOW stale ⇒ native
    expect(drv.inflightCmdId()).toBe("last"); // still never lifted, never resent
  });

  it("late E2 for the stale item lifts B1 and prompts are held again", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    await leadStale(drv, ctx);
    expect(drv.canHold(req("s2"), ctx)).toBe(false); // degraded first
    drv.onConsumed("s1"); // the stale item's E2 finally arrives
    expect(drv.inflightCmdId()).toBeUndefined();
    expect(drv.canHold(req("s3"), makeCtx())).toBe(true); // held again
  });

  it("a session boundary clears the stale block: prompts are held again after onSessionStart / onSessionShutdown", async () => {
    const { deps: depsA } = makeDeps();
    const drvA = createHoldDriver(depsA);
    const ctxA = makeCtx();
    await leadStale(drvA, ctxA);
    expect(drvA.canHold(req("s2"), ctxA)).toBe(false); // degraded before the boundary
    drvA.onSessionStart(makeCtx());
    drvA.onContext(makeCtx());
    expect(drvA.canHold(req("s2"), makeCtx())).toBe(true); // held again

    const { deps: depsB } = makeDeps();
    const drvB = createHoldDriver(depsB);
    const ctxB = makeCtx();
    await leadStale(drvB, ctxB);
    drvB.onSessionShutdown("quit");
    drvB.onContext(makeCtx());
    expect(drvB.canHold(req("s2"), makeCtx())).toBe(true); // held again
  });

  it("Y8.3: dispose() clears inflight — a disposed driver no longer reports a B1 block", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    await leadStale(drv, ctx);
    expect(drv.inflightCmdId()).toBe("s1");
    drv.dispose();
    expect(drv.inflightCmdId()).toBeUndefined();
  });
});

describe("createHoldDriver — turn_start skip-detect (A-SKIP, best-effort)", () => {
  it("dispatches a held steer when phase is still 'armed' at turn_start (previous turn_end skipped)", () => {
    const { deps, dispatchToPi } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTurnStart(ctx); // phase still 'armed' ⇒ skip-detect fires
    expect(dispatchToPi).toHaveBeenCalledTimes(1);
    expect(drv.phase()).toBe("between");
  });

  it("does nothing when phase is not 'armed' (no false positive)", () => {
    const { deps, dispatchToPi } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onTurnStart(ctx); // phase is 'idle' — never fires
    expect(dispatchToPi).not.toHaveBeenCalled();
  });

  it("never dispatches a followUp (allowFU=false at turn_start)", () => {
    const { deps, dispatchToPi } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("fu", { deliver: "followUp" }));
    drv.onTurnStart(ctx);
    expect(dispatchToPi).not.toHaveBeenCalled();
  });

  it("skip-detect respects B1 (never dispatches while blocked)", () => {
    const { deps, dispatchToPi } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("first"));
    void drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.inflightCmdId()).toBe("first");
    drv.hold(req("second"));
    drv.onContext(ctx); // re-arm (simulating a new request)
    dispatchToPi.mockClear();
    drv.onTurnStart(ctx);
    expect(dispatchToPi).not.toHaveBeenCalled();
  });
});

describe("createHoldDriver — onAgentSettled (I-EMPTY, never dispatches)", () => {
  it("settled with nothing held: phase → idle, no dispatch, no return", () => {
    const { deps, dispatchToPi, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    drv.onAgentSettled(makeCtx());
    expect(drv.phase()).toBe("idle");
    expect(dispatchToPi).not.toHaveBeenCalled();
    expect(onReturned).not.toHaveBeenCalled();
  });

  it("D-LEFTOVER: a defensive leftover at settled is returned{stale}, zero dispatch", () => {
    const { deps, buffer, dispatchToPi, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    drv.hold(req("leftover")); // forced leftover, simulating "cannot happen by construction"
    drv.onAgentSettled(makeCtx());
    expect(dispatchToPi).not.toHaveBeenCalled();
    expect(buffer.held("s1")).toHaveLength(0);
    expect(onReturned).toHaveBeenCalledTimes(1);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ cmdId: "leftover", reason: "stale" });
    expect(drv.phase()).toBe("idle");
  });

  it("P0 fix (verifier r_BHFA552J): inflight SURVIVES agent_settled — only onConsumed/session-boundary/dispose clear it", async () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.inflightCmdId()).toBe("a");
    drv.onAgentSettled(ctx);
    expect(drv.inflightCmdId()).toBe("a"); // NOT cleared — clearing here would let a later run's
    // first send race ahead of this run's still-unconsumed one (cross-run reorder, P0 blocker).
    drv.onConsumed("a"); // the only thing that lifts it
    expect(drv.inflightCmdId()).toBeUndefined();
    await p;
  });

  it("a late onConsumed for the PREVIOUS run's send still lifts B1 inside a NEW run", async () => {
    const { deps, buffer } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("prev-run-item"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(drv.inflightCmdId()).toBe("prev-run-item");
    drv.onAgentSettled(ctx); // run #1 ends; inflight survives
    // run #2 starts (same session, same driver instance — no session boundary in between).
    drv.onContext(ctx);
    drv.hold(req("run2-item"));
    const blockedTurnEnd = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(blockedTurnEnd).toBeUndefined(); // still blocked by run #1's send
    expect(buffer.held("s1").map((h) => h.cmdId)).toEqual(["run2-item"]);
    drv.onConsumed("prev-run-item"); // the late E2 finally arrives
    expect(drv.inflightCmdId()).toBeUndefined();
    drv.onContext(ctx);
    const unblockedTurnEnd = drv.onTurnEnd({ outcome: "completed" }, ctx);
    expect(unblockedTurnEnd).toBeInstanceOf(Promise);
    expect(drv.inflightCmdId()).toBe("run2-item");
    await p;
    await unblockedTurnEnd;
  });

  it("if the previous run's send NEVER lands, a new run's held item is returned at THAT run's agent_end (bounded, no deadlock)", async () => {
    const { deps, buffer, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("prev-run-item"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    drv.onAgentSettled(ctx); // run #1 ends, inflight survives, onConsumed never arrives
    drv.onContext(ctx); // run #2
    drv.hold(req("run2-item"));
    void drv.onTurnEnd({ outcome: "completed" }, ctx); // still blocked — nothing dispatched
    expect(buffer.held("s1").map((h) => h.cmdId)).toEqual(["run2-item"]);
    const agentEnd = drv.onAgentEnd(ctx); // run #2 ends, still blocked → R-A returns everything
    expect(agentEnd).toBeUndefined();
    expect(buffer.held("s1")).toHaveLength(0);
    expect((onReturned.mock.calls.at(-1)?.[0] as HoldItem[]).map((h) => h.cmdId)).toEqual(["run2-item"]);
    await p;
  });
});

describe("createHoldDriver — onWebAbort", () => {
  it("latches abort and returns every currently-held item of this session", () => {
    const { deps, buffer, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    drv.hold(req("a"));
    drv.onWebAbort();
    expect(buffer.held("s1")).toHaveLength(0);
    expect(onReturned).toHaveBeenCalledTimes(1);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ reason: "aborted" });
  });
});

describe("createHoldDriver — session boundaries", () => {
  it("onSessionStart adopts foreign-owner leftovers as returned{reload} and resets local state", () => {
    const buffer = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    buffer.hold(
      { cmdId: "stale", sessionId: "s1", owner: "old-owner", text: "x", deliver: "steer", origin: ORIGIN, at: 0 },
      0,
    );
    const { deps, onReturned } = makeDeps({ buffer });
    const drv = createHoldDriver(deps);
    drv.onSessionStart(makeCtx());
    expect(onReturned).toHaveBeenCalledTimes(1);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ cmdId: "stale", reason: "reload" });
    expect(drv.phase()).toBe("idle");
  });

  it("onSessionShutdown returns the session's held items with 'session' (default) or 'reload'", () => {
    const { deps, buffer, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    drv.hold(req("a"));
    drv.onSessionShutdown("quit");
    expect(buffer.held("s1")).toHaveLength(0);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ reason: "session" });
  });

  it("onSessionShutdown('reload') uses reason 'reload'", () => {
    const { deps, onReturned } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    drv.hold(req("a"));
    drv.onSessionShutdown("reload");
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ reason: "reload" });
  });
});

describe("createHoldDriver — onTick (§5.6, never touches phase, I-SERIAL)", () => {
  it("never mutates phase", () => {
    const { deps } = makeDeps();
    const drv = createHoldDriver(deps);
    drv.onContext(makeCtx());
    expect(drv.phase()).toBe("armed");
    drv.onTick(makeCtx());
    expect(drv.phase()).toBe("armed");
  });

  it("cap-down grace: hands out held items once the cap has been unavailable ≥ HOLD_CAP_GRACE_MS", () => {
    const { deps, dispatchToPi, advance } = makeDeps({ holdCap: false });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTick(ctx); // arms capDownSince
    expect(dispatchToPi).not.toHaveBeenCalled();
    advance(HOLD_CAP_GRACE_MS + 1);
    drv.onTick(ctx);
    expect(dispatchToPi).toHaveBeenCalledTimes(1);
  });

  it("cap-down grace with no live ctx returns the item instead of dispatching", () => {
    const { deps, buffer, onReturned, advance } = makeDeps({ holdCap: false });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTick(ctx);
    advance(HOLD_CAP_GRACE_MS + 1);
    drv.onTick(undefined);
    expect(buffer.held("s1")).toHaveLength(0);
    expect((onReturned.mock.calls[0]?.[0] as HoldItem[])[0]).toMatchObject({ reason: "stale" });
  });

  it("cap recovering before the grace elapses clears capDownSince (no flush)", () => {
    const { deps, dispatchToPi, advance } = makeDeps({ holdCap: false });
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.onTick(ctx);
    advance(HOLD_CAP_GRACE_MS - 1);
    deps.holdCap = () => true; // recovers just in time
    drv.onTick(ctx);
    advance(HOLD_CAP_GRACE_MS - 1); // would have tripped from the ORIGINAL capDownSince
    drv.onTick(ctx);
    expect(dispatchToPi).not.toHaveBeenCalled();
  });

  it("max-age flush dispatches an item once it has been held ≥ HOLD_MAX_MS", () => {
    const { deps, dispatchToPi, advance } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    advance(30 * 60_000 + 1);
    drv.onTick(ctx);
    expect(dispatchToPi).toHaveBeenCalledTimes(1);
  });

  it("at most one dispatch per tick call (I-SERIAL)", () => {
    const { deps, dispatchToPi, advance } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    drv.hold(req("b"));
    advance(30 * 60_000 + 1);
    drv.onTick(ctx);
    expect(dispatchToPi).toHaveBeenCalledTimes(1);
  });

  it("calls buffer.sweep() unconditionally even with nothing to flush", () => {
    const buffer = createHoldBuffer({ bag: { v: 1, rev: 0, items: new Map() } });
    const sweepSpy = vi.spyOn(buffer, "sweep");
    const { deps } = makeDeps({ buffer });
    const drv = createHoldDriver(deps);
    drv.onTick(makeCtx());
    expect(sweepSpy).toHaveBeenCalled();
  });
});

describe("createHoldDriver — §6 bounded confirm phase, T-REF timer leak checks (Y6.4)", () => {
  it("confirm() cancels its cap timer once observation wins the race — no leaked timers", async () => {
    const { deps, timers } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx({ pending: true }); // pendingBefore=true ⇒ skips the poll loop after the race
    drv.onContext(ctx);
    drv.hold(req("a"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    drv.onObserved("a"); // resolves `observed` before the cap timer's setImmediate fires
    await p;
    expect(timers.liveCount).toBe(0);
    expect(timers.cancelled).toBeGreaterThan(0);
  });

  it("confirm() settles even when no observation ever arrives (cap timeout path, still cancels)", async () => {
    const { deps, timers } = makeDeps();
    const drv = createHoldDriver(deps);
    const ctx = makeCtx();
    drv.onContext(ctx);
    drv.hold(req("a"));
    const p = drv.onTurnEnd({ outcome: "completed" }, ctx);
    await p; // never calls onObserved — must still settle via the cap timer, not hang
    expect(timers.liveCount).toBe(0);
  });
});
