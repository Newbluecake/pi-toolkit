/**
 * Scheduled-reports W1 (docs/dev/scheduled-reports/plan.md r3 §5.6, §12 W1 行): pure, DOM-free
 * logic behind `SchedulePanel.vue` / `ScheduleReview.vue`, the detail-header 「定时」 entry and
 * the AgentCard ⏰ badge. Mirrors `logic/load.js`'s posture: components only render, every
 * decision lives here and is unit-tested in `tests/web-hub/ui/schedule-logic.test.ts`.
 *
 * Wire source: the hub-global SSE `schedules` event + `GET /api/schedules` payload —
 * `SchedulesPayloadWire` (protocol/schedule.ts, S0 frozen). W1 MUST ignore unknown keys
 * (H1 may only append optional fields).
 *
 * Bundle discipline (contract.js precedent): this module NEVER value-imports
 * `@protocol/schedule.ts` — that module imports typebox at top level and would drag it into
 * the browser bundle. The two string constants below are hand-mirrored literals, pinned
 * against the protocol module by `tests/web-hub/ui/logic-schedule-contract.test.ts`.
 *
 * Cap gating: hub caps ∋ `sched.v1` ⇒ the UI renders the entry points; without the cap every
 * surface stays byte-identical to the pre-feature shape (the reducer never receives a frame
 * because the transport only listens to the contract's SSE_EVENTS, which only grows when H1
 * adds the event on the hub side too).
 */

/** @typedef {import("@protocol/schedule.js").SchedulesPayloadWire} SchedulesPayloadWire */
/** @typedef {import("@protocol/schedule.js").ScheduleSessionProjectionWire} ScheduleSessionProjectionWire */
/** @typedef {import("@protocol/schedule.js").ScheduleTaskProjectionWire} ScheduleTaskProjectionWire */
/** @typedef {import("@protocol/schedule.js").ScheduleRunProjectionWire} ScheduleRunProjectionWire */
/** @typedef {import("@protocol/schedule.js").ScheduleTaskDef} ScheduleTaskDef */
/** @typedef {import("@protocol/schedule.js").ScheduleWhen} ScheduleWhen */
/** @typedef {import("@protocol/schedule.js").ScheduleRunState} ScheduleRunState */
/** @typedef {import("@protocol/schedule.js").ScheduleFeishuDisplay} ScheduleFeishuDisplay */

/** Hand mirror of `SCHED_HUB_CAP` (protocol/schedule.ts) — pinned by logic-schedule-contract.test.ts. */
export const SCHED_CAP = "sched.v1";
/** Hand mirror of `SCHED_SSE_EVENT` (protocol/schedule.ts) — pinned by logic-schedule-contract.test.ts. */
export const SCHED_EVENT = "schedules";

/** Badge count cap (display only): counts above this render as `99+` (xsUnread precedent). */
export const SCHED_BADGE_CAP = 99;

const record = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v) => (v === true || v === false ? v : undefined);

/** Hub caps advertise sched.v1? (Array of unknowns — mirrors xsUnreadOf's defensive read.) */
export function schedCapOn(hubCaps) {
  return Array.isArray(hubCaps) && hubCaps.includes(SCHED_CAP);
}

const RUN_STATES = new Set([
  "dispatching",
  "running",
  "queued",
  "dispatched",
  "bound",
  "aborting",
  "completed",
  "failed",
  "timed_out",
  "aborted",
  "refused",
  "settled",
  "continued",
  "unknown",
  "dropped",
]);
const NON_TERMINAL = new Set(["dispatching", "running", "queued", "dispatched", "bound", "aborting"]);
const FEISHU_STATES = new Set([
  "accepted",
  "sent",
  "failed",
  "uncertain",
  "refused",
  "none",
  "n/a",
  "waiting",
  "expired",
]);

/**
 * Structural receive-side gate for the `schedules` SSE frame / GET payload (untrusted JSON,
 * same discipline as `isLoadWireLike`). Deliberately LOOSE on the leaves: W1 must ignore
 * unknown keys and tolerate projections that grow optional fields (H1 append-only rule), so
 * only the fields the templates actually render are checked, and only for type, not domain.
 * Returns the payload unchanged (already the right shape) or undefined.
 * @param {unknown} d @returns {SchedulesPayloadWire | undefined}
 */
