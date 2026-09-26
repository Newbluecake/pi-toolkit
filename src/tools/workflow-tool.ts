import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateScriptSize } from "../workflow/orchestrator.js";
import { assertHeartbeatBudgetInvariant } from "../workflow/runaway.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import type { BackgroundWorkflowUsage, BackgroundWorkflowView, BackgroundWorkflows } from "../workflow/background.js";
import type { WorkflowChildSummary, WorkflowOutcome, WorkflowRunBudget } from "../workflow/types.js";
import type { RunSnapshot, UsageDelta } from "../core/types.js";
import { buildProgressLines } from "./agent-tool.js";
import { formatDuration } from "../ui/fleet-panel.js";
import { formatWidgetCost } from "../ui/fleet-widget.js";
import { truncateResultText } from "./result-text.js";

/**
 * The `SubagentWorkflow` tool — the model-facing entry point into the engine
 * in `src/workflow/**`.
 *
 * Background-only (docs/dev/workflow-background/plan.md): `execute` validates
 * the parameters and budget, starts the run in the session's background
 * workflow registry (`src/workflow/background.ts`, which owns the bounded
 * run → stop → settle → degraded-fallback sequence formerly enforced here)
 * and returns the `workflowId` immediately. Completion is pushed to the main
 * session as a notification; `get_subagent_result` / `abort_subagent` accept
 * the workflow id. The run is detached from this call's AbortSignal (an
 * already-aborted signal still rejects before anything starts).
 *
 * Narrow port (mirrors `agent-tool.ts`'s `NestedSpawnPort`): this file has
 * zero imports from `src/stack.ts` / `src/service/**` — `index.ts` is the
 * only place that knows both this tool's shape and `Stack`'s.
 *
 * Main-session only: the tool is registered post-HOST_KEY-guard in
 * `src/index.ts` and is never injected into child sessions, so there is no
 * print-mode (blocking) flavour to keep.
 */
export interface WorkflowToolDeps {
  readonly defaultBudget: WorkflowRunBudget;
  readonly runs: Pick<BackgroundWorkflows, "start">;
}

/** Tool-result details consumed by renderResult (mirrors agent-tool.ts's `AgentToolDetails`). */
export interface WorkflowToolDetails {
  workflowId?: string;
  /** Script `meta.name` — the workflow's display label. */
  label?: string;
  status?: string;
  background?: true;
  durationMs?: number;
  /** Legacy (pre-background) sessions: partial live progress lines. Kept so old history still renders. */
  progress?: string[];
  /** Final-result stats line (legacy blocking results + get_subagent_result reads). */
  summary?: string;
  costUsd?: number;
  children?: WorkflowOutcome["children"];
  runIds?: string[];
  replay?: WorkflowOutcome["replay"];
}

