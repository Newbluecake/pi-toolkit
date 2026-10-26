/**
 * Tool-name single source of truth for the background-run result tool.
 *
 * Zero imports on purpose: `src/core` is pi-free (tests/boundary/pi-free.test.ts) and
 * delivery / schedule / config / commands / feishu-notify all read the name from here.
 */

/** Current name of the tool that reads a background run (r_…) or workflow (wf_…). */
export const RESULT_TOOL_NAME = "get_run_result";

/**
 * ≤ v0.9.x name. Kept as a reserved name in child sessions, drawn for history
 * (TUI renderer, web UI) and mapped in name-keyed user settings — never registered.
 */
export const LEGACY_RESULT_TOOL_NAME = "get_subagent_result";

/** Legacy → current rename map for name-keyed user settings. */
const TOOL_NAME_RENAMES: Readonly<Record<string, string>> = {
  [LEGACY_RESULT_TOOL_NAME]: RESULT_TOOL_NAME,
};

/** Apply the rename map to a name list (order-preserving, de-duplicated). */
export function migrateToolNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const mapped = Object.hasOwn(TOOL_NAME_RENAMES, name) ? (TOOL_NAME_RENAMES[name] as string) : name;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}
