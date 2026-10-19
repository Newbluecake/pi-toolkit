/** P0 factory signature for A. Not wired. The active guard must fail closed until A implements it. */
import type { ClientAllowGuard, HubLog } from "./ports.js";
export type { ClientAllowGuard } from "./ports.js";
export interface ClientAllowGuardDeps {
  entries?: string[];
  now?: () => number;
  log?: Pick<HubLog, "info">;
  /** Test seam only, never config. */
  implicitLoopback?: false;
}
export function createClientAllowGuard(_deps: ClientAllowGuardDeps): ClientAllowGuard {
  throw new Error("LAN security P0: client allow guard not implemented");
}
