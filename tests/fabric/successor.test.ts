import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";
import type { Verdict } from "../../src/fabric/mailbox.js";
import { flush, inboxRecord, inboxRig, sender, sessionFile, successor, target } from "../helpers/fabric-inbox.js";

// W4 (fabric-cross-session plan §3.4b/c, §8 W4): successor coalescing — the wait marker, the per-session drain and the
// redirect steer with its durable `steerAttempt`.

const sender2 = "r_SENDER02";
const owners = () => new Map([[sessionFile, successor]]);
type Patch = { [K in keyof FabricRecord]?: FabricRecord[K] | undefined };
const rec = (n: number, patch: Patch = {}): FabricRecord => {
  const record: Patch = {
    ...inboxRecord(),
    key: makeMessageKey(n % 2 ? sender : sender2, target, 1, n),
    from: n % 2 ? sender : sender2,
    seq: n,
    createdAt: n,
    payload: { text: `m${n}` },
    ttlMs: 100_000,
    ...patch,
  };
  // an explicit `undefined` means "field absent" (exactOptionalPropertyTypes)
  for (const k of Object.keys(record) as (keyof FabricRecord)[]) if (record[k] === undefined) delete record[k];
  return record as FabricRecord;
};
const calls = () => {
  const seen: { key: string; target: string | undefined }[] = [];
  const inject = vi.fn(async (r: FabricRecord, o?: { target: string }): Promise<Verdict> => {
    seen.push({ key: r.key, target: o?.target });
    return { ok: true };
  });
  return { seen, inject };
};
/** Successor admitted: in the tree as pending_start (spawn-service's `onSpawnEdge`). */
const startSuccessor = (h: ReturnType<typeof inboxRig>) => h.tree.append("root", successor);
const runSuccessor = (h: ReturnType<typeof inboxRig>) => {
  h.tree.markRunning(successor);
  h.mailbox.drainSession(sessionFile, successor);
};
const state = (h: ReturnType<typeof inboxRig>, r: FabricRecord) => h.engine.get(r.key)?.state;
/** Advance in 1ms steps so a steer's own microtask verdict always beats its (later) race timer. */
const tick = async (h: ReturnType<typeof inboxRig>, ms: number) => {
  for (let i = 0; i < ms; i++) {
    h.clock.advance(1);
    await flush();
  }
};
afterEach(() => vi.restoreAllMocks());

describe("W4 successor wait marker", () => {
  it("makes a message ineligible while the successor starts: no attempt, no spin, TTL is the only clock wake", async () => {
    const { inject, seen } = calls();
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: owners(), inject });
    startSuccessor(h);
    for (let i = 0; i < 20; i++) {
      h.mailbox.pump();
      h.mailbox.pump(target);
    }
    await flush();
    expect(seen).toEqual([]);
    expect(h.mailbox.waitingCount).toBe(1);
    expect(h.mailbox.inFlightCount).toBe(0);
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", attempts: 0 });
    expect(h.engine.get(r.key)?.steerAttempt).toBeUndefined();
    // exactly one armed timer: the message's TTL (no eligibility timer, no sweep timer)
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(100_000); // createdAt 1 + ttl 100_000 = 100_001: not yet
    expect(state(h, r)).toBe("pending");
    h.clock.advance(1);
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "abandoned", deadLetter: { reason: "ttl_expired" } });
    expect(h.mailbox.waitingCount).toBe(0);
  });

  it("applies to a freshly admitted wake:false message too (parked stamp does not hide it from the drain)", async () => {
    const { inject, seen } = calls();
    const h = inboxRig({ owners: owners(), inject });
    startSuccessor(h);
    const admitted = h.router.admit(sender, {
      to: target,
      kind: "finding",
      text: "hello",
      generation: 1,
      wake: false,
      canMessage: ["sibling"],
    });
    if (!admitted.ok) throw new Error(admitted.status);
    expect(h.engine.get(admitted.key)).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
    h.mailbox.pump(); // the stack's router `onChanged` hook
    expect(h.mailbox.waitingCount).toBe(1);
    runSuccessor(h);
    await flush();
    expect(seen).toEqual([{ key: admitted.key, target: successor }]);
    expect(state(h, h.engine.get(admitted.key)!)).toBe("delivered");
  });

  it("leaves omitted-wake (legacy) messages and progress alone: unchanged target_gone handling", async () => {
    const { inject, seen } = calls();
    const legacy = rec(1, { wake: undefined, parked: undefined });
    const progress = rec(2, { kind: "progress", wake: false, parked: undefined });
    const h = inboxRig({ records: [legacy, progress], owners: owners(), inject });
    startSuccessor(h);
    h.mailbox.pump();
    await flush();
    expect(seen).toEqual([]);
    expect(h.mailbox.waitingCount).toBe(0);
    expect(h.engine.get(legacy.key)).toMatchObject({ state: "dropped", deadLetter: { reason: "target_gone" } });
    expect(h.engine.get(progress.key)).toMatchObject({ state: "dropped", terminalReason: "target_gone" });
  });

  it("resolves the successor through the target run id when the session file is unknown", async () => {
    const { inject, seen } = calls();
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: new Map([[target, successor]]), inject });
    h.snapshots.set(target, { ...h.snapshots.get(target)!, diag: { ...h.snapshots.get(target)!.diag } });
    delete (h.snapshots.get(target)!.diag as { sessionFile?: string }).sessionFile;
    startSuccessor(h);
    h.mailbox.pump();
    expect(h.mailbox.waitingCount).toBe(1);
    runSuccessor(h);
    await flush();
    expect(seen).toEqual([{ key: r.key, target: successor }]);
  });
});

