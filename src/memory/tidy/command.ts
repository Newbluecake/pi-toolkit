// §7 `/mem tidy` / `/mem restore` command dispatch — todo #22 P4. Real
// implementation of the P0-b assembly skeleton: the main-session/UI gate
// and the "tidy unavailable" port gate were already real (P0-b's own
// comment on the previous version of this file) — this fills in the actual
// proposal → validate → per-file confirm → apply flow (§7.3) plus
// `--dry-run`/`--frontmatter` (§7.3/§7.4) and `/mem restore`/`--trash`
// (§7.5).

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../../core/worktree-origin.js";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../config/settings.js";
import { createCapWatcher, type ConsultCapReason } from "../../consult/watcher.js";
import type { RunOutcome } from "../../core/types.js";
import type { TidyPort, TidyProposal, TidyProposalFile } from "../contracts.js";
import { TIDY_SCHEMA } from "../contracts.js";
import { canonicalDir, canonicalMemoryDir, listRegular, readRegular, statRegularIfExists } from "../safe-fs.js";
import { memoryDirFor, type MemoryPaths } from "../paths.js";
import { parseMemoryMeta } from "../meta.js";
import { upsertFrontmatterFields } from "../frontmatter.js";
import {
  runDoctor as runDoctorReal,
  type DoctorSettings,
  type DoctorSnapshot,
  type DoctorSnapshotFile,
} from "../doctor.js";
import { snapshotMemoryDir, type TidySnapshot, type TidySnapshotFile } from "./snapshot.js";
import { buildTidyPrompt } from "./prompt.js";
import { estimateTidyUsd, isPricedRates, tidyRatesFromModelCost, type TidyCostRates } from "./cost.js";
import { validateTidyProposal, type TidyFileFlag, type TidyValidationResult } from "./validate.js";
import { renderTidyDiff } from "./diff.js";
import { planFrontmatterBackfill, type FrontmatterCandidateFile, type FrontmatterProposal } from "./frontmatter.js";
import { applyTidy } from "./apply.js";
import {
  applyRestore,
  planRestore,
  restoreFromTrash,
  type RestoreDecision,
  type RestorePlan,
  type RestoreResult,
} from "./restore.js";
import { listBackups, listTrashEntries } from "./manifest.js";

export interface TidyCommandDeps {
  paths?: MemoryPaths;
  isChildSession: boolean;
  getTidyPort: () => TidyPort | undefined;
  /** Activate-time settings snapshot shared with doctor/tidy. */
  settings?: () => MemorySettings;
  /** P3's `runDoctor`, injected for testability — P3 may still be a stub in
   *  this package's own dev loop (§14.1's "开发期用桩/注入端口测试"); falls
   *  back to the real import, wrapped so a still-throwing stub degrades to
   *  a filename-only migration-mode heuristic instead of crashing `/mem
   *  tidy`. */
  runDoctor?: typeof runDoctorReal;
  now?: () => Date;
  /** Called once after a successful apply/restore with >=1 entry (§7.3
   *  step 7's "调用一次 onAfterWrite" — the memory-block re-render hook).
   *  Production wiring passes `wireMemory`'s invalidation callback. */
  onAfterWrite?: (cwd: string) => void;
}

function parseTidyArgs(args: string): { dryRun: boolean; frontmatter: boolean; files: string[] } {
  const tokens = args.split(/\s+/).filter((t) => t.length > 0);
  return {
    dryRun: tokens.includes("--dry-run"),
    frontmatter: tokens.includes("--frontmatter"),
    files: tokens.filter((t) => t !== "--dry-run" && t !== "--frontmatter"),
  };
}

function parseRestoreArgs(args: string): { trash: boolean; id: string | undefined } {
  const tokens = args.split(/\s+/).filter((t) => t.length > 0);
  const trash = tokens.includes("--trash");
  const rest = tokens.filter((t) => t !== "--trash");
  return { trash, id: rest[0] };
}

