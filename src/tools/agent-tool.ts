import { Type, type Static } from "@sinclair/typebox";
import { Container, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ErrorInfo, JsonSchema, RunId, RunOutcome, RunSnapshot, SpawnRequest } from "../core/types.js";
import { displayAgentType } from "../core/types.js";
import type { ResolveExpertsResult } from "../consult/index.js";
import { normalizeSchemaInput } from "../core/json-schema.js";
import { formatDuration, formatModelRef, phaseLabel } from "../ui/fleet-panel.js";
import { parseStrictModelRef } from "../config/model-hint.js";
import { formatWidgetCost } from "../ui/fleet-widget.js";
import { toPiToolUsage } from "./usage.js";
import { COLLAPSED_BODY_LINES, CappedBody } from "../ui/capped-body.js";
import { truncateResultText } from "./result-text.js";

/**
 * Narrow port the Agent tool needs from SpawnService (X3: also the shape the
 * *nested* Agent tool injected into a child session is given — it never
 * gets the full SpawnService, only spawn/spawnAndWait, so it structurally
 * cannot call abort()/waitAll() on unrelated runs).
 */
export interface NestedSpawnPort {
  spawn(req: SpawnRequest): Promise<{ runId: RunId; label?: string } | { error: ErrorInfo }>;
  spawnAndWait(req: SpawnRequest): Promise<RunOutcome>;
}

/** Final-result details consumed by renderResult (and history replay). */
export interface AgentToolDetails {
  runId?: string;
  label?: string;
  status?: string;
  turns?: number;
  durationMs?: number;
  background?: boolean;
  structuredResult?: unknown;
  /** Blocking (nested) result: one-line stats summary (model · turns · tools · cost · duration). */
  summary?: string;
  model?: string;
  toolCounts?: Record<string, number>;
  costUsd?: number;
}

/**
 * M-B: live progress lines for a run's tool card (shared by
 * get_subagent_result's wait stream and SubagentWorkflow). Line 1 is a status
 * header (model · phase · turn · elapsed · cost); lines 2..N are the most
 * recent tool calls (✓ done, ✗ failed, ▸ running) with args preview and
 * per-call duration.
 */
export function buildProgressLines(snap: RunSnapshot, now: number, maxTools = 3): string[] {
  const d = snap.diag;
  const header = `⏳ ${[
    // consult §16.5 (acceptance follow-up): the model-fallback shows the
    // reserved id "main", never the internal sentinel type name.
    formatModelRef(d.model) ?? displayAgentType(d.agentType) ?? snap.status,
    phaseLabel(snap.phase, d, now),
    `turn ${d.turns + 1}`,
    formatDuration(Math.max(0, now - d.createdAt)),
    ...(d.usage ? [formatWidgetCost(d.usage.costUsd)] : []),
  ].join(" · ")}`;
  const lines = [header];
  for (const r of (d.toolHistory ?? []).slice(-maxTools)) {
    const mark = r.endedAt === undefined ? "▸" : r.isError ? "✗" : "✓";
    const dur = r.endedAt === undefined ? "running…" : formatDuration(r.endedAt - r.startedAt);
    lines.push(`${mark} ${r.name}${r.argsPreview ? ` ${r.argsPreview}` : ""} (${dur})`);
  }
  // M5: the subagent's own streaming text tail (diag.text accumulates via
  // text_delta) — the "what is it saying right now" line.
  const tail = d.text?.trimEnd().split("\n").filter(Boolean).pop();
  if (tail) {
    const compact = tail.replace(/\s+/g, " ").trim();
    lines.push(`💬 ${compact.length > 76 ? `…${compact.slice(-75)}` : compact}`);
  }
  return lines;
}

