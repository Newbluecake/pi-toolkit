/**
 * F1 (scheduled reports #32, plan §7.1–§7.4): the Feishu side of schedule delivery. pi-free, closure state,
 * no timers. Three jobs:
 *
 *  1. `pushReport` — turn one pending report (found by H1's reader scan) into AT MOST ONE outbox final. The
 *     receipt (`state.scheduleReceipts`, key = reportId) is written to memory in the SAME synchronous section
 *     as `enqueueFinal`'s store.add, so both ride one `state.commit()`. Outbox settle (`sch:` requests) and a
 *     restart reconcile move the receipt on to sent / failed / uncertain; every change is reported to H1 via
 *     `onReceipts` (→ `sched_receipts` frames).
 *  2. `pushNotice` — "已错过" / "结果未知" notices, at-most-once (H1 persists its own state first), gated by the
 *     NoticeBudget `schedule` lane + a per-task-per-hour and a global-per-hour cap.
 *  3. `/schedule` list + run presentation helpers (frozen list generations, Chinese reply texts).
 *
 * Interface with H1 (src/web-hub/hub/schedule/**): H1 → F1 calls `pushReport` / `pushNotice` / `receiptsFor` /
 * `hasReceipt` (through `service.schedule`), supplies {@link FeishuSchedulePort} (projection rows, `run`) and
 * `receiptsChanged`. F1 never reads schedule files; the report text arrives lazily through `offer.read()`.
 */
import { createHash } from "node:crypto";
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import type { EnqueueFinalInput, EnqueueNoticeInput, EnqueueResult, OutboxMessage } from "./outbox.js";
import { renderNotice, renderReply, sanitizeLabel } from "./render.js";
import type { NoticeBudget } from "./security.js";
import {
  FEISHU_OUTBOX_FINAL_RESERVE,
  type FeishuScheduleReceipt,
  type ScheduleReceiptState,
  type StateUsage,
} from "./state.js";
import type { SettledGroup } from "./outbox.js";

// ---------------------------------------------------------------------------
// limits (§7.3)
// ---------------------------------------------------------------------------

export const SCHEDULE_REPORT_GLOBAL_PER_HOUR = 20;
export const SCHEDULE_REPORT_TASK_PER_HOUR = 6;
export const SCHEDULE_NOTICE_GLOBAL_PER_HOUR = 30;
export const SCHEDULE_REPORT_MAX_BYTES = 256 * 1024;
/** outbox must be below this share of its cap; state needs this much spare room; work lane this many free slots */
export const SCHEDULE_OUTBOX_SHARE = 0.5;
export const SCHEDULE_STATE_HEADROOM_BYTES = 512 * 1024;
export const SCHEDULE_WORK_HEADROOM = 64;
const WORK_CAP = 256;
export const SCHEDULE_LIST_TTL_MS = 10 * 60_000;
export const SCHEDULE_LIST_MAX_ROWS = 30;
const LIST_STORE_MAX = 64;
const HOUR_MS = 3_600_000;
const REQUEST_PREFIX = "sch:";
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/** Outbox request id of one report delivery (`sch:<reportId>`, ≤100 chars). */
export const scheduleRequestId = (reportId: string): string => `${REQUEST_PREFIX}${reportId}`;

// ---------------------------------------------------------------------------
// public types (the F1⇄H1 contract)
// ---------------------------------------------------------------------------

export interface ScheduleReportOffer {
  sessionId: string;
  /** display label of the owning session (untrusted ⇒ sanitized on render) */
  sessionLabel: string;
  reportId: string;
  /** Validated relative ledger path; filename is independent of the receipt/deduplication key. */
  reportFile?: string;
  runKey: string;
  taskId: string;
  taskName: string;
  /** terminal summary from `PendingReport.status` (`completed` | `failed` | `timed_out` | `aborted` …) */
  status: string;
  endedAt: number;
  expiresAt: number;
  /** Lazy report text (validated md); read only after every cheap gate passed. `undefined` ⇒ unreadable. */
  read(): string | undefined | Promise<string | undefined>;
}
export type ReportOutcome = "queued" | "skipped" | "waiting" | "n/a" | "expired" | "refused";
export interface ReportOfferResult {
  reportId: string;
  outcome: ReportOutcome;
  /** static reason for `refused` (the receipt `code`) */
  reason?: string;
}
export interface ScheduleReceiptView {
  reportId: string;
  state: ScheduleReceiptState;
  code?: string;
}

