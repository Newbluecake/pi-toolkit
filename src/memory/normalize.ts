// §4.2 official-field/legacy-alias normalization — STUB (todo #22 P0-b's
// frozen-surface commit; real implementation lands in package P2, §14.1).

import type { NormalizedCall } from "./contracts.js";
import type { MemoryToolParamsV2 } from "./tool-surface.js";

/** Not implemented yet (P2). Pure function — §4.2's alias/mutual-exclusion
 *  table; returns a `NormalizedCall` or throws a user-facing `Error` for a
 *  conflicting/invalid combination (never a `MemoryError`, per §4.2's
 *  command-facing error convention). */
export function normalizeMemoryCall(_params: MemoryToolParamsV2): NormalizedCall {
  throw new Error("normalizeMemoryCall: not implemented yet (todo #22 P2)");
}
