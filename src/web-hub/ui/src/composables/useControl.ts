/**
 * Control-plane handle (control-plan v2.1 §7.1/§7.3/§7.7, package C4 — takes over C0's stub).
 *
 * Every visible control state change goes through `dispatch()` into `@logic/state.js`'s
 * reducer (and from there through the render gate — the hidden-page rule stays the single
 * source of truth): `ctl_send` before the wire call (optimistic item), `ctl_result` with a
 * `pendingTransition` event once the transport settles. The wire payloads themselves are kept
 * in a bounded in-memory map so `query()` (queryOnly, §3.4) and `retry()` (same id, §7.3) can
 * resend the exact frame without the component remembering anything.
 *
 * Composer drafts live in a plain per-agentKey `Map` (§7.1: survives agent switches, lost on
 * refresh — no localStorage, source-scan rule unchanged).
 *
 * K18: ids come from `@logic/control.js`'s `newCmdId` (`crypto.getRandomValues`, never
 * `crypto.randomUUID` — LAN plaintext HTTP has no randomUUID).
 */
import type { InjectionKey } from "vue";
import { newCmdId } from "@logic/control.js";
import type { ControlHandle, CmdOutcome } from "../types.js";
import type { CmdRequest, DialogRequest, HubTransport } from "../transport/types.js";
import { createUploads } from "./useUploads.js";

export const CONTROL_CTX: InjectionKey<{ agentKey: string; control: ControlHandle; enabled: boolean }> =
  Symbol("web-hub-control");

/**
 * How long the original wire payloads are retained for query/retry. §3.4's assertion: the
 * agent ledger (30 min TTL) outlives the browser's interest in a pending item (10 min), so a
 * small FIFO bound here can never strand a legitimate query.
 */
const REQUESTS_CAP = 128;

export interface ControlOptions {
  /** Current session id of an agent (D21: prompt/abort/command carry `expect.sessionId`). */
  getSessionId?(agentKey: string): string | undefined;
  now?(): number;
}

type StoredRequest = { channel: "cmd"; req: CmdRequest } | { channel: "dialog"; req: DialogRequest };
type DispatchMsg = { event: string; data?: unknown; id?: number };

