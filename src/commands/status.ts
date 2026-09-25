import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot, UsageDelta } from "../core/types.js";
import { displayAgentType } from "../core/types.js";
import {
  SETTING_SPECS,
  currentOf,
  defaultOf,
  formatSettingValue,
  isKnownSettingKey,
  isOverridden,
  parseSettingValue,
  resetSetting,
  settingKeys,
  writeSetting,
  type SettingsStore,
} from "../config/setting-specs.js";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import { formatDuration, formatModelRef } from "../ui/fleet-panel.js";
import { isTerminalJobStatus, previewCommand, type JobRecord } from "../bash/types.js";
import { describeJobStatus } from "../tools/bash-job-tool.js";
import type { MentionAutocompleteEntry } from "../mention/autocomplete.js";
import { canOpenSettingsEditor, openSettingsEditor } from "../ui/settings-editor.js";
import { countActiveRuns } from "../reload/defer.js";
import type { DynamicStatusView } from "../compact-hint/dynamic/wire.js";
import { effectiveThresholdPercentWithTokens, windowScaledForcePercent } from "../compact-hint/threshold.js";
import { resolveEffectiveHint } from "../compact-hint/dynamic/threshold.js";

/** Live settings object + persistence port (see config/setting-specs.ts). */
export type SettingsCommandDeps = SettingsStore;

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  /** Model-facing exact/prefix/label matcher shared with the tools. */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** M3.6: in-flight workflow rows for `/agent status`'s own WORKFLOWS section. */
  workflow?: { activity: { list(): readonly WorkflowActivitySnapshot[] }; now?: () => number };
  /**
   * bash auto-background §7: backgrounded bash jobs for the `bash jobs`
   * section and `/agent status <b_…>`. Absent (or empty) ⇒ nothing rendered,
   * so hosts without the feature see the previous output byte-for-byte.
   */
  bashJobs?: { list(): readonly JobRecord[] };
  /** `/agent status` and editor mention discovery share the live root-child view. */
  mention?: { entries(): readonly MentionAutocompleteEntry[] };
  /** `/agent settings` (+ `/agent budget` alias) — absent only in tests/minimal hosts. */
  settings?: SettingsCommandDeps;
  /**
   * Deferred /reload controller (src/reload/): `/agent reload` parks the
   * reload while runs are active and the controller fires once they settle.
   * Absent ⇒ the reload subcommand degrades to a hint to use built-in /reload.
   */
  reload?: { arm(activeCount: number): void; disarm(): void; readonly pending: boolean };
  /**
   * compact-hint 动态阈值（dynamic-threshold-plan.md §10.3，P1-11）：只读端口。
   * 缺席（mode=off / 惰性 runtime / 旧宿主）⇒ 输出与今天**逐字节相同**。
   * `facts()` 补齐渲染第 1 行所需的静态事实（force 锚点/reserve）——方案 §10.3 的
   * DynamicStatusView 没有这些字段但渲染行需要（方案矛盾处的保守处置，见施工报告）。
   */
  dynamic?: {
    view(): DynamicStatusView | undefined;
    facts?():
      | {
          /** Static hint lines (percent + absolute-k), so line 1 can show the line that actually fires. */
          thresholdPercent?: number;
          thresholdTokens?: number;
          forceAtPercent: number;
          forceAtTokens: number;
          forceScaling: boolean;
          reserveTokens: number;
        }
      | undefined;
  };
}

/**
 * `/agent status` - G4 diagnosability surface: for every non-terminal run,
 * shows which phase it's stuck in, when the last driver event landed, what
 * tool (if any) is currently executing, and the escalation trail if it's
 * stopping; plus the orphan/delivery counters that back the zero-tolerance
 * monitors in architecture section 9.6.
 */