function kb(bytes: number): string {
  return `${String(Math.ceil(bytes / 1024))}kB`;
}

/**
 * `/mem tidy [--dry-run|--frontmatter] [file…]` / `/mem restore [--trash]
 * [<id>]`. Real gating (§7's "仅主会话且 ctx.hasUI"; "未注入 ⇒ tidy
 * unavailable in this session"), then dispatches to the actual flow.
 */
export async function handleMemTidyCommand(
  kind: "tidy" | "restore",
  args: string,
  ctx: ExtensionCommandContext,
  deps: TidyCommandDeps,
): Promise<void> {
  if (deps.isChildSession || !ctx.hasUI) {
    if (ctx.hasUI) ctx.ui.notify(`/mem ${kind} is only available in the main session`, "warning");
    return;
  }
  const port = deps.getTidyPort();
  if (!port) {
    ctx.ui.notify("tidy unavailable in this session", "warning");
    return;
  }
  const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
  const settings = (deps.settings ?? (() => DEFAULT_SETTINGS.memory))();

  if (kind === "restore") {
    await handleRestoreCommand(args, ctx, { cwd, ...(deps.paths ? { paths: deps.paths } : {}) });
    return;
  }
  await handleTidyCommand(args, ctx, {
    cwd,
    port,
    settings,
    ...(deps.paths ? { paths: deps.paths } : {}),
    runDoctorFn: deps.runDoctor ?? runDoctorReal,
    now: deps.now ?? (() => new Date()),
    onAfterWrite: deps.onAfterWrite ?? (() => undefined),
  });
}

// ───────────────────────────── /mem tidy ─────────────────────────────

interface TidyCtx {
  cwd: string;
  port: TidyPort;
  settings: MemorySettings;
  paths?: MemoryPaths;
  runDoctorFn: typeof runDoctorReal;
  now: () => Date;
  onAfterWrite: (cwd: string) => void;
}

function coreMdExists(cwd: string, paths: MemoryPaths | undefined): boolean {
  const canon = canonicalMemoryDir(cwd, paths);
  if (!canon) return false;
  return listRegular(canon.real, { names: "v2" }).files.some((f) => f.name === "core.md");
}

function computeMigrationMode(
  cwd: string,
  paths: MemoryPaths | undefined,
  settings: MemorySettings,
  runDoctorFn: typeof runDoctorReal,
): boolean {
  let fallback = !coreMdExists(cwd, paths);
  try {
    const canon = canonicalMemoryDir(cwd, paths);
    if (!canon) return fallback;
    const files: DoctorSnapshotFile[] = listRegular(canon.real, { names: "v2" }).files.map((f) => {
      const { text } = readRegular(canon.real, f.name);
      const { meta } = parseMemoryMeta(text, f.name.replace(/\.md$/, ""));
      return { name: f.name, size: f.size, meta };
    });
    const snapshot: DoctorSnapshot = { cwd, files };
    const doctorSettings: DoctorSettings = {
      coreBytes: settings.coreBytes,
      blockBytes: settings.blockBytes,
      topicWarnBytes: settings.topicWarnBytes,
      topicMaxBytes: settings.topicMaxBytes,
      staleDays: settings.doctor.staleDays,
    };
    const findings = runDoctorFn(snapshot, doctorSettings);
    return findings.some((f) => f.id === "D01");
  } catch {
    return fallback; // P3's runDoctor may still be a stub — heuristic fallback
  }
}

function resolveModelRef(
  ctx: ExtensionCommandContext,
  settings: MemorySettings,
): { provider: string; id: string } | undefined {
  const raw = settings.tidy.model;
  const m = /^([^/]+)\/([^/]+)$/.exec(raw);
  if (m?.[1] && m[2]) return { provider: m[1], id: m[2] };
  if (ctx.model) return { provider: ctx.model.provider, id: ctx.model.id };
  return undefined;
}

