import { Type, type Static } from "@sinclair/typebox";
import { Container, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import { deliveryKey, type Notifier } from "../delivery/notifier.js";
import type { RunOutcome } from "../core/types.js";
import { formatDuration } from "../ui/fleet-panel.js";
import { buildProgressLines, formatOutcomeSummary } from "./agent-tool.js";
import {
  createPollGuard,
  createTimeoutStreak,
  type PollGuardOptions,
  type TimeoutStreakOptions,
  type TimeoutStreakResult,
} from "./poll-guard.js";
import { toPiToolUsage } from "./usage.js";
import { COLLAPSED_BODY_LINES, CappedBody } from "../ui/capped-body.js";
import { formatExitFacts, truncateResultText } from "./result-text.js";
import type { RunExitFacts } from "../core/types.js";
import { resolveToolTarget, type WorkflowQueryPort } from "./workflow-target.js";
import {
  buildWorkflowProgressLines,
  formatWorkflowResultText,
  formatWorkflowSummary,
  liveChildRunIds,
  sumUsage,
} from "./workflow-tool.js";
import type { BackgroundWorkflowView } from "../workflow/background.js";
import type { WorkflowOutcome } from "../workflow/types.js";
import type { UsageDelta } from "../core/types.js";

/**
 * "get_subagent_result" — drop-in replacement for @tintinweb/pi-subagents'
 * result-retrieval tool. `wait` is bounded by `wait_ms` (architecture G1/G2:
 * QueryService.wait() never blocks unboundedly, see service/query-service.ts)
 * — this closes the original plugin's P2 defect (unbounded wait:true).
 *
 * Reads never consume the run, so re-checking is side-effect free — but
 * polling in a tight loop trips the frequency guard (tools/poll-guard.ts,
 * shared with bash_job): a warning is prepended telling the model to stop
 * and await the completion notification. The wait path is guarded by a
 * consecutive-timeout streak instead (frequency is meaningless when each
 * call blocks by design): repeated timeouts on the same run escalate the
 * error message toward the two ways out — raise wait_ms, or end the turn
 * and let the notification arrive.
 */
export const ResultToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id returned by the Agent tool; also accepts a unique run_id prefix or the Agent call's label (its description). " +
      "A SubagentWorkflow id (wf_…, or a unique prefix / the workflow's script name) reads that background workflow instead.",
  }),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "If true, block until the run (or workflow) reaches a terminal state (bounded by wait_ms). Default false — and keep it " +
        "false in almost all cases: a blocking wait occupies the agent loop for its whole duration, so the user " +
        "cannot type a new message or command until it returns. Rely on the run's completion notification and " +
        "call this tool without wait once it arrives; use wait only as a fallback when an expected notification " +
        "never arrived and there is genuinely nothing else to do.",
    }),
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description: "Maximum time to wait in milliseconds when wait is true. Defaults to 300000 (5 minutes).",
    }),
  ),
});
export type ResultToolParams = Static<typeof ResultToolParams>;

export type { PollGuardOptions } from "./poll-guard.js";

/** Default blocking-wait budget for get_subagent_result when wait:true and no explicit wait_ms (5 minutes). */
export const DEFAULT_WAIT_MS = 300_000;

/** Partial-update / final-result details consumed by renderResult (mirrors AgentToolDetails in agent-tool.ts). */
export interface ResultToolDetails {
  runId?: string;
  /** Set when the target was a background SubagentWorkflow. */
  workflowId?: string;
  /** Workflow reads: the live child runs whose spend this result accounts for (HUD dedupe). */
  runIds?: string[];
  costUsd?: number;
  label?: string;
  status?: string;
  durationMs?: number;
  /** Partial (isPartial) updates from the wait path: preformatted live progress lines. */
  progress?: string[];
  /** Final result: one-line stats summary (model · turns · tools · cost · duration). */
  summary?: string;
  structuredResult?: unknown;
  truncated?: true;
  totalChars?: number;
}

