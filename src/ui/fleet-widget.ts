import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Millis, RunId, SubagentExtensionPoints } from "../core/types.js";
import type { ContextReceipt } from "../delivery/context-receipt.js";
import type { JobRecord, JobStatus } from "../bash/types.js";
import { isTerminalJobStatus, previewCommand } from "../bash/types.js";
import type { QueryService } from "../service/query-service.js";
import {
  buildFleetViewModel,
  colorizeToolTrail,
  formatContextUsage,
  formatDuration,
  worktreeMarker,
  type FleetColorize,
  type FleetHighlight,
  type FleetRow,
  type FleetViewModel,
} from "./fleet-panel.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";

/**
 * X7b fleet widget: the always-on compact counterpart to the `/agent fleet`
 * full-screen panel (fleet-panel.ts). Pinned above the editor via
 * ctx.ui.setWidget(placement: "aboveEditor") whenever subagent runs are
 * active; hidden (setWidget(key, undefined)) when the fleet is idle.
 *
 * M-C upgrade: the widget is now the primary background presentation — a
 * compact *agent tree*. One header line (worst-highlight bullet, active
 * count, live cost, overflow) followed by 1–2 lines per run: the main row
 * (label · type · model · phase · phase age · Σ total elapsed · cost),
 * children indented under their parent (↳) via FleetRow.parentRunId, plus an
 * activity line hung on a ╰ hook (collapsed tool tally `✓ bash ×9 | ✓ read
 * ×6` with green ✓ / red ✗ marks + an accent in-flight ▸tool + args preview
 * + live tool duration, » thinking stream) when the run is mid-tool or mid-thought — long tool calls render in full on their own
 * line instead of being truncated off the row. The ╰ + muting keep per-agent
 * boundaries legible: bright main rows are the anchors, dim hooked lines
 * read as belonging to the row above.
 *
 * Same two-layer split as the panel:
 *  1. Pure line builders (`buildFleetWidgetLines`, `formatWidgetCost`) —
 *     FleetViewModel in, plain-text lines (or undefined) out. Coloring is
 *     injected, so the layer is fully unit-testable without a terminal.
 *  2. `FleetWidgetController` — owns the 1s refresh timer (injected Clock),
 *     the ui capability probe (non-interactive print/rpc modes may lack
 *     setWidget → the controller goes inert silently), and the H1
 *     `onLifecycle` immediate-refresh hook exposed as
 *     SubagentExtensionPoints so stack.ts can merge it into the existing
 *     extension-point fan-out (no new hook surface). Failure isolation is
 *     part of the contract, but note WHICH paths actually needed it: the H1
 *     fan-out is already guarded upstream (mergeExtensionPoints catches +
 *     WARNs every onLifecycle throw), so the two unprotected paths were the
 *     1Hz tick — a self-rescheduling one-shot whose skipped re-arm freezes
 *     the tree for the whole session, not just one frame — and the
 *     constructor's initial refresh(), which runs inside buildSessionStack
 *     and would therefore take the *entire extension* down with it (a throw
 *     escapes the session_start handler before `holder.current = stack`, so
 *     every later Agent call fails with "no active session yet").
 *
 * The data source is always QueryService.list() → buildFleetViewModel (the
 * same view-model the panel renders); lifecycle events only trigger an early
 * refresh, they never carry display state.
 */

/** Widget registry key (setWidget). Stable across session rebuilds so a new session's widget replaces the old one's content. */
export const FLEET_WIDGET_KEY = "pi-subagent:fleet";

const WIDGET_MARK: Record<FleetHighlight, string> = { none: " ", warn: "!", crit: "✗" };

/** M-C: default / hard cap on run LINES below the header (a run uses 1–2: main row + activity line).
 *  Default 6 fully covers the common ≤3-busy-agent fleet (3 main + 3 activity lines). */
export const WIDGET_DEFAULT_ROWS = 6;
export const WIDGET_MAX_ROWS = 8;

/**
 * Compact cost for the widget: 4 decimals below half a cent (subagent runs
 * are typically sub-cent — same concern as formatUsage), 2 decimals at/above
 * (e.g. "$1.05"). Boundary: exactly $0.005 renders as "$0.01".
 */
export function formatWidgetCost(costUsd: number): string {
  return `$${costUsd < 0.005 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

/** Widget row log size; bytes remain explicit below 1KB because tiny logs are common. */
export function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Bash terminal severity mirrors the widget's run tones without treating user kills as failures. */
export function bashJobHighlight(status: JobStatus): FleetHighlight {
  if (status === "failed" || status === "timed_out") return "crit";
  if (status === "killed" || status === "exited_unknown" || status === "orphaned") return "warn";
  return "none";
}

/** Extract the last meaningful log line before folding its whitespace into one activity row. */
export function tailLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line.replace(/\s+/g, " ");
  }
  return undefined;
}

/** D1: controller-prepared bash data keeps the builder independent of manager state and clocks. */
export interface BashJobViewInput {
  jobId: string;
  commandPreview: string;
  status: JobStatus;
  highlight: FleetHighlight;
  elapsedMs: number;
  logBytes: number;
  logTail?: string;
  settledAgoMs?: number;
}

export interface FleetWidgetRenderOptions {
  /** Line budget for run lines below the header (a run with live activity uses 2). Default WIDGET_DEFAULT_ROWS (6); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** M6: keep just-finished runs visible (dimmed, ✓/✗) for this long. Default 5000ms; 0 disables. */
  terminalLingerMs?: number;
  /** Context receipt lookup for terminal notification visibility. */
  receiptOf?: (runId: string) => ContextReceipt;
  /** X6b: latest raw user @ message per run — rendered under the run (and as the ONLY awaiting-entry preview). */
  mentionNoteOf?: (runId: string) => string | undefined;
  /** Hard upper bound for pending notification rows. Default 10 minutes. */
  awaitNotificationMs?: number;
  /** M9: in-flight workflows — rendered as ⚙ group headers with their children (rows whose parentRunId === workflowId) indented beneath. M11: pipeline view — phase chain + counts + frozen terminal linger. */
  workflows?: readonly WorkflowGroupInput[];
  /** D1/M3: background bash jobs share the main-row budget with runs. */
  bashJobs?: readonly BashJobViewInput[];
  /** Color injector, same tones as the panel (warn/crit/muted); default plain text. */
  color?: FleetColorize;
  /** Available visible columns for main-row field assembly. */
  width?: number;
  /** M11: spinner frame index for the active phase chip (`now / refreshMs` is a natural choice). Default 0 — the builder stays pure. */
  frame?: number;
}

/** M11: one phase chip of a workflow's pipeline chain (structurally the registry's WorkflowPhaseActivity). */
export interface WorkflowPhaseChip {
  /** Visit display id — the bare phase name (`draft`) or a re-entry (`draft#2`). */
  readonly id: string;
  /** The original phase name — present only on repeat visits (`id !== name`). */
  readonly name?: string;
  readonly state: "pending" | "active" | "draining" | "done";
  readonly spawned: number;
  /** Live settles — replay hits are tallied in `replayed`, so `settled/spawned` stays a live-only fraction. */
  readonly settled: number;
  /** Settled children with status !== "completed" — renders the chip as ✗ (crit). */
  readonly failed: number;
  /** Journal-replay hits settled into this visit — renders the `↩ N` suffix. */
  readonly replayed: number;
}

/** M11: a just-settled workflow child still inside the terminal-linger window. */
export interface WorkflowDoneChild {
  readonly label: string;
  readonly ok: boolean;
  readonly durationMs: Millis;
  /** Replay hits (`↩ label replay`) have no duration and never render ✓/✗ — they were free. */
  readonly source: "live" | "replay";
}