function effectiveName(f: TidyProposalFile): string {
  return f.action === "rename" && f.newName ? f.newName : f.name;
}

function sizeKb(n: number): string {
  return `${(n / 1024).toFixed(1)}k`;
}

function buildFileTitle(
  index: number,
  total: number,
  f: TidyProposalFile,
  orig: TidySnapshotFile | undefined,
  overCostCap: boolean,
): string {
  const before = orig ? Buffer.byteLength(orig.body, "utf8") : 0;
  const after = f.content !== undefined ? Buffer.byteLength(f.content, "utf8") : before;
  const reason = f.reason.length > 120 ? `${f.reason.slice(0, 119)}…` : f.reason;
  const suffix = overCostCap ? " (over cost cap)" : "";
  return `tidy ${String(index + 1)}/${String(total)} · ${effectiveName(f)} · ${f.action} · ${sizeKb(before)}→${sizeKb(after)} · ${reason}${suffix}`;
}

function buildOptions(flag: TidyFileFlag | undefined, handWritten: boolean): string[] {
  if (handWritten) return ["View diff", "Skip", "Abort all"]; // §7.3 step5 / 用户决策 5: suggestion only, no commit path at all
  if (flag && !flag.canApply) return ["Edit then apply", "View diff", "Skip", "Abort all"]; // over budget / bad frontmatter: still fixable
  if (flag && flag.unaccountedLines > 0) return ["Skip", "Apply", "Edit then apply", "View diff", "Abort all"];
  return ["Apply", "Edit then apply", "View diff", "Skip", "Abort all"];
}