describe("W4 drain into a running successor", () => {
  it("redirects every unreserved pending record of the chain in createdAt order and never touches reserved ones", async () => {
    const { inject, seen } = calls();
    const reservedRec = rec(9, { reserved: { rsv: "rsv", runId: "r_OTHER001", at: 0 } });
    const records = [rec(3), rec(1), rec(2, { wake: true, parked: undefined })];
    const h = inboxRig({ records, owners: owners(), inject });
    // bound to a live run (admitted after construction ⇒ not a recovered reservation): the sweep leaves it alone
    h.snapshots.set("r_OTHER001", { ...h.snapshots.get(target)!, runId: "r_OTHER001", status: "running" });
    h.engine.put(reservedRec);
    startSuccessor(h);
    h.mailbox.pump();
    expect(h.mailbox.waitingCount).toBe(3);
    runSuccessor(h);
    await flush();
    expect(seen.map((s) => s.key)).toEqual([records[1]!, records[2]!, records[0]!].map((r) => r.key));
    expect(seen.every((s) => s.target === successor)).toBe(true);
    for (const r of records.slice(0, 3)) expect(state(h, r)).toBe("delivered");
    expect(h.engine.get(reservedRec.key)).toMatchObject({ state: "pending", reserved: { runId: "r_OTHER001" } });
    expect(h.mailbox.waitingCount).toBe(0);
    // the level of the delivered messages lands in the SUCCESSOR session, not the finished run
    expect(h.raised.every((x) => x.runId === successor)).toBe(true);
  });

  it("the durable steerAttempt is written BEFORE the send and survives as the persisted form", async () => {
    let persistedBeforeSend: unknown;
    const r = rec(1);
    let h!: ReturnType<typeof inboxRig>;
    h = inboxRig({
      records: [r],
      owners: owners(),
      inject: async () => {
        persistedBeforeSend = h.store.list().find((x) => x.key === r.key);
        return { ok: true };
      },
    });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(persistedBeforeSend).toMatchObject({ state: "pending", steerAttempt: { runId: successor } });
    expect(h.engine.get(r.key)).toMatchObject({ state: "delivered", attempts: 1 });
  });

  it("drains a long backlog in bounded microtask steps while FakeClock timers keep running (no starvation)", async () => {
    const { inject, seen } = calls();
    const records = Array.from({ length: 40 }, (_, i) => rec(i + 1, { wake: true, parked: undefined }));
    const h = inboxRig({ records, owners: owners(), inject });
    startSuccessor(h);
    h.mailbox.pump();
    runSuccessor(h);
    let ticks = 0;
    while (seen.length < records.length && ticks < 40 * 12) {
      await Promise.resolve();
      if (ticks % 3 === 0) h.clock.advance(1);
      ticks++;
    }
    await flush();
    expect(seen).toHaveLength(40);
    expect(ticks).toBeLessThan(40 * 12);
    expect(h.engine.select((r) => r.state === "delivered")).toHaveLength(40);
    expect(h.mailbox.inFlightCount).toBe(0);
    expect(h.mailbox.pendingRaceTimers).toBe(0);
    // the loop is event-driven: nothing is left armed once everything is delivered
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("two senders during a manual resume startup: the admitted inbox is reserved, later arrivals are redirected", async () => {
    const { inject, seen } = calls();
    const early = rec(100);
    const h = inboxRig({ records: [early], owners: owners(), inject });
    startSuccessor(h);
    h.tree.append("root", sender2);
    h.tree.markRunning(sender2);
    // spawn admission of the manual `Agent({resume})` (no trigger): the parked message is carried in its prompt
    expect(h.wake.onResumeAdmitted({ runId: successor, sessionFile })).toMatchObject({ trackInput: true });
    const keys: string[] = [];
    for (const [from, text] of [
      [sender, "from A"],
      [sender2, "from B"],
    ] as const) {
      const result = h.router.admit(from, {
        to: target,
        kind: "finding",
        text,
        generation: 1,
        wake: false,
        canMessage: ["sibling"],
      });
      if (!result.ok) throw new Error(result.status);
      keys.push(result.key);
    }
    h.mailbox.pump();
    expect(h.mailbox.waitingCount).toBe(2);
    runSuccessor(h);
    await flush();
    expect(seen.map((s) => s.key).sort()).toEqual([...keys].sort());
    expect(seen.every((s) => s.target === successor)).toBe(true);
    expect(h.engine.get(early.key)).toMatchObject({ state: "pending", reserved: { runId: successor } });
  });

  it("a successor that ends without ever running releases its waiters to normal handling", async () => {
    const { inject, seen } = calls();
    const parkedRec = rec(1);
    const wakeTrue = rec(2, { wake: true, parked: undefined });
    const h = inboxRig({ records: [parkedRec, wakeTrue], owners: owners(), inject });
    startSuccessor(h);
    h.mailbox.pump();
    expect(h.mailbox.waitingCount).toBe(2);
    // spawn-service releases the owner at the terminal; the runner reports the settle (never a running snapshot)
    h.mailbox.onRunSettled(successor);
    owners().clear();
    h.tree.tombstone(successor, h.clock.now(), 1000);
    h.mailbox.onRunSettled(successor);
    await flush();
    expect(seen).toEqual([]);
    expect(h.mailbox.waitingCount).toBe(0);
    // wake:true has no revive yet (W5) ⇒ ordinary dead letter; the wake:false record simply stays parked for TTL
    expect(h.engine.get(wakeTrue.key)).toMatchObject({ state: "dropped", deadLetter: { reason: "target_gone" } });
    expect(h.engine.get(parkedRec.key)).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
  });
});

describe("W4 redirect verdict handling (effect)", () => {
  it("a steer that lands AFTER its timeout is consumed once, audited, and never sent again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let late: ((v: Verdict) => void) | undefined;
    const inject = vi.fn(() => new Promise<Verdict>((resolve) => (late = resolve)));
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: owners(), inject });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(inject).toHaveBeenCalledTimes(1);
    h.clock.advance(10); // steerMs
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "steer_unverified" });
    expect(h.store.list().find((x) => x.key === r.key)).toMatchObject({
      state: "consumed",
      steerAttempt: { runId: successor },
    });
    late?.({ ok: true }); // the steer finally lands
    await flush();
    h.mailbox.pump();
    h.clock.advance(60_000);
    await flush();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(h.engine.get(r.key)?.state).toBe("consumed");
    expect(h.wake.stats().unverified).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`steer_unverified key=${r.key} run=${successor}`));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("m1");
    expect(h.mailbox.pendingRaceTimers).toBe(0);
  });

  it("a rejected steer (effect none) withdraws the attempt mark and returns the record to pending, then retries", async () => {
    let n = 0;
    const inject = vi.fn(async (): Promise<Verdict> => {
      if (++n === 1) throw new Error("boom");
      return { ok: true };
    });
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: owners(), inject });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", attempts: 1 });
    expect(h.engine.get(r.key)?.steerAttempt).toBeUndefined();
    expect(h.store.list().find((x) => x.key === r.key)?.steerAttempt).toBeUndefined();
    expect(h.mailbox.inFlightCount).toBe(0);
    await tick(h, 1_000);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(h.engine.get(r.key)).toMatchObject({ state: "delivered", attempts: 2 });
  });

  it("a successor with no active session (target_gone, effect none) is bounded by attempts, not dead-lettered at once", async () => {
    const inject = vi.fn(async (): Promise<Verdict> => {
      throw new Error("no active session for run");
    });
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: owners(), inject });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", attempts: 1 });
    await tick(h, 6_000);
    expect(inject).toHaveBeenCalledTimes(3); // maxAttempts
    expect(h.engine.get(r.key)).toMatchObject({ state: "dropped", deadLetter: { reason: "attempts_exhausted" } });
  });

  it("an unpersistable steerAttempt means nothing is sent: ordinary retryable verdict", async () => {
    const inject = vi.fn(async (): Promise<Verdict> => ({ ok: true }));
    const r = rec(1);
    const h = inboxRig({ records: [r], owners: owners(), inject, failUpdate: (_k, n) => n === 1 });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(inject).not.toHaveBeenCalled();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", attempts: 1 });
    await tick(h, 1_000);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(h.engine.get(r.key)?.state).toBe("delivered");
  });
});

