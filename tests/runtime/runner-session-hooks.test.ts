import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { isTerminalStatus } from "../../src/core/status.js";
import type { RunExitFacts, RunStatus } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { ToolScopeEnforcer, ToolScopePolicy } from "../../src/runtime/tool-scope.js";

/**
 * bash-timeout-grace plan §3.2/§7 T1 (P0b, frozen): invariant I-SEAL —
 * `RunnerDeps.sealSession` runs, synchronously and idempotently, before the
 * FIRST input that moves a run into a terminal RunStatus, for every one of
 * the plan's five call sites (bind failure/timeout share one site; the
 * abort_grace/extension_bind branches inside `fireDeadline` are the other
 * two "this fire is guaranteed terminal" sites; the normal/catch
 * `prompt_settled` dispatches and the `run()` finally fallback round out the
 * five). `RunnerDeps.onReaped`'s three call sites (normal reap + two
 * late-arrival paths) must carry the observed sessionId.
 *
 * Proof technique: `onStateChange` records `{status, exitFacts}` on every
 * accepted dispatch. Because sealBeforeTerminal dispatches the `exit_facts`
 * session_event as a SEPARATE, strictly-earlier input than the
 * terminal-causing one (both funnelled through the same synchronous
 * `dispatch` closure), the very first recorded entry whose status is
 * terminal already carries `exitFacts === facts` iff the seal ran first.
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

function makeFacts(tag: string): RunExitFacts {
  return {
    bashJobs: [
      {
        jobId: `j_${tag}`,
        commandPreview: "sleep 5",
        state: "terminating",
        exitCode: null,
        logPath: `/tmp/${tag}.log`,
        durationMs: 1_000,
        seen: false,
      },
    ],
  };
}

interface StateLogEntry {
  status: RunStatus;
  exitFacts?: RunExitFacts;
}
interface ReapedEntry {
  runId: string;
  forkSessionFrom?: string;
  sessionId?: string;
}

function harness(
  driver: SessionDriver,
  opts: { seal?: (runId: string, sessionId: string) => RunExitFacts | undefined } = {},
) {
  const clock = new FakeClock();
  const stateLog: StateLogEntry[] = [];
  const reaped: ReapedEntry[] = [];
  const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
    onStateChange: (_runId, state) => {
      stateLog.push({ status: state.status, exitFacts: state.diag.exitFacts });
    },
    ...(opts.seal ? { sealSession: opts.seal } : {}),
    onReaped: (runId, forkSessionFrom, sessionId) => {
      reaped.push({ runId, forkSessionFrom, sessionId });
    },
  };
  return { clock, runner: new RuntimeRunner(d), stateLog, reaped };
}

/** First entry in the state log whose status is terminal (or undefined if the walk never reached one). */
function firstTerminal(stateLog: StateLogEntry[]): StateLogEntry | undefined {
  return stateLog.find((e) => isTerminalStatus(e.status));
}

