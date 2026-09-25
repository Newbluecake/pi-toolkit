import { describe, expect, it } from "vitest";
import {
  createWorkflowDeadlineController,
  type WorkflowDeadlineController,
  type WorkflowDeadlinePolicy,
} from "../../src/workflow/deadline.js";

/**
 * workflow-agent-queue plan §4.2 / §7 stage B: the pure workflow deadline
 * controller. Transition table {soft deadline fires, grace deadline fires,
 * extend} × {budget left, no budget, explicit timeout_s, closed} plus seeded
 * property invariants (softAt monotone, killAt ∈ [softAt, hardAt], bounded
 * WT8 re-arms).
 */

const T0 = 1_000;
const DEFAULT: WorkflowDeadlinePolicy = { totalMs: 60_000, totalGraceMs: 10_000, maxExtensions: 2, maxTotalFactor: 2 };

function make(policy: Partial<WorkflowDeadlinePolicy> = {}): WorkflowDeadlineController {
  return createWorkflowDeadlineController("wf_t", T0, { ...DEFAULT, ...policy });
}

type Ctx = "budget" | "no_budget" | "explicit" | "closed";

/** Build a controller in the named context, positioned at its soft deadline (not yet fired). */
function inContext(ctx: Ctx): WorkflowDeadlineController {
  switch (ctx) {
    case "budget":
      return make();
    case "no_budget": {
      // extensions exhausted: two extensions used up front.
      const c = make();
      expect(c.extend(T0, 1_000).ok).toBe(true);
      expect(c.extend(T0, 1_000).ok).toBe(true);
      return c;
    }
    case "explicit":
      return make({ maxTotalFactor: 1 });
    case "closed": {
      const c = make();
      c.close();
      return c;
    }
  }
}

describe("workflow deadline controller: initial state", () => {
  it("softAt = start + total, hardAt = start + ceil(total × factor), nextTimerAt = softAt", () => {
    const c = make({ totalMs: 1_001, maxTotalFactor: 1.5 });
    const s = c.state();
    expect(s.softAt).toBe(T0 + 1_001);
    expect(s.hardAt).toBe(T0 + Math.ceil(1_001 * 1.5));
    expect(s.graceUntil).toBeUndefined();
    expect(c.nextTimerAt()).toBe(s.softAt);
    expect(s).toMatchObject({ extensions: 0, grantedMs: 0, graces: 0, closed: false, stopping: false });
  });

  it("a factor below 1 is treated as 1 (hardAt never precedes softAt)", () => {
    const s = make({ maxTotalFactor: 0.5 }).state();
    expect(s.hardAt).toBe(s.softAt);
  });

  it("killAt before the soft deadline previews the grace window the workflow will get", () => {
    expect(make().killAt(T0)).toBe(T0 + 60_000 + 10_000);
    expect(make({ totalGraceMs: 0 }).killAt(T0)).toBe(T0 + 60_000);
    expect(make({ maxTotalFactor: 1 }).killAt(T0)).toBe(T0 + 60_000);
    expect(make({ maxExtensions: 0 }).killAt(T0)).toBe(T0 + 60_000);
    // grace clamped by the hard ceiling (D-7).
    expect(make({ totalGraceMs: 500_000 }).killAt(T0)).toBe(T0 + 120_000);
  });
});