async function handleTidyCommand(args: string, ctx: ExtensionCommandContext, tctx: TidyCtx): Promise<void> {
  const { cwd, port, settings, paths, runDoctorFn, now, onAfterWrite } = tctx;
  const { dryRun, frontmatter, files } = parseTidyArgs(args);

  let snap: TidySnapshot;
  try {
    snap = snapshotMemoryDir(cwd, { ...(files.length > 0 ? { names: files } : {}), ...(paths ? { paths } : {}) });
  } catch (err) {
    ctx.ui.notify(`memory tidy: ${(err as Error).message}`, "warning");
    return;
  }
  if (snap.files.length === 0) {
    ctx.ui.notify("no memory files to tidy", "info");
    return;
  }
  if (snap.totalBytes > settings.tidy.maxInputBytes) {
    ctx.ui.notify(
      `tidy input is ${kb(snap.totalBytes)}, over the ${kb(settings.tidy.maxInputBytes)} cap — narrow the file set with /mem tidy <file…>`,
      "warning",
    );
    return;
  }

  if (frontmatter) {
    await runFrontmatterMode(snap, ctx, { cwd, ...(paths ? { paths } : {}), now, onAfterWrite });
    return;
  }

  const migrationMode = computeMigrationMode(cwd, paths, settings, runDoctorFn);
  const promptFiles = snap.files.map((f) => ({
    name: f.name,
    body: f.body,
    isPrimaryCore: f.isPrimaryCore,
    handWritten: f.handWritten,
  }));
  const prompt = buildTidyPrompt({
    cwd,
    files: promptFiles,
    migrationMode,
    coreBytes: settings.coreBytes,
    topicMaxBytes: settings.topicMaxBytes,
  });
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  const modelRef = resolveModelRef(ctx, settings);
  if (!modelRef) {
    ctx.ui.notify("no model to run tidy — set memory.tidy.model or pick a model for this session", "warning");
    return;
  }
  const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
  let rates: TidyCostRates | undefined;
  if (model) rates = tidyRatesFromModelCost(model.cost, Math.ceil(promptBytes / 2));
  const priced = rates !== undefined && isPricedRates(rates);
  const est =
    priced && rates ? estimateTidyUsd({ promptBytes, maxOutputBytes: settings.tidy.maxOutputBytes, rates }) : undefined;

  if (priced && est !== undefined && est > settings.tidy.maxCostUsd) {
    ctx.ui.notify(
      `tidy would cost ~$${est.toFixed(2)}, over the $${settings.tidy.maxCostUsd.toFixed(2)} cap — narrow the file set, ` +
        "use a cheaper memory.tidy.model, or raise memory.tidy.maxCostUsd",
      "warning",
    );
    return;
  }

  const modelLabel = `${modelRef.provider}/${modelRef.id}`;
  const summary = priced
    ? `${String(snap.files.length)} files · ${kb(promptBytes)} in · ${modelLabel} · est ≤$${(est ?? 0).toFixed(2)} ` +
      `(cap $${settings.tidy.maxCostUsd.toFixed(2)}) · ≤${String(settings.tidy.maxTurns)} turns · timeout ${String(Math.round(settings.tidy.timeoutMs / 1000))}s`
    : `${String(snap.files.length)} files · ${kb(promptBytes)} in · ${modelLabel} · ⚠ no price info — no cost guarantee ` +
      `(bounded only by ≤${String(settings.tidy.maxTurns)} turns · ≤${kb(settings.tidy.maxOutputBytes)} output · timeout ${String(
        Math.round(settings.tidy.timeoutMs / 1000),
      )}s)`;

  if (dryRun) {
    ctx.ui.notify(`tidy --dry-run: ${summary}`, "info");
    return; // zero spawn, zero writes
  }

  const ok = await ctx.ui.confirm("memory tidy", `${summary}. Continue?`);
  if (!ok) return;

  const spawnRes = await port.spawn({
    type: settings.tidy.agentType,
    prompt,
    label: "mem-tidy",
    cwd,
    ...(modelRef ? { modelOverride: modelRef } : {}),
    thinkingOverride: "low",
    totalMs: settings.tidy.timeoutMs,
    schema: TIDY_SCHEMA,
    toolDomain: "readonly",
    expectAck: true,
    suppressDelivery: true,
  });
  if ("error" in spawnRes) {
    ctx.ui.notify(`tidy spawn failed: ${spawnRes.error.message} — zero writes`, "warning");
    return;
  }
  const { runId } = spawnRes;

  let capReason: ConsultCapReason | undefined;
  const watcher = createCapWatcher({
    maxTurns: settings.tidy.maxTurns,
    maxCostUsd: priced ? settings.tidy.maxCostUsd : 0,
    onCap: (reason) => {
      capReason = reason;
      queueMicrotask(() => void port.abort(runId, "user_stop"));
    },
  });
  const pollTimer = setInterval(() => {
    const s = port.snapshot(runId);
    if (s) watcher.onSnapshot(s);
  }, 1000);
  pollTimer.unref?.();

  let outcome: RunOutcome;
  try {
    const waited = await port.waitOutcome(runId, settings.tidy.timeoutMs + 5000);
    if (waited.kind === "pending") {
      await port.abort(runId, "timeout");
      ctx.ui.notify("tidy timed out — zero writes", "warning");
      return;
    }
    outcome = waited.outcome;
  } finally {
    clearInterval(pollTimer);
  }

  if (outcome.status !== "completed" || outcome.structuredResult === undefined) {
    const costSuffix = !priced ? " (cost unknown)" : "";
    const reason =
      capReason === "cost_cap"
        ? `cost cap $${settings.tidy.maxCostUsd.toFixed(2)} reached`
        : capReason === "turn_cap"
          ? `turn cap reached${costSuffix}`
          : outcome.status === "timed_out"
            ? "timed out"
            : (outcome.error?.message ?? outcome.status);
    ctx.ui.notify(`tidy aborted: ${reason} — zero writes`, "warning");
    return;
  }

  const proposal = outcome.structuredResult as TidyProposal; // schema-validated host-side
  const originalByName = new Map(snap.files.map((f) => [f.name, f]));
  const working: TidyProposalFile[] = proposal.files.map((f) => ({ ...f }));
  const workingProposal = (): TidyProposal => ({
    files: working,
    dropped: proposal.dropped,
    ...(proposal.notes !== undefined ? { notes: proposal.notes } : {}),
  });
  const validateCtx = {
    original: originalByName,
    coreBytes: settings.coreBytes,
    topicMaxBytes: settings.topicMaxBytes,
    maxOutputBytes: settings.tidy.maxOutputBytes,
  };
  let vres: TidyValidationResult = validateTidyProposal(workingProposal(), validateCtx);
  if (!vres.ok) {
    ctx.ui.notify(`tidy proposal invalid: ${vres.issues.map((i) => i.message).join("; ")} — zero writes`, "warning");
    return;
  }

  const overCostCap = priced && outcome.usage !== undefined && outcome.usage.costUsd > settings.tidy.maxCostUsd;
  const targets = working.filter((f) => f.action !== "keep");
  const decisions = new Map<string, "apply" | "skip">();
  let abortedAll = false;

  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    if (!f) continue;
    const handWritten = originalByName.get(f.name)?.handWritten === true;
    let flag = vres.fileFlags.get(f.name);
    for (;;) {
      const title = buildFileTitle(i, targets.length, f, originalByName.get(f.name), overCostCap);
      const choice = await ctx.ui.select(title, buildOptions(flag, handWritten));
      if (choice === undefined || choice === "Abort all") {
        abortedAll = true;
        break;
      }
      if (choice === "View diff") {
        const before = originalByName.get(f.name)?.body ?? "";
        await ctx.ui.editor(`tidy diff — ${f.name}`, renderTidyDiff(before, f.content ?? before));
        continue;
      }
      if (choice === "Edit then apply") {
        const before = originalByName.get(f.name)?.body ?? "";
        const edited = await ctx.ui.editor(`tidy edit — ${f.name}`, f.content ?? before);
        if (edited === undefined) continue;
        f.content = edited;
        vres = validateTidyProposal(workingProposal(), validateCtx);
        flag = vres.fileFlags.get(f.name);
        if (flag && !flag.canApply) continue; // still not applyable — show the new reason
        decisions.set(f.name, "apply");
        break;
      }
      if (choice === "Skip") {
        decisions.set(f.name, "skip");
        break;
      }
      // "Apply"
      decisions.set(f.name, "apply");
      break;
    }
    if (abortedAll) break;
  }
  if (abortedAll) {
    ctx.ui.notify("tidy aborted by user — zero writes", "warning");
    return;
  }

  const originalSha = new Map(snap.files.map((f) => [f.name, f.sha256]));
  const applied = await applyTidy({
    cwd,
    ...(paths ? { paths } : {}),
    proposal: workingProposal(),
    decisions,
    originalSha,
    kind: "tidy",
    nowIso: now().toISOString(),
  });

  if (applied.manifest.entries.length > 0) onAfterWrite(cwd);

  const skippedCount = targets.length - applied.applied.length;
  const diskChangedCount = applied.skipped.filter((s) => /changed on disk/.test(s.reason)).length;
  const skipNote = diskChangedCount > 0 ? ` (${String(diskChangedCount)} changed on disk)` : "";
  const backupNote = applied.manifest.entries.length > 0 ? `; backup .backup/${applied.manifest.id}` : "";
  const costNote =
    priced && outcome.usage !== undefined
      ? `; cost $${outcome.usage.costUsd.toFixed(2)}`
      : `; cost: unknown — no price info for ${modelLabel}, no cost guarantee`;
  ctx.ui.notify(
    `tidy: applied ${String(applied.applied.length)}, skipped ${String(skippedCount)}${skipNote}${backupNote}${costNote}`,
    "info",
  );
}