const pump = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("I-SEAL: sealSession runs before the first terminal input (bash-timeout-grace plan §3.2 T1)", () => {
  it("normal completion", async () => {
    const facts = makeFacts("normal");
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return facts;
    };
    const h = harness(
      { create: async () => handle({ sessionId: "s-normal" }), bind: async () => undefined, onLateArrival() {} },
      { seal },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-normal" }, budget);
    expect(outcome.status).toBe("completed");
    expect(calls).toEqual([{ runId: "r-normal", sessionId: "s-normal" }]);
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
    expect(outcome.diag.exitFacts).toEqual(facts);
  });

  it("user cancel (abortRun)", async () => {
    const facts = makeFacts("cancel");
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-cancel", prompt: () => never() }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      { seal: () => facts },
    );
    const p = h.runner.run({ ...request, runId: "r-cancel" }, budget);
    await pump();
    await h.runner.abortRun("r-cancel", "user_stop");
    const outcome = await p;
    expect(outcome.status).toBe("aborted");
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("total timeout (no grace): the total deadline_fired enters abort_grace, cancel resolves the prompt guard, settles via prompt_settled", async () => {
    const facts = makeFacts("total-timeout");
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-total", prompt: () => never() }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      { seal: () => facts },
    );
    const p = h.runner.run({ ...request, runId: "r-total" }, budget);
    await pump();
    h.clock.advance(budget.totalMs + 1);
    await pump();
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("bind rejecting (bind failure)", async () => {
    const facts = makeFacts("bind-fail");
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return facts;
    };
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-bindfail" }),
        bind: () => Promise.reject(new Error("bind exploded")),
        onLateArrival() {},
      },
      { seal },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-bindfail" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("bind exploded");
    expect(calls).toEqual([{ runId: "r-bindfail", sessionId: "s-bindfail" }]);
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("bind timing out via the guard's own internal timer", async () => {
    const facts = makeFacts("bind-timeout");
    const h = harness(
      { create: async () => handle({ sessionId: "s-bindto" }), bind: () => never(), onLateArrival() {} },
      { seal: () => facts },
    );
    const p = h.runner.run({ ...request, runId: "r-bindto" }, budget);
    await pump();
    h.clock.advance(budget.bindMs + 1);
    await pump();
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("extension_bind");
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("fireDeadline while phase=extension_bind is directly terminal in the reducer, and seals first", async () => {
    const facts = makeFacts("fd-extbind");
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return facts;
    };
    const h = harness(
      { create: async () => handle({ sessionId: "s-fdbind" }), bind: () => never(), onLateArrival() {} },
      { seal },
    );
    const p = h.runner.run({ ...request, runId: "r-fdbind" }, budget);
    await pump();
    const state = h.runner.getRunState("r-fdbind");
    expect(state?.phase).toBe("extension_bind");
    expect(state?.armedTimers).toContain("bind");
    h.runner.fireDeadline("r-fdbind", state!.generation, {
      kind: "deadline_fired",
      at: h.clock.now(),
      timer: "bind",
      reason: "extension_bind",
    });
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(calls).toHaveLength(1); // exactly once, even though the guard's own rejection ALSO reaches the (now no-op) startup_failed dispatch
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("fireDeadline while phase=abort_grace (a run stuck past its abort grace window) is directly terminal, and seals first", async () => {
    const facts = makeFacts("fd-abortgrace");
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return facts;
    };
    const h = harness(
      {
        create: async () => handle({ sessionId: "s-fdgrace", prompt: () => never() }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      { seal },
    );
    const p = h.runner.run({ ...request, runId: "r-fdgrace" }, budget);
    await pump();
    const gen = h.runner.getRunState("r-fdgrace")!.generation;
    // Bypass the CancelHandle entirely (dispatchExternal), simulating a run
    // that entered abort_grace through some other path and is genuinely
    // stuck there (a real cancel() would resolve the prompt guard almost
    // instantly — see the plan's own reasoning for why this second-timeout
    // branch needs to be exercised synthetically).
    h.runner.dispatchExternal("r-fdgrace", gen, { kind: "stop_requested", at: h.clock.now(), cause: "user_stop" });
    const stuck = h.runner.getRunState("r-fdgrace");
    expect(stuck?.phase).toBe("abort_grace");
    expect(stuck?.status).toBe("stopping");
    expect(stuck?.armedTimers).toContain("abort_grace");
    h.runner.fireDeadline("r-fdgrace", gen, {
      kind: "deadline_fired",
      at: h.clock.now(),
      timer: "abort_grace",
      reason: "idle",
    });
    const outcome = await p;
    expect(isTerminalStatus(outcome.status)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("catch path: a synchronous throw after the handle is bound (onBind) still seals first", async () => {
    const facts = makeFacts("catch");
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return facts;
    };
    const throwingEnforcer: ToolScopeEnforcer = {
      onBind: () => {
        throw new Error("onBind exploded");
      },
      onTurnBoundary: () => ({ applied: [], blockedNewcomers: [], changed: false }),
    };
    const policy: ToolScopePolicy = { deny: new Set() };
    const h = harness(
      { create: async () => handle({ sessionId: "s-catch" }), bind: async () => undefined, onLateArrival() {} },
      { seal },
    );
    const outcome = await h.runner.run(
      { ...request, runId: "r-catch", toolScope: { policy, enforcer: throwingEnforcer } },
      budget,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("onBind exploded");
    expect(calls).toEqual([{ runId: "r-catch", sessionId: "s-catch" }]);
    expect(firstTerminal(h.stateLog)?.exitFacts).toEqual(facts);
  });

  it("no handle bound yet (session_create failure) ⇒ sealSession is never called", async () => {
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return makeFacts("never");
    };
    const h = harness(
      { create: () => Promise.reject(new Error("create exploded")), bind: async () => undefined, onLateArrival() {} },
      { seal },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-nohandle" }, budget);
    expect(outcome.status).toBe("failed");
    expect(calls).toEqual([]);
    expect(firstTerminal(h.stateLog)?.exitFacts).toBeUndefined();
  });

  it("no handle bound yet (queue timeout, never even attempts create) ⇒ sealSession is never called", async () => {
    const calls: Array<{ runId: string; sessionId: string }> = [];
    const seal = (runId: string, sessionId: string) => {
      calls.push({ runId, sessionId });
      return makeFacts("never");
    };
    const clock = new FakeClock();
    const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
    const pool = new SingleSlotPool(clock, 1);
    const d: RunnerDeps = {
      clock,
      driver: {
        create: async () => handle({ prompt: () => never() }),
        bind: async () => undefined,
        onLateArrival() {},
      },
      pool,
      store,
      watchdog: { arm() {}, disarm() {}, tick() {} },
      reaper: new EscalatingReaper(clock),
      effects: new BasicEffectInterpreter(),
      emit() {},
      deliver() {},
      sealSession: seal,
    };
    const runner = new RuntimeRunner(d);
    const a = runner.run({ ...request, runId: "r-slot-a" }, { ...budget, queueWaitMs: 1_000 }); // occupies the only slot
    const b = runner.run({ ...request, runId: "r-slot-b" }, budget); // queue_wait, small queueWaitMs
    await pump();
    clock.advance(budget.queueWaitMs + 1); // b's queueWaitMs expires while still queued (never reached session_create at all)
    await pump();
    const outcomeB = await b;
    expect(outcomeB.status).toBe("failed");
    expect(calls).toEqual([]);
    // cleanup
    await runner.abortRun("r-slot-a", "user_stop");
    await a;
  });

  it("sealSession returning undefined: no exit_facts is dispatched, the run still settles normally", async () => {
    const h = harness(
      { create: async () => handle({ sessionId: "s-undef" }), bind: async () => undefined, onLateArrival() {} },
      { seal: () => undefined },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-undef" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.exitFacts).toBeUndefined();
    expect(h.stateLog.some((e) => e.exitFacts !== undefined)).toBe(false);
  });

  it("no sealSession wired at all: the runner does not crash and settles normally (feature entirely absent)", async () => {
    const h = harness({ create: async () => handle(), bind: async () => undefined, onLateArrival() {} });
    const outcome = await h.runner.run({ ...request, runId: "r-nowire" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.exitFacts).toBeUndefined();
  });

  it("a throwing sealSession is swallowed; the run still settles, without exit_facts", async () => {
    const h = harness(
      { create: async () => handle({ sessionId: "s-throws" }), bind: async () => undefined, onLateArrival() {} },
      {
        seal: () => {
          throw new Error("sealSession exploded");
        },
      },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-throws" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.exitFacts).toBeUndefined();
  });

  it("idempotent: repeated calls (finally fallback after an earlier call site already sealed) never call sealSession twice or dispatch exit_facts twice", async () => {
    const facts = makeFacts("idempotent");
    let calls = 0;
    const h = harness(
      { create: async () => handle({ sessionId: "s-idem" }), bind: async () => undefined, onLateArrival() {} },
      {
        seal: () => {
          calls++;
          return facts;
        },
      },
    );
    const outcome = await h.runner.run({ ...request, runId: "r-idem" }, budget);
    expect(outcome.status).toBe("completed");
    expect(calls).toBe(1);
    const exitFactsSightings = h.stateLog.filter((e) => e.exitFacts !== undefined);
    expect(exitFactsSightings.length).toBeGreaterThan(0);
  });
});

describe("onReaped carries the observed sessionId at all three call sites (bash-timeout-grace plan §3.2)", () => {
  it("normal reap path: sessionId is the bound handle's sessionId", async () => {
    const h = harness({
      create: async () => handle({ sessionId: "s-reap-normal" }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run({ ...request, runId: "r-reap-normal" }, budget);
    expect(outcome.status).toBe("completed");
    await pump();
    expect(h.reaped).toEqual([{ runId: "r-reap-normal", forkSessionFrom: undefined, sessionId: "s-reap-normal" }]);
  });

  it("no handle at all (session_create rejects before any handle exists): sessionId is undefined", async () => {
    const h = harness({
      create: () => Promise.reject(new Error("boom")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run({ ...request, runId: "r-reap-nohandle" }, budget);
    expect(outcome.status).toBe("failed");
    await pump();
    expect(h.reaped).toEqual([{ runId: "r-reap-nohandle", forkSessionFrom: undefined, sessionId: undefined }]);
  });

  it("late-arrival after a create timeout (site: the create-guard-failure branch's own onLateArrival): sessionId is the late handle's sessionId", async () => {
    let lateResolve: (h: SessionHandle) => void = () => undefined;
    const lateP = new Promise<SessionHandle>((r) => {
      lateResolve = r;
    });
    const h = harness({
      create: () => lateP,
      bind: async () => undefined,
      onLateArrival(p, cb) {
        p.then(cb, () => undefined);
      },
    });
    const p = h.runner.run({ ...request, runId: "r-reap-late1" }, budget);
    await pump();
    h.clock.advance(budget.startupMs + 1); // create guard times out first
    const outcome = await p;
    await pump();
    expect(outcome.status).toBe("timed_out");
    expect(h.reaped).toEqual([{ runId: "r-reap-late1", forkSessionFrom: undefined, sessionId: undefined }]);
    lateResolve(handle({ sessionId: "s-reap-late1" }));
    await pump();
    expect(h.reaped).toHaveLength(2);
    expect(h.reaped[1]).toEqual({ runId: "r-reap-late1", forkSessionFrom: undefined, sessionId: "s-reap-late1" });
  });

  it("an aborted run past a successful create still reports the bound handle's sessionId through the normal reap path", async () => {
    const h = harness({
      create: async () => handle({ sessionId: "s-reap-abort", prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = h.runner.run({ ...request, runId: "r-reap-abort" }, budget);
    await pump();
    await h.runner.abortRun("r-reap-abort", "user_stop");
    const outcome = await p;
    await pump();
    expect(outcome.status).toBe("aborted");
    expect(h.reaped).toEqual([{ runId: "r-reap-abort", forkSessionFrom: undefined, sessionId: "s-reap-abort" }]);
  });
});

/** Records disposeLate calls on top of the real reaper (noLateArrival-path assertions need to see it). */
class RecordingReaper extends EscalatingReaper {
  readonly lateDisposals: string[] = [];
  override disposeLate(runId: string, generation: number, h: SessionHandle): void {
    this.lateDisposals.push(`${runId}:${generation}:${h.sessionId}`);
    super.disposeLate(runId, generation, h);
  }
}

describe("run() finally late-arrival fallback (the `if (createP)` branch; bash-timeout-grace plan §3.2 review follow-up)", () => {
  // Reaching that branch requires an exception between `createP = …` and its
  // two clearing points; the only injectable seam is the guard-failure
  // branch's own `driver.onLateArrival` call throwing (then the catch path
  // runs with createP still set). No handle is ever bound on this path, so
  // sealing is observable as: the terminal prompt_settled dispatch happens
  // BEFORE the finally's late-arrival registration (whose first line is
  // sealBeforeTerminal — a no-op here only because no handle was ever bound,
  // which is exactly why sealSession must stay untouched), and the late
  // session's defensive seal travels through onReaped(sessionId) — §3.2's
  // table row for the late-arrival paths.
  const lateHarness = (
    order: string[],
    create: () => Promise<SessionHandle>,
    onLateArrival: SessionDriver["onLateArrival"],
  ) => {
    const clock = new FakeClock();
    const reaper = new RecordingReaper(clock);
    const sealCalls: string[] = [];
    const reaped: ReapedEntry[] = [];
    const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
    const d: RunnerDeps = {
      clock,
      driver: { create, bind: async () => undefined, onLateArrival },
      pool: new SingleSlotPool(clock, 2),
      store,
      watchdog: { arm() {}, disarm() {}, tick() {} },
      reaper,
      effects: new BasicEffectInterpreter(),
      emit() {},
      deliver() {},
      onStateChange: (_runId, state) => {
        if (isTerminalStatus(state.status)) order.push("terminal-dispatch");
      },
      sealSession: (runId, sessionId) => {
        sealCalls.push(`${runId}:${sessionId}`);
        return makeFacts("late");
      },
      onReaped: (runId, forkSessionFrom, sessionId) => {
        order.push(`onReaped(${sessionId ?? "undefined"})`);
        reaped.push({ runId, forkSessionFrom, sessionId });
      },
    };
    return { clock, runner: new RuntimeRunner(d), reaper, sealCalls, reaped };
  };

  it("a throwing first onLateArrival (guard-failure branch) leaves createP set: the finally still seals first, registers the late handler, reaps, and settles without any unhandled rejection", async () => {
    let lateResolve: (h: SessionHandle) => void = () => undefined;
    const createP = new Promise<SessionHandle>((r) => {
      lateResolve = r;
    });
    const order: string[] = [];
    let calls = 0;
    const h = lateHarness(
      order,
      () => createP,
      (p, cb) => {
        calls++;
        if (calls === 1) {
          order.push("late-throw");
          throw new Error("first onLateArrival exploded"); // makes the !created.ok branch throw ⇒ catch ⇒ finally with createP still set
        }
        order.push("late-register");
        p.then(cb, () => undefined);
      },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const p = h.runner.run({ ...request, runId: "r-finally-late" }, budget);
      await pump();
      h.clock.advance(budget.startupMs + 1); // create guard times out ⇒ guard-failure branch ⇒ throwing onLateArrival ⇒ catch
      const outcome = await p;
      await pump(); // let the fire-and-forget runReap() → notifyReaped(undefined) chain settle
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.message).toBe("first onLateArrival exploded");
      // Sealing order: the terminal dispatch strictly precedes the finally's
      // late-arrival registration; sealSession stays untouched (no handle was
      // ever bound on this path — the no-handle test above pins that). The
      // possible extra "terminal-dispatch" entries after "late-register" are
      // the reaper's own absorbed `cancel.cancel("reap")` re-observing the
      // already-terminal state through onStateChange — not a second
      // transition (the reducer no-ops a stop_requested on a terminal run).
      expect(order.slice(0, 3)).toEqual(["late-throw", "terminal-dispatch", "late-register"]);
      expect(order.at(-1)).toBe("onReaped(undefined)");
      expect(order.indexOf("terminal-dispatch")).toBeLessThan(order.indexOf("late-register"));
      expect(h.sealCalls).toEqual([]);
      // Normal reap happened despite the throw (sessionId undefined — no handle).
      expect(h.reaped).toEqual([{ runId: "r-finally-late", forkSessionFrom: undefined, sessionId: undefined }]);
      // The late session still gets its defensive seal path: disposeLate +
      // onReaped with the late handle's sessionId.
      lateResolve(handle({ sessionId: "s-finally-late" }));
      await pump(5);
      expect(h.reaper.lateDisposals).toEqual(["r-finally-late:1:s-finally-late"]);
      expect(h.reaped).toHaveLength(2);
      expect(h.reaped[1]).toEqual({ runId: "r-finally-late", forkSessionFrom: undefined, sessionId: "s-finally-late" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a driver whose onLateArrival ALWAYS throws cannot break out of the finally: run() still resolves, the reap pipeline and map cleanup still run", async () => {
    const order: string[] = [];
    const h = lateHarness(
      order,
      () => new Promise<SessionHandle>(() => undefined),
      () => {
        order.push("late-throw");
        throw new Error("onLateArrival always explodes");
      },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const p = h.runner.run({ ...request, runId: "r-finally-throw" }, budget);
      await pump();
      h.clock.advance(budget.startupMs + 1);
      const outcome = await p; // without the try/catch fix this rejects with the driver hook's error instead
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.message).toBe("onLateArrival always explodes");
      await pump();
      expect(h.reaped).toEqual([{ runId: "r-finally-throw", forkSessionFrom: undefined, sessionId: undefined }]);
      // Map cleanup still ran ⇒ the terminal snapshot stays readable (the
      // generation/cancel/handle entries were deleted, not leaked forever).
      expect(h.runner.getRunState("r-finally-throw")?.outcome).toBe(outcome);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
