import type { RunSnapshot } from "../core/types.js";
import type { ResolveRunResult } from "../service/resolve-target.js";

/**
 * Shared "human name next to the run id" formatting for every tool surface that
 * prints a subagent run id (steer / abort / extend / set_model / get_subagent_result).
 *
 * Result text form: `<label> (run_id: r_XXXX)`; a run without a label falls back to
 * the bare `run r_XXXX` phrase exactly as before (never "undefined", never empty parens).
 * TUI title form (compact): `<label> (r_XXXX)` / `r_XXXX`.
 */

const MAX_LABEL = 48;

/** Single-line, trimmed, bounded label; undefined for blank. */
export function cleanLabel(label: string | undefined): string | undefined {
  if (typeof label !== "string") return undefined;
  const one = label
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (one === "") return undefined;
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
}

/** The run's effective label, if it has one. */
export function labelOfSnapshot(snapshot: Pick<RunSnapshot, "diag"> | undefined): string | undefined {
  return cleanLabel(snapshot?.diag?.label);
}

/** Result-text phrase: `label (run_id: r_x)` or `run r_x`. */
export function runRefText(runId: string, label: string | undefined): string {
  const l = cleanLabel(label);
  return l === undefined ? `run ${runId}` : `${l} (run_id: ${runId})`;
}

/** TUI title fragment: `label (r_x)` or `r_x`. */
export function runRefTitle(runId: string, label: string | undefined): string {
  const l = cleanLabel(label);
  return l === undefined ? runId : `${l} (${runId})`;
}

/** Append-only optional tool-result `details` fragment read by the web ToolCard. */
export function runRefDetails(runId: string, label: string | undefined): { runId: string; label?: string } {
  const l = cleanLabel(label);
  return l === undefined ? { runId } : { runId, label: l };
}

/**
 * Cheap synchronous title lookup for renderCall (runs before execute): resolve the raw
 * handle through the existing resolver and read the label from the registry. Never
 * throws; any miss ⇒ the raw handle is shown unchanged.
 */
export function titleForHandle(
  handle: string | undefined,
  deps: {
    resolveRun?: ((handle: string) => ResolveRunResult) | undefined;
    get?: ((runId: string) => RunSnapshot | undefined) | undefined;
  },
): string {
  if (handle === undefined) return "…";
  try {
    const r = deps.resolveRun?.(handle);
    if (r?.ok) {
      const label = labelOfSnapshot(deps.get?.(r.runId));
      if (label !== undefined) return runRefTitle(r.runId, label);
    }
  } catch {
    /* title only — fall through to the raw handle */
  }
  return handle;
}

/** Never-throwing label lookup through a QueryService-shaped `get` (tests/partial ports may lack it). */
export function labelOfRun(
  query: { get?: ((runId: string) => RunSnapshot | undefined) | undefined },
  runId: string,
): string | undefined {
  try {
    return labelOfSnapshot(query.get?.(runId));
  } catch {
    return undefined;
  }
}