export type ScheduleNoticeKind = "missed" | "unknown" | "skipped";
export interface ScheduleNoticeInput {
  /** H1's stable, unique id of this notice (hashed into the outbox key) */
  key: string;
  sessionId: string;
  sessionLabel: string;
  taskId: string;
  taskName: string;
  kind: ScheduleNoticeKind;
  /** missed: number of missed occurrences (carry included) */
  count?: number;
  /** unknown: the run's scheduled time */
  at?: number;
  /** index-overflow increments to fold in */
  droppedIndex?: number;
}
export interface NoticeResult {
  outcome: "queued" | "refused";
  reason?: string;
}

/** One row of H1's `/schedule` projection. */
export interface FeishuScheduleRow {
  sessionId: string;
  sessionLabel: string;
  /** the owning session has exactly one live view declaring `sched.v1` */
  online: boolean;
  taskId: string;
  name: string;
  form: "background" | "message";
  /** human-readable schedule (e.g. `cron 0 9 * * 1-5 @ Asia/Shanghai`) */
  when: string;
  enabled: boolean;
  /** approved ∧ executable (pending-approval tasks are listed but cannot run) */
  approved: boolean;
  defHash: string;
  nextAt?: number;
  lastStatus?: string;
}
export interface ScheduleRunRequest {
  /** deterministic Feishu cmdId (`fs…`), stable across redelivery */
  reqId: string;
  sessionId: string;
  taskId: string;
  defHash: string;
}
export type ScheduleRunResult =
  | { kind: "started" }
  | { kind: "refused"; reason: string }
  | { kind: "offline" }
  | { kind: "multi" }
  | { kind: "timeout" }
  | { kind: "unavailable" };

/** H1 → F1 (`FeishuBotServiceDeps.schedule`). Absent ⇒ every schedule surface is inert (byte-identical). */
export interface FeishuSchedulePort {
  list(): readonly FeishuScheduleRow[];
  /** hub-side: online check, `sched_run` frame, ≤10 s ack wait. Must never reject. */
  run(req: ScheduleRunRequest): Promise<ScheduleRunResult>;
  /** F1 → hub: receipts of `sessionId` changed (hub pushes `sched_receipts`). Best-effort, never throws into F1. */
  receiptsChanged(sessionId: string, receipts: readonly ScheduleReceiptView[]): void;
}

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

