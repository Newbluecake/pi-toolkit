/**
 * scheduled-reports plan r3 §4.3/§4.4/§4.5a/§4.5b (S1): auto claim (fired / lost / missed(late) /
 * overlap / ineligible), D13 coalescing, cross-process pause, rev-conflict retry, manual claim
 * (non-cron minute, watermark untouched, idempotent reqId, stale defHash, mutual exclusion with
 * auto), sweep with the tolerance cut-off (R2-3 races, supplemental sweep, once), missedLog with
 * exact numbers (R2-2), chunking and truncation, and approval semantics (S2).
 */
import { afterEach, describe, expect, it } from "vitest";
import { approveTask, autoClaim, changeTask, manualClaim, sweep } from "../../../src/schedule/core/claim.js";
import { applySweep, planSweep, voidUntil } from "../../../src/schedule/core/occurrence.js";
import {
  defHash,
  isExecutable,
  SCHED_FIRE_TOLERANCE_MS,
  SCHED_MISSED_LOG_MAX,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";
import { finishRun, type SessionStore } from "../../../src/schedule/core/writer.js";
import { addTask, approve, env, holder, HOUR, makeTask, MIN, readOk, utc, type Env } from "./fixtures.js";

let E: Env;
afterEach(() => E?.cleanup());

const T8 = utc("2026-10-24T08:00:00Z");

async function setup(task: ScheduleTask, now = T8 - 5 * MIN): Promise<ReturnType<Env["store"]>> {
  E = env(now);
  const store = E.store();
  await addTask(store, task, now);
  return store;
}

describe("auto claim — four outcomes", () => {
  it("fired: run + watermark + firedTotal in ONE write", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    const rev0 = readOk(store).rev;
    E.clock.t = T8 + 2_000;
    const r = await autoClaim(store, { taskId: t.id, t: T8, armedSince: T8 - 5 * MIN, holder: holder() });
    expect(r.kind).toBe("fired");
    const s = readOk(store);
    expect(s.rev).toBe(rev0 + 1);
    expect(s.occ[t.id]).toMatchObject({ decidedThrough: T8, firedTotal: 1, missedTotal: 0, skippedTotal: 0 });
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({
      runKey: `${t.id}@${T8}`,
      kind: "auto",
      state: "dispatching",
      scheduledAt: T8,
      note: "none",
    });
  });

  it("lost: an already-decided T writes nothing", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    const rev = readOk(store).rev;
    const again = await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder("ep-2") });
    expect(again).toEqual({ kind: "lost" });
    expect(readOk(store).rev).toBe(rev);
  });

  it("missed (late): lock obtained after T + tol ⇒ MissedEntry(cause late) incl. intermediate occurrences", async () => {
    const t = approve(makeTask());
    const store = await setup(t, T8 - 5 * MIN);
    // watermark at 07:55; the claim for 10:00 arrives at 10:01:00.001 — 08:00 and 09:00 were never decided.
    const T10 = T8 + 2 * HOUR;
    E.clock.t = T10 + 60_001;
    const r = await autoClaim(store, { taskId: t.id, t: T10, armedSince: 0, holder: holder() });
    expect(r.kind).toBe("missed");
    const occ = readOk(store).occ[t.id]!;
    expect(occ.decidedThrough).toBe(T10);
    expect(occ.firedTotal).toBe(0);
    expect(occ.missedTotal).toBe(3);
    expect(occ.missedLog).toEqual([
      expect.objectContaining({
        seq: 1,
        from: T8 - 5 * MIN,
        to: T10,
        count: 3,
        totalAfter: 3,
        cause: "late",
        defHash: defHash(t),
      }),
    ]);
    expect(readOk(store).runs).toHaveLength(0);
  });

  it("exactly T + tol still fires; T + tol + 1ms is late", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 60_000;
    expect((await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).kind).toBe("fired");
    E.clock.t = T8 + HOUR + 60_001;
    expect((await autoClaim(store, { taskId: t.id, t: T8 + HOUR, armedSince: 0, holder: holder() })).kind).toBe(
      "missed",
    );
  });

  it("overlap (background): a non-terminal run (auto OR manual) ⇒ skippedTotal++, no new run", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    await manualClaim(store, { taskId: t.id, reqId: "req-aaaaaaaaaaaaaaaa", holder: holder() });
    const r = await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    expect(r).toMatchObject({ kind: "overlap", skipped: 1 });
    const s = readOk(store);
    expect(s.occ[t.id]).toMatchObject({ decidedThrough: T8, skippedTotal: 1, firedTotal: 0, missedTotal: 0 });
    expect(s.runs).toHaveLength(1);
  });

  it("message D13: an older queued run is dropped(coalesced), the new one queues", async () => {
    const t = approve(makeTask({ form: "message", feishu: false }));
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    const a = await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    expect(a.kind).toBe("fired");
    E.clock.t = T8 + HOUR + 1_000;
    const b = await autoClaim(store, { taskId: t.id, t: T8 + HOUR, armedSince: 0, holder: holder() });
    expect(b).toMatchObject({ kind: "fired", coalescedRunKey: `${t.id}@${T8}`, skipped: 1 });
    const s = readOk(store);
    expect(s.runs.map((r) => [r.runKey, r.state, r.reason])).toEqual([
      [`${t.id}@${T8}`, "dropped", "coalesced"],
      [`${t.id}@${T8 + HOUR}`, "queued", undefined],
    ]);
    expect(s.occ[t.id]).toMatchObject({ firedTotal: 2, skippedTotal: 1 });
  });

  it("ineligible cases write nothing: armed after T, not an occurrence, paused, unapproved, gate", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    const rev = readOk(store).rev;
    const h = holder();
    expect(await autoClaim(store, { taskId: t.id, t: T8, armedSince: T8 + 1, holder: h })).toMatchObject({
      reason: "armed-after",
    });
    expect(await autoClaim(store, { taskId: t.id, t: T8 + MIN, armedSince: 0, holder: h })).toMatchObject({
      reason: "not-occurrence",
    });
    expect(
      await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: h, gate: () => ({ code: "E_SECURE" }) }),
    ).toMatchObject({ kind: "ineligible", reason: "gate", detail: "E_SECURE" });
    expect(readOk(store).rev).toBe(rev);
  });

  it("cross-process pause: a stale timer of another process is stopped under the lock", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    const other = E.store(undefined, { epoch: "ep-other" });
    await other.transact((d) => {
      d.tasks[0]!.enabled = false;
      return { value: undefined, write: true };
    });
    E.clock.t = T8 + 1_000;
    expect(await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).toMatchObject({
      kind: "ineligible",
      reason: "not-executable",
    });
    expect(readOk(store).runs).toHaveLength(0);
  });

  it("rev conflict: a write between plan and lock forces a re-plan (still exactly one fire)", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    let injected = 0;
    const racing = {
      ...store,
      transactPlanned: ((plan, apply) =>
        store.transactPlanned((snap, now) => {
          const p = plan(snap, now);
          if (injected++ === 0) {
            // another view renames the task right after our snapshot
            void E.store(undefined, { epoch: "ep-x" }).transact((d) => {
              d.tasks[0]!.name = "renamed";
              return { value: undefined, write: true };
            });
          }
          return p;
        }, apply)) as typeof store.transactPlanned,
    };
    const r = await autoClaim(racing, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    expect(r.kind).toBe("fired");
    expect(injected).toBeGreaterThanOrEqual(2);
    expect(readOk(store).runs).toHaveLength(1);
    expect(readOk(store).tasks[0]!.name).toBe("renamed");
  });
});