describe("workflow deadline controller: transition table", () => {
  const soft = T0 + 60_000;

  it.each<[Ctx, "grace" | "expire"]>([
    ["budget", "grace"],
    ["no_budget", "expire"],
    ["explicit", "expire"],
    ["closed", "expire"],
  ])("soft deadline fires × %s → %s", (ctx, expected) => {
    const c = inContext(ctx);
    const at = c.state().softAt;
    const r = c.onTimer(at);
    expect(r.kind).toBe(expected);
    if (r.kind === "grace") {
      expect(r.until).toBe(at + 10_000);
      expect(c.state().graceUntil).toBe(r.until);
      expect(c.state().graces).toBe(1);
      expect(c.nextTimerAt()).toBe(r.until);
      expect(c.killAt(at)).toBe(r.until);
    } else {
      expect(c.state().graceUntil).toBeUndefined();
      expect(c.state().graces).toBe(0);
    }
  });

  it.each<[Ctx]>([["budget"], ["no_budget"], ["explicit"], ["closed"]])("grace deadline fires × %s → expire", (ctx) => {
    // Only a controller that actually entered grace can have its grace timer fire.
    const c = ctx === "budget" ? make() : inContext(ctx);
    const first = c.onTimer(c.state().softAt);
    if (first.kind === "grace") {
      expect(c.onTimer(first.until)).toEqual({ kind: "expire" });
    } else {
      expect(first.kind).toBe("expire"); // the other contexts never reach a grace window.
    }
  });

  it("extend × budget (before the soft deadline): pushes softAt, not a rescue", () => {
    const c = make();
    const r = c.extend(T0 + 10_000, 30_000);
    expect(r).toEqual({
      ok: true,
      workflowId: "wf_t",
      previousDeadlineAt: soft,
      deadlineAt: soft + 30_000,
      requestedMs: 30_000,
      grantedMs: 30_000,
      clamped: false,
      extensionsUsed: 1,
      extensionsRemaining: 1,
      hardDeadlineAt: T0 + 120_000,
      rescuedFromGrace: false,
    });
    expect(c.nextTimerAt()).toBe(soft + 30_000);
  });

  it("extend × budget (inside grace): rescue, based on max(now, softAt), grace cleared", () => {
    const c = make();
    const g = c.onTimer(soft);
    expect(g.kind).toBe("grace");
    const now = soft + 4_000;
    const r = c.extend(now, 20_000);
    expect(r.ok && r.rescuedFromGrace).toBe(true);
    expect(r.ok && r.deadlineAt).toBe(now + 20_000);
    expect(c.state().graceUntil).toBeUndefined();
    expect(c.nextTimerAt()).toBe(now + 20_000);
    // Crossing the soft deadline again with budget left re-enters grace.
    const again = c.onTimer(now + 20_000);
    expect(again.kind).toBe("grace");
    expect(c.state().graces).toBe(2);
  });

  it("extend is clamped by the hard ceiling and reports it", () => {
    const c = make();
    const r = c.extend(T0, 10 * 60_000);
    expect(r).toMatchObject({ ok: true, deadlineAt: T0 + 120_000, grantedMs: 60_000, clamped: true });
    // Now at the ceiling: no headroom left.
    expect(c.extend(T0, 1_000)).toEqual({ ok: false, reason: "no_headroom" });
    // And no grace at the (now hard) soft deadline.
    expect(c.onTimer(T0 + 120_000)).toEqual({ kind: "expire" });
  });

  it.each<[Ctx, string]>([
    ["no_budget", "limit_reached"],
    ["explicit", "no_headroom"],
    ["closed", "already_terminal"],
  ])("extend × %s → %s (state unchanged)", (ctx, reason) => {
    const c = inContext(ctx);
    const before = c.state();
    expect(c.extend(T0 + 5_000, 30_000)).toEqual({ ok: false, reason });
    expect(c.state()).toEqual(before);
  });

  it("markStopping refuses extension with `stopping` and withholds grace", () => {
    const c = make();
    c.markStopping();
    expect(c.extend(T0, 1_000)).toEqual({ ok: false, reason: "stopping" });
    expect(c.onTimer(soft)).toEqual({ kind: "expire" });
  });

  it("close() after entering grace: extend refused (review v2 #5), the pending grace timer expires", () => {
    const c = make();
    const g = c.onTimer(soft);
    expect(g.kind).toBe("grace");
    c.close();
    expect(c.closed).toBe(true);
    expect(c.extend(soft + 1, 1_000)).toEqual({ ok: false, reason: "already_terminal" });
    expect(c.onTimer(soft + 1)).toEqual({ kind: "expire" });
  });

  it("a timer that fires early is answered with `wait` (defensive re-arm, no state change)", () => {
    const c = make();
    expect(c.onTimer(T0)).toEqual({ kind: "wait", at: soft });
    const g = c.onTimer(soft);
    expect(g.kind).toBe("grace");
    expect(c.onTimer(soft + 1)).toEqual({ kind: "wait", at: soft + 10_000 });
    expect(c.state().graces).toBe(1);
  });

  it("grace window is clamped by the hard ceiling (D-7)", () => {
    const c = make({ totalGraceMs: 10_000 });
    // extend right up to 5s below the ceiling, then let it fire.
    expect(c.extend(T0, 55_000).ok).toBe(true);
    const r = c.onTimer(T0 + 115_000);
    expect(r).toEqual({ kind: "grace", until: T0 + 120_000 });
  });
});

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