export function createStatusCommand(deps: StatusCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "Show diagnostics for running and recently finished subagents (phase, last event, orphans). `/agent status <runId>` shows one run's tool timeline; `/agent costs` per-run spend; `/agent settings` opens an interactive settings editor (`settings list` / `set <key> <value>` / `reset <key>` stay available for scripts; budget.* applies to new runs immediately, the rest after /reload). `/agent reload` reloads pi, deferred until running subagents settle (`reload now` forces, `reload cancel` cancels). Durations are configured in seconds. The live agent tree is pinned above the editor while runs are active.",
    getArgumentCompletions: (argumentPrefix: string) => {
      const settingsAction = argumentPrefix.trimStart().match(/^(settings|budget)\s+(set|reset)\s+(\S*)$/);
      if (settingsAction) {
        const [, scope, action, partial = ""] = settingsAction;
        return settingKeys(scope === "budget")
          .filter((k) => k.startsWith(scope === "budget" ? `budget.${partial}` : partial))
          .map((k) => ({
            value: scope === "budget" ? `budget ${action} ${k.slice("budget.".length)}` : `settings ${action} ${k}`,
            label: k,
            description: `default ${formatSettingValue(defaultOf(SETTING_SPECS[k]!))}`,
          }));
      }
      return [
        { value: "status", label: "status", description: "Text diagnostics (default)" },
        { value: "costs", label: "costs", description: "Per-run cost breakdown" },
        { value: "settings", label: "settings", description: "Interactive settings editor (or set/reset/list)" },
        { value: "budget", label: "budget", description: "Alias: settings scoped to budget.*" },
        { value: "reload", label: "reload", description: "Reload pi, deferred until subagents settle (now/cancel)" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim()));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];
      if (sub === "fleet") {
        // Removed overlay panel — point old muscle memory at the replacements.
        ctx.ui.notify(
          "The `/agent fleet` overlay panel was removed. The live agent tree is always pinned above the editor while runs are active; use `/agent status`, `/agent status <runId>` or `/agent costs` for details.",
          "info",
        );
        return;
      }
      if (sub === "costs") {
        ctx.ui.notify(renderCosts(deps.query), "info");
        return;
      }
      if (sub === "reload") {
        await handleReload(deps, tokens[1], ctx);
        return;
      }
      if (sub === "settings" || sub === "budget") {
        // `/agent budget k...` is a scoped alias: keys are budget.* leaves.
        const rest = tokens.slice(1);
        if (sub === "budget" && rest[0] && rest[0] !== "list" && rest[1]) rest[1] = `budget.${rest[1]}`;
        // No arguments in an interactive session → the overlay editor. Every
        // other form (and every non-TUI mode) keeps the text behaviour, so
        // scripts and `pi -p` are unaffected — the capability probe is
        // synchronous so those paths never even yield a microtask.
        if (rest.length === 0 && deps.settings && canOpenSettingsEditor(ctx)) {
          const opened = await openSettingsEditor(ctx, deps.settings, { budgetOnly: sub === "budget" });
          if (opened) return;
        }
        ctx.ui.notify(handleSettings(deps.settings, rest, sub === "budget"), "info");
        return;
      }
      // M-C4: `/agent status <runId-or-prefix>` (or `/agent <runId>`) — one run's tool timeline.
      const idArg = sub === "status" ? tokens[1] : sub;
      if (idArg) {
        // §7: `b_` is the bash job namespace, `r_`/labels stay with the runs.
        if (idArg.startsWith("b_") && deps.bashJobs) {
          ctx.ui.notify(renderBashJobDetail(deps.bashJobs, idArg), "info");
          return;
        }
        ctx.ui.notify(renderRunDetail(deps.query, idArg, deps.resolveRun), "info");
        return;
      }
      const usageWindow = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage()?.contextWindow : undefined;
      ctx.ui.notify(renderStatus(deps, usageWindow), "info");
    },
  };
}

/** Active subagent runs + active workflows (a non-empty workflow activity list also counts as busy). */
function countBusy(deps: StatusCommandDeps): number {
  const runs = countActiveRuns(deps.query.list());
  const workflows = deps.workflow?.activity.list().length ?? 0;
  return runs + workflows;
}

/** True when this pi build exposes ctx.reload (older builds do not — degrade to a manual-/reload hint). */
function canReload(ctx: ExtensionCommandContext): boolean {
  return typeof ctx.reload === "function";
}

/**
 * `/agent reload [now|cancel|fire]` — deferred reload entry point. The editor
 * wrapper rewrites exact `/reload` submissions to here; `fire` is the internal
 * action the controller's followUp message sends once the fleet settles.
 */
