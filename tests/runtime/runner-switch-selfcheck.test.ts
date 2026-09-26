import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { DriverEvent, SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";

/**
 * child-context-switch plan P0 (§2.3.1 point 3, v3.1; T-D4, runner side):
 * settlement priority for a self-check failure — the run must never settle
 * `completed` (or plain `failed(model)` with the switch-BEFORE text) when a
 * committed boundary-draft switch_context was never followed by a subsequent
 * model request. Two independent sources feed the same verdict:
 *   (a) the extension's own `subagent:switch-selfcheck` entry, forwarded as
 *       a `switch_selfcheck_failed` session_event and latched by the runner
 *       the FIRST time it is observed (driver.bind's onEvent callback, same
 *       call site as the X11 turn_end hook);
 *   (b)/(c) a synchronous, driver-independent fallback:
 *       `handle.getSwitchTail()` reporting a committed switch with no
 *       assistant entry after it on the branch — this is what still catches
 *       the failure when `agent_end` never fires, `appendEntry` throws, or
 *       the event is simply never forwarded (the extension's own reporting
 *       path is unavailable/broken, not just "didn't happen").
 * Priority order (runner.ts's promptError IIFE): cancel/timeout > prompt()'s
 * own rejection > self-check failure > turnError > completed.
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 20,
  bindMs: 20,
  totalMs: 200,
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
    getLastAssistantText: () => "switch-before answer",
    getUsage: () => undefined,
    ...overrides,
  };
}

/** A driver whose bind() fires the given events (synchronously, before its own promise resolves — matching pi's real ordering where appendEntry's entry_appended fires synchronously and agent_end precedes prompt() resolving) and hands the SessionHandle straight through. */
function driverEmitting(h: SessionHandle, events: DriverEvent[] = []): SessionDriver {
  return {
    create: async () => h,
    bind: async (_h, onEvent) => {
      for (const e of events) onEvent(e);
    },
    onLateArrival() {},
  };
}

function harness(driver: SessionDriver) {
  const clock = new FakeClock();
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
  };
  return { clock, runner: new RuntimeRunner(d) };
}