export const WorkflowToolParams = Type.Object({
  script: Type.String({
    description:
      "The workflow script source. Must start with `export const meta = { name, description }` (a plain object " +
      "literal). The sandboxed script body may call agent(prompt, opts?), parallel(thunks), pipeline(items, " +
      "...stages), phase(title), log(message), and read the top-level `args`/`budget` globals. agent()'s opts is " +
      "strictly validated: only label, agentType, phase, fullResult, model, thinking, isolation, experts are " +
      "allowed — any other key (or a wrong-typed value on an allowed one, or opts itself not being a plain object) " +
      "rejects the call with the full allowed-key list and a 'did you mean' hint for common mistakes (e.g. effort " +
      "-> thinking, subagent_type -> agentType, schema/resume/timeout_ms are not supported here at all). model is a " +
      "per-call model override — the FULL 'provider/id' exactly as listed in the " +
      "'Available models' section of the system prompt, same rule as the Agent tool; a bare model id/substring is " +
      "resolved as a fuzzy hint, and an unknown model or unresolvable hint rejects the agent() call), thinking " +
      "('off' | 'low' | 'medium' | 'high', per-call thinking-level override; unset = the agent type's frontmatter " +
      "level). isolation: 'worktree' runs that specific agent() call in its own isolated git worktree created from " +
      "the current HEAD (uncommitted main-checkout changes are NOT visible, and isolated calls cannot see each " +
      "other's changes either); on completion its changes are committed to a new pi-agent-<runId> branch in the " +
      "main repo (merge or cherry-pick it yourself — the workflow never merges automatically) or the worktree is " +
      "PRESERVED on disk instead if committing fails (the outcome names its path). Fails the call outright (no " +
      "fallback) when worktree.enabled is off. With workflow.isolationReplay=verify (the default), a subsequent " +
      "run with the same journal can reuse a prior isolated call's result IF its pi-agent-<runId> branch still " +
      "exists and points exactly at the commit that was recorded (anything else — merged-and-deleted, rebased, " +
      "force-pushed, appended-to — reruns it live); a re-run whose isolated call was skipped/live also re-runs " +
      "every downstream call that depended on it. With isolationReplay=off, an isolated call's result is never " +
      "journaled or replayed, and every " +
      "call submitted afterward in this same run is skipped from replay too, even when a journal is configured. " +
      "experts is a whitelist of subagent handles (labels/run_ids from THIS workflow run, or the reserved " +
      "'main' for the host main session) this specific agent() call may consult in-turn via the consult tool — " +
      "unlike the top-level Agent tool's experts, a workflow expert must already be a **completed** run with a " +
      "persisted session (failed/timed_out/aborted/still-running entries are rejected); resolving a within-this-" +
      "workflow label always prefers THIS run's own matching call (by declared or effective label) over any " +
      "outside run sharing the name, and rejects outright if that local call hasn't settled yet or never completed " +
      "successfully. Any agent() call that carries experts, and every call submitted after one whose experts " +
      "resolved successfully, is never replayed (journal-wise) even when a journal is configured — a re-run whose " +
      "upstream expert call would have replayed instead rejects the downstream expert call; pass noReplay: true to " +
      "force the whole run live. Each pipeline stage " +
      "is called as stage(prevValue, item, index) \u2014 the first stage gets prevValue=undefined, so write it as " +
      "(_prev, item, i) => ... . The script may not use " +
      "Date.now()/Math.random()/eval (all disabled \u2014 they would silently break replay). Max 512 KiB.",
  }),
  args: Type.Optional(
    Type.Unknown({ description: "JSON-shaped value surfaced to the script as its top-level `args` global." }),
  ),
  journal: Type.Optional(
    Type.String({
      description:
        "Journal namespace for replay/caching across runs. Omit to disable both replay and journal writes " +
        "(every agent() call runs live, nothing is recorded). If loading the journal takes too long (slow/hung disk), " +
        "this run silently falls back to live-only and skips writing it this time; see WorkflowOutcome.replay.loadError.",
    }),
  ),
  noReplay: Type.Optional(
    Type.Boolean({
      description: "Force every agent() call live even if a journal is configured; journal writes still happen.",
    }),
  ),
  replayScope: Type.Optional(
    Type.Union([Type.Literal("chain"), Type.Literal("content")], {
      description:
        'Replay lookup-key scope. "chain" (default) only reuses a result when every prior call in submission ' +
        'order also still matches (safe against implicit filesystem causality between sibling calls). "content" ' +
        "matches each call independently \u2014 higher hit rate, but can reuse a result even when an earlier sibling " +
        "call changed the workspace the prompt implicitly depends on. A WARN is logged whenever content scope is used.",
    }),
  ),
  timeout_s: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Total wall-clock budget for the whole workflow run, in seconds (overrides the default). An explicit " +
        "timeout_s is a hard cap: no timeout grace window and no extension. Omit it to get the default budget, " +
        "which can be extended.",
    }),
  ),
});
export type WorkflowToolParams = Static<typeof WorkflowToolParams>;

/**
 * Exported for tests. `timeoutMs <= 0` (or non-finite) falls back to the base budget — BW10 (a 0 = unbounded workflow
 * cap) is unsupported, same rule as the settings layer. An explicit `timeout_s` is a **hard cap** (workflow-agent-queue
 * §4.1, D-10 for workflows): `maxTotalFactor = 1` ⇒ hard ceiling = soft deadline ⇒ no grace window, no extension.
 */
export function mergeBudget(base: WorkflowRunBudget, timeoutMs?: number): WorkflowRunBudget {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return base;
  return { ...base, workflowTotalMs: timeoutMs, maxTotalFactor: 1 };
}

/** `" (extendable up to 2h)"` for a default-budget run that can be extended past its budget; empty for a hard cap. */
function extendableSuffix(budget: WorkflowRunBudget): string {
  const factor = budget.maxTotalFactor ?? 1;
  if (!(factor > 1) || !((budget.maxExtensions ?? 0) > 0)) return "";
  return ` (extendable up to ${formatDuration(Math.ceil(budget.workflowTotalMs * factor))})`;
}