describe("W4 reload with a durable steerAttempt", () => {
  it("reload between steer acceptance and verdict persist: audited consume, never steered again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inject, seen } = calls();
    const r = rec(1);
    // update #1 = steerAttempt (persisted); update #2 = `delivered` transition — the process dies before it lands
    const h = inboxRig({ records: [r], owners: owners(), inject, failUpdate: (_k, n) => n === 2 });
    startSuccessor(h);
    runSuccessor(h);
    await flush();
    expect(seen).toHaveLength(1); // the steer WAS accepted
    expect(h.store.list().find((x) => x.key === r.key)).toMatchObject({
      state: "pending",
      steerAttempt: { runId: successor },
    });
    // new stack over the persisted log, the successor now running in it
    const reload = calls();
    const h2 = inboxRig({ records: [...h.store.list()], owners: owners(), inject: reload.inject });
    startSuccessor(h2);
    h2.tree.markRunning(successor);
    expect(h2.wake.steerHeld(r.key)).toBe(true);
    h2.wake.reconcile();
    h2.mailbox.pump();
    h2.mailbox.drainSession(sessionFile, successor);
    await flush();
    h2.clock.advance(60_000);
    await flush();
    expect(reload.seen).toEqual([]);
    expect(h2.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "steer_unverified" });
    expect(h2.wake.steerHeld(r.key)).toBe(false);
    expect(h2.wake.stats().unverified).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("steer_unverified"));
  });

  it("is held out of delivery (even past its TTL) until consumed; a persistently failing persist degrades after a bounded count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inject, seen } = calls();
    const r = rec(1, { steerAttempt: { runId: successor, at: 0 }, ttlMs: 500 });
    const h = inboxRig({ records: [r], owners: owners(), inject, failUpdate: () => true });
    startSuccessor(h);
    h.tree.markRunning(successor);
    h.wake.reconcile();
    h.mailbox.pump();
    h.clock.advance(400);
    await flush();
    expect(h.engine.get(r.key)?.state).toBe("pending"); // strict consume failed, retry armed
    for (let i = 0; i < 8; i++) {
      h.clock.advance(1_000);
      await flush();
    }
    expect(seen).toEqual([]);
    expect(h.engine.get(r.key)).toMatchObject({ state: "consumed", terminalReason: "steer_unverified" });
    expect(h.wake.steerHeld(r.key)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("degrading to memory-only"));
  });
});