describe("manual claim (§4.5b)", () => {
  it("runs at a non-cron minute and leaves decidedThrough / firedTotal / missedTotal / missedLog untouched", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 17 * MIN + 3_000;
    const before = structuredClone(readOk(store).occ[t.id]);
    const r = await manualClaim(store, {
      taskId: t.id,
      reqId: "fsAbCdEfGhIjKlMnOpQrStUvWxYz0123",
      defHash: defHash(t),
      holder: holder(),
    });
    expect(r).toMatchObject({ kind: "started", runKey: `${t.id}@m-20f1cd92`, replay: false });
    const s = readOk(store);
    expect(s.occ[t.id]).toEqual(before);
    expect(s.manualTotal[t.id]).toBe(1);
    expect(s.runs[0]).toMatchObject({ kind: "manual", scheduledAt: E.clock.t, state: "dispatching" });
  });

  it("replaying a reqId returns the recorded result (started or refused), without writing", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    const req = "req-bbbbbbbbbbbbbbbb";
    const a = await manualClaim(store, { taskId: t.id, reqId: req, holder: holder() });
    const rev = readOk(store).rev;
    const b = await manualClaim(store, { taskId: t.id, reqId: req, holder: holder() });
    expect(b).toMatchObject({ kind: "started", replay: true, runKey: (a as { runKey: string }).runKey });
    expect(readOk(store).rev).toBe(rev);
    // second, different request overlaps; replaying THAT request answers the same refusal
    const c = await manualClaim(store, { taskId: t.id, reqId: "req-cccccccccccccccc", holder: holder() });
    expect(c).toEqual({ kind: "refused", code: "E_OVERLAP", replay: false });
    const d = await manualClaim(store, { taskId: t.id, reqId: "req-cccccccccccccccc", holder: holder() });
    expect(d).toEqual({ kind: "refused", code: "E_OVERLAP", replay: true });
    expect(readOk(store).manualTotal[t.id]).toBe(1);
  });

  it("stale defHash ⇒ E_REV; unapproved ⇒ E_UNAPPROVED; gate ⇒ its code", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    const stale = "0".repeat(64);
    expect(
      await manualClaim(store, { taskId: t.id, reqId: "req-dddddddddddddddd", defHash: stale, holder: holder() }),
    ).toMatchObject({
      code: "E_REV",
    });
    expect(
      await manualClaim(store, {
        taskId: t.id,
        reqId: "req-eeeeeeeeeeeeeeee",
        holder: holder(),
        gate: () => ({ code: "E_NOT_OWNER" }),
      }),
    ).toMatchObject({ code: "E_NOT_OWNER" });
    const u = makeTask(); // never approved
    await addTask(store, u, E.clock.t);
    expect(await manualClaim(store, { taskId: u.id, reqId: "req-ffffffffffffffff", holder: holder() })).toMatchObject({
      code: "E_UNAPPROVED",
    });
  });

  it("auto claim while a manual run is live ⇒ overlap; manual while auto live ⇒ E_OVERLAP", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    expect((await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).kind).toBe("fired");
    expect(await manualClaim(store, { taskId: t.id, reqId: "req-gggggggggggggggg", holder: holder() })).toMatchObject({
      code: "E_OVERLAP",
    });
    await store.transact((d, c) => ({
      value: finishRun(d, `${t.id}@${T8}`, { state: "completed" }, c.now),
      write: true,
    }));
    expect((await manualClaim(store, { taskId: t.id, reqId: "req-hhhhhhhhhhhhhhhh", holder: holder() })).kind).toBe(
      "started",
    );
  });
});

