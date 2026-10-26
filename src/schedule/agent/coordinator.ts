/**
 * Scheduled tasks — agent-side hub coordinator (plan r3 §7.1, §7.4, §7.5, §10.1; A0).
 *
 * The hub is a READ-ONLY coordinator (it scans state.json itself, S3); the agent only:
 *   - pushes `sched_changed{sessionId}` after its own ledger writes (hub re-scans that session),
 *     and once per `hello_ack` carrying `sched.v1` (reconnect / hub restart);
 *   - pushes `sched_bound{agentKey, runKey}` for the message dispatcher (A2, §7.5);
 *   - answers every `sched_run` with EXACTLY ONE `sched_run_ack` (manual claim §4.5b);
 *   - applies `sched_receipts` by removing the acknowledged `pendingReports` entries under the lock;
 *   - #61 C2 (sched.confirm.v1): publishes the confirm module's authoritative `sched_offers` snapshot
 *     (dropped unless the live link also carries `sched.confirm.v1` — the next publish / hello_ack
 *     resends the full list), and answers every `sched_decide` with EXACTLY ONE `sched_decide_ack`
 *     by forwarding to the confirm module's `decide()` (the ledger CAS in claim.ts is the arbiter).
 *
 * Two layers:
 *   - `createScheduleHubRouter()` — ONE per activate (the web-hub connection is process-level and
 *     outlives session swaps): owns the late-bound link and routes hub frames to whichever session
 *     coordinator is attached; no attached session ⇒ `sched_run` is refused (`E_NOT_OWNER`).
 *   - `createHubCoordinator()` — one per session stack. `NULL_SCHEDULE_COORDINATOR` when web-hub is
 *     off (or the domain is not plain): does nothing and persists nothing (§10.1).
 * Frames are only sent while the live link's `hello_ack.caps ∋ sched.v1` (`link.ready()`); otherwise
 * every call is a no-op — no queue, nothing to replay (the hub re-scans on its own 60 s cadence).
 */
import type {
  HubScheduleConfig,
  SchedAgentFrame,
  SchedDecideFrame,
  SchedOffersFrame,
  SchedReceiptsFrame,
  SchedRunFrame,
} from "../../web-hub/protocol/schedule.js";
import type { DecideResult, ScheduleConfirm } from "./confirm.js";

/** Late-bound view of the process-level web-hub connection. */
export interface SchedHubLink {
  /** Live link AND the hub advertised `sched.v1` in its latest hello_ack. */
  ready(): boolean;
  /** #61 C2: ready() ∧ hello_ack.caps ∋ `sched.confirm.v1` — the offers/decide channel. Optional so
   *  a pre-C2 link (or a hub without the cap) degrades to TUI-only with zero new frames. */
  confirmReady?(): boolean;
  send(frame: SchedAgentFrame): void;
}

export type SchedRunVerdict = { result: "started" } | { result: "refused"; reason: string };

export interface ScheduleCoordinator {
  readonly kind: "hub" | "null";
  /** The ledger of this session changed (coalesced per tick). */
  changed(): void;
  /** §7.5: the dispatcher's message started a run on `agentKey`. Sent synchronously. */
  bound(agentKey: string, runKey: string): void;
  /** Fresh hub caps (hello_ack): announce this session once. */
  onHubCaps(): void;
  onRun(frame: SchedRunFrame): void;
  onReceipts(frame: SchedReceiptsFrame): void;
  /** #61 C2: publish the confirm module's authoritative offers snapshot. Dropped unless the confirm
   *  channel is live (`confirmReady()`); no queue — the next publish / hello_ack resends everything. */
  offers(frame: Omit<SchedOffersFrame, "t">): void;
  /** #61 C2: the hub confirm channel is usable right now. */
  confirmReady(): boolean;
  /** #61 C2: hub→agent `sched_decide` — exactly one `sched_decide_ack` per received frame. */
  onDecide(frame: SchedDecideFrame): void;
  dispose(): void;
}

export const NULL_SCHEDULE_COORDINATOR: ScheduleCoordinator = Object.freeze({
  kind: "null" as const,
  changed: () => undefined,
  bound: () => undefined,
  onHubCaps: () => undefined,
  onRun: () => undefined,
  onReceipts: () => undefined,
  offers: () => undefined,
  confirmReady: () => false,
  onDecide: () => undefined,
  dispose: () => undefined,
});