export function createControl(
  transport: HubTransport,
  dispatch: (msg: DispatchMsg) => void,
  opts: ControlOptions = {},
): ControlHandle {
  const now = opts.now ?? Date.now;
  const drafts = new Map<string, string>();
  /** Insertion-ordered FIFO of the original wire payloads, keyed `${agentKey}|${id}`. */
  const requests = new Map<string, StoredRequest>();

  const keyOf = (agentKey: string, id: string): string => `${agentKey}|${id}`;

  function remember(key: string, stored: StoredRequest): void {
    requests.delete(key); // refresh insertion order
    requests.set(key, stored);
    while (requests.size > REQUESTS_CAP) {
      const oldest = requests.keys().next().value;
      if (oldest === undefined) break;
      requests.delete(oldest);
    }
  }

  /** D21: `expect.sessionId` rides every prompt/abort/command (§7.7); never on sub-agent ops. */
  function expectFor(agentKey: string): { expect?: { sessionId: string } } {
    const sessionId = opts.getSessionId?.(agentKey);
    return sessionId ? { expect: { sessionId } } : {};
  }

  function sendCmd(agentKey: string, item: Record<string, unknown>, req: CmdRequest): Promise<CmdOutcome> {
    remember(keyOf(agentKey, req.id), { channel: "cmd", req });
    dispatch({ event: "ctl_send", data: { agentKey, item } });
    return transport.command(req).then((outcome) => {
      dispatch({ event: "ctl_result", data: { agentKey, id: req.id, transition: { type: "result", outcome } } });
      return outcome;
    });
  }

  function sendDialog(agentKey: string, item: Record<string, unknown>, req: DialogRequest): Promise<CmdOutcome> {
    remember(keyOf(agentKey, req.id), { channel: "dialog", req });
    dispatch({ event: "ctl_send", data: { agentKey, item } });
    return transport.dialog(req).then((outcome) => {
      dispatch({ event: "ctl_result", data: { agentKey, id: req.id, transition: { type: "result", outcome } } });
      return outcome;
    });
  }

  const localMiss = (): CmdOutcome => ({
    ok: false,
    error: "E_UNKNOWN_ID",
    message: "request not retained locally (page was reloaded) — resend as a new action",
    retryable: false,
    effect: "none",
  });

  // U4b (web-hub-upload plan §6): mount the tray driver only when the transport implements
  // `upload` (both real adapters do; test fakes / future transports may not) — `ControlHandle.
  // uploads` is optional for exactly that reason.
  const uploadTransport = transport.upload;
  const uploads = uploadTransport !== undefined ? createUploads({ upload: uploadTransport }) : undefined;

  return {
    sendPrompt: (agentKey, text, deliver) => {
      const id = newCmdId();
      return sendCmd(
        agentKey,
        { id, kind: "prompt", text, deliver, state: "sending", at: now() },
        { agentKey, id, op: "prompt", text, deliver, ...expectFor(agentKey) },
      );
    },
    abort: (agentKey) => {
      const id = newCmdId();
      return sendCmd(
        agentKey,
        { id, kind: "abort", state: "sending", at: now() },
        { agentKey, id, op: "abort", ...expectFor(agentKey) },
      );
    },
    steerSub: (agentKey, runId, text) => {
      const id = newCmdId();
      return sendCmd(
        agentKey,
        { id, kind: "steer_subagent", runId, text, state: "sending", at: now() },
        { agentKey, id, op: "steer_subagent", runId, text },
      );
    },
    stopSub: (agentKey, runId) => {
      const id = newCmdId();
      return sendCmd(
        agentKey,
        { id, kind: "abort_subagent", runId, state: "sending", at: now() },
        { agentKey, id, op: "abort_subagent", runId },
      );
    },
    answerDialog: (agentKey, dialogId, epoch, answers, id = newCmdId()) => {
      return sendDialog(
        agentKey,
        { id, kind: "dialog_answer", dialogId, state: "sending", at: now() },
        {
          agentKey,
          id,
          dialogId,
          epoch,
          action: "answer",
          answers: answers as readonly { selected: readonly string[]; other: string | null }[],
        },
      );
    },
    cancelDialog: (agentKey, dialogId, epoch, id = newCmdId()) => {
      return sendDialog(
        agentKey,
        { id, kind: "dialog_cancel", dialogId, state: "sending", at: now() },
        { agentKey, id, dialogId, epoch, action: "cancel" },
      );
    },
    runCommand: (agentKey, name, args, cmdOpts) => {
      const id = newCmdId();
      return sendCmd(
        agentKey,
        { id, kind: "command", name, state: "sending", at: now() },
        {
          agentKey,
          id,
          op: "command",
          name,
          args,
          ...(cmdOpts?.confirm === true ? { confirm: true as const } : {}),
          ...expectFor(agentKey),
        },
      ).then((outcome) => {
        // 2026-10-05 field report: E_CONFIRM_REQUIRED means the command never executed and the
        // caller (DetailDock) drives the CommandConfirm dialog, then re-issues with a NEW id +
        // confirm:true. Without this discard the ctl_result leaves a zombie "failed" queue card
        // whose 重试 re-sends the SAME id WITHOUT confirm:true — it can only fail again.
        if (!outcome.ok && outcome.error === "E_CONFIRM_REQUIRED") {
          requests.delete(keyOf(agentKey, id));
          dispatch({ event: "ctl_discard", data: { agentKey, id } });
        }
        return outcome;
      });
    },
    /** §3.4/§3.5: queryOnly — ask the agent ledger for the outcome of `id`, never re-execute. */
    query: async (agentKey, id) => {
      const stored = requests.get(keyOf(agentKey, id));
      if (!stored) return localMiss();
      dispatch({ event: "ctl_result", data: { agentKey, id, transition: { type: "query_start" } } });
      const outcome =
        stored.channel === "cmd"
          ? await transport.command({ ...stored.req, queryOnly: true })
          : await transport.dialog({ ...stored.req, queryOnly: true });
      dispatch({ event: "ctl_result", data: { agentKey, id, transition: { type: "query_result", outcome } } });
      return outcome;
    },
    /** §7.3: re-execute a FAILED (effect:none) request with the same id — hub/agent dedupe it. */
    retry: async (agentKey, id) => {
      const stored = requests.get(keyOf(agentKey, id));
      if (!stored) return localMiss();
      dispatch({ event: "ctl_retry", data: { agentKey, id } });
      const outcome =
        stored.channel === "cmd" ? await transport.command(stored.req) : await transport.dialog(stored.req);
      dispatch({ event: "ctl_result", data: { agentKey, id, transition: { type: "result", outcome } } });
      return outcome;
    },
    discard: (agentKey, id) => {
      requests.delete(keyOf(agentKey, id));
      dispatch({ event: "ctl_discard", data: { agentKey, id } });
    },
    draft: (agentKey) => drafts.get(agentKey) ?? "",
    setDraft: (agentKey, text) => void drafts.set(agentKey, text),
    ...(uploads !== undefined ? { uploads } : {}),
  };
}

export function useControl(
  transport: HubTransport,
  dispatch: (msg: DispatchMsg) => void,
  opts: ControlOptions = {},
): ControlHandle {
  return createControl(transport, dispatch, opts);
}
