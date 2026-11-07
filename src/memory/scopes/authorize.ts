/**
 * #39 P1 authorization: `requestOpApproval` — the exact-content human confirmation that
 * mints a private OpCap (arch §5.2/§5.3, K5; plan §3.3 ApprovalPort).
 *
 * Channels race through `createDialogRace` (the repo's only arbitration primitive, topic-
 * switch precedent): the first synchronous callback wins; the loser is closed/aborted.
 * The REJECT option is always FIRST; the affirmative label embeds the frozen operation's
 * digest8, the dialog title shows the FULL frozen body text — a human must confirm the
 * exact content, a natural-language classifier is never involved.
 *
 * Fail-closed matrix (all ⇒ no cap, no write):
 * - no proven human turn ⇒ E_HUB_NEEDS_HUMAN_TURN; already rejected this turn ⇒
 *   E_HUB_DECLINED_TURN; 4th dialog in one turn ⇒ E_HUB_RATE;
 * - no channel (no TUI select AND remote port absent/disabled) ⇒ E_HUB_CONFIRM_UNAVAILABLE;
 * - rpc mode never opens the local select (rpc identity is unprovable);
 * - web answers must be `originKind === "loopback" | "lan"` (Feishu / missing / source string
 *   ⇒ reject) AND the binding (nonce, opDigest, incarnation, sid, epoch, branchGen, human
 *   turn) must still hold at callback time — otherwise the callback returns false and the
 *   bridge answers E_DIALOG_CLOSED;
 * - cancel / timeout / abort / foreign select value ⇒ declined; every non-affirmative
 *   outcome marks the turn rejected.
 *
 * The production HumanDispatchProofPort (P3) sits UPSTREAM: it feeds the tracker's turn;
 * this module never treats a request string, a tool argument or `authority:"user"` as proof.
 *
 * Pi-free (ask-user/remote.js closure is pi-free). Timer via injected clock; the default
 * clock unrefs its handle (I5) and every span passes clampSpanMs (I1).
 */
import {
  createDialogRace,
  type AskUserRemotePort,
  type AskUserRemoteSession,
  type RemoteOutcome,
} from "../../ask-user/remote.js";
import { clampSpanMs } from "../../core/deadline.js";
import type {
  ApprovalPort,
  MemoryApprovalBinding,
  OpApprovalRequest,
  OpApprovalResult,
  ScopedMemoryErrorCode,
} from "./types.js";
import { scopedOpDigest, bodyTextDigest, sha256Hex } from "./limits.js";
import type { HumanTurnTracker, MemoryOpCapRegistry } from "./op-cap.js";
import { HUMAN_TURN_MAX_DIALOGS } from "./op-cap.js";

export const OP_APPROVAL_TIMEOUT_MS = 120_000;

