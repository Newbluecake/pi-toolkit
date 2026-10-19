/** P0 factory for D; no request dispatch until I wires it. */
import type { LanSessionsDeps, LanSessionsRoutes } from "./ports.js";
export type { LanSessionsDeps, LanSessionsRoutes, LanSessionsIo } from "./ports.js";
export function createLanSessionsRoutes(_deps: LanSessionsDeps): LanSessionsRoutes {
  throw new Error("LAN security P0: session routes not implemented");
}
