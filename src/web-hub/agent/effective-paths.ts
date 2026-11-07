/** #39 effective slot adapter. P4 may use it with WebHub OFF: scopes-on is the gate,
 * not webHub.enabled. Web callers pass their SAME resolved paths object. No I/O here.
 */
import { resolveHubSlot, type HubSlotDeps } from "../../memory/scopes/hub-slot.js";
import type { EffectiveHubSlotPort } from "../../memory/scopes/types.js";

export function createEffectiveHubSlotPort(options: {
  enabled: boolean;
  domain: "plain" | "secure" | "locked";
  /** Lazy so off/secure/locked do not even read path properties or resolve HOME. */
  paths(): HubSlotDeps;
}): EffectiveHubSlotPort | undefined {
  if (!options.enabled || options.domain !== "plain") return undefined;
  return { resolve: () => resolveHubSlot(options.paths()) };
}
