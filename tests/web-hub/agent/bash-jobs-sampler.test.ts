/**
 * bash-jobs-panel plan §3.9 (包 A): `createBashJobsSampler` — fake timers, fake sources.
 * The ★-grade invariants: per-job 2s deadline, single-flight + catch-up rounds, per-job zombies
 * with hard slot release, footer race (R3-2), source generations (R3-3), retry/unavailable
 * latch, retention-driven cache pruning, stop() discard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBashJobsSampler,
  type BashJobsSource,
  type BashJobsTailRead,
} from "../../../src/web-hub/agent/bash-jobs-sampler.js";
import { projectBashJobs } from "../../../src/web-hub/agent/bash-jobs.js";
import type { JobRecord } from "../../../src/bash/types.js";

const T0 = 1_000_000;

type Behavior =
  { kind: "ok"; text?: string; logBytes: number } | { kind: "fail" } | { kind: "hang" } | { kind: "defer" };

interface Harness {
  sampler: ReturnType<typeof createBashJobsSampler>;
  onChange: ReturnType<typeof vi.fn>;
  /** Installs a NEW source (fresh gen — a manager rebuild); the records array stays mutable. */
  setSource(records: JobRecord[]): BashJobsSource;
  /** Resolve the oldest pending `defer` read of a job (first-in-first-served). */
  resolve: (jobId: string, value: { text?: string; logBytes: number } | undefined) => boolean;
  calls: () => string[];
  callsFor: (jobId: string) => number;
  t: () => number;
  advance: (ms: number) => Promise<void>;
  flush: () => Promise<void>;
  live: (v: boolean) => void;
  retention: (ms: number) => void;
}

function job(jobId: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    v: 1,
    jobId,
    command: `echo ${jobId}`,
    cwd: "/w",
    sessionId: "s",
    hostPid: 1,
    status: "running",
    createdAt: T0,
    spawnedAt: T0,
    backgroundedAt: T0,
    exitCode: null,
    logPath: `/log/${jobId}.log`,
    logBytes: 100,
    outputTruncated: false,
    readCursor: 0,
    ...over,
  };
}

function terminalJob(jobId: string, over: Partial<JobRecord> = {}): JobRecord {
  return job(jobId, { status: "completed", endedAt: T0 - 1, exitCode: 0, ...over });
}

/** Scriptable tail port: per-job behaviors consumed in order; the LAST entry repeats. */
function harness(
  script: Record<string, Behavior[]>,
  over: Partial<Parameters<typeof createBashJobsSampler>[0]> = {},
): Harness {
  let t = T0;
  let live = true;
  let retentionMs = 0;
  const order: string[] = [];
  const counts = new Map<string, number>();
  const cursors = new Map<string, number>();
  const defers = new Map<string, Array<(v: BashJobsTailRead | undefined) => void>>();

  const behaviorFor = (jobId: string): Behavior | undefined => {
    const list = script[jobId];
    if (list === undefined || list.length === 0) return { kind: "ok", logBytes: 100 };
    const i = cursors.get(jobId) ?? 0;
    cursors.set(jobId, Math.min(i + 1, list.length - 1));
    return list[Math.min(i, list.length - 1)]!;
  };

  let current: BashJobsSource | undefined;
  const onChange = vi.fn();
  const sampler = createBashJobsSampler({
    source: () => current,
    retentionMs: () => retentionMs,
    now: () => t,
    isLive: () => live,
    onChange,
    ...over,
  });
  const advance = async (ms: number): Promise<void> => {
    t += ms;
    await vi.advanceTimersByTimeAsync(ms);
    // Sinon quirk: a 0ms timer scheduled INSIDE another timer's callback (the catch-up round)
    // is not fired by the ongoing advance, nor by advance(0) — only by a positive tick.
    for (let i = 0; i < 2; i++) {
      t += 1;
      await vi.advanceTimersByTimeAsync(1);
    }
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(0);
  };
  return {
    sampler,
    onChange,
    setSource: (records) => {
      const gen = { tag: Math.random().toString(36).slice(2) };
      current = {
        gen,
        list: () => records,
        tail: async (record) => {
          order.push(record.jobId);
          counts.set(record.jobId, (counts.get(record.jobId) ?? 0) + 1);
          const beh = behaviorFor(record.jobId);
          if (beh.kind === "fail") return undefined;
          if (beh.kind === "hang") return new Promise<never>(() => {});
          if (beh.kind === "defer") {
            return new Promise<BashJobsTailRead | undefined>((resolve) => {
              const q = defers.get(record.jobId) ?? [];
              q.push(resolve);
              defers.set(record.jobId, q);
            });
          }
          return { text: beh.text ?? `tail of ${record.jobId}`, logBytes: beh.logBytes };
        },
      };
      return current;
    },
    resolve: (jobId, value) => {
      const q = defers.get(jobId);
      const r = q?.shift();
      if (r === undefined) return false;
      r(value);
      return true;
    },
    calls: () => order.slice(),
    callsFor: (id) => counts.get(id) ?? 0,
    t: () => t,
    advance,
    flush,
    live: (v) => (live = v),
    retention: (ms) => (retentionMs = ms),
  };
}

