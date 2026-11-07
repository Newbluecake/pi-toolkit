import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { flushMicrotasks, H1, H2, makeHarness, RUN_A, RUN_B, RUN_C, type Harness } from "./harness.js";
import type { ThreadEventInput } from "../../../src/fabric/thread/types.js";

/**
 * Seeded property tests for the ThreadEngine invariants the arch NAMES (§11.1 P1):
 *   1. 去重 — one EventRecord/fan-out per eventId; duplicates answer from the record;
 *   2. 至多一次回流 — the system auto-return fires at most once per event;
 *   3. 无 unknown 回流 — auto-return ONLY when every subscriber is `none`; in particular NEVER
 *      for an event whose steer was actually CALLED (any post-call outcome blocks it).
 * Plus the first-reply at-most-once invariant those rest on.
 *
 * Deterministic by construction: FakeClock + manually-settled steers + a fixed fc seed. The
 * steer payload IS the eventId, so sink arrays double as per-event call logs.
 */

const PROPERTY_SEED = 0x5eed_2026;

const THREADS = [H1, H2];
const RUNS = [RUN_A, RUN_B, RUN_C];
const DEADLINES = [1500, 1900, 2000, 8000, 12_000];

interface Op {
  k: number; // op selector
  a: number; // generic parameter (run/thread/event index…)
  b: number; // generic parameter (status/deadline/disposition…)
}

interface World {
  h: Harness;
  events: ThreadEventInput[]; // every event input ever built (dup source)
  laneCount: Map<string, number>;
  disposed: boolean;
  laneActions: number;
  deduped: number;
  subscribeDenies: Map<string, number>;
  subscribeOks: number;
}

/** Aggregated non-vacuity coverage across every generated run — asserted at the end so the
 *  invariants above are PROVEN to have exercised real lanes, steers, replies and auto-returns. */
interface Coverage {
  laneActions: number;
  deduped: number;
  steers: number;
  routed: number;
  native: number;
  autoReturns: number;
  staleCtx: number;
  display: number;
  audits: number;
}

async function runStream(ops: readonly Op[]): Promise<Coverage & { denies: Record<string, number>; oks: number }> {
  const h = makeHarness();
  const w: World = {
    h,
    events: [],
    laneCount: new Map(),
    disposed: false,
    laneActions: 0,
    deduped: 0,
    subscribeDenies: new Map(),
    subscribeOks: 0,
  };
  try {
    for (const [i, op] of ops.entries()) {
      await runOp(w, op, i, ops.length);
      checkInvariants(w);
    }
  } finally {
    h.engine.dispose(); // never leave timers behind
  }
  return {
    laneActions: w.laneActions,
    deduped: w.deduped,
    steers: h.steers.length,
    routed: h.routed.length,
    native: h.native.length,
    autoReturns: h.autoReturns.length,
    staleCtx: h.staleCtx.length,
    display: h.display.length,
    audits: h.audits.length,
    denies: Object.fromEntries(w.subscribeDenies),
    oks: w.subscribeOks,
  };
}