/** M-B/M-D: final stats line, e.g. "kimi-k3 · 5 turns · 6 tools (bash×3 read×2 edit) · $0.156 · 1m18s". */
export function formatOutcomeSummary(outcome: RunOutcome): string {
  const d = outcome.diag;
  const parts: string[] = [];
  const model = formatModelRef(d.model);
  if (model) parts.push(model);
  parts.push(`${outcome.turns} turn${outcome.turns === 1 ? "" : "s"}`);
  const counts = Object.entries(d.toolCounts ?? {});
  if (counts.length) {
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const breakdown = counts
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
      .join(" ");
    parts.push(`${total} tool${total === 1 ? "" : "s"} (${breakdown})`);
  }
  if (outcome.usage) parts.push(formatWidgetCost(outcome.usage.costUsd));
  parts.push(formatDuration(outcome.durationMs));
  return parts.join(" · ");
}

/**
 * "Agent" tool — drop-in replacement for @tintinweb/pi-subagents' Agent tool
 * (see package.json description). Parameter surface intentionally mirrors
 * the fields the original plugin's model-facing contract relies on
 * (description / prompt / subagent_type / model) so existing agent .md files
 * and calling conventions keep working; steering and result retrieval are
 * separate tools (steer_subagent / get_subagent_result) rather than crammed
 * into this one, and supports X2 resume by label or run id.
 *
 * Two parameter surfaces (docs/dev/agent-background-only/plan.md):
 *  - {@link AgentToolParams}: the top-level (main-session) tool. It always
 *    runs in the background, so it has no `run_in_background` field. A
 *    model that still sends one (old habit) is not rejected — TypeBox
 *    objects allow additional properties and pi's argument validation keeps
 *    them — the field is simply ignored.
 *  - {@link NestedAgentToolParams}: the nested delegation tool injected into
 *    a child session. A child runs in print mode and its run ends with its
 *    turn, so it cannot wait for a completion notification: it keeps the
 *    blocking default plus the opt-in `run_in_background`.
 */
const leadingFields = {
  description: Type.String({ description: "Short (3-5 word) description of the task, shown while it runs." }),
  prompt: Type.String({ description: "The task for the subagent to perform, described in detail." }),
  subagent_type: Type.String({
    description:
      "The type of specialized subagent to use, matching a registered agent type name. " +
      "Registered types are listed in the system prompt under 'Available subagent types' — pass one of those exact names; an unknown name is rejected with a config error.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Optional model override: the FULL 'provider/id' exactly as listed in the 'Available models' section of " +
        "the system prompt — the provider prefix is mandatory. A bare model id or substring alias ('kimi-k3', " +
        "'sonnet') is a fallback only and may be rejected. Defaults to the agent type's configured model " +
        "(frontmatter 'model').",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Optional thinking-level override for this run ('off' | 'low' | 'medium' | 'high'). Defaults to the agent type's configured level (frontmatter 'thinking'), or the global defaultThinkingLevel when the type defines none.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Agent label or run_id of a terminal subagent session (completed, failed, timed_out or aborted) with an existing persisted session to continue.",
    }),
  ),
  isolation: Type.Optional(
    Type.Literal("worktree", {
      description:
        "Run in an isolated git worktree created from the current HEAD (uncommitted changes in the main checkout are NOT visible). " +
        "Use for risky edits or when running parallel agents on the same repo. " +
        "On completion all changes are committed to a new pi-agent-<runId> branch in the main repo and the worktree is deleted; " +
        "if those changes cannot be committed the worktree is PRESERVED on disk instead (a warning names its path) so uncommitted work is never lost. " +
        "Merge or cherry-pick that branch to keep the results. " +
        "Fails with a config error (no fallback) if worktree.enabled is off or the cwd is not a git repository.",
    }),
  ),
  timeout_s: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Optional total wall-clock budget for this run in seconds (overrides the default 30min). " +
        "An explicit timeout is a hard cap: the run always settles within it — no grace window, no extension. " +
        "Omit it to use the default budget, which gets a grace window at expiry and can be extended with extend_subagent_timeout.",
    }),
  ),
};
const trailingFields = {
  schema: Type.Optional(
    Type.Unknown({
      description:
        "Optional JSON Schema object. When set, the subagent must submit its final result through an injected " +
        "StructuredOutput tool matching this schema; the host independently re-validates the submitted payload " +
        "before the run is considered completed (validated twice — by the injected tool at submission and independently by the host before completion). If the run ends " +
        "without a schema-valid submission it is reported as failed, not completed with free text.",
    }),
  ),
  experts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional whitelist of subagent runs (labels or run_ids) this subagent may consult in-turn via the " +
        'consult tool — e.g. an upstream agent whose decisions it needs. The reserved id "main" always names ' +
        "the HOST main session (this one, or the one that ultimately dispatched this chain), never a real run, " +
        "and takes priority over any run/label that happens to share the name — include it to let the " +
        "subagent ask the main session directly. Entries are resolved at dispatch " +
        "time: unresolvable or ambiguous entries fail the dispatch (use the run_id to disambiguate); " +
        "still-running entries are accepted with a warning and become consultable once they finish. " +
        "The consulted copy is read-only and runs in the consulting agent's checkout. " +
        "Use it when the subagent needs what an upstream agent (or the main session) holds but cannot be read " +
        "from code (decisions, rejected alternatives, user preferences). The subagent's consult tool already " +
        "lists each expert's label, type, state and original task; add to the task prompt only what that " +
        "summary does not convey, and still put file locations and key conclusions in the prompt itself.",
    }),
  ),
};

