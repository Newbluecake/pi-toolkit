/**
 * `@logic/schedule.js` unit tests (scheduled-reports W1, plan r3 §5.6) — plus the contract
 * pins that keep the UI-side hand mirrors honest against the S0-frozen protocol module
 * (the bundle can never value-import `@protocol/schedule.ts` — typebox — so the two string
 * literals are mirrored by hand and pinned HERE; the tests run in Node where the protocol
 * module imports fine).
 */
import { describe, expect, it } from "vitest";
import {
  SCHED_CAP,
  SCHED_EVENT,
  feishuKey,
  fmtTs,
  isRunLive,
  isSchedulesPayloadLike,
  panelView,
  relIn,
  runReasonKey,
  runStateKey,
  scheduleBadgeOf,
  scheduleBadgeText,
  schedSummaryOf,
  sessionProjectionOf,
  taskRowsOf,
  whenParts,
  whenTextOf,
} from "../../../src/web-hub/ui/src/logic/schedule.js";
import { SCHED_HUB_CAP, SCHED_SSE_EVENT } from "../../../src/web-hub/protocol/schedule.js";
import { makePayload, makeRun, makeSession, makeTask, SCHED_SID } from "./fixtures/schedule.js";

describe("contract pins (UI hand mirrors vs protocol/schedule.ts)", () => {
  it("SCHED_CAP === SCHED_HUB_CAP, SCHED_EVENT === SCHED_SSE_EVENT", () => {
    expect(SCHED_CAP).toBe(SCHED_HUB_CAP);
    expect(SCHED_EVENT).toBe(SCHED_SSE_EVENT);
  });
});

describe("isSchedulesPayloadLike", () => {
  it("accepts the mock payload and keeps unknown keys (H1 append-only)", () => {
    const payload = makePayload();
    expect(isSchedulesPayloadLike(payload)).toBe(payload);
    const withExtra = { ...payload, futureField: { any: "thing" } };
    expect(isSchedulesPayloadLike(withExtra)).toBe(withExtra);
  });
  it("rejects malformed frames wholesale", () => {
    expect(isSchedulesPayloadLike(null)).toBeUndefined();
    expect(isSchedulesPayloadLike({})).toBeUndefined();
    expect(isSchedulesPayloadLike({ sessions: "x" })).toBeUndefined();
    expect(isSchedulesPayloadLike({ sessions: [{ sessionId: "" }] })).toBeUndefined();
    expect(isSchedulesPayloadLike({ sessions: [{ sessionId: "a", rev: "1", tasks: [], runs: [] }] })).toBeUndefined();
    expect(isSchedulesPayloadLike({ sessions: [{ sessionId: "a", rev: 1, tasks: "x", runs: [] }] })).toBeUndefined();
    // over the spec caps (8 tasks / 64 sessions)
    const tasks = Array.from({ length: 9 }, (_, i) => makeTask({ task: { id: `s_abcd23${i}5` } }));
    expect(isSchedulesPayloadLike({ sessions: [{ sessionId: "a", rev: 1, tasks, runs: [] }] })).toBeUndefined();
    const sessions = Array.from({ length: 65 }, (_, i) => ({ sessionId: `s${i}`, rev: 1, tasks: [], runs: [] }));
    expect(isSchedulesPayloadLike({ sessions })).toBeUndefined();
  });
});

describe("sessionProjectionOf / scheduleBadgeOf", () => {
  const payload = makePayload();
  it("finds by sessionId; unknown ⇒ undefined", () => {
    expect(sessionProjectionOf(payload, SCHED_SID)?.sessionId).toBe(SCHED_SID);
    expect(sessionProjectionOf(payload, "nope")).toBeUndefined();
    expect(sessionProjectionOf(undefined, SCHED_SID)).toBeUndefined();
  });
  it("badge: count-only; legacy pendingApproval/offer tasks count like any other; cap off / no projection / zero tasks ⇒ undefined", () => {
    // makePayload() includes makePendingTask() (pendingApproval: true + an offer, old-hub wire)
    // — the badge no longer carries a pending variant and counts it like any other task.
    expect(scheduleBadgeOf([SCHED_CAP], payload, SCHED_SID)).toEqual({ count: 2 });
    expect(scheduleBadgeOf([], payload, SCHED_SID)).toBeUndefined();
    expect(scheduleBadgeOf([SCHED_CAP], payload, "nope")).toBeUndefined();
    const empty = makePayload([makeSession({ tasks: [] })]);
    expect(scheduleBadgeOf([SCHED_CAP], empty, SCHED_SID)).toBeUndefined();
    // degraded store with zero tasks still badges (the user should see the repair hint exists)
    const degraded = makePayload([makeSession({ tasks: [], runs: [], degraded: "invalid-json" })]);
    expect(scheduleBadgeOf([SCHED_CAP], degraded, SCHED_SID)).toEqual({ count: 0 });
    const plain = makePayload([makeSession({ tasks: [makeTask()] })]);
    expect(scheduleBadgeOf([SCHED_CAP], plain, SCHED_SID)).toEqual({ count: 1 });
  });
  it("badge text saturates at 99+", () => {
    expect(scheduleBadgeText(2)).toBe("2");
    expect(scheduleBadgeText(100)).toBe("99+");
  });
});

