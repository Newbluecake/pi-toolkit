/** P0 F prompt port. Secrets are rendered ONLY by the TUI after the independent command gate. */
import type { TfaReqFrame, TfaResFrame } from "../protocol/lan-2fa.js";
export interface TwofaPromptDeps {
  hasCap(cap: string): boolean;
  request(frame: TfaReqFrame, requiredCap: string): Promise<TfaResFrame>;
  promptCode(title: string): Promise<string | undefined>;
  /** F supplies renderQr + base32 fallback; no browser/Feishu output. */
  showEnrollment(input: { otpauthUri: string; secretB32: string }): void;
  showRecoveryCodes(codes: readonly string[]): void;
  hasFeishuOwner(): Promise<boolean>;
}
export type TwofaPromptOutcome =
  { ok: true } | { ok: false; reason: "no-cap" | "cancelled" | "rejected"; message?: string };
export async function runTwofaEnrollPrompt(_deps: TwofaPromptDeps, _replace = false): Promise<TwofaPromptOutcome> {
  throw new Error("LAN security P0: TUI 2FA prompt not implemented");
}
