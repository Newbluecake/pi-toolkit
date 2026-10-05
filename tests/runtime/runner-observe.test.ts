import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { isTerminalStatus } from "../../src/core/status.js";
import type { EffectEnvelope, RunExitFacts, RunStatus } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type EffectInterpreter,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";

/**
 * fleet-drawer plan §4.1 (#1/#7) + §9 F1 acceptance, against a REAL
 * RuntimeRunner (per the plan's "用真实 RuntimeRunner 测试"):
 *
 * final_leaf:
 *   - sealBeforeTerminal dispatches `final_leaf` strictly BEFORE `exit_facts`
 *     and BEFORE the `if (facts === undefined) return;` gate — a run with NO
 *     bash facts still records its leaf;
 *   - getLeafId absent / null / throwing ⇒ no finalLeafId, run unaffected;
 *   - the leaf lands on the terminal outcome's diag.
 *
 * observeRun / peekRunBranch:
 *   - all four registration states (unknown / terminal / no_session×3 /
 *     attached), the 16-observer cap (with detach freeing a slot);
 *   - onEnd exactly once across the terminal-dispatch and finally paths
 *     (including the finally-only path: a throwing effects interpreter makes
 *     the terminal dispatch's endObservers site unreachable);
 *   - detach never fires onEnd and stops event delivery;
 *   - listener exceptions (onEvent and onEnd) never affect the run or the
 *     other observers;
 *   - peekRunBranch serves the live handle's branch and turns undefined once
 *     the run is terminal.
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 20,
  bindMs: 20,
  totalMs: 30,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};
const request: ResolvedSpawnRequest = { runId: "r", prompt: "hello" };
const never = <T>() => new Promise<T>(() => undefined);

const pump = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "answer",
    getUsage: () => undefined,
    ...overrides,
  };
}

/** A handle whose observe() captures the raw push function, like a real session.subscribe. */
interface ObserveHandle {
  handle: SessionHandle;
  push(e: unknown): void;
  unsubbed: number;
}
function observingHandle(overrides: Partial<SessionHandle> = {}): ObserveHandle {
  let push: ((e: unknown) => void) | undefined;
  const h: ObserveHandle = {
    unsubbed: 0,
    push: (e) => push?.(e),
    handle: handle({
      prompt: () => never(),
      observe: (l) => {
        push = l;
        return () => {
          h.unsubbed++;
          push = undefined;
        };
      },
      ...overrides,
    }),
  };
  return h;
}

function makeFacts(tag: string): RunExitFacts {
  return {
    bashJobs: [
      {
        jobId: `j_${tag}`,
        commandPreview: "sleep 5",
        state: "completed",
        exitCode: 0,
        logPath: `/tmp/${tag}.log`,
        durationMs: 1,
        seen: true,
      },
    ],
  };
}

interface StateLogEntry {
  status: RunStatus;
  finalLeafId?: string;
  exitFacts?: RunExitFacts;
}

function harness(
  driver: SessionDriver,
  opts: { seal?: (runId: string, sessionId: string) => RunExitFacts | undefined; effects?: EffectInterpreter } = {},
) {
  const clock = new FakeClock();
  const stateLog: StateLogEntry[] = [];
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: opts.effects ?? new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
    onStateChange: (_runId, state) => {
      stateLog.push({ status: state.status, finalLeafId: state.diag.finalLeafId, exitFacts: state.diag.exitFacts });
    },
    ...(opts.seal ? { sealSession: opts.seal } : {}),
  };
  return { clock, runner: new RuntimeRunner(d), stateLog };
}

/** A driver whose handle is observable; prompt never resolves until finish() is called. */
function liveHarness(
  opts: {
    handleOverrides?: Partial<SessionHandle>;
    seal?: (runId: string, sessionId: string) => RunExitFacts | undefined;
  } = {},
) {
  const obs = observingHandle(opts.handleOverrides);
  const h = harness(
    { create: async () => obs.handle, bind: async () => undefined, onLateArrival() {} },
    { seal: opts.seal },
  );
  return { ...h, obs };
}

