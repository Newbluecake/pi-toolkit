/** Assembly-local bridge, not wire or frozen P0 ports. Both HTTP listeners receive
 * the SAME routes/fence/views; authentication remains the original authority. */
import type { AuthIdentity } from "../../auth-identity.js";
import type { AuthRevokeSelector } from "../../auth-revoke.js";
import type { TerminalAuthFact, TerminalAuthFenceV2, TerminalRoutesPortV2 } from "../../terminal-v2-ports.js";
import type { TerminalRevalidateV2 } from "./view.js";
export interface TerminalFrontendV2 {
  routes: TerminalRoutesPortV2;
  auth: import("./revocation-fence.js").TerminalRevocationFenceV2;
  attachAuthority(revalidate: TerminalRevalidateV2): void;
}
export interface TerminalFrontendDepsV2 {
  terminalV2?: TerminalFrontendV2;
}
export const isTerminalPathV2 = (path: string) => path.split("?")[0]!.startsWith("/api/terminal/");
/** Terminal exceptions cannot change auth's execution point, deadline or result. */
export function invalidateTerminalAuthV2(
  fence: TerminalAuthFenceV2 | undefined,
  selector: AuthRevokeSelector,
): number | undefined {
  try {
    return fence?.invalidate(selector);
  } catch {
    return undefined;
  }
}
export function settleTerminalAuthV2(
  fence: TerminalAuthFenceV2 | undefined,
  selector: AuthRevokeSelector,
  revision: number | undefined,
  fact: TerminalAuthFact,
): void {
  if (revision === undefined) return;
  try {
    fence?.settle(selector, revision, fact);
  } catch {
    /* auth owns its result */
  }
}

/** Trusted request context carried only on an internal identity, never serialized.
 * Enumerable symbol survives the view's frozen spread, without extending P0/wire. */
export const terminalAuthSourceV2: unique symbol = Symbol("terminal-auth-source-v2");
export type TerminalSourcedIdentityV2 = AuthIdentity & {
  [terminalAuthSourceV2]?: Readonly<{ origin: string; clientIp: string }>;
};