export function createResultTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
  notifier?: Pick<Notifier, "ack">;
  pollGuard?: PollGuardOptions;
  timeoutStreak?: TimeoutStreakOptions;
  resultMaxChars?: () => number;
  /**
   * Resolves the host's MarkdownTheme for rendering the result body with the
   * Markdown component. Optional and lazy: hosts without an initialized theme
   * subsystem (headless runs, tests) return undefined and get the legacy
   * plain-text card instead.
   */
  markdownTheme?: () => MarkdownTheme | undefined;
  /** Background SubagentWorkflow reads (absent: workflow ids are not accepted). */
  workflows?: WorkflowQueryPort;
}): ToolDefinition<typeof ResultToolParams> {
  const pollGuard = createPollGuard(deps.pollGuard);
  const waitStreak = createTimeoutStreak(deps.timeoutStreak);
  // pi usage accounting dedupe: a background run's spend is attached to the
  // FIRST tool result that reports its terminal outcome — get_subagent_result
  // can be called repeatedly for the same run, and re-attaching usage each
  // time would double-count the cost in pi's session totals.
  const usageReported = new Set<string>();
  const usageOnce = (runId: string, usage?: Parameters<typeof toPiToolUsage>[0]) => {
    if (!usage || usageReported.has(runId)) return {};
    usageReported.add(runId);
    return { usage: toPiToolUsage(usage) };
  };
  const tryAck = (runId: string, generation: number, outcome: RunOutcome) => {
    if (!deps.notifier) return;
    try {
      deps.notifier.ack(runId, generation, {
        extensionOwner: "get_subagent_result",
      });
    } catch {
      // Defensive boundary for future notifier implementations.
    }
  };
  /**
   * Workflow spend accounting, same "first terminal read attaches it" rule as
   * runs, with ONE dedupe set shared with the run path: each live child run is
   * reported at most once, whether it is read individually (get_subagent_result
   * on the child run_id) or through its workflow. After /reload the child runs
   * are gone from the query service; the aggregate captured at settle time
   * (view.usage) is used then — only when none of its children was reported.
   */
  const workflowUsageOnce = (view: BackgroundWorkflowView, outcome: WorkflowOutcome) => {
    const runIds = liveChildRunIds(outcome);
    if (usageReported.has(view.workflowId)) return { runIds, total: undefined as UsageDelta | undefined };
    usageReported.add(view.workflowId);
    const unreported = runIds.filter((id) => !usageReported.has(id));
    const live = deps.workflows?.usageOf ? unreported.map((id) => deps.workflows!.usageOf!(id)) : [];
    const resolvedAny = live.some((u) => u !== undefined);
    let total = sumUsage(live);
    if (!resolvedAny && unreported.length === runIds.length && view.usage) total = sumUsage([view.usage]);
    for (const id of runIds) usageReported.add(id);
    return { runIds, total };
  };
  const workflowTerminal = (view: BackgroundWorkflowView, outcome: WorkflowOutcome, maxChars: number) => {
    const { runIds, total } = workflowUsageOnce(view, outcome);
    // Display cost: the whole workflow's spend, whether or not this read is the one that accounts it.
    const displayUsage =
      total ??
      (deps.workflows?.usageOf ? sumUsage(runIds.map((id) => deps.workflows!.usageOf!(id))) : undefined) ??
      view.usage;
    const rendered = formatWorkflowResultText(outcome, displayUsage, maxChars);
    return {
      text: rendered.text,
      ...(total ? { usage: toPiToolUsage(total) } : {}),
      details: {
        workflowId: view.workflowId,
        label: view.name,
        status: outcome.status,
        durationMs: outcome.durationMs,
        summary: formatWorkflowSummary(outcome, displayUsage),
        runIds,
        ...(displayUsage ? { costUsd: displayUsage.costUsd } : {}),
        ...(rendered.truncated ? { truncated: true as const, totalChars: rendered.totalChars } : {}),
      } satisfies ResultToolDetails,
    };
  };
  const workflowProgress = (workflowId: string, now: number): string[] => {
    const activity = deps.workflows?.activity(workflowId);
    return activity ? buildWorkflowProgressLines(activity, now, deps.workflows?.snapshotOf) : [];
  };
  async function executeWorkflow(
    workflowId: string,
    params: ResultToolParams,
    signal: AbortSignal | undefined,
    onUpdate: ((u: { content: { type: "text"; text: string }[]; details: ResultToolDetails }) => void) | undefined,
  ) {
    const workflows = deps.workflows!;
    const maxChars = deps.resultMaxChars?.() ?? 0;
    if (!params.wait) {
      const pollWarning = pollGuard.record(workflowId);
      const withWarning = (text: string) => (pollWarning ? `${pollWarning}\n\n${text}` : text);
      const view = workflows.get(workflowId);
      if (!view) throw new Error(`unknown workflow id: ${params.run_id}`);
      if (view.status === "running" || !view.outcome) {
        const text = [
          `Workflow ${workflowId} ("${view.name}") is still running.`,
          ...workflowProgress(workflowId, Date.now()),
        ].join("\n");
        return {
          content: [{ type: "text" as const, text: withWarning(text) }],
          details: { workflowId, label: view.name, status: "running" } satisfies ResultToolDetails,
        };
      }
      waitStreak.reset(workflowId);
      const terminal = workflowTerminal(view, view.outcome, maxChars);
      return {
        content: [{ type: "text" as const, text: withWarning(terminal.text) }],
        ...(terminal.usage ? { usage: terminal.usage } : {}),
        details: terminal.details,
      };
    }
    const startedAt = Date.now();
    const waitMs = params.wait_ms ?? DEFAULT_WAIT_MS;
    const push = () => {
      if (!onUpdate) return;
      const now = Date.now();
      const lines = [
        `⏳ waiting for ${workflowId} · ${formatDuration(now - startedAt)} / ${formatDuration(waitMs)}`,
        ...workflowProgress(workflowId, now),
      ];
      onUpdate({ content: [{ type: "text", text: lines.join("\n") }], details: { workflowId, progress: lines } });
    };
    const timer = onUpdate ? setInterval(push, 1000) : undefined;
    (timer as { unref?: () => void } | undefined)?.unref?.();
    push();
    let waited;
    try {
      waited = await workflows.wait(workflowId, { waitMs, ...(signal ? { signal } : {}) });
    } finally {
      if (timer) clearInterval(timer);
    }
    if (!waited.ok) {
      if (waited.reason === "wait_timeout") {
        throw new Error(waitTimeoutMessage(workflowId, waitMs, waitStreak.timeout(workflowId, waitMs), "workflow"));
      }
      throw new Error(
        waited.reason === "unknown_workflow" ? `unknown workflow id: ${params.run_id}` : "wait was aborted",
      );
    }
    waitStreak.reset(workflowId);
    const terminal = workflowTerminal(waited.view, waited.view.outcome, maxChars);
    return {
      content: [{ type: "text" as const, text: terminal.text }],
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      details: terminal.details,
    };
  }
  return {
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Check on, or collect the result of, a subagent run started with the Agent tool — or a background " +
      "SubagentWorkflow, by its workflow id (wf_…): progress while it runs, the full outcome plus its children's " +
      "spend once it is terminal. " +
      "Agent runs push a completion notification on terminal state, so the normal flow is: continue other " +
      "work (or end your turn), then call this tool without wait once the notification arrives. Set wait: true " +
      "to block until the run finishes (up to wait_ms) — while it blocks, the user cannot send new input, so " +
      "avoid it whenever anything else could proceed (ending your turn counts); it is a fallback for when an " +
      "expected notification never arrived. Terminal results include the run's wall-clock " +
      "duration (text trailer and details.durationMs), so post-completion reads still expose how long it ran. " +
      "Long result text is capped by resultMaxChars with a session-file path for reading the full transcript. " +
      "Reading a result never consumes the run, so checking is safe — but rapid repeated polling of the " +
      "same run returns a warning; await the completion notification instead. " +
      "A wait that times out tells you how to proceed; repeated timeouts on the same run escalate that " +
      "guidance (raise wait_ms, or stop blocking and await the notification).",
    promptSnippet:
      "get_subagent_result(run_id, wait?, wait_ms?) - check a background subagent's or workflow's status/result",
    parameters: ResultToolParams,
    /**
     * Without a renderCall the TUI shows a bare "get_subagent_result ⠦" while
     * a wait blocks — no hint of *which* run is being awaited or under what
     * budget. Mirror the Agent tool: surface the key arguments on the card.
     */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Get Subagent Result: ${args?.run_id ?? "…"}`));
      const meta = args?.wait
        ? `wait (budget: ${args.wait_ms !== undefined ? formatDuration(args.wait_ms) : "default"})`
        : undefined;
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    /**
     * Renders like the Agent tool's card (M-B), so collecting a result looks
     * the same as the completion notification's stats line:
     *  - partial (wait path, 1 Hz): the live progress lines, tone-mapped per
     *    mark (✗ error / ▸ accent / ✓ muted);
     *  - final: a status-marked summary line (✓ completed / ✗ otherwise,
     *    label + model · turns · tools · cost · duration), then the result
     *    text collapsed to a handful of lines unless the entry is expanded.
     */
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = (result.details ?? {}) as ResultToolDetails;
      const body = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
      if (options.isPartial && details.progress) {
        const rendered = details.progress
          .map((line) => {
            if (line.startsWith("✗")) return theme.fg("error", line);
            if (line.startsWith("▸")) return theme.fg("accent", line);
            if (line.startsWith("✓")) return theme.fg("muted", line);
            return line;
          })
          .join("\n");
        text.setText(rendered);
        return text;
      }
      const summaryLine = details.summary
        ? theme.fg(
            details.status === "completed" ? "muted" : "error",
            `${details.status === "completed" ? "✓" : "✗"} ${details.label ? `"${details.label}" · ` : ""}${details.summary}`,
          )
        : undefined;
      // Rich path: render the body as Markdown when the host provides a theme.
      // Fresh components per call are safe here — pi's ToolExecutionComponent
      // re-invokes renderResult on every setExpanded()/updateDisplay(); only
      // the streaming partial path above relies on context.lastComponent reuse.
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
              : new CappedBody(markdown, COLLAPSED_BODY_LINES, (hidden) =>
                  theme.fg("muted", `… +${hidden} more lines`),
                ),
          );
        }
        return container;
      }
      const parts: string[] = [];
      if (summaryLine !== undefined) {
        parts.push(summaryLine);
      }
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
    },
    // §2.7: the pi harness may invoke execute() with signal === undefined; the
    // wait path below tolerates that (QueryService.wait's opts.signal is optional).
    async execute(_toolCallId, params, signal, onUpdate) {
      const target = resolveToolTarget(params.run_id, deps.resolveRun, deps.workflows);
      if (target.kind === "workflow") {
        return executeWorkflow(target.workflowId, params, signal, onUpdate as never);
      }
      const runId = target.runId;
      if (!params.wait) {
        // The frequency guard covers only this non-blocking read path; the
        // wait path below is guarded by the consecutive-timeout streak.
        const pollWarning = pollGuard.record(runId);
        const withWarning = (text: string) => (pollWarning ? `${pollWarning}\n\n${text}` : text);
        const snapshot = deps.query.get(runId);
        if (!snapshot) throw new Error(`unknown run_id: ${params.run_id}`);
        const maxChars = deps.resultMaxChars?.() ?? 0;
        const text = snapshot.outcome
          ? formatOutcome(snapshot.outcome, maxChars)
          : [
              `Run ${runId} is still ${snapshot.status} (phase: ${snapshot.phase}).`,
              ...buildProgressLines(snapshot, Date.now()),
            ].join("\n");
        if (snapshot.outcome) {
          waitStreak.reset(runId);
          tryAck(runId, snapshot.generation, snapshot.outcome);
        }
        return {
          content: [{ type: "text" as const, text: withWarning(text) }],
          ...(snapshot.outcome ? usageOnce(runId, snapshot.outcome.usage) : {}),
          details: {
            runId,
            status: snapshot.status,
            usage: snapshot.diag.usage,
            ...(snapshot.outcome
              ? {
                  durationMs: snapshot.outcome.durationMs,
                  // Presentation stats for renderResult + history replay (M-D).
                  summary: formatOutcomeSummary(snapshot.outcome),
                  ...(snapshot.diag.label !== undefined ? { label: snapshot.diag.label } : {}),
                }
              : {}),
            ...(snapshot.outcome ? truncationDetails(snapshot.outcome, maxChars) : {}),
            ...(snapshot.outcome?.structuredResult !== undefined
              ? { structuredResult: snapshot.outcome.structuredResult }
              : {}),
          },
        };
      }
      // Live visibility while the (bounded) wait blocks: a 1 Hz partial-
      // update side channel (buildProgressLines, shared with workflow) — header with
      // elapsed/budget plus the awaited run's own progress snapshot. Purely a
      // read-only display concern; the wait semantics are unchanged.
      const startedAt = Date.now();
      const push = () => {
        if (!onUpdate) return;
        const now = Date.now();
        const budget = formatDuration(params.wait_ms ?? DEFAULT_WAIT_MS);
        const snap = deps.query.get(runId);
        const lines = [
          `⏳ waiting for ${runId} · ${formatDuration(now - startedAt)} / ${budget}`,
          ...(snap && !snap.outcome ? buildProgressLines(snap, now) : []),
        ];
        onUpdate({
          content: [{ type: "text", text: lines.join("\n") }],
          details: { runId, progress: lines },
        });
      };
      const timer = onUpdate ? setInterval(push, 1000) : undefined;
      (timer as { unref?: () => void } | undefined)?.unref?.();
      push();
      // try/finally rather than .finally(): a synchronous throw from a
      // non-async QueryService stub would otherwise skip cleanup entirely
      // (the rejection would surface before the .finally chain existed).
      const waitMs = params.wait_ms ?? DEFAULT_WAIT_MS;
      let waited;
      try {
        waited = await deps.query.wait(runId, {
          waitMs,
          ...(signal ? { signal } : {}),
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      if (!waited.ok) {
        if (waited.reason === "wait_timeout") {
          throw new Error(waitTimeoutMessage(runId, waitMs, waitStreak.timeout(runId, waitMs)));
        }
        throw new Error(waited.reason === "unknown_run" ? `unknown run_id: ${params.run_id}` : "wait was aborted");
      }
      waitStreak.reset(runId);
      tryAck(runId, waited.outcome.diag.generation, waited.outcome);
      const maxChars = deps.resultMaxChars?.() ?? 0;
      return {
        content: [{ type: "text" as const, text: formatOutcome(waited.outcome, maxChars) }],
        ...usageOnce(runId, waited.outcome.usage),
        details: {
          runId,
          status: waited.outcome.status,
          durationMs: waited.outcome.durationMs,
          // Presentation stats for renderResult + history replay (M-D).
          summary: formatOutcomeSummary(waited.outcome),
          ...(waited.outcome.diag.label !== undefined ? { label: waited.outcome.diag.label } : {}),
          usage: waited.outcome.usage,
          ...truncationDetails(waited.outcome, maxChars),
          ...(waited.outcome.structuredResult !== undefined
            ? { structuredResult: waited.outcome.structuredResult }
            : {}),
        },
      };
    },
  } satisfies ToolDefinition<typeof ResultToolParams>;
}

/**
 * The wait-timeout error IS the guidance surface (a timeout throws, so there
 * is no tool result to prepend a warning to). The first timeout states the
 * two ways out; consecutive timeouts on the same run escalate with the
 * streak count and the cumulative time already wasted blocking.
 */
function waitTimeoutMessage(
  runId: string,
  waitMs: number,
  streak: TimeoutStreakResult,
  noun: "run" | "workflow" = "run",
): string {
  const base = `wait timed out after ${formatDuration(waitMs)}; ${noun} ${runId} is still going.`;
  const directions =
    "Either retry with a larger wait_ms if blocking is genuinely necessary, or — preferred — end your " +
    `turn (or do other work) and let the ${noun}'s completion notification arrive.`;
  if (!streak.escalate) return `${base} ${directions}`;
  return (
    `${base} That is ${streak.streak} consecutive timeouts on this ${noun} ` +
    `(~${formatDuration(streak.totalWaitedMs)} spent blocked) — re-waiting does not make it finish faster. ` +
    directions
  );
}

function formatOutcome(
  outcome: {
    status: string;
    text?: string;
    structuredResult?: unknown;
    error?: { message: string };
    timeoutReason?: string;
    durationMs: number;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
    diag?: { sessionFile?: string; exitFacts?: RunExitFacts };
  },
  maxChars = 0,
): string {
  // durationMs is a first-class RunOutcome field, so the trailer always
  // carries it — unlike the completion notification (which shows `21s` once
  // and is gone), this makes wall-clock duration retrievable on every
  // post-terminal read of the result.
  const trailer = outcome.usage
    ? `\n\n(duration: ${formatDuration(outcome.durationMs)} · usage: in:${outcome.usage.input} out:${outcome.usage.output} cache_r:${outcome.usage.cacheRead} cache_w:${outcome.usage.cacheWrite} cost:$${outcome.usage.costUsd.toFixed(4)})`
    : `\n\n(duration: ${formatDuration(outcome.durationMs)})`;
  // bash-timeout-grace plan §3.7/T25 (P5): `diag.exitFacts` is threaded here
  // via the `exit_facts` session_event (§3.8, P0b) → `RunOutcome.diag`
  // (state-machine `finish()`) → this outcome — the same value the parent's
  // completion notice renders from `DeliveryPayload.exitFacts` (§3.7 table).
  const exitFactsText = formatExitFacts(outcome.diag?.exitFacts);
  const exitSuffix = exitFactsText !== undefined ? `\n\n${exitFactsText}` : "";
  if (outcome.status === "completed") {
    const body =
      outcome.structuredResult !== undefined
        ? JSON.stringify(outcome.structuredResult)
        : truncateResultText(
            outcome.text ?? "(subagent completed with no text output)",
            maxChars,
            outcome.diag?.sessionFile,
          ).text;
    return body + trailer + exitSuffix;
  }
  const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
  // L1 (agent-tool pool-full plan §3): a queue_timeout outcome carries no
  // outcome.error (only diag/timeoutReason) — render the same
  // self-explanatory text the notification's failReason uses (core's
  // describeTimeout), instead of the bare enum value "queue_timeout", so a
  // read of the terminal result explains itself without cross-referencing
  // the state machine.
  if (outcome.timeoutReason === "queue_timeout" && outcome.error === undefined) {
    return (
      `Subagent run failed: queue timeout — the concurrency pool was full; waited ${formatDuration(outcome.durationMs)} without getting a slot. ` +
      "Wait for a run to finish and dispatch again, or raise concurrencyLimit (/agent settings)." +
      trailer +
      exitSuffix
    );
  }
  return `Subagent run ${outcome.status}: ${reason}${trailer}${exitSuffix}`;
}

function truncationDetails(outcome: RunOutcome, maxChars: number): { truncated?: true; totalChars?: number } {
  if (outcome.status !== "completed" || outcome.structuredResult !== undefined || outcome.text === undefined) return {};
  const result = truncateResultText(outcome.text, maxChars, outcome.diag.sessionFile);
  return result.truncated ? { truncated: true, totalChars: result.totalChars } : {};
}
