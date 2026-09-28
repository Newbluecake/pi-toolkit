/**
 * §4.6 policy table (plan control-plan.md §4.6/§4.9, package C11).
 *
 * Pure classification logic, no pi imports: given a command's classified `kind` (from
 * `slash.ts`, which reads `pi.getCommands()` + the builtin name sets below) and its raw
 * `args`, decides `allow | confirm | deny` — including the pi-toolkit sub-command-level table
 * the plan explicitly calls for (§4.6's "pi-toolkit 自有命令... 子命令级表（C11 逐一列出）" row).
 *
 * `webHub.webCommandPolicy` overrides win outright over everything below (§4.6 U8); busy-state
 * overrides (`policyBusy`, today only `/compact`) are resolved by the caller via
 * `effectivePolicy()` once it knows whether the agent is idle.
 */
export type CommandPolicy = "allow" | "confirm" | "deny";
export type CommandKind = "extension" | "template" | "skill" | "builtin";

export interface PolicyDecision {
  policy: CommandPolicy;
  policyBusy?: CommandPolicy;
}

/** True builtin commands (`BUILTIN_SLASH_COMMANDS`) the bridge executes directly via plain
 *  `pi`/`ExtensionContext` calls (§4.6's "内置桥" column). */
export const BUILTIN_BRIDGE_NAMES: ReadonlySet<string> = new Set([
  "session",
  "name",
  "thinking",
  "model",
  "compact",
  "new",
  "reload",
]);

/** Every other name pi ships in `BUILTIN_SLASH_COMMANDS` (plus the bare-word `exit`, which pi
 *  itself only special-cases as `source:"interactive"` text — never a slash command — but the
 *  plan calls out `/quit`/`/exit` together, so a literal `/exit` name is denied defensively
 *  too): TUI overlay / host-file / clipboard / process-exit / session-switch commands this
 *  bridge does not implement (§4.6's builtin deny rows). */
export const BUILTIN_DENY_NAMES: ReadonlySet<string> = new Set([
  "settings",
  "tree",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "resume",
  "quit",
  "debug",
  "exit",
  // pi 0.87.1's two hidden easter-egg built-ins (interactive-mode.js:2566-2573) — denying them
  // explicitly keeps the classification table in sync with pi's real TUI command set instead of
  // relying on the unknown-command fallback (which also denies, but invisibly).
  "arminsayshi",
  "dementedelves",
]);

function builtinPolicy(name: string, args: string): PolicyDecision | undefined {
  switch (name) {
    case "session":
      return { policy: "allow" };
    case "name":
    case "thinking":
    case "model":
      // No argument opens a TUI selector pi has no extension-facing equivalent for (§4.6 rows).
      return { policy: args.trim() === "" ? "deny" : "allow" };
    case "compact":
      return { policy: "allow", policyBusy: "confirm" };
    case "new":
    case "reload":
      return { policy: "confirm" };
    default:
      return BUILTIN_DENY_NAMES.has(name) ? { policy: "deny" } : undefined;
  }
}

/**
 * pi-toolkit's own extension commands (§4.6's "子命令级表"), keyed by the FIRST whitespace token
 * of `args` (the sub-command). Read-only / idempotent sub-commands are `allow`; anything that
 * mutates settings, writes files, dispatches a subagent, or sends external notifications is
 * `confirm`; sub-commands whose only UI is a TUI-only selector with no text fallback are `deny`.
 * Reference (read-only, per plan §12.3): `src/commands/status.ts`, `src/memory/command.ts`,
 * `src/cache-ttl/cache-ttl.ts`, `src/todo/index.ts`, `src/goal/command.ts`, `src/commands/task.ts`,
 * `src/feishu-notify/index.ts`, `src/hud/index.ts`, `src/session-nav/index.ts`,
 * `src/commands/webhub.ts`.
 */
type SubPolicyFn = (tokens: readonly string[]) => PolicyDecision;