/** Top-level (main-session) Agent tool parameters — always background, no `run_in_background`. */
export const AgentToolParams = Type.Object({ ...leadingFields, ...trailingFields });
export type AgentToolParams = Static<typeof AgentToolParams>;

/** Nested delegation Agent tool parameters — blocking by default, opt-in `run_in_background`. */
export const NestedAgentToolParams = Type.Object({
  ...leadingFields,
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "If true, returns immediately with a run id instead of waiting for completion. Retrieve the result later with get_subagent_result.",
    }),
  ),
  ...trailingFields,
});
export type NestedAgentToolParams = Static<typeof NestedAgentToolParams>;

function parseModel(model?: string): { provider: string; id: string } | undefined {
  return model ? parseStrictModelRef(model) : undefined;
}

function labelMarker(label: string, runId: string, status: string): string {
  return `[subagent label: "${label}" · run_id: ${runId} · status: ${status}] — 用户可 @${label} 直接向它发消息`;
}

/** Dependencies shared by both Agent tool flavours. */
interface AgentToolCommonDeps {
  resultMaxChars?: () => number;
  /**
   * Resolves the host's MarkdownTheme for rendering the result body with the
   * Markdown component. Optional and lazy: hosts without an initialized theme
   * subsystem (headless runs, tests) return undefined and get the legacy
   * plain-text card instead.
   */
  markdownTheme?: () => MarkdownTheme | undefined;
  /**
   * consult (consult plan §4.2): dispatch-time expert-whitelist resolver.
   * Wired for BOTH the top-level Agent tool (src/index.ts holder) and the
   * nested one injected by runtime-adapter — any Agent caller that can pass
   * `experts` must be able to resolve them; an unresolvable/ambiguous entry
   * throws here so the dispatcher gets immediate feedback. Absent +
   * `experts` passed ⇒ execute throws (never silently ignored, review-2 #11③).
   */
  resolveExperts?: (refs: readonly string[]) => ResolveExpertsResult;
}

/**
 * Top-level (main-session) Agent tool: every call spawns in the background
 * and returns a run_id immediately — the host is notified on completion.
 * Only `spawn` is ever reached (never spawnAndWait).
 */
export interface TopLevelAgentToolDeps extends AgentToolCommonDeps {
  spawn: Pick<NestedSpawnPort, "spawn">;
  allowedTypes?: undefined;
}

/**
 * X3: the *nested* delegation tool injected into a child session
 * (service/runtime-adapter.ts, gated by the parent agent type's `canSpawn`).
 */
export interface NestedAgentToolDeps extends AgentToolCommonDeps {
  spawn: NestedSpawnPort;
  parentRunId?: string;
  /**
   * `subagent_type` is rejected outright (never silently clamped) when it is
   * not in this list — the spawn-service-level check (spawn-service.ts)
   * re-validates the same whitelist plus the nesting-depth cap
   * independently, so this check is defense-in-depth, not the sole
   * enforcement point.
   */
  allowedTypes: readonly string[];
  /** X3: nested runs are always slotless (do not consume the concurrency pool) — forced here so a nested delegation tool can never be constructed without it. */
  forceSlotless?: boolean;
}