describe("display helpers", () => {
  it("fmtTs renders YYYY-MM-DD HH:mm (browser-local tz); junk ⇒ empty", () => {
    // tz-independent: derive the expectation from the same Date methods.
    const d = new Date(0);
    const p2 = (n: number) => String(n).padStart(2, "0");
    expect(fmtTs(0)).toBe(`1970-01-01 ${p2(d.getHours())}:${p2(d.getMinutes())}`);
    expect(fmtTs(undefined)).toBe("");
    expect(fmtTs(Number.NaN)).toBe("");
  });
  it("relIn: minute/hour/day grains, past ⇒ due", () => {
    const now = 1_700_000_000_000;
    expect(relIn(now + 45 * 60_000, now)).toBe("45m");
    expect(relIn(now + 12 * 3_600_000, now)).toBe("12h");
    expect(relIn(now + 3 * 86_400_000, now)).toBe("3d");
    expect(relIn(now - 1, now)).toBe("due");
    expect(relIn(undefined, now)).toBe("");
  });
  it("whenParts: cron/once/invalid", () => {
    expect(whenParts({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" })).toEqual({
      kind: "cron",
      expr: "0 8 * * *",
      tz: "Asia/Shanghai",
    });
    expect(whenParts({ kind: "once", at: "2026-11-01T09:00", tz: "UTC" })).toEqual({
      kind: "once",
      expr: "2026-11-01T09:00",
      tz: "UTC",
    });
    expect(whenParts(undefined).kind).toBe("invalid");
  });
  it("runReasonKey: only dropped runs with a known reason map to an i18n leaf (I1)", () => {
    for (const r of [
      "coalesced",
      "owner-closed",
      "capability",
      "capability-unknown",
      "start-timeout",
      "task-changed",
    ]) {
      expect(runReasonKey("dropped", r)).toBe(r);
      expect(runReasonKey("unknown", r)).toBeUndefined();
    }
    expect(runReasonKey("dropped", "something-else")).toBeUndefined();
    expect(runReasonKey("dropped", undefined)).toBeUndefined();
  });

  it("runStateKey / isRunLive / feishuKey (stale ⇒ q; n/a ⇒ na)", () => {
    expect(runStateKey("completed")).toBe("completed");
    expect(runStateKey("bogus" as never)).toBe("unknown");
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("completed")).toBe(false);
    expect(feishuKey("sent", false)).toBe("sent");
    expect(feishuKey("n/a", false)).toBe("na");
    expect(feishuKey("sent", true)).toBe("q"); // stale overrides everything
    expect(feishuKey("bogus", false)).toBe("q");
  });
  it("whenTextOf: expression verbatim + tz suffix; invalid/empty ⇒ empty", () => {
    expect(whenTextOf({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" })).toBe("0 8 * * * (Asia/Shanghai)");
    expect(whenTextOf({ kind: "cron", expr: "0 8 * * *" })).toBe("0 8 * * *");
    expect(whenTextOf({ kind: "once", at: "2026-11-01T09:00", tz: "UTC" })).toBe("2026-11-01T09:00 (UTC)");
    expect(whenTextOf(undefined)).toBe("");
    expect(whenTextOf({ kind: "cron", expr: "" } as never)).toBe("");
  });
});

describe("legacy approval fields are ignored (r2 §6-W1, old-hub compat)", () => {
  it("a projection carrying pendingApproval/executable/offer/approval yields plain views (no approval surface at all)", () => {
    // the fixture session already carries the legacy shape (makePendingTask); every derived
    // view must come back approval-free — and the logic module no longer exports any
    // approval/offer helper (the import list of this file pins that).
    const payload = makePayload();
    const badge = scheduleBadgeOf([SCHED_CAP], payload, SCHED_SID);
    expect(badge).toEqual({ count: 2 });
    expect("pending" in (badge ?? {})).toBe(false);
    const summary = schedSummaryOf([SCHED_CAP], payload, SCHED_SID);
    expect(summary).toEqual({ count: 2, live: true });
    expect("pending" in (summary ?? {})).toBe(false);
    const rows = taskRowsOf(payload.sessions[0]!, 1_761_350_400_000);
    expect(rows.every((row) => !("pendingApproval" in row))).toBe(true);
  });
});

describe("panelView", () => {
  const payload = makePayload();
  const base = {
    hubCaps: [SCHED_CAP],
    payload,
    sessionId: SCHED_SID,
    offline: false,
    stale: false,
    canWrite: true,
    now: 0,
  };
  it("no cap ⇒ none (byte-identical pre-feature)", () => {
    expect(panelView({ ...base, hubCaps: [] }).kind).toBe("none");
    expect(panelView({ ...base, payload: undefined }).kind).toBe("none");
    expect(panelView({ ...base, sessionId: "nope" }).kind).toBe("none");
  });
  it("degraded projection ⇒ degraded kind with the reason", () => {
    const p = makePayload([makeSession({ tasks: [], runs: [], degraded: "invalid-json" })]);
    const v = panelView({ ...base, payload: p });
    expect(v).toMatchObject({ kind: "degraded", reason: "invalid-json" });
  });
  it("ready: tasks + runs normalized, missedTotal derived; legacy approval fields not projected", () => {
    const v = panelView(base);
    if (v.kind !== "ready") throw new Error("expected ready");
    expect(v.tasks).toHaveLength(2);
    expect(v.runs).toHaveLength(3);
    expect(v.missedTotal).toBe(0);
    expect(v.canWrite).toBe(true);
    expect(v.runs[1]?.taskName).toBe("每日晨报"); // joined from the task list
    // the fixture's legacy pending task yields a PLAIN task row (r2: approval removed)
    expect(
      v.tasks.every((task) => !("pendingApproval" in task) && !("executable" in task) && !("defHash" in task)),
    ).toBe(true);
    expect("pendingCount" in v).toBe(false);
  });
  it("offline ⇒ canWrite false (E3 read-only); stale ⇒ feishu q", () => {
    const off = panelView({ ...base, offline: true });
    if (off.kind !== "ready") throw new Error("expected ready");
    expect(off.canWrite).toBe(false);
    expect(off.runs[0]?.feishu).toBe("none"); // not stale ⇒ wire value
    const stale = panelView({ ...base, stale: true });
    if (stale.kind !== "ready") throw new Error("expected ready");
    expect(stale.runs.every((r) => r.feishu === "q")).toBe(true);
  });
  it("unknown wire state/kind values degrade to safe defaults", () => {
    const p = makePayload([
      makeSession({
        tasks: [],
        runs: [makeRun({ state: "bogus" as never, kind: "bogus" as never, reason: 42 as never })],
      }),
    ]);
    const v = panelView({ ...base, payload: p });
    if (v.kind !== "ready") throw new Error("expected ready");
    expect(v.runs[0]?.state).toBe("unknown");
    expect(v.runs[0]?.kind).toBe("auto");
    expect(v.runs[0]?.reason).toBeUndefined();
  });
  it("runs carry runId through; old wire without runId degrades to undefined (P3)", () => {
    const p = makePayload([
      makeSession({
        tasks: [],
        runs: [makeRun({ runId: "run-abc123" }), makeRun({ runKey: "s_abcd2345@older" })],
      }),
    ]);
    const v = panelView({ ...base, payload: p });
    if (v.kind !== "ready") throw new Error("expected ready");
    expect(v.runs[0]?.runId).toBe("run-abc123");
    expect(v.runs[1]?.runId).toBeUndefined(); // legacy wire: no link rendered
  });
});

describe("taskRowsOf (schedule-auto-approve §3-P3)", () => {
  const now = 1_761_350_400_000; // T0
  it("one row per task: identity/when/next/enabled fields (legacy pendingApproval ignored)", () => {
    const rows = taskRowsOf(makeSession(), now);
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first).toMatchObject({
      id: "s_abcd2345",
      name: "每日晨报",
      whenText: "0 8 * * * (Asia/Shanghai)",
      enabled: true,
    });
    expect(first?.nextIn).toBe("12h"); // nextAt = T0 + 12h
    const legacyPending = rows[1];
    expect(legacyPending).toMatchObject({ id: "s_efgh6789", enabled: true });
    expect(legacyPending?.nextIn).toBe("3d");
  });
  it("live flag + lastRun is the newest matching run (runs arrive most-recent-first)", () => {
    const rows = taskRowsOf(makeSession(), now);
    // s_abcd2345: first run is `running` (non-terminal) ⇒ live; it is also the newest ⇒ lastRun
    expect(rows[0]?.live).toBe(true);
    expect(rows[0]?.lastRun?.state).toBe("running");
    // s_efgh6789: only a timed_out run ⇒ not live; lastRun falls back to scheduledAt-less chain
    expect(rows[1]?.live).toBe(false);
    expect(rows[1]?.lastRun?.state).toBe("timed_out");
    expect(rows[1]?.lastRun?.at).toBeTypeOf("number");
  });
  it("lastRun carries runId; old wire without runId ⇒ undefined (no-link degradation)", () => {
    const withId = makeSession({
      tasks: [makeTask()],
      runs: [makeRun({ runId: "run-xyz789" })],
    });
    expect(taskRowsOf(withId, now)[0]?.lastRun?.runId).toBe("run-xyz789");
    const legacy = makeSession({ tasks: [makeTask()], runs: [makeRun()] });
    const row = taskRowsOf(legacy, now)[0];
    expect(row?.lastRun?.state).toBe("completed");
    expect(row?.lastRun?.runId).toBeUndefined();
  });
  it("no runs / unknown wire state degrade safely; malformed projections ⇒ []", () => {
    const noRuns = taskRowsOf(makeSession({ tasks: [makeTask()], runs: [] }), now);
    expect(noRuns[0]?.live).toBe(false);
    expect(noRuns[0]?.lastRun).toBeUndefined();
    const bogus = makeSession({
      tasks: [makeTask()],
      runs: [makeRun({ state: "bogus" as never })],
    });
    expect(taskRowsOf(bogus, now)[0]?.lastRun?.state).toBe("unknown");
    expect(taskRowsOf(undefined, now)).toEqual([]);
    expect(taskRowsOf(null, now)).toEqual([]);
    expect(taskRowsOf({ tasks: "x", runs: [] }, now)).toEqual([]);
    expect(taskRowsOf({ tasks: [{}], runs: [{}] }, now)).toEqual([
      {
        id: "",
        name: "",
        whenText: "",
        nextAt: undefined,
        nextIn: "",
        enabled: false,
        live: false,
        lastRun: undefined,
      },
    ]);
  });
});

describe("schedSummaryOf (schedule-auto-approve §3-P3)", () => {
  const payload = makePayload();
  it("gate: no cap / unknown session / zero tasks without degraded ⇒ undefined", () => {
    expect(schedSummaryOf([], payload, SCHED_SID)).toBeUndefined();
    expect(schedSummaryOf([SCHED_CAP], undefined, SCHED_SID)).toBeUndefined();
    expect(schedSummaryOf([SCHED_CAP], payload, "nope")).toBeUndefined();
    const empty = makePayload([makeSession({ tasks: [], runs: [] })]);
    expect(schedSummaryOf([SCHED_CAP], empty, SCHED_SID)).toBeUndefined();
  });
  it("count / live derived from the session projection (legacy pendingApproval ignored)", () => {
    // fixture: 2 tasks (one legacy-pendingApproval + offer), one `running` run ⇒ live
    expect(schedSummaryOf([SCHED_CAP], payload, SCHED_SID)).toEqual({ count: 2, live: true });
    const quiet = makePayload([
      makeSession({ tasks: [makeTask()], runs: [makeRun()] }), // completed run only
    ]);
    expect(schedSummaryOf([SCHED_CAP], quiet, SCHED_SID)).toEqual({ count: 1, live: false });
    // degraded store with zero tasks still surfaces (repair hint), live false
    const degraded = makePayload([makeSession({ tasks: [], runs: [], degraded: "invalid-json" })]);
    expect(schedSummaryOf([SCHED_CAP], degraded, SCHED_SID)).toEqual({ count: 0, live: false });
  });
});
