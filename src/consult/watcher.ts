/**
 * #40 shim: the cap watcher moved to `src/runtime/cap-watcher.ts` (docs/dev/consult-removal/plan.md §2).
 * Kept only so `src/consult/**` keeps compiling until PS1b deletes it.
 */
import type { RunCapReason } from "../runtime/cap-watcher.js";

export { createCapWatcher } from "../runtime/cap-watcher.js";
export type { CapWatcher } from "../runtime/cap-watcher.js";
export type ConsultCapReason = RunCapReason;