/** Full projection of a snapshot through the sampler's cache — the tailCurrent oracle. */
function project(h: Harness, records: readonly JobRecord[], src: BashJobsSource) {
  return projectBashJobs(records, h.sampler.tails(src.gen), h.t(), 0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createBashJobsSampler — cadence & priority", () => {
  it("kick(ids) rows lead the round's read order", async () => {
    const records = [terminalJob("b_a"), terminalJob("b_b"), job("b_c", { createdAt: T0 - 5 })];
    const h = harness({
      b_a: [{ kind: "ok", logBytes: 100 }],
      b_b: [{ kind: "ok", logBytes: 100 }],
      b_c: [{ kind: "ok", logBytes: 100 }],
    });
    h.setSource(records);
    h.sampler.kick(["b_c"]);
    await h.flush();
    expect(h.calls()[0]).toBe("b_c");
    expect(h.calls().length).toBe(3);
  });

  it("a terminal row that became current is never re-read", async () => {
    const records = [terminalJob("b_t")];
    const h = harness({ b_t: [{ kind: "ok", logBytes: 100 }] });
    h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_t")).toBe(1);
    await h.advance(30_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_t")).toBe(1);
  });

  it("running rows refresh on the 10s cadence, not per tick", async () => {
    const records = [job("b_r")];
    const h = harness({ b_r: [{ kind: "ok", logBytes: 100 }] });
    h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_r")).toBe(1);
    for (let i = 0; i < 9; i++) {
      await h.advance(1_000);
      h.sampler.tick(h.t());
      await h.flush();
    }
    expect(h.callsFor("b_r")).toBe(1); // <10s since the sample ⇒ throttled
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_r")).toBe(2); // ≥10s ⇒ refreshed
  });
});

describe("createBashJobsSampler — R3-1 bounds", () => {
  it("20 selected rows (8 running + 12 terminal) discovered in one tick ⇒ ONE round reads all, all current ≤3s", async () => {
    const records: JobRecord[] = [];
    const script: Record<string, Behavior[]> = {};
    for (let i = 0; i < 8; i++) {
      const id = `b_r${String(i).padStart(2, "0")}`;
      records.push(job(id));
      script[id] = [{ kind: "ok", logBytes: 100 }];
    }
    for (let i = 0; i < 12; i++) {
      const id = `b_t${String(i).padStart(2, "0")}`;
      records.push(terminalJob(id));
      script[id] = [{ kind: "ok", logBytes: 100 }];
    }
    const h = harness(script);
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.calls().length).toBe(20); // perRound=20 covers the whole selection at once
    const wire = project(h, records, src)!;
    expect(wire.rows).toHaveLength(20);
    expect(wire.rows.every((r) => r.tailCurrent === true)).toBe(true);
  });

  it("a kick while a round is in flight ⇒ immediate catch-up round after it settles (≤5s)", async () => {
    const records: JobRecord[] = [terminalJob("b_wedge")];
    const h = harness({
      b_wedge: [{ kind: "hang" }],
      b_late: [{ kind: "ok", logBytes: 100 }],
    });
    h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.calls()).toEqual(["b_wedge"]); // round 1 in flight (wedged)

    // A new row appears mid-round and gets kicked.
    records.push(terminalJob("b_late"));
    h.sampler.kick(["b_late"]); // round in flight ⇒ remembered as one pending rerun
    await h.flush();
    expect(h.callsFor("b_late")).toBe(0); // single-flight: no second concurrent round

    await h.advance(2_000); // the wedge's 2s deadline settles the round…
    // …and the 0ms catch-up timer fires within the same advance: b_late is read immediately.
    expect(h.callsFor("b_late")).toBe(1);
  });

  it("1 wedged + 19 rows in one round ⇒ the 19 are current within the 2s deadline", async () => {
    const records: JobRecord[] = [];
    const script: Record<string, Behavior[]> = {};
    for (let i = 0; i < 8; i++) {
      const id = `b_r${String(i).padStart(2, "0")}`;
      records.push(job(id));
      script[id] = [{ kind: "ok", logBytes: 100 }];
    }
    for (let i = 0; i < 12; i++) {
      const id = `b_t${String(i).padStart(2, "0")}`;
      records.push(terminalJob(id));
      script[id] = [i === 0 ? { kind: "hang" } : { kind: "ok", logBytes: 100 }];
    }
    const h = harness(script);
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush(); // 19 reads land at once
    await h.advance(2_000); // the wedge deadlines: round settles
    const wire = project(h, records, src)!;
    expect(wire.rows.filter((r) => r.tailCurrent === true)).toHaveLength(19);
    expect(wire.rows.find((r) => r.id === "b_t00")!.tailCurrent).toBeUndefined();
    await h.advance(3_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_t00")).toBe(1); // zombie ⇒ stays out of new rounds while outstanding
  });

  it("4 wedged (<10s) reads stop NEW rounds; landing resumes and runs the pending rerun", async () => {
    const records: JobRecord[] = [];
    const script: Record<string, Behavior[]> = {};
    for (let i = 0; i < 4; i++) {
      const id = `b_z${i}`;
      records.push(terminalJob(id));
      script[id] = [{ kind: "defer" }, { kind: "ok", logBytes: 100 }];
    }
    const h = harness(script);
    h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    await h.advance(2_000); // 4 deadlines: 4 zombies, round settled
    expect(h.calls().length).toBe(4);

    records.push(terminalJob("b_new"));
    script["b_new"] = [{ kind: "ok", logBytes: 100 }];
    await h.advance(500);
    h.sampler.tick(h.t()); // 4 active (<10s) reads ⇒ round blocked, rerun pending
    await h.flush();
    expect(h.callsFor("b_new")).toBe(0);

    // The four reads land: zombie slots free, pending rerun consumed, b_new sampled.
    h.resolve("b_z0", { text: "late", logBytes: 100 });
    await h.flush();
    expect(h.callsFor("b_new")).toBe(1);
    h.resolve("b_z1", undefined);
    h.resolve("b_z2", undefined);
    h.resolve("b_z3", undefined);
    await h.flush();
  });
});

