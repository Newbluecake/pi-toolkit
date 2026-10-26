/**
 * scheduled-reports plan r3 §7.1–§7.4 (H1 r2) — the H1⇄F1 seam, NOW ALIGNED WITH F1'S COMMITTED
 * INTERFACE (`src/web-hub/hub/feishu/schedule.ts`, commit 7766997b; review round 1's verify
 * major). The round-1 `ScheduleBotIntegration` duck binding is gone.
 *
 * Direction map (all types are F1's own — imported here so the two sides can never drift):
 *   - H1 IMPLEMENTS `FeishuSchedulePort` (`list` / `run` / `receiptsChanged`) and hub.ts injects
 *     it into `FeishuBotServiceDeps.schedule` at CONSTRUCTION time (F1 builds its whole schedule
 *     surface iff the port is present; absent ⇒ byte-identical bot).
 *   - After `bot.start()`, hub.ts hands F1's `service.schedule` (a `FeishuSchedule`:
 *     pushReport / pushNotice / receiptsFor / hasReceipt) back to the coordinator via
 *     `bindDelivery` — discovery, notices and receipt views flow through it from then on.
 *   - `sched_bound` frames (§7.5) arrive at the coordinator (agent-server routes them there
 *     before the registry); hub.ts wires `setBoundTap` so the bot's own event listener receives
 *     them as `{type:"sched_bound"}` FeishuServiceEvents, exactly as F1's service expects.
 *   - `sched_run_ack` frames resolve the ≤10s waiters of the port's `run()` (§7.4).
 *
 * Until `bindDelivery` lands (bot starting / bot off), pending accumulators simply wait —
 * nothing is consumed without a successful delivery (review r1 #5).
 */
import type {
  FeishuSchedule,
  FeishuScheduleOfferClosed,
  FeishuScheduleOfferRow,
  FeishuSchedulePort,
  ScheduleDecideRequest,
  ScheduleDecideResult,
  NoticeResult,
  ReportOfferResult,
  ScheduleNoticeInput,
  ScheduleReceiptView,
  ScheduleReportOffer,
  ScheduleRunRequest,
  ScheduleRunResult,
} from "../feishu/schedule.js";
import type { ScheduleReceiptState } from "../feishu/state.js";

export type {
  FeishuSchedule,
  FeishuScheduleOfferClosed,
  FeishuScheduleOfferRow,
  FeishuSchedulePort,
  ScheduleDecideRequest,
  ScheduleDecideResult,
  NoticeResult,
  ReportOfferResult,
  ScheduleNoticeInput,
  ScheduleReceiptView,
  ScheduleReportOffer,
  ScheduleRunRequest,
  ScheduleRunResult,
};
export type { ScheduleReceiptState } from "../feishu/state.js";

/** The delivery half F1 exposes on its service object (`service.schedule`). */
export type ScheduleDelivery = Pick<FeishuSchedule, "pushReport" | "pushNotice" | "receiptsFor" | "hasReceipt"> & {
  /**
   * #61: the coordinator calls this (best-effort, never awaited, errors swallowed) whenever the
   * VISIBLE offers/closed set of a session may have changed — a `sched_offers` frame, a rescan that
   * flipped the ledger-hash match, or the session going on/offline. Absent ⇒ no card reconcile.
   */
  offersChanged?(sessionId: string): void;
};

/**
 * #61 H2 → F2: ledger evidence about ONE task, taken from the hub's last scan of its session.
 * `FeishuSchedulePort.list()` cannot tell "deleted" from "projection lag" from "degraded"; this can.
 * It is an OPTIONAL extra member of the object `coordinator.port()` returns (the C0 port type is
 * untouched) — consumers read it structurally: `(port as HubSchedulePort).ledgerTask?.(sid, id)`.
 *
 *  - `present`  — the task exists in the ledger as of `scannedAt`; `approved` = approval.hash === defHash.
 *  - `deleted`  — the session's ledger was READ OK by a scan that STARTED at/after `since` (default 0)
 *                 and holds no such task. A scan older than `since` can never prove deletion
 *                 (the task may simply not have been created yet when that scan ran).
 *  - `unknown`  — no proof either way: the session is not cached, its ledger is degraded, the
 *                 store root is degraded, or the only scan predates `since`.
 */
export type ScheduleLedgerEvidence =
  | { kind: "present"; approved: boolean; defHash: string; scannedAt: number }
  | { kind: "deleted"; scannedAt: number }
  | { kind: "unknown"; reason: "no-session" | "degraded" | "root-degraded" | "stale" };

/** What the agent's last `sched_offers` frame says about a session (authority marker for reconcile). */
export interface ScheduleOffersSeen {
  /** hub clock ms when the last accepted `sched_offers` frame of this session arrived. */
  at: number;
  /** exactly one live view and it is the view that sent the frame. */
  online: boolean;
}

/** The extra, optional, hub-internal members of the port object (see {@link ScheduleLedgerEvidence}). */
export interface HubScheduleExtras {
  ledgerTask(sessionId: string, taskId: string, opts?: { since?: number }): ScheduleLedgerEvidence;
  offersSeen(sessionId: string): ScheduleOffersSeen | undefined;
}
export type HubSchedulePort = FeishuSchedulePort & Partial<HubScheduleExtras>;

/** A receipt as H1 keeps it in memory (fed by `receiptsChanged` + `receiptsFor` on bind). */
export interface ReceiptView {
  state: ScheduleReceiptState;
  at: number;
  code?: string;
}

/** hub.ts's post-start wiring for the §7.5 `sched_bound` → bot event stream tap. */
export type SchedBoundTap = (agentKey: string, runKey: string) => void;