const PI_TOOLKIT_TABLE: Readonly<Record<string, SubPolicyFn>> = {
  // /agent [status|<runId>] · costs · fleet → read-only text. settings/budget with no further
  // args falls back to the text listing (allow, §4.9's C12 text-fallback row); with a
  // set/reset/list arg it mutates persisted settings (confirm). reload always confirms — it is
  // the same action as the builtin `/reload` row, just reached under its native extension name.
  agent(tokens) {
    const sub = tokens[0];
    if (sub === undefined || sub === "status" || sub === "costs" || sub === "fleet") return { policy: "allow" };
    if (sub === "settings" || sub === "budget") return { policy: tokens.length <= 1 ? "allow" : "confirm" };
    if (sub === "reload") return { policy: "confirm" };
    // Anything else is a bare runId/prefix (`/agent r_xxx`) — a read-only detail view.
    return { policy: "allow" };
  },
  // /mem [list] · path · doctor → read-only. import/tidy/restore write files or (tidy/restore)
  // are multi-step interactive flows the web caller cannot drive (§4.9's downgrade-to-cancel row).
  mem(tokens) {
    const sub = tokens[0];
    if (sub === undefined || sub === "list" || sub === "path" || sub === "doctor") return { policy: "allow" };
    return { policy: "confirm" };
  },
  // /cache-ttl [status] → read-only. Every mode switch / keepalive toggle / save mutates process
  // (or persisted) state.
  "cache-ttl"(tokens) {
    const sub = tokens[0];
    if (sub === undefined || sub === "status") return { policy: "allow" };
    return { policy: "confirm" };
  },
  // /tasklist [no args] → read-only listing (text fallback, §4.9). `clear` is destructive.
  tasklist(tokens) {
    return { policy: tokens[0] === undefined ? "allow" : "confirm" };
  },
  // /goal [status] → read-only. pause/resume/clear mutate the loop; any other single token is
  // free-text objective, which starts a new loop (also mutating).
  goal(tokens) {
    const sub = tokens[0];
    return { policy: sub === undefined || sub === "status" ? "allow" : "confirm" };
  },
  // /task always dispatches a background subagent.
  task() {
    return { policy: "confirm" };
  },
  // /watch toggles a per-session flag with no confirmation step in the terminal either, but it
  // changes standing behavior (every future task end notifies Feishu) — confirm on the web.
  watch() {
    return { policy: "confirm" };
  },
  // /feishu-test sends an outbound webhook call.
  "feishu-test"() {
    return { policy: "confirm" };
  },
  // /pi-hud-refresh is an idempotent, harmless `git fetch` kick.
  "pi-hud-refresh"() {
    return { policy: "allow" };
  },
  // /clear is session-nav's alias for /new (same confirm as the builtin row).
  clear() {
    return { policy: "confirm" };
  },
  // /resume-recent always opens a TUI-only session picker (`ctx.ui.custom`); no text fallback
  // exists for either the 48h-window or --all form.
  "resume-recent"() {
    return { policy: "deny" };
  },
  // /webhub: only the read-only `status` (default) sub-command is web-safe; everything else
  // (open/passwd/unlock/restart, and the internal `__exec` nonce bridge) is denied — a web caller
  // must not be able to manage its own hub's auth or trigger the internal exec bridge directly.
  webhub(tokens) {
    const sub = tokens[0] ?? "status";
    return { policy: sub === "status" ? "allow" : "deny" };
  },
};

function tokenize(args: string): string[] {
  const trimmed = args.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

export interface ResolvePolicyOptions {
  name: string;
  args: string;
  kind: CommandKind;
  overrides?: Record<string, CommandPolicy>;
}

/** Main entry point (§4.6/§4.9): resolves the base decision for a classified command, before
 *  the busy/idle split (`effectivePolicy`) and before the caller checks `cmd.confirm`. */
export function resolveCommandPolicy(opts: ResolvePolicyOptions): PolicyDecision {
  const override = opts.overrides?.[opts.name];
  if (override !== undefined) return { policy: override };
  if (opts.kind === "template" || opts.kind === "skill") return { policy: "allow" };
  if (opts.kind === "builtin") return builtinPolicy(opts.name, opts.args) ?? { policy: "deny" };
  // extension: pi-toolkit's own table first, third-party extension commands default to confirm
  // (§4.6: "效果未知" — the confirmation is UX friction, not a new privilege boundary, since the
  // same principal can already ask the model to run arbitrary bash).
  const rule = PI_TOOLKIT_TABLE[opts.name];
  return rule ? rule(tokenize(opts.args)) : { policy: "confirm" };
}

/** Applies the busy/idle split (only `/compact` has a `policyBusy` today). */
export function effectivePolicy(decision: PolicyDecision, busy: boolean): CommandPolicy {
  return busy && decision.policyBusy !== undefined ? decision.policyBusy : decision.policy;
}
