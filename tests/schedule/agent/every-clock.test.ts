import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, type Clock, type TimerHandle } from "../../../src/core/clock.js";
import {
  createSessionClock,
  SCHED_POLL_MS,
  type SessionClock,
  type SessionClockDeps,
} from "../../../src/schedule/agent/clock.js";
import { openSessionStore, type SessionStore } from "../../../src/schedule/core/writer.js";
import { holderOf } from "../../../src/schedule/core/recovery.js";
import { everyTask, seedEvery } from "../core/every-fixtures.js";
import { env, holder, readOk, self, type Env } from "../core/fixtures.js";
const A = Date.parse("2026-11-09T10:07:23Z"),
  D = 5_400_000;
let e: Env | undefined;
const clocks: SessionClock[] = [];
afterEach(() => {
  clocks.splice(0).forEach((c) => c.dispose());
  e?.cleanup();
  e = undefined;
});
class ManualClock implements Clock {
  time = A;
  seq = 0;
  entries = new Map<number, { delay: number; fn(): void }>();
  delays: number[] = [];
  now = () => this.time;
  setTimer(delay: number, fn: () => void): TimerHandle {
    this.delays.push(delay);
    const id = ++this.seq;
    this.entries.set(id, { delay, fn });
    return { id };
  }
  clearTimer(h: TimerHandle): void {
    this.entries.delete(h.id);
  }
  fire(delay: number): void {
    const pair = [...this.entries].find(([, v]) => v.delay === delay);
    if (pair === undefined) throw Error(`missing ${delay}`);
    this.entries.delete(pair[0]);
    pair[1].fn();
  }
}
function setup(clock: Clock, overrides: Partial<SessionClockDeps> = {}, storeOverride?: SessionStore) {
  e = env(clock.now());
  const store = storeOverride ?? e.store(undefined, { now: () => clock.now(), monotonic: () => clock.now() });
  const fired = vi.fn();
  const c = createSessionClock({
    store: { get: () => store },
    clock,
    monotonic: () => clock.now(),
    holder: holder(),
    self: self(),
    armedSince: A,
    gate: () => undefined,
    onFired: fired,
    warn: () => undefined,
    ...overrides,
  });
  clocks.push(c);
  return { c, store, fired };
}
async function idle(c: SessionClock) {
  await c.idle();
  await c.idle();
}
function permutations<T>(xs: T[]): T[][] {
  return xs.length === 0
    ? [[]]
    : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((rest) => [x, ...rest]));
}

