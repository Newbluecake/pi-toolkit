// §7.5 `/mem restore` (manifest/trash recovery, hash-conflict detection) —
// STUB (todo #22 P0-b's frozen-surface commit; real implementation lands in
// package P4, §14.1).

import type { TidyManifest } from "../contracts.js";

export interface RestorePlanEntry {
  name: string;
  conflict: boolean;
  reason?: string;
}

export interface RestorePlan {
  manifest: TidyManifest;
  entries: readonly RestorePlanEntry[];
}

/** Not implemented yet (P4). */
export async function planRestore(_cwd: string, _id: string): Promise<RestorePlan> {
  throw new Error("planRestore: not implemented yet (todo #22 P4)");
}
