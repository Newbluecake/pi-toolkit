import { runIdsFromNotificationDetails, type ContextReceiptTracker } from "./context-receipt.js";
import { type BackgroundCompletionHub } from "../service/background-completions.js";

export function createNotificationReceiptHook(holder: {
  current?: { contextReceipt: ContextReceiptTracker };
}): (event: { message: { role?: string; customType?: string; details?: unknown } }) => void {
  return (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "subagent:notification") return;
    holder.current?.contextReceipt.noteEntered(runIdsFromNotificationDetails(message.details), Date.now());
  };
}

/**
 * ask-user-async plan §3.3 (P2): holder-routed forwarding of the three agent
 * events the background-completion hub's token state machine consumes
 * (message_start confirms, agent_end/agent_settled bound the orphan-detection
 * window). Registered once per activate() in index.ts — never inside
 * buildSessionStack — same pattern as createNotificationReceiptHook just
 * above. Lives here so integration tests exercise the real forwarding path.
 */
export function createBackgroundCompletionEventHook(holder: {
  current?: { backgroundCompletions: BackgroundCompletionHub };
}): {
  onMessageStart: (event: {
    message: { role?: string; customType?: string; content?: unknown; details?: unknown };
  }) => void;
  onAgentEnd: () => void;
  onAgentSettled: () => void;
} {
  return {
    onMessageStart: (event) => holder.current?.backgroundCompletions.noteMessageStart(event.message),
    onAgentEnd: () => holder.current?.backgroundCompletions.noteAgentEnd(),
    onAgentSettled: () => holder.current?.backgroundCompletions.noteAgentSettled(),
  };
}
