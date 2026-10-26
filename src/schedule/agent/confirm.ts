/**
 * Scheduled tasks — confirm-on-the-spot for AI-authored tasks (#61, `docs/dev/scheduled-reports/confirm-plan.md`).
 *
 * When the `schedule` tool leaves a task pending, an in-memory OFFER asks the human to confirm
 * right now — locally (a three-option TUI select) and, through the hub, on web / Feishu. The
 * ledger is the only arbiter: every channel ends in `approveTask` / `rejectTask` (a CAS under the
 * ledger lock, idempotent: the loser gets `already-approved` / `E_REV`). This module owns:
 *  - the offer registry (≤ 8 open, TTL 2 h, one `deciding` promise per offer ⇒ one decision, one notice);
 *  - `decide()` — the single entry for TUI select, `/schedule reject` and the hub's `sched_decide`;
 *  - `revalidate()` — closes offers whose task vanished / was approved elsewhere / changed / expired;
 *  - the TUI presenter: FIFO, opens a box ONLY when nothing else can be on screen, and NEVER takes the
 *    box down itself (no pi `timeout`, no abort signal — pi's nested dialogs share one editor slot, so
 *    ownership of "the box on screen" is unprovable; closing the wrong one is worse than a leaked promise).
 * Pure of pi: the UI, clock, publishing and model notice are injected ports. Nothing at module scope
 * (I4); every timer goes through the injected clock (production: `systemClock`, unref'd — I5).
 */
import { randomBytes } from "node:crypto";
import type { Clock, TimerHandle } from "../../core/clock.js";
import {
  SCHED_CONFIRM_CLOSED_MAX,
  SCHED_CONFIRM_OFFERS_MAX,
  SCHED_CONFIRM_TTL_MS,
  type SchedOfferBy,
  type SchedOfferClosedWire,
  type SchedOfferOutcome,
  type SchedOffersFrame,
} from "../../web-hub/protocol/schedule.js";
import { approveTask, rejectTask, type RejectRevertTo } from "../core/claim.js";
import { defHash, isApproved, type ScheduleErrorCode, type ScheduleTask } from "../core/spec.js";
import { dropQueuedRuns } from "./ops.js";
import { taskDetail } from "./view.js";
import type { ScheduleAgent } from "./wire.js";

/** Open offers are re-validated against the ledger this often (a foreign process may have written it). */
export const CONFIRM_REVALIDATE_MS = 15_000;
/** `closed` echo retention in `sched_offers`. */
export const CONFIRM_CLOSED_KEEP_MS = 120_000;
/** No local box within this long of the user's last input. */
export const CONFIRM_QUIET_INPUT_MS = 2_000;
/** Re-check cadence while a box is blocked by something we cannot get an event for. */
const PUMP_POLL_MS = 3_000;
const OWN_TITLES_MAX = 16;
/**
 * `updateTask`'s own `changed()` re-validates BEFORE the tool calls `offer()` and so closes the previous offer
 * as superseded first; its origin is remembered this long so the new offer still inherits it.
 */
const CHAIN_GRACE_MS = 60_000;

export const CONFIRM_OPT_APPROVE = "批准";
export const CONFIRM_OPT_REJECT_DELETE = "拒绝（删除该任务）";
export const CONFIRM_OPT_REJECT_RESTORE = "拒绝（恢复到修改前的定义）";
export const CONFIRM_OPT_LATER = "稍后（保持待确认）";

export type OfferOrigin =
  | { kind: "create" } // reject ⇒ delete
  | { kind: "update"; base: RejectRevertTo; wasApproved?: boolean }; // reject ⇒ roll back to base

export type DecideVia = "tui" | "web" | "feishu";

export type DecideResult =
  | { kind: "approved" }
  | { kind: "rejected"; removed: boolean }
  | { kind: "refused"; code: ScheduleErrorCode | "already-approved" | "offer-gone" | "expired"; detail: string };