describe("final_leaf: sealBeforeTerminal records the run's leaf (fleet-drawer plan §4.1 #1)", () => {
  it("no bash facts at all (sealSession undefined / absent): the leaf is still written, before the terminal state", async () => {
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-leaf", getLeafId: () => "e_leaf_9" }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      { seal: () => undefined }, // explicitly no facts — must NOT gate the leaf
    );
    const outcome = await h.runner.run({ ...request, runId: "r-leaf" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.finalLeafId).toBe("e_leaf_9");
    // final_leaf is its own, strictly-earlier dispatch: the log walks a
    // non-terminal state carrying the leaf BEFORE the first terminal one.
    const leafDispatch = h.stateLog.find((e) => e.finalLeafId === "e_leaf_9");
    expect(leafDispatch).toBeDefined();
    expect(isTerminalStatus(leafDispatch!.status)).toBe(false);
    expect(h.stateLog.find((e) => isTerminalStatus(e.status))!.finalLeafId).toBe("e_leaf_9");
  });

  it("final_leaf is dispatched BEFORE exit_facts when both exist", async () => {
    const facts = makeFacts("order");
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-order", getLeafId: () => "e_leaf_1" }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      { seal: () => facts },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-order" }, budget);
    expect(outcome.status).toBe("completed");
    // Walk: some state with leaf but no facts must appear strictly before any
    // state with facts (both before the first terminal state).
    const idxLeaf = h.stateLog.findIndex((e) => e.finalLeafId === "e_leaf_1");
    const idxFacts = h.stateLog.findIndex((e) => e.exitFacts !== undefined);
    const idxTerminal = h.stateLog.findIndex((e) => isTerminalStatus(e.status));
    expect(idxLeaf).toBeGreaterThanOrEqual(0);
    expect(idxFacts).toBeGreaterThan(idxLeaf);
    expect(idxTerminal).toBeGreaterThan(idxFacts);
    expect(outcome.diag.finalLeafId).toBe("e_leaf_1");
    expect(outcome.diag.exitFacts).toEqual(facts);
  });

  it("getLeafId returning null, or absent, or throwing ⇒ no finalLeafId and the run still settles", async () => {
    for (const variant of [
      { name: "absent", overrides: {} },
      { name: "null", overrides: { getLeafId: () => null } },
      {
        name: "throwing",
        overrides: {
          getLeafId: () => {
            throw new Error("leaf read exploded");
          },
        },
      },
    ] as const) {
      const h = harness({
        create: async () => handle({ sessionId: `s-${variant.name}`, ...variant.overrides }),
        bind: async () => undefined,
        onLateArrival() {},
      });
      const outcome = await h.runner.run({ ...request, runId: `r-${variant.name}` }, budget);
      expect(outcome.status).toBe("completed");
      expect(outcome.diag.finalLeafId).toBeUndefined();
    }
  });

  it("a run that never bound a session (create rejected) has no leaf", async () => {
    const h = harness({
      create: () => Promise.reject(new Error("no session")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run({ ...request, runId: "r-nosession" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.diag.finalLeafId).toBeUndefined();
  });
});

describe("observeRun: registration four-states (fleet-drawer plan §4.1 #7)", () => {
  it("unknown: a runId this runner never saw", async () => {
    const h = harness({ create: async () => handle(), bind: async () => undefined, onLateArrival() {} });
    expect(h.runner.observeRun("r-ghost", { onEvent: () => undefined, onEnd: () => undefined })).toEqual({
      kind: "unknown",
    });
  });

  it("no_session: run exists, still queued/creating (create pending ⇒ no handle yet)", async () => {
    let releaseCreate: ((h: SessionHandle) => void) | undefined;
    const createP = new Promise<SessionHandle>((resolve) => (releaseCreate = resolve));
    const h = harness({ create: () => createP, bind: async () => undefined, onLateArrival() {} });
    const p = h.runner.run({ ...request, runId: "r-creating" }, budget);
    await pump();
    const verdict = h.runner.observeRun("r-creating", { onEvent: () => undefined, onEnd: () => undefined });
    expect(verdict).toEqual({ kind: "no_session" });
    releaseCreate!(handle({ prompt: () => never() }));
    await pump();
    await h.runner.abortRun("r-creating", "user_stop");
    await p;
  });

  it("no_session: handle does not support observe", async () => {
    const h = liveHarness({ handleOverrides: { observe: undefined } });
    const p = h.runner.run({ ...request, runId: "r-noobserve" }, budget);
    await pump();
    expect(h.runner.observeRun("r-noobserve", { onEvent: () => undefined, onEnd: () => undefined })).toEqual({
      kind: "no_session",
    });
    await h.runner.abortRun("r-noobserve", "user_stop");
    await p;
  });

  it("no_session: a handle whose observe() throws", async () => {
    const h = liveHarness({
      handleOverrides: {
        observe: () => {
          throw new Error("subscribe exploded");
        },
      },
    });
    const p = h.runner.run({ ...request, runId: "r-throwing-sub" }, budget);
    await pump();
    expect(h.runner.observeRun("r-throwing-sub", { onEvent: () => undefined, onEnd: () => undefined })).toEqual({
      kind: "no_session",
    });
    await h.runner.abortRun("r-throwing-sub", "user_stop");
    await p;
  });

  it("terminal: after the run settles, registration is refused with the terminal status (late arrivals never get a handle)", async () => {
    const h = harness({ create: async () => handle(), bind: async () => undefined, onLateArrival() {} });
    await h.runner.run({ ...request, runId: "r-done" }, budget);
    expect(h.runner.observeRun("r-done", { onEvent: () => undefined, onEnd: () => undefined })).toEqual({
      kind: "terminal",
      status: "completed",
    });
    // a run that failed at create: same story for its late-arriving handle
    const h2 = harness({
      create: () => Promise.reject(new Error("x")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    await h2.runner.run({ ...request, runId: "r-failed" }, budget);
    expect(h2.runner.observeRun("r-failed", { onEvent: () => undefined, onEnd: () => undefined })).toEqual({
      kind: "terminal",
      status: "failed",
    });
  });

  it("attached: session events flow to onEvent", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-live" }, budget);
    await pump();
    const events: unknown[] = [];
    const verdict = h.runner.observeRun("r-live", { onEvent: (e) => events.push(e), onEnd: () => undefined });
    expect(verdict.kind).toBe("attached");
    h.obs.push({ type: "message_update", delta: "a" });
    h.obs.push({ type: "turn_start" });
    expect(events).toEqual([{ type: "message_update", delta: "a" }, { type: "turn_start" }]);
    await h.runner.abortRun("r-live", "user_stop");
    await p;
  });

  it("cap: at most 16 observers per run; the 17th is no_session; a detach frees the slot", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-cap" }, budget);
    await pump();
    const listener = { onEvent: () => undefined, onEnd: () => undefined };
    const attached = [];
    for (let i = 0; i < 16; i++) {
      const v = h.runner.observeRun("r-cap", listener);
      expect(v.kind).toBe("attached");
      attached.push(v as { kind: "attached"; detach(): void });
    }
    expect(h.runner.observeRun("r-cap", listener)).toEqual({ kind: "no_session" });
    attached[0]!.detach();
    const again = h.runner.observeRun("r-cap", listener);
    expect(again.kind).toBe("attached");
    (again as { kind: "attached"; detach(): void }).detach();
    await h.runner.abortRun("r-cap", "user_stop");
    await p;
  });
});

/** A prompt that stays pending until settle() — so the run is genuinely in-flight when the observer attaches. */
function settleablePrompt(): { prompt: () => Promise<void>; settle(): void } {
  let settle: (() => void) | undefined;
  const p = new Promise<void>((resolve) => (settle = resolve));
  return { prompt: () => p, settle: () => settle!() };
}

describe("observeRun: onEnd exactly once across the dispatch and finally paths (plan §4.1 #7)", () => {
  it("normal completion: onEnd fires exactly once, with the terminal status, after run() fully settles", async () => {
    const pr = settleablePrompt();
    const h = liveHarness({ handleOverrides: { prompt: pr.prompt } });
    const ends: string[] = [];
    h.runner.run({ ...request, runId: "r-complete" }, budget).catch(() => undefined);
    await pump();
    const v = h.runner.observeRun("r-complete", { onEvent: () => undefined, onEnd: (s) => ends.push(s) });
    expect(v.kind).toBe("attached");
    pr.settle();
    await pump(50);
    expect(ends).toEqual(["completed"]);
  });

  it("user abort: onEnd exactly once with 'aborted'", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-abort" }, budget);
    await pump();
    const ends: string[] = [];
    h.runner.observeRun("r-abort", { onEvent: () => undefined, onEnd: (s) => ends.push(s) });
    await h.runner.abortRun("r-abort", "user_stop");
    await p;
    await pump();
    expect(ends).toEqual(["aborted"]);
  });

  it("total timeout: onEnd exactly once with 'timed_out'", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-timeout" }, budget);
    await pump();
    const ends: string[] = [];
    h.runner.observeRun("r-timeout", { onEvent: () => undefined, onEnd: (s) => ends.push(s) });
    h.clock.advance(budget.totalMs + 1);
    await pump(10);
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(ends).toEqual(["timed_out"]);
  });

  it("finally-only path: when the terminal dispatch's effects application throws before the endObservers site, the run() finally still fires onEnd exactly once", async () => {
    // An interpreter that explodes on the terminal-only persist_snapshot batch:
    // dispatch#1 (prompt_settled) then throws BEFORE its endObservers site; the
    // catch path's dispatch#2 sees wasTerminal=true (no second attempt); the
    // finally cleanup is the one that fires onEnd. Exactly the two-path
    // competition the plan's done-latch exists for.
    class ExplodingEffects extends BasicEffectInterpreter {
      apply(runId: string, generation: number, batch: readonly EffectEnvelope[]): void {
        if (batch.some((e) => e.effect.kind === "persist_snapshot")) throw new Error("effects exploded");
        super.apply(runId, generation, batch);
      }
    }
    const h = liveHarness();
    // rebuild the harness with the exploding interpreter (liveHarness wires the stock one)
    const pr = settleablePrompt();
    const clock = new FakeClock();
    const ends: string[] = [];
    const obs = observingHandle({ prompt: pr.prompt });
    const d: RunnerDeps = {
      clock,
      driver: { create: async () => obs.handle, bind: async () => undefined, onLateArrival() {} },
      pool: new SingleSlotPool(clock, 2),
      store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
      watchdog: { arm() {}, disarm() {}, tick() {} },
      reaper: new EscalatingReaper(clock),
      effects: new ExplodingEffects(),
      emit() {},
      deliver() {},
    };
    const runner = new RuntimeRunner(d);
    const outcomeP = runner.run({ ...request, runId: "r-explode" }, budget);
    await pump();
    const v = runner.observeRun("r-explode", { onEvent: () => undefined, onEnd: (s) => ends.push(s) });
    expect(v.kind).toBe("attached");
    pr.settle();
    const outcome = await outcomeP;
    expect(outcome.status).toBe("completed"); // the catch path still returns the settled outcome
    await pump();
    expect(ends).toEqual(["completed"]);
  });

  it("detach does not fire onEnd and stops event delivery", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-detach" }, budget);
    await pump();
    const events: unknown[] = [];
    const ends: string[] = [];
    const v = h.runner.observeRun("r-detach", { onEvent: (e) => events.push(e), onEnd: (s) => ends.push(s) });
    expect(v.kind).toBe("attached");
    h.obs.push({ type: "turn_start" });
    expect(events).toHaveLength(1);
    (v as { kind: "attached"; detach(): void }).detach();
    expect(h.obs.unsubbed).toBe(1);
    // The fake's push is gone after unsub; the runner's done-flag ALSO guards
    // a sloppy handle that keeps delivering — drive the raw listener path.
    h.obs.handle.observe?.(() => undefined); // no-op: proves observe still functional on the handle
    await h.runner.abortRun("r-detach", "user_stop");
    await p;
    await pump();
    expect(ends).toEqual([]); // detach ⇒ never an onEnd, not even from the terminal dispatch
  });

  it("a done-flagged observer ignores events even if a sloppy handle keeps pushing after unsub", async () => {
    // handle whose unsub does NOT stop delivery — the runner's own done-flag
    // must be the second line of defense.
    let push: ((e: unknown) => void) | undefined;
    const sloppy = handle({
      prompt: () => never(),
      observe: (l) => {
        push = l;
        return () => undefined; // unsub is a lie
      },
    });
    const h = harness({ create: async () => sloppy, bind: async () => undefined, onLateArrival() {} });
    const p = h.runner.run({ ...request, runId: "r-sloppy" }, budget);
    await pump();
    const events: unknown[] = [];
    const v = h.runner.observeRun("r-sloppy", { onEvent: (e) => events.push(e), onEnd: () => undefined });
    (v as { kind: "attached"; detach(): void }).detach();
    push?.({ type: "turn_start" });
    expect(events).toEqual([]);
    await h.runner.abortRun("r-sloppy", "user_stop");
    await p;
  });

  it("a throwing onEvent is swallowed: the run is unaffected and later events still arrive", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-throw-ev" }, budget);
    await pump();
    const seen: unknown[] = [];
    let first = true;
    h.runner.observeRun("r-throw-ev", {
      onEvent: (e) => {
        if (first) {
          first = false;
          throw new Error("onEvent exploded");
        }
        seen.push(e);
      },
      onEnd: () => undefined,
    });
    h.obs.push({ type: "turn_start" }); // throws inside the listener
    h.obs.push({ type: "turn_end" }); // still delivered
    expect(seen).toEqual([{ type: "turn_end" }]);
    await h.runner.abortRun("r-throw-ev", "user_stop");
    const outcome = await p;
    expect(outcome.status).toBe("aborted");
  });

  it("a throwing onEnd never affects the run's outcome nor the other observers' onEnd", async () => {
    const pr = settleablePrompt();
    const h = liveHarness({ handleOverrides: { prompt: pr.prompt } });
    const ends: string[] = [];
    h.runner.run({ ...request, runId: "r-throw-end" }, budget).catch(() => undefined);
    await pump();
    h.runner.observeRun("r-throw-end", {
      onEvent: () => undefined,
      onEnd: () => {
        throw new Error("onEnd exploded");
      },
    });
    h.runner.observeRun("r-throw-end", { onEvent: () => undefined, onEnd: (s) => ends.push(s) });
    pr.settle();
    await pump(50);
    expect(ends).toEqual(["completed"]);
  });
});

