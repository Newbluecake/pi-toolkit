/**
 * Manual-compaction window tracker (plan §4.2/D13).
 *
 * D13: only the explicit `session_before_compact{reason:"manual"}` →
 * `session_compact`/`session_compact_failed{reason:"manual"}` window maps to
 * `E_BUSY_COMPACTING`. Threshold/overflow compaction and branch summaries
 * never set this — pi's own `prompt()` only rejects while
 * `_compactionAbortController` (manual compaction) is set
 * (`agent-session.js:1226-1227`); a heuristic like `!isIdle() && signal ===
 * undefined` would misfire on those other paths.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CompactionState {
  readonly manualCompacting: boolean;
  dispose(): void;
}

function reasonOf(event: unknown): unknown {
  return event !== null && typeof event === "object" ? (event as { reason?: unknown }).reason : undefined;
}

export function createCompactionState(pi: ExtensionAPI): CompactionState {
  let manual = false;
  const offBefore = pi.on("session_before_compact", (event) => {
    if (reasonOf(event) === "manual") manual = true;
  });
  const offOk = pi.on("session_compact", (event) => {
    if (reasonOf(event) === "manual") manual = false;
  });
  const offFailed = pi.on("session_compact_failed", (event) => {
    if (reasonOf(event) === "manual") manual = false;
  });
  return {
    get manualCompacting() {
      return manual;
    },
    dispose() {
      for (const off of [offBefore, offOk, offFailed]) {
        try {
          off();
        } catch {
          /* never let teardown fail */
        }
      }
    },
  };
}