async function handleReload(
  deps: StatusCommandDeps,
  action: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const ctl = deps.reload;
  if (!ctl) {
    ctx.ui.notify("Deferred reload is not wired in this host; use pi's built-in /reload.", "warning");
    return;
  }
  if (action === "now") {
    ctl.disarm();
    if (!canReload(ctx)) {
      ctx.ui.notify("This pi build cannot reload programmatically — run /reload manually.", "warning");
      return;
    }
    await ctx.reload();
    return;
  }
  if (action === "cancel") {
    const wasPending = ctl.pending;
    ctl.disarm();
    ctx.ui.notify(wasPending ? "Deferred reload cancelled." : "No deferred reload was pending.", "info");
    return;
  }
  if (action === "fire") {
    // Internal: the deferred fire re-counts rather than trusting the event
    // count — a run spawned between settle and fire keeps the reload parked.
    const busy = countBusy(deps);
    if (busy > 0) {
      ctl.arm(busy);
      ctx.ui.notify(`${busy} run(s) still active — reload stays deferred.`, "info");
      return;
    }
    ctl.disarm();
    if (!canReload(ctx)) {
      ctx.ui.notify("This pi build cannot reload programmatically — run /reload manually.", "warning");
      return;
    }
    ctx.ui.notify("Subagents settled — reloading.", "info");
    await ctx.reload();
    return;
  }
  if (action !== undefined) {
    ctx.ui.notify(`Unknown reload action "${action}". Usage: /agent reload [now|cancel]`, "warning");
    return;
  }
  const busy = countBusy(deps);
  if (busy > 0) {
    ctl.arm(busy);
    ctx.ui.notify(
      `${busy} run(s) active — reload deferred until they settle. \`/agent reload now\` to force, \`/agent reload cancel\` to cancel.`,
      "info",
    );
    return;
  }
  if (!canReload(ctx)) {
    ctx.ui.notify("This pi build cannot reload programmatically — run /reload manually.", "warning");
    return;
  }
  await ctx.reload();
}

function renderSettings(store: SettingsStore, budgetOnly: boolean): string {
  const keys = settingKeys(budgetOnly);
  const width = Math.max(...keys.map((k) => k.length));
  const lines = keys.map((k) => {
    const spec = SETTING_SPECS[k]!;
    const mark = isOverridden(store.current, spec) ? ` (default ${formatSettingValue(defaultOf(spec))})` : "";
    return `  ${k.padEnd(width)}  ${formatSettingValue(currentOf(store.current, spec))}${mark}`;
  });
  const usage = budgetOnly
    ? "`/agent budget` opens the interactive editor; `/agent budget set <key> <value>` / `reset <key>` (budget.* keys) stay scriptable. Durations are seconds. Applies to new runs immediately; in-flight runs keep the budget armed at their start. 0 disables a phase timeout."
    : "`/agent settings` opens the interactive editor; `set <key> <value>` / `reset <key>` / `list` stay scriptable. Durations are seconds (keys end in `S`). budget.* applies to new runs immediately; every other key is persisted but takes effect after /reload. All changes persist to the settings file.";
  return [`Extension settings — ${store.path}:`, ...lines, "", usage].join("\n");
}

function handleSettings(store: SettingsStore | undefined, args: string[], budgetOnly: boolean): string {
  if (!store) return "Settings command unavailable: the extension host did not wire settings persistence.";
  const [action, key, ...restRaw] = args;
  const command = budgetOnly ? "budget" : "settings";
  if (!action || action === "list") return renderSettings(store, budgetOnly);
  if (action !== "set" && action !== "reset")
    return `Unknown ${command} action "${action}". Usage: /agent ${command} [set <key> <value>|reset <key>|list]`;
  if (!key || !isKnownSettingKey(key, budgetOnly))
    return (
      `Unknown ${command} key "${key ?? ""}". Valid keys: ` +
      settingKeys(budgetOnly)
        .map((k) => (budgetOnly ? k.slice("budget.".length) : k))
        .join(", ")
    );
  const spec = SETTING_SPECS[key]!;
  if (action === "reset") {
    const result = resetSetting(store, key);
    return (
      `${key} reset to default ${result.next} (${result.effect}). ` +
      (result.persistError ? `Persist failed: ${result.persistError}` : `Persisted to ${store.path}.`)
    );
  }
  const raw = restRaw.join(" ");
  const parsed = parseSettingValue(spec, raw);
  if (!parsed.ok) return `Invalid value "${raw}" for ${key}: ${parsed.error}.`;
  const result = writeSetting(store, key, parsed);
  return (
    `${key}: ${result.previous} → ${result.next} (${result.effect}). ` +
    (result.persistError ? `Persist failed: ${result.persistError}` : `Persisted to ${store.path}.`)
  );
}