export function isSchedulesPayloadLike(d) {
  if (d === null || typeof d !== "object" || Array.isArray(d)) return undefined;
  const sessions = /** @type {{ sessions?: unknown }} */ (d).sessions;
  if (!Array.isArray(sessions)) return undefined;
  if (sessions.length > 64) return undefined; // spec: ≤64 session dirs — a bigger frame is junk
  for (const s of sessions) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return undefined;
    const sess = /** @type {Record<string, unknown>} */ (s);
    if (typeof sess.sessionId !== "string" || sess.sessionId === "" || sess.sessionId.length > 128) return undefined;
    if (typeof sess.rev !== "number" || !Number.isFinite(sess.rev)) return undefined;
    if (!Array.isArray(sess.tasks) || !Array.isArray(sess.runs)) return undefined;
    if (sess.tasks.length > 8 || sess.runs.length > 256) return undefined; // spec caps (8 tasks per session; runs list bounded)
  }
  return /** @type {SchedulesPayloadWire} */ (d);
}

/**
 * The projection of ONE session (by wire sessionId), or undefined.
 * @param {SchedulesPayloadWire | undefined} payload @param {string | undefined} sessionId
 * @returns {ScheduleSessionProjectionWire | undefined}
 */
export function sessionProjectionOf(payload, sessionId) {
  if (payload === undefined || typeof sessionId !== "string" || sessionId === "") return undefined;
  for (const s of payload.sessions) if (s.sessionId === sessionId) return s;
  return undefined;
}

/** @typedef {{ count: number, pending: boolean }} ScheduleBadge */
/**
 * AgentCard badge: `⏰<n>` while the session has tasks, `⏰!` when any task is pendingApproval.
 * undefined ⇒ nothing renders (no cap / no sessionId / no projection / zero tasks).
 * @param {unknown} hubCaps @param {SchedulesPayloadWire | undefined} payload @param {string | undefined} sessionId
 * @returns {ScheduleBadge | undefined}
 */
export function scheduleBadgeOf(hubCaps, payload, sessionId) {
  if (!schedCapOn(hubCaps)) return undefined;
  const proj = sessionProjectionOf(payload, sessionId);
  if (proj === undefined) return undefined;
  const count = proj.tasks.length;
  if (count === 0 && proj.degraded === undefined) return undefined;
  return { count, pending: proj.tasks.some((task) => task.pendingApproval === true) };
}

/** Badge text: `99+` saturation (xsUnreadLabel precedent). */
export function scheduleBadgeText(count) {
  return count > SCHED_BADGE_CAP ? `${SCHED_BADGE_CAP}+` : String(count);
}

/** Non-terminal run state (SCHEDULE_NON_TERMINAL_RUN_STATES mirror). */
export function isRunLive(state) {
  return NON_TERMINAL.has(state);
}

/** i18n leaf for a run state (schedule.runState.*). Unknown ⇒ "unknown". */
export function runStateKey(state) {
  return RUN_STATES.has(state) ? state : "unknown";
}

/**
 * i18n leaf for the Feishu receipt column (schedule.feishu.*). "?" is frontend-derived only
 * (§7.1: the hub never emits it — consult r1 Q3) — callers pass stale=true when the hub
 * connection is down, which maps every receipt to the "q" leaf. "n/a" maps to "na" (slash-free key).
 * @param {ScheduleFeishuDisplay | unknown} feishu @param {boolean} stale
 */
export function feishuKey(feishu, stale) {
  if (stale) return "q";
  if (feishu === "n/a") return "na";
  return typeof feishu === "string" && FEISHU_STATES.has(feishu) ? feishu : "q";
}

/** Zero-pad helper for fmtTs. */
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * `YYYY-MM-DD HH:mm` in the BROWSER's local timezone (display surface; the authoritative tz
 * math is the hub's cron core — `nextAt` arrives precomputed). Non-finite ⇒ "".
 * @param {number | undefined} ts @returns {string}
 */
export function fmtTs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Short relative "in 12h" / "3d 前"-style neutral duration token for `nextAt` (English tokens
 * only — the compact-inline-marker rule): `45m`, `12h`, `3d`. Past ⇒ "due".
 * @param {number | undefined} at @param {number} now @returns {string}
 */
export function relIn(at, now) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "due";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Human-readable summary of `task.when` WITHOUT a cron parser (首期: the expression renders
 * verbatim + tz; the hub-computed `nextAt` carries the authoritative next occurrence).
 * Returns i18n params, never a formatted string — locale lives in the component's t().
 * @param {ScheduleWhen | undefined} when
 * @returns {{ kind: "cron" | "once" | "invalid", expr: string, tz: string }}
 */