export function scriptDisplayName(script: string): string {
  const m = /export\s+const\s+meta\s*=\s*\{[^}]*name\s*:\s*["'`]([^"'`]+)["'`]/.exec(script);
  return m?.[1] ?? "(unnamed workflow)";
}

/** M10: at most this many per-child live rows on the tool card; the rest collapse into a "+N more" line. */
const MAX_PROGRESS_CHILD_ROWS = 6;
/** M10: how many recently-settled children the card's ✓/✗ trail shows. */
const MAX_SETTLED_TRAIL = 3;

function settledMark(status: string, source: "live" | "replay"): string {
  if (status === "completed") return source === "replay" ? "\u21a9" : "\u2713"; // ↩ replay hit, ✓ live
  if (status === "withheld") return "\u2298"; // ⊘ never ran (admission/budget)
  return "\u2717"; // ✗
}

/**
 * M10: live progress lines for a running workflow (get_subagent_result's
 * running read and its wait stream; formerly the blocking tool card) — the
 * workflow-level counterpart of agent-tool.ts's `buildProgressLines`.
 * Line 1 is a status header (name · phase · elapsed · budget left); line 2
 * is a settled/running tally; then one live row per active child (the
 * child's own M-B progress lines, re-prefixed with its label), falling back
 * to a plain "spawned … ago" row while the child's session snapshot has not
 * landed in the query service yet.
 */
export function buildWorkflowProgressLines(
  activity: WorkflowActivitySnapshot,
  now: number,
  snapshotOf?: (runId: string) => RunSnapshot | undefined,
): string[] {
  const header = [
    `\u23f3 ${activity.name}`,
    activity.currentPhaseId !== undefined ? `phase: ${activity.currentPhaseId}` : undefined,
    formatDuration(Math.max(0, now - activity.startedAt)),
    // Stage B: inside the timeout grace window the soft deadline is already past — count down the grace instead.
    activity.graceUntil !== undefined
      ? `grace ${formatDuration(Math.max(0, activity.graceUntil - now))} left`
      : activity.deadlineAt !== undefined
        ? `${formatDuration(Math.max(0, activity.deadlineAt - now))} left${
            (activity.extensions ?? 0) > 0 ? ` (+${activity.extensions})` : ""
          }`
        : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header];

  const failed = activity.settledTotal - activity.completedTotal;
  const tally = [
    activity.settledTotal > 0
      ? `\u2713 ${activity.completedTotal}${activity.replayTotal > 0 ? ` (${activity.replayTotal} replay)` : ""}`
      : undefined,
    failed > 0 ? `\u2717 ${failed}` : undefined,
    activity.activeChildren.length > 0 ? `\u25b8 ${activity.activeChildren.length} running` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (tally) lines.push(tally);

  const recent = activity.settledChildren.slice(-MAX_SETTLED_TRAIL);
  if (recent.length > 0) {
    lines.push(
      recent
        .map((c) => `${settledMark(c.status, c.source)} ${c.label ?? c.callId} (${formatDuration(c.durationMs)})`)
        .join(" · "),
    );
  }

  const shown = activity.activeChildren.slice(0, MAX_PROGRESS_CHILD_ROWS);
  for (const child of shown) {
    const name = child.label ?? child.callId;
    const snap = child.runId !== undefined ? snapshotOf?.(child.runId) : undefined;
    if (!snap) {
      lines.push(`\u25b8 ${name} · spawned ${formatDuration(Math.max(0, now - child.enteredAt))} ago`);
      continue;
    }
    const childLines = buildProgressLines(snap, now, 1);
    const first = childLines[0] ?? "";
    childLines[0] = `\u25b8 ${name} · ${first.replace(/^\u23f3 /, "")}`;
    lines.push(...childLines);
  }
  const hidden = activity.activeChildren.length - shown.length;
  if (hidden > 0) lines.push(`\u2026 +${hidden} more running`);
  return lines;
}

/** M10: final stats line, e.g. "completed · 2m10s · 5 children (\u27133 \u21a91 \u27171) · $0.42". */
export function formatWorkflowSummary(outcome: WorkflowOutcome, totalUsage?: UsageDelta): string {
  const parts: string[] = [outcome.status, formatDuration(outcome.durationMs)];
  if (outcome.children.length > 0) {
    const completed = outcome.children.filter((c) => c.status === "completed").length;
    const replay = outcome.children.filter((c) => c.source === "replay").length;
    const failed = outcome.children.length - completed;
    const tally = [
      completed > 0 ? `\u2713${completed}` : undefined,
      replay > 0 ? `\u21a9${replay}` : undefined,
      failed > 0 ? `\u2717${failed}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`${outcome.children.length} children${tally ? ` (${tally})` : ""}`);
  }
  if (totalUsage) parts.push(formatWidgetCost(totalUsage.costUsd));
  return parts.join(" · ");
}