export interface ConfirmUi {
  mode: string;
  hasUI: boolean;
  /** Called with exactly (title, options): never an options bag (no timeout, no signal — module header). */
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(text: string, level: "info" | "warning"): void;
  isIdle(): boolean;
}

export interface ScheduleConfirmDeps {
  agent: Pick<ScheduleAgent, "sessionId" | "mode" | "store" | "gate" | "changed" | "onChanged" | "readState">;
  /** undefined ⇒ no local UI (print / json / !hasUI). */
  ui?: ConfirmUi;
  /** Hub confirm channel usable now (link ready ∧ hub caps ∋ sched.confirm.v1). rpc + true ⇒ no local box. */
  hubConfirmReady(): boolean;
  publish(frame: Omit<SchedOffersFrame, "t">): void;
  notice(
    text: string,
    details: { kind: "confirm"; taskId: string; outcome: SchedOfferOutcome; by?: SchedOfferBy },
  ): void;
  /** I1: own-session in-memory revocation of a deleted task's queued runs. */
  revoke?(taskId: string): void;
  clock: Clock;
}

export interface LiveOfferInfo {
  offerId: string;
  taskId: string;
  defHash: string;
  kind: OfferOrigin["kind"];
  expiresAt: number;
}

export interface ScheduleConfirm {
  /** Tool create/update left `task` pending. `unavailable` ⇒ nobody could be asked (print / no UI and no hub / not interactive). */
  offer(task: ScheduleTask, origin: OfferOrigin): "offered" | "unavailable";
  /** The one decision entry (TUI select, `/schedule reject`, `sched_decide`). */
  decide(req: {
    taskId: string;
    defHash: string;
    decision: "approve" | "reject";
    via: DecideVia;
    offerId?: string;
  }): Promise<DecideResult>;
  hasLiveOffer(taskId: string, defHash: string): boolean;
  liveOffer(taskId: string): LiveOfferInfo | undefined;
  /** Re-check every open offer against the ledger (local write, poll, turn start, settle). */
  revalidate(): void;
  onUiPrompt(open: boolean, info?: { kind?: string; title?: string }): void;
  onInput(): void;
  onBeforeAgentStart(): void;
  onAgentSettled(): void;
  /** Fresh hub caps: re-send the full list (empty too). */
  onHubCaps(): void;
  /** Closes every offer as `withdrawn`, publishes, clears timers. Does NOT abort a box already on screen. */
  dispose(): void;
}

interface Offer {
  offerId: string;
  taskId: string;
  name: string;
  defHash: string;
  origin: OfferOrigin;
  expiresAt: number;
  deciding?: Promise<DecideResult>;
  /** Local presentation: waiting in the FIFO, on screen, or done with (answered / dismissed / not ours). */
  tui: "queued" | "showing" | "settled";
}

const BY_LABEL: Record<SchedOfferBy, string> = { tui: "终端", web: "web", feishu: "飞书", elsewhere: "其他入口" };

const refused = (code: Extract<DecideResult, { kind: "refused" }>["code"], detail: string): DecideResult => ({
  kind: "refused",
  code,
  detail,
});