describe("createBashJobsSampler — R3-2 footer race", () => {
  it("running current → terminal patch(N)+file footer(N+k): not current, ≤1 read/tick, settle, patch(N+k) ⇒ footer tail + current", async () => {
    // Real finalizeLocal sequence: running → applyTransition(terminal, {logBytes:N}) → appendLogFooter
    // (file N+k) → applyPatch({logBytes:N+k}).
    const records = [job("b_f", { logBytes: 100 })];
    const h = harness({
      b_f: [
        { kind: "ok", logBytes: 100 }, // running-phase sample (no footer)
        { kind: "ok", logBytes: 110 }, // post-terminal read: file already carries the footer
        { kind: "ok", logBytes: 110 },
        { kind: "ok", logBytes: 110 },
        { kind: "ok", logBytes: 110 }, // post-patch read: current, footer in the tail
      ],
    });
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(project(h, records, src)!.rows[0]!.tailCurrent).toBe(true); // running ⇒ current

    // Terminal transition patches logBytes=100 (pre-footer value); the FILE already has 110.
    records[0] = job("b_f", { status: "completed", endedAt: h.t() + 1, exitCode: 0, logBytes: 100 });
    await h.advance(1_000);
    h.sampler.tick(h.t()); // tailAt < endedAt ⇒ re-read ⇒ sees 110 vs record 100
    await h.flush();
    let wire = project(h, records, src)!;
    expect(wire.rows[0]!.tailCurrent).toBeUndefined(); // footer pending ⇒ NOT current
    expect(wire.rows[0]!.tailBytes).toBe(110);

    // Mismatch phase: at most one read per tick.
    const afterFirst = h.callsFor("b_f");
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_f")).toBe(afterFirst + 1);
    let wire2 = project(h, records, src)!;
    expect(wire2.rows[0]!.tailCurrent).toBeUndefined(); // 2nd mismatch read: not settled yet
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_f")).toBe(afterFirst + 2);

    // Read 4 was the 3rd identical mismatching outcome: the row is settled — treated as
    // current, and reads stop (D3-2's anti-spin valve).
    wire = project(h, records, src)!;
    expect(wire.rows[0]!.tailCurrent).toBe(true); // settled ⇒ treated as current (D3-2)
    const settledCalls = h.callsFor("b_f");
    await h.advance(2_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_f")).toBe(settledCalls); // settled ⇒ no more reads

    // The record's logBytes patch lands (N+k): re-enqueued, re-read, footer visible, current.
    records[0] = { ...records[0]!, logBytes: 110 };
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_f")).toBe(settledCalls + 1);
    wire = project(h, records, src)!;
    expect(wire.rows[0]!.tailCurrent).toBe(true);
    expect(wire.rows[0]!.tailBytes).toBe(110);
    expect(wire.rows[0]!.tail).toContain("tail of b_f");
  });
});

describe("createBashJobsSampler — R3-3 source generations", () => {
  it("gen switch: next tick clears the cache, reads only the new manager; the old round's late landing is discarded", async () => {
    const aRecords = [terminalJob("b_a1")];
    const h = harness({
      b_a1: [{ kind: "defer" }], // A's read stays outstanding, then lands late
      b_b1: [{ kind: "ok", logBytes: 100 }],
    });
    h.setSource(aRecords);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.calls()).toEqual(["b_a1"]);

    // Manager rebuild (holder swap): a fresh source with a different gen and different rows. The
    // first tick after the switch reconciles (cache cleared, generation bumped, old round
    // dissolved) and reads ONLY B — the old generation never mixes in.
    const bRecords = [terminalJob("b_b1")];
    const srcB = h.setSource(bRecords);
    await h.advance(1_000);
    const changed = h.sampler.tick(h.t()); // gen reconcile: cache cleared, everything re-kicked
    expect(changed).toBe(true);
    await h.flush();
    expect(h.callsFor("b_b1")).toBe(1); // only B is read…
    expect(h.callsFor("b_a1")).toBe(1); // …no new A reads; the old round never mixed sources
    // NB: tails() with a STALE gen would itself reconcile — in production the projection
    // closure always passes the gen of the source it just read, so that cannot happen; here
    // the A-cache clearing is proven by B's own cache + wire (no a1 row, no a1 tail).
    const wireB = project(h, bRecords, srcB)!;
    expect(wireB.rows[0]!.id).toBe("b_b1");
    expect(wireB.rows[0]!.tailCurrent).toBe(true);

    // A's deferred read finally lands: discarded by generation — no onChange, no A cache entry.
    const onChangeBefore = h.onChange.mock.calls.length;
    const b1Reads = h.callsFor("b_b1");
    h.resolve("b_a1", { text: "stale A tail", logBytes: 100 });
    await h.flush();
    expect(h.onChange.mock.calls.length).toBe(onChangeBefore);
    expect(h.callsFor("b_b1")).toBe(b1Reads); // the rerun found nothing to do
    expect(h.sampler.tails(srcB.gen)!.has("b_a1")).toBe(false);
  });
});

