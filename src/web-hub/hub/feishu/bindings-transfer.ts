/**
 * 飞书话题换绑方案 r3 §4.4 (P0a, D1) — the ONE shared binding write op.
 *
 * `state.bindings.set()` is a dumb store write (memory + rev bump, no side effects); the
 * lifecycle side effects (retained-request finalization + `thr_closed`) historically rode ONLY
 * the feishu inbound `durable()` wrapper. This module lifts the orchestration into an explicit
 * function shared by `/use` (router.ts) and the rebind op (later package):
 *
 *   before snapshot → (optional CAS) → same-target no-op check → set (identity fields
 *   preserved) → `await commit()` barrier → (optional, ONLY after a successful commit)
 *   `threads.onBindingClosed` → `scheduleConfirm.reconcile` on both sides.
 *
 * Rules (each asserted in tests/web-hub/hub/feishu/bindings-transfer.test.ts):
 *   R1  first bind (`before === undefined`) is a NORMAL path — `E_THR_NOT_BOUND` exists only on
 *       the CAS path (`expect !== undefined`); `/use` never passes `expect`.
 *   R2  same-target no-op (`before.sessionId === target.sessionId && before.offline ===
 *       undefined`): no set, no rev bump, no commit, no notification, no reconcile.
 *   R3  CAS: `expect.rev` mismatch ⇒ `E_THR_STALE`; `expect.sessionId` mismatch ⇒
 *       `E_THR_NO_OWNER`; both effect "none".
 *   R4  the write preserves the identity fields (chatId/chatType/threadId from `before`; for a
 *       first bind the caller supplies them via `identity`), sanitizes the label and clears
 *       `offline`. `target.agentKey` stays OPTIONAL — `/use` may pick an offline session (§2.1).
 *   R5  a refused `Admit` ⇒ `E_THR_STATE` / "none" (memory untouched).
 *   R6  `await state.commit()` is the persistence barrier: failure ⇒ `E_THR_COMMIT` / "unknown"
 *       (memory already moved; NO lifecycle notification, NO reconcile). Lifecycle notification
 *       fires ONLY after a successful commit and ONLY when `notifyLifecycle === true` — `/use`
 *       keeps it false because the inbound durable hook is still its notification source (R7).
 *   R7  exactly-once between the two notification sources is enforced inside
 *       `threads.onBindingClosed` itself (idempotency key `(key, before.rev)`, D2), not here.
 *   R8  exceptions are never swallowed: any throw ⇒ `E_THR_STATE` / "unknown" + a
 *       `binding-transfer` log line.
 *
 * The `log` dep uses the feishu-module diagnostic signature `log(event, reason?)` (same shape
 * as `FeishuThreadsDeps.log`), not the hub-wide `HubLog` interface. No module-scope mutable
 * state (I4): the closure holds nothing but the injected deps.
 */
import { sanitizeHeaderField } from "../../protocol/feishu.js";
import type { FeishuBinding, FeishuState } from "./state.js";
import type { FeishuThreads } from "./thread-hub.js";

export interface TransferInput {
  key: string;
  /** Target session. `agentKey` is OPTIONAL: `/use` may select an offline session (§2.1); only
   *  the rebind op (later package) requires a live, resolved agent. */
  target: { sessionId: string; label: string; agentKey?: string };
  /** Identity fields for the FIRST bind (R4): `/use` takes them from the message; rebind never
   *  needs them (its binding already exists). Ignored when `before` exists. */
  identity?: { chatId: string; chatType: "p2p" | "group"; threadId?: string };
  /** Optional CAS (rebind carries it; `/use` does not). Presence + `before === undefined` ⇒
   *  `E_THR_NOT_BOUND` (R1). */
  expect?: { sessionId?: string; rev?: number };
  reason: "rebound";
  /** true ⇒ THIS call owns the lifecycle notification (retained finalize + thr_closed, after
   *  the commit barrier). false ⇒ the caller already has an equivalent hook (the `/use`
   *  inbound durable wrapper) and this function only writes + commits + reconciles. */
  notifyLifecycle: boolean;
}

export type TransferResult =
  | { ok: true; created: boolean; changed: boolean; binding: FeishuBinding }
  | { ok: false; code: string; effect: "none" | "unknown" };

export function createBindingTransfer(deps: {
  state: FeishuState;
  threads?: FeishuThreads;
  scheduleConfirm?: { reconcile(sessionId: string): void };
  log(event: string, reason?: string): void;
}) {
  async function transfer(input: TransferInput): Promise<TransferResult> {
    try {
      const before = deps.state.bindings.get(input.key);
      // R1: a first bind is a normal path; NOT_BOUND exists only on the CAS path.
      if (before === undefined && input.expect !== undefined)
        return { ok: false, code: "E_THR_NOT_BOUND", effect: "none" };
      if (before !== undefined) {
        // R3 CAS (both checks before any write).
        if (input.expect?.rev !== undefined && before.rev !== input.expect.rev)
          return { ok: false, code: "E_THR_STALE", effect: "none" };
        if (input.expect?.sessionId !== undefined && before.sessionId !== input.expect.sessionId)
          return { ok: false, code: "E_THR_NO_OWNER", effect: "none" };
        // R2 same-target no-op: no set (set bumps rev on EVERY call), no commit, no notify.
        if (before.sessionId === input.target.sessionId && before.offline === undefined)
          return { ok: true, created: false, changed: false, binding: before };
      }
      // R4: preserve the identity fields; a first bind takes them from the caller.
      const chatId = before?.chatId ?? input.identity?.chatId;
      const chatType = before?.chatType ?? input.identity?.chatType;
      const threadId = before?.threadId ?? input.identity?.threadId;
      if (chatId === undefined || chatType === undefined) {
        deps.log("binding-transfer", `missing identity fields for ${input.key}`);
        return { ok: false, code: "E_THR_STATE", effect: "none" };
      }
      const admitted = deps.state.bindings.set(input.key, {
        chatId,
        chatType,
        ...(threadId !== undefined ? { threadId } : {}),
        sessionId: input.target.sessionId,
        label: sanitizeHeaderField(input.target.label),
        offline: null,
      });
      // R5: a refused Admit leaves memory untouched.
      if (!admitted.ok) return { ok: false, code: "E_THR_STATE", effect: "none" };
      // R6: the persistence barrier — memory has moved but nothing is durable yet; a failure
      // is "unknown" and must NOT notify (the old subscribers keep working, §6 risk R3).
      if (!(await deps.state.commit())) return { ok: false, code: "E_THR_COMMIT", effect: "unknown" };
      if (input.notifyLifecycle && before !== undefined) deps.threads?.onBindingClosed(input.key, before, input.reason);
      if (before?.sessionId !== undefined) deps.scheduleConfirm?.reconcile(before.sessionId);
      deps.scheduleConfirm?.reconcile(input.target.sessionId);
      return { ok: true, created: before === undefined, changed: true, binding: admitted.value };
    } catch (err) {
      // R8: never swallow — log and report "unknown" (the write may or may not have landed).
      try {
        deps.log("binding-transfer", err instanceof Error ? err.message : String(err));
      } catch {
        /* diagnostic only */
      }
      return { ok: false, code: "E_THR_STATE", effect: "unknown" };
    }
  }
  return { transfer };
}

export type BindingTransfer = ReturnType<typeof createBindingTransfer>;