export function createScheduleConfirm(deps: ScheduleConfirmDeps): ScheduleConfirm {
  const { clock } = deps;
  const offers = new Map<string, Offer>();
  const queue: string[] = [];
  const closed: { wire: SchedOfferClosedWire; at: number }[] = [];
  const ownTitles: string[] = [];
  const chains = new Map<string, { origin: OfferOrigin; until: number }>();
  const uiOpen: string[] = [];
  let showing: string | undefined;
  let turnActive = false;
  let lastInput = -Infinity;
  let dirty = false;
  let disposed = false;
  let pumpTimer: TimerHandle | undefined;
  let revalTimer: TimerHandle | undefined;
  const unsubscribe = deps.agent.onChanged(() => revalidate());

  const say = (text: string, level: "info" | "warning" = "info"): void => {
    try {
      deps.ui?.notify(text, level);
    } catch {
      /* stale ctx */
    }
  };

  // ----------------------------------------------------------------- publish / close

  const wireOpen = (): SchedOffersFrame["open"] =>
    [...offers.values()].map((o) => ({
      offerId: o.offerId,
      taskId: o.taskId,
      defHash: o.defHash,
      expiresAt: o.expiresAt,
    }));

  const flush = (force = false): void => {
    if (!dirty && !force) return;
    dirty = false;
    const sessionId = deps.agent.sessionId;
    if (sessionId === undefined) return;
    const cut = clock.now() - CONFIRM_CLOSED_KEEP_MS;
    while (closed.length > 0 && closed[0]!.at < cut) closed.shift();
    while (closed.length > SCHED_CONFIRM_CLOSED_MAX) closed.shift();
    try {
      deps.publish({ sessionId, open: wireOpen(), closed: closed.map((c) => c.wire) });
    } catch {
      /* the hub link must never break a decision */
    }
  };

  const clearTimer = (h: TimerHandle | undefined): void => {
    if (h !== undefined) clock.clearTimer(h);
  };

  const armReval = (): void => {
    if (revalTimer !== undefined || disposed || offers.size === 0) return;
    revalTimer = clock.setTimer(CONFIRM_REVALIDATE_MS, () => {
      revalTimer = undefined;
      revalidate();
      armReval();
    });
  };

  const close = (offer: Offer, outcome: SchedOfferOutcome, by?: SchedOfferBy, removed?: boolean): void => {
    if (!offers.delete(offer.offerId)) return;
    const qi = queue.indexOf(offer.offerId);
    if (qi >= 0) queue.splice(qi, 1);
    closed.push({
      wire: {
        offerId: offer.offerId,
        taskId: offer.taskId,
        defHash: offer.defHash,
        outcome,
        ...(by !== undefined ? { by } : {}),
      },
      at: clock.now(),
    });
    dirty = true;
    if (outcome === "superseded") {
      chains.set(offer.taskId, { origin: offer.origin, until: clock.now() + CHAIN_GRACE_MS });
      while (chains.size > SCHED_CONFIRM_OFFERS_MAX) chains.delete(chains.keys().next().value as string);
    } else chains.delete(offer.taskId);
    const label = by !== undefined ? BY_LABEL[by] : undefined;
    if (offer.tui === "showing" && outcome !== "withdrawn") {
      // The box stays (never aborted): tell the user what a click there would now do.
      say(
        outcome === "approved"
          ? `任务 ${offer.taskId} 已在${label ?? "其他入口"}批准（终端里的确认框可直接关闭）`
          : outcome === "superseded"
            ? `任务 ${offer.taskId} 的定义已变更，稍后会再问你（当前确认框已过期，请选「稍后」）`
            : `任务 ${offer.taskId} 的确认请求已作废（当前确认框可直接关闭）`,
        "warning",
      );
    }
    offer.tui = "settled";
    if (outcome === "approved" || outcome === "rejected") {
      const text =
        outcome === "approved"
          ? `[schedule] 用户已通过${label ?? "其他入口"}批准任务 ${offer.taskId}「${offer.name}」`
          : `[schedule] 用户通过${label ?? "其他入口"}拒绝了任务 ${offer.taskId}「${offer.name}」：${
              removed === true || offer.origin.kind === "create" ? "任务已删除" : "已恢复到修改前的定义"
            }`;
      try {
        deps.notice(text, { kind: "confirm", taskId: offer.taskId, outcome, ...(by !== undefined ? { by } : {}) });
      } catch {
        /* best effort */
      }
    }
    if (offers.size === 0) {
      clearTimer(revalTimer);
      revalTimer = undefined;
    }
  };

  // ----------------------------------------------------------------- revalidate

  function revalidate(): void {
    if (disposed || offers.size === 0) return;
    const r = deps.agent.readState();
    if (r.kind === "degraded") return; // cannot tell ⇒ keep every offer, judge next time
    const tasks = r.kind === "ok" ? r.state.tasks : [];
    const now = clock.now();
    for (const offer of [...offers.values()]) {
      if (offer.deciding !== undefined) continue; // the decision in flight closes it
      const task = tasks.find((t) => t.id === offer.taskId);
      if (task === undefined) close(offer, "withdrawn");
      else if (defHash(task) !== offer.defHash) close(offer, "superseded");
      else if (isApproved(task)) close(offer, "approved", "elsewhere");
      else if (now >= offer.expiresAt) close(offer, "expired");
    }
    flush();
    pump();
  }

  // ----------------------------------------------------------------- decide

  function findLive(req: { taskId: string; defHash: string; offerId?: string }): Offer | undefined {
    for (const o of offers.values())
      if (
        o.taskId === req.taskId &&
        o.defHash === req.defHash &&
        (req.offerId === undefined || o.offerId === req.offerId)
      )
        return o;
    return undefined;
  }

  async function run(req: Parameters<ScheduleConfirm["decide"]>[0], offer: Offer | undefined): Promise<DecideResult> {
    // feishu and reject need a live, matching offer; a local approve may still CAS without one (it is
    // exactly `/schedule approve`: the ledger refuses with E_REV / already-approved if it lost).
    if (offer === undefined && (req.via === "feishu" || req.decision === "reject"))
      return refused("offer-gone", "no live confirm offer for this definition");
    if (offer !== undefined && clock.now() >= offer.expiresAt) {
      close(offer, "expired");
      flush();
      return refused("expired", "the confirm request expired");
    }
    const g = deps.agent.gate();
    if (g !== undefined) return refused(g.code, g.detail);
    const store = deps.agent.store();
    if (store === undefined) return refused("E_INVALID", "no-task");
    let res: Awaited<ReturnType<typeof rejectTask>>;
    try {
      res =
        req.decision === "approve"
          ? await approveTask(store, req.taskId, req.defHash, req.via === "tui" ? "tui" : "web")
          : await rejectTask(
              store,
              req.taskId,
              req.defHash,
              offer!.origin.kind === "update" ? offer!.origin.base : undefined,
            );
    } catch (err) {
      return refused("E_DEGRADED", err instanceof Error ? err.message : String(err));
    }
    if (res.kind === "refused") {
      return res.detail === "already-approved"
        ? refused("already-approved", "the task is already approved")
        : refused(res.code, res.detail ?? "refused");
    }
    if (res.kind === "error") return refused(res.code, res.detail);
    const removed = res.kind === "removed";
    const outcome: SchedOfferOutcome = req.decision === "approve" ? "approved" : "rejected";
    if (offer !== undefined) close(offer, outcome, req.via, removed);
    flush();
    deps.agent.changed();
    if (removed) {
      try {
        deps.revoke?.(req.taskId);
      } catch {
        /* best effort */
      }
      await dropQueuedRuns(store, req.taskId);
    }
    return req.decision === "approve" ? { kind: "approved" } : { kind: "rejected", removed };
  }

  function decide(req: Parameters<ScheduleConfirm["decide"]>[0]): Promise<DecideResult> {
    const offer = findLive(req);
    if (offer?.deciding !== undefined) return offer.deciding; // same offer, in flight: one decision, one notice
    const p = run(req, offer);
    if (offer !== undefined) {
      offer.deciding = p;
      const done = (): void => {
        if (offer.deciding === p) delete offer.deciding;
        revalidate(); // a refused decision leaves the offer to the ledger's verdict
      };
      p.then(done, done);
    }
    return p;
  }

  // ----------------------------------------------------------------- offer

  function offer(task: ScheduleTask, origin: OfferOrigin): "offered" | "unavailable" {
    if (disposed || deps.agent.mode.kind !== "interactive" || deps.agent.sessionId === undefined) return "unavailable";
    if (isApproved(task)) return "unavailable";
    if (deps.ui?.hasUI !== true && !deps.hubConfirmReady()) return "unavailable";
    const hash = defHash(task);
    const existing = [...offers.values()].find((o) => o.taskId === task.id);
    const chain = chains.get(task.id);
    if (existing === undefined && chain !== undefined && clock.now() <= chain.until) origin = chain.origin;
    chains.delete(task.id);
    if (existing !== undefined) {
      if (existing.defHash === hash) {
        existing.name = task.name; // a rename never re-asks
        return "offered";
      }
      origin = existing.origin; // the chain's baseline stays the FIRST change's (create ⇒ delete; update ⇒ original)
      close(existing, "superseded");
      chains.delete(task.id);
    }
    while (offers.size >= SCHED_CONFIRM_OFFERS_MAX) {
      const oldest = offers.values().next().value as Offer | undefined;
      if (oldest === undefined) break;
      close(oldest, "withdrawn");
    }
    const o: Offer = {
      offerId: randomBytes(12).toString("base64url"),
      taskId: task.id,
      name: task.name,
      defHash: hash,
      origin,
      expiresAt: clock.now() + SCHED_CONFIRM_TTL_MS,
      tui: "queued",
    };
    offers.set(o.offerId, o);
    queue.push(o.offerId);
    dirty = true;
    armReval();
    flush();
    pump();
    return "offered";
  }

  // ----------------------------------------------------------------- TUI presenter

  const tuiEnabled = (): boolean => {
    const ui = deps.ui;
    if (ui === undefined || !ui.hasUI) return false;
    if (ui.mode === "tui") return true;
    return ui.mode === "rpc" && !deps.hubConfirmReady(); // rpc with a remote channel: only the remote
  };

  /** ms to wait before a box may open, or undefined when it may open now. */
  const blockedFor = (): number | undefined => {
    const ui = deps.ui;
    if (ui === undefined) return PUMP_POLL_MS;
    let idle = false;
    try {
      idle = ui.isIdle();
    } catch {
      idle = false;
    }
    if (!idle || turnActive || uiOpen.length > 0) return PUMP_POLL_MS;
    const since = clock.now() - lastInput;
    return since < CONFIRM_QUIET_INPUT_MS ? CONFIRM_QUIET_INPUT_MS - since + 50 : undefined;
  };

  const armPump = (ms: number): void => {
    clearTimer(pumpTimer);
    pumpTimer = clock.setTimer(ms, () => {
      pumpTimer = undefined;
      pump();
    });
  };

  function pump(): void {
    if (disposed || showing !== undefined) return;
    clearTimer(pumpTimer);
    pumpTimer = undefined;
    while (queue.length > 0) {
      const o = offers.get(queue[0]!);
      if (o === undefined || o.tui !== "queued") {
        queue.shift();
        continue;
      }
      if (!tuiEnabled()) {
        queue.shift(); // not a local-box configuration: web / Feishu / `/schedule approve` carry it
        o.tui = "settled";
        continue;
      }
      const wait = blockedFor();
      if (wait !== undefined) return void armPump(wait);
      queue.shift();
      void present(o);
      return;
    }
  }

  async function present(o: Offer): Promise<void> {
    const ui = deps.ui!;
    const r = deps.agent.readState();
    if (r.kind === "degraded") {
      queue.unshift(o.offerId);
      return void armPump(PUMP_POLL_MS);
    }
    const task = r.kind === "ok" ? r.state.tasks.find((t) => t.id === o.taskId) : undefined;
    // CAS discipline of `/schedule approve`: what we show must be exactly what the offer binds.
    if (task === undefined || defHash(task) !== o.defHash || isApproved(task)) {
      revalidate();
      if (offers.has(o.offerId)) close(o, "superseded");
      flush();
      return void pump();
    }
    const reject = o.origin.kind === "create" ? CONFIRM_OPT_REJECT_DELETE : CONFIRM_OPT_REJECT_RESTORE;
    const head =
      o.origin.kind === "create"
        ? `AI 新建了定时任务 ${o.taskId}，请确认`
        : `AI 修改了定时任务 ${o.taskId}${o.origin.wasApproved === false ? "" : "（原批准已失效）"}，请确认`;
    const title = [head, ...taskDetail(task, r.kind === "ok" ? r.state.occ[task.id] : undefined)].join("\n");
    o.tui = "showing";
    showing = o.offerId;
    ownTitles.push(title);
    while (ownTitles.length > OWN_TITLES_MAX) ownTitles.shift();
    let choice: string | undefined;
    try {
      choice = await ui.select(title, [CONFIRM_OPT_APPROVE, reject, CONFIRM_OPT_LATER]);
    } catch {
      choice = undefined;
    }
    showing = undefined;
    if (o.tui === "showing") o.tui = "settled";
    if (disposed) {
      say(`任务 ${o.taskId} 仍待确认：/schedule approve ${o.taskId}`);
      return;
    }
    if (choice === CONFIRM_OPT_APPROVE || choice === reject) {
      const approve = choice === CONFIRM_OPT_APPROVE;
      const res = await decide({
        taskId: o.taskId,
        defHash: o.defHash,
        decision: approve ? "approve" : "reject",
        via: "tui",
        offerId: o.offerId,
      });
      say(...describeLocal(o, approve, res));
    } else {
      say(`任务 ${o.taskId} 仍待确认：/schedule approve ${o.taskId}`);
    }
    pump();
  }

  const describeLocal = (o: Offer, approve: boolean, res: DecideResult): [string, "info" | "warning"] => {
    if (res.kind === "approved") return [`已批准 ${o.taskId}（hash ${o.defHash.slice(0, 8)}）。`, "info"];
    if (res.kind === "rejected")
      return [res.removed ? `已拒绝并删除 ${o.taskId}。` : `已拒绝：${o.taskId} 已恢复到修改前的定义。`, "info"];
    if (res.code === "E_REV") return ["E_REV: 审阅期间任务定义已变更，未批准；请重新审阅", "warning"];
    if (res.code === "already-approved") return [`任务 ${o.taskId} 已在其他入口批准。`, "info"];
    return [`${approve ? "未批准" : "未拒绝"} ${o.taskId}：${res.code} ${res.detail}`, "warning"];
  };

  // ----------------------------------------------------------------- events

  return {
    offer,
    decide,
    hasLiveOffer: (taskId, hash) => findLive({ taskId, defHash: hash }) !== undefined,
    liveOffer(taskId) {
      for (const o of offers.values())
        if (o.taskId === taskId)
          return { offerId: o.offerId, taskId, defHash: o.defHash, kind: o.origin.kind, expiresAt: o.expiresAt };
      return undefined;
    },
    revalidate,
    onUiPrompt(open, info) {
      const title = info?.title;
      if (title !== undefined && ownTitles.includes(title)) return; // our own box: never counts against us
      const key = `${info?.kind ?? ""}\u0000${title ?? ""}`;
      if (open) uiOpen.push(key);
      else {
        const i = uiOpen.indexOf(key);
        if (i >= 0) uiOpen.splice(i, 1); // unmatched end ⇒ keep counting (overcount, never undercount)
      }
      if (!open) pump();
    },
    onInput() {
      lastInput = clock.now();
      if (queue.length > 0) pump();
    },
    onBeforeAgentStart() {
      turnActive = true;
      revalidate();
    },
    onAgentSettled() {
      turnActive = false;
      revalidate();
      pump();
    },
    onHubCaps() {
      if (!disposed) flush(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearTimer(pumpTimer);
      clearTimer(revalTimer);
      pumpTimer = revalTimer = undefined;
      for (const o of [...offers.values()]) close(o, "withdrawn");
      flush(true);
    },
  };
}