const MAX_CHILD_PREVIEW = 2_048;
const MAX_TOTAL_PREVIEW = 32_768;

/**
 * `omitCompletedPreviews`: when the script returned a `result`, a completed
 * child's text already reached the caller through it (or was deliberately
 * condensed away by the script) — repeating up to 32 KiB of previews would
 * just duplicate `result`. Non-completed children keep their preview: their
 * `agent()` call resolved to `null`, so that text never made it into `result`.
 */
function renderChildren(children: WorkflowOutcome["children"], omitCompletedPreviews = false): string {
  let budget = MAX_TOTAL_PREVIEW;
  const lines: string[] = [];
  for (const c of children) {
    const showPreview = !(omitCompletedPreviews && c.status === "completed");
    const preview = showPreview && c.textPreview ? c.textPreview.slice(0, MAX_CHILD_PREVIEW) : "";
    let line = `  - [${c.status}${c.source === "replay" ? "/replay" : ""}] ${c.label ?? c.callId}${preview ? `: ${preview}` : ""}`;
    if (line.length > budget) {
      line = `${line.slice(0, Math.max(0, budget))}\u2026(truncated, see get_subagent_result for the full run)`;
    }
    lines.push(line);
    budget -= line.length;
    if (budget <= 0) {
      lines.push("  \u2026(further child output truncated)");
      break;
    }
  }
  return lines.join("\n");
}

/**
 * workflow-worktree plan D5 (§4 render): the worktree-isolation block
 * `formatWorkflowResultText`/`formatWorkflowNotification` splice in
 * *outside* the head/tail-truncated body, so a caller can always see every
 * child's branch/kept-path/pending state even when `renderOutcomeText`'s
 * own body got cut. Self-bounded independently of that truncation: at most
 * `WORKTREE_BLOCK_MAX_LINES` rows, each capped at
 * `WORKTREE_BLOCK_LINE_MAX_CHARS` chars, the whole block capped at
 * `WORKTREE_BLOCK_MAX_BYTES` — anything beyond that collapses into a single
 * "…N more" line pointing at `git branch --list 'pi-agent-*'`. `clean`/
 * `none` children are never listed (nothing interesting to report).
 * Returns `undefined` when no child has a worktree entry at all (the common
 * case — no `isolation:"worktree"` calls this run), so callers can skip
 * splicing in an empty section.
 */
const WORKTREE_BLOCK_MAX_LINES = 64;
const WORKTREE_BLOCK_LINE_MAX_CHARS = 300;
const WORKTREE_BLOCK_MAX_BYTES = 8 * 1024;

function describeWorktreeState(info: NonNullable<WorkflowChildSummary["worktree"]>): string {
  switch (info.state) {
    case "committed":
      return info.branch ?? "committed";
    case "kept":
      return info.path ? `kept ${info.path}` : "kept";
    case "pending":
      return "pending";
    case "clean":
      return "clean";
    case "none":
      return "none";
  }
}

