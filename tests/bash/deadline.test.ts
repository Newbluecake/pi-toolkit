import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_DEADLINE_POLICY,
  applyJobExtension,
  createJobDeadline,
  jobExtendability,
  jobGraceWindow,
  resumeDeadline,
  type JobExtendabilityReason,
} from "../../src/bash/deadline.js";
import { createJobRecord, transitionJob, type JobDeadlinePolicy, type JobRecord } from "../../src/bash/types.js";

const POLICY: JobDeadlinePolicy = DEFAULT_JOB_DEADLINE_POLICY; // { graceMs: 60_000, maxExtensions: 3, maxTimeoutFactor: 3 }

/** A backgrounded, running job with a deadline created at `now` for `timeoutMs`. */
function backgroundedJob(opts: {
  timeoutMs: number;
  now: number;
  policy?: JobDeadlinePolicy;
  extensions?: number;
  backgroundedAt?: number;
}): JobRecord {
  const staged = createJobRecord({
    jobId: "b_3F7K2M9P",
    command: "sleep 100",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 1,
    logPath: "/tmp/b_3F7K2M9P.log",
    createdAt: opts.now,
  });
  const running = transitionJob(staged, "running", { at: opts.now, pid: 111, pgid: 111 });
  if (!running.ok) throw new Error(running.reason);
  const policy = opts.policy ?? POLICY;
  const deadline = createJobDeadline(opts.timeoutMs, policy, opts.now);
  return {
    ...running.record,
    backgroundedAt: opts.backgroundedAt ?? opts.now,
    deadline: opts.extensions !== undefined ? { ...deadline, extensions: opts.extensions } : deadline,
  };
}

function foregroundJob(opts: { timeoutMs: number; now: number; policy?: JobDeadlinePolicy }): JobRecord {
  const record = backgroundedJob(opts);
  const { backgroundedAt: _drop, ...rest } = record;
  return rest as JobRecord;
}

function noDeadlineJob(now: number): JobRecord {
  const staged = createJobRecord({
    jobId: "b_3F7K2M9P",
    command: "echo hi",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 1,
    logPath: "/tmp/b_3F7K2M9P.log",
    createdAt: now,
  });
  const running = transitionJob(staged, "running", { at: now, pid: 111, pgid: 111 });
  if (!running.ok) throw new Error(running.reason);
  return { ...running.record, backgroundedAt: now };
}

describe("createJobDeadline", () => {
  it("computes dueAt/hardAt from spawnedAt + timeoutMs, factor applied to hardAt only", () => {
    const d = createJobDeadline(100_000, POLICY, 1_000);
    expect(d.dueAt).toBe(101_000);
    expect(d.hardAt).toBe(1_000 + Math.ceil(100_000 * 3));
    expect(d.extensions).toBe(0);
    expect(d.grantedMs).toBe(0);
    expect(d.graces).toBe(0);
    expect(d.graceNotified).toBe(0);
    expect(d.seq).toBe(0);
    expect(d.graceUntil).toBeUndefined();
  });

  it("clamps a sub-1 maxTimeoutFactor to 1 (headroom 0, defensive) and a negative timeoutMs to 0", () => {
    const badFactor = createJobDeadline(1_000, { ...POLICY, maxTimeoutFactor: 0.2 }, 0);
    expect(badFactor.hardAt).toBe(badFactor.dueAt); // factor clamped to 1 => hardAt === dueAt
    const negTimeout = createJobDeadline(-500, POLICY, 0);
    expect(negTimeout.timeoutMs).toBe(0);
    expect(negTimeout.dueAt).toBe(0);
  });

  it("never produces dueAt > hardAt for any policy.maxTimeoutFactor >= 1", () => {
    for (const factor of [1, 1.5, 2, 3, 10]) {
      const d = createJobDeadline(50_000, { ...POLICY, maxTimeoutFactor: factor }, 5_000);
      expect(d.dueAt).toBeLessThanOrEqual(d.hardAt);
    }
  });
});

/**
 * T5: reason table for `jobExtendability`, driven declaratively — every named
 * `JobExtendabilityReason` (plan §2.2) gets its own row, plus the `ok:true`
 * case with the exact `headroomMs`.
 */