/** workflow-agent-queue §5: one FIFO-queued `agent()` call waiting for a maxParallel slot, as rendered under its workflow's active rows. */
export interface WorkflowQueuedChildView {
  /** `label ?? agentType ?? callId` — the call's best display name. */
  readonly label: string;
  /** `now − queuedAt`, frozen at the snapshot's terminal time once the workflow ends. */
  readonly waitedMs: Millis;
}

/** M9/M11: one workflow's header + pipeline data (controller maps the registry snapshot; elapsed is precomputed and frozen at terminal). */
export interface WorkflowGroupInput {
  readonly workflowId: string;
  readonly name: string;
  readonly elapsedMs: number;
  /** Total budget (deadline − start); rendered as `elapsed / budget` when present. */
  readonly budgetMs?: number;
  /** Phase chain chips; empty/absent → no chain line (a workflow with neither planned nor entered phases stays one simple header). */
  readonly phases?: readonly WorkflowPhaseChip[];
  /** M12: visits collapsed off the chain head past the registry's visit cap — the chain renders `…+N` in front. */
  readonly collapsedVisits?: number;
  /** Children settled completed (workflow-level totals — implicit-phase children count here too). */
  readonly doneTotal: number;
  /** Children settled non-completed. */
  readonly failedTotal: number;
  /** Children currently in flight. */
  readonly activeTotal: number;
  /** workflow-agent-queue §5: calls acked while every maxParallel slot was busy, FIFO (oldest first) — header `⧗ N` + dim waiting rows. */
  readonly queued?: readonly WorkflowQueuedChildView[];
  /** workflow-agent-queue §5: `agent()` calls rejected at admission or dispatch (once per callId) — feeds `⚠ N`. */
  readonly rejectedTotal?: number;
  /** workflow-agent-queue §5: parallel/pipeline stage errors + unhandled rejections — feeds `⚠ N`. */
  readonly stageErrorTotal?: number;
  /** Just-settled children still within terminalLingerMs, most recent last. */
  readonly recentSettled?: readonly WorkflowDoneChild[];
  /** Present while the finished workflow's frozen snapshot lingers — muted header with a ✓/✗ icon. */
  readonly terminal?: { readonly status: string };
  /**
   * workflow-agent-queue §5 (stage B): the header's deadline marker, present
   * only while it carries information beyond `elapsed / budget` — inside the
   * timeout grace window (`⏳grace 58s`) or once extended (`⏳12m+1`). Running
   * workflows only.
   */
  readonly deadline?: { readonly remainingMs: number; readonly extensions: number; readonly inGrace: boolean };
}

/** M-C: one run's main tree-row line. M10: segment-colored — label is the eye-catcher
 *  (plain on calm rows, tone-tinted via `labelTone` on warn/crit rows),
 *  type/model/phase/phase-age/deadline/Σ-total/cost muted — so rows have visual
 *  depth instead of a uniform white line. Highlighted rows are NOT whole-line
 *  tone-wrapped anymore (that erased the segment colors of healthy-but-quiet
 *  runs; see renderRunLines). Live activity (tool trail / thinking stream) is
 *  NOT on this line — see widgetRowActivity. */
/** Exported for unit tests (VS16-bearing inputs are unreachable via FleetRow). */
export function compactPhaseLabel(label: string): string {
  // Codepoint-aware first cluster (keeps a trailing U+FE0F variation
  // selector): astral emoji like 🤔 are one spread element, BMP emoji like
  // ⏸/⚡/♻ may be followed by \uFE0F, which must travel with the emoji or the
  // rest-slicing below misfires (♻️重试2/3 would keep the 重试 remnant).
  const codePoints = [...label];
  const emoji = `${codePoints[0] ?? ""}${codePoints[1] === "\uFE0F" ? codePoints[1] : ""}`;
  if (emoji.startsWith("♻")) {
    // Keep a visible separator before the attempt counter. The recycle mark
    // is rendered as an emoji in some terminals (two columns), so `♻1/3`
    // can visually collide even though its string width looks correct.
    // phaseLabel now writes `♻ 重试…`; the space-bearing form must be
    // stripped too (legacy space-less inputs keep working).
    const rest = label.slice(emoji.length).replace(/^ ?重试/, "");
    return rest ? `${emoji} ${rest}` : emoji;
  }
  if (!/^(?:🧠|💭|🤔|💡|⏸|⚡|🔧|🗜|⏹)/u.test(label)) return label;
  return emoji;
}

// ── Wide-risk glyphs (defense against emoji-terminal column overlap) ───────

/**
 * BMP symbols with an emoji-presentation variant: pi-tui's `visibleWidth`
 * counts them as 1 column, but many terminals render them 2 wide — the
 * character glued right after them gets covered. (⚡⏳🔧🧠💭🤔💡 are
 * counted as 2 by visibleWidth already; ✓✗▸○⧗→⎇ have no emoji variant.)
 * UI copy must follow each of these with a space or end the line — enforced
 * by `findGlyphCollisions` in tests.
 */
export const WIDE_RISK_GLYPHS = ["⚙", "⚠", "↩", "♻", "⏸", "⏹", "🗜"] as const;

/**
 * Offending fragments of a (plain, uncolored) line: every wide-risk glyph —
 * optionally followed by U+FE0F — must be followed by a space or the end of
 * the line. Returns e.g. `["⚠2"]` for `"⚠2 active"`; empty = safe to render.
 */
export function findGlyphCollisions(line: string): string[] {
  const collisions: string[] = [];
  const codePoints = [...line];
  const risky = new Set<string>(WIDE_RISK_GLYPHS);
  for (let i = 0; i < codePoints.length; i += 1) {
    const cp = codePoints[i]!;
    if (!risky.has(cp)) continue;
    const vs16 = codePoints[i + 1] === "\uFE0F";
    const next = codePoints[i + (vs16 ? 2 : 1)];
    if (next !== undefined && next !== " ") collisions.push(`${cp}${vs16 ? "\uFE0F" : ""}${next}`);
  }
  return collisions;
}

/** Distance to an effective deadline: `⏳12m` (with `+N` when extensions
 *  were granted), `⏳grace 58s` while inside the grace window. Shared by run
 *  rows and (stage B) workflow headers so both read the same. */
export function deadlineMarker(remainingMs: number, extensions: number, inGrace: boolean): string {
  const t = formatDuration(remainingMs);
  const ext = extensions > 0 ? `+${extensions}` : "";
  return inGrace ? `⏳grace ${t}` : `⏳${t}${ext}`;
}

/** The run's distance to its effective deadline (see `deadlineMarker`). */
function deadlineField(row: FleetRow): string {
  return deadlineMarker(row.remainingMs!, row.extensions, row.inGrace);
}