describe("every owner clock", () => {
  it.each(["gate", "lock"])(
    "unchanged rev/stat poll recovers %s failure without waiting for the next grid",
    async (failure) => {
      const fake = new FakeClock(A + D + 1);
      let blocked = true;
      const { c, store, fired } = setup(fake, {
        armedSince: fake.now(),
        gate: () => (failure === "gate" && blocked ? { code: "E_BUSY" } : undefined),
      });
      const t = everyTask(A);
      seedEvery(store, [t], A);
      const original = store.transactPlanned.bind(store);
      const calls = vi
        .spyOn(store, "transactPlanned")
        .mockImplementation((...args) =>
          failure === "lock" && blocked
            ? Promise.resolve({ ok: false, code: "E_BUSY", detail: "lock unavailable" })
            : original(...args),
        );
      await c.start();
      expect(readOk(store).rev).toBe(0);
      expect(fired).not.toHaveBeenCalled();
      fake.advance(2000);
      await idle(c);
      expect(readOk(store).rev).toBe(0);
      // First + at most one delayed retry, even repeated refresh/poke cannot reset attempts.
      for (let i = 0; i < 10; i++) {
        c.poke();
        await c.refresh();
      }
      await idle(c);
      expect(calls.mock.calls.length).toBe(failure === "lock" ? 2 : 0);
      blocked = false;
      fake.advance(SCHED_POLL_MS - 2000);
      await idle(c);
      expect(fired).toHaveBeenCalledTimes(1);
      expect(readOk(store).runs[0]!.catchUp!.cause).toBe("reopen");
      expect(readOk(store).occ[t.id]!.decidedThrough).toBe(A + D);
      expect(c.status().nextAt).toBe(A + 2 * D);
      c.dispose();
      expect(fake.pendingTimers).toBe(0);
    },
  );
  it("one shared retry timer, ≤16 logical/≤48 writer attempts, fixed 10s deadline and no zero timers", async () => {
    const fake = new ManualClock();
    fake.time = A + D + 1;
    const { c, store } = setup(fake);
    seedEvery(
      store,
      Array.from({ length: 8 }, () => everyTask(A)),
      A,
    );
    const calls = vi.spyOn(store, "transactPlanned").mockResolvedValue({ ok: false, code: "E_BUSY", detail: "busy" });
    await c.start();
    expect(calls).toHaveBeenCalledTimes(8);
    expect(fake.entries.size).toBe(4); // fire/poll/beat/ONE retry
    const deadlines = calls.mock.calls.map((args) => args[2]!.deadlineMono);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBe(fake.time + 10_000);
    c.poke();
    await c.refresh();
    await idle(c);
    expect(calls).toHaveBeenCalledTimes(8);
    fake.time += 2000;
    fake.fire(2000);
    await idle(c);
    expect(calls).toHaveBeenCalledTimes(16);
    c.poke();
    await c.refresh();
    await idle(c);
    expect(calls).toHaveBeenCalledTimes(16);
    expect(fake.entries.size).toBe(3);
    expect(fake.delays.every((d) => d > 0)).toBe(true);
    expect(calls.mock.calls.length * 3).toBeLessThanOrEqual(48);
    c.dispose();
    expect(fake.entries.size).toBe(0);
  });
  it("round time exhaustion rotates the cursor; next unchanged poll serves the tail", async () => {
    const fake = new ManualClock();
    fake.time = A + D + 1;
    const { c, store } = setup(fake);
    const tasks = Array.from({ length: 8 }, (_, i) => ({ ...everyTask(A), prompt: `task ${i}` }));
    seedEvery(store, tasks, A);
    const ids: string[] = [];
    vi.spyOn(store, "transactPlanned").mockImplementation(async (plan) => {
      // Observe the real planner's selected task id via hash, advance mono by 6s of lock work.
      const snap = readOk(store);
      const p = plan(snap, fake.now());
      if (!("plan" in p)) throw Error();
      const hash = (p.plan as { defHash: string }).defHash;
      ids.push(tasks.find((t) => snap.occ[t.id]!.defHash === hash)!.id);
      fake.time += 6000;
      return { ok: false, code: "E_BUSY", detail: "slow lock" };
    });
    await c.start();
    expect(ids).toEqual(tasks.slice(0, 2).map((t) => t.id));
    await c.refresh();
    expect(ids).toHaveLength(2); // no fresh deadline before next poll
    fake.time = A + D + 1 + 30_000;
    fake.fire(SCHED_POLL_MS);
    await idle(c);
    expect(ids.slice(2)).toEqual(tasks.slice(2, 4).map((t) => t.id));
  });
  it("runtime locked checks before all ledger IO, including poll", async () => {
    const fake = new ManualClock();
    let locked = false;
    const { c, store } = setup(fake, { gate: () => (locked ? { code: "E_SECURE" } : undefined) });
    seedEvery(store, [everyTask(A)], A);
    await c.start();
    const read = vi.spyOn(store, "read");
    const tx = vi.spyOn(store, "transactPlanned");
    read.mockClear();
    tx.mockClear();
    locked = true;
    fake.time += D;
    fake.fire(SCHED_POLL_MS);
    c.poke();
    await c.refresh();
    await idle(c);
    expect(read).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });
  it.each(["normal", "reopen", "resume", "late"])(
    "timer/poll/changed/online refresh permutations classify %s by fixed openedAt, never source",
    async (mode) => {
      for (const order of permutations(["timer", "poll", "changed", "refresh"])) {
        const fake = new ManualClock();
        e = env(A);
        const store = e.store(undefined, { now: fake.now, monotonic: fake.now });
        const t = everyTask(A);
        seedEvery(store, [t], A, mode === "resume");
        // Startup does not consume resumePending while no due: set it immediately before the race.
        const fired = vi.fn();
        const opened = mode === "reopen" || mode === "resume" ? A + D + 1 : A;
        const c = createSessionClock({
          store: { get: () => store },
          clock: fake,
          monotonic: fake.now,
          holder: holderOf(self(), "ep-race"),
          self: self(),
          armedSince: opened,
          gate: () => undefined,
          onFired: fired,
          warn: () => undefined,
        });
        clocks.push(c);
        await c.start();
        seedEvery(store, [t], A, mode === "resume");
        fake.time = A + (mode === "late" ? 2 * D : D) + 1;
        for (const source of order) {
          if (source === "timer") fake.fire(D);
          else if (source === "poll") fake.fire(SCHED_POLL_MS);
          else if (source === "changed") c.poke();
          else void c.refresh();
        }
        await idle(c);
        expect(fired, order.join(",")).toHaveBeenCalledTimes(1);
        expect(readOk(store).runs[0]!.catchUp?.cause, order.join(",")).toBe(mode === "normal" ? undefined : mode);
        c.dispose();
        expect(fake.entries.size).toBe(0);
        e.cleanup();
        e = undefined;
      }
    },
  );
  it("uncertain commits never dispatch; ≤8 readback timers and disposal clears all", async () => {
    const fake = new FakeClock(A + D + 1);
    e = env(fake.now());
    const store = openSessionStore({
      root: e.root,
      sessionId: "uncertain",
      self: self(),
      epoch: "ep-1",
      now: () => fake.now(),
      monotonic: () => fake.now(),
      faults: (point) => {
        if (point === "dir-fsync") throw new Error("injected failure");
      },
    });
    const tasks = Array.from({ length: 8 }, () => everyTask(A));
    seedEvery(store, tasks, A);
    const fired = vi.fn();
    const c = createSessionClock({
      store: { get: () => store },
      clock: fake,
      monotonic: () => fake.now(),
      holder: holder(),
      self: self(),
      armedSince: fake.now(),
      gate: () => undefined,
      onFired: fired,
      warn: () => undefined,
    });
    clocks.push(c);
    await c.start();
    expect(fired).not.toHaveBeenCalled();
    expect(readOk(store).runs).toHaveLength(8);
    expect(fake.pendingTimers).toBeLessThanOrEqual(12);
    fake.advance(5000);
    await idle(c);
    expect(readOk(store).runs.every((r) => r.state === "unknown" && r.reason === "no-outcome")).toBe(true);
    expect(fired).not.toHaveBeenCalled();
    c.dispose();
    expect(fake.pendingTimers).toBe(0);
  });
});

it("timer recovers a dead holder BEFORE judging interval overlap", async () => {
  const fake = new ManualClock();
  const { c, store, fired } = setup(fake);
  const t = everyTask(A);
  seedEvery(store, [t], A);
  await c.start();
  await store.transact((d) => {
    d.runs.push({
      runKey: `${t.id}@m-12345678`,
      taskId: t.id,
      kind: "manual",
      form: "background",
      scheduledAt: A,
      startedAt: A,
      defHash: d.occ[t.id]!.defHash,
      state: "running",
      holder: { ...holder(), boot: "old-boot" },
      note: "none",
    });
    return { value: undefined, write: true };
  });
  fake.time = A + D + 1;
  fake.fire(D);
  await idle(c);
  expect(fired).toHaveBeenCalledTimes(1);
  expect(readOk(store).runs[0]).toMatchObject({ state: "unknown", reason: "crash" });
  expect(readOk(store).occ[t.id]).toMatchObject({ firedTotal: 1, skippedTotal: 0 });
});
