import { afterEach, describe, expect, it } from "vitest";
import { createMeasureClaim, getMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { MEASURE_CLAIM_KEY, type MeasureProgress, type MeasureRunHandle } from "../../src/cache-ttl/measure-types.js";

const owner = (runId = "m-1", activationId = "act-1", sessionId = "sess-1") => ({ activationId, sessionId, runId });
const handle = (label = "x"): MeasureRunHandle => ({
  snapshot: () =>
    ({
      runId: label,
      label,
      status: "running",
      startedAt: 0,
      slotsDone: 0,
      sent: 0,
      cost: { knownUsd: 0, unknownUsd: [0, 0], unknownItems: [] },
      physicalPending: 0,
    }) as MeasureProgress,
  cancel: () => undefined,
  done: new Promise(() => undefined),
});
const prep = (c = createMeasureClaim(), o = owner(), now = 1_000) => {
  const r = c.prepare(o, now);
  if (!r.ok) throw new Error("prepare failed");
  return { c, token: r.token };
};

describe("measure claim — states", () => {
  it("free → preparing → running → free (no IO pending)", () => {
    const c = createMeasureClaim();
    expect(c.state).toBe("free");
    const r = c.prepare(owner(), 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(c.state).toBe("preparing");
    expect(r.token.owner).toMatchObject({ activationId: "act-1", sessionId: "sess-1", runId: "m-1", generation: 1 });
    expect(c.owns(r.token)).toBe(true);
    expect(c.start(r.token, handle())).toBe(true);
    expect(c.state).toBe("running");
    expect(c.owns(r.token)).toBe(true);
    c.finishLogical(r.token, 20);
    expect(c.state).toBe("free");
    expect(c.owns(r.token)).toBe(false);
  });

  it("prepare is only possible from free: preparing and running answer busy", () => {
    const { c, token } = prep();
    expect(c.prepare(owner("m-2"), 5)).toEqual({ ok: false, reason: "busy" });
    c.start(token, handle());
    expect(c.prepare(owner("m-2"), 5)).toEqual({ ok: false, reason: "busy" });
  });

  it("revoke(token): preparing → free, a pending confirm can no longer start", () => {
    const { c, token } = prep();
    c.revoke(token);
    expect(c.state).toBe("free");
    expect(c.owns(token)).toBe(false);
    expect(c.start(token, handle())).toBe(false);
    expect(c.state).toBe("free");
    // the next prepare gets a NEW generation
    const next = c.prepare(owner("m-2"), 5);
    expect(next.ok && next.token.owner.generation).toBe(2);
  });

  it("revoke is a no-op on a running claim (use the run's cancel)", () => {
    const { c, token } = prep();
    c.start(token, handle());
    c.revoke(token);
    expect(c.state).toBe("running");
    expect(c.owns(token)).toBe(true);
  });

  it("running → draining while physical IO is pending → free only when every send settled", () => {
    const { c, token } = prep();
    c.start(token, handle());
    c.ioBegin();
    c.ioBegin();
    c.finishLogical(token, 500);
    expect(c.state).toBe("draining");
    expect(c.drainingSince).toBe(500);
    expect(c.owns(token)).toBe(false);
    expect(c.prepare(owner("m-2"), 600)).toEqual({ ok: false, reason: "busy-io-pending", since: 500 });
    c.ioSettled();
    expect(c.state).toBe("draining");
    expect(c.physicalPending).toBe(1);
    c.ioSettled();
    expect(c.state).toBe("free");
    expect(c.drainingSince).toBeUndefined();
    expect(c.prepare(owner("m-2"), 700).ok).toBe(true);
  });

  it("a settled that never resolves keeps the claim draining (fail closed)", () => {
    const { c, token } = prep();
    c.start(token, handle());
    c.ioBegin();
    c.finishLogical(token, 1);
    for (const t of [10, 10_000_000, 99_999_999_999]) {
      expect(c.prepare(owner("m-2"), t)).toMatchObject({ ok: false, reason: "busy-io-pending", since: 1 });
    }
    expect(c.state).toBe("draining");
  });

  it("ioSettled is NOT token-gated and never goes negative", () => {
    const c = createMeasureClaim();
    c.ioSettled();
    expect(c.physicalPending).toBe(0);
    c.ioBegin();
    expect(c.physicalPending).toBe(1);
    // free state with pending IO (anomaly): prepare reports busy-io-pending, then frees on settle
    expect(c.prepare(owner(), 3)).toMatchObject({ ok: false, reason: "busy-io-pending" });
    c.ioSettled();
    expect(c.prepare(owner(), 4).ok).toBe(true);
  });

  it("start requires preparing + ownership", () => {
    const c = createMeasureClaim();
    const { token } = prep(c);
    expect(c.start(token, handle())).toBe(true);
    expect(c.start(token, handle())).toBe(false); // already running
  });

  it("current() shows the live run of any generation; absent when free/draining", () => {
    const { c, token } = prep();
    expect(c.current()).toBeUndefined();
    c.start(token, handle("run-A"));
    expect(c.current()?.runId).toBe("run-A");
    c.ioBegin();
    c.finishLogical(token, 1);
    expect(c.current()).toBeUndefined();
  });
});

describe("measure claim — generation / owner fences", () => {
  it("a token from an older generation never owns a newer claim", () => {
    const c = createMeasureClaim();
    const first = prep(c).token;
    c.revoke(first);
    const second = prep(c, owner("m-2")).token;
    expect(second.owner.generation).toBe(first.owner.generation + 1);
    expect(c.owns(first)).toBe(false);
    expect(c.owns(second)).toBe(true);
    c.finishLogical(first, 1); // stale: ignored
    expect(c.state).toBe("preparing");
    c.start(first, handle()); // stale: refused
    expect(c.state).toBe("preparing");
  });

  it("activation, session and run id must all match (a forged token with another owner is refused)", () => {
    const { c, token } = prep(createMeasureClaim(), owner("m-1", "act-1", "sess-1"));
    const clone = (o: Partial<typeof token.owner>) => ({ owner: { ...token.owner, ...o } });
    expect(c.owns(clone({}))).toBe(true); // an equal copy is the same owner
    expect(c.owns(clone({ activationId: "act-2" }))).toBe(false);
    expect(c.owns(clone({ sessionId: "sess-2" }))).toBe(false);
    expect(c.owns(clone({ runId: "m-9" }))).toBe(false);
    expect(c.owns(clone({ generation: token.owner.generation + 1 }))).toBe(false);
  });

  it("an old generation's IO still settles into the ledger and frees the claim for the next owner", () => {
    const c = createMeasureClaim();
    const first = prep(c).token;
    c.start(first, handle());
    c.ioBegin();
    c.finishLogical(first, 5);
    expect(c.state).toBe("draining");
    c.ioSettled(); // belongs to the generation-1 run; no token needed
    const next = c.prepare(owner("m-2", "act-2", "sess-2"), 6);
    expect(next.ok).toBe(true);
    expect(c.owns(first)).toBe(false);
  });
});

describe("measure claim — process singleton", () => {
  const g = globalThis as Record<symbol, unknown>;
  const saved = g[MEASURE_CLAIM_KEY];
  afterEach(() => {
    if (saved === undefined) delete g[MEASURE_CLAIM_KEY];
    else g[MEASURE_CLAIM_KEY] = saved;
  });

  it("lives at globalThis[Symbol.for('pi-subagent:cache-ttl-measure')] and is shared across 'activations'", () => {
    expect(MEASURE_CLAIM_KEY).toBe(Symbol.for("pi-subagent:cache-ttl-measure"));
    delete g[MEASURE_CLAIM_KEY];
    const a = getMeasureClaim();
    const b = getMeasureClaim();
    expect(a).toBe(b);
    expect(g[MEASURE_CLAIM_KEY]).toBe(a);
    const t = a.prepare(owner(), 1);
    expect(t.ok).toBe(true);
    expect(b.state).toBe("preparing"); // a "second activation" sees the first one's claim
    expect(b.prepare(owner("m-2", "act-2"), 2)).toEqual({ ok: false, reason: "busy" });
  });

  it("an untrusted/foreign object at the key is replaced, not used", () => {
    g[MEASURE_CLAIM_KEY] = { state: "running" };
    const c = getMeasureClaim();
    expect(c.state).toBe("free");
    expect(typeof c.prepare).toBe("function");
  });

  it("carries the process-wide persist slot", () => {
    delete g[MEASURE_CLAIM_KEY];
    const c = getMeasureClaim();
    expect(c.persistSlot).toMatchObject({ state: "idle", writing: false });
    expect(getMeasureClaim().persistSlot).toBe(c.persistSlot);
  });
});
