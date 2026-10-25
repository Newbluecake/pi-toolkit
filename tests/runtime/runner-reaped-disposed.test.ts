import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type RunnerDeps } from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { Reaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

/**
 * cache-thread plan R2-1: `RunnerDeps.onReaped`'s 4th argument `{ disposed }` is the seal proof. true only when
 * the session was positively disposed (reaper `disposed:true` and nothing unkillable, or a late arrival that went
 * through `disposeLate`); a reap rejection / `disposed:false` / unkillable orphan reports false.
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 100,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 50,
  steerMs: 2,
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

class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}

const drain = async (ticks = 80): Promise<void> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

function setup(driver: SessionDriver, opts: { reapRejects?: boolean; voidDisposeLate?: boolean } = {}) {
  const clock = new FakeClock();
  const calls: Array<{ runId: string; fork?: string; info?: { disposed: boolean } }> = [];
  const real = new EscalatingReaper(clock);
  const reaper: Reaper = {
    registry: real.registry,
    abortReap: (runId, gen) => real.abortReap(runId, gen),
    reap: opts.reapRejects ? () => Promise.reject(new Error("reap exploded")) : (input) => real.reap(input),
    disposeLate: opts.voidDisposeLate
      ? (runId, gen, h) => {
          real.disposeLate(runId, gen, h);
        }
      : (runId, gen, h) => real.disposeLate(runId, gen, h),
  };
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: new FakeWatchdog(),
    reaper,
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
    onReaped: (runId, fork, _sessionId, info) => {
      calls.push({ runId, ...(fork === undefined ? {} : { fork }), ...(info === undefined ? {} : { info }) });
    },
  };
  return { clock, runner: new RuntimeRunner(d), calls };
}

const base = (extra: Partial<SessionDriver> = {}): SessionDriver => ({
  create: async () => {
    throw new Error("create must not run for a resumed session");
  },
  bind: async () => undefined,
  onLateArrival() {},
  ...extra,
});

describe("RunnerDeps.onReaped { disposed } (R2-1)", () => {
  it("normal settle with a positively disposed session ⇒ disposed:true", async () => {
    const t = setup(base({ resume: async (file) => handle({ sessionFile: file }) }));
    await t.runner.run({ runId: "r1", prompt: "q", resumeFrom: "/c/f1.jsonl" }, budget);
    await drain();
    expect(t.calls).toEqual([{ runId: "r1", info: { disposed: true } }]);
  });

  it("dispose() reports returned:false ⇒ disposed:false (the file may still be written)", async () => {
    const t = setup(
      base({
        resume: async (file) =>
          handle({ sessionFile: file, dispose: () => ({ returned: false, killed: 0, unkillable: [] }) }),
      }),
    );
    await t.runner.run({ runId: "r2", prompt: "q", resumeFrom: "/c/f2.jsonl" }, budget);
    await drain();
    expect(t.calls[0]!.info).toEqual({ disposed: false });
  });

  it("unkillable orphan after dispose ⇒ disposed:false", async () => {
    const t = setup(
      base({
        resume: async (file) =>
          handle({
            sessionFile: file,
            dispose: () => ({ returned: true, killed: 0, unkillable: [{ kind: "bash", id: "j1" }] }),
          }),
      }),
    );
    await t.runner.run({ runId: "r3", prompt: "q", resumeFrom: "/c/f3.jsonl" }, budget);
    await drain();
    expect(t.calls[0]!.info).toEqual({ disposed: false });
  });

  it("a rejecting reap ⇒ disposed:false", async () => {
    const t = setup(base({ resume: async (file) => handle({ sessionFile: file }) }), { reapRejects: true });
    await t.runner.run({ runId: "r4", prompt: "q", resumeFrom: "/c/f4.jsonl" }, budget);
    await drain();
    expect(t.calls[0]!.info).toEqual({ disposed: false });
  });

  it("no session ever created (create failure) ⇒ disposed:false at the reap site", async () => {
    const t = setup(
      base({
        resume: async () => {
          throw new Error("unreadable");
        },
      }),
    );
    await t.runner.run({ runId: "r5", prompt: "q", resumeFrom: "/c/f5.jsonl" }, budget);
    await drain();
    expect(t.calls).toEqual([{ runId: "r5", info: { disposed: false } }]);
  });

  it("a late-arriving session that goes through disposeLate ⇒ a second callback with disposed:true", async () => {
    let lateResolve: (h: SessionHandle) => void = () => undefined;
    const lateP = new Promise<SessionHandle>((r) => {
      lateResolve = r;
    });
    const t = setup(
      base({
        resume: () => lateP,
        onLateArrival(p, cb) {
          p.then(cb, () => undefined);
        },
      }),
    );
    const run = t.runner.run({ runId: "r6", prompt: "q", resumeFrom: "/c/f6.jsonl" }, budget);
    await drain();
    t.clock.advance(11);
    await run;
    await drain();
    lateResolve(handle({ sessionFile: "/c/f6.jsonl" }));
    await drain();
    expect(t.calls.map((c) => c.info?.disposed)).toEqual([false, true]);
  });

  it("a late session whose dispose never returned ⇒ disposed:false (follow-up r_38A7HG4K #2: no hard-coded true)", async () => {
    for (const dispose of [
      () => ({ returned: false, killed: 0, unkillable: [] }),
      () => ({ returned: true, killed: 0, unkillable: [{ kind: "bash", id: "j" }] }),
    ]) {
      let lateResolve: (h: SessionHandle) => void = () => undefined;
      const lateP = new Promise<SessionHandle>((r) => {
        lateResolve = r;
      });
      const t = setup(
        base({
          resume: () => lateP,
          onLateArrival(p, cb) {
            p.then(cb, () => undefined);
          },
        }),
      );
      const run = t.runner.run({ runId: "r8", prompt: "q", resumeFrom: "/c/f8.jsonl" }, budget);
      await drain();
      t.clock.advance(11);
      await run;
      await drain();
      lateResolve(handle({ sessionFile: "/c/f8.jsonl", dispose }));
      await drain();
      expect(t.calls.map((c) => c.info?.disposed)).toEqual([false, false]);
    }
  });

  it("a reaper whose disposeLate returns no verdict is treated as not proven (disposed:false)", async () => {
    let lateResolve: (h: SessionHandle) => void = () => undefined;
    const lateP = new Promise<SessionHandle>((r) => {
      lateResolve = r;
    });
    const t = setup(
      base({
        resume: () => lateP,
        onLateArrival(p, cb) {
          p.then(cb, () => undefined);
        },
      }),
      { voidDisposeLate: true },
    );
    const run = t.runner.run({ runId: "r9", prompt: "q", resumeFrom: "/c/f9.jsonl" }, budget);
    await drain();
    t.clock.advance(11);
    await run;
    await drain();
    lateResolve(handle({ sessionFile: "/c/f9.jsonl" }));
    await drain();
    expect(t.calls.map((c) => c.info?.disposed)).toEqual([false, false]);
  });

  it("runs call onReaped with forkSessionFrom undefined (legacy 2nd arg) (4th arg is simply extra)", async () => {
    const t = setup(base({ create: async () => handle() }));
    await t.runner.run({ runId: "r7", prompt: "q" }, budget);
    await drain();
    expect(t.calls).toEqual([{ runId: "r7", info: { disposed: true } }]);
  });
});
