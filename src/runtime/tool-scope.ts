/**
 * X11: dynamic tool-scope re-enforcement (architecture \u00a77.5). Zero
 * `@earendil-works/*` import (I1) \u2014 operates purely on the narrow
 * `getActiveTools()/setActiveTools()` shape (structurally satisfied by
 * runtime/session-driver.ts's SessionHandle) so this module stays testable
 * with a plain object, no pi runtime required.
 *
 * Why this exists (not redundant with the one-shot `tools` allowlist passed
 * to createAgentSession): that allowlist is applied once, before the first
 * turn. An MCP server that registers a tool after the session has started
 * would then sit inside the session's active tool set forever, silently
 * bypassing the agent type's whitelist (architecture \u00a75.5 / \u00a77.5 TS2). This
 * enforcer re-applies the policy at every turn boundary, using
 * `getActiveTools()` (never a locally cached idea of "what should be
 * active") as the sole source of truth for what actually needs filtering.
 */

/** Tool names this package itself registers; a late-registered tool that
 *  collides with one of these must never be silently trusted (TS1). Only
 *  reflects tools actually deployed by this package's own tools/ modules. */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "StructuredOutput",
  "message_agent",
  // set_model (set-model plan, review m3): the HOST_KEY activate() guard
  // already keeps the host-registered form out of child sessions, so "the
  // host version leaking into a child" is not the threat here — the real
  // targets are MCP/late-registered same-name tools and future registration
  // changes; deny-by-default strips them from any run not granted the name.
  "set_model",
  // extend_subagent_timeout (timeout-notify): same precedent as set_model
  // above — the tool is host-registered only (never injected into child
  // sessions), so deny-by-default strips MCP/late-registered same-name
  // tools from every run.
  "extend_subagent_timeout",
  // consult (consult plan §6 A-4b): injected into a subagent run only when its
  // dispatcher attached a resolved expert whitelist (`Agent({experts})`), and
  // never into a consult run itself. Deny-by-default means an MCP or
  // late-registered same-name tool cannot hand any other run the ability to
  // fork+resume somebody else's session.
  "consult",
  // bash_job (bash-timeout-grace plan §3.10): registered per-session only when
  // bashJobs.childSessions is on AND the child session already carries a real
  // `bash` tool grant (bashJobGrant below) — deny-by-default keeps an
  // MCP/late-registered same-name tool from handing a run job-management
  // powers (extend/kill/wait/status/list) it was never granted.
  "bash_job",
  // list_subagents (todo #19): host-registered only, same treatment as
  // get_subagent_result/steer_subagent above — never pushed to
  // grantedReserved, so deny-by-default strips an MCP/late-registered
  // same-name tool from every child session.
  "list_subagents",
  // switch_context (child-context-switch plan.md §4, known & accepted difference): registered
  // ONLY in child sessions (src/context-switch/child.ts, boundary mode) and granted per-run by
  // runtime-adapter.ts's `childSwitchContextGrant` (every non-consult run, when the feature and
  // the capability state machine both allow it). Unconditional reservation means a same-named
  // MCP/late-registered tool is stripped even when the FEATURE itself is off — accepted, same
  // precedent as bash_job/set_model/consult (T-S11).
  "switch_context",
];

/**
 * consult (plan §4.6/§5.4, frozen surface): the tool domain a consulted expert
 * runs with. Single source for BOTH pi's one-shot `tools` allowlist on the
 * forked session (set after H2 so no extension can widen it) and this
 * module's per-turn enforcer policy — the two must never drift, which is why
 * this constant lives here rather than in src/consult/.
 *
 * `grep`/`find`/`ls` are NOT active by default in pi (an unset `tools` means
 * read/bash/edit/write), so they only exist for a consult run because they
 * are named here.
 */