describe("createBashJobsSampler — failure paths", () => {
  it("3 failed reads ⇒ tailUnavailable (never tailCurrent); the latch reopens when record.logBytes moves", async () => {
    const records = [terminalJob("b_u")];
    const h = harness({
      b_u: [{ kind: "fail" }, { kind: "fail" }, { kind: "fail" }, { kind: "ok", logBytes: 140 }],
    });
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_u")).toBe(3);
    let wire = project(h, records, src)!;
    expect(wire.rows[0]!.tailUnavailable).toBe(true);
    expect(wire.rows[0]!.tailCurrent).toBeUndefined();

    const latched = h.callsFor("b_u");
    await h.advance(3_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_u")).toBe(latched); // latched at this logBytes

    records[0] = { ...records[0]!, logBytes: 140 };
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_u")).toBe(latched + 1);
    wire = project(h, records, src)!;
    expect(wire.rows[0]!.tailUnavailable).toBeUndefined();
    expect(wire.rows[0]!.tailCurrent).toBe(true);
  });

  it("stop(): late results are discarded, nothing new is read", async () => {
    const records = [job("b_s")];
    const h = harness({ b_s: [{ kind: "ok", logBytes: 100 }] });
    h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.onChange).toHaveBeenCalled();
    h.onChange.mockClear();
    h.sampler.stop();
    const calls = h.calls().length;
    await h.advance(1_000);
    h.sampler.tick(h.t());
    h.sampler.kick();
    await h.flush();
    expect(h.calls().length).toBe(calls);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("not live ⇒ zero reads (ticks and kicks alike)", async () => {
    const records = [job("b_x")];
    const h = harness({ b_x: [{ kind: "ok", logBytes: 100 }] });
    h.setSource(records);
    h.live(false);
    h.sampler.tick(h.t());
    h.sampler.kick();
    await h.advance(5_000);
    await h.flush();
    expect(h.calls().length).toBe(0);
  });

  it("source() undefined ⇒ tick is a no-op returning false", async () => {
    const h = harness({});
    expect(h.sampler.tick(h.t())).toBe(false);
    await h.flush();
    expect(h.calls().length).toBe(0);
  });

  it("start() re-arms after a stop and samples again", async () => {
    const records = [job("b_s2")];
    const h = harness({ b_s2: [{ kind: "ok", logBytes: 100 }] });
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    h.sampler.stop();
    h.sampler.start();
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_s2")).toBe(2); // re-kicked and re-read
    expect(project(h, records, src)!.rows[0]!.tailCurrent).toBe(true);
  });

  it("a never-landing read's zombie entry is pruned once its job leaves the selection (no permanent wedge)", async () => {
    const records: JobRecord[] = [terminalJob("b_z")];
    const h = harness({ b_z: [{ kind: "hang" }, { kind: "ok", logBytes: 100 }] });
    const src = h.setSource(records);
    h.sampler.tick(h.t());
    await h.flush();
    await h.advance(2_000); // deadline fires: b_z is a zombie, round settled
    expect(h.callsFor("b_z")).toBe(1);

    // The job leaves the selection (retention expiry / cap rotation / manager list change):
    // the next tick prunes cache/failures/lastReadAt AND the stale zombie/read bookkeeping.
    records.length = 0;
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();

    // The job re-enters the selection before the wedged read ever lands: it MUST be
    // readable again — a surviving zombie entry would exclude it forever.
    records.push(terminalJob("b_z"));
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.callsFor("b_z")).toBe(2); // re-read despite the still-outstanding first read
    const wire = project(h, records, src)!;
    const row = wire.rows.find((r) => r.id === "b_z")!;
    expect(row.tailCurrent).toBe(true); // the second read landed and went current
  });

  it("retention expiry prunes the row's cache entry in the same tick it leaves the selection", async () => {
    const R = 60_000;
    const records = [job("b_e", { status: "completed", endedAt: T0, exitCode: 0, logBytes: 100 })];
    const h = harness({ b_e: [{ kind: "ok", logBytes: 100 }] });
    const src = h.setSource(records);
    h.retention(R);
    h.sampler.tick(h.t()); // endedAt === now ⇒ inside the window
    await h.flush();
    expect(h.sampler.tails(src.gen)!.size).toBe(1);
    await h.advance(R - 1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.sampler.tails(src.gen)!.size).toBe(1); // age R-1s ⇒ kept
    await h.advance(1_000);
    h.sampler.tick(h.t());
    await h.flush();
    expect(h.sampler.tails(src.gen)!.size).toBe(0); // expired: row and tail vanish together
  });
});
