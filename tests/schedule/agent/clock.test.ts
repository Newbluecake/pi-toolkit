/**
 * SessionClock (A0) over a REAL S1 store (tmp dir, kernel flock) and a FakeClock driving both the
 * timers and the ledger's business clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { createSessionClock, SCHED_POLL_MS, type SessionClockDeps } from "../../../src/schedule/agent/clock.js";
import { holderOf } from "../../../src/schedule/core/recovery.js";
import type { RunRecord, ScheduleTask } from "../../../src/schedule/core/spec.js";
import { openSessionStore, type SessionStore, type WriterFaultPoint } from "../../../src/schedule/core/writer.js";
import { addTask, approve, env, makeTask, MIN, readOk, self, SID, utc, type Env } from "../core/fixtures.js";

const T0 = utc("2026-01-01T00:00:30Z");
const T1 = utc("2026-01-01T00:01:00Z");

let e: Env | undefined;
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  e?.cleanup();
  e = undefined;
});

function storeOn(env0: Env, fake: FakeClock, epoch: string, faults?: (p: WriterFaultPoint) => void): SessionStore {
  return openSessionStore({
    root: env0.root,
    sessionId: SID,
    self: self(),
    epoch,
    now: () => fake.now(),
    monotonic: () => fake.now(),
    lockTimeoutMs: 300,
    ...(faults ? { faults } : {}),
  });
}

function makeClock(store: SessionStore, fake: FakeClock, over: Partial<SessionClockDeps> & { epoch?: string } = {}) {
  const fired: Array<{ run: RunRecord; task: ScheduleTask }> = [];
  const changed = vi.fn();
  const epoch = over.epoch ?? "ep-a";
  const c = createSessionClock({
    store: { get: () => store },
    holder: holderOf(self(), epoch),
    self: self(),
    armedSince: fake.now(),
    clock: fake,
    monotonic: () => fake.now(),
    gate: () => undefined,
    onFired: (run, task) => fired.push({ run, task }),
    onChanged: changed,
    warn: () => undefined,
    ...over,
  });
  disposers.push(() => c.dispose());
  return { c, fired, changed };
}

async function settle(...clocks: Array<{ idle(): Promise<void> }>): Promise<void> {
  for (let i = 0; i < 6; i++) {
    for (const c of clocks) await c.idle();
    await new Promise((r) => setImmediate(r));
  }
}

const everyMinute = () => approve(makeTask({ when: { kind: "cron", expr: "* * * * *", tz: "UTC" } }));

describe("SessionClock", () => {
  it("arms the earliest occurrence and fires it exactly once through autoClaim", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = everyMinute();
    await addTask(store, task, T0 - MIN);
    const { c, fired, changed } = makeClock(store, fake);
    await c.start();
    expect(c.status()).toMatchObject({ nextAt: T1, nextTaskId: task.id });
    fake.advance(T1 - T0 - 1);
    await settle(c);
    expect(fired).toHaveLength(0);
    fake.advance(1);
    await settle(c);
    expect(fired.map((f) => f.run.runKey)).toEqual([`${task.id}@${T1}`]);
    expect(changed).toHaveBeenCalled();
    const st = readOk(store);
    expect(st.occ[task.id]).toMatchObject({ decidedThrough: T1, firedTotal: 1, missedTotal: 0 });
    expect(c.status().nextAt).toBe(T1 + MIN);
  });

  it("a session opened after T never fires T: the supplemental sweep judges it missed at T+61s", async () => {
    const opened = T1 + 30_000;
    e = env(opened);
    const fake = new FakeClock(opened);
    const store = storeOn(e, fake, "ep-a");
    const task = approve(makeTask({ when: { kind: "cron", expr: "1 0 * * *", tz: "UTC" } })); // 00:01 daily
    await addTask(store, task, T0);
    const { c, fired } = makeClock(store, fake);
    await c.start();
    fake.advance(30_000); // T+60s: still inside tolerance, nobody decides it
    await settle(c);
    expect(readOk(store).occ[task.id]!.missedTotal).toBe(0);
    fake.advance(1_000); // T+61s: the supplemental sweep
    await settle(c);
    expect(fired).toHaveLength(0);
    const occ = readOk(store).occ[task.id]!;
    expect(occ.missedTotal).toBe(1);
    expect(occ.missedLog[0]).toMatchObject({ to: T1, count: 1, cause: "offline" });
  });

  it("two processes armed before T: exactly one fires, the other loses", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const sa = storeOn(e, fake, "ep-a");
    const sb = storeOn(e, fake, "ep-b");
    const task = everyMinute();
    await addTask(sa, task, T0 - MIN);
    const a = makeClock(sa, fake, { epoch: "ep-a" });
    const b = makeClock(sb, fake, { epoch: "ep-b" });
    await a.c.start();
    await b.c.start();
    fake.advance(T1 - T0);
    await settle(a.c, b.c);
    expect(a.fired.length + b.fired.length).toBe(1);
    expect(readOk(sa).runs).toHaveLength(1);
    expect(readOk(sa).occ[task.id]!.firedTotal).toBe(1);
  });

  it("a pause written by another process after arming stops the old timer in the lock", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = everyMinute();
    await addTask(store, task, T0 - MIN);
    const { c, fired } = makeClock(store, fake);
    await c.start();
    const other = storeOn(e, fake, "ep-x");
    await other.transact((d) => {
      d.tasks[0]!.enabled = false;
      return { value: undefined, write: true };
    });
    fake.advance(T1 - T0);
    await settle(c);
    expect(fired).toHaveLength(0);
    expect(readOk(store).runs).toHaveLength(0);
  });

  it("a preflight refusal never claims; the occurrence is judged missed after tolerance", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = approve(makeTask({ when: { kind: "cron", expr: "1 0 * * *", tz: "UTC" } }));
    await addTask(store, task, T0 - MIN);
    const preflight = vi.fn(() => ({ code: "E_UNSUPPORTED" as const, detail: "no executor" }));
    const { c, fired } = makeClock(store, fake, { preflight });
    await c.start();
    fake.advance(T1 - T0);
    await settle(c);
    expect(preflight).toHaveBeenCalled();
    expect(fired).toHaveLength(0);
    expect(readOk(store).runs).toHaveLength(0);
    fake.advance(61_000);
    await settle(c);
    expect(readOk(store).occ[task.id]).toMatchObject({ missedTotal: 1, decidedThrough: T1 });
  });

  it("a gate refusal inside the lock writes nothing (ineligible)", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = everyMinute();
    await addTask(store, task, T0 - MIN);
    const { c, fired } = makeClock(store, fake, { gate: () => ({ code: "E_SECURE", detail: "locked" }) });
    await c.start();
    const rev = readOk(store).rev;
    fake.advance(T1 - T0);
    await settle(c);
    expect(fired).toHaveLength(0);
    expect(readOk(store).rev).toBe(rev);
  });

  it("an uncertain claim commit is never dispatched; the follow-up finishes it as unknown(no-outcome)", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    let failNext = false;
    const store = storeOn(e, fake, "ep-a", (p) => {
      if (p === "dir-fsync" && failNext) {
        failNext = false;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
    });
    const task = everyMinute();
    await addTask(store, task, T0 - MIN);
    const { c, fired } = makeClock(store, fake);
    await c.start();
    failNext = true;
    fake.advance(T1 - T0);
    await settle(c);
    expect(fired).toHaveLength(0);
    expect(readOk(store).runs[0]).toMatchObject({ runKey: `${task.id}@${T1}`, state: "dispatching" });
    fake.advance(5_000);
    await settle(c);
    expect(readOk(store).runs[0]).toMatchObject({ state: "unknown", reason: "no-outcome" });
    expect(fired).toHaveLength(0);
  });

  it("the 30 s poll recovers a dead foreign holder's run as unknown(crash)", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = everyMinute();
    await addTask(store, task, T0 - MIN);
    const { c } = makeClock(store, fake);
    await c.start();
    const me = self();
    const dead = { pid: 4_194_000 + (process.pid % 1000), start: 1, host: me.host, boot: me.boot, epoch: "gone" };
    await store.transact((d) => {
      d.runs.push({
        runKey: `${task.id}@${T0 - 30_000}`,
        taskId: task.id,
        kind: "auto",
        form: "background",
        scheduledAt: T0 - 30_000,
        defHash: task.approval!.hash,
        state: "running",
        holder: dead,
        startedAt: T0 - 30_000,
        note: "none",
      });
      return { value: undefined, write: true };
    });
    fake.advance(SCHED_POLL_MS);
    await settle(c);
    expect(readOk(store).runs.find((r) => r.holder.epoch === "gone")).toMatchObject({
      state: "unknown",
      reason: "crash",
    });
  });

  it("poke() after an external definition change re-arms on the new definition", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    const task = approve(makeTask({ when: { kind: "cron", expr: "30 0 * * *", tz: "UTC" } }));
    await addTask(store, task, T0 - MIN);
    const { c } = makeClock(store, fake);
    await c.start();
    expect(c.status().nextAt).toBe(utc("2026-01-01T00:30:00Z"));
    await storeOn(e, fake, "ep-x").transact((d) => {
      const t = d.tasks[0]!;
      t.when = { kind: "cron", expr: "5 0 * * *", tz: "UTC" };
      t.approval = { hash: "", by: "user", via: "tui", at: 0 };
      approve(t);
      d.occ[t.id]!.decidedThrough = fake.now();
      d.occ[t.id]!.defHash = t.approval.hash;
      return { value: undefined, write: true };
    });
    c.poke();
    await settle(c);
    expect(c.status().nextAt).toBe(utc("2026-01-01T00:05:00Z"));
  });

  it("dispose() cancels every timer (nothing can keep the process alive)", async () => {
    e = env(T0);
    const fake = new FakeClock(T0);
    const store = storeOn(e, fake, "ep-a");
    await addTask(store, everyMinute(), T0 - MIN);
    const { c, fired } = makeClock(store, fake);
    await c.start();
    expect(fake.pendingTimers).toBeGreaterThan(0);
    c.dispose();
    expect(fake.pendingTimers).toBe(0);
    fake.advance(10 * MIN);
    await settle(c);
    expect(fired).toHaveLength(0);
  });

  it("no store yet ⇒ nothing armed, poll keeps re-resolving, no error", async () => {
    const fake = new FakeClock(T0);
    let s: SessionStore | undefined;
    const get = vi.fn(() => s);
    const c = createSessionClock({
      store: { get },
      holder: holderOf(self(), "ep-a"),
      self: self(),
      armedSince: T0,
      clock: fake,
      gate: () => undefined,
      onFired: () => undefined,
      warn: () => undefined,
    });
    disposers.push(() => c.dispose());
    await c.start();
    expect(c.status().nextAt).toBeUndefined();
    fake.advance(SCHED_POLL_MS);
    await settle(c);
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });
});