export interface FeishuScheduleDeps {
  state: {
    scheduleReceipts: {
      get(reportId: string): FeishuScheduleReceipt | undefined;
      set(
        reportId: string,
        input: { sid: string; state: ScheduleReceiptState; code?: string },
      ): { ok: true; value: FeishuScheduleReceipt } | { ok: false; refused: string };
      list(filter?: { sid?: string }): Array<FeishuScheduleReceipt & { reportId: string }>;
      readonly size: number;
    };
    outbox: { list(): { kind: string; requestId?: string }[]; readonly size: number };
    usage(): Pick<StateUsage, "bytes" | "budget" | "reserve">;
    commit(): Promise<boolean>;
  };
  now(): number;
  owner(): string | undefined;
  /** ms epoch the bot credentials were installed; `undefined` ⇒ never configured */
  installedAt(): number | undefined;
  /** connector open (credentials exist but not open ⇒ wait) */
  ready(): boolean;
  budget: NoticeBudget;
  outbox: {
    enqueueFinal(input: EnqueueFinalInput): Promise<EnqueueResult>;
    enqueueNotice(input: EnqueueNoticeInput): Promise<EnqueueResult>;
  };
  /** md attachment upload (single-flight is enforced here); absent ⇒ overflow truncates */
  upload?(input: { bytes: Buffer; fileName: string }): Promise<{ ok: true; fileKey: string } | { ok: false }>;
  workSize(): number;
  /** `sched-<reason>` counters → `info().counters.dropped` */
  count(reason: string): void;
  onReceipts(sessionId: string, receipts: readonly ScheduleReceiptView[]): void;
  log?(e: { event: string; reason?: string }): void;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createFeishuSchedule(deps: FeishuScheduleDeps) {
  const inflight = new Set<string>();
  let uploadTail: Promise<unknown> = Promise.resolve();
  let hourOf = -1;
  const reportsGlobal = { n: 0 };
  const reportsTask = new Map<string, number>();
  const noticesGlobal = { n: 0 };
  const noticesTask = new Set<string>();
  /** budget-skipped reports waiting to be mentioned by the next notice of that task */
  const skipped = new Map<string, number>();

  const taskKey = (sid: string, taskId: string): string => `${sid}\0${taskId}`;
  function roll(): void {
    const h = Math.floor(deps.now() / HOUR_MS);
    if (h === hourOf) return;
    hourOf = h;
    reportsGlobal.n = 0;
    reportsTask.clear();
    noticesGlobal.n = 0;
    noticesTask.clear();
  }
  const count = (reason: string): void => {
    try {
      deps.count(`sched-${reason}`);
    } catch {
      /* diagnostic only */
    }
  };
  const view = (reportId: string, r: FeishuScheduleReceipt): ScheduleReceiptView => ({
    reportId,
    state: r.state,
    ...(r.code !== undefined ? { code: r.code } : {}),
  });
  function announce(sid: string, rows: ScheduleReceiptView[]): void {
    if (rows.length === 0) return;
    try {
      deps.onReceipts(sid, rows);
    } catch {
      /* hub push is best-effort; hello re-pushes */
    }
  }
  function setReceipt(
    reportId: string,
    sid: string,
    st: ScheduleReceiptState,
    code?: string,
  ): FeishuScheduleReceipt | undefined {
    const res = deps.state.scheduleReceipts.set(reportId, { sid, state: st, ...(code !== undefined ? { code } : {}) });
    return res.ok ? res.value : undefined;
  }
  function refuse(offer: ScheduleReportOffer, code: string): ReportOfferResult {
    const rec = setReceipt(offer.reportId, offer.sessionId, "refused", code);
    if (rec === undefined) {
      count("receipt-cap");
      return { reportId: offer.reportId, outcome: "refused", reason: "receipt" };
    }
    announce(offer.sessionId, [view(offer.reportId, rec)]);
    void deps.state.commit().catch(() => {});
    return { reportId: offer.reportId, outcome: "refused", reason: code };
  }
  function headroom(): boolean {
    const u = deps.state.usage();
    const outboxLimit = Math.floor(FEISHU_CAPS.outboxParts * SCHEDULE_OUTBOX_SHARE);
    if (deps.state.outbox.size >= outboxLimit) return false;
    if (u.budget - (u.bytes + u.reserve) < SCHEDULE_STATE_HEADROOM_BYTES) return false;
    if (deps.workSize() > WORK_CAP - SCHEDULE_WORK_HEADROOM) return false;
    return true;
  }

  async function uploadSerial(bytes: Buffer, fileName: string): Promise<{ ok: true; fileKey: string } | { ok: false }> {
    const upload = deps.upload;
    if (upload === undefined) return { ok: false };
    const run = uploadTail.then(
      () => upload({ bytes, fileName }),
      () => upload({ bytes, fileName }),
    );
    uploadTail = run.catch(() => {});
    try {
      return await run;
    } catch {
      return { ok: false };
    }
  }

  async function render(offer: ScheduleReportOffer, text: string): Promise<OutboxMessage[]> {
    const ok = offer.status === "completed";
    const label = `定时 · ${offer.taskName} · ${offer.sessionLabel}`;
    const body = `状态：${offer.status}\n\n${text}`;
    // The offer carries a validated ledger path. Only new short names override render's
    // original reply-<sid6>.md default; legacy 64hex paths keep that readable default.
    const attachmentFileName = offer.reportFile?.startsWith("reports/s_")
      ? offer.reportFile.slice("reports/".length)
      : undefined;
    const base = {
      kind: ok ? ("done" as const) : ("failed" as const),
      label,
      shortId: offer.sessionId,
      ...(attachmentFileName === undefined ? {} : { attachmentFileName }),
      text: ok ? body : text,
      ...(ok ? {} : { failure: { stopReason: offer.status } }),
    };
    const first = renderReply({ ...base, overflow: deps.upload !== undefined ? "file" : "truncate" });
    let messages: OutboxMessage[] = [...first.parts];
    if (first.overflow !== undefined) {
      const up = await uploadSerial(Buffer.from(first.overflow.fullText, "utf8"), first.overflow.fileName);
      if (up.ok) messages.push({ msgType: "file", content: JSON.stringify({ file_key: up.fileKey }) });
      else messages = [...renderReply({ ...base, overflow: "truncate" }).parts];
    }
    return messages;
  }

  async function pushReport(offer: ScheduleReportOffer): Promise<ReportOfferResult> {
    const id = offer.reportId;
    const out = (outcome: ReportOutcome): ReportOfferResult => ({ reportId: id, outcome });
    if (inflight.has(id)) return out("skipped");
    inflight.add(id);
    try {
      const installed = deps.installedAt();
      if (installed === undefined || offer.endedAt < installed) return out("n/a");
      if (deps.now() >= offer.expiresAt) return out("expired");
      if (deps.state.scheduleReceipts.get(id) !== undefined) return out("skipped");
      const owner = deps.owner();
      if (owner === undefined || !deps.ready()) return out("waiting");
      roll();
      const tk = taskKey(offer.sessionId, offer.taskId);
      if (
        reportsGlobal.n >= SCHEDULE_REPORT_GLOBAL_PER_HOUR ||
        (reportsTask.get(tk) ?? 0) >= SCHEDULE_REPORT_TASK_PER_HOUR
      ) {
        count("budget");
        skipped.set(tk, (skipped.get(tk) ?? 0) + 1);
        return refuse(offer, "budget");
      }
      if (!headroom()) {
        count("headroom");
        return refuse(offer, "headroom");
      }
      let text: string | undefined;
      try {
        text = await offer.read();
      } catch {
        text = undefined;
      }
      if (text === undefined) return refuse(offer, "file");
      if (utf8(text) > SCHEDULE_REPORT_MAX_BYTES)
        text = Buffer.from(text, "utf8")
          .subarray(0, SCHEDULE_REPORT_MAX_BYTES)
          .toString("utf8")
          .replace(/\uFFFD+$/u, "");
      const messages = await render(offer, text);
      // ---- one synchronous section from here: re-check, receipt (memory), enqueue (store.add) ----
      if (deps.state.scheduleReceipts.get(id) !== undefined) return out("skipped");
      roll();
      if (
        reportsGlobal.n >= SCHEDULE_REPORT_GLOBAL_PER_HOUR ||
        (reportsTask.get(tk) ?? 0) >= SCHEDULE_REPORT_TASK_PER_HOUR
      ) {
        count("budget");
        skipped.set(tk, (skipped.get(tk) ?? 0) + 1);
        return refuse(offer, "budget");
      }
      if (!headroom()) {
        count("headroom");
        return refuse(offer, "headroom");
      }
      const accepted = setReceipt(id, offer.sessionId, "accepted");
      if (accepted === undefined) {
        count("receipt-cap");
        return { reportId: id, outcome: "refused", reason: "receipt" };
      }
      const pending = deps.outbox.enqueueFinal({
        requestId: scheduleRequestId(id),
        target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: owner },
        messages,
        laneKey: owner,
      });
      reportsGlobal.n++;
      reportsTask.set(tk, (reportsTask.get(tk) ?? 0) + 1);
      // ---- end of the synchronous section ----
      let result: EnqueueResult;
      try {
        result = await pending;
      } catch {
        result = { ok: false, refused: "unavailable" };
      }
      if (!result.ok) {
        reportsGlobal.n = Math.max(0, reportsGlobal.n - 1);
        reportsTask.set(tk, Math.max(0, (reportsTask.get(tk) ?? 1) - 1));
        const rec = setReceipt(id, offer.sessionId, "refused", `outbox-${result.refused}`);
        if (rec !== undefined) announce(offer.sessionId, [view(id, rec)]);
        void deps.state.commit().catch(() => {});
        return { reportId: id, outcome: "refused", reason: `outbox-${result.refused}` };
      }
      // `durable:false` keeps the receipt `accepted`: the parts sit in the outbox and persist on the writer's
      // retry; a restart without them is exactly what `reconcile()` turns into `uncertain`.
      if (!result.durable) void deps.state.commit().catch(() => {});
      announce(offer.sessionId, [view(id, accepted)]);
      return out("queued");
    } finally {
      inflight.delete(id);
    }
  }

