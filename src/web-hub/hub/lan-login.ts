/** P0 factory for C; no HTTP call site until I wires it after C's tests pass. */
import type { LanLoginCore, LanLoginCoreDeps } from "./ports.js";
export type { LanLoginCore, LanLoginCoreDeps, LoginIo, LoginReply, LoginApprovalPort } from "./ports.js";
export function createLanLoginCore(_deps: LanLoginCoreDeps): LanLoginCore {
  throw new Error("LAN security P0: login core not implemented");
}