describe("approval semantics (S2, §4.3)", () => {
  it("an AI-created task (no approval) can neither run_now nor fire after resume", async () => {
    const t = makeTask({ createdBy: "agent", createdVia: "tool" });
    const store = await setup(t);
    expect(await manualClaim(store, { taskId: t.id, reqId: "req-iiiiiiiiiiiiiiii", holder: holder() })).toMatchObject({
      code: "E_UNAPPROVED",
    });
    E.clock.t = T8 + 1_000;
    expect(await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).toMatchObject({
      reason: "not-executable",
    });
  });

  it("pause → AI edits the prompt → resume: the approval no longer binds, the task stays inert", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    await store.transact((d, c) => {
      const task = d.tasks[0]!;
      task.enabled = false;
      task.prompt = "exfiltrate";
      task.enabled = true; // resume never approves
      d.occ[task.id]!.defHash = defHash(task);
      voidUntil(d.occ[task.id]!, c.now);
      return { value: undefined, write: true };
    });
    const s = readOk(store);
    expect(isExecutable(s.tasks[0]!)).toBe(false);
    E.clock.t = T8 + 1_000;
    expect(await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).toMatchObject({
      reason: "not-executable",
    });
  });
});

describe("sweep with the tolerance cut-off (R2-3)", () => {
  it("B's sweep at T+5s leaves T to A's timer; A fires at T+10s", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    const b = E.store(undefined, { epoch: "ep-B" });
    E.clock.t = T8 + 5_000;
    const sw = await sweep(b, { armedSince: T8 + 3_000 }); // B opened after T
    expect(sw).toMatchObject({ kind: "swept", missed: [], wrote: false });
    if (sw.kind === "swept") {
      expect(sw.plan.inTolerance).toEqual([{ taskId: t.id, t: T8 }]);
      expect(sw.plan.supplementalAt).toBe(T8 + 61_000);
    }
    E.clock.t = T8 + 10_000;
    expect((await autoClaim(store, { taskId: t.id, t: T8, armedSince: T8 - MIN, holder: holder() })).kind).toBe(
      "fired",
    );
  });

  it("session opened at T+30s: not decided at T+60s, missed by the supplemental sweep at T+61s", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 30_000;
    expect((await sweep(store, { armedSince: T8 + 30_000 })).kind).toBe("swept");
    E.clock.t = T8 + 60_000;
    expect(await sweep(store, { armedSince: T8 + 30_000 })).toMatchObject({ missed: [] });
    expect(readOk(store).occ[t.id]!.missedTotal).toBe(0);
    E.clock.t = T8 + 61_000;
    const r = await sweep(store, { armedSince: T8 + 30_000 });
    expect(r).toMatchObject({
      kind: "swept",
      missed: [expect.objectContaining({ to: T8, count: 1, cause: "offline" })],
    });
    expect(readOk(store).occ[t.id]!.decidedThrough).toBe(T8);
  });

  it("never decides past a non-terminal run's T (claim moved the watermark first)", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    E.clock.t = T8 + 1_000;
    await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    E.clock.t = T8 + 30 * MIN;
    expect(await sweep(store)).toMatchObject({ missed: [] });
    expect(readOk(store).occ[t.id]).toMatchObject({ decidedThrough: T8, missedTotal: 0, firedTotal: 1 });
  });

  it("once: online ⇒ executed then disabled; offline ⇒ missed(once-past) after tolerance and disabled", async () => {
    const on = approve(makeTask({ when: { kind: "once", at: "2026-10-24T08:00", tz: "UTC" } }));
    const store = await setup(on);
    E.clock.t = T8 + 1_000;
    expect((await autoClaim(store, { taskId: on.id, t: T8, armedSince: 0, holder: holder() })).kind).toBe("fired");
    expect(readOk(store).tasks[0]!.enabled).toBe(false);

    const off = approve(makeTask({ when: { kind: "once", at: "2026-10-24T09:00", tz: "UTC" } }));
    await addTask(store, off, T8);
    E.clock.t = T8 + HOUR + 60_000;
    expect(await sweep(store)).toMatchObject({ missed: [] }); // still within tolerance
    E.clock.t = T8 + HOUR + 60_001;
    expect(await sweep(store)).toMatchObject({ missed: [expect.objectContaining({ cause: "once-past", count: 1 })] });
    expect(readOk(store).tasks.find((x) => x.id === off.id)!.enabled).toBe(false);
  });

  it("paused / unapproved tasks are not swept; voidUntil on resume makes the pause free", async () => {
    const t = approve(makeTask({ enabled: false }));
    const store = await setup(t);
    E.clock.t = T8 + 3 * HOUR;
    expect(await sweep(store)).toMatchObject({ missed: [], wrote: false });
    await store.transact((d, c) => {
      d.tasks[0]!.enabled = true;
      voidUntil(d.occ[t.id]!, c.now);
      return { value: undefined, write: true };
    });
    E.clock.t = T8 + 3 * HOUR + 5 * MIN;
    expect(await sweep(store)).toMatchObject({ missed: [] });
    expect(readOk(store).occ[t.id]!.missedTotal).toBe(0);
  });
});