export interface HubCoordinatorDeps {
  link: () => SchedHubLink | undefined;
  sessionId: string;
  now?: () => number;
  /** Manual run (`manualClaim` + executor hand-off). Must resolve (never reject) within bounds. */
  runRequest: (req: { reqId: string; taskId: string; defHash: string }) => Promise<SchedRunVerdict>;
  /** Remove acknowledged pendingReports (one locked transaction). `false` ⇒ transient failure. */
  removeReports: (reportIds: readonly string[]) => Promise<boolean>;
  /** One-shot retry timer for a transient receipt failure (unref'd in production). */
  retryLater?: (fn: () => void) => void;
  /** #61 C2: the surface's confirm module, late-bound (the surface creates it AFTER the session
   *  coordinator; unset ⇒ `sched_decide` is refused `offer-gone`). */
  confirm?: () => ScheduleConfirm | undefined;
  warn?: (message: string) => void;
}

const REASON_MAX = 128;

export function createHubCoordinator(deps: HubCoordinatorDeps): ScheduleCoordinator {
  const now = deps.now ?? Date.now;
  let disposed = false;
  let changePending = false;
  const inflight = new Map<string, Promise<SchedRunVerdict>>();
  const decideInflight = new Map<string, Promise<DecideResult>>();

  const send = (frame: SchedAgentFrame): void => {
    if (disposed) return;
    const link = deps.link();
    if (link === undefined || !link.ready()) return;
    try {
      link.send(frame);
    } catch {
      /* the connection owns its own failure accounting */
    }
  };

  const ack = (reqId: string, v: SchedRunVerdict): void => {
    const link = deps.link();
    if (link === undefined || !link.ready()) return;
    try {
      link.send(
        v.result === "started"
          ? { t: "sched_run_ack", reqId, result: "started" }
          : { t: "sched_run_ack", reqId, result: "refused", reason: v.reason.slice(0, REASON_MAX) || "E_INVALID" },
      );
    } catch {
      /* ignore */
    }
  };

  const refuseDecide = (code: Extract<DecideResult, { kind: "refused" }>["code"]): DecideResult => ({
    kind: "refused",
    code,
    detail: code,
  });

  /** Exactly one `sched_decide_ack` per received frame, sent under the same readiness as run acks. */
  const decideAck = (reqId: string, r: DecideResult): void => {
    const link = deps.link();
    if (link === undefined || !link.ready()) return;
    try {
      link.send(
        r.kind === "refused"
          ? { t: "sched_decide_ack", reqId, result: "refused", reason: r.code.slice(0, REASON_MAX) || "E_INVALID" }
          : { t: "sched_decide_ack", reqId, result: r.kind },
      );
    } catch {
      /* ignore */
    }
  };

  return {
    kind: "hub",
    changed() {
      if (disposed || changePending) return;
      changePending = true;
      queueMicrotask(() => {
        changePending = false;
        send({ t: "sched_changed", sessionId: deps.sessionId });
      });
    },
    bound(agentKey, runKey) {
      send({ t: "sched_bound", agentKey, runKey });
    },
    onHubCaps() {
      send({ t: "sched_changed", sessionId: deps.sessionId });
      // #61 C2: fresh caps — the confirm module resends its authoritative offers list (empty too).
      if (disposed) return;
      try {
        deps.confirm?.()?.onHubCaps();
      } catch {
        /* a confirm failure must not break the link hook */
      }
    },
    offers(frame) {
      if (disposed) return;
      const link = deps.link();
      if (link?.confirmReady?.() !== true) return; // no cap ⇒ drop; the next publish resends the full list
      try {
        link.send({ t: "sched_offers", ...frame });
      } catch {
        /* the connection owns its own failure accounting */
      }
    },
    confirmReady() {
      return !disposed && deps.link()?.confirmReady?.() === true;
    },
    onDecide(frame) {
      // Exactly one ack per received frame (a hub re-send of the same reqId gets the same result).
      if (disposed || frame.sessionId !== deps.sessionId) return decideAck(frame.reqId, refuseDecide("E_NOT_OWNER"));
      if (frame.expiresAt <= now()) return decideAck(frame.reqId, refuseDecide("expired"));
      let p = decideInflight.get(frame.reqId);
      if (p === undefined) {
        const confirm = deps.confirm?.();
        p = (
          confirm === undefined
            ? Promise.resolve(refuseDecide("offer-gone"))
            : confirm.decide({
                taskId: frame.taskId,
                defHash: frame.defHash,
                decision: frame.decision,
                via: "feishu",
                offerId: frame.offerId,
              })
        )
          .catch(() => refuseDecide("E_BUSY"))
          .finally(() => decideInflight.delete(frame.reqId));
        decideInflight.set(frame.reqId, p);
      }
      void p.then((r) => decideAck(frame.reqId, r));
    },
    onRun(frame) {
      // Exactly one ack per received frame (a hub re-send of the same reqId gets the same verdict).
      if (disposed) return ack(frame.reqId, { result: "refused", reason: "E_NOT_OWNER" });
      if (frame.sessionId !== deps.sessionId) return ack(frame.reqId, { result: "refused", reason: "E_NOT_OWNER" });
      if (frame.expiresAt <= now()) return ack(frame.reqId, { result: "refused", reason: "E_INVALID:expired" });
      let p = inflight.get(frame.reqId);
      if (p === undefined) {
        p = deps
          .runRequest({ reqId: frame.reqId, taskId: frame.taskId, defHash: frame.defHash })
          .catch((): SchedRunVerdict => ({ result: "refused", reason: "E_BUSY" }))
          .finally(() => inflight.delete(frame.reqId));
        inflight.set(frame.reqId, p);
      }
      void p.then((v) => ack(frame.reqId, v));
    },
    onReceipts(frame) {
      if (disposed || frame.sessionId !== deps.sessionId || frame.reportIds.length === 0) return;
      const ids = [...frame.reportIds];
      const attempt = (retry: boolean): void => {
        void deps
          .removeReports(ids)
          .catch(() => false)
          .then((ok) => {
            if (!ok && retry && !disposed) deps.retryLater?.(() => attempt(false));
          });
      };
      attempt(true);
    },
    dispose() {
      disposed = true;
    },
  };
}