function worktreeLineFor(c: WorkflowChildSummary): string | undefined {
  const info = c.worktree;
  if (info === undefined || info.state === "clean" || info.state === "none") return undefined;
  const name = c.label ?? c.callId;
  if (c.source === "replay") {
    // replay-verify plan D7/D11: a replayed hit has no `runId`, so the
    // "expected branch" convention below is meaningless for it — render the
    // recorded branch + a short sha instead, plus a stale annotation from
    // the terminal recheck (D4.4) when one landed.
    if (info.state !== "committed") return undefined; // clean replay hits are filtered above; nothing else is ever journaled
    const sha7 = info.commit !== undefined ? info.commit.slice(0, 7) : "?";
    const staleSuffix = c.replayStale !== undefined ? `, branch ${c.replayStale}` : "";
    const line = `${name} \u2192 ${info.branch ?? "?"} (replayed @${sha7}${staleSuffix})`;
    return line.length > WORKTREE_BLOCK_LINE_MAX_CHARS
      ? `${line.slice(0, WORKTREE_BLOCK_LINE_MAX_CHARS - 1)}\u2026`
      : line;
  }
  const expectedBranch = `pi-agent-${c.runId ?? c.callId}`;
  const desc =
    info.state === "pending" && c.worktreeFinal !== undefined
      ? `pending\u2192${describeWorktreeState(c.worktreeFinal)}`
      : describeWorktreeState(info);
  const line = `${name} \u2192 ${desc} (expected branch ${expectedBranch})`;
  return line.length > WORKTREE_BLOCK_LINE_MAX_CHARS
    ? `${line.slice(0, WORKTREE_BLOCK_LINE_MAX_CHARS - 1)}\u2026`
    : line;
}

export function renderWorktreeBlock(outcome: WorkflowOutcome): string | undefined {
  const candidates: string[] = [];
  for (const c of outcome.children) {
    const line = worktreeLineFor(c);
    if (line !== undefined) candidates.push(line);
  }
  if (candidates.length === 0) return undefined;
  let more = Math.max(0, candidates.length - WORKTREE_BLOCK_MAX_LINES);
  const capped = candidates.slice(0, WORKTREE_BLOCK_MAX_LINES);
  const kept: string[] = [];
  // The 8 KiB cap covers the WHOLE block: header + lines + the worst-case
  // `…N more` tail (N ≤ candidates.length), reserved up front.
  const header = "worktrees:\n";
  const tailReserve = Buffer.byteLength(worktreeTail(candidates.length), "utf8");
  const budget = WORKTREE_BLOCK_MAX_BYTES - Buffer.byteLength(header, "utf8") - tailReserve;
  let bytes = 0;
  for (const line of capped) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > budget) {
      more += capped.length - kept.length;
      break;
    }
    bytes += lineBytes;
    kept.push(line);
  }
  return `${header}${kept.join("\n")}${more > 0 ? worktreeTail(more) : ""}`;
}

function worktreeTail(more: number): string {
  return `\n\u2026${more} more; git branch --list 'pi-agent-*'`;
}

export function renderOutcomeText(outcome: WorkflowOutcome): string {
  const parts: string[] = [];
  if (outcome.diag.degraded === "settlement_timeout") {
    parts.push(
      "WARNING: the tool's own settlement grace window elapsed before the orchestrator confirmed a fully " +
        "reconciled outcome. The status/children below are a best-effort snapshot (pendingReconcile may still be " +
        "true) and MUST NOT be treated as a confirmed final state \u2014 some children may still be `running`/`stopping`.",
    );
  }
  parts.push(`workflow ${outcome.workflowId}: ${outcome.status}${outcome.stopCause ? ` (${outcome.stopCause})` : ""}`);
  if (outcome.diag.stageErrors) {
    const se = outcome.diag.stageErrors;
    parts.push(
      `WARNING: ${se.count} parallel()/pipeline() stage(s) threw and were settled to null \u2014 the result below may be ` +
        "silently incomplete (a null where a real value was expected). First reported failures: " +
        se.samples
          .map(
            (s) =>
              `${s.source}[item ${s.itemIndex}${s.stageIndex !== undefined ? ` stage ${s.stageIndex}` : ""}]: ${s.message}`,
          )
          .join(" | "),
    );
  }
  if (outcome.result !== undefined) {
    // Strings verbatim; structured values pretty-printed (2-space) on their own lines so nested
    // objects stay readable. A primitive/empty value stays inline (`result: 42`).
    const r = outcome.result;
    const rendered = typeof r === "string" ? r : (JSON.stringify(r, null, 2) ?? String(r));
    parts.push(rendered.includes("\n") ? `result:\n${rendered}` : `result: ${rendered}`);
  }
  if (outcome.error) parts.push(`error: ${outcome.error.message}`);
  if (outcome.children.length) {
    const hasResult = outcome.result !== undefined;
    const note = hasResult ? ", completed outputs omitted \u2014 see result or get_subagent_result" : "";
    parts.push(`children (${outcome.children.length}${note}):\n${renderChildren(outcome.children, hasResult)}`);
  }
  if (outcome.orphanChildren?.length) parts.push(`orphaned children: ${outcome.orphanChildren.length} (see diag)`);
  if (outcome.replay) {
    const iso = outcome.replay.isolation;
    const isoSuffix =
      iso !== undefined
        ? `, ${iso.verified} wt-verified, ${iso.unverified} wt-unverified${iso.stale > 0 ? `, ${iso.stale} wt-stale` : ""}`
        : "";
    parts.push(
      `replay: ${outcome.replay.hits} hit, ${outcome.replay.misses} miss, ${outcome.replay.skipped} skipped, ${outcome.replay.corruptLines} corrupt${isoSuffix}`,
    );
    if (outcome.replay.loadError !== undefined) {
      parts.push(
        `WARNING: journal not used this run (${outcome.replay.loadError}) \u2014 every agent() call ran live and nothing was written to the journal.`,
      );
    }
  }
  return parts.join("\n");
}