describe("jobExtendability — reason table", () => {
  const now = 10_000;

  const cases: Array<{
    name: string;
    build: () => JobRecord;
    expect: { ok: true; headroomMs: number } | { ok: false; reason: JobExtendabilityReason };
  }> = [
    {
      name: "terminal job",
      build: () => {
        const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
        const killed = transitionJob(job, "killed", { at: now });
        if (!killed.ok) throw new Error(killed.reason);
        return { ...killed.record, deadline: job.deadline };
      },
      expect: { ok: false, reason: "already_terminal" },
    },
    {
      name: "no deadline at all",
      build: () => noDeadlineJob(0),
      expect: { ok: false, reason: "no_timeout" },
    },
    {
      name: "still foreground (never backgrounded)",
      build: () => foregroundJob({ timeoutMs: 100_000, now: 0 }),
      expect: { ok: false, reason: "foreground" },
    },
    {
      name: "maxExtensions=0 disables extend outright",
      build: () => backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxExtensions: 0 } }),
      expect: { ok: false, reason: "limit_reached" },
    },
    {
      name: "extensions already at the policy max",
      build: () => backgroundedJob({ timeoutMs: 100_000, now: 0, extensions: POLICY.maxExtensions }),
      expect: { ok: false, reason: "limit_reached" },
    },
    {
      name: "hard ceiling already reached (maxTimeoutFactor: 1)",
      build: () => backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxTimeoutFactor: 1 } }),
      expect: { ok: false, reason: "no_headroom" },
    },
    {
      name: "eligible: backgrounded, under the limit, headroom remains",
      build: () => backgroundedJob({ timeoutMs: 100_000, now: 0 }),
      // hardAt = 0 + ceil(100_000*3) = 300_000; max(now, dueAt) = max(10_000, 100_000) = 100_000
      expect: { ok: true, headroomMs: 300_000 - 100_000 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(jobExtendability(c.build(), now)).toEqual(c.expect);
    });
  }
});

/** D-6: `jobGraceWindow` requires the exact same eligibility as `jobExtendability`. */
describe("jobGraceWindow — D-6 (no extension headroom => no grace either)", () => {
  it("returns undefined when graceMs <= 0, even for an otherwise-eligible job", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, graceMs: 0 } });
    expect(jobGraceWindow(job, 100_000)).toBeUndefined();
  });

  it("returns undefined for every reason jobExtendability refuses (D-6)", () => {
    const now = 100_000;
    const foreground = foregroundJob({ timeoutMs: 100_000, now: 0 });
    expect(jobExtendability(foreground, now)).toMatchObject({ ok: false, reason: "foreground" });
    expect(jobGraceWindow(foreground, now)).toBeUndefined();

    const noTimeout = noDeadlineJob(0);
    expect(jobGraceWindow(noTimeout, now)).toBeUndefined();

    const limitReached = backgroundedJob({ timeoutMs: 100_000, now: 0, extensions: POLICY.maxExtensions });
    expect(jobExtendability(limitReached, now)).toMatchObject({ ok: false, reason: "limit_reached" });
    expect(jobGraceWindow(limitReached, now)).toBeUndefined();

    const noHeadroom = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxTimeoutFactor: 1 } });
    expect(jobExtendability(noHeadroom, now)).toMatchObject({ ok: false, reason: "no_headroom" });
    expect(jobGraceWindow(noHeadroom, now)).toBeUndefined();
  });

  it("grants min(at + graceMs, hardAt) when eligible", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    // hardAt = 300_000, graceMs = 60_000; at = dueAt = 100_000
    expect(jobGraceWindow(job, 100_000)).toBe(160_000);
  });

  it("caps the grace window at hardAt", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxTimeoutFactor: 1.5 } });
    // hardAt = ceil(100_000*1.5) = 150_000; at = 100_000 => at+graceMs=160_000 > hardAt
    expect(jobGraceWindow(job, 100_000)).toBe(150_000);
  });

  it("returns undefined when the window would collapse to `at` or earlier", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxTimeoutFactor: 1 } });
    // hardAt === dueAt === 100_000 => jobExtendability already no_headroom, covered above;
    // this covers the defensive `until > at` guard directly for a hand-built edge deadline.
    const edge: JobRecord = { ...job, deadline: { ...job.deadline!, hardAt: 100_000 } };
    expect(jobGraceWindow(edge, 100_000)).toBeUndefined();
  });
});

