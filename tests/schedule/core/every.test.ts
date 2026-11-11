import { afterEach, describe, expect, it, vi } from "vitest";
import * as cronMath from "../../../src/schedule/core/cron.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileWhen,
  countOccurrences,
  formatLocal,
  isOccurrence,
  nextEvery,
  nextOccurrence,
  occurrencesBetween,
  parseEvery,
} from "../../../src/schedule/core/cron.js";
import { appendEveryMissed, planEveryDue, reconcileEvery } from "../../../src/schedule/core/interval.js";
import { autoClaim, changeTask, sweep } from "../../../src/schedule/core/claim.js";
import { isEpoch, emptyStateFile, defHash } from "../../../src/schedule/core/spec.js";
import { validateStateFile } from "../../../src/schedule/core/reader.js";
import { finishRun } from "../../../src/schedule/core/writer.js";
import { initOcc } from "../../../src/schedule/core/occurrence.js";
import { everyTask, seedEvery } from "./every-fixtures.js";
import { env, holder, readOk, type Env } from "./fixtures.js";
const A = Date.parse("2026-11-09T10:07:23Z");
const D = 5_400_000;
let e: Env | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});
const claim = (store: ReturnType<Env["store"]>, id: string, openedAt = A) =>
  reconcileEvery(store, {
    taskId: id,
    openedAt,
    holder: holder(),
    gate: () => undefined,
    deadlineMono: performance.now() + 10_000,
  });

describe("P1 interval arithmetic", () => {
  it.each([
    ["90m", D],
    ["1.5h", D],
    ["45s", 45_000],
    ["0.75m", 45_000],
    [" 30s ", 30_000],
    ["365d", 31_536_000_000],
    ["0.5m", 30_000],
  ])("normalizes %s exactly", (text, ms) => expect(parseEvery(String(text))).toEqual({ ok: true, everyMs: ms }));
  it.each([
    "0.001s",
    "30.001s",
    "90min",
    "1ms",
    "10s",
    "366d",
    "1e2s",
    "+30s",
    "030s",
    "1 h",
    "1h30m",
    "1w",
    "999999999d",
    "1.0000h",
    "30S",
    "",
    " ",
    "0s",
    "9".repeat(33),
  ])("rejects %s", (text) => expect(parseEvery(text).ok).toBe(false));
  it("starts at the committed anchor, retains seconds, strictly after and checks overflow", () => {
    const w = { kind: "every" as const, anchorAt: A, everyMs: D };
    expect(nextEvery(w, A)).toBe(Date.parse("2026-11-09T11:37:23Z"));
    expect(nextEvery(w, A + D)).toBe(Date.parse("2026-11-09T13:07:23Z"));
    expect(nextEvery({ ...w, everyMs: 45_000 }, A)).toBe(Date.parse("2026-11-09T10:08:08Z"));
    expect(nextEvery(w, A - 10_000)).toBe(A + D);
    expect(nextEvery({ ...w, anchorAt: 8_640_000_000_000_000 - 10_000 }, A)).toBeUndefined();
    expect(isEpoch(8_640_000_000_000_001)).toBe(false);
    expect(compileWhen({ ...w, anchorAt: -1 }).ok).toBe(false);
    const far = compileWhen({ kind: "every", anchorAt: Date.UTC(10000, 0, 1), everyMs: 30_000 });
    if (!far.ok) throw Error(far.error);
    expect(formatLocal(far.when, Date.UTC(10000, 0, 1, 0, 0, 30))).toBe("+010000-01-01 00:00:30");
  });
  it.each(["2026-03-08T06:30Z", "2026-11-01T05:30Z"])("DST and process TZ cannot affect UTC grid %s", (anchor) => {
    const w = { kind: "every" as const, anchorAt: Date.parse(anchor), everyMs: D };
    const c = compileWhen(w);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect("fmt" in c.when).toBe(false);
    const ts = occurrencesBetween(c.when, w.anchorAt, w.anchorAt + 48 * 3_600_000, 100);
    expect(ts).toHaveLength(32);
    expect(new Set(ts).size).toBe(32);
    expect(ts.every((t, i) => t === w.anchorAt + (i + 1) * D)).toBe(true);
    const old = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(nextOccurrence(c.when, w.anchorAt)).toBe(ts[0]);
      process.env.TZ = "Asia/Shanghai";
      expect(nextOccurrence(c.when, w.anchorAt)).toBe(ts[0]);
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
    expect(formatLocal(c.when, ts[0]!)).toBe(new Date(ts[0]!).toISOString().slice(0, 19).replace("T", " "));
    expect(countOccurrences(c.when, w.anchorAt, ts[2]!)).toEqual({ count: 3, capped: false });
    expect(isOccurrence(c.when, ts[0]!)).toBe(true);
    expect(isOccurrence(c.when, w.anchorAt)).toBe(false);
    expect(isOccurrence(c.when, ts[0]! + 1)).toBe(false);
    expect(countOccurrences(c.when, w.anchorAt, w.anchorAt + 10001 * D)).toEqual({ count: 10000, capped: true });
  });
});