export const CONSULT_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export interface ToolScopePolicy {
  /** Allow-list (agent type `tools` field, plus any explicitly granted reserved names). `undefined` = no allow-list restriction (only `deny` applies). */
  readonly allow?: ReadonlySet<string>;
  /** Always wins over `allow` (TS1). Reserved names not explicitly granted for this session. */
  readonly deny: ReadonlySet<string>;
  /**
   * P0-r (todo #22 optimize-plan \u00a77.0 point 6b): expected tool-implementation
   * source (`ToolInfo.sourceInfo.source`, e.g. "builtin"/"sdk") for names that
   * must not be silently shadowed by a same-named custom/extension tool \u2014
   * `_refreshToolRegistry`'s allowlist only filters by NAME, so a same-named
   * custom tool still overrides a builtin one. Only ever set for the readonly
   * tool domain (consult / `toolDomain:"readonly"`); every other policy
   * leaves this `undefined` and the enforcer's source check is a complete
   * no-op (byte-identical to pre-P0-r behavior, \u00a77.0.0 defense-in-depth only).
   */
  readonly provenance?: ReadonlyMap<string, string>;
}
export interface ScopeDecision {
  /** The tool names actually left active after this recompute, sorted. */
  readonly applied: readonly string[];
  /** Names present in `getActiveTools()` this call that got filtered out (deny hit, or not in an explicit allow-list). Never silently dropped (TS4). */
  readonly blockedNewcomers: readonly string[];
  /**
   * P0-r (\u00a77.0 point 6b): names from `policy.provenance` that survived the
   * allow/deny filter above but were stripped anyway because their actual
   * tool-implementation source did not match the expected one (missing
   * `getToolSources`, a thrown read, a missing map entry, or a mismatched
   * value all fail closed \u2014 the name is stripped). Always present (empty for
   * every policy without `provenance`); never silently dropped, same TS4
   * discipline as `blockedNewcomers`.
   */
  readonly rejectedShadowed: readonly string[];
  /** Whether `setActiveTools` was actually called (it is skipped when the computed set is unchanged \u2014 avoids per-turn churn/log noise). */
  readonly changed: boolean;
}
export interface ScopeSessionHandle {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  /**
   * P0-r (\u00a77.0 point 6b): optional source lookup for the tools currently in
   * `getActiveTools()`. Absent, throwing, or missing an entry for a name
   * that `policy.provenance` cares about is treated as "unknown source" \u2014
   * fail-closed, the name is stripped (`rejectedShadowed`). A handle that
   * never needs provenance verification (every non-readonly-domain run) can
   * simply omit this method; nothing calls it unless `policy.provenance` is
   * set.
   */
  getToolSources?(): ReadonlyMap<string, string>;
}
/**
 * P0-r (\u00a77.0 point 6b): one provenance mismatch the enforcer stripped at a
 * given checkpoint, handed to `onShadowed` for WARN-level logging (the
 * caller supplies the run id and exact log format \u2014 this module stays
 * side-effect-free otherwise).
 */
export interface ShadowedToolReport {
  readonly name: string;
  /** `undefined` when the handle has no `getToolSources`, throws, or the map is missing this name. */
  readonly actual: string | undefined;
  readonly expected: string;
}
export interface ToolScopeEnforcer {
  /** First application, right after bind() succeeds and before prompt() dispatch. */
  onBind(h: ScopeSessionHandle, policy: ToolScopePolicy): ScopeDecision;
  /**
   * Re-application at `turn_end` (TS2/TS3, unconditional) and, additively for
   * P0-r, at `turn_start` \u2014 but ONLY when `policy.provenance` is set (runner.ts
   * gates the call; every other policy never reaches `turn_start` here,
   * preserving "only at bind/turn_end" byte-for-byte for every pre-P0-r run).
   */
  onTurnBoundary(h: ScopeSessionHandle, policy: ToolScopePolicy): ScopeDecision;
}