async function runOp(w: World, op: Op, index: number, total: number): Promise<void> {
  const h = w.h;
  const pick = <T>(arr: readonly T[], n: number): T => arr[n % arr.length]!;
  switch (op.k % 8) {
    case 0: {
      // note + subscribe (random run × thread); a run the world has never seen defaults to a
      // subscribable direct run (realistic: runs exist before anyone subscribes to them)
      const runId = pick(RUNS, op.a);
      const th = pick(THREADS, op.b);
      if (!h.facts.has(runId)) {
        h.facts.set(runId, {
          direct: true,
          status: pick(["queued", "starting", "running"] as const, op.b),
          steerable: true,
        });
      }
      h.engine.noteThread(th, `topic-${op.b}`);
      const res = h.engine.subscribe({ runId, h: th, label: `w${op.a}`, scope: "s", createdBy: "root" });
      if (res.ok) w.subscribeOks++;
      else w.subscribeDenies.set(res.reason, (w.subscribeDenies.get(res.reason) ?? 0) + 1);
      return;
    }
    case 1: {
      // event: fresh or duplicate of a past one; steer payload = eventId
      const base = w.events.length > 0 && op.b % 4 === 0 ? pick(w.events, op.a) : undefined;
      const seq = w.events.length + 1;
      const input: ThreadEventInput = {
        ...(base ?? {
          eventId: `fs${String(seq).padStart(30, "0")}`,
          h: pick(THREADS, op.a),
          label: "topic",
          sentAt: 0,
          trustedOrigin: true,
          hasThreadMeta: true,
          threadMetaValid: true,
          headerOk: true,
          bypass: false,
          addressedOther: false,
          frameDeadlineMs: 8000,
          text: "",
        }),
        frameDeadlineMs: pick(DEADLINES, op.b),
        bypass: op.a % 7 === 0,
        addressedOther: op.b % 11 === 0,
        text: base ? base.eventId : `fs${String(seq).padStart(30, "0")}`,
      };
      if (!base) input.eventId = input.text; // text === eventId (see header comment)
      w.events.push(input);
      const result = h.engine.handleEvent(input);
      if (result.action === "lane") {
        w.laneActions++;
        w.laneCount.set(input.eventId, (w.laneCount.get(input.eventId) ?? 0) + 1);
      } else if (result.action === "deduped") {
        w.deduped++;
      }
      return;
    }
    case 2: {
      // advance the clock (fires deadlines / backstops / TTLs) — bounded jumps cross windows
      h.clock.advance(op.a % 4 === 0 ? (op.b % 10) * 60_000 : op.a * 100 + op.b);
      await flushMicrotasks();
      return;
    }
    case 3: {
      // settle a pending steer: queued / handled / reject
      const idx = op.a % Math.max(1, h.steers.length);
      const steer = h.steers[idx];
      if (steer === undefined) return;
      if (op.b % 3 === 2) steer.reject(new Error("prop-reject"));
      else steer.resolve(op.b % 3 === 0 ? "queued" : "handled");
      await flushMicrotasks();
      return;
    }
    case 4: {
      // run snapshot: mutate facts then notify
      const runId = pick(RUNS, op.a);
      const status = pick(["queued", "starting", "running", "stopping", "completed", "failed"] as const, op.b);
      const direct = op.b % 5 !== 0;
      h.facts.set(runId, { direct, status, steerable: status === "running" && op.a % 3 !== 0 });
      h.engine.onRunSnapshot(runId, status);
      await flushMicrotasks();
      return;
    }
    case 5: {
      // unsubscribe a created sub (if any)
      const subs = h.engine.inspectSubscriptions().filter((s) => s.state === "active");
      const target = subs[op.a % Math.max(1, subs.length)];
      if (target) h.engine.unsubscribe(String(target.subId));
      return;
    }
    case 6: {
      // hub cap toggle mostly; thread close rarer (a closed thread stays closed — no resurrection)
      if (op.a % 4 === 0) h.engine.threadClosed(pick(THREADS, op.b), "unbound");
      else h.hubOnline.value = op.b % 4 !== 0;
      return;
    }
    default: {
      // dispose — only in the tail of the stream (an early dispose kills the world wholesale);
      // later calls are no-ops by the engine's absorbing guard
      if (!w.disposed && index >= total - 5) {
        w.disposed = true;
        h.engine.dispose();
        await flushMicrotasks();
      }
      return;
    }
  }
}

function checkInvariants(w: World): void {
  const h = w.h;
  // 1. 去重 — the fast path starts at most ONE fan-out per eventId
  for (const [eventId, n] of w.laneCount) {
    expect(n, `lane entries for ${eventId}`).toBeLessThanOrEqual(1);
    // every steer call for that event belongs to its single fan-out (≤ #runs)
    const steerCalls = h.steers.filter((s) => s.text === eventId).length;
    expect(steerCalls, `steer calls for ${eventId}`).toBeLessThanOrEqual(RUNS.length);
  }
  // first reply at most once per event (routed / native / stale combined)
  const replyCounts = new Map<string, number>();
  for (const r of h.routed) replyCounts.set(r.eventId, (replyCounts.get(r.eventId) ?? 0) + 1);
  for (const id of h.native) replyCounts.set(id, (replyCounts.get(id) ?? 0) + 1);
  for (const id of h.staleCtx) replyCounts.set(id, (replyCounts.get(id) ?? 0) + 1);
  for (const [eventId, n] of replyCounts) expect(n, `replies for ${eventId}`).toBeLessThanOrEqual(1);

  // 2. 至多一次回流 — per event AND globally consistent with the counter
  const perEvent = new Map<string, number>();
  for (const a of h.autoReturns) perEvent.set(a.eventId, (perEvent.get(a.eventId) ?? 0) + 1);
  for (const [eventId, n] of perEvent) expect(n, `auto-returns for ${eventId}`).toBeLessThanOrEqual(1);
  expect(h.autoReturns.length).toBe(h.engine.stats().autoReturned);

  // 3. 无 unknown 回流 — every auto-return: all outcomes `none`, and NO steer was ever CALLED
  //    for that event (a called steer ⇒ queued|unknown ⇒ blocked, §6.4/§6.7).
  for (const a of h.autoReturns) {
    expect(a.outcomesSnapshot.length, `auto-return ${a.eventId} had subscribers`).toBeGreaterThan(0);
    for (const o of a.outcomesSnapshot) expect(o, `auto-return ${a.eventId} outcome`).toBe("none");
    expect(
      h.steers.some((s) => s.text === a.eventId),
      `auto-return ${a.eventId} after a real steer call`,
    ).toBe(false);
    const record = h.engine.inspectRecord(a.eventId);
    if (record) {
      expect(record.judged).toBe(true);
      expect(record.replyKind).toBe("routed");
      expect(record.replied).toBe(true);
      expect(record.autoReturned).toBe(true);
    }
  }
}

