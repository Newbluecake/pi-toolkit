// §4.4 T3 budget feedback + exact-duplicate-line detection — STUB (todo #22
// P0-b's frozen-surface commit; real implementation lands in package P2,
// §14.1).

import type { BudgetReport } from "./contracts.js";

export interface DuplicateLineHit {
  line: string;
  alsoAt: string; // "<file>:<lineNo>"
}

/** Not implemented yet (P2). Pure function — §4.4's normalize-and-compare
 *  exact-duplicate-line scan (never approximate matching, that's D12/§13). */
export function findExactDuplicates(
  _newLines: readonly string[],
  _corpus: readonly { file: string; lines: readonly string[] }[],
): DuplicateLineHit[] {
  throw new Error("findExactDuplicates: not implemented yet (todo #22 P2)");
}

/** Not implemented yet (P2). Pure function — the `budget: …` feedback line
 *  appended to every successful v2 write/append result. */
export function computeBudgetReport(_cwd: string, _changedFile: string): BudgetReport {
  throw new Error("computeBudgetReport: not implemented yet (todo #22 P2)");
}