/**
 * Build a policy from an agent type's `tools` field plus any tool names this
 * run deliberately grants beyond the base allow-list (the injected nested
 * Agent tool for X3, the injected StructuredOutput tool for X10). Granted
 * reserved names are excluded from `deny` \u2014 this is the "except X3
 * explicitly enabled" carve-out in TS1, expressed structurally rather than
 * by letting `allow` override `deny` at decision time.
 */
export function buildToolScopePolicy(opts: {
  tools?: readonly string[];
  granted?: readonly string[];
  /** P0-r (\u00a77.0 point 6b): attached to the returned policy verbatim (see ToolScopePolicy.provenance). */
  provenance?: ReadonlyMap<string, string>;
}): ToolScopePolicy {
  const grantedSet = new Set(opts.granted ?? []);
  const deny = new Set(RESERVED_TOOL_NAMES.filter((n) => !grantedSet.has(n)));
  return {
    ...(opts.tools ? { allow: new Set([...opts.tools, ...grantedSet]) } : {}),
    deny,
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  };
}

/**
 * bash-timeout-grace plan §3.10 (P0b, frozen): pure decision — should this
 * child session's `bash_job` reserved name be added to `grantedReserved` (the
 * same E24 pattern set_model/Agent/StructuredOutput/consult already use,
 * merged by the caller into `sessionSpec.tools` and this policy's `allow`)?
 *
 *   bashJobGrant({ typeTools, childBashJobs, consult })
 *     = childBashJobs && !consult && (typeTools === undefined || typeTools.includes("bash"))
 *
 * `typeTools` mirrors `buildToolScopePolicy`'s own `opts.tools` semantics:
 * `undefined` = the agent type declares no allow-list restriction (every
 * built-in tool, including `bash`, is available) — granted. An explicit list
 * gates on it actually containing `bash` (a type that never has `bash` has
 * nothing for `bash_job` to manage). `childBashJobs` is the session-level
 * `bashJobs.childSessions` setting gate (false ⇒ the whole feature is off for
 * this session, never granted, never registered). `consult` is true for a
 * consult run (forkSessionFrom-based, CONSULT_READONLY_TOOLS domain) — never
 * granted regardless of type/tools, matching the plan's "两层都不含" rule (the
 * read-only domain's `tools` list also never contains "bash"/"bash_job", so
 * this check is defense-in-depth, not the only gate). Wiring the actual
 * `bash_job` tool registration + settings read is `src/bash/child.ts` (a
 * later package), not this pure function.
 */
export interface BashJobGrantInput {
  /** Agent type's declared `tools` allow-list; `undefined` = no restriction (buildToolScopePolicy's own `opts.tools` semantics). */
  typeTools?: readonly string[];
  /** `bashJobs.childSessions` setting gate — false disables the feature outright for this session. */
  childBashJobs: boolean;
  /**
   * True for the readonly tool domain (a consult run, or a plain run with
   * `SpawnRequest.toolDomain:"readonly"` such as `/mem tidy` — P0-r §7.0
   * point 1) — never granted regardless of type/tools. Field name kept as
   * `consult` for callers already passing `isConsultRun`; the caller now
   * passes `readonlyDomain` instead (runtime-adapter.ts).
   */
  consult: boolean;
}
export function bashJobGrant(input: BashJobGrantInput): boolean {
  return input.childBashJobs && !input.consult && (input.typeTools === undefined || input.typeTools.includes("bash"));
}