function widgetRowMain(
  row: FleetRow,
  width: number,
  color: FleetColorize = (_t, s) => s,
  labelTone?: "warn" | "crit",
): string {
  const modelFull = row.model;
  const modelBase = modelFull?.slice(modelFull.lastIndexOf("/") + 1);
  const fixed = `${compactPhaseLabel(row.phaseLabel)} ${formatDuration(row.phaseMs)}`;
  const label = row.label ?? row.shortRunId;
  // X1: worktree isolation marker (⎇ wt / ⎇ branch / ⎇ kept / ⎇ clean) —
  // identity-adjacent, so it sits right after the agent type.
  const wt = worktreeMarker(row.worktree);
  const fields: Array<{ name: string; value: string }> = [
    { name: "type", value: row.type ?? "·" },
    ...(wt === undefined ? [] : [{ name: "wt", value: wt }]),
    ...(modelFull ? [{ name: "model", value: modelFull }] : []),
    { name: "phase", value: fixed },
    // deadline sits with phase ("is this run healthy?"), ahead of the resource
    // stats (context/cost/total).
    ...(row.remainingMs === undefined ? [] : [{ name: "deadline", value: deadlineField(row) }]),
    { name: "context", value: row.contextUsage ? formatContextUsage(row.contextUsage) : "" },
    ...(row.usage ? [{ name: "cost", value: formatWidgetCost(row.usage.costUsd) }] : []),
    { name: "total", value: `Σ${formatDuration(row.elapsedMs)}` },
  ];
  const shown = new Map(fields.map((field) => [field.name, field.value]));
  const compose = (labelText: string): string =>
    [labelText, ...fields.map((field) => shown.get(field.name)).filter((value) => value)].join(" ");
  const fits = () => visibleWidth(compose(label)) <= width;
  const drop = (name: string) => shown.delete(name);
  const modelField = fields.find((field) => field.name === "model");
  const modelCanShorten = modelField !== undefined && modelBase !== undefined && modelField.value !== modelBase;

  // Try the complete row first. Only after each field tier is exhausted may
  // the label be shortened; label and phase are the final identity signal.
  if (!fits()) {
    drop("type");
    if (!fits() && modelField) {
      if (modelCanShorten) shown.set("model", modelBase!);
      if (!fits()) drop("model");
    }
    if (!fits()) drop("context");
    if (!fits()) drop("wt");
    if (!fits()) drop("cost");
    if (!fits()) drop("total");
    // deadline is the LAST droppable field ("how long is left" beats "how long
    // it has run" at narrow widths), and while in grace it is NEVER dropped —
    // that is a sub-90s must-see signal; truncate the label instead.
    if (!fits() && !row.inGrace) drop("deadline");
    // Still too wide even with a 1-column label while in grace: fall back to the
    // bare `⏳58s` countdown (the row is already crit-toned, so "grace" stays legible).
    if (row.inGrace && visibleWidth(compose("")) + 1 > width) {
      shown.set("deadline", `⏳${formatDuration(row.remainingMs!)}`);
    }
  }
  // compose("") already contains the label↔fields separator (its leading
  // empty element contributes exactly one space), so no extra column reserve.
  const nonLabelWidth = visibleWidth(compose(""));
  const labelWidth = Math.max(1, width - nonLabelWidth);
  const finalLabel = visibleWidth(compose(label)) <= width ? label : truncateToWidth(label, labelWidth);
  const values = [finalLabel, ...fields.map((field) => shown.get(field.name)).filter((value) => value)];
  return values
    .map((value, index) =>
      index === 0 ? (labelTone === undefined ? value : color(labelTone, value!)) : color("muted", value!),
    )
    .join(" ");
}

/** The run's live-activity line (rendered on its own indented continuation
 *  line so long tool calls are never truncated off the row): the collapsed
 *  tool tally (`✓ bash ×9 | ✓ read ×6` — green ✓ / red ✗ marks, muted names
 *  and counts) plus the in-flight `▸tool` segment (whole-segment accent) and/or
 *  the one-line thinking stream (`» …`, muted). undefined when the run is quiet.
 *  Boundary cue: names/counts stay muted and only the ✓/✗/▸ marks pop, so
 *  bright main rows stay the visual anchors and dim activity reads as
 *  belonging to the row above it (see also the ╰ hook in renderRunLines). */
function widgetRowActivity(row: FleetRow, color: FleetColorize = (_t, s) => s): string | undefined {
  const parts: string[] = [];
  const fallbackTool =
    row.currentTool === undefined
      ? undefined
      : `▸${row.currentTool}${row.currentToolMs === undefined ? "" : ` · ${formatDuration(row.currentToolMs)}`}`;
  const trail = row.toolTrail ?? fallbackTool;
  if (trail) parts.push(colorizeToolTrail(trail, color));
  if (row.streamLine) parts.push(color("muted", `» ${row.streamLine}`));
  return parts.length ? parts.join(" ") : undefined;
}

/** M6: a just-finished run's dimmed row: "✓ 任务名 type model completed 39s $0.11". */
function widgetTerminalDetail(row: FleetRow, width: number): string {
  const label = row.label ?? row.shortRunId;
  const type = row.type ?? "·";
  const wt = worktreeMarker(row.worktree);
  const model = row.model;
  const modelBase = model?.slice(model.lastIndexOf("/") + 1);
  const suffix = [row.status, formatDuration(row.elapsedMs)];
  if (row.contextUsage) suffix.push(formatContextUsage(row.contextUsage));
  if (row.usage) suffix.push(formatWidgetCost(row.usage.costUsd));
  const candidates = [model, modelBase, undefined];
  const fits = (candidate: string | undefined, labelText: string) =>
    visibleWidth([labelText, type, wt, candidate, ...suffix].filter(Boolean).join(" ")) <= width;
  const chosen = candidates.find((candidate) => fits(candidate, label));
  const modelWidth = visibleWidth([type, wt, chosen, ...suffix].filter(Boolean).join(" "));
  const labelWidth = Math.max(1, width - modelWidth - 1);
  const finalLabel = visibleWidth(label) > labelWidth ? truncateToWidth(label, labelWidth) : label;
  return [finalLabel, type, wt, chosen, ...suffix].filter(Boolean).join(" ");
}

// ── M11: workflow pipeline view (pure builders) ─────────────────────────────

/** Braille spinner frames for the active phase chip; the frame index arrives as a parameter so the builder stays pure. */
export const PHASE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Compact arrow separator (visible width 3) — the old ` ━━▶ ` (5) ate too much of narrow chains. */
const PHASE_CHAIN_SEP = " → ";

function phaseChipText(chip: WorkflowPhaseChip, frame: string): string {
  const name = chip.id.replace(/\s+/g, " ").trim() || "?";
  // The fraction is live-only (`settled` counts live settles; replay hits carry
  // no spawn) and replay hits ride along as `↩ N` — the space is mandatory:
  // ↩ is a wide-risk glyph whose digits would overlap it in emoji terminals.
  const counts = chip.spawned > 0 ? ` ${chip.settled}/${chip.spawned}` : "";
  const replay = chip.replayed > 0 ? ` ↩ ${chip.replayed}` : "";
  if (chip.state === "done") return `${chip.failed > 0 ? "✗" : "✓"} ${name}${counts}${replay}`;
  if (chip.state === "active") return `${frame} ${name}${counts}${replay}`;
  // Left behind by the script but children still running: progress, never ✓.
  if (chip.state === "draining") return `▸ ${name}${counts}${replay}`;
  return `○ ${name}`;
}

/**
 * M11: the phase chain line — `✓ done n/n → ⠹ active settled/spawned → ○ pending`,
 * joined by ` → ` (M12: the short arrow). Coloring: done+clean = success,
 * done-with-failures = ✗ crit (the only mandatory tone), pending = muted,
 * active = plain (the moving spinner separates it from the muted tail
 * without another color).
 * Returns undefined when there is no chain to draw (no planned and no entered
 * phase — the header then stays as simple as before M11).
 *
 * Truncation keeps the ACTIVE chip (the "current stage" is the one thing a
 * glance must land on) and grows outward while the line fits; whatever falls
 * off either side collapses to a single `…` chip. Without an active chip
 * (frozen terminal snapshot / never started) the anchor is the last done
 * chip, else the head. `collapsedVisits` (registry visit-cap drops) renders
 * as `…+N` in front — once set, the head marker absorbs the truncated-left
 * chips into its count (both mean "more visits before the window").
 */