describe("missedLog — the reconciliation numbers (R2-2)", () => {
  it("08 ok · 09 missed · 10 ok · 11+12 missed (open 12:30) ⇒ {(08,09],1} {(10,12],2}, missedTotal 3", async () => {
    const t = approve(makeTask());
    const store = await setup(t, T8 - 5 * MIN);
    const go = async (at: number, fire?: number): Promise<void> => {
      E.clock.t = at;
      await sweep(store, { armedSince: at });
      if (fire !== undefined)
        await autoClaim(store, { taskId: t.id, t: fire, armedSince: fire - MIN, holder: holder() });
    };
    await go(T8 + 1_000, T8); // 08:00 fired
    await store.transact((d, c) => ({
      value: finishRun(d, `${t.id}@${T8}`, { state: "completed" }, c.now),
      write: true,
    }));
    await go(T8 + HOUR + 30 * MIN); // reopened 09:30 ⇒ sweep decides 09:00 as missed
    await go(T8 + 2 * HOUR + 1_000, T8 + 2 * HOUR); // 10:00 fired
    await go(T8 + 4 * HOUR + 30 * MIN); // reopened 12:30
    const occ = readOk(store).occ[t.id]!;
    expect(occ.missedLog.map((e) => ({ from: e.from, to: e.to, count: e.count, totalAfter: e.totalAfter }))).toEqual([
      { from: T8, to: T8 + HOUR, count: 1, totalAfter: 1 },
      { from: T8 + 2 * HOUR, to: T8 + 4 * HOUR, count: 2, totalAfter: 3 },
    ]);
    expect(occ).toMatchObject({ missedTotal: 3, firedTotal: 2, decidedThrough: T8 + 4 * HOUR });
    // no successful run lies inside any missed interval
    for (const e of occ.missedLog)
      for (const r of readOk(store).runs) expect(r.scheduledAt > e.from && r.scheduledAt <= e.to).toBe(false);
  });

  it("a gap longer than the count cap is split into exact chunks", () => {
    const t = approve(makeTask({ when: { kind: "cron", expr: "* * * * *", tz: "UTC" } }));
    const state = {
      v: 1 as const,
      sessionId: "x",
      rev: 1,
      tasks: [t],
      occ: {
        [t.id]: {
          defHash: defHash(t),
          decidedThrough: T8,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      },
      manualTotal: {},
      runs: [],
      pendingReports: [],
      reportStats: { droppedIndexCap: 0 },
      manualReqs: {},
      digest: { shownMissedTotal: {}, shownRunsThrough: 0 },
    };
    const now = T8 + 12_000 * MIN + 61_000; // 12 000 minutes later (+ tolerance)
    const plan = planSweep(state, now);
    applySweep(state, plan, now);
    const occ = state.occ[t.id]!;
    expect(occ.missedLog.map((e) => e.count)).toEqual([10_000, 2_000]);
    expect(occ.missedLog[1]!.from).toBe(occ.missedLog[0]!.to);
    expect(occ.missedTotal).toBe(12_000);
    expect(occ.decidedThrough).toBe(T8 + 12_000 * MIN);
  });

  it("truncation keeps the newest 64 entries; missedTotal and totalAfter stay cumulative", async () => {
    const t = approve(makeTask());
    const store = await setup(t, T8 - 5 * MIN);
    for (let i = 0; i < 70; i++) {
      E.clock.t = T8 + i * HOUR + 2 * MIN; // each sweep decides exactly one hour as missed
      await sweep(store);
    }
    const occ = readOk(store).occ[t.id]!;
    expect(occ.missedLog).toHaveLength(SCHED_MISSED_LOG_MAX);
    expect(occ.missedTotal).toBe(70);
    expect(occ.missedLog[0]).toMatchObject({ seq: 7, totalAfter: 7 });
    expect(occ.missedLog.at(-1)).toMatchObject({ seq: 70, totalAfter: 70 });
  });
});

describe("definition changes and approval CAS (§4.3/§4.4)", () => {
  it("approve binds the reviewed hash; a concurrent edit during review ⇒ E_REV", async () => {
    const t = makeTask({ createdBy: "agent", createdVia: "tool" });
    const store = await setup(t);
    const reviewed = defHash(t);
    await changeTask(store, t.id, (task) => {
      task.prompt = "changed while the dialog was open";
    });
    expect(await approveTask(store, t.id, reviewed, "tui")).toMatchObject({ kind: "refused", code: "E_REV" });
    expect(isExecutable(readOk(store).tasks[0]!)).toBe(false);
    const fresh = defHash(readOk(store).tasks[0]!);
    expect(await approveTask(store, t.id, fresh, "web")).toMatchObject({ kind: "changed", hashChanged: false });
    expect(readOk(store).tasks[0]!.approval).toMatchObject({ hash: fresh, via: "web", by: "user" });
  });

  it("approving later voids what was owed while unapproved (never counted as missed)", async () => {
    const t = makeTask();
    const store = await setup(t, T8 - 5 * MIN);
    E.clock.t = T8 + 3 * HOUR;
    await approveTask(store, t.id, defHash(t), "tui");
    expect(readOk(store).occ[t.id]).toMatchObject({ decidedThrough: T8 + 3 * HOUR, missedTotal: 0 });
  });

  it("an execution-field edit first sweeps the OLD definition, then restarts the watermark at now", async () => {
    const t = approve(makeTask());
    const store = await setup(t, T8 - 5 * MIN);
    E.clock.t = T8 + 2 * HOUR + 30 * MIN; // 08:00, 09:00, 10:00 owed and past tolerance
    const r = await changeTask(store, t.id, (task) => {
      task.when = { kind: "cron", expr: "30 * * * *", tz: "UTC" };
    });
    expect(r).toMatchObject({
      kind: "changed",
      hashChanged: true,
      missed: [expect.objectContaining({ count: 3, cause: "offline" })],
    });
    const s = readOk(store);
    expect(s.occ[t.id]).toMatchObject({ defHash: defHash(s.tasks[0]!), decidedThrough: E.clock.t, missedTotal: 3 });
    expect(isExecutable(s.tasks[0]!)).toBe(false); // approval no longer binds (S2)
    // renaming never touches the hash
    const n = await changeTask(store, t.id, (task) => {
      task.name = "renamed";
    });
    expect(n).toMatchObject({ kind: "changed", hashChanged: false });
  });
});

/** Wrap a store so the test can move the clocks between a planned transaction's plan and its lock. */
function racing(store: SessionStore, afterPlan: (attempt: number) => void): SessionStore & { plans: () => number } {
  let n = 0;
  return {
    ...store,
    plans: () => n,
    transactPlanned: (plan, apply) =>
      store.transactPlanned((snap, now) => {
        const p = plan(snap, now);
        afterPlan(n++);
        return p;
      }, apply),
  };
}

describe("wall-clock rollback (review M1)", () => {
  async function fixed(task: ScheduleTask) {
    E = env(T8 - 5 * MIN);
    const mono = { t: 0 };
    const store = E.store(undefined, { monotonic: () => mono.t });
    await addTask(store, task, T8 - 5 * MIN);
    return { store, mono };
  }

  it("a late plan made at T+61s is void when the wall clock rolls back to T+1s before the lock ⇒ fired, never missed", async () => {
    const t = approve(makeTask());
    const { store } = await fixed(t);
    E.clock.t = T8 + 61_000;
    const s = racing(store, (i) => {
      if (i === 0) E.clock.t = T8 + 1_000; // rollback inside the plan→lock window
    });
    const r = await autoClaim(s, { taskId: t.id, t: T8, armedSince: 0, holder: holder() });
    expect(r.kind).toBe("fired");
    expect(s.plans()).toBe(2); // re-planned
    expect(readOk(store).occ[t.id]).toMatchObject({ firedTotal: 1, missedTotal: 0, decidedThrough: T8 });
  });

  it("wall clock before T ⇒ ineligible(early), no write (plan side and lock side)", async () => {
    const t = approve(makeTask());
    const { store } = await fixed(t);
    const rev = readOk(store).rev;
    E.clock.t = T8 - 120_000;
    expect(await autoClaim(store, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).toEqual({
      kind: "ineligible",
      reason: "early",
    });
    // planned at T+1s, rolled back to T−5s before the lock ⇒ re-planned ⇒ early
    E.clock.t = T8 + 1_000;
    const s = racing(store, (i) => {
      if (i === 0) E.clock.t = T8 - 5_000;
    });
    expect(await autoClaim(s, { taskId: t.id, t: T8, armedSince: 0, holder: holder() })).toMatchObject({
      reason: "early",
    });
    expect(readOk(store).rev).toBe(rev);
    expect(readOk(store).runs).toEqual([]);
  });

  it("transactPlanned: a wall jump the monotonic clock did not see (> 1 s) voids the plan; ≤ 1 s is tolerated", async () => {
    const t = approve(makeTask());
    const { store, mono } = await fixed(t);
    const plan = () => ({ plan: { validUntil: Number.POSITIVE_INFINITY } });
    const apply = (_d: unknown, _p: unknown, ctx: { now: number }) => ({ value: ctx.now, write: false });
    const base = E.clock.t;
    // +900 ms wall, monotonic still: tolerated (applied on the first plan)
    let s = racing(store, (i) => {
      if (i === 0) E.clock.t = base + 900;
    });
    expect(await s.transactPlanned(plan, apply)).toMatchObject({ ok: true, value: base + 900 });
    expect(s.plans()).toBe(1);
    // +1500 ms wall forward, monotonic still ⇒ re-planned once
    s = racing(store, (i) => {
      if (i === 0) E.clock.t += 1_500;
    });
    expect(await s.transactPlanned(plan, apply)).toMatchObject({ ok: true });
    expect(s.plans()).toBe(2);
    // the monotonic clock moving with the wall clock is a normal wait, not a jump
    s = racing(store, (i) => {
      if (i === 0) {
        E.clock.t += 5_000;
        mono.t += 5_000;
      }
    });
    expect(await s.transactPlanned(plan, apply)).toMatchObject({ ok: true });
    expect(s.plans()).toBe(1);
    // the clock keeps jumping ⇒ E_BUSY after 3 plans
    s = racing(store, () => {
      E.clock.t -= 10_000;
    });
    expect(await s.transactPlanned(plan, apply)).toMatchObject({ ok: false, code: "E_BUSY" });
    expect(s.plans()).toBe(3);
  });
});

describe("manual request capacity (review M2)", () => {
  const req = (i: number) => `req-${String(i).padStart(16, "0")}`;

  it("32 live requests ⇒ a NEW reqId is refused E_LIMIT (unrecorded); old ones still replay; expiry frees room", async () => {
    const t = approve(makeTask());
    const store = await setup(t);
    for (let i = 0; i < 32; i++) {
      const r = await manualClaim(store, { taskId: t.id, reqId: req(i), holder: holder() });
      expect(r).toMatchObject({ kind: "started", replay: false });
      await store.transact((d, c) => ({
        value: finishRun(d, (r as { runKey: string }).runKey, { state: "completed" }, c.now),
        write: true,
      }));
      E.clock.t += 1_000; // distinct manual minutes/keys
    }
    const s0 = readOk(store);
    expect(Object.keys(s0.manualReqs)).toHaveLength(32);
    expect(await manualClaim(store, { taskId: t.id, reqId: req(99), holder: holder() })).toEqual({
      kind: "refused",
      code: "E_LIMIT",
      replay: false,
    });
    const s1 = readOk(store);
    expect(s1.rev).toBe(s0.rev); // nothing written, nothing evicted
    expect(s1.manualReqs[req(99)]).toBeUndefined();
    expect(await manualClaim(store, { taskId: t.id, reqId: req(0), holder: holder() })).toMatchObject({
      kind: "started",
      replay: true,
    });
    expect(readOk(store).manualTotal[t.id]).toBe(32);
    // once the 24 h idempotency window of the oldest passes, a new request fits again
    E.clock.t = s0.manualReqs[req(0)]!.at + 24 * HOUR + 1;
    expect(await manualClaim(store, { taskId: t.id, reqId: req(99), holder: holder() })).toMatchObject({
      kind: "started",
      replay: false,
    });
  });
});

describe("definition change over a huge backlog (review m3)", () => {
  it("settles ALL old-definition misses (64×10 000 + 999 minutes) before switching definitions", async () => {
    const t = approve(makeTask({ when: { kind: "cron", expr: "* * * * *", tz: "UTC" } }));
    const t0 = T8 - 5 * MIN;
    const store = await setup(t, t0);
    const owed = SCHED_MISSED_LOG_MAX * 10_000 + 999;
    E.clock.t = t0 + owed * MIN + SCHED_FIRE_TOLERANCE_MS + 1; // sweepCut = t0 + owed minutes
    const r = await changeTask(store, t.id, (task) => {
      task.when = { kind: "cron", expr: "0 * * * *", tz: "UTC" };
    });
    expect(r).toMatchObject({ kind: "changed", hashChanged: true });
    const missed = (r as { missed: Array<{ count: number }> }).missed;
    expect(missed.reduce((a, m) => a + m.count, 0)).toBe(owed);
    const occ = readOk(store).occ[t.id]!;
    expect(occ.missedTotal).toBe(owed); // pre-fix: 640 000 (the 999 were voided by the new definition)
    expect(occ.decidedThrough).toBe(E.clock.t);
  }, 60_000);
});