/** What `wireWebHub` receives (`WebHubDeps.schedule`): presence ⇔ schedule enabled ∧ plain domain. */
export interface ScheduleWebHubPort {
  /** `HubConfig.schedule` (undefined ⇒ key absent, e.g. the store dir failed the vault check). */
  hubConfig(): HubScheduleConfig | undefined;
  /** Called once by wireWebHub with a late-bound view of its connection. */
  bindLink(link: SchedHubLink): void;
  onSchedRun(frame: SchedRunFrame): void;
  onSchedReceipts(frame: SchedReceiptsFrame): void;
  /** #61 C2: hub→agent Feishu-card decision; the port answers EXACTLY ONE `sched_decide_ack`. */
  onSchedDecide(frame: SchedDecideFrame): void;
  onHubCaps(): void;
}

export interface ScheduleHubRouter extends ScheduleWebHubPort {
  link(): SchedHubLink | undefined;
  /** Attach a session coordinator; returns the detach function (identity-checked). */
  attach(coordinator: ScheduleCoordinator): () => void;
  attached(): ScheduleCoordinator | undefined;
}

export function createScheduleHubRouter(opts: { hubConfig: () => HubScheduleConfig | undefined }): ScheduleHubRouter {
  let link: SchedHubLink | undefined;
  let active: ScheduleCoordinator | undefined;
  return {
    hubConfig: () => opts.hubConfig(),
    bindLink(l) {
      link = l;
    },
    link: () => link,
    attach(c) {
      active = c;
      return () => {
        if (active === c) active = undefined;
      };
    },
    attached: () => active,
    onSchedRun(frame) {
      if (active !== undefined) return active.onRun(frame);
      // No session attached (between session swaps): still exactly one ack.
      if (link?.ready() === true) {
        try {
          link.send({ t: "sched_run_ack", reqId: frame.reqId, result: "refused", reason: "E_NOT_OWNER" });
        } catch {
          /* ignore */
        }
      }
    },
    onSchedReceipts(frame) {
      active?.onReceipts(frame);
    },
    onSchedDecide(frame) {
      if (active !== undefined) return active.onDecide(frame);
      // No session attached (between session swaps): still exactly one ack.
      if (link?.ready() === true) {
        try {
          link.send({ t: "sched_decide_ack", reqId: frame.reqId, result: "refused", reason: "E_NOT_OWNER" });
        } catch {
          /* ignore */
        }
      }
    },
    onHubCaps() {
      active?.onHubCaps();
    },
  };
}
