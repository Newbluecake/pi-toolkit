import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type WorkflowChildEvent,
} from "../../src/workflow/host.js";
import type { HostCallEnvelope, WorkerHost } from "../../src/workflow/types.js";

/**
 * workflow-agent-queue §6/§7 (stage A): seeded property test for the host's
 * FIFO queue. Random interleavings of agent() submissions, spawn
 * success/error/rejection/lateness, child settles, phase entries, clock
 * advances (phase timeouts, dispatch spawn timeouts, HR2) and a final stop
 * or terminate. Invariants:
 *  - at every step: slots in use (admission + pre_runner + running) ≤ maxParallel;
 *  - spawn() is called in submission order (FIFO — nobody jumps the queue);
 *  - each callId: exactly one children[] record, at most one host_settle, and a
 *    child-event sequence allowed by the §5 contract (queued before spawned,
 *    rejected right before settled, settled last);
 *  - after stop + late spawns/settles: nothing active or queued, no armed timers.
 */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeWorkerHost() {
  const hostCall: Array<(e: HostCallEnvelope) => void> = [];
  const phase: Array<(t: string) => void> = [];
  const terminating: Array<(r: string) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const workerHost = {
    events: {
      onHostCall: (cb: (e: HostCallEnvelope) => void) => hostCall.push(cb),
      onPhase: (cb: (t: string) => void) => phase.push(cb),
      onTerminating: (cb: (r: string) => void) => terminating.push(cb),
    },
    send: (m: Record<string, unknown>) => sent.push(m),
  } as unknown as WorkerHost;
  return {
    workerHost,
    sent,
    call: (id: string, args: unknown) => hostCall.forEach((cb) => cb({ id, op: "agent", args })),
    enterPhase: (title: string) => phase.forEach((cb) => cb(title)),
    terminate: (reason: string) => terminating.forEach((cb) => cb(reason)),
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface PendingSpawn {
  readonly callIndex: number;
  resolve(r: { runId: string } | { error: { message: string } }): void;
  reject(e: unknown): void;
}

async function runSeed(seed: number): Promise<void> {
  const next = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const clock = new FakeClock();
  const w = fakeWorkerHost();
  const maxParallel = 1 + Math.floor(next() * 3);
  const pendingSpawns: PendingSpawn[] = [];
  const waiters = new Map<string, (o: ChildOutcome) => void>();
  const spawnOrder: number[] = [];
  const aborts: string[] = [];
  const events: WorkflowChildEvent[] = [];
  let runSeq = 0;
  const spawner: ChildSpawner = {
    spawn: (req) =>
      new Promise((resolve, reject) => {
        const callIndex = Number(req.prompt.slice(2));
        spawnOrder.push(callIndex);
        pendingSpawns.push({ callIndex, resolve, reject });
      }),
    abort: async (runId) => {
      aborts.push(runId);
      return true;
    },
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        waiters.set(runIds[0]!, (o) => resolve({ settled: [o], pending: [] }));
      }),
  };
  const handler = attachHostCallHandler({
    clock,
    workerHost: w.workerHost,
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget: {
      hostCallMs: 1_000,
      gateMs: 1_000,
      maxParallel,
      maxChildren: 1_000,
      maxBatchItems: 1_000,
      childBudgetPolicy: "inherit_remaining",
      phaseTotalMs: 3_000,
    },
    workflowDeadlineAt: 10_000_000,
    onChildEvent: (e) => events.push(e),
  });

  const activeNow = (): number => {
    const s = handler.registry.stats;
    return s.admission + s.pre_runner + s.running;
  };
  const submitted: string[] = [];
  const steps = 60 + Math.floor(next() * 60);
  for (let i = 0; i < steps; i += 1) {
    const r = next();
    if (r < 0.35) {
      const id = String(submitted.length);
      submitted.push(id);
      const phase = pick(["a", "b", undefined] as const);
      w.call(id, { prompt: `p-${id}`, opts: phase === undefined ? null : { phase } });
    } else if (r < 0.6 && pendingSpawns.length > 0) {
      const idx = Math.floor(next() * pendingSpawns.length);
      const [s] = pendingSpawns.splice(idx, 1);
      const kind = next();
      if (kind < 0.7) s!.resolve({ runId: `run-${++runSeq}` });
      else if (kind < 0.9) s!.resolve({ error: { message: "spawn error" } });
      else s!.reject(new Error("spawn threw"));
    } else if (r < 0.8 && waiters.size > 0) {
      const runId = pick([...waiters.keys()]);
      const done = waiters.get(runId)!;
      waiters.delete(runId);
      done({ runId, status: pick(["completed", "failed", "aborted"] as const), text: "t" });
    } else if (r < 0.88) {
      w.enterPhase(pick(["a", "b"]));
    } else {
      clock.advance(Math.floor(next() * 1_500));
    }
    await flush();
    expect(activeNow(), `seed ${seed} step ${i}: slots in use`).toBeLessThanOrEqual(maxParallel);
  }

  // Final stop: stopOwned (with a grace window) or a hard terminate().
  if (next() < 0.5) {
    const stopping = handler.stopOwned("user_stop", 500);
    await flush();
    clock.advance(500);
    await stopping;
  } else {
    w.terminate("workflow_timed_out");
  }
  await flush();
  expect(handler.registry.listActive(), `seed ${seed}: nothing active after stop`).toEqual([]);
  expect(handler.registry.stats.queued).toBe(0);

  // Late arrivals after the stop must change nothing.
  const recordedBefore = handler.children.length;
  for (const s of pendingSpawns.splice(0)) s.resolve({ runId: `late-${++runSeq}` });
  await flush();
  for (const [runId, done] of [...waiters]) {
    waiters.delete(runId);
    done({ runId, status: "completed", text: "late" });
  }
  await flush();
  expect(handler.children.length).toBe(recordedBefore);

  // Exactly one record per submitted call; at most one settle each.
  const recordedIds = handler.children.map((c) => c.callId);
  expect(new Set(recordedIds).size, `seed ${seed}: duplicate children[] records`).toBe(recordedIds.length);
  expect([...recordedIds].sort()).toEqual([...submitted].sort());
  const settleCounts = new Map<string, number>();
  for (const m of w.sent) {
    if (m.kind === "host_settle") settleCounts.set(String(m.callId), (settleCounts.get(String(m.callId)) ?? 0) + 1);
  }
  for (const [id, n] of settleCounts) expect(n, `seed ${seed}: call ${id} settled ${n}×`).toBe(1);

  // §5 event contract, per callId.
  const allowed = new Set([
    "settled", // immediate admission withheld while its spawn was in flight (stop / phase timeout)
    "spawned,settled",
    "queued,settled",
    "queued,spawned,settled",
    "queued,rejected,settled",
    "rejected,settled",
  ]);
  for (const id of submitted) {
    const seq = events
      .filter((e) => e.callId === id)
      .map((e) => e.kind)
      .join(",");
    expect(allowed.has(seq), `seed ${seed}: call ${id} events ${seq}`).toBe(true);
  }

  // FIFO: spawn() calls happen in submission order.
  for (let i = 1; i < spawnOrder.length; i += 1) {
    expect(spawnOrder[i]!, `seed ${seed}: spawn order ${spawnOrder.join(",")}`).toBeGreaterThan(spawnOrder[i - 1]!);
  }

  expect(clock.pendingTimers, `seed ${seed}: armed timers left`).toBe(0);
}

describe("host.ts FIFO queue: seeded properties (workflow-agent-queue §7)", () => {
  it("keeps the slot cap, FIFO dispatch, single-record/single-settle and clean-stop invariants across seeded interleavings", async () => {
    for (const seed of [1, 7, 42, 99, 1234, 4096, 31337, 0xc0ffee, 0xbeef, 2026]) {
      await runSeed(seed);
    }
  }, 30_000);
});