  /** Outbox `onSettled` hook for `sch:` finals. Returns whether the group was claimed. Throws on a failed commit. */
  async function settled(group: SettledGroup): Promise<boolean> {
    const rid = group.requestId;
    if (group.kind !== "final" || rid === undefined || !rid.startsWith(REQUEST_PREFIX)) return false;
    const id = rid.slice(REQUEST_PREFIX.length);
    const cur = deps.state.scheduleReceipts.get(id);
    if (cur === undefined) return true;
    let st: ScheduleReceiptState;
    let code: string | undefined;
    if (group.outcome === "delivered" && !group.swept) st = "sent";
    else if (group.outcome === "partial" || group.swept || group.code === "expired-uncertain") {
      st = "uncertain";
      code = group.swept ? "swept" : (group.code ?? "partial");
    } else {
      st = "failed";
      code = group.code ?? "failed";
    }
    const rec = setReceipt(id, cur.sid, st, code?.slice(0, 64));
    if (rec === undefined) return true;
    if (!(await deps.state.commit())) throw new Error("persist-failed");
    announce(cur.sid, [view(id, rec)]);
    return true;
  }

  /**
   * Boot-time reconcile (call BEFORE `outbox.start()`): an `accepted` receipt with no outbox group left means the
   * parts' fate is unknown (maybe sent) ⇒ `uncertain`, never resent.
   */
  async function reconcile(): Promise<void> {
    const live = new Set<string>();
    for (const p of deps.state.outbox.list())
      if (p.kind === "final" && p.requestId !== undefined) live.add(p.requestId);
    const bySession = new Map<string, ScheduleReceiptView[]>();
    for (const r of deps.state.scheduleReceipts.list()) {
      if (r.state !== "accepted" || live.has(scheduleRequestId(r.reportId))) continue;
      const rec = setReceipt(r.reportId, r.sid, "uncertain", "restart");
      if (rec === undefined) continue;
      const rows = bySession.get(r.sid) ?? [];
      rows.push(view(r.reportId, rec));
      bySession.set(r.sid, rows);
    }
    if (bySession.size === 0) return;
    await deps.state.commit().catch(() => false);
    for (const [sid, rows] of bySession) announce(sid, rows);
  }