function mergeCoverage(
  a: (Coverage & { denies: Record<string, number>; oks: number }) | undefined,
  b: Coverage & { denies: Record<string, number>; oks: number },
): Coverage & { denies: Record<string, number>; oks: number } {
  if (!a) return b;
  const denies = { ...a.denies };
  for (const [k, v] of Object.entries(b.denies)) denies[k] = (denies[k] ?? 0) + v;
  return {
    laneActions: a.laneActions + b.laneActions,
    deduped: a.deduped + b.deduped,
    steers: a.steers + b.steers,
    routed: a.routed + b.routed,
    native: a.native + b.native,
    autoReturns: a.autoReturns + b.autoReturns,
    staleCtx: a.staleCtx + b.staleCtx,
    display: a.display + b.display,
    audits: a.audits + b.audits,
    denies,
    oks: a.oks + b.oks,
  };
}

describe("ThreadEngine seeded property invariants (§11.1 P1)", () => {
  it("dedup · at-most-once auto-return · no auto-return over called steers — random op streams", async () => {
    const opArbitrary = fc.record({
      k: fc.integer({ min: 0, max: 7 }),
      a: fc.integer({ min: 0, max: 97 }),
      b: fc.integer({ min: 0, max: 89 }),
    });
    let coverage: (Coverage & { denies: Record<string, number>; oks: number }) | undefined;
    await fc.assert(
      fc.asyncProperty(fc.array(opArbitrary, { minLength: 40, maxLength: 160 }), async (ops) => {
        coverage = mergeCoverage(coverage, await runStream(ops));
      }),
      { seed: PROPERTY_SEED, numRuns: 120, endOnFailure: true },
    );
    // Non-vacuity floors (seeded ⇒ deterministic): the invariants above saw REAL traffic.
    const c = coverage!;
    expect(c.laneActions, "lanes entered").toBeGreaterThanOrEqual(50);
    expect(c.steers, "steer calls").toBeGreaterThanOrEqual(15);
    expect(c.routed, "routed replies").toBeGreaterThanOrEqual(30);
    expect(c.native, "native releases").toBeGreaterThanOrEqual(15);
    expect(c.autoReturns, "system auto-returns").toBeGreaterThanOrEqual(10);
    expect(c.deduped, "deduped arrivals").toBeGreaterThanOrEqual(3);
    expect(c.staleCtx, "dispose stale replies").toBeGreaterThanOrEqual(1);
    expect(c.display, "visibility lines").toBeGreaterThanOrEqual(1);
  });

  it("the seeded stream is deterministic (same seed ⇒ identical sink fingerprints)", async () => {
    const runOnce = async (): Promise<string> => {
      const h = makeHarness();
      const w: World = {
        h,
        events: [],
        laneCount: new Map(),
        disposed: false,
        laneActions: 0,
        deduped: 0,
        subscribeDenies: new Map(),
        subscribeOks: 0,
      };
      // a FIXED op stream derived from the same arbitrary shape — replay twice, compare
      const ops: Op[] = [];
      let state = PROPERTY_SEED >>> 0;
      for (let i = 0; i < 120; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        ops.push({ k: (state >>> 8) % 8, a: (state >>> 4) % 97, b: state % 89 });
      }
      for (const [i, op] of ops.entries()) await runOp(w, op, i, ops.length);
      h.engine.dispose();
      const fingerprint = JSON.stringify({
        routed: h.routed.map((r) => [r.eventId, r.runs.length]),
        native: h.native,
        stale: h.staleCtx,
        auto: h.autoReturns.map((a) => a.eventId),
        stats: h.engine.stats(),
      });
      return fingerprint;
    };
    expect(await runOnce()).toBe(await runOnce());
  });
});