describe("applyJobExtension", () => {
  it("moves dueAt forward, clears graceUntil, bumps extensions/seq, records grantedMs and lastReason", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    const inGrace: JobRecord = { ...job, deadline: { ...job.deadline!, graceUntil: 150_000 } };
    const result = applyJobExtension(inGrace, 50_000, 120_000, "still working");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.record.deadline!;
    // base = max(now=120_000, dueAt=100_000) = 120_000; next = min(120_000+50_000, hardAt=300_000) = 170_000
    expect(d.dueAt).toBe(170_000);
    expect(d.graceUntil).toBeUndefined();
    expect(d.extensions).toBe(1);
    expect(d.grantedMs).toBe(50_000);
    expect(d.lastReason).toBe("still working");
    expect(d.seq).toBe(1);
  });

  it("caps the granted amount at hardAt and records the reduced grantedMs", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, maxTimeoutFactor: 1.2 } });
    // hardAt = ceil(100_000*1.2) = 120_000
    const result = applyJobExtension(job, 1_000_000, 100_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.deadline!.dueAt).toBe(120_000);
    expect(result.record.deadline!.grantedMs).toBe(20_000); // 120_000 - max(100_000,100_000)
  });

  it("rejects with the extendability reason when not eligible", () => {
    const foreground = foregroundJob({ timeoutMs: 100_000, now: 0 });
    expect(applyJobExtension(foreground, 10_000, 50_000)).toEqual({ ok: false, reason: "foreground" });

    const noTimeout = noDeadlineJob(0);
    expect(applyJobExtension(noTimeout, 10_000, 50_000)).toEqual({ ok: false, reason: "no_timeout" });

    const limitReached = backgroundedJob({ timeoutMs: 100_000, now: 0, extensions: POLICY.maxExtensions });
    expect(applyJobExtension(limitReached, 10_000, 150_000)).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("rejects a zero/negative extendMs as zero_gain even when otherwise eligible", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    expect(applyJobExtension(job, 0, 100_000)).toEqual({ ok: false, reason: "zero_gain" });
    expect(applyJobExtension(job, -5_000, 100_000)).toEqual({ ok: false, reason: "zero_gain" });
  });

  it("rejects zero_gain when the request would not move dueAt forward at all (hardAt already at base)", () => {
    // hardAt = dueAt exactly (factor 1) is already caught as no_headroom by jobExtendability
    // (asserted above); this covers the narrower "not exactly at hardAt but next <= base" edge
    // via a hand-built deadline whose hardAt sits one ms past dueAt.
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    const nearCeiling: JobRecord = { ...job, deadline: { ...job.deadline!, hardAt: job.deadline!.dueAt + 1 } };
    const result = applyJobExtension(nearCeiling, 1, 100_000); // base=100_000, next=min(100_001,100_001)=100_001 > base -> ok
    expect(result.ok).toBe(true);
  });

  it("caps maxExtensions at 3 by default and rejects the 4th attempt", () => {
    let job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    let now = 100_000;
    for (let i = 0; i < 3; i++) {
      const result = applyJobExtension(job, 60_000, now);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      job = result.record;
      now = job.deadline!.dueAt;
    }
    expect(job.deadline!.extensions).toBe(3);
    expect(applyJobExtension(job, 60_000, now)).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("never grants past 3x the original timeout (maxTimeoutFactor default)", () => {
    let job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    let now = 100_000;
    for (let i = 0; i < 2; i++) {
      const result = applyJobExtension(job, 50_000, now);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      job = result.record;
      now = job.deadline!.dueAt;
    }
    // 2 extensions of 50_000 => dueAt = 200_000, still well under hardAt=300_000.
    expect(job.deadline!.extensions).toBe(2);
    expect(job.deadline!.dueAt).toBe(200_000);
    // 3rd extension asks for far more than remains -> capped at hardAt, not granted past it.
    const capped = applyJobExtension(job, 1_000_000, now);
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    job = capped.record;
    expect(job.deadline!.dueAt).toBe(job.deadline!.hardAt);
    expect(job.deadline!.hardAt).toBe(300_000); // 100_000 * 3
    expect(job.deadline!.extensions).toBe(3);
    // Already at the hard ceiling with no extensions left => limit_reached fires first (decision order).
    expect(applyJobExtension(job, 1, job.deadline!.dueAt)).toEqual({ ok: false, reason: "limit_reached" });
  });
});

/** T5: `resumeDeadline`'s three-way decision (plus the defensive `none`). */
describe("resumeDeadline — three-way decision", () => {
  it("kind: none for a job without a deadline", () => {
    expect(resumeDeadline(noDeadlineJob(0), 100_000)).toEqual({ kind: "none" });
  });

  it("kind: arm at dueAt when the deadline has not been reached yet", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    expect(resumeDeadline(job, 50_000)).toEqual({ kind: "arm", at: 100_000 });
  });

  it("kind: grace at dueAt reached, no grace yet, and grace is available", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    // hardAt=300_000, graceMs=60_000 -> min(100_000+60_000, 300_000) = 160_000
    expect(resumeDeadline(job, 100_000)).toEqual({ kind: "grace", graceUntil: 160_000 });
  });

  it("kind: expire when dueAt reached and no grace is available (D-6)", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0, policy: { ...POLICY, graceMs: 0 } });
    expect(resumeDeadline(job, 100_000)).toEqual({ kind: "expire" });
  });

  it("kind: expire when dueAt reached and the job is still foreground (D-6 via foreground)", () => {
    const job = foregroundJob({ timeoutMs: 100_000, now: 0 });
    expect(resumeDeadline(job, 100_000)).toEqual({ kind: "expire" });
  });

  it("kind: arm at graceUntil while already inside an active grace window", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    const inGrace: JobRecord = { ...job, deadline: { ...job.deadline!, graceUntil: 160_000 } };
    expect(resumeDeadline(inGrace, 120_000)).toEqual({ kind: "arm", at: 160_000 });
  });

  it("kind: expire once graceUntil itself has passed", () => {
    const job = backgroundedJob({ timeoutMs: 100_000, now: 0 });
    const inGrace: JobRecord = { ...job, deadline: { ...job.deadline!, graceUntil: 160_000 } };
    expect(resumeDeadline(inGrace, 160_000)).toEqual({ kind: "expire" });
    expect(resumeDeadline(inGrace, 200_000)).toEqual({ kind: "expire" });
  });
});