// ───────────────────────────── /mem tidy --frontmatter ─────────────────────────────

function describePatch(patch: FrontmatterProposal["patch"]): string {
  const parts: string[] = [];
  if (patch.description !== undefined) parts.push("+description");
  if (patch.topic !== undefined) parts.push("+topic");
  if (patch.status !== undefined) parts.push("+status");
  return parts.join(", ");
}

function applyFrontmatterPatch(body: string, patch: FrontmatterProposal["patch"]): string {
  const fields: Record<string, string> = {};
  if (patch.description !== undefined) fields.description = patch.description;
  if (patch.topic !== undefined) fields.topic = patch.topic;
  if (patch.status !== undefined) fields.status = patch.status;
  return upsertFrontmatterFields(body, fields);
}

async function runFrontmatterMode(
  snap: TidySnapshot,
  ctx: ExtensionCommandContext,
  o: { cwd: string; paths?: MemoryPaths; now: () => Date; onAfterWrite: (cwd: string) => void },
): Promise<void> {
  const candidates: FrontmatterCandidateFile[] = snap.files.map((f) => ({
    name: f.name,
    body: f.body,
    meta: f.meta,
    isPrimaryCore: f.isPrimaryCore,
  }));
  const proposals = planFrontmatterBackfill(candidates);
  if (proposals.length === 0) {
    ctx.ui.notify("frontmatter: nothing to backfill", "info");
    return;
  }
  const byName = new Map(snap.files.map((f) => [f.name, f]));
  const decisions = new Map<string, "apply" | "skip">();
  const files: TidyProposalFile[] = proposals.map((p) => {
    const orig = byName.get(p.name);
    const content = applyFrontmatterPatch(orig?.body ?? "", p.patch);
    return { name: p.name, action: "rewrite", content, reason: "frontmatter backfill" };
  });

  for (const f of files) {
    const orig = byName.get(f.name);
    const patch = proposals.find((p) => p.name === f.name)?.patch ?? {};
    if (orig?.handWritten) {
      const choice = await ctx.ui.select(`frontmatter · ${f.name} · suggestion only (hand-written)`, [
        "View diff",
        "Skip",
      ]);
      if (choice === "View diff")
        await ctx.ui.editor(`frontmatter diff — ${f.name}`, renderTidyDiff(orig.body, f.content ?? ""));
      decisions.set(f.name, "skip");
      continue;
    }
    let applied = false;
    for (;;) {
      const choice = await ctx.ui.select(`frontmatter · ${f.name} · ${describePatch(patch)}`, [
        "Apply",
        "View diff",
        "Skip",
      ]);
      if (choice === "View diff") {
        await ctx.ui.editor(`frontmatter diff — ${f.name}`, renderTidyDiff(orig?.body ?? "", f.content ?? ""));
        continue;
      }
      applied = choice === "Apply";
      break;
    }
    decisions.set(f.name, applied ? "apply" : "skip");
  }

  const originalSha = new Map(snap.files.map((f) => [f.name, f.sha256]));
  const result = await applyTidy({
    cwd: o.cwd,
    ...(o.paths ? { paths: o.paths } : {}),
    proposal: { files, dropped: [] },
    decisions,
    originalSha,
    kind: "frontmatter",
    nowIso: o.now().toISOString(),
  });
  if (result.manifest.entries.length > 0) o.onAfterWrite(o.cwd);
  const backupNote = result.manifest.entries.length > 0 ? `; backup .backup/${result.manifest.id}` : "";
  ctx.ui.notify(
    `frontmatter: applied ${String(result.applied.length)}, skipped ${String(files.length - result.applied.length)}${backupNote}`,
    "info",
  );
}