export function whenParts(when) {
  if (when === null || typeof when !== "object") return { kind: "invalid", expr: "", tz: "" };
  const w = /** @type {Record<string, unknown>} */ (when);
  const tz = str(w.tz) ?? "";
  if (w.kind === "cron") return { kind: "cron", expr: str(w.expr) ?? "", tz };
  if (w.kind === "once") return { kind: "once", expr: str(w.at) ?? "", tz };
  return { kind: "invalid", expr: "", tz };
}

/** `/schedule approve <id> <fullHash>` args (§5.6: the hash comes ONLY from the review dialog's
 *  projection; the agent does the lock-internal CAS). Callers pass the wire values through. */
export function approveArgs(taskId, defHash) {
  return `approve ${taskId} ${defHash}`;
}

/** First 8 hex chars of a defHash for display (§5.6「hash 前 8 位」). */
export function shortHash(defHash) {
  return typeof defHash === "string" ? defHash.slice(0, 8) : "";
}

/**
 * Panel view-model: everything `SchedulePanel.vue` renders, derived in one place.
 * @param {object} in_
 * @param {unknown} in_.hubCaps
 * @param {SchedulesPayloadWire | undefined} in_.payload
 * @param {string | undefined} in_.sessionId
 * @param {boolean} in_.offline   agent card down/stale ⇒ E3 read-only
 * @param {boolean} in_.stale     hub connection not open ⇒ panel-wide stale (feishu ⇒ "?")
 * @param {boolean} in_.canWrite  control channel available (online + cmd.v1 + command.v1)
 * @param {number} in_.now
 */
export function panelView(in_) {
  const proj = schedCapOn(in_.hubCaps) ? sessionProjectionOf(in_.payload, in_.sessionId) : undefined;
  if (proj === undefined) return { kind: "none" };
  if (typeof proj.degraded === "string" && proj.degraded !== "") {
    return { kind: "degraded", reason: proj.degraded, offline: in_.offline };
  }
  const tasks = proj.tasks.map((task) => {
    const t = record(task);
    const def = record(t.task);
    const totals = record(t.totals);
    return {
      id: str(def.id) ?? "",
      name: str(def.name) ?? "",
      form: str(def.form) === "message" ? "message" : "background",
      when: whenParts(/** @type {ScheduleWhen | undefined} */ (def.when)),
      enabled: bool(def.enabled) === true,
      executable: t.executable === true,
      pendingApproval: t.pendingApproval === true,
      createdBy: str(def.createdBy) ?? "user",
      feishu: bool(def.feishu) === true,
      nextAt: num(t.nextAt),
      degraded: t.degraded === "never",
      defHash: str(t.defHash) ?? "",
      totals: {
        fired: num(totals.fired) ?? 0,
        missed: num(totals.missed) ?? 0,
        skipped: num(totals.skipped) ?? 0,
        manual: num(totals.manual) ?? 0,
      },
    };
  });
  const taskName = new Map(tasks.map((task) => [task.id, task.name]));
  const runs = proj.runs.map((run) => {
    const r = record(run);
    const stateRaw = str(r.state);
    const state = stateRaw !== undefined && RUN_STATES.has(stateRaw) ? stateRaw : "unknown";
    return {
      runKey: str(r.runKey) ?? "",
      taskId: str(r.taskId) ?? "",
      taskName: taskName.get(str(r.taskId) ?? "") ?? "",
      kind: r.kind === "manual" ? "manual" : "auto",
      form: r.form === "message" ? "message" : "background",
      state,
      live: NON_TERMINAL.has(state),
      reason: str(r.reason),
      scheduledAt: num(r.scheduledAt),
      startedAt: num(r.startedAt),
      endedAt: num(r.endedAt),
      reportFile: str(r.reportFile),
      feishu: feishuKey(r.feishu, in_.stale),
    };
  });
  const droppedReports = num(record(proj).droppedReports) ?? 0;
  return {
    kind: "ready",
    offline: in_.offline,
    stale: in_.stale,
    canWrite: in_.canWrite && !in_.offline, // E3: offline sessions are read-only on web
    rev: num(record(proj).rev) ?? 0,
    tasks,
    runs,
    pendingCount: tasks.filter((task) => task.pendingApproval).length,
    missedTotal: tasks.reduce((acc, task) => acc + task.totals.missed, 0),
    droppedReports,
  };
}