export type TuiSelectPort = (
  title: string,
  options: readonly string[],
  opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;

export interface ApprovalClock {
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

const realClock: ApprovalClock = {
  setTimer(ms, fn) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
  now: () => Date.now(),
};

export interface OpApprovalDeps {
  readonly tracker: HumanTurnTracker;
  readonly registry: MemoryOpCapRegistry;
  /** TUI channel: presence of the function IS channel availability (host decides mode). */
  readonly select?: TuiSelectPort;
  /** Web channel: only exists when `webHub.remoteAskUser` is on AND the hub is connected. */
  readonly remote?: AskUserRemotePort;
  /** rpc sessions never open the local select (arch §4 lifecycle matrix). */
  readonly localSelectForbidden?: boolean;
  readonly clock?: ApprovalClock;
  readonly timeoutMs?: number;
}

export const REJECT_LABEL = "拒绝（不写入）";

export const affirmLabel = (scope: "session" | "hub", digest8: string): string =>
  scope === "hub" ? `授权并写入 HUB（所有项目共享）· ${digest8}` : `以用户令记录到本会话 · ${digest8}`;

/** Dialog title: target layer, operation, id/topic, project label, digest and the FULL body. */
export function approvalTitle(request: OpApprovalRequest, digest8: string): string {
  const op = request.operation;
  const lines = [
    `目标：${op.storageScope === "hub" ? "HUB（所有项目共享）" : "本会话（session）"}`,
    `操作：${op.op}${op.targetId !== undefined ? ` · ${op.targetId}` : ""}${op.topic !== undefined ? ` · topic ${op.topic}` : ""}`,
    `当前项目：${request.projectLabel}`,
    `操作摘要：${digest8}`,
    "—— 冻结原文（请逐字确认）——",
    op.text ?? "（无正文：删除操作）",
  ];
  return lines.join("\n");
}

export function createOpApprovalPort(deps: OpApprovalDeps): ApprovalPort {
  const clock = deps.clock ?? realClock;
  const timeoutMs = clampSpanMs(deps.timeoutMs ?? OP_APPROVAL_TIMEOUT_MS) ?? OP_APPROVAL_TIMEOUT_MS;
  let inFlight = 0;

  const checkTurnBinding = (binding: MemoryApprovalBinding): boolean => {
    const turn = deps.tracker.current();
    return turn !== undefined && turn.id === binding.humanTurn.id && turn.owner === binding.owner;
  };

  const request = (input: OpApprovalRequest, signal?: AbortSignal): Promise<OpApprovalResult> => {
    // Recompute the digests from the frozen operation: a binding that disagrees with its own
    // operation is tampered and never opens a dialog.
    const operation = input.operation as unknown as Record<string, unknown>;
    const recomputedOp = scopedOpDigest(operation);
    const recomputedText = bodyTextDigest(typeof operation.text === "string" ? operation.text : "");
    if (recomputedOp !== input.binding.opDigest || recomputedText !== input.binding.textDigest)
      return Promise.resolve({ approved: false, code: "E_META_INVALID" } as const);

    const turn = deps.tracker.current();
    if (turn === undefined) return Promise.resolve({ approved: false, code: "E_HUB_NEEDS_HUMAN_TURN" } as const);
    if (deps.tracker.rejected()) return Promise.resolve({ approved: false, code: "E_HUB_DECLINED_TURN" } as const);
    if (deps.tracker.dialogsThisTurn() >= HUMAN_TURN_MAX_DIALOGS)
      return Promise.resolve({ approved: false, code: "E_HUB_RATE" } as const);
    if (inFlight > 0) return Promise.resolve({ approved: false, code: "E_HUB_RATE" } as const);

    const scope = input.operation.storageScope === "hub" ? "hub" : "session";
    const digest8 = input.binding.opDigest.slice(0, 8);
    const affirm = affirmLabel(scope, digest8);
    const title = approvalTitle(input, digest8);
    // The binding's nonce IS the confirmation nonce (frozen upstream); the web dialog is
    // addressed by it and the callback path re-verifies it. Format-checked, never reused
    // while a request with it is in flight (the inFlight gate below is single-pending).
    const nonce = input.binding.nonce;
    if (!/^[a-f0-9]{32}$/.test(nonce)) return Promise.resolve({ approved: false, code: "E_META_INVALID" } as const);

    const select = deps.localSelectForbidden === true ? undefined : deps.select;
    let session: AskUserRemoteSession | undefined;
    if (deps.remote !== undefined) {
      try {
        session = deps.remote.open({
          toolCallId: `memory-op:${nonce}`,
          questions: [
            {
              question: title,
              header: scope === "hub" ? "HUB" : "SESSION",
              options: [{ label: REJECT_LABEL }, { label: affirm }],
              allowOther: false,
            },
          ],
          allowCancel: true,
          attributionTitle: title,
        });
      } catch {
        session = undefined; // port present but broken ⇒ that channel is unavailable
      }
    }
    if (session === undefined && select === undefined)
      return Promise.resolve({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" } as const);

    deps.tracker.noteDialog();
    inFlight++;
    return new Promise<OpApprovalResult>((resolve) => {
      const race = createDialogRace();
      const localAbort = new AbortController();
      let settled = false;
      let sessionClosed = false;
      let timer: unknown;
      const closeSession = (by: "tui" | "abort" | "error", outcome: "answered" | "cancelled" | "aborted"): void => {
        if (sessionClosed || session === undefined) return;
        sessionClosed = true;
        try {
          session.close(by, outcome);
        } catch {
          /* best-effort close must never break settlement */
        }
      };
      const settle = (result: OpApprovalResult): void => {
        if (settled) return;
        settled = true;
        inFlight--;
        if (timer !== undefined) {
          clock.clearTimer(timer);
          timer = undefined;
        }
        try {
          signal?.removeEventListener("abort", onAbort);
        } catch {
          /* idempotent */
        }
        localAbort.abort();
        resolve(result);
      };
      const declined = (code: ScopedMemoryErrorCode): void => {
        deps.tracker.markRejected();
        settle({ approved: false, code });
      };
      const mint = (channel: "tui" | "web", who?: string): void => {
        if (!checkTurnBinding(input.binding)) {
          declined("E_HUB_DECLINED"); // the turn died mid-dialog: no cap may be minted
          return;
        }
        const cap = deps.registry.mint({
          operation: input.operation,
          binding: input.binding,
          channel,
          project: input.projectLabel,
          ...(who !== undefined ? { who } : {}),
        });
        settle({ approved: true, cap });
      };
      const onAbort = (): void => {
        if (settled || !race.claim("abort")) return;
        closeSession("abort", "aborted");
        deps.tracker.markRejected();
        settle({ approved: false, code: "E_HUB_DECLINED" });
      };
      const onTimeout = (): void => {
        timer = undefined;
        if (settled) return;
        race.claim("abort"); // freeze arbitration: a racing web answer is rejected, not late
        closeSession("abort", "aborted");
        declined("E_HUB_DECLINED");
      };
      const onSelect = (choice: string | undefined): void => {
        if (settled) return;
        if (!race.claim("tui")) return; // late: web / abort / timeout already settled
        closeSession("tui", choice === affirm ? "answered" : "cancelled");
        if (choice === affirm) mint("tui");
        else declined("E_HUB_DECLINED"); // explicit reject, other value, or dismissed without answer
      };
      const onWeb = (outcome: RemoteOutcome): boolean => {
        if (settled) return false;
        if (outcome.kind === "cancel") {
          if (!race.claim("web")) return false;
          sessionClosed = true; // the bridge closes its own record when we return true
          localAbort.abort();
          declined("E_HUB_DECLINED");
          return true;
        }
        if (outcome.originKind !== "loopback" && outcome.originKind !== "lan") return false; // feishu/source string
        const values = Object.values(outcome.answers);
        if (!values.includes(affirm)) {
          if (!values.includes(REJECT_LABEL) || !race.claim("web")) return false;
          sessionClosed = true;
          localAbort.abort();
          declined("E_HUB_DECLINED");
          return true;
        }
        if (!checkTurnBinding(input.binding)) return false; // owner/turn changed mid-dialog
        if (!race.claim("web")) return false;
        sessionClosed = true;
        localAbort.abort();
        mint("web", sha256Hex(outcome.origin).slice(0, 8));
        return true;
      };

      if (session !== undefined) {
        try {
          session.setOnRemote(onWeb);
        } catch {
          sessionClosed = true;
          try {
            session.close("error", "aborted");
          } catch {
            /* best-effort */
          }
          session = undefined;
        }
      }
      if (session === undefined && select === undefined) {
        // The remote session died between open and setOnRemote and no local channel exists.
        settle({ approved: false, code: "E_HUB_CONFIRM_UNAVAILABLE" });
        return;
      }
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
      } catch {
        /* a signal that cannot take listeners cannot abort; the timeout still bounds us */
      }
      try {
        timer = clock.setTimer(timeoutMs, onTimeout);
      } catch {
        closeSession("error", "aborted");
        declined("E_HUB_DECLINED");
        return;
      }
      if (select !== undefined) {
        select(title, [REJECT_LABEL, affirm], { signal: localAbort.signal }).then(onSelect, () => {
          if (settled || !race.claim("error")) return;
          closeSession("error", "aborted");
          declined("E_HUB_DECLINED");
        });
      }
    });
  };

  return {
    request,
    revoke(): void {
      deps.tracker.invalidate("abort");
      deps.registry.revoke();
    },
    dispose(): void {
      deps.tracker.invalidate("shutdown");
      deps.registry.revoke();
    },
  };
}