  async function pushNotice(input: ScheduleNoticeInput): Promise<NoticeResult> {
    const no = (reason: string): NoticeResult => ({ outcome: "refused", reason });
    const owner = deps.owner();
    if (owner === undefined) return no("no-owner");
    roll();
    const tk = taskKey(input.sessionId, input.taskId);
    if (noticesTask.has(tk)) {
      count("notice-task-hour");
      return no("task-hour");
    }
    if (noticesGlobal.n >= SCHEDULE_NOTICE_GLOBAL_PER_HOUR) {
      count("notice-global-hour");
      return no("global-hour");
    }
    if (!headroom()) {
      count("headroom");
      return no("headroom");
    }
    const key = `schm:${createHash("sha256").update(input.key).digest("base64url").slice(0, 24)}`;
    if (!deps.budget.reserve(key, 0, { lane: "schedule" })) {
      count("notice-budget");
      return no("budget");
    }
    const parts: string[] = [];
    const where = `${input.taskName}（${input.sessionLabel}）`;
    if (input.kind === "missed")
      parts.push(
        `定时任务已错过：${where}，共错过 ${Math.max(1, input.count ?? 1)} 次（归属会话当时不在线，已跳过，不补跑）。`,
      );
    else if (input.kind === "unknown")
      parts.push(
        `定时任务结果未知：${where}${input.at !== undefined ? ` ${new Date(input.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}（运行中会话被关闭）。`,
      );
    else parts.push(`定时任务：${where}`);
    const skippedReports = skipped.get(tk) ?? 0;
    if (skippedReports > 0) parts.push(`本小时另有 ${skippedReports} 份报告未推送，请到会话或网页查看。`);
    if ((input.droppedIndex ?? 0) > 0)
      parts.push(`另有 ${input.droppedIndex} 份报告因索引已满未能登记，请到会话或网页查看。`);
    let res: EnqueueResult;
    try {
      res = await deps.outbox.enqueueNotice({
        target: { scope: "p2p", via: "send", receiveIdType: "open_id", receiveId: owner },
        message: renderNotice({ label: "定时任务", text: parts.join("\n") }),
        key,
        laneKey: owner,
      });
    } catch {
      res = { ok: false, refused: "unavailable" };
    }
    if (!res.ok) return no(`outbox-${res.refused}`);
    noticesTask.add(tk);
    noticesGlobal.n++;
    skipped.delete(tk);
    return { outcome: "queued" };
  }

  return {
    pushReport,
    pushNotice,
    settled,
    reconcile,
    receiptsFor(sessionId: string): ScheduleReceiptView[] {
      return deps.state.scheduleReceipts.list({ sid: sessionId }).map((r) => view(r.reportId, r));
    },
    hasReceipt(reportId: string): boolean {
      return deps.state.scheduleReceipts.get(reportId) !== undefined;
    },
  };
}
export type FeishuSchedule = ReturnType<typeof createFeishuSchedule>;

// ---------------------------------------------------------------------------
// `/schedule` presentation (list generations + replies)
// ---------------------------------------------------------------------------

export interface FrozenScheduleRow {
  sessionId: string;
  taskId: string;
  defHash: string;
  name: string;
  label: string;
}

/** Per (chat, operator) list generation: frozen `{sid, taskId, defHash}` rows, valid {@link SCHEDULE_LIST_TTL_MS}. */
export function createScheduleLists(now: () => number) {
  const lists = new Map<string, { at: number; rows: FrozenScheduleRow[] }>();
  const keyOf = (chatId: string, operator: string): string => `${chatId}\0${operator}`;
  return {
    freeze(chatId: string, operator: string, rows: FrozenScheduleRow[]): void {
      const t = now();
      for (const [k, v] of lists) if (t - v.at > SCHEDULE_LIST_TTL_MS) lists.delete(k);
      const key = keyOf(chatId, operator);
      lists.delete(key);
      while (lists.size >= LIST_STORE_MAX) lists.delete(lists.keys().next().value as string);
      lists.set(key, { at: t, rows });
    },
    pick(chatId: string, operator: string, n: number): FrozenScheduleRow | "expired" | "range" {
      const cur = lists.get(keyOf(chatId, operator));
      if (cur === undefined || now() - cur.at > SCHEDULE_LIST_TTL_MS) return "expired";
      return Number.isInteger(n) && n >= 1 ? (cur.rows[n - 1] ?? "range") : "range";
    },
    revokeOperator(operator: string): void {
      for (const k of [...lists.keys()]) if (k.endsWith(`\0${operator}`)) lists.delete(k);
    },
  };
}

/** Plain-text list body (rendered by `renderNotice`/card elsewhere — everything here is untrusted-safe text). */
export function scheduleListText(rows: readonly FeishuScheduleRow[]): { text: string; frozen: FrozenScheduleRow[] } {
  const shown = rows.slice(0, SCHEDULE_LIST_MAX_ROWS);
  const frozen = shown.map((r) => ({
    sessionId: r.sessionId,
    taskId: r.taskId,
    defHash: r.defHash,
    name: r.name,
    label: r.sessionLabel,
  }));
  if (shown.length === 0) return { text: "暂无定时任务。", frozen };
  const lines = shown.map((r, i) => {
    const flags = [
      r.approved ? (r.enabled ? "启用" : "已暂停") : "待批准",
      r.online ? "会话在线" : "会话离线",
      r.form === "background" ? "后台" : "消息",
    ];
    const next = r.nextAt !== undefined && r.enabled && r.approved ? ` · 下次 ${isoMinute(r.nextAt)}` : "";
    const last = r.lastStatus ? ` · 上次 ${r.lastStatus}` : "";
    return `${i + 1}. ${sanitizeLabel(r.name, 40)} [${sanitizeLabel(r.sessionLabel, 40)}] ${r.when} · ${flags.join(" · ")}${next}${last}`;
  });
  const more = rows.length > shown.length ? `\n…另有 ${rows.length - shown.length} 项，请到网页或终端查看` : "";
  return { text: `${lines.join("\n")}${more}\n\n/schedule run <序号> — 立即运行（需要归属会话在线）`, frozen };
}
function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function scheduleRunReply(row: FrozenScheduleRow, result: ScheduleRunResult): string {
  const who = `${sanitizeLabel(row.name, 40)}（${sanitizeLabel(row.label, 40)}）`;
  switch (result.kind) {
    case "started":
      return `已开始：${who}`;
    case "offline":
      return `归属会话不在线（${sanitizeLabel(row.label, 40)}），无法立即运行`;
    case "multi":
      return `会话在多处打开（${sanitizeLabel(row.label, 40)}），无法确定由哪一处执行`;
    case "timeout":
      return "执行结果未确认，请稍后用 /schedule 查看";
    case "unavailable":
      return "定时任务暂不可用，请稍后再试";
    case "refused": {
      const r = result.reason;
      if (r === "defhash" || r === "task-changed") return "任务已修改，请重新 /schedule";
      if (r === "not-approved" || r === "pending-approval") return `任务尚未批准：${who}`;
      if (r === "overlap" || r === "E_OVERLAP") return `任务正在运行：${who}`;
      return `拒绝运行：${/^[A-Za-z0-9_.:()-]{1,64}$/.test(r) ? r : "refused"}`;
    }
  }
}