export function workflowPhaseChainLine(
  phases: readonly WorkflowPhaseChip[],
  opts: { width?: number; color?: FleetColorize; frame?: number; collapsedVisits?: number } = {},
): string | undefined {
  if (phases.length === 0) return undefined;
  const color = opts.color ?? ((_tone, text) => text);
  const frameIndex = Math.trunc(Math.abs(opts.frame ?? 0)) % PHASE_SPINNER_FRAMES.length;
  const frame = PHASE_SPINNER_FRAMES[frameIndex] ?? PHASE_SPINNER_FRAMES[0]!;
  const width = Math.max(4, opts.width ?? 120);
  const collapsed = Math.max(0, Math.trunc(opts.collapsedVisits ?? 0));
  const texts = phases.map((chip) => {
    const text = phaseChipText(chip, frame);
    if (chip.state === "done") return color(chip.failed > 0 ? "crit" : "success", text);
    if (chip.state === "pending") return color("muted", text);
    return text;
  });
  const widths = texts.map((text) => visibleWidth(text));
  const sepWidth = visibleWidth(PHASE_CHAIN_SEP);
  const activeIdx = phases.findIndex((chip) => chip.state === "active");
  const anchor = activeIdx >= 0 ? activeIdx : phases.some((chip) => chip.state === "done") ? phases.length - 1 : 0;
  const headMarker = (lo: number): string | undefined =>
    collapsed > 0 ? `…+${collapsed + lo}` : lo > 0 ? "…" : undefined;
  const windowFits = (lo: number, hi: number): boolean => {
    let total = 0;
    for (let i = lo; i <= hi; i++) total += widths[i]!;
    total += (hi - lo) * sepWidth;
    const head = headMarker(lo);
    if (head !== undefined) total += sepWidth + visibleWidth(head);
    if (hi < phases.length - 1) total += sepWidth + 1; // `…` chip + separator
    return total <= width;
  };
  let lo = anchor;
  let hi = anchor;
  if (!windowFits(lo, hi)) return truncateToWidth(texts[anchor]!, width);
  // Grow toward the pending side first, fall back to the done side; stop when neither fits.
  for (;;) {
    let grew = false;
    if (hi + 1 < phases.length && windowFits(lo, hi + 1)) {
      hi += 1;
      grew = true;
    } else if (lo - 1 >= 0 && windowFits(lo - 1, hi)) {
      lo -= 1;
      grew = true;
    }
    if (!grew) break;
  }
  const parts: string[] = [];
  const head = headMarker(lo);
  if (head !== undefined) parts.push(head);
  for (let i = lo; i <= hi; i++) parts.push(texts[i]!);
  if (hi < phases.length - 1) parts.push("…");
  return parts.join(PHASE_CHAIN_SEP);
}

/** Terminal icon: explicit failure statuses → ✗; unknown ("terminal") judged by the children's failure count. */
function workflowTerminalIcon(wf: WorkflowGroupInput): "✓" | "✗" {
  const status = wf.terminal?.status;
  if (status === "failed" || status === "timed_out" || status === "aborted") return "✗";
  if (status === "completed") return "✓";
  return wf.failedTotal > 0 ? "✗" : "✓";
}

/** M12: the terminal cause as a plain English token appended to the frozen header (` · timed out`). */
function terminalReasonText(status: string): string | undefined {
  if (status === "timed_out") return "timed out";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  return undefined; // "completed" and unknown statuses add nothing
}

/**
 * workflow-agent-queue §5: a queued call's waiting row — `⧗ label waiting
 * for slot · 15s` — muted (dim), 4-space indent matching the recent-settled
 * rows it precedes. English tokens only (UI-text rule); ⧗ has no
 * emoji-presentation variant (visible width 1 everywhere) and still keeps a
 * space before the label for column consistency with the header's `⧗ N`.
 */
function workflowQueuedLine(child: WorkflowQueuedChildView, width: number, color: FleetColorize): string {
  const prefix = "    ⧗ ";
  const suffix = ` waiting for slot · ${formatDuration(child.waitedMs)}`;
  const label = truncateToWidth(child.label, Math.max(8, width - visibleWidth(prefix) - visibleWidth(suffix)));
  return color("muted", `${prefix}${label}${suffix}`);
}

/**
 * M11: the workflow header — `⚙ name · elapsed / budget · ✓n ✗n ▸n ⧗ N ⚠ N`. The budget
 * segment only appears when a deadline was declared; ✗ is omitted at zero
 * and the whole counts segment stays hidden while nothing has happened yet
 * (✓0 ▸0 is noise). workflow-agent-queue §5 appends `⧗ N` (calls waiting for
 * a maxParallel slot) and `⚠ N` (rejectedTotal + stageErrorTotal) — the
 * space between glyph and digit is MANDATORY: ⚠ has an emoji-presentation
 * variant (WIDE_RISK_GLYPHS) that renders two-wide in many terminals, ⧗ gets
 * the same space for visual consistency. Terminal (frozen) workflows swap ⚙
 * for ✓/✗, render the whole line muted, and (M12) name their cause — ` ·
 * timed out` / ` · aborted` / ` · failed`; `completed` and unknown statuses add
 * nothing. UI-text rule: compact inline markers, English tokens only.
 */
export function workflowHeaderLine(wf: WorkflowGroupInput, color: FleetColorize): string {
  const icon = wf.terminal === undefined ? "⚙" : workflowTerminalIcon(wf);
  const elapsed = formatDuration(wf.elapsedMs);
  const time = wf.budgetMs !== undefined ? `${elapsed} / ${formatDuration(wf.budgetMs)}` : elapsed;
  const warnTotal = (wf.rejectedTotal ?? 0) + (wf.stageErrorTotal ?? 0);
  const queuedTotal = wf.queued?.length ?? 0;
  const counts: string[] = [];
  if (wf.doneTotal > 0) counts.push(`✓${wf.doneTotal}`);
  if (wf.failedTotal > 0) counts.push(`✗${wf.failedTotal}`);
  if (wf.activeTotal > 0) counts.push(`▸${wf.activeTotal}`);
  if (queuedTotal > 0) counts.push(`⧗ ${queuedTotal}`);
  if (warnTotal > 0) counts.push(`⚠ ${warnTotal}`);
  const segments = [wf.name, time];
  // Stage B: grace / extension marker, same format as the run row's deadline
  // field. Headers never consume the line budget, so it is never dropped.
  if (wf.deadline !== undefined && wf.terminal === undefined) {
    segments.push(deadlineMarker(wf.deadline.remainingMs, wf.deadline.extensions, wf.deadline.inGrace));
  }
  const countsText = counts.join(" ");
  if (countsText !== "") segments.push(countsText);
  if (wf.terminal !== undefined) {
    const reason = terminalReasonText(wf.terminal.status);
    if (reason !== undefined) segments.push(reason);
  }
  return color(wf.terminal === undefined ? "header" : "muted", `${icon} ${segments.join(" · ")}`);
}

/**
 * M11: registry snapshot → WorkflowGroupInput. Elapsed freezes at
 * `terminal.endedAt` for lingering workflows (a frozen pipeline must not keep
 * ticking); the recent-children window reuses the widget's terminalLingerMs so
 * the ✓/✗ rows fade on the same clock as the freeze itself.
 * workflow-agent-queue §5: queued children map with `label ?? agentType ??
 * callId` and their wait time measured against the same frozen clock (the
 * engine settles every queued call before unregistering, so a frozen snapshot
 * carries an empty queue — the frozen clock is defensive only).
 */
