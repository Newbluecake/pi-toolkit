import { describe, expect, it, vi } from "vitest";
import { FakeClock, MAX_TIMER_DELAY_MS } from "../../../src/core/clock.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import {
  createIncrementalScheduler,
  type IncrementalBatch,
  type IncrementalAttemptContext,
  type IncrementalCorpus,
  type IncrementalDirectory,
} from "../../../src/memory/govern/incremental.js";
import type { MemoryActivitySnapshot } from "../../../src/memory/govern/activity.js";
import { isExternalWriteOrigin } from "../../../src/memory/govern/write-origin.js";

const directory: IncrementalDirectory = { realpath: "/memory/project", dev: 1, ino: 2, sessionEpoch: 1 };
const corpus = (rev = "r1"): IncrementalCorpus => ({
  fingerprint: rev,
  candidates: [{ id: "rule.001", rev, topic: "rule", authority: "user" }],
  omittedCount: 0,
});
const drain = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
function setup(
  options: {
    subscribe?: boolean;
    owner?: boolean;
    enabled?: boolean;
    deferred?: boolean;
    canAttempt?: boolean;
    admission?: ((batch: IncrementalBatch) => boolean) | "missing";
    idleMs?: number;
    cooldownMs?: number;
    taskDoneTrigger?: boolean;
  } = {},
) {
  const clock = new FakeClock();
  const snapshot: { -readonly [K in keyof MemoryActivitySnapshot]: MemoryActivitySnapshot[K] } = {
    generation: 0,
    lastActivityAt: 0,
    running: false,
    toolsInFlight: 0,
    liveIdle: true,
    hasPendingMessages: false,
  };
  const listeners = new Set<() => void>();
  const port = {
    snapshot: vi.fn(() => ({ ...snapshot })),
    ...(options.subscribe === false
      ? {}
      : {
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        }),
  };
  let latest = corpus();
  let owner = options.owner === false ? undefined : port;
  let valid = true;
  let resolve!: (r: { kind: "settled" | "cap-reached" }) => void;
  const batches: IncrementalBatch[] = [],
    contexts: IncrementalAttemptContext[] = [];
  const handler = vi.fn((batch: IncrementalBatch, context: IncrementalAttemptContext) => {
    batches.push(batch);
    contexts.push(context);
    return options.deferred
      ? new Promise<{ kind: "settled" | "cap-reached" }>((r) => {
          resolve = r;
        })
      : { kind: "settled" as const };
  });
  const diagnostic = vi.fn();
  // Passing behavior tests explicitly model an available client budget. Omission
  // is tested separately: it must never inherit an implicit production allow.
  const admission =
    options.admission === "missing" ? undefined : vi.fn(options.admission ?? (() => options.canAttempt !== false));
  const scheduler = createIncrementalScheduler({
    settings: {
      ...DEFAULT_MEMORY_SETTINGS.incremental,
      enabled: options.enabled !== false,
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
      ...(options.taskDoneTrigger === undefined ? {} : { taskDoneTrigger: options.taskDoneTrigger }),
    },
    clock,
    activity: () => owner,
    isCurrent: () => valid,
    readCorpus: () => latest,
    handler,
    diagnostic,
    ...(admission ? { canAttempt: admission } : {}),
  });
  const activity = (patch: Partial<MemoryActivitySnapshot>) => {
    Object.assign(snapshot, patch);
    for (const listener of listeners) listener();
  };
  const write = (rev = "r1", origin?: string, d = directory) => {
    latest = corpus(rev);
    scheduler.externalWrite(d, latest, origin);
  };
  return {
    clock,
    snapshot,
    port,
    scheduler,
    handler,
    batches,
    contexts,
    diagnostic,
    admission,
    activity,
    write,
    latest: (value: IncrementalCorpus) => {
      latest = value;
    },
    ownerOff: () => {
      owner = undefined;
    },
    invalidate: () => {
      valid = false;
    },
    resolve: (kind: "settled" | "cap-reached" = "settled") => resolve({ kind }),
    state: () => scheduler.inspect(directory),
    writes: (n = 5) => {
      for (let i = 0; i < n; i++) write();
    },
  };
}

