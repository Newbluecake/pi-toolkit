import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { DeliveryPayload, RunOutcome, RunSnapshot } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  START_ERROR_MESSAGE_CAP,
  type ResolvedSpawnRequest,
} from "../../src/runtime/runner.js";
import { explainPromptRejection, type SessionDriver, type SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { formatSingle } from "../../src/delivery/format.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { QueryService } from "../../src/service/query-service.js";

/**
 * Incident 2026-09-25: `Agent({ model: "cloudrouter-anthropic/claude-opus-5-5" })`
 * after the provider was renamed. The host registry still resolved the old
 * name, the child's fresh model runtime did not, and pi's `session.prompt()`
 * threw `No API key found for cloudrouter-anthropic.` — which the runner's
 * prompt guard reported as reason "cancelled" ⇒ `aborted — 0 turns: cancelled`.
 * A start-phase rejection must settle `failed` with the real cause visible in
 * the delivery notice and in get_subagent_result; a real abort must not change.
 */
const NO_KEY = "No API key found for cloudrouter-anthropic.\n\nUse /login to log into a provider via OAuth or API key.";
const request: ResolvedSpawnRequest = { runId: "r_start", prompt: "hello", displayMeta: { label: "P2" } };
const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 30,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};
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

async function resultText(outcome: RunOutcome, snapshot: RunSnapshot): Promise<string> {
  const query: QueryService = {
    get: () => ({ ...snapshot, outcome }),
    list: () => [],
    wait: async () => ({ ok: true, outcome }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  };
  const result = await createResultTool({ query }).execute(
    "tc",
    { run_id: outcome.runId },
    undefined,
    () => undefined,
    {} as never,
  );
  return (result.content[0] as { text: string }).text;
}

describe("start-phase rejections settle failed with the cause visible", () => {
  it("prompt() rejecting (the incident) ⇒ failed, notice + get_subagent_result show the pi error", async () => {
    const h = harness({
      create: async () => handle({ prompt: () => Promise.reject(new Error(NO_KEY)) }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.turns).toBe(0);
    expect(outcome.error?.message).toBe(NO_KEY);
    expect(outcome.error?.message).not.toBe("cancelled");

    expect(h.deliveries).toHaveLength(1);
    const payload = h.deliveries[0]!;
    expect(payload.status).toBe("failed");
    expect(payload.failReason).toBe(NO_KEY);
    const notice = formatSingle(payload);
    expect(notice).toContain('Subagent "P2" (#r_start) failed');
    expect(notice).toContain("No API key found for cloudrouter-anthropic.");
    expect(notice).not.toContain("cancelled");

    const text = await resultText(outcome, h.snapshots.at(-1)!);
    expect(text).toContain("Subagent run failed: No API key found for cloudrouter-anthropic.");
  });

  it("driver.create rejecting ⇒ failed(cause), not timed_out(session_create)", async () => {
    const h = harness({
      create: () => Promise.reject(new Error("unknown model: cloudrouter-anthropic/claude-opus-5-5")),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.timeoutReason).toBeUndefined();
    expect(outcome.error?.message).toBe("unknown model: cloudrouter-anthropic/claude-opus-5-5");
    expect(h.deliveries[0]?.failReason).toBe("unknown model: cloudrouter-anthropic/claude-opus-5-5");
  });

  it("driver.create throwing synchronously keeps its message (pre-existing outer-catch path)", async () => {
    const h = harness({
      create: () => {
        throw new Error("unknown model: x/y (not in pi's model registry — check provider/auth)");
      },
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(h.deliveries[0]?.failReason).toContain("unknown model: x/y");
  });

  it("driver.bind rejecting ⇒ failed(cause)", async () => {
    const h = harness({
      create: async () => handle(),
      bind: () => Promise.reject(new Error("extension bind exploded")),
      onLateArrival() {},
    });
    const outcome = await h.runner.run(request, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("extension bind exploded");
    expect(h.deliveries[0]?.failReason).toBe("extension bind exploded");
  });

  it("caps a huge error message and never reports an empty one", async () => {
    const huge = "x".repeat(START_ERROR_MESSAGE_CAP * 3);
    const big = await harness({
      create: async () => handle({ prompt: () => Promise.reject(new Error(huge)) }),
      bind: async () => undefined,
      onLateArrival() {},
    }).runner.run(request, budget);
    expect(big.error?.message.length).toBe(START_ERROR_MESSAGE_CAP);
    expect(big.error?.message.endsWith("…")).toBe(true);

    const empty = await harness({
      create: async () => handle({ prompt: () => Promise.reject(new Error("   ")) }),
      bind: async () => undefined,
      onLateArrival() {},
    }).runner.run(request, budget);
    expect(empty.status).toBe("failed");
    expect(empty.error?.message).toContain("session start failed");
  });
});

describe("abort / timeout semantics are unchanged", () => {
  it("user abort of a hanging prompt ⇒ aborted, failReason cancelled", async () => {
    const h = harness({
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = h.runner.run(request, budget);
    await pump();
    await h.runner.abortRun(request.runId, "user_stop");
    const outcome = await p;
    expect(outcome.status).toBe("aborted");
    expect(h.deliveries[0]?.failReason).toBe("cancelled");
  });

  it("a prompt() that rejects *because of* the user abort is still aborted, not failed", async () => {
    let rejectPrompt: ((e: Error) => void) | undefined;
    const h = harness({
      create: async () =>
        handle({
          prompt: () => new Promise<void>((_, reject) => (rejectPrompt = reject)),
          requestAbort: () => {
            rejectPrompt?.(new Error("Request was aborted"));
            return Promise.resolve();
          },
        }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = h.runner.run(request, budget);
    await pump();
    await h.runner.abortRun(request.runId, "user_stop");
    rejectPrompt?.(new Error("Request was aborted"));
    const outcome = await p;
    expect(outcome.status).toBe("aborted");
    expect(outcome.error?.kind).toBe("aborted");
  });

  it("create that never resolves still times out (startup budget), not failed", async () => {
    const h = harness({ create: () => never(), bind: async () => undefined, onLateArrival() {} });
    const p = h.runner.run(request, budget);
    await pump();
    h.clock.advance(11);
    await pump();
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("session_create");
  });

  it("a prompt that hangs past the total budget still times out", async () => {
    const h = harness({
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = h.runner.run(request, budget);
    await pump();
    h.clock.advance(31);
    await pump();
    expect((await p).status).toBe("timed_out");
  });
});

describe("explainPromptRejection (host-registry vs child-runtime divergence)", () => {
  const base = new Error("No API key found for cloudrouter-anthropic.");
  it("names the stale-registry divergence when the child runtime does not know the model", () => {
    const session = {
      model: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
      modelRuntime: { getModel: () => undefined },
    };
    const err = explainPromptRejection(session, base);
    expect(err.message).toContain(
      `model "cloudrouter-anthropic/claude-opus-5-5" is not in the child session's model registry`,
    );
    expect(err.message).toContain("No API key found for cloudrouter-anthropic.");
  });
  it("passes the original error through when the model is known or the runtime is not inspectable", () => {
    const known = { model: { provider: "cr-anthropic", id: "x" }, modelRuntime: { getModel: () => ({}) } };
    expect(explainPromptRejection(known, base)).toBe(base);
    expect(explainPromptRejection({ model: { provider: "p", id: "i" } }, base)).toBe(base);
    expect(explainPromptRejection(undefined, base)).toBe(base);
    const throwing = {
      model: { provider: "p", id: "i" },
      modelRuntime: {
        getModel: () => {
          throw new Error("boom");
        },
      },
    };
    expect(explainPromptRejection(throwing, base)).toBe(base);
    expect(explainPromptRejection(known, "plain string").message).toBe("plain string");
  });
});
