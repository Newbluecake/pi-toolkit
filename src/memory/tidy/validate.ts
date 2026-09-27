// §7.3 step 5 tidy proposal validation — STUB (todo #22 P0-b's
// frozen-surface commit; real implementation lands in package P4, §14.1).

import type { TidyProposal } from "../contracts.js";

export interface TidyValidationIssue {
  file?: string;
  message: string;
}

export interface TidyValidationResult {
  ok: boolean;
  issues: readonly TidyValidationIssue[];
}

/** Not implemented yet (P4). Pure function. */
export function validateTidyProposal(_proposal: TidyProposal): TidyValidationResult {
  throw new Error("validateTidyProposal: not implemented yet (todo #22 P4)");
}
