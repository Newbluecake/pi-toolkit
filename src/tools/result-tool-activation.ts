/**
 * Active-tool migration for the result-tool rename (get_subagent_result → get_run_result).
 *
 * Why it exists: pi ≥ 1.3 restores a session's active tools from its transcript on resume / fork /
 * `/resume` (AgentSession construction) and on `/tree` navigation (before `session_tree` fires). The
 * restore OVERWRITES the active set with what the transcript declared, so a session recorded under the
 * old name comes back with the new tool registered but NOT active — the model would have no result
 * tool at all. `/reload` is not affected (pi keeps the active set and activates newly registered tools).
 *
 * Fail-safe design (r3 R2-B1): the migration only ever APPENDS the new name, and only when
 *   ① the transcript's current tool declarations contain the legacy name,
 *   ② the new name is registered (pi's registry is already filtered by `--tools`/`--exclude-tools`
 *      allow rules) and not active, and
 *   ③ this process carries no tool-selection argument at all (`--tools`, `--exclude-tools`,
 *      `--no-tools`, `--no-builtin-tools` and their short forms). pi applies `+name`/`-name` modifiers
 *      to the restored loadout and an extension cannot read them back, so any such argument means
 *      "the user shaped the loadout" and we leave it alone.
 * Anything unreadable ⇒ no migration. Pi-facing but stateless; hooked from the already-registered
 * session_start / session_tree handlers (no new handler, so handlerCounts goldens do not move).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import { LEGACY_RESULT_TOOL_NAME, RESULT_TOOL_NAME } from "../core/tool-names.js";

/** Pure decision: the activation set to apply, or undefined when nothing should change. */
export function planResultToolActivation(input: {
  /** Tool names the transcript currently declares. */
  declared: readonly string[];
  /** Currently active tool names. */
  active: readonly string[];
  /** Registered (and allowed) tool names. */
  registered: readonly string[];
}): string[] | undefined {
  if (!input.declared.includes(LEGACY_RESULT_TOOL_NAME)) return undefined;
  if (!input.registered.includes(RESULT_TOOL_NAME)) return undefined;
  if (input.active.includes(RESULT_TOOL_NAME)) return undefined;
  return [...input.active, RESULT_TOOL_NAME];
}

const TOOL_SELECTION_FLAGS: ReadonlySet<string> = new Set([
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
]);

/** True when argv shapes the tool loadout (any form, including `--flag=value`). */
export function hasToolSelectionArgs(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    if (TOOL_SELECTION_FLAGS.has(arg)) return true;
    const eq = arg.indexOf("=");
    return eq > 0 && arg.startsWith("--") && TOOL_SELECTION_FLAGS.has(arg.slice(0, eq));
  });
}

type GetCurrentTools = (messages: readonly { role: string }[]) => readonly { name: string }[];

function getCurrentToolsFn(): GetCurrentTools | undefined {
  const fn = (piAi as unknown as { getCurrentTools?: GetCurrentTools }).getCurrentTools;
  return typeof fn === "function" ? fn : undefined;
}

/**
 * Wire the migration. Returns a function to call from `session_start` / `session_tree`; it never throws
 * and does nothing when any required pi capability is missing (stub pi, pi < 1.3) or argv is unreadable.
 */
export function createResultToolActivation(
  pi: ExtensionAPI,
  opts: { argv?: () => readonly string[] | undefined } = {},
): (ctx: ExtensionContext) => void {
  const readArgv = opts.argv ?? (() => process.argv);
  return (ctx) => {
    try {
      if (
        typeof pi.getActiveTools !== "function" ||
        typeof pi.setActiveTools !== "function" ||
        typeof pi.getAllTools !== "function"
      )
        return;
      const getCurrentTools = getCurrentToolsFn();
      const sessionManager = ctx?.sessionManager as
        { buildSessionProjection?: () => { messages: unknown[] } } | undefined;
      if (getCurrentTools === undefined || typeof sessionManager?.buildSessionProjection !== "function") return;
      const argv = readArgv();
      if (!Array.isArray(argv) || hasToolSelectionArgs(argv)) return;
      const messages = sessionManager.buildSessionProjection().messages as readonly { role: string }[];
      const next = planResultToolActivation({
        declared: getCurrentTools(messages).map((tool) => tool.name),
        active: pi.getActiveTools(),
        registered: pi.getAllTools().map((tool) => tool.name),
      });
      if (next !== undefined) pi.setActiveTools(next);
    } catch (err) {
      console.warn(`[pi-subagent] result-tool activation migration skipped: ${(err as Error)?.message ?? String(err)}`);
    }
  };
}