export function createToolScopeEnforcer(
  deps: {
    onBlocked?: (names: readonly string[]) => void;
    /** H27: setActiveTools throwing must not escape into pi's event emitter;
     * record + WARN and let the next turn boundary retry. */
    onError?: (error: unknown) => void;
    /**
     * P0-r (\u00a77.0 point 6b): fired whenever `policy.provenance` stripped one or
     * more names for a source mismatch \u2014 at EVERY checkpoint the enforcer runs
     * at (bind included, unlike `onBlocked`'s bind-time silence), since a
     * shadowed builtin at bind time is itself the misconfiguration signal, not
     * an expected baseline tool.
     */
    onShadowed?: (entries: readonly ShadowedToolReport[]) => void;
  } = {},
): ToolScopeEnforcer {
  // TS4 refinement: stripping tools that were already active at bind time is
  // *by design* (our own reserved Agent/result/steer tools are active in every
  // child session and get stripped from every run) — warning about those is
  // pure noise. Only tools that appear AFTER bind (late-registered MCP/custom
  // tools — the actual security event) are reported, once per name per run.
  let baseline: ReadonlySet<string> | undefined;
  const warned = new Set<string>();
  const recompute = (h: ScopeSessionHandle, policy: ToolScopePolicy, report: boolean): ScopeDecision => {
    const current = h.getActiveTools(); // TS2: sole source of truth, never a locally cached idea of "what should be active"
    const isBlocked = (n: string) => policy.deny.has(n) || (policy.allow !== undefined && !policy.allow.has(n));
    const blockedNewcomers = [...new Set(current.filter(isBlocked))].sort();
    let allowedNames = current.filter((n) => !isBlocked(n));
    // P0-r (\u00a77.0 point 6b): source verification, fail-closed. Only names the
    // policy actually cares about (policy.provenance) and that survived the
    // allow/deny filter above are checked; every other policy (provenance
    // undefined) skips this block entirely \u2014 byte-identical to pre-P0-r.
    const rejectedShadowed: string[] = [];
    if (policy.provenance) {
      let sources: ReadonlyMap<string, string> | undefined;
      try {
        sources = h.getToolSources?.();
      } catch {
        sources = undefined;
      }
      const shadowed: ShadowedToolReport[] = [];
      for (const name of allowedNames) {
        const expected = policy.provenance.get(name);
        if (expected === undefined) continue; // not a name this policy tracks provenance for
        const actual = sources?.get(name);
        if (actual !== expected) {
          rejectedShadowed.push(name);
          shadowed.push({ name, actual, expected });
        }
      }
      if (shadowed.length) {
        allowedNames = allowedNames.filter((n) => !rejectedShadowed.includes(n));
        deps.onShadowed?.(shadowed); // never silent, at every checkpoint (including bind)
      }
    }
    const applied = [...new Set(allowedNames)].sort();
    const currentSorted = [...current].sort();
    // Compare against the *current* live set (not a remembered "last applied"
    // value) so a session that already matches the policy — on the very
    // first bind, or because nothing new registered since the previous turn
    // — never gets a redundant setActiveTools call.
    const changed = applied.length !== currentSorted.length || applied.some((n, i) => n !== currentSorted[i]);
    if (report) {
      // Fail-safe: if onBind never ran (no baseline), every blocked name is
      // treated as a newcomer rather than going unreported.
      const trulyNew = blockedNewcomers.filter((n) => (baseline === undefined || !baseline.has(n)) && !warned.has(n));
      if (trulyNew.length) {
        trulyNew.forEach((n) => warned.add(n));
        deps.onBlocked?.(trulyNew); // TS4: late registrations are never silent
      }
    }
    if (changed) {
      try {
        h.setActiveTools(applied); // TS3: caller guarantees this only runs at bind/turn_start(provenance-only)/turn_end boundaries
      } catch (error) {
        // H27: a throwing setActiveTools (disposed handle, pi internal state)
        // must not propagate into pi's session.subscribe emitter. The next
        // turn boundary recomputes from getActiveTools() and retries.
        deps.onError?.(error);
        return { applied, blockedNewcomers, rejectedShadowed: [...new Set(rejectedShadowed)].sort(), changed: false };
      }
    }
    return { applied, blockedNewcomers, rejectedShadowed: [...new Set(rejectedShadowed)].sort(), changed };
  };
  return {
    onBind: (h, policy) => {
      const decision = recompute(h, policy, false); // bind-time strips are by design, never reported
      baseline = new Set(decision.blockedNewcomers);
      return decision;
    },
    onTurnBoundary: (h, policy) => recompute(h, policy, true),
  };
}
