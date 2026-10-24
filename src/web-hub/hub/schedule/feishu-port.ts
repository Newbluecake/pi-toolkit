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
  FeishuSchedulePort,
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
  FeishuSchedulePort,
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
export type ScheduleDelivery = Pick<FeishuSchedule, "pushReport" | "pushNotice" | "receiptsFor" | "hasReceipt">;

/** A receipt as H1 keeps it in memory (fed by `receiptsChanged` + `receiptsFor` on bind). */
export interface ReceiptView {
  state: ScheduleReceiptState;
  at: number;
  code?: string;
}

/** hub.ts's post-start wiring for the §7.5 `sched_bound` → bot event stream tap. */
export type SchedBoundTap = (agentKey: string, runKey: string) => void;