// ───────────────────────────── /mem restore ─────────────────────────────

async function handleRestoreCommand(
  args: string,
  ctx: ExtensionCommandContext,
  o: { cwd: string; paths?: MemoryPaths },
): Promise<void> {
  const { trash, id } = parseRestoreArgs(args);
  const canon = canonicalDir(memoryDirFor(o.cwd, o.paths));
  if (!canon) {
    ctx.ui.notify(`no memory directory for ${o.cwd}`, "warning");
    return;
  }

  if (trash) {
    if (!id) {
      const entries = listTrashEntries(canon.real);
      ctx.ui.notify(
        entries.length > 0 ? entries.map((e) => `  ${e.id} — ${e.name}`).join("\n") : "trash is empty",
        "info",
      );
      return;
    }
    const entry = listTrashEntries(canon.real).find((e) => e.id === id);
    if (!entry) {
      ctx.ui.notify(`no trash entry ${id}`, "warning");
      return;
    }
    let decision: "overwrite" | "skip" = "skip";
    if (statRegularIfExists(canon.real, entry.name) !== undefined) {
      const choice = await ctx.ui.select(`restore --trash ${id} · ${entry.name} already exists`, [
        "Overwrite (back up current)",
        "Skip",
      ]);
      decision = choice === "Overwrite (back up current)" ? "overwrite" : "skip";
    }
    const result = await restoreFromTrash(o.cwd, id, decision, o.paths);
    if (!result.restored) {
      ctx.ui.notify(`restore --trash: ${result.reason ?? "not restored"}`, "warning");
      return;
    }
    ctx.ui.notify(
      `restore --trash: restored ${entry.name}${result.backupId ? `; pre-restore backup .backup/${result.backupId}` : ""}`,
      "info",
    );
    return;
  }

  if (!id) {
    const backups = listBackups(canon.real);
    const trashEntries = listTrashEntries(canon.real);
    if (backups.length === 0 && trashEntries.length === 0) {
      ctx.ui.notify("no backups or trash entries", "info");
      return;
    }
    const lines = [
      ...backups.map((b) => `  ${b.id} — ${b.kind} · ${String(b.fileCount)} file(s) · ${b.createdAt}`),
      ...trashEntries.map((t) => `  (trash) ${t.id} — ${t.name}`),
    ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  let plan: RestorePlan;
  try {
    plan = planRestore(o.cwd, id, o.paths);
  } catch (err) {
    ctx.ui.notify(`restore: ${(err as Error).message}`, "warning");
    return;
  }

  const listText = plan.entries
    .map(
      (e) => `  ${e.name}${e.newName ? ` -> ${e.newName}` : ""} (${e.op})${e.conflict ? ` ⚠ ${e.reason ?? ""}` : ""}`,
    )
    .join("\n");
  const ok = await ctx.ui.confirm(`restore ${id}`, `Restore ${String(plan.entries.length)} file(s)?\n${listText}`);
  if (!ok) return;

  const decisions = new Map<string, RestoreDecision>();
  for (const e of plan.entries) {
    if (!e.conflict) {
      decisions.set(e.name, "restore");
      continue;
    }
    const choice = await ctx.ui.select(`restore ${e.name} ⚠ ${e.reason ?? "conflict"}`, [
      "Overwrite (current saved to the pre-restore backup)",
      "Skip",
    ]);
    decisions.set(e.name, choice === "Overwrite (current saved to the pre-restore backup)" ? "overwrite" : "skip");
  }

  let result: RestoreResult;
  try {
    result = await applyRestore(o.cwd, id, decisions, o.paths);
  } catch (err) {
    ctx.ui.notify(`restore: pre-restore backup failed, aborted — zero writes (${(err as Error).message})`, "warning");
    return;
  }

  const failedText =
    result.failed.length > 0
      ? `; failed ${String(result.failed.length)}: ${result.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}`
      : "";
  const preBackupText = result.preRestoreBackupId ? `; pre-restore backup .backup/${result.preRestoreBackupId}` : "";
  ctx.ui.notify(
    `restore: restored ${String(result.restored.length)}, skipped ${String(result.skipped.length)} (conflict)${failedText}${preBackupText}`,
    "info",
  );
}