/**
 * X9: render a lifetime usage accumulator (architecture §7.2). Costs are
 * formatted to 4 decimal places since subagent runs are typically cheap
 * (fractions of a cent) and truncating to 2 would print "$0.00" for most.
 */
function formatUsage(u: UsageDelta | undefined): string {
  if (!u) return "";
  return ` usage=in:${u.input} out:${u.output} cache_r:${u.cacheRead} cache_w:${u.cacheWrite} cost:$${u.costUsd.toFixed(4)}`;
}
function sumUsage(items: readonly (UsageDelta | undefined)[]): UsageDelta | undefined {
  const present = items.filter((u): u is UsageDelta => u !== undefined);
  if (!present.length) return undefined;
  return present.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      costUsd: acc.costUsd + u.costUsd,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  );
}

/**
 * M-C4: one run's detail view — header (label/type/model/status/elapsed) plus
 * a tool timeline from diag.toolHistory (start offsets relative to createdAt,
 * per-call durations, ✓/✗/▸ marks, args previews) and the error, if any.
 * Accepts a full runId, a unique prefix, or an exact label.
 */
export function renderRunDetail(
  query: QueryService,
  idArg: string,
  resolveRun?: (handle: string) => ResolveRunResult,
): string {
  const runs = query.list();
  const resolved = resolveRun?.(idArg);
  if (resolved && !resolved.ok) return resolved.error;
  const matches = resolved?.ok
    ? runs.filter((s) => s.runId === resolved.runId)
    : runs.filter((s) => s.runId === idArg || s.runId.startsWith(idArg) || s.diag.label === idArg);
  if (matches.length === 0) return `No run matches "${idArg}".`;
  if (matches.length > 1)
    return `Ambiguous "${idArg}" — matches: ${matches.map((s) => s.runId.slice(0, 8)).join(", ")}`;
  const s: RunSnapshot = matches[0]!;
  const d = s.diag;
  const elapsed = (d.settledAt ?? Date.now()) - d.createdAt;
  const head = [
    `Run ${s.runId.slice(0, 8)}${d.label ? ` (${d.label})` : ""}`,
    // consult §16.5 (acceptance follow-up): reserved id "main", never the sentinel.
    displayAgentType(d.agentType) ?? undefined,
    formatModelRef(d.model),
    `${s.status}/${s.phase}`,
    formatDuration(Math.max(0, elapsed)),
    `${d.turns} turn${d.turns === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [head];
  if (d.taskPrompt !== undefined) {
    lines.push("  Task prompt:");
    lines.push(d.taskPrompt);
  }
  if (d.toolHistory?.length) {
    lines.push("  Timeline:");
    for (const r of d.toolHistory) {
      const offset = formatDuration(Math.max(0, r.startedAt - d.createdAt)).padStart(7);
      const mark = r.endedAt === undefined ? "▸" : r.isError ? "✗" : "✓";
      const dur = r.endedAt === undefined ? "running…" : formatDuration(r.endedAt - r.startedAt);
      lines.push(`  +${offset}  ${mark} ${r.name.padEnd(10)} ${(r.argsPreview ?? "").slice(0, 60).padEnd(60)} ${dur}`);
    }
    const counts = Object.entries(d.toolCounts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
      .join(" ");
    if (counts) lines.push(`  Tools: ${counts}`);
  } else {
    lines.push("  Timeline: (no tool calls observed)");
  }
  // Timeout grace & extension: raw deadline facts (no emoji — this is the
  // diagnostic surface). Each segment appears only when its field exists.
  const now = Date.now();
  const deadlineParts: string[] = [];
  if (s.deadlines.deadlineAt !== undefined) {
    const at = s.deadlines.deadlineAt;
    deadlineParts.push(
      `${new Date(at).toISOString()} (${at >= now ? `in ${formatDuration(at - now)}` : `${formatDuration(now - at)} ago`})`,
    );
  }
  if (s.deadlines.graceUntil !== undefined)
    deadlineParts.push(`[grace: ${formatDuration(Math.max(0, s.deadlines.graceUntil - now))} left]`);
  // The ceiling mirrors to diag for terminal snapshots rebuilt by spawn-service (BL-5).
  const hardDeadlineAt = s.deadlines.hardDeadlineAt ?? d.hardDeadlineAt;
  if (hardDeadlineAt !== undefined)
    deadlineParts.push(`ceiling ${hardDeadlineAt >= now ? "+" : "-"}${formatDuration(Math.abs(hardDeadlineAt - now))}`);
  if (deadlineParts.length) lines.push(`  Deadline: ${deadlineParts.join("  ")}`);
  if (d.overtime) {
    const ot = d.overtime;
    lines.push(
      `  Overtime: graces=${ot.graces} extensions=${ot.extensions} granted=${formatDuration(ot.grantedMs)}` +
        (ot.lastReason ? ` reason="${ot.lastReason}"` : ""),
    );
  }
  if (d.usage) lines.push(`  Usage:${formatUsage(d.usage)}`);
  if (d.error) lines.push(`  Error: [${d.error.kind}] ${d.error.message.slice(0, 300)}`);
  if (d.timeoutReason) lines.push(`  Timeout: ${d.timeoutReason}`);
  if (d.sessionFile) lines.push(`  Session: ${d.sessionFile}`);
  return lines.join("\n");
}

/**
 * M7: `/agent costs` — per-run spend breakdown (cost-descending), separating
 * active from finished runs, with a grand total. Answers "钱花哪了" without
 * digging through notifications.
 *
 * X12: a run's `diag.usage` already includes the lifetime spend of any
 * nested run absorbed on one of its usage-bearing toolResults (consult /
 * nested Agent / get_subagent_result — see src/core/state-machine.ts
 * absorbRunIds). Listing every run's cost AND summing all of them would
 * double-count the absorbed child on top of the parent that already carries
 * its spend, so the grand total skips any run whose id shows up in another
 * tracked run's `absorbedRunIds` (same rule as the HUD footer's `+agents`
 * and the usage broadcast's `absorbed` flag) — the per-run row is still
 * shown (marked `(absorbed)`) so nothing silently disappears from the list.
 */
export function renderCosts(query: QueryService): string {
  const runs = [...query.list()].sort((a, b) => (b.diag.usage?.costUsd ?? 0) - (a.diag.usage?.costUsd ?? 0));
  if (runs.length === 0) return "No subagent runs recorded this session.";
  const terminalStatuses = ["completed", "failed", "timed_out", "aborted"];
  const absorbedIds = new Set<string>();
  for (const s of runs) for (const id of s.diag.absorbedRunIds ?? []) absorbedIds.add(id);
  const lines = [`Subagent costs — ${runs.length} run(s)`];
  for (const s of runs) {
    const d = s.diag;
    const active = !terminalStatuses.includes(s.status);
    const cost = d.usage ? `$${d.usage.costUsd.toFixed(4)}` : "$0.0000";
    const cols = [
      `  ${cost.padStart(8)}`,
      active ? "▸" : s.status === "completed" ? "✓" : "✗",
      s.runId.slice(0, 8),
      (d.label ?? "·").slice(0, 24).padEnd(24),
      (displayAgentType(d.agentType) ?? "·").padEnd(12),
      (formatModelRef(d.model) ?? "·").padEnd(24),
      `${d.turns}t`,
      d.settledAt !== undefined ? formatDuration(Math.max(0, d.settledAt - d.createdAt)) : "running",
    ];
    let row = cols.join(" ");
    if (absorbedIds.has(s.runId)) row += " (absorbed)";
    lines.push(row);
  }
  const countedRuns = runs.filter((s) => !absorbedIds.has(s.runId));
  const total = sumUsage(countedRuns.map((s) => s.diag.usage));
  if (total)
    lines.push(
      `  Total: $${total.costUsd.toFixed(4)} · in:${total.input} out:${total.output} cache_r:${total.cacheRead}`,
    );
  const absorbedCount = runs.length - countedRuns.length;
  if (absorbedCount > 0)
    lines.push(`  (excludes ${absorbedCount} absorbed run(s) already counted in a parent's total above)`);
  return lines.join("\n");
}

/** Rows shown per group in the `bash jobs` section (§7). */
const BASH_JOB_ROWS = 5;

function bashJobElapsed(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

function bashJobRow(record: JobRecord, now: number, suffix: string): string {
  return (
    `  ${record.jobId}  ${describeJobStatus(record)}  ${formatDuration(bashJobElapsed(record, now))}  ` +
    `$ ${previewCommand(record.command, 40)}  (log ${formatSize(record.logBytes)}${suffix})`
  );
}

/**
 * §7: the `bash jobs` section of `/agent status`. Running jobs first (the
 * ones the user may still want to kill), then terminal jobs whose completion
 * notice has not gone out yet. The whole section disappears when there are no
 * jobs at all — users who never hit the auto-background threshold should not
 * see a new empty header.
 */
export function renderBashJobsSection(port: { list(): readonly JobRecord[] }, now: number): string[] {
  let jobs: readonly JobRecord[] = [];
  try {
    jobs = port.list();
  } catch {
    return [];
  }
  if (jobs.length === 0) return [];
  const running = jobs.filter((record) => !isTerminalJobStatus(record.status));
  const unread = jobs.filter((record) => isTerminalJobStatus(record.status) && record.notifiedAt === undefined);
  const lines = [`bash jobs (${running.length} running, ${unread.length} finished unread):`];
  for (const record of running.slice(0, BASH_JOB_ROWS)) lines.push(bashJobRow(record, now, ""));
  if (running.length > BASH_JOB_ROWS) lines.push(`  … ${running.length - BASH_JOB_ROWS} more running`);
  for (const record of unread.slice(0, BASH_JOB_ROWS)) lines.push(bashJobRow(record, now, ", unnotified"));
  if (unread.length > BASH_JOB_ROWS) lines.push(`  … ${unread.length - BASH_JOB_ROWS} more finished unread`);
  return lines;
}

/** §7: `/agent status <b_prefix>` — one bash job (exact id or unique prefix). */
export function renderBashJobDetail(
  port: { list(): readonly JobRecord[] },
  handle: string,
  now: number = Date.now(),
): string {
  const jobs = port.list();
  const matches = jobs.filter((record) => record.jobId === handle || record.jobId.startsWith(handle));
  const exact = jobs.find((record) => record.jobId === handle);
  const record = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!record) {
    if (matches.length > 1) return `Ambiguous "${handle}" — matches: ${matches.map((m) => m.jobId).join(", ")}`;
    return `No bash job matches "${handle}".`;
  }
  const lines = [
    `Bash job ${record.jobId} · ${describeJobStatus(record)} · ${formatDuration(bashJobElapsed(record, now))}`,
    `  Command: $ ${previewCommand(record.command, 200)}`,
    `  Cwd: ${record.cwd || "(unknown)"}`,
    `  Log: ${record.logPath} (${formatSize(record.logBytes)}${record.outputTruncated ? ", size cap reached" : ""})`,
  ];
  if (record.pid !== undefined)
    lines.push(`  Pid: ${record.pid}${record.pgid !== undefined ? ` (pgid ${record.pgid})` : ""}`);
  lines.push(
    `  Flags: ${record.backgroundedAt !== undefined ? "backgrounded" : "foreground"}, ` +
      `${record.notifiedAt !== undefined ? "notified" : "not notified"}`,
  );
  if (record.finalText) lines.push(`  Final: ${record.finalText.slice(-300)}`);
  lines.push("  Read that log file directly (read tool, or tail/grep/awk) for the full output.");
  return lines.join("\n");
}

export function renderStatus(deps: StatusCommandDeps, contextWindow?: number): string {
  const runs = deps.query.list();
  const active = runs.filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
  const lines: string[] = [];
  if (deps.workflow) {
    const now = deps.workflow.now?.() ?? Date.now();
    const snapshots = deps.workflow.activity.list();
    lines.push(`Workflows: ${snapshots.length} active`);
    for (const s of snapshots) {
      const elapsedMs = Math.max(0, now - s.startedAt);
      const remaining = s.deadlineAt !== undefined ? Math.max(0, s.deadlineAt - now) : undefined;
      lines.push(
        `  ${s.workflowId} name=${s.name} phase=${s.currentPhaseId ?? "-"} elapsed_ms=${elapsedMs}` +
          (remaining !== undefined ? ` deadline_remaining_ms=${remaining}` : ""),
      );
    }
  }
  lines.push(`Subagent runs: ${runs.length} total, ${active.length} active`);
  for (const s of active.slice(0, 10)) {
    const currentTool = s.diag.currentTool ? ` tool=${s.diag.currentTool.name}` : "";
    const lastEvent =
      s.diag.lastEventAt !== undefined ? ` last_event=${s.diag.lastEventType ?? "?"}@${s.diag.lastEventAt}` : "";
    const escalation = s.diag.escalation.length
      ? ` escalation=[${s.diag.escalation.map((e) => `${e.level}:${e.ok ? "ok" : "fail"}`).join(",")}]`
      : "";
    lines.push(
      `  ${s.runId} status=${s.status} phase=${s.phase}${currentTool}${lastEvent}${escalation}${formatUsage(s.diag.usage)}`,
    );
  }
  const totalUsage = sumUsage(runs.map((s) => s.diag.usage));
  if (totalUsage) lines.push(`Usage (all runs):${formatUsage(totalUsage)}`);
  const orphans = deps.orphans;
  lines.push(
    `Orphans: ${orphans.totalCount} total (retained ${orphans.recent.length}, late-recovered ${orphans.lateRecoveredCount})`,
  );
  const delivery = deps.notifier.stats;
  lines.push(
    `Delivery: staged=${delivery.staged} pending=${delivery.pending} batched=${delivery.batched} delivered=${delivery.delivered} consumed=${delivery.consumed} dropped=${delivery.dropped} abandoned=${delivery.abandoned} acked=${deps.notifier.ackedSuppressions}`,
  );
  if (deps.notifier.degraded.length) lines.push(`Degraded deliveries: ${deps.notifier.degraded.length}`);
  if (deps.mention) lines.push(...renderMentionableLabels(deps.mention));
  if (deps.bashJobs) lines.push(...renderBashJobsSection(deps.bashJobs, deps.workflow?.now?.() ?? Date.now()));
  if (deps.dynamic) lines.push(...renderDynamicThresholdSection(deps.dynamic, contextWindow));
  return lines.join("\n");
}

function renderMentionableLabels(source: { entries(): readonly MentionAutocompleteEntry[] }): string[] {
  const entries = source.entries();
  const lines = [`Mentionable labels: ${entries.length}`];
  for (const entry of entries) {
    const status = entry.status === "running" ? "running" : entry.status === "settled" ? "已结束·@可resume" : "不可用";
    lines.push(`  @${entry.label} status=${status} type=${entry.type} run=${entry.runId}`);
  }
  return lines;
}

// ── compact-hint 动态阈值节（dynamic-threshold-plan.md §10.3，P1-11）─────────────

/** token 量的短英文格式（1.0M / 98k / 16k）；null ⇒ "—"。 */
function formatTokensShort(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${Math.round(tokens)}`;
}

function formatUsdPerM(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  return `$${value.toFixed(2)}/M`;
}

/**
 * Line-1 head: the hint percent that actually fires (static vs dynamic composed exactly like the
 * hook, via the shared resolveEffectiveHint), with the losing line shown for context. Without the
 * static facts (older host) it falls back to the bare dynamic line.
 */
function renderHintHead(
  view: DynamicStatusView,
  staticLines: { percent: number; tokensK: number } | null,
  staticEffective: number | null,
  window: number | null,
  reserveTokens: number | undefined,
): string {
  const dynLabel = `dyn ${view.hintPercent ?? "—"}% ${view.basis ?? "—"}`;
  if (staticLines === null || staticEffective === null || window === null || reserveTokens === undefined) {
    return `hint ${view.hintPercent ?? "—"}% (dyn·${view.basis ?? "—"})`;
  }
  if (view.mode !== "on") {
    return staticEffective > 0
      ? `hint ${staticEffective}% (static; shadow ${dynLabel})`
      : `hint off (static off; shadow ${dynLabel})`;
  }
  // D3: a disabled static line stays disabled — the dynamic layer never resurrects a hint.
  if (staticEffective <= 0) return `hint off (static off; ${dynLabel} not applied)`;
  const resolved = resolveEffectiveHint({
    staticEffectivePercent: staticEffective,
    staticLines,
    window,
    reserveTokens,
    dynamic:
      view.hintTokens !== null && view.hintPercent !== null
        ? { hintTokens: view.hintTokens, hintPercent: view.hintPercent }
        : undefined,
  });
  return resolved.dynamicWon
    ? `hint ${resolved.percent}% (dyn·${view.basis ?? "—"}; static ${staticEffective}%)`
    : `hint ${resolved.percent}% (static; ${dynLabel})`;
}

/**
 * §10.3 渲染（英文，3 行）。view 缺席 / mode="off" ⇒ 整节不渲染（旧输出逐字节不变）。
 * `contextWindow` 来自命令时点的 `ctx.getContextUsage()`（force 线换算用，缺席则省略该段）。
 */
export function renderDynamicThresholdSection(
  port: NonNullable<StatusCommandDeps["dynamic"]>,
  contextWindow?: number,
): string[] {
  const view = port.view();
  if (view === undefined || view.mode === "off") return [];
  const facts = port.facts?.();
  const window =
    contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const forcePercent =
    facts !== undefined && window !== null
      ? effectiveThresholdPercentWithTokens(
          facts.forceScaling ? windowScaledForcePercent(facts.forceAtPercent, window) : facts.forceAtPercent,
          facts.forceAtTokens,
          window,
          facts.reserveTokens,
        )
      : null;
  const factsParts = [
    forcePercent !== null ? `force ${forcePercent}%` : null,
    window !== null ? `window ${formatTokensShort(window)}` : null,
    facts !== undefined ? `reserve ${formatTokensShort(facts.reserveTokens)}` : null,
  ].filter(Boolean);
  // The static hint line as the hook resolves it (null when the host did not supply it).
  const staticLines =
    facts?.thresholdPercent !== undefined
      ? { percent: facts.thresholdPercent, tokensK: facts.thresholdTokens ?? 0 }
      : null;
  const staticEffective =
    staticLines !== null && window !== null && facts !== undefined
      ? effectiveThresholdPercentWithTokens(staticLines.percent, staticLines.tokensK, window, facts.reserveTokens)
      : null;
  if (view.usable) {
    const range =
      view.lowerBoundPercent !== null && view.capPercent !== null
        ? ` · range ${view.lowerBoundPercent}%..${view.capPercent}%`
        : "";
    const lines = [
      `Compact thresholds: ${renderHintHead(view, staticLines, staticEffective, window, facts?.reserveTokens)} · ${factsParts.join(" · ")}${range}`,
    ];
    lines.push(
      `  price r ${formatUsdPerM(view.priceReadPerM)} w ${formatUsdPerM(view.priceWritePerM)}~ out ${formatUsdPerM(view.priceOutputPerM)} (write pricing approximate) · C* ${
        view.cStarPercent !== null ? `${view.cStarPercent}%` : "—"
      } · g ${formatTokensShort(view.g)}/turn (σ ${formatTokensShort(view.sigma)}) · S0 ${formatTokensShort(view.s0)}`,
    );
    lines.push(
      `  R $${view.rUsd.toFixed(2)} (uncalibrated prior${
        view.rEquivalentTurns !== null ? `, ≈ ${view.rEquivalentTurns} turns` : ""
      }) · dynamic ${view.mode} · telemetry ${view.telemetryCount} → ${view.telemetryPath ?? "—"}`,
    );
    return lines;
  }
  // 退化：第 1 行末尾改为 dyn off（reason → static line）；估计量/价格行仍给诊断值。
  const reason = view.degradeReason ?? "unknown";
  const staticHead =
    staticEffective === null ? "hint static" : staticEffective > 0 ? `hint ${staticEffective}% (static)` : "hint off";
  return [
    `Compact thresholds: ${staticHead} · ${factsParts.join(" · ")} · dyn off (${reason} → static line)`,
    `  price r ${formatUsdPerM(view.priceReadPerM)} w ${formatUsdPerM(view.priceWritePerM)}~ · g ${formatTokensShort(view.g)}/turn (σ ${formatTokensShort(view.sigma)}) · S0 ${formatTokensShort(view.s0)}`,
    `  R $${view.rUsd.toFixed(2)} (uncalibrated prior) · dynamic ${view.mode} · telemetry ${view.telemetryCount} → ${view.telemetryPath ?? "—"}`,
  ];
}