/** Sum of the live children's lifetime spend (replay hits and withheld calls carry no runId and cost nothing). */
export function liveChildRunIds(outcome: WorkflowOutcome): string[] {
  return outcome.children.filter((c) => c.source === "live" && c.runId !== undefined).map((c) => c.runId!);
}

export function sumUsage(
  usages: readonly (UsageDelta | BackgroundWorkflowUsage | undefined)[],
): UsageDelta | undefined {
  return usages.reduce<UsageDelta | undefined>((acc, u) => {
    if (!u) return acc;
    return acc
      ? {
          input: acc.input + u.input,
          output: acc.output + u.output,
          cacheRead: acc.cacheRead + u.cacheRead,
          cacheWrite: acc.cacheWrite + u.cacheWrite,
          costUsd: acc.costUsd + u.costUsd,
        }
      : { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: u.costUsd };
  }, undefined);
}

/** Aggregate child spend of a settled workflow, looked up per live child run. */
export function aggregateChildUsage(
  outcome: WorkflowOutcome,
  usageOf: ((runId: string) => UsageDelta | undefined) | undefined,
): UsageDelta | undefined {
  if (!usageOf) return undefined;
  return sumUsage(liveChildRunIds(outcome).map((id) => usageOf(id)));
}

function workflowLabelMarker(name: string, workflowId: string, status: string): string {
  return `[workflow label: "${name}" · workflow_id: ${workflowId} · status: ${status}]`;
}

/**
 * Terminal read text (get_subagent_result): the outcome rendering capped by
 * resultMaxChars, plus a duration/children/cost trailer — the workflow
 * counterpart of the run result trailer.
 */
