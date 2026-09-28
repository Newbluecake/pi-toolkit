import type { CmdData, CmdErrorCode, CmdOp, CtlFrame } from "../protocol/messages.js";
export type LedgerResult =
  | { ok: true; dup?: true; data: CmdData }
  | { ok: false; code: CmdErrorCode; message?: string; retryable: boolean; effect: "none" | "unknown" };
export interface CommandLedger {
  get(id: string): LedgerResult | undefined;
  set(id: string, result: LedgerResult): void;
  frame(): CtlFrame;
  dispose(): void;
}
export function createCommandLedger(): CommandLedger {
  const values = new Map<string, LedgerResult>();
  return {
    get: (id) => values.get(id),
    set: (id, result) => values.set(id, result),
    frame: () => ({ t: "ctl", epoch: "", sessionId: "", items: [] }),
    dispose: () => values.clear(),
  };
}