describe("P50.1 incremental aggregation", () => {
  it.each([false, true])("count=3, task-done=%s: only substitutes the count gate", async (taskDone) => {
    const h = setup();
    h.writes(3);
    if (taskDone) h.scheduler.taskDone(directory);
    h.clock.advance(14_999);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.state()?.quietSatisfied).toBe(false);
    h.clock.advance(1);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(taskDone ? 1 : 0);
    expect(h.state()?.state).toBe(taskDone ? "cooldown" : "quiet-wait");
    if (!taskDone) {
      expect(h.state()?.quietSatisfied).toBe(true);
      expect(h.clock.pendingTimers).toBe(0);
    }
  });
  it("quiet first, then task-done gains eligibility but cannot bypass live idle", async () => {
    const h = setup();
    h.writes(3);
    h.activity({ liveIdle: false });
    h.clock.advance(15_000);
    h.scheduler.taskDone(directory);
    h.clock.advance(0);
    await drain();
    expect(h.state()?.state).toBe("idle-wait");
    expect(h.handler).not.toHaveBeenCalled();
    h.activity({ liveIdle: true, lastActivityAt: h.clock.now() });
    h.clock.advance(1999);
    expect(h.handler).not.toHaveBeenCalled();
    h.clock.advance(1);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });
  it("replays §2.4 exactly, and never includes an old A revision", async () => {
    const h = setup();
    h.write("A1");
    h.clock.advance(8000);
    h.write("B1");
    h.clock.advance(6000);
    h.scheduler.taskDone(directory);
    h.clock.advance(2000);
    h.write("A2");
    h.clock.advance(13_000);
    h.activity({ toolsInFlight: 1, lastActivityAt: 29_000 });
    h.clock.advance(2000);
    await drain();
    expect(h.state()).toMatchObject({ state: "idle-wait", pendingCount: 3, taskDoneEligible: true });
    expect(h.handler).not.toHaveBeenCalled();
    h.activity({ toolsInFlight: 0, lastActivityAt: 31_000 });
    h.clock.advance(1999);
    expect(h.handler).not.toHaveBeenCalled();
    h.clock.advance(1);
    await drain();
    expect(h.batches.map((b) => [b.changeCount, b.corpus.fingerprint, b.corpus.candidates[0]?.rev])).toEqual([
      [3, "A2", "A2"],
    ]);
    expect(h.clock.now()).toBe(33_000);
  });
  it("every new edit clears quiet satisfaction and resets the full quiet window", async () => {
    const h = setup();
    h.writes(3);
    h.clock.advance(15_000);
    expect(h.state()?.quietSatisfied).toBe(true);
    h.write("new");
    expect(h.state()?.quietSatisfied).toBe(false);
    h.scheduler.taskDone(directory);
    h.clock.advance(14_999);
    expect(h.handler).not.toHaveBeenCalled();
    h.clock.advance(1);
    await drain();
    expect(h.batches[0]?.corpus.fingerprint).toBe("new");
  });
  it.each(["cooldown", "quiet-wait", "idle-wait"] as const)(
    "cooldown-elapsed really releases from %s",
    async (path) => {
      const h = setup({ deferred: true });
      h.writes();
      h.clock.advance(15_000);
      await drain();
      h.resolve();
      await drain();
      expect(h.state()?.cooldownUntil).toBe(315_000);
      if (path === "cooldown") {
        // A running write is one trailing batch, retained in cooldown after settlement.
        h.clock.advance(300_000);
        expect(h.state()?.state).toBe("idle");
        h.writes();
        h.clock.advance(15_000);
      } else {
        h.clock.advance(path === "quiet-wait" ? 299_000 : 1000);
        h.writes();
        if (path === "idle-wait") {
          h.clock.advance(15_000);
          expect(h.state()?.state).toBe("idle-wait");
          expect(h.handler).toHaveBeenCalledTimes(1);
          h.clock.advance(284_000);
        } else {
          h.clock.advance(1000);
          expect(h.state()?.state).toBe("quiet-wait");
          h.clock.advance(14_000);
        }
      }
      await drain();
      expect(h.handler).toHaveBeenCalledTimes(2);
    },
  );
  it("running writes merge exactly one trailing batch and never mutate the current snapshot", async () => {
    const h = setup({ deferred: true });
    h.writes();
    h.clock.advance(15_000);
    await drain();
    h.write("r2");
    h.write("r3");
    h.scheduler.taskDone(directory);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.batches[0]?.corpus.fingerprint).toBe("r1");
    expect(h.state()?.pendingCount).toBe(2);
    h.resolve();
    await drain();
    expect(h.state()?.state).toBe("cooldown");
    h.scheduler.taskDone(directory);
    h.clock.advance(299_999);
    expect(h.handler).toHaveBeenCalledTimes(1);
    h.clock.advance(1);
    await drain();
    expect(h.batches[1]).toMatchObject({ changeCount: 2, corpus: { fingerprint: "r3" } });
  });
  it.each(["sweep", "revision", "p50-auto"])(
    "suppresses internal origin %s without resetting quiet",
    async (origin) => {
      const h = setup();
      h.writes();
      h.clock.advance(8000);
      h.write("r1", origin);
      expect(h.state()?.pendingCount).toBe(5);
      h.clock.advance(7000);
      await drain();
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(isExternalWriteOrigin(origin)).toBe(false);
    },
  );
  it.each([undefined, "external", "unexpected"])("undefined/unknown origins are external (%s)", async (origin) => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.write("r1", origin);
    h.clock.advance(15_000);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(isExternalWriteOrigin(origin)).toBe(true);
  });
  it.each(["off", "no-owner"])("%s means zero timer and zero batch/client opportunity", async (mode) => {
    const h = setup({ enabled: mode !== "off", owner: mode !== "no-owner" });
    h.writes();
    h.scheduler.taskDone(directory);
    h.scheduler.activityChanged();
    h.clock.advance(1_000_000);
    await drain();
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.port.snapshot).not.toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledTimes(mode === "no-owner" ? 1 : 0);
  });
  it.each([
    { running: true },
    { toolsInFlight: 1 },
    { liveIdle: false },
    { liveIdle: undefined },
    { hasPendingMessages: true },
    { hasPendingMessages: undefined },
    { toolsInFlight: NaN },
  ])("live activity denies %j", async (patch) => {
    const h = setup();
    h.writes();
    h.activity(patch);
    h.clock.advance(1_000_000);
    await drain();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
    h.activity({
      running: false,
      toolsInFlight: 0,
      liveIdle: true,
      hasPendingMessages: false,
      lastActivityAt: h.clock.now(),
    });
    h.clock.advance(2000);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });
  it("timer re-reads live ctx, not the idle value from the last activity event", async () => {
    const h = setup();
    h.writes();
    h.snapshot.hasPendingMessages = true;
    h.clock.advance(15_000);
    await drain();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.port.snapshot.mock.calls.length).toBeGreaterThan(1);
  });
  it("new input revokes a lease, including same-millisecond activity", async () => {
    const h = setup({ deferred: true });
    h.writes();
    h.clock.advance(15_000);
    await drain();
    expect(h.contexts[0]?.leaseValid()).toBe(true);
    h.activity({ generation: 1, lastActivityAt: h.clock.now(), running: true });
    expect(h.contexts[0]?.leaseValid()).toBe(false);
    expect(h.contexts[0]?.tryStartGenerate()).toBe(false);
  });
  it("without subscribe, a natural activityChanged wake is required after busy quiet expiry", async () => {
    const h = setup({ subscribe: false });
    h.writes();
    h.snapshot.toolsInFlight = 1;
    h.clock.advance(15_000);
    expect(h.clock.pendingTimers).toBe(0);
    h.activity({ toolsInFlight: 0, lastActivityAt: h.clock.now() });
    h.clock.advance(2000);
    await drain();
    expect(h.handler).not.toHaveBeenCalled();
    h.scheduler.activityChanged();
    h.clock.advance(0);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });
  it.each(["abort", "shutdown", "reload"] as const)(
    "%s cancels waiting and ignores late running results",
    async (reason) => {
      const waiting = setup();
      waiting.writes();
      waiting.scheduler.stop(reason);
      waiting.clock.advance(100_000);
      expect(waiting.state()?.state).toBe("stopped");
      expect(waiting.handler).not.toHaveBeenCalled();
      expect(waiting.clock.pendingTimers).toBe(0);
      const h = setup({ deferred: true });
      h.writes();
      h.clock.advance(15_000);
      await drain();
      h.scheduler.stop(reason);
      expect(h.contexts[0]?.signal.aborted).toBe(true);
      expect(h.contexts[0]?.isCurrent()).toBe(false);
      h.resolve();
      await drain();
      expect(h.state()?.state).toBe("stopped");
      expect(h.clock.pendingTimers).toBe(0);
      expect(h.diagnostic).toHaveBeenCalledTimes(1);
      expect(h.diagnostic).toHaveBeenCalledWith("p50: late batch result ignored");
    },
  );
  it("cap-reached keeps one evidence, cancels further attempts and never retries on a timer", async () => {
    const h = setup({ deferred: true, canAttempt: true });
    h.writes();
    h.clock.advance(15_000);
    await drain();
    const context = h.contexts[0]!;
    expect(context.tryStartGenerate()).toBe(true);
    expect(context.tryStartGenerate()).toBe(true);
    expect(context.tryStartGenerate()).toBe(false);
    expect(context.tryStartGenerate()).toBe(false);
    expect(h.state()).toMatchObject({ state: "quiet-wait", pendingCount: 1, dormant: true });
    h.clock.advance(10_000_000);
    h.scheduler.activityChanged();
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.handler).toHaveBeenCalledTimes(1);
    h.resolve();
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
    h.scheduler.taskDone(directory);
    h.clock.advance(0);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(2);
  });
  function assertBatchDenied(h: ReturnType<typeof setup>): void {
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.batches).toEqual([]);
    expect(h.contexts).toEqual([]);
    expect(h.state()).toMatchObject({ state: "quiet-wait", pendingCount: 1, dormant: true });
    expect(h.state()?.state).not.toBe("running");
    expect(h.state()?.cooldownUntil).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  }
  it("B1 false batch admission keeps evidence dormant before running or handler", async () => {
    const observed: unknown[] = [];
    const h = setup({
      admission: (batch) => {
        observed.push({ state: h.state(), changeCount: batch.changeCount });
        return false;
      },
    });
    h.writes();
    expect(h.state()?.pendingCount).toBe(5);
    h.clock.advance(15_000);
    await drain();
    expect(h.admission).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      {
        state: {
          state: "idle-wait",
          pendingCount: 5,
          taskDoneEligible: false,
          quietSatisfied: true,
          cooldownUntil: 0,
          dormant: false,
        },
        changeCount: 5,
      },
    ]);
    assertBatchDenied(h);
    h.clock.advance(10_000_000);
    h.scheduler.activityChanged(true);
    await drain();
    assertBatchDenied(h);
    expect(h.admission).toHaveBeenCalledTimes(1);
  });
  it("B1 missing batch admission keeps evidence dormant before running or handler", async () => {
    const h = setup({ admission: "missing" });
    expect(h.admission).toBeUndefined();
    h.writes();
    expect(h.state()?.pendingCount).toBe(5);
    h.clock.advance(15_000);
    await drain();
    assertBatchDenied(h);
    h.clock.advance(10_000_000);
    h.scheduler.activityChanged(true);
    await drain();
    assertBatchDenied(h);
  });
  it("B1 throwing batch admission keeps evidence dormant before running or handler", async () => {
    const h = setup({
      admission: () => {
        throw new Error("budget unavailable");
      },
    });
    h.writes();
    expect(h.state()?.pendingCount).toBe(5);
    h.clock.advance(15_000);
    await drain();
    assertBatchDenied(h);
    expect(h.admission).toHaveBeenCalledTimes(1);
    h.clock.advance(10_000_000);
    h.scheduler.activityChanged(true);
    await drain();
    assertBatchDenied(h);
    expect(h.admission).toHaveBeenCalledTimes(1);
  });
  it.each(["queue", "concurrency"] as const)(
    "B1 exhausted %s budget keeps evidence dormant before running or handler",
    async (exhausted) => {
      const available = { queue: exhausted !== "queue", concurrency: exhausted !== "concurrency" };
      const h = setup({ admission: () => available.queue && available.concurrency });
      h.writes();
      expect(h.state()?.pendingCount).toBe(5);
      h.clock.advance(15_000);
      await drain();
      assertBatchDenied(h);
      expect(h.admission).toHaveBeenCalledTimes(1);
      available.queue = true;
      available.concurrency = true;
      h.clock.advance(10_000_000);
      h.scheduler.activityChanged(true);
      await drain();
      assertBatchDenied(h);
      expect(h.admission).toHaveBeenCalledTimes(1);
      // Only a new natural eligible trigger can retry the preserved evidence.
      h.scheduler.taskDone(directory);
      h.clock.advance(0);
      await drain();
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(h.batches[0]).toMatchObject({
        changeCount: 1,
        corpus: { fingerprint: "r1", candidates: corpus().candidates },
      });
      expect(h.admission).toHaveBeenCalledTimes(2);
    },
  );
  it("B1 successful batch admission does not replace fresh attempt admission", async () => {
    let allowed = true;
    const h = setup({ deferred: true, admission: () => allowed });
    h.writes();
    h.clock.advance(15_000);
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.admission).toHaveBeenCalledTimes(1);
    expect(h.state()?.state).toBe("running");
    allowed = false;
    expect(h.contexts[0]?.tryStartGenerate()).toBe(false);
    expect(h.admission).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ state: "quiet-wait", pendingCount: 1, dormant: true });
    expect(h.contexts[0]?.signal.aborted).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
    h.resolve();
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });
  it.each(["epoch", "inode"])("%s change discards the old state and aborts its lease", async (kind) => {
    const h = setup({ deferred: true });
    h.writes();
    h.clock.advance(15_000);
    await drain();
    const next = { ...directory, ...(kind === "epoch" ? { sessionEpoch: 2 } : { ino: 3 }) };
    h.write("r2", undefined, next);
    expect(h.state()).toBeUndefined();
    expect(h.contexts[0]?.signal.aborted).toBe(true);
    expect(h.scheduler.inspect(next)).toMatchObject({ state: "quiet-wait", pendingCount: 1, taskDoneEligible: false });
    h.resolve();
    await drain();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });
  it("directory invalidation or owner disposal while waiting cannot resurrect", async () => {
    const h = setup();
    h.writes();
    h.invalidate();
    h.clock.advance(15_000);
    await drain();
    expect(h.state()?.state).toBe("stopped");
    expect(h.handler).not.toHaveBeenCalled();
    const other = setup();
    other.writes();
    other.ownerOff();
    other.clock.advance(15_000);
    expect(other.state()?.state).toBe("stopped");
    expect(other.clock.pendingTimers).toBe(0);
  });
  it("a changed corpus without a write signal is dormant evidence, not an old-rev batch", async () => {
    const h = setup();
    h.writes();
    h.latest(corpus("unobserved"));
    h.clock.advance(15_000);
    await drain();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.state()?.dormant).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });
  it("session queue admits at most eight directories and sixteen pending candidates with ONE timer", () => {
    const h = setup();
    for (let i = 0; i < 9; i++) h.write("r1", undefined, { ...directory, realpath: `/dir/${i}`, ino: i });
    expect(h.scheduler.inspect({ ...directory, realpath: "/dir/8", ino: 8 })).toBeUndefined();
    expect(h.clock.pendingTimers).toBe(1);
  });
  it("taskDoneTrigger=false and no-pending task-done cannot manufacture a batch", async () => {
    const h = setup({ taskDoneTrigger: false });
    h.scheduler.taskDone(directory);
    h.writes(3);
    h.scheduler.taskDone(directory);
    h.clock.advance(15_000);
    await drain();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.state()?.taskDoneEligible).toBe(false);
  });
  it("pending candidate cap preserves dormant evidence without growing the queue", () => {
    const h = setup();
    const many = {
      ...corpus(),
      candidates: Array.from({ length: 16 }, (_, i) => ({
        id: `rule.${String(i + 1).padStart(3, "0")}`,
        rev: "r1",
        topic: "rule",
        authority: "agent" as const,
      })),
    };
    h.latest(many);
    h.scheduler.externalWrite(directory, many);
    const second = { ...directory, realpath: "/another", ino: 4 };
    h.scheduler.externalWrite(second, corpus());
    expect(h.scheduler.inspect(second)).toMatchObject({ state: "quiet-wait", pendingCount: 1, dormant: true });
    expect(h.clock.pendingTimers).toBe(1);
  });
  it("real scheduler clock segments long delays, unrefs every segment and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    const handler = vi.fn((_batch: IncrementalBatch) => ({ kind: "settled" as const }));
    const selection = corpus();
    const scheduler = createIncrementalScheduler({
      settings: {
        ...DEFAULT_MEMORY_SETTINGS.incremental,
        enabled: true,
        quietMs: MAX_TIMER_DELAY_MS + 1000,
        idleMs: 0,
      },
      activity: () => port,
      isCurrent: () => true,
      readCorpus: () => selection,
      canAttempt: () => true,
      handler,
    });
    const port = {
      snapshot: () => ({
        generation: 0,
        lastActivityAt: 0,
        running: false,
        toolsInFlight: 0,
        liveIdle: true,
        hasPendingMessages: false,
      }),
    };
    try {
      for (let i = 0; i < 5; i++) scheduler.externalWrite(directory, selection);
      const raw = timers.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(raw.hasRef()).toBe(false);
      expect(timers.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
      expect(handler).not.toHaveBeenCalled();
      expect(timers.mock.calls.at(-1)?.[1]).toBe(1000);
      expect((timers.mock.results.at(-1)?.value as NodeJS.Timeout).hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(handler.mock.calls[0]?.[0])).toBe(true);
      scheduler.stop("shutdown");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      scheduler.stop("shutdown");
      timers.mockRestore();
      vi.useRealTimers();
    }
  });
});
