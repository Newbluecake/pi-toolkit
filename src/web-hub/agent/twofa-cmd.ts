/** P0 F contract. Local-secret command gate must be independent of web command policy. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TfaReqFrame, TfaResFrame } from "../protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../protocol/version.js";
import type { TwofaPromptDeps } from "./twofa-prompt.js";
export interface TwofaCommandDeps extends TwofaPromptDeps {
  notify(message: string, level: "info" | "warning" | "error"): void;
}
/** Cap gate can be tested before F is implemented. Old hubs must never receive unknown frames. */
export function requestTfa(
  deps: Pick<TwofaPromptDeps, "hasCap" | "request">,
  frame: TfaReqFrame,
): Promise<TfaResFrame> {
  if (!deps.hasCap(LAN_2FA_HUB_CAP))
    return Promise.resolve({
      t: "tfa_res",
      rid: frame.rid,
      ok: false,
      code: "E_UNSUPPORTED",
      message: "hub 版本过旧，请 /webhub restart",
    });
  return deps.request(frame, LAN_2FA_HUB_CAP);
}
export async function runTwofaCommand(
  _args: string,
  _ctx: ExtensionCommandContext,
  _deps: TwofaCommandDeps,
): Promise<void> {
  throw new Error("LAN security P0: TUI 2FA command not implemented");
}