describe("P1 one-window transaction", () => {
  it.each(["background", "message"] as const)(
    "aggregates N=3 into one latest %s run and never replays",
    async (form) => {
      e = env(A + 5 * 3_600_000);
      const store = e.store();
      const task = everyTask(A, D, form);
      seedEvery(store, [task], A);
      expect((await sweep(store)).kind).toBe("swept");
      expect(readOk(store).occ[task.id]!.missedTotal).toBe(0);
      expect((await autoClaim(store, { taskId: task.id, t: A + D, armedSince: A, holder: holder() })).kind).toBe(
        "ineligible",
      );
      const r = await claim(store, task.id, e.clock.t);
      expect(r.kind).toBe("fired");
      const state = readOk(store);
      expect(state.v).toBe(2);
      expect(state.rev).toBe(1);
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0]).toMatchObject({
        scheduledAt: A + 3 * D,
        state: form === "background" ? "dispatching" : "queued",
        catchUp: { cause: "reopen", dueCount: 3, fromExclusive: A, through: A + 3 * D, recoveredAt: e.clock.t },
      });
      expect(state.occ[task.id]).toMatchObject({
        decidedThrough: A + 3 * D,
        firedTotal: 1,
        missedTotal: 2,
        skippedTotal: 0,
      });
      expect((await claim(store, task.id, e.clock.t + 1)).kind).toBe("lost");
      expect(readOk(store).rev).toBe(1);
      expect(nextEvery(task.when as { kind: "every"; everyMs: number; anchorAt: number }, e.clock.t)).toBe(A + 4 * D);
    },
  );
  it.each(["background", "message"] as const)(
    "existing %s live run skips the whole new window without replacing it",
    async (form) => {
      e = env(A + D);
      const store = e.store();
      const task = everyTask(A, D, form);
      seedEvery(store, [task], A);
      await claim(store, task.id);
      e.clock.t = A + 4 * D;
      expect(await claim(store, task.id)).toMatchObject({ kind: "overlap", skipped: 3 });
      expect(readOk(store).runs).toHaveLength(1);
      expect(readOk(store).occ[task.id]).toMatchObject({
        firedTotal: 1,
        skippedTotal: 3,
        missedTotal: 0,
        decidedThrough: A + 4 * D,
      });
    },
  );
  it.each([0, 1])("24h grace inclusive, expired plans still commit instead of E_BUSY (+%dms)", async (extra) => {
    const long = 365 * 86_400_000;
    e = env(A + long + 86_400_000 + extra);
    const store = e.store();
    const t = everyTask(A, long);
    seedEvery(store, [t], A);
    expect((await claim(store, t.id)).kind).toBe(extra === 0 ? "fired" : "missed");
    expect(readOk(store).occ[t.id]).toMatchObject({
      decidedThrough: A + long,
      firedTotal: extra === 0 ? 1 : 0,
      missedTotal: extra,
    });
  });
  it("multi-year short-period gap still attempts only one latest representative", async () => {
    e = env(A + 20 * 365 * 86_400_000);
    const store = e.store();
    const t = everyTask(A, 30_000);
    seedEvery(store, [t], A);
    await claim(store, t.id, e.clock.t);
    expect(readOk(store).runs).toHaveLength(1);
    expect(readOk(store).runs[0]!.catchUp!.dueCount).toBe(21_024_000);
  });
  it("gate refuses without rev/file change and later accepts the same window", async () => {
    e = env(A + 3 * D);
    const store = e.store();
    const t = everyTask(A);
    seedEvery(store, [t], A);
    const file = join(store.root.real, store.dirName, "state.json");
    const before = readFileSync(file);
    const r = await reconcileEvery(store, {
      taskId: t.id,
      holder: holder(),
      openedAt: e.clock.t,
      deadlineMono: performance.now() + 1000,
      gate: () => ({ code: "E_BUSY" }),
    });
    expect(r).toMatchObject({ kind: "ineligible", reason: "gate", detail: "E_BUSY" });
    expect(readFileSync(file)).toEqual(before);
    expect((await claim(store, t.id, e.clock.t)).kind).toBe("fired");
  });
  it("expired round starts zero plans or locks", async () => {
    e = env(A + D);
    const store = e.store();
    const t = everyTask(A);
    seedEvery(store, [t], A);
    const spy = vi.spyOn(store, "read");
    const r = await reconcileEvery(store, {
      taskId: t.id,
      holder: holder(),
      openedAt: A,
      deadlineMono: performance.now() - 1,
      gate: () => undefined,
    });
    expect(r).toMatchObject({ kind: "error", code: "E_BUSY" });
    expect(spy).not.toHaveBeenCalled();
    expect(readOk(store).rev).toBe(0);
  });
  it.each(["background", "message"] as const)(
    "pause/resume %s retains grid, clears empty resume, definition change reanchors",
    async (form) => {
      e = env(A);
      const store = e.store();
      const t = everyTask(A, D, form);
      seedEvery(store, [t], A);
      await changeTask(store, t.id, (task) => {
        task.enabled = false;
      });
      const rev = readOk(store).rev;
      await changeTask(store, t.id, (task) => {
        task.enabled = false;
      });
      expect(readOk(store).rev).toBe(rev);
      e.clock.t = A + 3 * 3_600_000;
      await changeTask(store, t.id, (task) => {
        task.enabled = true;
      });
      expect(readOk(store).occ[t.id]!.resumePending).toBe(true);
      await claim(store, t.id, e.clock.t + 1);
      expect(readOk(store).runs[0]!.catchUp).toMatchObject({ cause: "resume", dueCount: 2 });
      await store.transact((d) => {
        finishRun(d, d.runs[0]!.runKey, { state: "completed" }, e!.clock.t);
        return { value: undefined, write: true };
      });
      await changeTask(store, t.id, (task) => {
        task.enabled = false;
      });
      e.clock.t += 1000;
      await changeTask(store, t.id, (task) => {
        task.enabled = true;
      });
      await claim(store, t.id);
      expect(readOk(store).occ[t.id]!.resumePending).toBeUndefined();
      expect(readOk(store).runs).toHaveLength(1);
      const hash = defHash(readOk(store).tasks[0]!);
      await changeTask(store, t.id, (task) => {
        task.name = "renamed";
      });
      expect(defHash(readOk(store).tasks[0]!)).toBe(hash);
      await changeTask(store, t.id, (task) => {
        task.prompt = "changed execution";
      });
      expect(readOk(store).tasks[0]!.when).toEqual({ kind: "every", everyMs: D, anchorAt: e.clock.t });
      expect(readOk(store).occ[t.id]!.decidedThrough).toBe(e.clock.t);
    },
  );
  it("pause decides its old overdue window as paused in the same write", async () => {
    e = env(A + 3 * D);
    const store = e.store();
    const t = everyTask(A);
    seedEvery(store, [t], A);
    await changeTask(store, t.id, (task) => {
      task.enabled = false;
    });
    expect(readOk(store).rev).toBe(1);
    expect(readOk(store).occ[t.id]).toMatchObject({
      missedTotal: 3,
      decidedThrough: A + 3 * D,
      missedLog: [expect.objectContaining({ cause: "paused", count: 3 })],
    });
  });
});