export function formatWorkflowResultText(outcome: WorkflowOutcome, usage: UsageDelta | undefined, maxChars: number) {
  const body = truncateResultText(renderOutcomeText(outcome), maxChars);
  // workflow-worktree plan D5 (§4 render): spliced in *outside* the
  // truncated body — the branch/kept/pending block always survives head/tail
  // truncation, and is capped independently of it.
  const worktreeBlock = renderWorktreeBlock(outcome);
  const worktreeSection = worktreeBlock !== undefined ? `\n\n${worktreeBlock}` : "";
  const trailer = [
    `duration: ${formatDuration(outcome.durationMs)}`,
    `children: ${outcome.children.length}`,
    usage
      ? `usage: in:${usage.input} out:${usage.output} cache_r:${usage.cacheRead} cache_w:${usage.cacheWrite} cost:$${usage.costUsd.toFixed(4)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    text: `${body.text}${worktreeSection}\n\n(${trailer})`,
    truncated: body.truncated,
    totalChars: body.totalChars,
  };
}

/**
 * Completion notification body pushed to the main session when a background
 * workflow settles: header (name · id · stats incl. spend), the outcome text
 * capped by resultMaxChars, and how to re-read it.
 */
export function formatWorkflowNotification(
  settled: Pick<BackgroundWorkflowView, "workflowId" | "name"> & { outcome: WorkflowOutcome },
  usage: UsageDelta | undefined,
  maxChars: number,
): string {
  const { outcome } = settled;
  const header = `Workflow "${settled.name}" (${settled.workflowId}) ${outcome.status} — ${formatWorkflowSummary(outcome, usage)}`;
  const body = truncateResultText(renderOutcomeText(outcome), maxChars).text;
  // workflow-worktree plan D5: same placement rule as formatWorkflowResultText — outside the truncated body, before the hint.
  const worktreeBlock = renderWorktreeBlock(outcome);
  const worktreeSection = worktreeBlock !== undefined ? `\n\n${worktreeBlock}` : "";
  const hint =
    `Re-read the full outcome with get_subagent_result(run_id: "${settled.workflowId}")` +
    (outcome.children.length > 0 ? " (it also reports the children's spend to the session totals)." : ".");
  return `${header}\n\n${body}${worktreeSection}\n\n${hint}`;
}

/**
 * "SubagentWorkflow" — model-facing entry point.
 *
 * Honest capability declaration (§5.3 compat matrix, §1.2 non-goals):
 *  - Always background: the call returns a workflow id at once; a completion
 *    notification follows; get_subagent_result / abort_subagent manage it.
 *  - NW3: no pause/step/skip/retry — the only control once started is stop
 *    (abort_subagent), which stops the whole run.
 *  - NW5: `workflow(nameOrRef)` (nested workflow calls) is not implemented;
 *    a script that calls it gets a clear rejection, not a silent no-op.
 */
export function createWorkflowTool(deps: WorkflowToolDeps): ToolDefinition<typeof WorkflowToolParams> {
  return {
    name: "SubagentWorkflow",
    label: "Subagent Workflow",
    description:
      "Run a multi-agent orchestration script: a sandboxed JS program that calls agent(prompt, opts?) (and " +
      "parallel()/pipeline()/phase()/log()) to coordinate several bounded subagent runs, with its own absolute " +
      "wall-clock budget, deadline-capped children, and (optionally) cross-run result caching via a journal. " +
      "The workflow always runs in the background: the call returns immediately with a workflow id (wf_…), and " +
      "a completion notification is pushed to you when the workflow reaches a terminal state " +
      "(completed/failed/timed_out/aborted — it never hangs). After that notification arrives, collect the full " +
      "outcome with get_subagent_result(run_id: <workflow id>); stop it early with abort_subagent(run_id: " +
      "<workflow id>), which stops every child run. Do not poll or block waiting for it — continue other work or " +
      "end your turn. Differences from a general multi-agent orchestrator you may have used before: (1) there is " +
      "no pause/step/skip/retry control once started — only stop; (2) nested workflow(...) calls are not " +
      "supported (inline the referenced logic directly). Each agent() call can also carry its own model (full " +
      "'provider/id' as listed in the system prompt's Available models section — same rule as the Agent tool's model " +
      "param) and thinking level, overriding the agent type's frontmatter for that child. agent() calls beyond the workflow's own concurrency " +
      "limit are queued FIFO instead of failing; a call still queued when the workflow stops or times out " +
      "resolves to null (as does one that runs out of workflow budget while queued — a call made after the " +
      "budget is already exhausted rejects instead). A queued call whose dispatch fails (spawn error/timeout) " +
      "rejects like any admission failure, so fire-and-forget agent() calls (not awaited) should attach their " +
      "own .catch(). Timeouts work like a subagent's: with the default budget, a workflow that reaches its " +
      "deadline gets a short grace window and you receive a notice — extend it with extend_subagent_timeout(run_id: " +
      "<workflow id>, extend_s) (a limited number of extensions, capped by a hard ceiling) or let it stop as " +
      "timed_out; its children are aborted with it. A workflow started with an explicit timeout_s is a hard cap " +
      "(no grace, no extension). One exception: a script gate() shell call keeps the deadline it was given when it " +
      "started, so extending the workflow does not lengthen a gate already in flight. Use this only when a single Agent call's own multi-step " +
      "reasoning is not enough and you specifically need several independently-prompted subagents coordinated by " +
      "real control flow.",
    promptSnippet:
      "SubagentWorkflow(script, args?, journal?, noReplay?, replayScope?, timeout_s?) - run a multi-agent orchestration script in the background (returns a workflow id; completion is notified)",
    parameters: WorkflowToolParams,
    /**
     * Show the workflow's declared name + the knobs that matter (journal /
     * timeout), like the Agent card shows its description.
     */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = typeof args?.script === "string" ? scriptDisplayName(args.script) : "…";
      const title = theme.fg("toolTitle", theme.bold(`Subagent Workflow: ${name}`));
      const meta = [
        args?.journal ? `journal: ${args.journal}` : undefined,
        args?.replayScope ? `replay: ${args.replayScope}` : undefined,
        args?.noReplay ? "no-replay" : undefined,
        typeof args?.timeout_s === "number" ? `timeout: ${formatDuration(args.timeout_s * 1000)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    async execute(_toolCallId, params, signal) {
      // §5.1 rule 1: check signal?.aborted before anything else — never boot a worker for an already-cancelled call.
      // After this check the run is detached from `signal` (Esc on this turn does not stop the workflow).
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "workflow run aborted before starting (signal already aborted)." }],
          details: { status: "aborted" as const },
        };
      }
      const size = validateScriptSize(params.script);
      if (!size.ok) throw new Error(`SubagentWorkflow: ${size.message}`);
      const budget = mergeBudget(
        deps.defaultBudget,
        params.timeout_s === undefined ? undefined : params.timeout_s * 1000,
      );
      if (budget.heartbeatMs > 0) {
        assertHeartbeatBudgetInvariant(budget.scriptSliceMs, budget.heartbeatStallMs, budget.heartbeatMs);
      }
      const name = scriptDisplayName(params.script);
      const started = deps.runs.start({
        script: params.script,
        name,
        budget,
        ...(params.args !== undefined ? { args: params.args } : {}),
        ...(params.journal !== undefined ? { journal: params.journal } : {}),
        ...(params.noReplay !== undefined ? { noReplay: params.noReplay } : {}),
        ...(params.replayScope !== undefined ? { replayScope: params.replayScope } : {}),
      });
      const id = started.workflowId;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Workflow "${name}" started in background (workflow_id: ${id}, budget: ${formatDuration(budget.workflowTotalMs)}${extendableSuffix(budget)}). ` +
              "You will receive a completion notification when it reaches a terminal state — do not block or poll " +
              `for it now; collect the full outcome with get_subagent_result(run_id: "${id}") after the notification ` +
              `arrives, or stop it early with abort_subagent(run_id: "${id}").`,
          },
          { type: "text" as const, text: workflowLabelMarker(name, id, "running") },
        ],
        details: { workflowId: id, label: name, status: "running", background: true } satisfies WorkflowToolDetails,
      };
    },
    /**
     * Background start results render as their (short) text; results from
     * sessions recorded before the background switch still carry a stats
     * `summary` and, for partial updates, live `progress` lines — both keep
     * rendering so old history stays readable.
     */
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = (result.details ?? {}) as WorkflowToolDetails;
      const body = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
      if (options.isPartial && details.progress) {
        const rendered = details.progress
          .map((line) => {
            const t = line.trimStart();
            if (t.startsWith("\u2717")) return theme.fg("error", line);
            if (t.startsWith("\u25b8")) return theme.fg("accent", line);
            if (t.startsWith("\u2713") || t.startsWith("\u21a9") || t.startsWith("\u2298"))
              return theme.fg("muted", line);
            return line;
          })
          .join("\n");
        text.setText(rendered);
        return text;
      }
      const parts: string[] = [];
      if (details.summary) parts.push(theme.fg("muted", `\u2713 ${details.summary}`));
      else if (details.background && details.workflowId)
        parts.push(theme.fg("muted", `\u25b8 ${details.workflowId} · running in background`));
      if (body) {
        const lines = body.split("\n");
        const cap = 6;
        if (!options.expanded && lines.length > cap) {
          parts.push(lines.slice(0, cap).join("\n"));
          parts.push(theme.fg("muted", `\u2026 +${lines.length - cap} more lines`));
        } else {
          parts.push(body);
        }
      }
      text.setText(parts.join("\n"));
      return text;
    },
  } satisfies ToolDefinition<typeof WorkflowToolParams>;
}

/** M3.6 \u00a711 hand-off: registered instead of the real tool when `settings.workflow.enabled` is false (index.ts) \u2014 gives the model (and a curious user reading tool descriptions) a clear, honest reason rather than the tool silently not existing. Mirrors index.ts's existing `compat.ok===false` "Agent (unavailable)" stub. */
export function createDisabledWorkflowToolStub(): ToolDefinition<typeof WorkflowToolParams> {
  return {
    name: "SubagentWorkflow",
    label: "Subagent Workflow (disabled)",
    description:
      "Multi-agent orchestration scripts are disabled on this instance (settings.workflow.enabled is false). " +
      "Use the Agent tool for single-subagent delegation instead.",
    parameters: WorkflowToolParams,
    async execute() {
      throw new Error("SubagentWorkflow is disabled (settings.workflow.enabled is false)");
    },
  } satisfies ToolDefinition<typeof WorkflowToolParams>;
}