type AnyAgentToolDeps = TopLevelAgentToolDeps | NestedAgentToolDeps;

const DESCRIPTION_HEAD =
  "Launch an autonomous subagent to handle a complex, multi-step task. The subagent runs in its own bounded session " +
  "and cannot hang indefinitely: every run has a total wall-clock budget and always reaches a terminal state " +
  "(completed/failed/timed_out/aborted). ";
const DESCRIPTION_TAIL =
  "Set resume to the Agent label or run_id of a terminal run to continue its persisted session. " +
  "Set schema to require a structured (schema-validated) result instead of free text. The effective label is reported in the tool result and should be used for @mentions.";

const TOP_LEVEL_DESCRIPTION =
  DESCRIPTION_HEAD +
  "Agent always runs in the background: the call returns immediately with a run_id, and a completion " +
  "notification is pushed to you when the run reaches a terminal state. Do not poll or block waiting for it — " +
  "continue other work or end your turn, then collect the result with get_subagent_result after the " +
  "notification arrives (a blocking get_subagent_result wait monopolizes the agent loop, so the user cannot " +
  "enter a new command until it returns). Independent tasks can be dispatched in parallel: issue several " +
  "Agent calls in the same message. Use steer_subagent to send a follow-up instruction to a still-running one; " +
  "abort_subagent stops a running subagent. " +
  DESCRIPTION_TAIL;

function nestedDescription(allowedTypes: readonly string[]): string {
  return (
    DESCRIPTION_HEAD +
    "By default the call blocks until the subagent finishes and returns its result directly. " +
    "With run_in_background: true it returns a run_id immediately instead; a background run pushes a completion " +
    "notification to you when it reaches a terminal state: prefer continuing other work (or ending your turn) " +
    "and collecting the result with get_subagent_result after that notification arrives, rather than blocking " +
    "with wait: true — a blocking wait monopolizes the agent loop, so the user cannot enter a new command until " +
    "it returns. Use steer_subagent to send a follow-up instruction to a still-running one. abort_subagent stops " +
    "a running subagent. " +
    DESCRIPTION_TAIL +
    ` This is a nested delegation tool: subagent_type is restricted to [${allowedTypes.join(", ")}], every spawned run is slotless (does not consume the concurrency pool), and nesting depth is capped by the host (further attempts beyond the cap are rejected, not silently allowed).`
  );
}

/**
 * Validate the call and build the spawn request shared by every path
 * (background and nested-blocking alike). Throws on any dispatcher-side
 * config error before anything is admitted.
 */
