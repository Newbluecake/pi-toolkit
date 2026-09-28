import type { CmdFrame, CmdResultBody } from "../protocol/messages.js";
export interface BuiltinBridge {
  execute(frame: CmdFrame): CmdResultBody;
}
export function createBuiltinBridge(): BuiltinBridge {
  return { execute: () => ({ ok: false, code: "E_UNSUPPORTED", retryable: false, effect: "none" }) };
}