export function workflowGroupInput(snap: WorkflowActivitySnapshot, now: number, lingerMs: number): WorkflowGroupInput {
  const asOf = snap.terminal?.endedAt ?? now;
  return {
    workflowId: snap.workflowId,
    name: snap.name,
    elapsedMs: Math.max(0, asOf - snap.startedAt),
    ...(snap.deadlineAt !== undefined && snap.deadlineAt > snap.startedAt
      ? { budgetMs: snap.deadlineAt - snap.startedAt }
      : {}),
    phases: [...snap.phases],
    ...(snap.collapsedVisits !== undefined && snap.collapsedVisits > 0
      ? { collapsedVisits: snap.collapsedVisits }
      : {}),
    doneTotal: snap.completedTotal,
    failedTotal: Math.max(0, snap.settledTotal - snap.completedTotal),
    activeTotal: snap.activeChildren.length,
    queued: snap.queuedChildren.map((child) => ({
      label: child.label ?? child.agentType ?? child.callId,
      waitedMs: Math.max(0, asOf - child.queuedAt),
    })),
    rejectedTotal: snap.rejectedTotal,
    stageErrorTotal: snap.stageErrorTotal,
    recentSettled: snap.settledChildren
      .filter((child) => now - child.settledAt <= lingerMs)
      .map((child) => ({
        label: child.label ?? child.callId,
        ok: child.status === "completed",
        durationMs: child.durationMs,
        source: child.source,
      })),
    ...(snap.terminal !== undefined ? { terminal: { status: snap.terminal.status } } : {}),
    ...workflowDeadlineInput(snap, now),
  };
}

/** Stage B: the header deadline marker input — only inside grace or once extended, never on a frozen snapshot. */
function workflowDeadlineInput(snap: WorkflowActivitySnapshot, now: number): Pick<WorkflowGroupInput, "deadline"> {
  if (snap.terminal !== undefined) return {};
  const extensions = snap.extensions ?? 0;
  const inGrace = snap.graceUntil !== undefined;
  if (!inGrace && extensions === 0) return {};
  const effective = snap.graceUntil ?? snap.deadlineAt;
  if (effective === undefined) return {};
  return { deadline: { remainingMs: Math.max(0, effective - now), extensions, inGrace } };
}