describe("W3 verifier findings", () => {
  it("a transient persist failure while parking leaves the record pending and retries; it is not dead-lettered", async () => {
    const r = rec(1, { parked: undefined });
    const h = inboxRig({ records: [r], failUpdate: (_k, n) => n === 1 });
    h.mailbox.pump();
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending" });
    expect(h.engine.get(r.key)?.deadLetter).toBeUndefined();
    expect(h.engine.get(r.key)?.parked).toBeUndefined();
    h.clock.advance(1_000);
    await flush();
    expect(h.engine.get(r.key)).toMatchObject({ state: "pending", parked: { reason: "wake_false" } });
  });

  it("a reserved record whose release keeps failing degrades to memory-only after a bounded count", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = inboxRecord({ reserved: { rsv: "rsv", runId: successor, at: 0 }, ttlMs: 1_000_000 });
    const h = inboxRig({ failUpdate: () => true });
    h.engine.put(r); // admitted after construction: a live (not recovered) reservation
    h.snapshots.set(successor, {
      ...h.snapshots.get(target)!,
      runId: successor,
      status: "failed",
      phase: "settled",
    });
    h.wake.onSnapshot(h.snapshots.get(successor)!);
    for (let i = 0; i < 8; i++) {
      h.clock.advance(1_000);
      h.mailbox.pump();
    }
    expect(h.engine.get(r.key)?.reserved).toBeUndefined();
    expect(h.wake.stats().reserved).toBe(0);
  });
});