function prepareSpawn(
  deps: AnyAgentToolDeps,
  params: AgentToolParams,
): { baseRequest: SpawnRequest; expertEcho: Array<{ type: "text"; text: string }> } {
  if (deps.allowedTypes !== undefined && !deps.allowedTypes.includes(params.subagent_type)) {
    throw new Error(
      `nested delegation is not permitted: this agent may only spawn [${deps.allowedTypes.join(", ")}], not "${params.subagent_type}"`,
    );
  }
  // Normalize before anything is admitted: a string/non-object schema would
  // otherwise crash pi's typebox at session construction with an opaque
  // "Object.defineProperty called on non-object" (see normalizeSchemaInput).
  let schema: JsonSchema | undefined;
  if (params.schema !== undefined) {
    const normalized = normalizeSchemaInput(params.schema);
    if (!normalized.ok) throw new Error(normalized.error);
    schema = normalized.schema;
  }
  const modelOverride = parseModel(params.model);
  // consult §4.2: `experts` must be resolvable in THIS context — an
  // unresolvable/ambiguous entry is a dispatcher config error and throws
  // here (fail-fast at dispatch, never silently ignored).
  if (params.experts?.length && !deps.resolveExperts)
    throw new Error(
      "experts is not supported in this context (no consult whitelist resolver is wired); drop the experts parameter",
    );
  const experts = params.experts?.length ? deps.resolveExperts!(params.experts) : undefined;
  // consult §4.3: the resolved refs ride on the spawn request (trusted,
  // already resolved — the runtime adapter injects the consult tool off
  // them). Every spawn path spreads baseRequest, so background and nested
  // blocking runs both carry them.
  const expertEcho = (experts === undefined ? [] : [...experts.lines, ...experts.warnings]).map((line) => ({
    type: "text" as const,
    text: line,
  }));
  const nested = deps.allowedTypes !== undefined ? deps : undefined;
  const baseRequest: SpawnRequest = {
    type: params.subagent_type,
    prompt: params.prompt,
    label: params.description,
    ...(modelOverride ? { modelOverride } : {}),
    // Non-pair values are fuzzy hints ("sonnet", "kimi-k3") — resolved
    // against pi's available models at spawn admission; unresolvable
    // hints come back as a self-correcting config error.
    ...(!modelOverride && params.model ? { modelHintOverride: params.model } : {}),
    ...(params.thinking ? { thinkingOverride: params.thinking } : {}),
    ...(nested?.parentRunId ? { parentRunId: nested.parentRunId } : {}),
    ...(nested?.forceSlotless ? { slotless: true } : {}),
    ...(params.resume ? { resumeFrom: params.resume } : {}),
    ...(typeof params.timeout_s === "number" ? { budgetOverride: { totalMs: params.timeout_s * 1000 } } : {}),
    ...(params.isolation ? { isolation: params.isolation } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(experts !== undefined && experts.refs.length > 0 ? { consultExperts: experts.refs } : {}),
  };
  return { baseRequest, expertEcho };
}

/**
 * Background spawn: returns the run_id immediately. detachSignalOnStart:
 * background runs are fire-and-forget — the external turn signal only gates
 * admission; once started, aborting this host turn (Esc / compact_context /
 * compact-hint) must not cancel the run. The run's own layered deadlines
 * still guarantee it settles, and its outcome reaches the host through the
 * notification outbox.
 */
async function spawnInBackground(
  spawnPort: Pick<NestedSpawnPort, "spawn">,
  params: AgentToolParams,
  prepared: ReturnType<typeof prepareSpawn>,
  signal: AbortSignal | undefined,
) {
  const spawned = await spawnPort.spawn({
    ...prepared.baseRequest,
    detachSignalOnStart: true,
    ...(signal ? { signal } : {}),
  });
  if ("error" in spawned) throw new Error(spawned.error.message);
  const effectiveLabel = spawned.label ?? params.description;
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagent "${effectiveLabel}" started in background (run_id: ${spawned.runId}). You will receive a completion notification when it finishes — do not block or poll for it now; collect the result with get_subagent_result(run_id: "${spawned.runId}") after the notification arrives.`,
      },
      { type: "text" as const, text: labelMarker(effectiveLabel, spawned.runId, "running") },
      ...prepared.expertEcho,
    ],
    details: { runId: spawned.runId, label: effectiveLabel, background: true } satisfies AgentToolDetails,
  };
}

/** Nested-only blocking path: spawnAndWait keeps full-turn signal linkage (Esc stops the child run). */
async function spawnAndCollect(
  deps: NestedAgentToolDeps,
  params: NestedAgentToolParams,
  prepared: ReturnType<typeof prepareSpawn>,
  signal: AbortSignal | undefined,
) {
  const outcome: RunOutcome = await deps.spawn.spawnAndWait({
    ...prepared.baseRequest,
    ...(signal ? { signal } : {}),
  });
  if (outcome.status !== "completed") {
    const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
    const tail = outcome.text?.trim();
    const excerpt = tail ? (tail.length > 500 ? `…${tail.slice(-500)}` : tail) : undefined;
    const effectiveLabel = outcome.diag.label ?? params.description;
    const parts = [
      `Subagent "${effectiveLabel}" (run_id: ${outcome.runId}, label: "${effectiveLabel}") did not complete successfully: ${reason}.`,
    ];
    if (outcome.diag.sessionFile) {
      parts.push(`A persisted session may be resumable — retry with resume: "${outcome.runId}".`);
    } else {
      parts.push("The run failed before a session was created; there is nothing to resume.");
    }
    if (excerpt) parts.push(`Partial output (tail): ${excerpt}`);
    throw new Error(parts.join(" "));
  }
  const effectiveLabel = outcome.diag.label ?? params.description;
  const resultText =
    outcome.structuredResult !== undefined
      ? JSON.stringify(outcome.structuredResult)
      : truncateResultText(
          outcome.text ?? "(subagent completed with no text output)",
          deps.resultMaxChars?.() ?? 0,
          outcome.diag.sessionFile,
        ).text;
  return {
    content: [
      { type: "text" as const, text: resultText },
      { type: "text" as const, text: labelMarker(effectiveLabel, outcome.runId, outcome.status) },
      ...prepared.expertEcho,
    ],
    // pi usage accounting: the child session's spend rides on this tool
    // result so pi's own totals (footer, /session, RPC) include it.
    ...(outcome.usage ? { usage: toPiToolUsage(outcome.usage) } : {}),
    details: {
      runId: outcome.runId,
      label: effectiveLabel,
      status: outcome.status,
      turns: outcome.turns,
      durationMs: outcome.durationMs,
      // M-B/M-D: presentation stats (renderResult summary line + history replay).
      summary: formatOutcomeSummary(outcome),
      ...(outcome.diag.model ? { model: formatModelRef(outcome.diag.model)! } : {}),
      ...(outcome.diag.toolCounts ? { toolCounts: outcome.diag.toolCounts } : {}),
      ...(outcome.usage ? { costUsd: outcome.usage.costUsd } : {}),
      ...(outcome.structuredResult !== undefined ? { structuredResult: outcome.structuredResult } : {}),
    } satisfies AgentToolDetails,
  };
}

/**
 * Without a renderCall the TUI falls back to the bare tool name while a run
 * executes — an Agent card with zero context about *what* is running. Show
 * the label + type (and background/resume markers) like the built-in tools
 * show their key argument (e.g. bash renders `$ <command>`). The top-level
 * tool is always background, so the marker is only meaningful (and only
 * rendered) for the nested tool's opt-in `run_in_background`.
 */
function renderAgentCall(
  args: Partial<NestedAgentToolParams> | undefined,
  theme: { fg(color: "toolTitle" | "muted", text: string): string; bold(text: string): string },
  lastComponent: unknown,
): Text {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const title = theme.fg("toolTitle", theme.bold(`Agent: ${args?.description ?? "…"}`));
  const meta = [
    args?.subagent_type ? `type: ${args.subagent_type}` : undefined,
    args?.model ? `model: ${args.model}` : undefined,
    args?.thinking ? `thinking: ${args.thinking}` : undefined,
    args?.run_in_background ? "background" : undefined,
    args?.resume ? `resume: ${args.resume}` : undefined,
    args?.isolation ? `isolation: ${args.isolation}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
  return text;
}

/**
 * M-B: renders the final result: a muted stats summary line (blocking nested
 * results only), then the result text (collapsed to a handful of lines
 * unless the entry is expanded).
 */
function renderAgentResult(
  deps: AgentToolCommonDeps,
  result: { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean },
  theme: { fg(color: "muted", text: string): string },
  lastComponent: unknown,
) {
  const details = (result.details ?? {}) as AgentToolDetails;
  const body = result.content
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const summaryLine = details.summary ? theme.fg("muted", `✓ ${details.summary}`) : undefined;
  // Rich path: render the body as Markdown when the host provides a theme.
  // Fresh components per call are safe here — pi's ToolExecutionComponent
  // re-invokes renderResult on every setExpanded()/updateDisplay().
  const mdTheme = deps.markdownTheme?.();
  if (mdTheme !== undefined && (summaryLine !== undefined || body)) {
    const container = new Container();
    if (summaryLine !== undefined) container.addChild(new Text(summaryLine, 0, 0));
    if (body) {
      // padding 0/0: the tool card's outer Box already supplies padding.
      const markdown = new Markdown(body, 0, 0, mdTheme);
      container.addChild(
        options.expanded
          ? markdown
          : new CappedBody(markdown, COLLAPSED_BODY_LINES, (hidden) => theme.fg("muted", `… +${hidden} more lines`)),
      );
    }
    return container;
  }
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const parts: string[] = [];
  if (summaryLine !== undefined) parts.push(summaryLine);
  if (body) {
    const lines = body.split("\n");
    const cap = COLLAPSED_BODY_LINES;
    if (!options.expanded && lines.length > cap) {
      parts.push(lines.slice(0, cap).join("\n"));
      parts.push(theme.fg("muted", `… +${lines.length - cap} more lines`));
    } else {
      parts.push(body);
    }
  }
  text.setText(parts.join("\n"));
  return text;
}

function createTopLevelAgentTool(deps: TopLevelAgentToolDeps): ToolDefinition<typeof AgentToolParams> {
  return {
    name: "Agent",
    label: "Agent",
    description: TOP_LEVEL_DESCRIPTION,
    promptSnippet:
      "Agent(description, prompt, subagent_type, model?, thinking?, resume?, schema?) - spawn or resume a bounded subagent in the background (returns a run_id; completion is notified)",
    parameters: AgentToolParams,
    renderCall(args, theme, context) {
      // Always background: never render the (ignored) legacy run_in_background marker.
      const { run_in_background: _ignored, ...shown } = (args ?? {}) as Partial<NestedAgentToolParams>;
      return renderAgentCall(shown, theme, context.lastComponent);
    },
    async execute(_toolCallId, params, signal) {
      // Every call is a background spawn — a legacy `run_in_background`
      // field (even `false`) is accepted by validation and ignored here.
      return spawnInBackground(deps.spawn, params, prepareSpawn(deps, params), signal);
    },
    renderResult(result, options, theme, context) {
      return renderAgentResult(deps, result, options, theme, context.lastComponent);
    },
  } satisfies ToolDefinition<typeof AgentToolParams>;
}

function createNestedAgentTool(deps: NestedAgentToolDeps): ToolDefinition<typeof NestedAgentToolParams> {
  return {
    name: "Agent",
    label: "Agent",
    description: nestedDescription(deps.allowedTypes),
    promptSnippet:
      "Agent(description, prompt, subagent_type, model?, thinking?, resume?, schema?, run_in_background?) - spawn or resume a bounded subagent",
    parameters: NestedAgentToolParams,
    renderCall(args, theme, context) {
      return renderAgentCall(args, theme, context.lastComponent);
    },
    async execute(_toolCallId, params, signal) {
      const prepared = prepareSpawn(deps, params);
      if (params.run_in_background) return spawnInBackground(deps.spawn, params, prepared, signal);
      return spawnAndCollect(deps, params, prepared, signal);
    },
    renderResult(result, options, theme, context) {
      return renderAgentResult(deps, result, options, theme, context.lastComponent);
    },
  } satisfies ToolDefinition<typeof NestedAgentToolParams>;
}

/**
 * Agent tool factory. Without `allowedTypes` it builds the top-level
 * (main-session) tool, which always runs in the background; with
 * `allowedTypes` it builds the X3 nested delegation tool injected into a
 * child session, which keeps the blocking default and the opt-in
 * `run_in_background` (a print-mode child cannot wait for notifications).
 */
export function createAgentTool(deps: NestedAgentToolDeps): ToolDefinition<typeof NestedAgentToolParams>;
export function createAgentTool(deps: TopLevelAgentToolDeps): ToolDefinition<typeof AgentToolParams>;
export function createAgentTool(
  deps: AnyAgentToolDeps,
): ToolDefinition<typeof NestedAgentToolParams> | ToolDefinition<typeof AgentToolParams> {
  return deps.allowedTypes !== undefined ? createNestedAgentTool(deps) : createTopLevelAgentTool(deps);
}
export type { ExtensionContext };
