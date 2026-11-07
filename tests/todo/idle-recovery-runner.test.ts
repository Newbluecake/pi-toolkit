import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  createIdleRecoveryHost,
  RECOVERY_BUSY_SOURCES,
  type RecoveryBusy,
  type RecoveryIdentity,
} from "../../src/todo/idle-recovery-host.js";
import { createIdleRecoveryStore } from "../../src/todo/idle-recovery-store.js";
import {
  createIdleRecoveryRunner,
  IDLE_RECOVERY_CHECK,
  IDLE_RECOVERY_SUPERVISION,
  IDLE_RECOVERY_DEADLINE_MS,
  IDLE_RECOVERY_GRACE_MS,
  type RecoveryCheckMessage,
  type IdleRecoveryRunnerDeps,
} from "../../src/todo/idle-recovery-runner.js";
import type { TodoState } from "../../src/todo/state.js";

function fixture(options: { enabled?: boolean; subscription?: boolean; realImmediate?: boolean } = {}) {
  const clock = new FakeClock(1_000);
  const entries: unknown[] = [];
  let onAppend: ((type: string, data: unknown) => void) | undefined;
  let fail = "";
  const append = (customType: string, data: unknown) => {
    if (customType === fail) throw Error("append failure");
    entries.push({ type: "custom", customType, data });
    onAppend?.(customType, data);
  };
  const store = createIdleRecoveryStore({
    sessionId: "s",
    owner: "root",
    getEntries: () => entries,
    appendCustomEntry: append,
    now: () => clock.now(),
    createAttemptId: () => `a${store.view().totalAttempts + 1}`,
  });
  const todo: TodoState = {
    nextId: 2,
    tasks: [
      {
        id: 1,
        subject: "authorized work",
        description: "continue original scope",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  let identity: RecoveryIdentity | undefined = { sid: "s", owner: "root" };
  const sdk = { mode: "tui", idle: true, pending: false };
  const busy = Object.fromEntries(RECOVERY_BUSY_SOURCES.map((name) => [name, () => "clear" as RecoveryBusy]));
  let runner: ReturnType<typeof createIdleRecoveryRunner> | undefined;
  const host = createIdleRecoveryHost({
    sid: "s",
    owner: "root",
    enabled: options.enabled ?? true,
    store,
    currentIdentity: () => identity,
    readSdk: () => sdk,
    readTodo: () => todo,
    busy,
    handover: () => runner?.handover(),
  });
  const sent: RecoveryCheckMessage[] = [];
  let onSend: (() => void) | undefined;
  let listener: ((e: { type: string; aborted?: boolean }) => void) | undefined;
  const unsubscribe = vi.fn();
  const jobs: { callback: () => void; cancelled: boolean }[] = [];
  const abort = vi.fn();
  const deps: IdleRecoveryRunnerDeps = {
    enabled: options.enabled ?? true,
    sid: "s",
    owner: "root",
    store,
    clock,
    appendCustomEntry: append,
    getEntries: () => entries,
    readHostSnapshot: () => host.readHostSnapshot(),
    abort,
    createOwnerToken: () => `token-${store.view().totalAttempts}`,
    sendMessage: (m) => {
      sent.push(m);
      onSend?.();
    },
    ...(options.subscription === false
      ? {}
      : {
          subscribeSession: (cb: typeof listener) => {
            listener = cb;
            return unsubscribe;
          },
        }),
    ...(options.realImmediate
      ? {}
      : {
          immediate: (callback: () => void) => {
            const job = { callback, cancelled: false };
            jobs.push(job);
            return {
              cancel: () => {
                job.cancelled = true;
              },
            };
          },
        }),
  };
  runner = createIdleRecoveryRunner(deps);
  let input = 0;
  const arrival = () =>
    host.onTuiInput(
      { type: "input", source: "interactive", text: `${++input}` },
      { sid: "s", owner: "root", mode: "tui" },
    );
  const emit = (aborted: boolean | undefined = false) =>
    listener?.({ type: "agent_settled", ...(aborted === undefined ? {} : { aborted }) });
  const flush = () => {
    for (const job of jobs.splice(0)) if (!job.cancelled) job.callback();
  };
  const start = () => {
    arrival();
    emit();
    flush();
  };
  const bas = (message = sent.at(-1)) => {
    sdk.idle = false;
    runner!.beforeAgentStart({ messageType: "custom", message });
  };
  return {
    runner,
    deps,
    host,
    store,
    entries,
    todo,
    sdk,
    clock,
    busy,
    abort,
    sent,
    jobs,
    unsubscribe,
    arrival,
    emit,
    flush,
    start,
    bas,
    progress: (key: string) => {
      todo.tasks[0]!.metadata = { idleRecovery: { progressKey: key } };
    },
    setIdentity: (v: typeof identity) => {
      identity = v;
    },
    onAppend: (cb: typeof onAppend) => {
      onAppend = cb;
    },
    onSend: (cb: typeof onSend) => {
      onSend = cb;
    },
    fail: (type: string) => {
      fail = type;
    },
  };
}

describe("recovery runner scheduling/accounting", () => {
  it("off and current Root extension-only topology have no subscription, entries, timer, or immediate", () => {
    const off = fixture({ enabled: false });
    off.start();
    expect(off.runner.effective).toBe(false);
    expect(off.sent).toEqual([]);
    expect(off.entries).toEqual([]);
    expect(off.jobs).toEqual([]);
    expect(off.clock.pendingTimers).toBe(0);
    const root = fixture({ subscription: false });
    root.runner.onSettled({ aborted: false });
    expect(root.runner.offReason).toBe("root-session-subscription-unavailable");
    expect(root.jobs).toEqual([]);
    expect(root.clock.pendingTimers).toBe(0);
  });
  it.each(["throw", "partial"])("%s host snapshot fails closed without scheduling", (kind) => {
    const f = fixture();
    f.arrival();
    const runner = createIdleRecoveryRunner({
      ...f.deps,
      readHostSnapshot: () => {
        if (kind === "throw") throw Error("host unavailable");
        return { ...f.host.readHostSnapshot(), sources: {} } as ReturnType<typeof f.host.readHostSnapshot>;
      },
    });
    f.emit();
    f.flush();
    expect(f.sent).toEqual([]);
    expect(f.store.view().totalAttempts).toBe(0);
    expect(f.clock.pendingTimers).toBe(0);
    runner.dispose();
    f.runner.dispose();
  });
  it("extension onSettled cannot schedule, even in otherwise supported composition", () => {
    const f = fixture();
    f.arrival();
    f.runner.onSettled({ aborted: false });
    f.flush();
    expect(f.sent).toEqual([]);
  });
  it("merges settled into one immediate, write-ahead then claim before one synchronous send", () => {
    const f = fixture();
    f.arrival();
    f.emit();
    f.emit();
    expect(f.jobs).toHaveLength(1);
    f.onSend(() => {
      expect(f.store.view().attemptsInWindow).toBe(1);
      expect(f.entries).toContainEqual(
        expect.objectContaining({
          customType: IDLE_RECOVERY_SUPERVISION,
          data: expect.objectContaining({ phase: "claim" }),
        }),
      );
      expect(f.runner.phase()).toBe("unknown");
      expect(f.clock.pendingTimers).toBe(1);
      f.emit();
    });
    f.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.jobs).toHaveLength(0);
    expect(f.sent[0]).toMatchObject({ customType: IDLE_RECOVERY_CHECK, display: true });
    expect(f.sent[0]?.content).toContain("只处理已授权且当前可推进");
    expect(f.sent[0]?.content).toContain("不得启动 pending/未授权任务");
  });
  it.each(["owner", "sid", "epoch", "stop", "busy", "unknown", "pairs"])(
    "rechecks changed %s before charge/send; no auto-requeue",
    (change) => {
      const f = fixture();
      f.arrival();
      f.emit();
      if (change === "owner") f.setIdentity({ sid: "s", owner: "old" });
      if (change === "sid") f.setIdentity({ sid: "new", owner: "root" });
      if (change === "epoch") f.arrival();
      if (change === "stop") f.store.noteStop("abort-admission");
      if (change === "busy") f.busy.web = () => "busy";
      if (change === "unknown") f.busy.goal = () => "unknown";
      if (change === "pairs") f.progress("new");
      f.flush();
      expect(f.sent).toEqual([]);
      expect(f.store.view().totalAttempts).toBe(0);
      expect(f.jobs).toEqual([]);
    },
  );
  it.each(["append-fail", "append-reentry", "pair-reentry", "owner-reentry", "arrival-reentry", "claim-reentry"])(
    "%s never sends stale work or refunds",
    (kind) => {
      const f = fixture();
      f.arrival();
      if (kind === "append-fail") f.fail("subagent:todo-idle-recovery");
      let once = false;
      f.onAppend((type, data) => {
        if (once) return;
        const phase = data as { kind?: string; phase?: string };
        if (kind === "claim-reentry" ? phase.phase !== "claim" : phase.kind !== "attempt") return;
        once = true;
        if (kind === "append-reentry") f.emit();
        if (kind === "pair-reentry") f.progress("changed");
        if (kind === "owner-reentry") f.setIdentity({ sid: "s", owner: "old" });
        if (kind === "arrival-reentry" || kind === "claim-reentry") f.arrival();
        expect(type).toContain("subagent:todo-idle-recovery");
      });
      f.emit();
      f.flush();
      expect(f.sent).toHaveLength(kind === "append-reentry" ? 1 : 0);
      // B1 append reentry can conservatively fold the still-being-appended attempt twice.
      // Never refund or send it; B2 does not rewrite the frozen B1 accounting seam.
      expect(f.store.view().totalAttempts).toBe(kind === "arrival-reentry" ? 2 : 1);
      expect(f.jobs).toHaveLength(0);
    },
  );
  it("final synchronous guard catches a busy source injected by claim persistence", () => {
    const f = fixture();
    f.arrival();
    f.onAppend((_type, data) => {
      if ((data as { phase?: string }).phase === "claim") f.busy.notifier = () => "busy";
    });
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(0);
    expect(f.store.view().totalAttempts).toBe(1);
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("send throw remains unknown/single-flight, consumes without retry/refund", () => {
    const f = fixture();
    f.onSend(() => {
      throw Error("void transport uncertain");
    });
    f.start();
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.runner.busy()).toBe(true);
    expect(f.store.view().attemptsInWindow).toBe(1);
  });
  it("two attempts per window, same-pair once across new windows, no pending task authorization", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.sdk.idle = true;
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(1);
    f.progress("p1");
    f.emit();
    f.flush();
    f.bas();
    f.sdk.idle = true;
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(2);
    f.progress("p2");
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(2);
    f.arrival();
    f.todo.tasks[0]!.status = "pending";
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(2);
    f.todo.tasks[0]!.status = "in_progress";
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(3);
  });
  it("true aborted settles Stop; missing field skips, new arrival alone clears Stop", () => {
    const f = fixture();
    f.arrival();
    f.runner.onSettled({});
    f.flush();
    expect(f.sent).toEqual([]);
    f.emit(true);
    f.progress("p1");
    f.emit();
    f.flush();
    expect(f.sent).toEqual([]);
    expect(f.store.view().stopped).toBe(true);
    f.arrival();
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(1);
  });
});

describe("current BAS ownership and fixed supervised deadline", () => {
  it("only actual current custom/details bind; normal user history/tail marker never binds or aborts", () => {
    const f = fixture();
    f.start();
    f.runner.beforeAgentStart({ messageType: "user", prompt: "human" });
    expect(f.runner.phase()).toBe("idle");
    f.runner.context();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.store.view().attemptsInWindow).toBe(1);
  });
  it.each(["ownerToken", "attemptId", "sid"])(
    "wrong %s current marker rejected, never bound and never aborts a foreign run",
    (field) => {
      const f = fixture();
      f.start();
      const m = f.sent[0]!;
      f.bas({ ...m, details: { ...m.details, [field]: "wrong" } });
      // #59 B2: a non-own marker is not authorization to abort the run it starts (that run
      // may be another feature's accepted custom run) — only this runner's rights are forfeited.
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.runner.phase()).toBe("idle");
      expect(f.clock.pendingTimers).toBe(0);
    },
  );
  it("fixed 15min from attempt, not BAS; one abort, then 10s grace stuck with no retries", () => {
    const f = fixture();
    f.start();
    f.clock.advance(1234);
    f.bas();
    expect(f.runner.phase()).toBe("bound");
    f.runner.context();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS - 1235);
    expect(f.abort).not.toHaveBeenCalled();
    f.clock.advance(1);
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.runner.phase()).toBe("aborting");
    f.clock.advance(IDLE_RECOVERY_GRACE_MS);
    expect(f.runner.effective).toBe(false);
    expect(f.runner.phase()).toBe("stuck");
    expect(f.entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ phase: "stuck" }) }));
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("synchronous attempt-append time does not extend the fixed deadline", () => {
    const f = fixture();
    f.arrival();
    f.onAppend((_type, data) => {
      if ((data as { kind?: string }).kind === "attempt") f.clock.advance(500);
    });
    f.emit();
    f.flush();
    f.bas();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS - 501);
    expect(f.abort).not.toHaveBeenCalled();
    f.clock.advance(1);
    expect(f.abort).toHaveBeenCalledOnce();
  });
  it("settled during abort callback cancels grace and preserves Stop", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.abort.mockImplementation(() => {
      f.sdk.idle = true;
      f.emit(true);
    });
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.clock.pendingTimers).toBe(0);
    expect(f.store.view().stopped).toBe(true);
    expect(f.runner.phase()).toBe("idle");
  });
  it("unbound expires tombstoned/effective-off, never blindly aborts; late own BAS rejected", () => {
    const f = fixture();
    f.start();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.runner.phase()).toBe("tombstone");
    expect(f.runner.effective).toBe(false);
    expect(f.clock.pendingTimers).toBe(0);
    f.bas();
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(1);
  });
  it("trusted arrival first revokes deadline/abort, even if new-window append fails", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.fail("subagent:todo-idle-recovery");
    f.arrival();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS + IDLE_RECOVERY_GRACE_MS);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("#59 B2: foreign custom BAS forfeits only own rights — no abort, claim invalid, own marker cannot rebind", () => {
    const f = fixture();
    f.start();
    expect(f.runner.phase()).toBe("unknown");
    // another feature's accepted custom run starts (marker-shaped payload must not matter)
    f.runner.beforeAgentStart({
      messageType: "custom",
      message: { customType: "another:feature", details: { v: 1, sid: "s", ownerToken: "not-ours", attemptId: "aX" } },
    });
    expect(f.abort).not.toHaveBeenCalled();
    // this runner's claim/handover/timer/deadline rights are cleared (token invalidated)
    expect(f.runner.phase()).toBe("idle");
    expect(f.clock.pendingTimers).toBe(0);
    expect(f.entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ phase: "handed" }) }));
    // a later own marker cannot bind the revoked claim; only its own stale run may be aborted
    f.bas();
    expect(f.runner.phase()).toBe("idle");
    expect(f.abort).toHaveBeenCalledOnce();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).toHaveBeenCalledOnce();
  });
  it("#59 B2: coexistence — a foreign feature's accepted custom run is never aborted by late/mimicking markers", () => {
    const f = fixture();
    f.start();
    f.runner.beforeAgentStart({ messageType: "custom", message: { customType: "fabric:xs", details: {} } });
    expect(f.abort).not.toHaveBeenCalled();
    const m = f.sent[0]!;
    // check-type BAS with a forged token: rejected without aborting the in-flight foreign run
    f.bas({ ...m, details: { ...m.details, ownerToken: "forged", attemptId: "aX" } });
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.runner.phase()).toBe("idle");
    expect(f.clock.pendingTimers).toBe(0);
    // own late marker still follows the accepted rule: rejected, aborts only its own stale turn
    f.bas();
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.runner.phase()).toBe("idle");
  });
  it("#59 B2: check-type BAS with no current claim and no issuance never aborts", () => {
    const f = fixture();
    f.arrival();
    f.emit();
    f.runner.beforeAgentStart({
      messageType: "custom",
      message: {
        customType: IDLE_RECOVERY_CHECK,
        details: { v: 1, sid: "s", ownerToken: "forged", attemptId: "a1" },
      },
    });
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.runner.phase()).toBe("idle");
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("external BAS revokes abort but does not reset quota; context never trusts a history marker", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.runner.beforeAgentStart({
      messageType: "custom",
      message: { customType: "notification", details: f.sent[0]!.details },
    });
    f.runner.context();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.store.view().attemptsInWindow).toBe(1);
  });
  it("changed owner/deadline context aborts only currently BAS-bound run", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.busy.goal = () => "unknown";
    f.runner.context();
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.runner.effective).toBe(false);
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("lost owner at context revokes rights without aborting a possible successor/user run", () => {
    const f = fixture();
    f.start();
    f.bas();
    f.setIdentity({ sid: "s", owner: "successor" });
    f.runner.context();
    f.clock.advance(IDLE_RECOVERY_DEADLINE_MS);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.runner.effective).toBe(false);
    expect(f.clock.pendingTimers).toBe(0);
  });
  it("supervision append failure denies send and old supervision never replays rights", () => {
    const f = fixture();
    f.arrival();
    f.fail(IDLE_RECOVERY_SUPERVISION);
    f.emit();
    f.flush();
    expect(f.sent).toHaveLength(0);
    expect(f.store.view().totalAttempts).toBe(1);
    expect(f.runner.effective).toBe(false);
    const old = fixture();
    old.start();
    const fresh = createIdleRecoveryRunner(old.deps);
    expect(fresh.effective).toBe(false);
    expect(fresh.offReason).toBe("old-supervision-unresolved");
    expect(old.sent).toHaveLength(1);
  });
  it.each(["scheduled", "unknown", "bound", "handed"])(
    "synchronous dispose %s cancels all work and only proven bound aborts",
    (phase) => {
      const f = fixture();
      f.arrival();
      f.emit();
      if (phase !== "scheduled") f.flush();
      if (phase === "bound" || phase === "handed") f.bas();
      if (phase === "handed") f.arrival();
      f.runner.dispose();
      f.runner.dispose();
      f.flush();
      f.clock.advance(IDLE_RECOVERY_DEADLINE_MS * 2);
      expect(f.abort).toHaveBeenCalledTimes(phase === "bound" ? 1 : 0);
      expect(f.clock.pendingTimers).toBe(0);
      expect(f.runner.phase()).toBe("disposed");
      expect(f.unsubscribe).toHaveBeenCalledOnce();
      expect(f.sent).toHaveLength(phase === "scheduled" ? 0 : 1);
    },
  );
  it("the sole real immediate is unrefed and cancelable, with no polling", () => {
    const handle = { unref: vi.fn() };
    const set = vi.spyOn(globalThis, "setImmediate").mockReturnValue(handle as unknown as NodeJS.Immediate);
    const clear = vi.spyOn(globalThis, "clearImmediate").mockImplementation(() => {});
    try {
      const f = fixture({ realImmediate: true });
      f.arrival();
      f.emit();
      f.emit();
      expect(set).toHaveBeenCalledOnce();
      expect(handle.unref).toHaveBeenCalledOnce();
      f.runner.dispose();
      expect(clear).toHaveBeenCalledWith(handle);
      expect(f.clock.pendingTimers).toBe(0);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
});