describe("workflow deadline controller: seeded properties", () => {
  it("softAt monotone, killAt ∈ [softAt, hardAt], hardAt constant, WT8 arms ≤ 1 + 2 × maxExtensions, extend after close always refused", () => {
    let expiredRuns = 0;
    let rescuedRuns = 0;
    let graceRuns = 0;
    let hardCapRuns = 0;
    for (const seed of [1, 2, 3, 7, 42, 99, 1234, 4096, 31337, 0xc0ffee, 0xbeef, 2026]) {
      const next = random(seed);
      const policy: WorkflowDeadlinePolicy = {
        totalMs: 1_000 + Math.floor(next() * 50_000),
        totalGraceMs: next() < 0.2 ? 0 : 1_000 + Math.floor(next() * 20_000),
        maxExtensions: Math.floor(next() * 5),
        maxTotalFactor: next() < 0.2 ? 1 : 1.2 + next() * 3,
      };
      const c = createWorkflowDeadlineController("wf_p", 0, policy);
      const hardAt = c.state().hardAt;
      if (hardAt === c.state().softAt) hardCapRuns += 1;
      let now = 0;
      let prevSoft = c.state().softAt;
      let arms = 1; // the initial WT8 arm
      let expired = false;
      for (let step = 0; step < 200 && !expired; step += 1) {
        // Bias extensions towards grace windows (rescues) so the walk exercises both extend flavours.
        const inGrace = c.state().graceUntil !== undefined;
        const r = inGrace
          ? next() < 0.6
            ? 0.6
            : next() * 0.5
          : next() < 0.15
            ? 0.6
            : next() < 0.8
              ? next() * 0.5
              : 0.9;
        if (r < 0.5) {
          // Advance to (or past) the next timer, then fire it — the orchestrator's WT8 path.
          now = Math.max(now, c.nextTimerAt()) + (next() < 0.2 ? Math.floor(next() * 100) : 0);
          const t = c.onTimer(now);
          if (t.kind === "expire") expired = true;
          else arms += 1; // grace (or defensive wait) re-arms
          if (t.kind === "grace") graceRuns += 1;
        } else if (r < 0.85) {
          now += Math.floor(next() * 5_000);
          const out = c.extend(now, Math.floor(next() * 40_000));
          if (out.ok) {
            arms += 1;
            if (out.rescuedFromGrace) rescuedRuns += 1;
            expect(out.deadlineAt).toBeLessThanOrEqual(hardAt);
            expect(out.grantedMs).toBeGreaterThanOrEqual(0);
            expect(out.grantedMs).toBeLessThanOrEqual(out.requestedMs);
          }
        } else {
          now += Math.floor(next() * 3_000);
        }
        const s = c.state();
        expect(s.hardAt, `seed ${seed}: hardAt constant`).toBe(hardAt);
        expect(s.softAt, `seed ${seed}: softAt monotone`).toBeGreaterThanOrEqual(prevSoft);
        prevSoft = s.softAt;
        const k = c.killAt(now);
        expect(k, `seed ${seed}: killAt ≥ softAt`).toBeGreaterThanOrEqual(s.softAt);
        expect(k, `seed ${seed}: killAt ≤ hardAt`).toBeLessThanOrEqual(hardAt);
        expect(s.extensions).toBeLessThanOrEqual(c.policy.maxExtensions);
        expect(s.graces).toBeLessThanOrEqual(c.policy.maxExtensions);
        if (s.graceUntil !== undefined) expect(s.graceUntil).toBeLessThanOrEqual(hardAt);
        expect(c.nextTimerAt(), `seed ${seed}: WT8 never armed past hardAt`).toBeLessThanOrEqual(hardAt);
      }
      // Drive to expiry if the random walk did not (bounded: each fire either expires or opens a grace).
      for (let i = 0; !expired && i < 2 + 2 * c.policy.maxExtensions; i += 1) {
        now = Math.max(now, c.nextTimerAt());
        const t = c.onTimer(now);
        if (t.kind === "expire") expired = true;
        else arms += 1;
      }
      expect(expired, `seed ${seed}: reaches expiry without further extension`).toBe(true);
      expect(arms, `seed ${seed}: WT8 re-arms bounded`).toBeLessThanOrEqual(1 + 2 * c.policy.maxExtensions);
      expiredRuns += 1;
      c.close();
      expect(c.extend(now, 1_000).ok).toBe(false);
    }
    expect(expiredRuns).toBe(12);
    // The generator must actually exercise grace, rescue and hard-cap branches.
    expect(graceRuns).toBeGreaterThan(0);
    expect(rescuedRuns).toBeGreaterThan(0);
    expect(hardCapRuns).toBeGreaterThan(0);
  });
});
