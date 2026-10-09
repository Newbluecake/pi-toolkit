/**
 * topic-switch · `/reload` and crash recovery (plan.md §P3b.7, R-C, I5).
 *
 * Pure orchestration over `records.planRecovery`'s decisions: `wire.ts`'s `session_start`
 * handler supplies the branch/transfer/sessionId/reason snapshot, this module decides WHAT to do
 * (already decided by `planRecovery`) and HOW to do it through the small, pi-typed `deps` port —
 * kept pi-typeless on purpose (every field is a plain function) so it is unit-testable without a
 * real `ExtensionContext`. `delivering` never auto-redelivers (I5): the `deliver` action always
 * writes the `delivering` record/transfer-state transition BEFORE calling `deps.deliver`, and the
 * `notice`/`resolve` actions always write their terminal record so the same branch scan never
 * re-raises the same pending/delivering record on a later `session_start`.
 */
import { planRecovery, type RecoveryAction } from "./records.js";
import type { EntryLike, HeldPayload, StartReason, TransferLike } from "./types.js";

export interface RecoveryDeps {
  branch: readonly EntryLike[];
  transfer: TransferLike | undefined;
  sessionId: string;
  reason: StartReason;
  now(): number;
  /** Writes a `subagent:topic-switch` custom entry (`ENTRY_TYPE`, caller already supplies `v`/`kind`/...). */
  appendRecord(data: unknown): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setEditorText(text: string): void;
  /** CAS the transfer AND write the `delivering` record BEFORE the actual delivery — the deliver
   *  action's ordering requirement (I5: "先写 delivering 再发"). No-op (and the deliver is
   *  skipped) if the CAS fails — meaning something else already advanced this holdId's state. */
  markDelivering(holdId: string): boolean;
  /** Delivers the FULL (uncapped) payload into the current session (release-queue semantics:
   *  waits out an in-progress compaction, then `pi.sendUserMessage(toContent(payload),{deliverAs:"followUp"})`). */
  deliver(payload: HeldPayload): void;
}

/** Runs every `RecoveryAction` `planRecovery` returns against `deps`, in order.
 *
 * M3 dedupe: `planRecovery` can legitimately emit BOTH a `deliver`/`editor` action for a holdId
 * (rule 1/2, from the in-process transfer) AND a `notice` action for the SAME holdId (rule 4, from
 * the disk `pending` record `persistPending` always writes alongside the transfer) — rule 4's own
 * `actedIds` guard is populated only by rules 3/4 themselves, never by the transfer-driven rules 1/2
 * (records.ts is frozen P1; this is the P3b-side fix). Order-safety: `planRecovery` always pushes
 * the transfer actions (rule 1/2) before the branch-scan actions (rule 3/4), so a `deliver`/`editor`
 * for a given holdId is always seen before that same holdId's `notice`, making a single forward
 * pass with an `acted` set sufficient — never suppress `resolve` (always a DIFFERENT holdId from
 * whatever a transfer action touched in the same run). */
export function runRecovery(deps: RecoveryDeps): void {
  let actions: RecoveryAction[];
  try {
    actions = planRecovery({
      branch: deps.branch,
      transfer: deps.transfer,
      sessionId: deps.sessionId,
      reason: deps.reason,
      now: deps.now(),
    });
  } catch {
    actions = [];
  }
  const acted = new Set<string>();
  for (const action of actions) {
    try {
      if (action.a === "deliver" || action.a === "editor") {
        acted.add(action.holdId);
      } else if (action.a === "notice" && acted.has(action.holdId)) {
        continue; // already delivered/edited this run — a notice now would be a false "未能送达"
      }
      applyAction(action, deps);
    } catch {
      /* one bad action must never block the rest of recovery (fail-open) */
    }
  }
}

function applyAction(action: RecoveryAction, deps: RecoveryDeps): void {
  switch (action.a) {
    case "none":
      return;
    case "deliver": {
      if (!deps.markDelivering(action.holdId)) return; // lost the CAS: something else already moved this on
      deps.deliver(action.payload);
      return;
    }
    case "editor": {
      try {
        deps.setEditorText(action.text);
      } catch {
        /* best-effort */
      }
      deps.notify("上次切换前截留的请求未能送达，已放回输入框（如含图片需重新粘贴）。", "warning");
      return;
    }
    case "resolve": {
      deps.appendRecord({ v: 1, kind: "resolved", at: deps.now(), holdId: action.holdId, how: "observed" });
      return;
    }
    case "notice": {
      deps.notify(`上次截留的请求可能未送达：${action.preview}，可用 /topic-switch last 查看/重发。`, "warning");
      deps.appendRecord({ v: 1, kind: "resolved", at: deps.now(), holdId: action.holdId, how: "noticed" });
      return;
    }
  }
}
