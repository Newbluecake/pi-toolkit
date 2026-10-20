import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { DriverEvent, RunState } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner } from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";

const budget = { ...DEFAULT_BUDGET, totalMs: 100_000, startupMs: 50_000, totalGraceMs: 0, abortGraceMs: 5, reapMs: 50 };
async function drain() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
function setup(opts: { syncThrow?: boolean; reject?: boolean; turnError?: string; delayedCreate?: boolean } = {}) {
  const clock = new FakeClock();
  let event: (e: DriverEvent) => void = () => undefined;
  let resolvePrompt: () => void = () => undefined;
  let rejectPrompt: (e: Error) => void = () => undefined;
  let runner: RuntimeRunner;
  let entered = false;
  const handle: SessionHandle = {
    sessionId: "s",
    sessionFile: "/tmp/input-evidence.jsonl",
    prompt: () => {
      // This assertion runs INSIDE the call: dispatch evidence must predate handing off the prompt.
      expect(runner.getRunState("r")?.diag.promptDispatchedAt).toBe(clock.now());
      entered = true;
      if (opts.syncThrow) throw new Error("sync refusal");
      if (opts.reject) return Promise.reject(new Error("refused before run"));
      return new Promise<void>((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });
    },
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools() {},
    getActiveTools: () => [],
    getLastAssistantText: () => "answer",
    getUsage: () => undefined,
    getTurnError: () => opts.turnError,
  };
  let resolveCreate: (h: SessionHandle) => void = () => undefined;
  const driver: SessionDriver = {
    create: () =>
      opts.delayedCreate
        ? new Promise((resolve) => {
            resolveCreate = resolve;
          })
        : Promise.resolve(handle),
    bind: async (_h, cb) => {
      event = cb;
    },
    onLateArrival() {},
  };
  const store = new MemoryRunStore();
  const snapshots: RunState[] = [];
  runner = new RuntimeRunner({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter({
      persist_snapshot: (e) => {
        if (e.kind === "persist_snapshot") store.put(e.snapshot);
      },
    }),
    emit() {},
    deliver() {},
    onStateChange: (_id, state) => {
      snapshots.push(state);
    },
  });
  return {
    runner,
    clock,
    store,
    snapshots,
    handle,
    entered: () => entered,
    emit: (e: DriverEvent) => event(e),
    finish: () => resolvePrompt(),
    reject: () => rejectPrompt(new Error("late failure")),
    created: () => resolveCreate(handle),
  };
}

const absent = (diag: object) => {
  expect(diag).not.toHaveProperty("inputAcceptedAt");
  expect(diag).not.toHaveProperty("promptOutcome");
};