/** M-C: order active rows as a forest — severity-ordered roots, each followed by its children (depth-first). */
export function treeOrder(rows: readonly FleetRow[]): Array<{ row: FleetRow; depth: number }> {
  const present = new Set(rows.map((r) => r.runId));
  const children = new Map<string, FleetRow[]>();
  const roots: FleetRow[] = [];
  for (const row of rows) {
    if (row.parentRunId !== undefined && present.has(row.parentRunId)) {
      const list = children.get(row.parentRunId) ?? [];
      list.push(row);
      children.set(row.parentRunId, list);
    } else roots.push(row);
  }
  const out: Array<{ row: FleetRow; depth: number }> = [];
  const visit = (row: FleetRow, depth: number) => {
    out.push({ row, depth });
    for (const child of children.get(row.runId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/** M10 (revised): warn/crit rows tint ONLY the mark (`!`/`✗`) and the label with the
 *  tone color; every other segment keeps the calm-row palette (meta muted, in-flight ▸
 *  accent). The previous whole-line tone wrap ("visibility beats prettiness") was
 *  dropped: half-idle warn fires on healthy-but-quiet runs (a minutes-long silent
 *  bash), and the whole-line yellow erased all segment colors, making a routine
 *  state look like an alarm. mark+label remain the loudest elements on the line,
 *  so the highlight stays unmissable without any SGR nesting. Returns 1–2 lines:
 *  the main row plus, when the run is mid-tool / mid-thought, an indented
 *  activity continuation hung on a ╰ hook under the row's label (↳ replaced by space). */
function renderRunLines(row: FleetRow, indent: string, color: FleetColorize, width: number): string[] {
  // ╰ hook sits directly under the row's label (mark column + space + indent),
  // so the continuation reads as hanging from the task name itself — without
  // it a bright trail line reads as the next agent's row.
  const pad = `  ${indent.replace(/↳/g, " ")}╰ `;
  const mark = WIDGET_MARK[row.highlight];
  const markText = row.highlight === "none" ? mark : color(row.highlight, mark);
  const prefixWidth = visibleWidth(`${mark} ${indent}`);
  const labelTone = row.highlight === "none" ? undefined : row.highlight;
  const main = `${markText} ${indent}${widgetRowMain(row, Math.max(1, width - prefixWidth), color, labelTone)}`;
  const activity = widgetRowActivity(row, color);
  return activity ? [main, `${pad}${activity}`] : [main];
}

function widgetBashRowMain(row: BashJobViewInput, color: FleetColorize): string {
  const meta = `$ ${row.commandPreview} · ${row.status} · ${formatDuration(row.elapsedMs)} · log ${formatLogSize(row.logBytes)}`;
  return row.highlight === "none" ? `  ${meta}` : color(row.highlight, `${WIDGET_MARK[row.highlight]} ${meta}`);
}

function widgetBashRowActivity(row: BashJobViewInput, color: FleetColorize): string | undefined {
  return row.logTail === undefined ? undefined : `  ╰ ${color("muted", `» ${row.logTail}`)}`;
}

function widgetBashTerminalDetail(row: BashJobViewInput): string {
  return `$ ${row.commandPreview} · ${row.status} · ${formatDuration(row.elapsedMs)} · log ${formatLogSize(row.logBytes)}`;
}

/**
 * Build the agent-tree widget lines from the (shared) fleet view model.
 *
 * - Returns undefined when no runs or background bash jobs are visible.
 * - Line 1 (header): `<bullet> N active Agents[ · M bash][ · $cost][ · +M more]` —
 *   the bullet remains the worst active run highlight; bash does not affect it.
 * - Lines 2..: runs in tree order — mark (! warn / ✗ crit), depth indent,
 *   `↳` for nested rows. Each run takes 1–2 lines: the main row (label /
 *   type / model / phase / phase age / Σ total elapsed / cost) plus, when mid-tool or
 *   mid-thought, an indented activity line (tool trail with in-flight
 *   ▸tool + args preview, and/or the » thinking stream) so long tool calls
 *   render in full instead of being truncated off the row. maxRows is a
 *   LINE budget: main rows are dealt out first (every visible run keeps its
 *   identity line), then the leftover lines go to activity continuations in
 *   display order — greedy 2-lines-per-run allocation starved the LAST
 *   visible run of its tool trail whenever N busy runs didn't fit an even
 *   budget.
 */
export function buildFleetWidgetLines(
  model: FleetViewModel,
  opts: FleetWidgetRenderOptions = {},
): string[] | undefined {
  const color: FleetColorize = opts.color ?? ((_tone, text) => text);
  const width = Math.max(20, opts.width ?? 120);
  const maxRows = Math.min(WIDGET_MAX_ROWS, Math.max(1, opts.maxRows ?? WIDGET_DEFAULT_ROWS));
  const lingerMs = opts.terminalLingerMs ?? 5000;
  const awaitMs = opts.awaitNotificationMs ?? 600_000;
  const receiptOf = opts.receiptOf ?? (() => ({ kind: "untracked" as const }));
  // Notes are single-line display text: fold whitespace like the panel's taskPreview does.
  const rawMentionNoteOf = opts.mentionNoteOf ?? (() => undefined);
  const mentionNoteOf = (runId: string) => rawMentionNoteOf(runId)?.replace(/\s+/g, " ").trim() || undefined;
  const workflows = (opts.workflows ?? []).slice(0, 3);
  const bashJobs = opts.bashJobs ?? [];
  const activeRows = model.rows.filter((r) => !r.terminal);
  const activeBash = bashJobs.filter((job) => !isTerminalJobStatus(job.status));
  const recentBash = bashJobs.filter(
    (job) => isTerminalJobStatus(job.status) && job.settledAgoMs !== undefined && job.settledAgoMs <= lingerMs,
  );
  const visibleBash = [...activeBash, ...recentBash];
  // M6: just-finished runs linger dimmed for a few seconds so a completion is
  // perceivable instead of vanishing between two ticks.
  const terminalRows = model.rows.filter((r) => r.terminal);
  const awaitingTerminal = terminalRows.filter((r) => {
    const receipt = receiptOf(r.runId);
    return receipt.kind === "pending" && (r.settledAgoMs ?? Infinity) <= awaitMs;
  });
  const recentTerminal = terminalRows.filter((r) => {
    const receipt = receiptOf(r.runId);
    if (receipt.kind === "pending") return false;
    const age =
      receipt.kind === "entered" &&
      receipt.at !== undefined &&
      r.settledAt !== undefined &&
      r.settledAgoMs !== undefined
        ? Math.max(0, r.settledAt + r.settledAgoMs - receipt.at)
        : r.settledAgoMs;
    return age !== undefined && age <= lingerMs;
  });
  if (
    model.activeCount === 0 &&
    awaitingTerminal.length === 0 &&
    recentTerminal.length === 0 &&
    workflows.length === 0 &&
    visibleBash.length === 0
  )
    return undefined;
  const worst = activeRows[0]?.highlight ?? "none";
  // M9: workflow children (parentRunId === workflowId) are claimed by their
  // workflow's ⚙ group; everything else goes through the regular run tree.
  const workflowIds = new Set(workflows.map((w) => w.workflowId));
  const grouped = new Map<string, FleetRow[]>();
  const general: FleetRow[] = [];
  for (const row of activeRows) {
    if (row.parentRunId !== undefined && workflowIds.has(row.parentRunId)) {
      const list = grouped.get(row.parentRunId) ?? [];
      list.push(row);
      grouped.set(row.parentRunId, list);
    } else general.push(row);
  }
  const activeCost = activeRows.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
  // Ordered entries: workflow ⚙ group headers (plus their free phase-chain
  // line, dim queued waiting rows and lingering just-settled child rows)
  // interleaved with their claimed runs, then the general run forest. ⚙
  // headers and chain lines don't consume the line budget; queued rows draw
  // from the identity budget (they hold a slot in the script's future), while
  // just-settled child rows draw from the leftover budget so they can never
  // crowd out a run's identity row.
  type Entry =
    | { header: string }
    | { settled: string }
    | { queued: string }
    | { row: FleetRow; indent: string }
    | { bash: BashJobViewInput }
    | { awaiting: FleetRow };
  const entries: Entry[] = [];
  for (const wf of workflows) {
    entries.push({ header: workflowHeaderLine(wf, color) });
    const chain =
      wf.phases === undefined
        ? undefined
        : workflowPhaseChainLine(wf.phases, {
            width: Math.max(6, width - 2),
            color,
            ...(opts.frame !== undefined ? { frame: opts.frame } : {}),
            ...(wf.collapsedVisits !== undefined ? { collapsedVisits: wf.collapsedVisits } : {}),
          });
    if (chain !== undefined) entries.push({ header: `  ${chain}` });
    for (const row of grouped.get(wf.workflowId) ?? []) entries.push({ row, indent: "↳ " });
    for (const child of wf.queued ?? []) entries.push({ queued: workflowQueuedLine(child, width, color) });
    for (const child of wf.recentSettled ?? []) {
      const label = truncateToWidth(child.label, Math.max(8, width - 16));
      entries.push({
        settled:
          child.source === "replay"
            ? color("muted", `    ↩ ${label} replay`) // journal hit: no ✓/✗, no fake duration
            : color("muted", `    ${child.ok ? "✓" : "✗"} ${label} ${formatDuration(child.durationMs)}`),
      });
    }
  }
  for (const { row, depth } of treeOrder(general)) {
    const indent = depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : row.nested ? "↳ " : "";
    entries.push({ row, indent });
  }
  // M3: bash main rows join the same pool as run identities. This deliberately
  // lets bash be hidden only after the same maxRows worth of runs, preserving
  // one simple budget and truthful "+N more" accounting.
  for (const bash of activeBash) entries.push({ bash });
  // Awaiting terminal identities are allocated with active identities so their
  // prompt context cannot be separated from the row it describes.
  for (const row of awaitingTerminal) entries.push({ awaiting: row });
  // Fair line budget: deal every run its main row first, then hand the
  // leftover lines to activity continuations in display order. (Greedy
  // 2-lines-per-run allocation starved the LAST visible run of its tool
  // trail whenever N busy runs didn't fit an even budget.)
  let budget = maxRows;
  let shownRuns = 0;
  const rendered = entries.map((entry) => {
    if ("header" in entry) return { main: entry.header, activity: undefined as string | undefined, show: false };
    // Just-settled workflow children: no identity row of their own — their
    // single line lives in the leftover budget (same pool as activity
    // continuations, display order preserved).
    if ("settled" in entry) return { main: undefined, activity: entry.settled, show: false };
    // workflow-agent-queue §5: queued calls are in-flight identities (they
    // hold a slot in the script's future) — main-row budget, same pool as run
    // identities; overflow joins the "+N more" count below.
    if ("queued" in entry) {
      if (budget <= 0) return undefined; // queued identity hidden behind "+N more"
      budget -= 1;
      shownRuns += 1;
      return { main: entry.queued, activity: undefined as string | undefined, show: false };
    }
    if (budget <= 0) return undefined; // identity hidden behind "+N more"
    const rendered =
      "bash" in entry
        ? { main: widgetBashRowMain(entry.bash, color), activity: widgetBashRowActivity(entry.bash, color) }
        : "awaiting" in entry
          ? {
              main: color(
                "muted",
                `${entry.awaiting.status === "completed" ? "✓" : "✗"} ${widgetTerminalDetail(entry.awaiting, width)} · 待处理`,
              ),
              // X6b: awaiting entries preview ONLY the user's @ message; dispatch prompts are never shown.
              activity: (() => {
                const note = mentionNoteOf(entry.awaiting.runId);
                return note === undefined
                  ? undefined
                  : color("muted", `╰ @ » ${truncateToWidth(note, Math.max(1, width - 6))}`);
              })(),
              mention: undefined,
            }
          : (() => {
              const [main, activity] = renderRunLines(entry.row, entry.indent, color, width);
              const note = mentionNoteOf(entry.row.runId);
              const pad = `  ${entry.indent.replace(/↳/g, " ")}╰ `;
              const mention =
                note === undefined
                  ? undefined
                  : color("muted", `${pad}@ » ${truncateToWidth(note, Math.max(1, width - visibleWidth(pad) - 4))}`);
              return { main: main!, activity, mention };
            })();
    budget -= 1;
    shownRuns++;
    return { ...rendered, show: false };
  });
  for (const r of rendered) {
    if (budget <= 0) break;
    if (r?.activity !== undefined && !r.show) {
      r.show = true;
      budget -= 1;
    }
  }
  const lines: string[] = [];
  const latestAwaiting = awaitingTerminal[0]?.runId;
  let expandedAwaiting = false;
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    if (!r) continue;
    if (r.main !== undefined) lines.push(r.main);
    if (r.show && r.activity !== undefined) {
      const entry = entries[i];
      const awaitingNote = entry !== undefined && "awaiting" in entry ? mentionNoteOf(entry.awaiting.runId) : undefined;
      if (
        !expandedAwaiting &&
        entry !== undefined &&
        "awaiting" in entry &&
        entry.awaiting.runId === latestAwaiting &&
        awaitingNote !== undefined
      ) {
        const wrapped = wrapTextWithAnsi(awaitingNote, Math.max(1, width - 6)).slice(0, Math.min(4, budget + 1));
        lines.push(...wrapped.map((line) => color("muted", `╰ @ » ${line}`)));
        budget -= Math.max(0, wrapped.length - 1);
        expandedAwaiting = true;
      } else {
        lines.push(r.activity);
      }
    }
    // X6b: the user's latest @ message hangs one line below the tool trail.
    if (
      r !== undefined &&
      "mention" in r &&
      r.mention !== undefined &&
      budget > 0 &&
      (r.show || r.activity === undefined)
    ) {
      lines.push(r.mention);
      budget -= 1;
    }
  }
  // M4: only active identities contribute to hidden; workflow headers and
  // terminal linger rows are transient and intentionally excluded. Workflow
  // children count through model.activeCount; queued calls (§5) are
  // identities without a run row, so they join both totals explicitly.
  // Awaiting mains live in the same shownRuns pool, so they join the identity
  // total rather than being adjusted for separately (which would double-count them).
  const queuedTotal = workflows.reduce((sum, wf) => sum + (wf.queued?.length ?? 0), 0);
  const hidden = model.activeCount + activeBash.length + awaitingTerminal.length + queuedTotal - shownRuns;
  const header =
    `${color(worst, "●")} ${model.activeCount} active Agents` +
    (activeBash.length > 0 ? ` · ${activeBash.length} bash` : "") +
    (activeCost > 0 ? ` · ${formatWidgetCost(activeCost)}` : "") +
    (awaitingTerminal.length > 0 ? ` · ${awaitingTerminal.length} 待处理` : "") +
    (hidden > 0 ? ` · +${hidden} more` : "");
  lines.unshift(
    model.activeCount === 0 && activeBash.length > 0 && awaitingTerminal.length === 0
      ? `${color("none", "●")} ${activeBash.length} background bash${hidden > 0 ? ` · +${hidden} more` : ""}`
      : header,
  );
  // M6/F1: lingering rows are lowest priority and use only the remaining budget.
  for (const row of recentTerminal) {
    if (budget <= 0) break;
    const mark = row.status === "completed" ? "✓" : "✗";
    lines.push(color("muted", `${mark} ${widgetTerminalDetail(row, width - visibleWidth(`${mark} `))}`));
    budget -= 1;
  }
  for (const row of recentBash) {
    if (budget <= 0) break;
    const tone = row.highlight;
    const mark = tone === "crit" ? "✗" : tone === "warn" ? "!" : "✓";
    lines.push(color(tone === "none" ? "muted" : tone, `${mark} ${widgetBashTerminalDetail(row)}`));
    budget -= 1;
    if (row.logTail !== undefined && budget > 0) {
      lines.push(color("muted", `  ╰ » ${row.logTail}`));
      budget -= 1;
    }
  }
  return lines;
}

// ── Controller ──

/** Minimal probed slice of ExtensionUIContext; setWidget is `unknown` because non-interactive modes may drop it. */
export interface FleetWidgetHost {
  setWidget?: unknown;
}
type SetWidgetFn = (
  key: string,
  content: string[] | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

export interface FleetWidgetDeps {
  query: QueryService;
  /** ctx.ui (probed, never trusted): missing setWidget → inert controller, no timer, no throw. */
  ui?: FleetWidgetHost;
  /** Master switch (settings.fleetWidget). Default true. */
  enabled?: boolean;
  clock?: Clock;
  /** Refresh tick. Default 1000ms, same cadence as the panel. */
  refreshMs?: Millis;
  /** settings.budget.idleMs — same half-idle warn semantics as the panel. */
  idleBudgetMs?: Millis;
  /** settings.fleetDeadlineWarnMs — runs within this of their deadline turn warn. 0/undefined disables. */
  deadlineWarnMs?: Millis;
  /** Line budget for run lines below the header. Default WIDGET_DEFAULT_ROWS (6); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** M9/M11: workflow snapshots (WorkflowActivityRegistry.listForDisplay — running plus frozen terminal linger) for ⚙ pipeline group headers. */
  workflows?: () => readonly WorkflowActivitySnapshot[];
  /** D1: live in-memory bash job records; fs access remains in the stack adapter. */
  bashJobs?: () => readonly JobRecord[];
  /** D2: stack-bound two-pass tail reader, including the observed file size. */
  readBashTail?: (
    record: JobRecord,
    sizeHint?: number,
  ) => Promise<{ text: string | undefined; logBytes: number } | undefined>;
  typeOf?: (runId: RunId) => string | undefined;
  color?: FleetColorize;
  /** Receipt lookup for terminal notification visibility. */
  receiptOf?: (runId: string) => ContextReceipt;
  /** X6b: latest raw user @ message per run. */
  mentionNoteOf?: (runId: string) => string | undefined;
  terminalLingerMs?: number;
  awaitNotificationMs?: number;
  pruneReceipts?: (keepRunIds: ReadonlySet<string>, now: number) => void;
}

export class FleetWidgetController {
  private readonly clock: Clock;
  private readonly setWidget: SetWidgetFn | undefined;
  private timer: TimerHandle | undefined;
  private disposed = false;
  /** Sticky: one setWidget throw (degenerate non-interactive host) disables the widget silently. */
  private uiDead = false;
  /** Sticky: refresh() failures are reported once — the 1Hz tick keeps running. */
  private warnedRefreshFailure = false;
  /** H1 observer; merge into the session's SubagentExtensionPoints fan-out. */
  readonly lifecycle: SubagentExtensionPoints;
  /** D2: cache is controller-owned because renderFrame must stay synchronous. */
  private readonly bashTailCache = new Map<string, { text: string; observedSize: number; terminal: boolean }>();
  private readonly bashTailInflight = new Set<string>();
  private readonly tailFailures = new Map<string, Millis>();

  constructor(private readonly deps: FleetWidgetDeps) {
    this.clock = deps.clock ?? systemClock;
    const candidate = deps.ui?.setWidget;
    this.setWidget = typeof candidate === "function" ? (candidate as SetWidgetFn).bind(deps.ui) : undefined;
    this.lifecycle = { onLifecycle: () => this.refresh() };
    if (!this.live) return; // inert: disabled or no setWidget capability
    this.refresh();
    if (!this.live) return; // initial push already hit a degenerate host — stay inert, no tick
    const refreshMs = deps.refreshMs ?? 1000;
    const tick = () => {
      if (!this.live) return;
      try {
        this.refresh();
      } finally {
        // Unconditional re-arm. This is a self-rescheduling ONE-SHOT timer, not
        // a setInterval: a skipped setTimer is not a dropped frame but a
        // permanently stopped clock (the agent tree would freeze for the rest
        // of the session, recoverable only by a /reload-driven stack rebuild).
        // `live` — not `!disposed` — is the correct guard: push() sets uiDead +
        // stopTimer() as its deliberate give-up path for a degenerate host, and
        // re-arming there would resurrect a zombie 1Hz tick that only ever
        // early-returns out of refresh().
        if (this.live) this.timer = this.clock.setTimer(refreshMs, tick);
      }
    };
    this.timer = this.clock.setTimer(refreshMs, tick);
  }

  private get live(): boolean {
    return !this.disposed && !this.uiDead && this.setWidget !== undefined && this.deps.enabled !== false;
  }

  /**
   * Re-pull the view model and push lines (or hide). A view-model/render
   * failure is swallowed here (frame dropped, warned once) rather than
   * propagated, because refresh() has three callers with very different blast
   * radii:
   *  - the constructor, running inside buildSessionStack → a throw escapes the
   *    session_start handler before `holder.current = stack` is assigned and
   *    kills the whole extension for that session (every Agent call then fails
   *    with "no active session yet"). This is the worst one.
   *  - the 1Hz tick → see the re-arm note in the constructor.
   *  - the H1 onLifecycle sink wired in stack.ts → defense in depth only;
   *    mergeExtensionPoints already catches and WARNs throws on that path.
   * Dropping a frame is always safe: the widget holds no incremental state, so
   * the next tick rebuilds it from scratch.
   */
  refresh(): void {
    if (!this.live) return;
    try {
      this.renderFrame();
    } catch (error) {
      // Warn-once: a 1Hz tick would otherwise spam the TUI with the same line.
      if (!this.warnedRefreshFailure) {
        this.warnedRefreshFailure = true;
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-subagent] fleet widget refresh failed (frame dropped, tick continues): ${detail}`);
      }
    }
  }

  /** Unguarded refresh core — never call directly, always go through refresh(). */
  private renderFrame(): void {
    const now = this.clock.now();
    const bashRecords = this.deps.bashJobs?.() ?? [];
    const bashViews = this.bashJobViews(bashRecords, now);
    this.prefetchBashTails(bashRecords);
    const model = buildFleetViewModel(this.deps.query.list(), {
      now,
      recentTerminal: 3, // M6: feed just-finished runs so the builder can linger them briefly
      maxActiveRows: Math.min(WIDGET_MAX_ROWS, Math.max(1, this.deps.maxRows ?? WIDGET_DEFAULT_ROWS)),
      ...(this.deps.idleBudgetMs !== undefined ? { idleBudgetMs: this.deps.idleBudgetMs } : {}),
      ...(this.deps.deadlineWarnMs !== undefined ? { deadlineWarnMs: this.deps.deadlineWarnMs } : {}),
      ...(this.deps.typeOf ? { typeOf: this.deps.typeOf } : {}),
      ...(this.deps.receiptOf
        ? {
            retainTerminal: (snapshot: import("../core/types.js").RunSnapshot) => {
              const receipt = this.deps.receiptOf!(snapshot.runId);
              return (
                receipt.kind === "pending" && now - snapshot.updatedAt <= (this.deps.awaitNotificationMs ?? 600_000)
              );
            },
          }
        : {}),
    });
    this.deps.pruneReceipts?.(new Set(this.deps.query.list().map((run) => run.runId)), now);
    const lines = buildFleetWidgetLines(model, {
      width: this.widgetWidth(),
      ...(this.deps.maxRows !== undefined ? { maxRows: this.deps.maxRows } : {}),
      ...(this.deps.terminalLingerMs !== undefined ? { terminalLingerMs: this.deps.terminalLingerMs } : {}),
      ...(this.deps.awaitNotificationMs !== undefined ? { awaitNotificationMs: this.deps.awaitNotificationMs } : {}),
      ...(this.deps.receiptOf ? { receiptOf: this.deps.receiptOf } : {}),
      ...(this.deps.mentionNoteOf ? { mentionNoteOf: this.deps.mentionNoteOf } : {}),
      ...(this.deps.color ? { color: this.deps.color } : {}),
      // M11: the active phase chip spins one frame per tick; the recent-children
      // window shares the builder's linger so rows fade on the same clock as
      // the terminal freeze.
      frame: Math.floor(now / Math.max(120, this.deps.refreshMs ?? 1000)),
      ...(this.deps.workflows
        ? {
            workflows: this.deps.workflows().map((w) => workflowGroupInput(w, now, this.deps.terminalLingerMs ?? 5000)),
          }
        : {}),
      ...(this.deps.bashJobs ? { bashJobs: bashViews } : {}),
    });
    this.push(lines);
  }

  private bashJobViews(records: readonly JobRecord[], now: number): BashJobViewInput[] {
    const visible = records.filter((record) => record.backgroundedAt !== undefined);
    const ids = new Set(visible.map((record) => record.jobId));
    // Each session rebuild owns this cache; pruning every frame also handles
    // retention sweeps without allowing job ids to accumulate indefinitely.
    for (const id of this.bashTailCache.keys()) if (!ids.has(id)) this.bashTailCache.delete(id);
    for (const id of this.bashTailInflight) if (!ids.has(id)) this.bashTailInflight.delete(id);
    for (const id of this.tailFailures.keys()) if (!ids.has(id)) this.tailFailures.delete(id);
    return visible.map((record) => {
      const terminal = isTerminalJobStatus(record.status);
      const cache = this.bashTailCache.get(record.jobId);
      const elapsedMs = Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
      const view: BashJobViewInput = {
        jobId: record.jobId,
        commandPreview: previewCommand(record.command, 80),
        status: record.status,
        highlight: terminal ? bashJobHighlight(record.status) : "none",
        elapsedMs,
        logBytes: record.logBytes,
        ...(cache?.text !== undefined && tailLine(cache.text) !== undefined ? { logTail: tailLine(cache.text)! } : {}),
        ...(terminal && record.endedAt !== undefined ? { settledAgoMs: Math.max(0, now - record.endedAt) } : {}),
      };
      return view;
    });
  }

  private prefetchBashTails(records: readonly JobRecord[]): void {
    const readTail = this.deps.readBashTail;
    if (!readTail || this.disposed) return;
    for (const record of records) {
      if (record.backgroundedAt === undefined || this.bashTailInflight.has(record.jobId)) continue;
      const terminal = isTerminalJobStatus(record.status);
      const cache = this.bashTailCache.get(record.jobId);
      // Running jobs deliberately reread every tick: adopted records do not
      // refresh logBytes during liveness polling, so record-only invalidation
      // would freeze their activity forever. Terminal rows freeze after one read.
      if (terminal && cache?.terminal) continue;
      const failedAt = this.tailFailures.get(record.jobId);
      if (failedAt !== undefined && this.clock.now() - failedAt < 5000) continue;
      this.bashTailInflight.add(record.jobId);
      const hint = Math.max(record.logBytes, cache?.observedSize ?? 0);
      void readTail(record, hint)
        .then((result) => {
          const text = result?.text;
          const fallback = text === undefined ? record.finalText : undefined;
          const value = text ?? fallback;
          const observedSize = result?.logBytes ?? hint;
          if (value !== undefined) {
            this.bashTailCache.set(record.jobId, { text: value, observedSize, terminal });
          } else if (terminal) {
            this.bashTailCache.set(record.jobId, { text: "", observedSize, terminal: true });
          }
          this.tailFailures.delete(record.jobId);
        })
        .catch(() => {
          // Log retention races are expected; suppress them and back off so a
          // long-lived missing log cannot generate one rejected read per tick.
          this.tailFailures.set(record.jobId, this.clock.now());
          if (terminal) {
            const fallback = tailLine(record.finalText);
            this.bashTailCache.set(record.jobId, { text: fallback ?? "", observedSize: hint, terminal: true });
          }
        })
        .finally(() => this.bashTailInflight.delete(record.jobId));
    }
  }

  private push(lines: string[] | undefined): void {
    try {
      // M-C fix: setWidget lines are plain strings — a long label + tool trail
      // would wrap and grow the widget by extra lines. Truncate to the live
      // terminal width (ANSI-safe), falling back to a conservative 120 cols.
      //
      // Flicker fix: pi renders each widget string as `new Text(line, /*paddingX*/ 1, 0)`,
      // so the wrap threshold is terminal columns − 2 (1 col of padding each
      // side), NOT columns − 1. Truncating to columns − 1 left every max-width
      // line exactly 1 col past the threshold: it wrapped onto a dangling
      // second line, and as live durations/trails changed width each 1Hz tick
      // the wrap toggled on/off → widget height oscillated → every line below
      // (editor, footer) reflowed every second — the "agent tree flicker".
      const width = this.widgetWidth();
      // Main run rows are assembled to width; only live activity continuations
      // retain truncation because their stream/tool content is intentionally unbounded.
      const truncated = lines?.map((line) => truncateToWidth(line, width));
      this.setWidget!(FLEET_WIDGET_KEY, truncated, { placement: "aboveEditor" });
    } catch {
      // Non-interactive/degenerate host: go inert silently (never throw out of a UI observer).
      this.uiDead = true;
      this.stopTimer();
    }
  }

  private widgetWidth(): number {
    return Math.max(20, (process.stdout?.columns ?? 120) - 2);
  }

  private stopTimer(): void {
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Stop the tick and clear the widget. Idempotent; called on session rebuild before the new stack's widget mounts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    if (this.setWidget && !this.uiDead) {
      try {
        this.setWidget(FLEET_WIDGET_KEY, undefined);
      } catch {
        /* host already gone — nothing to clear */
      }
    }
  }
}
