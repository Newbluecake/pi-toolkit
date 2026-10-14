import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { ClassifiedError } from "../../src/core/errors.js";
import type { DeliveryPayload, ErrorInfo, RunOutcome, RunSnapshot } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  START_ERROR_MESSAGE_CAP,
  type ResolvedSpawnRequest,
} from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";

/**
 * external-agent plan §2.7/§2.13 (P1): the runner unwraps ClassifiedError at
 * both of its seams — startError (create/resume/prompt rejections) and the
 * prompt settlement (handle.getTurnErrorInfo takes priority over getTurnError).
 * A handle WITHOUT getTurnErrorInfo (every pi handle, every test fake) keeps
 * its exact pre-P1 behavior.
 */
const request: ResolvedSpawnRequest = { runId: "r_cls", prompt: "hello", displayMeta: { label: "P1" } };
const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  firstEventMs: 10,
  idleMs: 10,
  totalMs: 200,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};
const classified = (kind: ErrorInfo["kind"], message: string, retryable = false): ClassifiedError =>
  new ClassifiedError({ kind, message, retryable });

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
    getLastAssistantText: () => undefined,
    getUsage: () => undefined,
    ...overrides,
  };
}

function harness(driver: SessionDriver) {
  const clock = new FakeClock();
  const deliveries: DeliveryPayload[] = [];
  const snapshots: RunSnapshot[] = [];
  const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
  const effects = new BasicEffectInterpreter({
    enqueue_delivery: (e) => {
      if (e.kind === "enqueue_delivery") deliveries.push(e.payload);
    },
    persist_snapshot: (e) => {
      if (e.kind === "persist_snapshot") snapshots.push(e.snapshot);
    },
  });
  const runner = new RuntimeRunner({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 1),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects,
    emit() {},
    deliver() {},
  });
  return { clock, runner, deliveries, snapshots };
}
const pump = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("startError unwraps ClassifiedError (plan §2.7)", () => {
  it("driver.create rejecting with ClassifiedError{auth} ⇒ failed with error.kind=auth, retryable false", async () => {
    const h = harness({
      create: () => Promise.reject(classified("auth", "droid authentication/subscription failure (HTTP 402)")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("auth");
    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.message).toContain("HTTP 402");
  });

  it("prompt() rejecting with ClassifiedError keeps kind/model semantics and the message cap", async () => {
    const huge = "y".repeat(START_ERROR_MESSAGE_CAP * 3);
    const h = harness({
      create: async () => handle({ prompt: () => Promise.reject(classified("model", huge, true)) }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("model");
    expect(outcome.error?.retryable).toBe(true);
    expect(outcome.error?.message.length).toBe(START_ERROR_MESSAGE_CAP);
    expect(outcome.error?.message.endsWith("…")).toBe(true);
  });

  it("non-classified rejections keep the pre-P1 internal kind and the empty-message fallback", async () => {
    const h = harness({
      create: () => Promise.reject(new Error("plain failure")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.error?.kind).toBe("internal");
    expect(outcome.error?.message).toBe("plain failure");
  });

  it("startup_transient+retryable passes the classified kind through when the retry budget is exhausted (0)", async () => {
    // NOTE: the runner has no create()-retry loop (the reducer's startup_retry
    // branch keeps the run non-terminal for a later package's driver to
    // exploit); with startupRetries 0 the run settles immediately and the
    // classified kind/retryable must survive into the outcome verbatim.
    let creates = 0;
    const h = harness({
      create: () => {
        creates++;
        return Promise.reject(classified("startup_transient", "spawn EAGAIN", true));
      },
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, { ...budget, startupRetries: 0 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("startup_transient");
    expect(outcome.error?.retryable).toBe(true);
    expect(outcome.error?.message).toBe("spawn EAGAIN");
    expect(creates).toBe(1);
  });
});

describe("prompt settlement honors getTurnErrorInfo (plan §2.7)", () => {
  it("resolved prompt + getTurnErrorInfo ⇒ failed with that kind/retryable (message capped)", async () => {
    const info: ErrorInfo = { kind: "auth", message: "subscription exhausted", retryable: false };
    const h = harness({
      create: async () =>
        handle({
          getLastAssistantText: () => "partial",
          getTurnErrorInfo: () => info,
        }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("auth");
    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.message).toBe("subscription exhausted");
  });

  it("getTurnErrorInfo wins over getTurnError when both are present", async () => {
    const h = harness({
      create: async () =>
        handle({
          getTurnError: () => "provider 500",
          getTurnErrorInfo: () => ({ kind: "config", message: "unknown model: droid/nope", retryable: false }),
        }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toBe("unknown model: droid/nope");
  });

  it("getTurnErrorInfo message is capped at START_ERROR_MESSAGE_CAP", async () => {
    const huge = "z".repeat(START_ERROR_MESSAGE_CAP * 2);
    const h = harness({
      create: async () =>
        handle({
          getTurnErrorInfo: () => ({ kind: "model", message: huge, retryable: false }),
        }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.error?.message.length).toBe(START_ERROR_MESSAGE_CAP);
  });

  it("pi-shaped handles (getTurnError only, or neither) are unchanged", async () => {
    const turnErrorOnly = await harness({
      create: async () => handle({ getTurnError: () => "provider 500" }),
      bind: async () => undefined,
      onLateArrival() {},
    }).runner.run(request, budget);
    expect(turnErrorOnly.status).toBe("failed");
    expect(turnErrorOnly.error?.kind).toBe("model");
    expect(turnErrorOnly.error?.message).toBe("provider 500");

    const clean = await harness({
      create: async () => handle({ getLastAssistantText: () => "done" }),
      bind: async () => undefined,
      onLateArrival() {},
    }).runner.run(request, budget);
    expect(clean.status).toBe("completed");
    expect(clean.error).toBeUndefined();
    expect(clean.text).toBe("done");
  });
});
