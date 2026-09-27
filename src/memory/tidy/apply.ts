// §7.3 step 7 apply (backup + atomic write + manifest) — STUB (todo #22
// P0-b's frozen-surface commit; real implementation lands in package P4,
// §14.1). Will run inside `withMemoryDirLock` (`../lock.js`) and use
// `../safe-fs.js` exclusively, same as every other memory write path.

import type { TidyManifest, TidyProposal } from "../contracts.js";

export interface ApplyTidyInput {
  cwd: string;
  proposal: TidyProposal;
  decisions: ReadonlyMap<string, "apply" | "skip">;
}

export interface ApplyTidyResult {
  manifest: TidyManifest;
  applied: number;
  skipped: number;
}

/** Not implemented yet (P4). */
export async function applyTidy(_input: ApplyTidyInput): Promise<ApplyTidyResult> {
  throw new Error("applyTidy: not implemented yet (todo #22 P4)");
}
