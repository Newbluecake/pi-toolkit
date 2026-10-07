import { describe, expect, it } from "vitest";
import {
  createSegmentedClock,
  FakeClock,
  MAX_TIMER_DELAY_MS,
  type Clock,
  type RawTimerClock,
  type TimerHandle,
} from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator } from "../../src/workflow/orchestrator.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * T4 (agent-explicit-timeout-extend plan §3.4/§4 Z11/§7): the workflow WT8
 * timer must not busy-wait when the deadline exceeds setTimeout's 2^31−1 ms
 * ceiling (C16: Node fires such a timer after ~1ms, the orchestrator answers
 * `onTimer(now < softAt)` with `wait` and re-arms — a 1ms re-arm loop).
 *
 * The orchestrator runs on `deps.clock = createSegmentedClock(overflowRaw)`:
 * the raw backend below simulates Node's overflow (a delay > MAX fires after
 * 1ms). With segmentation a 30-day deadline arms as ≤ MAX-sized chained
 * segments — a bounded number of raw `set` calls per hour. Without it (a
 * passthrough `createSegmentedClock`, the batch-0 stub) the raw call count
 * explodes — that red state was expected until P4 landed; P4's real
 * implementation is now in the tree, so all three cases below must be green.
 *
 * The worker is the standard FakeWorkerLike (never returns the script), so
 * the workflow sits on WT8 alone; `heartbeatMs: 0` keeps the runaway
 * watchdog timer-free.
 */

const DAY = 86_400_000;
const THIRTY_DAYS = 30 * DAY;
const HOUR = 3_600_000;

const BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: THIRTY_DAYS,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 600_000,
  maxParallel: 1,
  maxChildren: 50,
  maxBatchItems: 100,
  childBudgetPolicy: "inherit_remaining",
  abortGraceMs: 1_000,
  totalGraceMs: 10_000,
  maxExtensions: 2,
  maxTotalFactor: 2,
};

const SCRIPT = 'export const meta = { name: "g", description: "g" };\nreturn 1;';

/**
 * A raw timer backend simulating Node's overflow (plan §3.4/C16): any delay
 * above MAX_TIMER_DELAY_MS fires after ~1ms instead. Counts every raw `set`
 * call so the tests can bound how often the un-segmented layer is touched.
 * `direct` exposes the same backend as a plain (un-segmented) Clock — the
 * control case.
 */
function overflowRawClock() {
  const base = new FakeClock(0);
  const inner = new Map<number, TimerHandle>();
  let nextId = 1;
  let setCalls = 0;
  const set = (ms: number, fn: () => void): number => {
    setCalls += 1;
    const h = base.setTimer(ms > MAX_TIMER_DELAY_MS ? 1 : ms, fn);
    inner.set(nextId, h);
    return nextId++;
  };
  const clear = (timer: unknown): void => {
    const owned = inner.get(timer as number);
    if (owned !== undefined) base.clearTimer(owned);
    inner.delete(timer as number);
  };
  const raw: RawTimerClock = { now: () => base.now(), set, clear };
  const direct: Clock = {
    now: () => base.now(),
    setTimer: (ms, fn) => ({ id: set(ms, fn) }),
    clearTimer: (h) => clear(h.id),
  };
  return { raw, direct, base, setCalls: () => setCalls };
}

interface Booted {
  readonly run: Promise<WorkflowOutcome>;
  readonly deadlineEvents: readonly { channel: string; payload: Record<string, unknown> }[];
}

async function boot(clock: Clock): Promise<Booted> {
  const factory = fakeSpawnWorkerFactory();
  const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const deps = {
    clock,
    createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
    spawner: {
      spawn: async () => ({ runId: "run-1" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    },
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    emit: (channel: string, payload: unknown) => emitted.push({ channel, payload: payload as Record<string, unknown> }),
    onDeadlineNotice: () => undefined,
  };
  const orch = createOrchestrator(deps);
  const run = orch.run({ workflowId: "wf_wt8", script: SCRIPT, budget: BUDGET });
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  return { run, deadlineEvents: emitted };
}

describe("WT8 with a 30-day deadline (agent-explicit-timeout-extend §7 T4)", () => {
  it("segmented clock keeps raw setTimer calls bounded while arming a 30d deadline (≤3 across a 1h advance)", async () => {
    const { raw, base, setCalls } = overflowRawClock();
    const booted = await boot(createSegmentedClock(raw));
    // Advance a full hour in chunks; bail out as soon as the bound is
    // decisively violated so the pre-P4 (stub) red failure stays fast —
    // under real segmentation the count never grows past the boot-time arms.
    let advanced = 0;
    while (advanced < HOUR) {
      base.advance(Math.min(60_000, HOUR - advanced));
      advanced += 60_000;
      if (setCalls() > 3) break;
    }
    expect(setCalls()).toBeLessThanOrEqual(3);
    void booted;
  }, 20_000);

  it("control: the same raw backend WITHOUT segmentation busy-waits (≥1000 raw calls in 1.5s) — proves the bound above is meaningful", async () => {
    const { direct, base, setCalls } = overflowRawClock();
    await boot(direct);
    base.advance(1_500);
    expect(setCalls()).toBeGreaterThanOrEqual(1_000);
  }, 20_000);

  // Pre-P4 guard: with the batch-0 stub `createSegmentedClock(raw) === raw`,
  // and advancing a FakeClock 30 days through a 1ms re-arm loop would mean
  // ~2.6 billion timer fires. Skip until the real segmentation lands; the
  // identity check below is exactly the stub detector.
  const stubProbe = overflowRawClock().raw;
  const segmentationIsReal = createSegmentedClock(stubProbe) !== stubProbe;
  (segmentationIsReal ? it : it.skip)(
    "WT8 still fires at the 30d soft deadline through the segments: grace window, then timed_out at graceUntil",
    async () => {
      const { raw, base } = overflowRawClock();
      const booted = await boot(createSegmentedClock(raw));
      base.advance(THIRTY_DAYS);
      const events = booted.deadlineEvents.filter((e) => e.channel === "subagent:workflow:deadline");
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        workflowId: "wf_wt8",
        kind: "grace",
        deadlineAt: THIRTY_DAYS,
        graceUntil: THIRTY_DAYS + 10_000,
        hardDeadlineAt: 2 * THIRTY_DAYS,
      });
      base.advance(10_000);
      const outcome = await booted.run;
      expect(outcome.status).toBe("timed_out");
      expect(outcome.timeoutReason).toBe("workflow_total");
    },
    20_000,
  );
});
