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
  approveArgs,
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
  sessionProjectionOf,
  shortHash,
  whenParts,
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
  it("badge: count + pending flag; cap off / no projection / zero tasks ⇒ undefined", () => {
    expect(scheduleBadgeOf([SCHED_CAP], payload, SCHED_SID)).toEqual({ count: 2, pending: true });
    expect(scheduleBadgeOf([], payload, SCHED_SID)).toBeUndefined();
    expect(scheduleBadgeOf([SCHED_CAP], payload, "nope")).toBeUndefined();
    const empty = makePayload([makeSession({ tasks: [] })]);
    expect(scheduleBadgeOf([SCHED_CAP], empty, SCHED_SID)).toBeUndefined();
    // degraded store with zero tasks still badges (the user should see the repair hint exists)
    const degraded = makePayload([makeSession({ tasks: [], runs: [], degraded: "invalid-json" })]);
    expect(scheduleBadgeOf([SCHED_CAP], degraded, SCHED_SID)).toEqual({ count: 0, pending: false });
    // no pending task ⇒ pending:false
    const plain = makePayload([makeSession({ tasks: [makeTask()] })]);
    expect(scheduleBadgeOf([SCHED_CAP], plain, SCHED_SID)).toEqual({ count: 1, pending: false });
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
  it("approveArgs / shortHash", () => {
    expect(approveArgs("s_abcd2345", "fd9fcbba".repeat(8))).toBe(`approve s_abcd2345 ${"fd9fcbba".repeat(8)}`);
    expect(shortHash("1b4611e2ff4f7bc06a36a751b84306214878c05506d49e70aec1d8394ec06655")).toBe("1b4611e2");
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
  it("ready: tasks + runs normalized, pendingCount / missedTotal derived", () => {
    const v = panelView(base);
    if (v.kind !== "ready") throw new Error("expected ready");
    expect(v.tasks).toHaveLength(2);
    expect(v.runs).toHaveLength(3);
    expect(v.pendingCount).toBe(1);
    expect(v.canWrite).toBe(true);
    expect(v.runs[1]?.taskName).toBe("每日晨报"); // joined from the task list
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
});