describe("P1 labels, bounded accounting and version contract", () => {
  it.each([
    [false, A, A + D + 1, undefined],
    [false, A + D, A + D + 1, undefined],
    [false, A + D + 1, A + D + 1, "reopen"],
    [true, A + D + 1, A + D + 1, "resume"],
    [false, A, A + 2 * D, "late"],
    [false, A, A + D + 60_000, undefined],
    [false, A, A + D + 60_001, "late"],
  ] as const)("fixed snapshot label pending=%s opened=%s now=%s", (pending, opened, now, cause) => {
    const t = everyTask(A);
    const occ = { ...initOcc(t, A), ...(pending ? { resumePending: true as const } : {}) };
    const p = planEveryDue(t, occ, now, opened);
    expect(p.catchUp?.cause).toBe(cause);
  });
  it("N=1,000,000,123 produces at most 64 chunks with exact sequence/total/range arithmetic", () => {
    const t = everyTask(0, 30_000);
    if (t.when.kind !== "every") throw Error();
    const o = initOcc(t, 0);
    o.missedTotal = 11;
    o.missedLog = [{ seq: 5, defHash: defHash(t), from: 0, to: 0, count: 11, totalAfter: 11, at: 0, cause: "late" }];
    const M = 1_000_000_123 - 1,
      C = Math.ceil(M / 10_000);
    const steps = vi.fn();
    appendEveryMissed(o, t.when, M, defHash(t), "late", M * 30_000, steps);
    expect(steps).toHaveBeenCalledTimes(64);
    expect(o.missedLog).toHaveLength(64);
    expect(o.missedTotal).toBe(11 + M);
    o.missedLog.forEach((entry, i) => {
      const j = C - 64 + i;
      const count = Math.min(10_000, M - j * 10_000);
      expect(entry).toMatchObject({
        seq: 5 + j + 1,
        from: j * 10_000 * 30_000,
        to: (j * 10_000 + count) * 30_000,
        count,
        totalAfter: 11 + j * 10_000 + count,
      });
    });
    expect(o.missedLog.at(-1)).toMatchObject({ seq: 5 + C, totalAfter: 11 + M });
  });
  it("v2 validates every, resume/catch-up; v1 rejects them; unknown v is not repaired", async () => {
    e = env(A + D);
    const store = e.store();
    const t = everyTask(A);
    const s = seedEvery(store, [t], A, true);
    expect(validateStateFile(s).ok).toBe(true);
    expect(validateStateFile({ ...s, v: 1 }).ok).toBe(false);
    for (const when of [
      { ...t.when, tz: "UTC" },
      { kind: "every", everyMs: 30_001, anchorAt: A },
      { kind: "every", everyMs: D, anchorAt: NaN },
    ])
      expect(validateStateFile({ ...s, tasks: [{ ...t, when }] }).ok).toBe(false);
    await claim(store, t.id);
    const good = readOk(store);
    expect(validateStateFile(good).ok).toBe(true);
    expect(validateStateFile({ ...good, occ: { [t.id]: { ...good.occ[t.id], resumePending: false } } }).ok).toBe(false);
    const bad = structuredClone(good);
    bad.runs[0]!.catchUp!.dueCount = 0;
    expect(validateStateFile(bad).ok).toBe(false);
    await store.transact((d) => {
      finishRun(d, d.runs[0]!.runKey, { state: "completed" }, A + D);
      return { value: undefined, write: true };
    });
    expect(readOk(store).v).toBe(2);
    const file = join(store.root.real, store.dirName, "state.json");
    const bytes = JSON.stringify({ ...good, v: 3 });
    writeFileSync(file, bytes);
    expect(await store.repair()).toMatchObject({ ok: false, code: "E_DEGRADED" });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
  it("ordinary writer cannot introduce every or v2 into v1 without explicit migration", async () => {
    e = env(A);
    const store = e.store();
    const t = everyTask(A);
    const r = await store.transact((d) => {
      d.tasks.push(t);
      d.occ[t.id] = initOcc(t, A);
      d.v = 2;
      return { value: undefined, write: true };
    });
    expect(r).toMatchObject({ ok: false, code: "E_DEGRADED" });
    expect(store.read().kind).toBe("absent");
    expect(emptyStateFile(store.sessionId).v).toBe(1);
  });
});

describe("writer attempt budgets observed at real flock boundary", () => {
  it("one reconcile starts at most three plan/lock attempts even under continuous clock skew", async () => {
    e = env(A + D);
    let attempts = 0;
    const store = e.store(undefined, {
      faults: (point) => {
        if (point === "lock-held") {
          attempts++;
          e!.clock.t += 2000;
        }
      },
    });
    const t = everyTask(A);
    seedEvery(store, [t], A);
    expect(await claim(store, t.id)).toMatchObject({ kind: "error", code: "E_BUSY" });
    expect(attempts).toBe(3);
    expect(readOk(store).rev).toBe(0);
    expect(readOk(store).runs).toEqual([]);
  });
  it("deadline is checked again before any replan/locked apply and bounds remaining lock budget", async () => {
    e = env(A + D);
    let attempts = 0,
      m = 0;
    const store = e.store(undefined, {
      monotonic: () => m,
      faults: (point) => {
        if (point === "lock-held") {
          attempts++;
          m += 6000;
        }
      },
    });
    const t = everyTask(A);
    seedEvery(store, [t], A);
    const r = await reconcileEvery(store, {
      taskId: t.id,
      holder: holder(),
      openedAt: A,
      deadlineMono: 10_000,
      gate: () => undefined,
    });
    expect(r).toMatchObject({ kind: "error", code: "E_BUSY" });
    expect(attempts).toBe(2);
    expect(readOk(store).rev).toBe(0);
  });
});

it("explicit repair of a structurally damaged recognized v2 preserves v2 and quarantines original bytes", async () => {
  e = env(A);
  const store = e.store();
  const state = seedEvery(store, [everyTask(A)], A);
  const file = join(store.root.real, store.dirName, "state.json");
  const bytes = JSON.stringify({ ...state, rev: -1 });
  writeFileSync(file, bytes);
  expect(await store.repair()).toMatchObject({ ok: true, value: { quarantined: true } });
  expect(readOk(store)).toMatchObject({ v: 2, rev: 1, tasks: [] });
  expect(readFileSync(`${file}.bak`, "utf8")).toBe(bytes);
});

it("a billion-point reconciliation never enters the legacy occurrence enumerator", async () => {
  const N = 1_000_000_123;
  e = env(N * 30_000);
  const store = e.store();
  const task = everyTask(0, 30_000);
  seedEvery(store, [task], 0);
  const enumeration = vi.spyOn(cronMath, "occurrencesBetween").mockImplementation(() => {
    throw new Error("legacy enumeration must not run");
  });
  try {
    const result = await claim(store, task.id, e.clock.t);
    expect(result.kind).toBe("fired");
    expect(enumeration).not.toHaveBeenCalled();
    expect(readOk(store).occ[task.id]).toMatchObject({ firedTotal: 1, missedTotal: N - 1, decidedThrough: N * 30_000 });
    expect(readOk(store).occ[task.id]!.missedLog).toHaveLength(64);
    expect(readOk(store).runs).toHaveLength(1);
    expect(readOk(store).runs[0]!.catchUp).toMatchObject({ dueCount: N, through: N * 30_000 });
  } finally {
    enumeration.mockRestore();
  }
});