describe("peekRunBranch (fleet-drawer plan §4.1)", () => {
  it("serves the live handle's branch while the run is in flight; undefined for unknown/terminal/unsupported", async () => {
    const branch = [{ id: "e1" }, { id: "e2" }];
    const h = liveHarness({ handleOverrides: { getBranchEntries: () => branch } });
    expect(h.runner.peekRunBranch("r-peek")).toBeUndefined(); // unknown
    const p = h.runner.run({ ...request, runId: "r-peek" }, budget);
    await pump();
    expect(h.runner.peekRunBranch("r-peek")).toBe(branch);
    await h.runner.abortRun("r-peek", "user_stop");
    await p;
    await pump();
    expect(h.runner.peekRunBranch("r-peek")).toBeUndefined(); // terminal ⇒ handle cleaned up
  });

  it("a handle without getBranchEntries peeks undefined (run unaffected)", async () => {
    const h = liveHarness();
    const p = h.runner.run({ ...request, runId: "r-nopeek" }, budget);
    await pump();
    expect(h.runner.peekRunBranch("r-nopeek")).toBeUndefined();
    await h.runner.abortRun("r-nopeek", "user_stop");
    await p;
  });

  it("a throwing getBranchEntries peeks undefined", async () => {
    const h = liveHarness({
      handleOverrides: {
        getBranchEntries: () => {
          throw new Error("branch read exploded");
        },
      },
    });
    const p = h.runner.run({ ...request, runId: "r-throw-peek" }, budget);
    await pump();
    expect(h.runner.peekRunBranch("r-throw-peek")).toBeUndefined();
    await h.runner.abortRun("r-throw-peek", "user_stop");
    await p;
  });
});