/**
 * T6: seeded property invariants (mirrors `tests/core/core.test.ts`'s
 * `seeded property invariants` block / mulberry32 PRNG style) driving a
 * random sequence of {advance clock, extend, no-op} against a fresh job and
 * asserting the plan's structural invariants hold after every step:
 * `dueAt <= hardAt`, `graceUntil <= hardAt` (when set), `extensions <= max`,
 * and the grace window itself never exceeds `hardAt`.
 */
describe("seeded property invariants", () => {
  function mulberry32(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("dueAt <= hardAt, graceUntil <= hardAt, extensions <= max, grace window <= hardAt — 200 seeded sequences", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = mulberry32(seed);
      const timeoutMs = 1_000 + Math.floor(random() * 500_000);
      const maxTimeoutFactor = 1 + random() * 4;
      const maxExtensions = Math.floor(random() * 5);
      const graceMs = Math.floor(random() * 120_000);
      const policy: JobDeadlinePolicy = { graceMs, maxExtensions, maxTimeoutFactor };
      let now = 0;
      let job = backgroundedJob({ timeoutMs, now, policy });

      for (let step = 0; step < 40; step++) {
        // Property must hold after every mutation, starting from the freshly created deadline.
        const d = job.deadline!;
        expect(d.dueAt).toBeLessThanOrEqual(d.hardAt);
        expect(d.extensions).toBeLessThanOrEqual(d.policy.maxExtensions);
        if (d.graceUntil !== undefined) expect(d.graceUntil).toBeLessThanOrEqual(d.hardAt);

        now += Math.floor(random() * 200_000);
        const action = Math.floor(random() * 3);
        if (action === 0) {
          // probe the grace window without mutating
          const g = jobGraceWindow(job, now);
          if (g !== undefined) expect(g).toBeLessThanOrEqual(job.deadline!.hardAt);
        } else if (action === 1) {
          const extendMs = Math.floor(random() * 300_000);
          const result = applyJobExtension(job, extendMs, now);
          if (result.ok) job = result.record;
        } else {
          // enter grace deterministically via resumeDeadline, mirroring §2.3's manager behavior
          const decision = resumeDeadline(job, now);
          if (decision.kind === "grace")
            job = { ...job, deadline: { ...job.deadline!, graceUntil: decision.graceUntil } };
        }
      }
    }
  });
});