const pump = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("child-context-switch plan P0 (T-D4): runner selfcheck latch + settlement priority", () => {
  it("(a) extension-reported switch_selfcheck_failed latches and settles failed(model), even when getSwitchTail would otherwise say it's fine", async () => {
    const h = handle({
      getTurnError: () => undefined,
      getSwitchTail: () => ({ seq: 1, entryId: "e2", assistantAfter: true }),
    });
    const driver = driverEmitting(h, [{ t: "switch_selfcheck_failed", reason: "run-ended-after-switch" }]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-a" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("model");
    expect(outcome.error?.message).toBe("context switch self-check failed: run-ended-after-switch");
    expect(outcome.textFinal).toBeUndefined();
    // T-D4 joint assertion: the pre-switch assistant text must never leak into the outcome as a result.
    expect(JSON.stringify(outcome)).not.toContain("switch-before answer");
    expect(outcome.diag.contextSwitches?.selfcheck).toEqual({
      reason: "run-ended-after-switch",
      at: expect.any(Number),
    });
  });

  it("(b)/(c) no switch_selfcheck_failed event at all (agent_end never fired / appendEntry failed / not forwarded) — the getSwitchTail() fallback still catches it", async () => {
    const h = handle({
      getTurnError: () => undefined,
      getSwitchTail: () => ({ seq: 3, entryId: "e9", assistantAfter: false }),
    });
    const driver = driverEmitting(h, []); // nothing forwarded
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-bc" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("model");
    expect(outcome.error?.message).toBe(
      "context switch self-check failed: run ended right after switch_context (pi runtime semantics changed)",
    );
    expect(outcome.textFinal).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain("switch-before answer");
    // No extension-side entry was ever observed: the diag latch field stays empty even though the
    // run still correctly fails via the driver-independent fallback.
    expect(outcome.diag.contextSwitches?.selfcheck).toBeUndefined();
  });

  it("(d) latch + a live turnError both present: the message carries both, self-check first", async () => {
    const h = handle({
      getTurnError: () => "provider exploded",
      getSwitchTail: () => undefined,
    });
    const driver = driverEmitting(h, [{ t: "switch_selfcheck_failed", reason: "run-ended-after-switch" }]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-d" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe(
      "context switch self-check failed: run-ended-after-switch; turn error: provider exploded",
    );
  });

  it("(e) a self-check failure racing a user cancel: cancel/aborted takes priority (never overridden by self-check)", async () => {
    const h = handle({
      prompt: () => never(),
      getSwitchTail: () => ({ seq: 1, entryId: "e2", assistantAfter: false }),
    });
    const driver = driverEmitting(h, [{ t: "switch_selfcheck_failed", reason: "run-ended-after-switch" }]);
    const { runner } = harness(driver);
    const p = runner.run({ ...request, runId: "r-e" }, budget);
    await pump();
    await runner.abortRun("r-e", "user_stop");
    const outcome = await p;
    expect(outcome.status).toBe("aborted");
  });

  it("(e') a self-check failure racing a total timeout: timed_out takes priority", async () => {
    const h = handle({
      prompt: () => never(),
      getSwitchTail: () => ({ seq: 1, entryId: "e2", assistantAfter: false }),
    });
    const driver = driverEmitting(h, [{ t: "switch_selfcheck_failed", reason: "run-ended-after-switch" }]);
    const { clock, runner } = harness(driver);
    const p = runner.run({ ...request, runId: "r-e2" }, budget);
    await pump();
    clock.advance(budget.totalMs + 1);
    await pump();
    const outcome = await p;
    expect(outcome.status).toBe("timed_out");
  });

  it("(f) positive: a committed switch followed by an assistant entry, no latch — completes normally with the switch-after text", async () => {
    const h = handle({
      getTurnError: () => undefined,
      getSwitchTail: () => ({ seq: 1, entryId: "e2", assistantAfter: true }),
      getLastAssistantText: () => "switch-after answer",
    });
    const driver = driverEmitting(h, []);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-f" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("switch-after answer");
  });

  it("regression: a run that never touched switch_context (no getSwitchTail method at all) is unaffected", async () => {
    const h = handle({ getTurnError: () => undefined });
    delete (h as { getSwitchTail?: unknown }).getSwitchTail;
    const driver = driverEmitting(h, []);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-plain" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("switch-before answer");
  });

  it("regression: getSwitchTail() returning undefined (no switch ever committed on the branch) never triggers a self-check failure", async () => {
    const h = handle({ getTurnError: () => undefined, getSwitchTail: () => undefined });
    const driver = driverEmitting(h, []);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-none" }, budget);
    expect(outcome.status).toBe("completed");
  });
});

/**
 * child-context-switch plan P0 (§2.3.1, runner error concatenation): a live
 * turnError gets pi's own auto-compaction failure reason appended, but only
 * when that failure postdates both the last successful switch_context and
 * the last successful pi auto-compaction (never a stale, superseded one).
 */
describe("child-context-switch plan P0: runner turnError + auto-compaction-failure annotation", () => {
  it("appends the most recent compaction_failed reason/message to a live turnError", async () => {
    const h = handle({ getTurnError: () => "provider crashed" });
    const driver = driverEmitting(h, [{ t: "compaction_failed", reason: "overflow", message: "recovery failed" }]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-annot" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("provider crashed; auto-compaction failed (overflow): recovery failed");
  });

  it("does not append a compaction failure superseded by a later successful compaction_end", async () => {
    const h = handle({ getTurnError: () => "provider crashed" });
    const driver = driverEmitting(h, [
      { t: "compaction_failed", reason: "threshold", message: "old failure" },
      { t: "compaction_end", aborted: false }, // a later successful pi compaction supersedes it
    ]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-stale" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("provider crashed");
  });

  it("does not append a compaction failure superseded by a later successful switch_context", async () => {
    const h = handle({ getTurnError: () => "provider crashed" });
    const driver = driverEmitting(h, [
      { t: "compaction_failed", reason: "threshold", message: "old failure" },
      {
        t: "context_switch",
        seq: 1,
        keepRecent: false,
        dropped: { fromEntryId: "e1", toEntryId: "e5", entries: 3, tokensBefore: 500, tokensAfterEstimate: 50 },
      },
    ]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-stale2" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("provider crashed");
  });

  it("a completed run (no turnError) never gets the annotation, even with a live compaction failure recorded", async () => {
    const h = handle({ getTurnError: () => undefined });
    const driver = driverEmitting(h, [{ t: "compaction_failed", reason: "threshold", message: "old failure" }]);
    const { runner } = harness(driver);
    const outcome = await runner.run({ ...request, runId: "r-completed" }, budget);
    expect(outcome.status).toBe("completed");
  });
});
