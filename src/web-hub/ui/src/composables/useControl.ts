import type { InjectionKey } from "vue";
import type { ControlHandle, CmdOutcome } from "../types.js";
import type { CmdRequest, DialogRequest, HubTransport } from "../transport/types.js";

export const CONTROL_CTX: InjectionKey<{ agentKey: string; control: ControlHandle; enabled: boolean }> =
  Symbol("web-hub-control");

/** C0 transport facade. The unsupported transport keeps the P1 UI byte-identical. */
export function createControl(
  transport: HubTransport,
  dispatch: (msg: { event: string; data?: unknown; id?: number }) => void,
): ControlHandle {
  const drafts = new Map<string, string>();
  const unsupported = (): CmdOutcome => ({ ok: false, error: "E_UNSUPPORTED", retryable: false, effect: "none" });
  const command = (req: CmdRequest): Promise<CmdOutcome> => transport.command(req);
  const dialog = (req: DialogRequest): Promise<CmdOutcome> => transport.dialog(req);
  return {
    sendPrompt: (agentKey, text, deliver) => command({ agentKey, id: cryptoRandomId(), op: "prompt", text, deliver }),
    abort: (agentKey) => command({ agentKey, id: cryptoRandomId(), op: "abort" }),
    steerSub: (agentKey, runId, text) => command({ agentKey, id: cryptoRandomId(), op: "steer_subagent", runId, text }),
    stopSub: (agentKey, runId) => command({ agentKey, id: cryptoRandomId(), op: "abort_subagent", runId }),
    answerDialog: (agentKey, dialogId, epoch, answers) =>
      dialog({
        agentKey,
        id: cryptoRandomId(),
        dialogId,
        epoch,
        action: "answer",
        answers: answers as DialogRequest["answers"],
      }),
    cancelDialog: (agentKey, dialogId, epoch) =>
      dialog({ agentKey, id: cryptoRandomId(), dialogId, epoch, action: "cancel" }),
    runCommand: (agentKey, name, args, opts) =>
      command({ agentKey, id: cryptoRandomId(), op: "command", name, args, ...(opts ?? {}) }),
    query: async () => unsupported(),
    retry: async () => unsupported(),
    discard: (agentKey, id) => dispatch({ event: "ctl_discard", data: { agentKey, id } }),
    draft: (agentKey) => drafts.get(agentKey) ?? "",
    setDraft: (agentKey, text) => drafts.set(agentKey, text),
  };
}
function cryptoRandomId(): string {
  try {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  }
}
export function useControl(
  transport: HubTransport,
  dispatch: (msg: { event: string; data?: unknown; id?: number }) => void,
): ControlHandle {
  return createControl(transport, dispatch);
}