describe("T5 (§10, runner side): resume — two runs sharing one append-only file record their own seal-time leaf", () => {
  it("run B's leaf descends from run A's; post-seal appends never enter A's branch walk", async () => {
    // A fake append-only session file with a parent chain, standing in for
    // pi's SessionManager: run A and run B (resume) share it, and a reap hook
    // appends one entry AFTER A's seal.
    const log: { id: string; parentId: string | null }[] = [];
    const append = (tag: string): string => {
      const entry = { id: `e_${tag}_${log.length}`, parentId: log.at(-1)?.id ?? null };
      log.push(entry);
      return entry.id;
    };
    const driver: SessionDriver = {
      create: async () =>
        handle({
          prompt: async () => {
            append("prompt");
            append("assistant");
          },
          getLeafId: () => log.at(-1)?.id ?? null,
        }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const h = harness(driver, { seal: () => undefined });

    const a = await h.runner.run({ ...request, runId: "rA" }, budget);
    expect(a.status).toBe("completed");
    const leafA = a.diag.finalLeafId;
    expect(leafA).toBeDefined();

    // A reap hook appends AFTER A's seal — by construction a descendant of
    // leafA, which is exactly what makes A's file-side walk deterministic.
    const postSealTip = append("reap_hook");
    expect(postSealTip).not.toBe(leafA);

    const b = await h.runner.run({ ...request, runId: "rB" }, budget);
    expect(b.status).toBe("completed");
    const leafB = b.diag.finalLeafId;
    expect(leafB).toBeDefined();
    expect(leafB).not.toBe(leafA);

    const ancestorsOf = (leaf: string): string[] => {
      const chain: string[] = [];
      for (let cur = log.find((e) => e.id === leaf); cur; cur = log.find((e) => e.id === cur.parentId))
        chain.push(cur.id);
      return chain;
    };
    // B (the resume) walks back through A's history — expected per §4.1;
    // A's own walk never reaches the post-seal append, and A's recorded leaf
    // stays valid (the file only ever appends).
    expect(ancestorsOf(leafB!)).toContain(leafA!);
    expect(ancestorsOf(leafA!)).not.toContain(postSealTip);
  });
});