describe("W2 RuntimeRunner input markers", () => {
  it.each([{ reject: true }, { syncThrow: true }])(
    "pre-run rejection %j is proven, failed, and persisted",
    async (opts) => {
      const t = setup(opts);
      const outcome = await t.runner.run({ runId: "r", prompt: "question", trackInput: true }, budget);
      expect(t.entered()).toBe(true);
      expect(outcome.status).toBe("failed");
      expect(outcome.diag).toMatchObject({ promptDispatchedAt: 0, promptOutcome: "rejected_pre_accept" });
      expect(outcome.diag).not.toHaveProperty("inputAcceptedAt");
      expect(outcome.diag).not.toHaveProperty("lastTurnStartAt");
      expect(t.store.get("r")?.outcome?.diag.promptOutcome).toBe("rejected_pre_accept");
    },
  );

  it("acceptance after slow creation and dispatch is observed immediately, once", async () => {
    const t = setup({ delayedCreate: true });
    const p = t.runner.run({ runId: "r", prompt: "question", trackInput: true }, budget);
    await drain();
    expect(t.runner.getRunState("r")?.diag).not.toHaveProperty("promptDispatchedAt");
    t.clock.advance(20_000);
    t.created();
    await drain();
    expect(t.entered()).toBe(true);
    expect(t.runner.getRunState("r")?.diag.promptDispatchedAt).toBe(20_000);
    t.clock.advance(5_000);
    t.emit({ t: "turn_start" });
    t.emit({ t: "input_accepted" });
    expect(t.runner.getRunState("r")?.diag.inputAcceptedAt).toBe(25_000);
    expect(t.snapshots.at(-1)?.diag.inputAcceptedAt).toBe(25_000);
    t.clock.advance(5_000);
    t.emit({ t: "input_accepted" });
    expect(t.runner.getRunState("r")?.diag.inputAcceptedAt).toBe(25_000);
    t.finish();
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(outcome.diag).not.toHaveProperty("promptOutcome");
    expect(t.store.get("r")?.outcome?.diag.inputAcceptedAt).toBe(25_000);
  });

  it.each([false, true])(
    "accepted then %s (provider failure / rejection) stays accepted, not retry-safe",
    async (reject) => {
      const t = setup({ turnError: "provider crashed after accepting" });
      const p = t.runner.run({ runId: "r", prompt: "question", trackInput: true }, budget);
      await drain();
      t.emit({ t: "input_accepted" });
      // No turn_start: acceptance alone is sufficient to prevent rejected_pre_accept.
      if (reject) t.reject();
      else t.finish();
      const outcome = await p;
      expect(outcome.status).toBe("failed");
      expect(outcome.diag.inputAcceptedAt).toBe(0);
      expect(outcome.diag).not.toHaveProperty("promptOutcome");
    },
  );

  it("turn_start without acceptance followed by rejection remains ambiguous", async () => {
    const t = setup();
    const p = t.runner.run({ runId: "r", prompt: "question", trackInput: true }, budget);
    await drain();
    t.emit({ t: "turn_start" });
    t.reject();
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.diag.promptDispatchedAt).toBe(0);
    absent(outcome.diag);
  });

  it.each(["timeout", "cancel"])("%s after dispatch without acceptance never proves rejection", async (reason) => {
    const t = setup();
    const abort = new AbortController();
    const p = t.runner.run({ runId: "r", prompt: "question", trackInput: true, signal: abort.signal }, budget);
    await drain();
    if (reason === "cancel") abort.abort();
    else t.clock.advance(budget.totalMs);
    await drain();
    const outcome = await p;
    expect(outcome.status).toBe(reason === "cancel" ? "aborted" : "timed_out");
    expect(outcome.diag.promptDispatchedAt).toBe(0);
    absent(outcome.diag);
    t.emit({ t: "input_accepted" }); // late acceptance cannot mutate a physically terminal entry
    expect(t.runner.getRunState("r")?.diag).not.toHaveProperty("inputAcceptedAt");
    t.finish();
  });

  it("startup failure leaves dispatch absent (prompt was never handed over)", async () => {
    const t = setup({ delayedCreate: true });
    const p = t.runner.run({ runId: "r", prompt: "question", trackInput: true }, budget);
    await drain();
    t.clock.advance(budget.startupMs);
    await drain();
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(t.entered()).toBe(false);
    for (const key of ["promptDispatchedAt", "inputAcceptedAt", "promptOutcome"])
      expect(outcome.diag).not.toHaveProperty(key);
    t.created();
  });

  it("tracking off ignores extra acceptance events, even liveness/first-event clocks", async () => {
    const t = setup();
    // The setup's prompt assertion is deliberately replaced for this untracked run.
    t.handle.prompt = () => new Promise<void>(() => undefined);
    const abort = new AbortController();
    const p = t.runner.run({ runId: "r", prompt: "question", signal: abort.signal }, budget);
    await drain();
    const before = t.runner.getRunState("r");
    t.clock.advance(10);
    t.emit({ t: "input_accepted" });
    expect(t.runner.getRunState("r")).toBe(before);
    abort.abort();
    const outcome = await p;
    for (const key of ["promptDispatchedAt", "inputAcceptedAt", "promptOutcome"])
      expect(outcome.diag).not.toHaveProperty(key);
  });

  it("an external/droid prompt rejection without a pi acceptance contract stays ambiguous", async () => {
    const t = setup({ reject: true });
    const outcome = await t.runner.run(
      {
        runId: "r",
        prompt: "question",
        trackInput: true,
        external: {
          provider: "droid",
          modelId: "x",
          roleName: "general",
          contextBlocks: [],
          persistTranscript: false,
          runId: "r",
          pricing: { status: "unpriced", reason: "no_match" },
          degraded: [],
        },
      },
      budget,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.diag.promptDispatchedAt).toBe(0);
    absent(outcome.diag);
  });
});
