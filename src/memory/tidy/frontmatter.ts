// §7.4 `--frontmatter` deterministic metadata backfill — STUB (todo #22
// P0-b's frozen-surface commit; real implementation lands in package P4,
// §14.1). Zero model cost — pure function over already-parsed `MemoryMeta`.

import type { MemoryMeta } from "../contracts.js";

export interface FrontmatterProposal {
  name: string;
  patch: Partial<Pick<MemoryMeta, "description" | "topic" | "status">>;
}

/** Not implemented yet (P4). Pure function; must be idempotent (§7.4: a
 *  second run over an already-backfilled directory produces `[]`). */
export function planFrontmatterBackfill(
  _files: readonly { name: string; body: string; meta: MemoryMeta; isPrimaryCore: boolean }[],
): FrontmatterProposal[] {
  throw new Error("planFrontmatterBackfill: not implemented yet (todo #22 P4)");
}
