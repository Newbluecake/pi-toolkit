import type { CmdFrame, CmdResultFrame } from "../protocol/messages.js";
export interface CommandRouter {
  run(frame: CmdFrame, agentKey: string): Promise<CmdResultFrame>;
  drain(): Promise<{ inflight: number; timedOut: boolean }>;
  inflight(): number;
}
export function createCommandRouter(): CommandRouter {
  return {
    run: async (frame) => ({
      t: "cmd_result",
      rid: frame.rid,
      id: frame.id,
      ok: false,
      code: "E_UNSUPPORTED",
      retryable: false,
      effect: "none",
    }),
    drain: async () => ({ inflight: 0, timedOut: false }),
    inflight: () => 0,
  };
}
