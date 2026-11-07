/**
 * jev-reflex · setting specs (plan R0 step 4): this subsystem's slice of the settable-surface table.
 * `config/setting-specs.ts` spreads the record at the END of the table (listing order of existing keys
 * unchanged, pinned by tests/config/setting-specs-pin.test.ts).
 */
import { bool, csvString } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const REFLEX_SETTING_SPECS: Record<string, SettingSpec> = {
  "reflex.enabled": bool(
    "reflex.enabled",
    "Answer read-only tool-state questions deterministically, shadow-only until promoted (default off)",
  ),
  "reflex.autoResolve": {
    ...csvString(
      "reflex.autoResolve",
      "Comma-separated script ids allowed to answer without the model (empty = shadow only)",
    ),
    live: true,
  },
  "reflex.drafts.enabled": bool(
    "reflex.drafts.enabled",
    "Load offline-generated draft scripts (shadow-only, never autoResolve; default off)",
  ),
};
