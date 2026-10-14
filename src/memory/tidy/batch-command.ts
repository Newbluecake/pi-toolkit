import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveWorktreeOrigin } from "../../core/worktree-origin.js";
import type { RunOutcome } from "../../core/types.js";
import type { TidyPort, TidyProposal, TidyOwner, Ident, Loc } from "../contracts.js";
import { TIDY_SCHEMA } from "../contracts.js";
import {
  canonicalDir,
  listDirNames,
  listRegular,
  observeLoc,
  openRunDirs,
  readRegular,
  readEpoch,
  bumpEpoch,
  lockBreak,
} from "../safe-fs.js";
import { memoryDirFor, type MemoryPaths, MemoryError } from "../paths.js";
import { snapshotMemoryDir, sha256Hex, type TidySnapshot, type TidySnapshotFile } from "./snapshot.js";
import { selectArchiveCandidates } from "./archive-signals.js";
import { editIndex } from "./index-edit.js";
import {
  fmtKiB,
  selectedTotal,
  selectionAction,
  selectionItems,
  reduceSelection,
  type SelectionState,
} from "./selection.js";
import { openSelectionView, SelectionViewModel } from "./selection-view.js";
import { planBatches, overheadFloorBytes, type BatchCandidate } from "./batch-plan.js";
import { createLedger, reserve, settle } from "./run-ledger.js";
import type { TidyBatchSettings } from "./batch-settings.js";
import { buildTidyPrompt } from "./prompt.js";
import { validateTidyProposal } from "./validate.js";
import { estimateTidyUsd, isPricedRates, tidyRatesFromModelCost } from "./cost.js";
import { newTidyId, parseManifestStrict, readManifestV2 } from "./manifest.js";
import { runTransaction, recoverRun, type TxnOperation } from "./txn.js";
import {
  leaseBreak,
  leaseCreate,
  leaseOwnerAlive,
  leaseRead,
  leaseRefresh,
  leaseRelease,
  makeLeasePayload,
  type LeasePayload,
} from "./lease.js";
import { withMemoryDirLock } from "../lock.js";
import { isWebInvocation } from "../../web-hub/agent/command-capture.js";
import { showBoundedViewer } from "./ui/bounded-viewer.js";

const DIALOG_MAX_MS = 600_000;
const UI_TOTAL_MS = 3_600_000;
const MIN_DISPATCH_REMAINING_MS = 60_000;

type BatchArgs = {
  batch: boolean;
  dryRun: boolean;
  status: boolean;
  breakLock: boolean;
  triage: boolean;
  archiveOnly: boolean;
  files: string[];
};
function parseBatchArgs(raw: string): BatchArgs {
  const tokens = raw.trim().split(/\s+/u).filter(Boolean);
  const flags = new Set(tokens.filter((x) => x.startsWith("--")));
  return {
    batch: flags.has("--batch"),
    dryRun: flags.has("--dry-run"),
    status: flags.has("--status"),
    breakLock: flags.has("--break-lock"),
    triage: flags.has("--triage"),
    archiveOnly: flags.has("--archive-only"),
    files: tokens.filter((x) => !x.startsWith("--")),
  };
}
export interface BatchTiming {
  readonly startedAt: number;
  dialogMs: number;
  uiMs: number;
}
function newBatchTiming(): BatchTiming {
  return { startedAt: Date.now(), dialogMs: 0, uiMs: 0 };
}
function remainingActivityMs(timing: BatchTiming, totalMs: number): number {
  return Math.max(0, totalMs - (Date.now() - timing.startedAt - timing.dialogMs));
}
function beginDialog(timing: BatchTiming): { signal: AbortSignal; close: () => void } {
  if (timing.uiMs >= UI_TOTAL_MS) return { signal: AbortSignal.abort(), close: () => undefined };
  const controller = new AbortController();
  const started = Date.now();
  let closed = false;
  const timer = setTimeout(() => controller.abort(), DIALOG_MAX_MS);
  timer.unref?.();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    timing.uiMs += elapsed;
    timing.dialogMs += elapsed;
    if (timing.uiMs >= UI_TOTAL_MS) controller.abort();
  };
  return { signal: controller.signal, close };
}
async function withDialog<T>(timing: BatchTiming, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (timing.uiMs >= UI_TOTAL_MS) return undefined;
  const slot = beginDialog(timing);
  try {
    return await fn(slot.signal);
  } finally {
    slot.close();
  }
}

export interface BatchLeaseState {
  dir: string;
  payload: LeasePayload;
}
function refreshBatchLease(state: BatchLeaseState, draining: readonly string[] = state.payload.draining): void {
  state.payload = { ...state.payload, draining: [...draining], at: Date.now() };
  if (!leaseRefresh(state.dir, state.payload)) throw new MemoryError("memory directory lease was lost");
}

function asIdent(value: ReturnType<typeof observeLoc>): Ident | undefined {
  return value.kind === "file" ? { dev: value.dev, ino: value.ino, sha: value.sha, size: value.size } : undefined;
}
function locKey(loc: Loc): string {
  return loc.area === "tmp" ? `tmp:${loc.within}:${loc.name}` : `${loc.area}:${loc.name}`;
}
function nonce(): string {
  return randomBytes(4).toString("hex");
}
function owner(): TidyOwner {
  const lease = makeLeasePayload();
  return {
    pid: lease.pid,
    host: lease.host,
    token: lease.token,
    at: lease.at,
    ...(lease.startTicks === undefined ? {} : { startTicks: String(lease.startTicks) }),
    ...(lease.bootId === undefined ? {} : { bootId: lease.bootId }),
  };
}
function modelRef(
  ctx: ExtensionCommandContext,
  settings: { model: string },
): { provider: string; id: string } | undefined {
  const match = /^([^/]+)\/([^/]+)$/.exec(settings.model);
  if (match?.[1] && match[2]) return { provider: match[1], id: match[2] };
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

/** Recover abandoned v2 runs before starting new work. This is intentionally
 * called only from an interactive mutating command; --status remains read-only. */
export async function recoverInterruptedRuns(dir: string): Promise<readonly string[]> {
  const backupRoot = `${dir}/.backup`;
  const ids = listDirNames(backupRoot);
  const recovered: string[] = [];
  await withMemoryDirLock(dir, () => {
    for (const id of ids) {
      let dirs;
      try {
        dirs = openRunDirs(dir, id, { createArchive: false, createBackup: false });
      } catch {
        continue;
      }
      const manifest = readManifestV2(dirs, id);
      const run = manifest?.events
        .slice()
        .reverse()
        .find((e) => e.ev === "run");
      if (
        !manifest ||
        !run ||
        (run.ev === "run" &&
          (run.state === "complete" ||
            run.state === "aborted" ||
            run.state === "recovered" ||
            run.state === "conflict-reported"))
      )
        continue;
      const lease = leaseRead(dir);
      if (lease && leaseOwnerAlive(lease) !== false) continue;
      if (lease && leaseOwnerAlive(lease) === false) leaseBreak(dir);
      const epoch = readEpoch(dirs);
      const token = makeLeasePayload(epoch, [id]);
      if (!leaseCreate(dir, token)) continue;
      try {
        recoverRun(dirs, id, { epoch, owner: owner() });
        recovered.push(id);
      } finally {
        leaseRelease(dir, token.token);
      }
    }
  });
  return recovered;
}

function invalidManifestIds(dir: string): { id: string; reason: string }[] {
  const invalid: { id: string; reason: string }[] = [];
  for (const id of listDirNames(`${dir}/.backup`)) {
    try {
      const dirs = openRunDirs(dir, id, { createArchive: false, createBackup: false });
      const rawText = readRegular(dirs.backup.path, "manifest.json").text;
      const raw = JSON.parse(rawText) as { v?: unknown };
      if (raw.v === 2) {
        try {
          parseManifestStrict(raw, id);
        } catch (err) {
          invalid.push({ id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch {
      // A directory without a readable v2 manifest is left to other status surfaces.
    }
  }
  return invalid;
}

function statusText(dir: string): string {
  const lease = leaseRead(dir);
  const leaseLine = lease
    ? `lease: pid ${lease.payload.pid} on ${lease.payload.host} since ${new Date(lease.payload.at).toISOString()}${lease.payload.draining.length ? ` draining ${lease.payload.draining.join(",")}` : ""}`
    : "lease: free";
  // Read-only: a stale or foreign directory lock blocks every memory write, so --status shows its
  // holder too (only `/mem tidy --break-lock` may clear it, M-T4).
  const lockHolder = lockReadText(dir);
  const rows: string[] = [lockHolder === "none" ? "lock: free" : `lock: ${lockHolder}`, leaseLine];
  const invalid: { id: string; reason: string }[] = [];
  for (const id of listDirNames(`${dir}/.backup`)) {
    let dirs;
    try {
      dirs = openRunDirs(dir, id, { createArchive: false, createBackup: false });
    } catch {
      continue;
    }
    const raw = (() => {
      try {
        return JSON.parse(readRegular(dirs.backup.path, "manifest.json").text) as unknown;
      } catch {
        return undefined;
      }
    })();
    const manifest = readManifestV2(dirs, id);
    if (!manifest) {
      try {
        parseManifestStrict(raw, id);
      } catch (err) {
        invalid.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    const run = manifest.events
      .slice()
      .reverse()
      .find((e) => e.ev === "run");
    if (run?.ev === "run") rows.push(`run ${id}: ${run.state}`);
  }
  if (invalid.length)
    rows.push(`invalid manifest: ${invalid.map((entry) => `${entry.id} (${entry.reason})`).join(", ")}`);
  return rows.join("\n");
}

function formatRevokedMessage(id: string, oldEpoch: number, newEpoch: number): string {
  return `tidy run ${id} stopped: ownership was revoked by /mem tidy --break-lock (epoch ${oldEpoch} → ${newEpoch}) at ${new Date().toISOString()}. Nothing more was written by this run; its journal will be recovered by the next /mem tidy --batch.`;
}
function epochRevoked(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "EPOCH_REVOKED",
  );
}
function revokedMessage(id: string, dir: string, oldEpoch = Math.max(0, readEpoch(dir) - 1)): string {
  return formatRevokedMessage(id, oldEpoch, readEpoch(dir));
}

async function breakLockCommand(ctx: ExtensionCommandContext, dir: string, timing: BatchTiming): Promise<void> {
  if (ctx.mode !== "tui" || isWebInvocation(ctx)) {
    ctx.ui.notify("/mem tidy --break-lock needs the terminal UI", "warning");
    return;
  }
  const lock = `${dir}/.lock`;
  const lease = leaseRead(dir);
  const holder = lockReadText(dir);
  const message = `lock: ${holder}\nlease: ${lease ? `pid ${lease.payload.pid} on ${lease.payload.host}` : "none"}\nBreak the lock and revoke the current owner?`;
  const confirmed = await withDialog(timing, (signal) => ctx.ui.confirm("Break memory lock", message, { signal }));
  if (!confirmed) return;
  const old = readEpoch(dir);
  const next = bumpEpoch(dir, { pid: process.pid, host: hostname() });
  const broken = lockBreak(dir);
  const leaseBroken = leaseBreak(dir);
  ctx.ui.notify(
    `${broken ? "lock broken" : "lock not found"}; owner epoch ${old} → ${next}${leaseBroken ? "; lease broken" : ""}; run will be recovered on the next /mem tidy --batch`,
    "info",
  );
}
function lockReadText(dir: string): string {
  let raw: string;
  try {
    raw = readRegular(dir, ".lock").text;
  } catch {
    return "none";
  }
  try {
    const p = JSON.parse(raw) as { pid?: number; host?: string; at?: number };
    return p.pid && p.host
      ? `pid ${p.pid} on ${p.host} since ${p.at ? new Date(p.at).toISOString() : "unknown"}`
      : "unknown owner";
  } catch {
    return "unknown owner";
  }
}

async function selectArchives(
  ctx: ExtensionCommandContext,
  snap: TidySnapshot,
  deadline: BatchTiming,
): Promise<readonly TidySnapshotFile[]> {
  const archiveDir = `${snap.dir}/archive`;
  const conflicts = new Set(listDirNames(archiveDir));
  const candidates = selectArchiveCandidates(snap.files, { now: Date.now(), conflicts }).map((x) => ({
    name: x.file.name,
    bytes: x.file.size,
    signals: x.signal.signals,
    suggested: x.signal.suggested,
    reason: x.signal.reason,
    conflict: x.conflict,
  }));
  if (!candidates.length) return [];
  let state: SelectionState = {
    candidates,
    selected: new Set(candidates.filter((x) => x.suggested && !x.conflict).map((x) => x.name)),
  };
  // The custom overlay keeps the cursor in place across toggles; the bounded
  // select loop (no initial-cursor parameter in pi's dialog options) is the
  // fallback for hosts without ctx.ui.custom (or with an inert one).
  if (typeof ctx.ui.custom === "function") return selectArchivesOverlay(ctx, snap, deadline, state);
  return selectArchivesSelectLoop(ctx, snap, deadline, state);
}

async function selectArchivesSelectLoop(
  ctx: ExtensionCommandContext,
  snap: TidySnapshot,
  deadline: BatchTiming,
  initial: SelectionState,
): Promise<readonly TidySnapshotFile[]> {
  let state = initial;
  const candidates = initial.candidates;
  for (;;) {
    const items = selectionItems(state);
    const choice = await withDialog(deadline, (signal) =>
      ctx.ui.select(
        "Archive memory files",
        items.map((x) => x.label),
        { signal },
      ),
    );
    const action = selectionAction(items, choice);
    if (action.kind === "cancel") return [];
    if (action.kind === "view") {
      const picked = await withDialog(deadline, (signal) =>
        ctx.ui.select(
          "View a file",
          candidates.map((x, i) => `${String(i + 1).padStart(2, "0")} ${x.name}`),
          { signal },
        ),
      );
      const name = picked ? candidates.find((x) => picked.endsWith(x.name))?.name : undefined;
      const file = name ? snap.files.find((x) => x.name === name) : undefined;
      if (file && typeof ctx.ui.custom === "function") {
        const viewed = await withDialog(deadline, (signal) =>
          showBoundedViewer(ctx.ui, file.name, file.body, { signal }),
        );
        void viewed;
      }
      continue;
    }
    if (action.kind === "continue") {
      const selected = snap.files.filter((x) => state.selected.has(x.name));
      const bytes = selected.reduce((sum, x) => sum + x.size, 0);
      const confirmed = await withDialog(deadline, (signal) =>
        ctx.ui.confirm("Archive selected files", `Move ${selected.length} files (${fmtKiB(bytes)}) to archive/?`, {
          signal,
        }),
      );
      if (confirmed) return selected;
      continue;
    }
    state = reduceSelection(state, action);
  }
}

/** Overlay variant: one `ui.custom` list per phase; view/confirm-cancel re-open with cursor intact. */
async function selectArchivesOverlay(
  ctx: ExtensionCommandContext,
  snap: TidySnapshot,
  deadline: BatchTiming,
  initial: SelectionState,
): Promise<readonly TidySnapshotFile[]> {
  const model = new SelectionViewModel(initial);
  for (;;) {
    const event = await withDialog(deadline, (signal) => openSelectionView(ctx.ui, model, { signal }));
    if (event === undefined) return selectArchivesSelectLoop(ctx, snap, deadline, model.state); // custom exists but never engaged
    if (event.kind === "cancel") return [];
    if (event.kind === "view") {
      const file = snap.files.find((x) => x.name === event.name);
      if (file) {
        const viewed = await withDialog(deadline, (signal) =>
          showBoundedViewer(ctx.ui, file.name, file.body, { signal }),
        );
        void viewed;
      }
      continue;
    }
    const total = selectedTotal(model.state);
    const confirmed = await withDialog(deadline, (signal) =>
      ctx.ui.confirm("Archive selected files", `Move ${total.files} files (${fmtKiB(total.bytes)}) to archive/?`, {
        signal,
      }),
    );
    if (confirmed) return snap.files.filter((x) => model.state.selected.has(x.name));
  }
}

async function applyArchives(
  dir: string,
  selected: readonly TidySnapshotFile[],
  leaseState: BatchLeaseState,
): Promise<Set<string>> {
  if (!selected.length) return new Set();
  const id = newTidyId(new Date(), process.pid, randomBytes(3).toString("hex"));
  const dirs = openRunDirs(dir, id, { createArchive: true, createBackup: true });
  const ops: TxnOperation[] = [];
  const archived = new Set<string>();
  for (const [index, file] of selected.entries()) {
    const source = observeLoc(dirs, { area: "live", name: file.name });
    const ident = asIdent(source);
    if (!ident || ident.sha !== file.sha256 || observeLoc(dirs, { area: "archive", name: file.name }).kind !== "absent")
      continue;
    ops.push({
      op: {
        prim: "MOVE",
        src: { area: "live", name: file.name },
        dst: { area: "archive", name: file.name },
        obj: ident,
      },
      seq: index + 1,
      phase: "archive",
    });
    archived.add(file.name);
  }
  if (!ops.length) return new Set();
  refreshBatchLease(leaseState);
  try {
    const result = await runTransaction(dir, {
      id,
      kind: "batch",
      phase: "archive",
      ops,
      probe: true,
      epoch: leaseState.payload.epoch,
      owner: owner(),
    });
    const done = new Set<string>();
    for (const [index, file] of selected.entries()) if (result.results[index]?.state === "done") done.add(file.name);
    return done;
  } catch (err) {
    if (epochRevoked(err)) throw new MemoryError(formatRevokedMessage(id, leaseState.payload.epoch, readEpoch(dir)));
    throw err;
  }
}

async function applyArchiveIndex(
  dir: string,
  done: ReadonlySet<string>,
  leaseState: BatchLeaseState,
): Promise<boolean> {
  if (!done.size) return false;
  const entries = listRegular(dir, { names: "v2" }).files.filter((x) => x.name.toLowerCase() === "memory.md");
  const id = newTidyId(new Date(), process.pid, randomBytes(3).toString("hex"));
  const dirs = openRunDirs(dir, id, { createArchive: true, createBackup: true });
  const ops: TxnOperation[] = [];
  const contents = new Map<string, string>();
  let seq = 1;
  const n = nonce();
  for (const entry of entries) {
    const body = readRegular(dir, entry.name).text;
    const edit = editIndex(body, done);
    if (edit.text === body) continue;
    const before = asIdent(observeLoc(dirs, { area: "live", name: entry.name }));
    if (!before) continue;
    const tmp: Loc = { area: "tmp", within: "live", name: `.pt-${n}-${seq}-c.tmp` };
    contents.set(locKey(tmp), edit.text);
    ops.push({
      op: {
        prim: "REPLACE",
        target: { area: "live", name: entry.name },
        before,
        afterSha: sha256Hex(edit.text),
        backup: { area: "backup", name: `s${seq}-${seq}-live--${entry.name}` },
        tmpBackup: { area: "tmp", within: "backup", name: `.pt-${n}-${seq}-b.tmp` },
        tmpContent: tmp,
      },
      seq,
      phase: "archive",
    });
    seq++;
  }
  // ARCHIVE.md is itself journaled. It is appended only after the MOVE
  // results are known, so a CAS-skipped archive never gains a dangling link.
  const archiveName = "ARCHIVE.md";
  const archiveLoc: Loc = { area: "archive", name: archiveName };
  const archiveObs = observeLoc(dirs, archiveLoc);
  const suffix = [...done]
    .sort()
    .map((name) => `- [${name}](${name})`)
    .join("\n");
  const archiveBody =
    archiveObs.kind === "file"
      ? `${readRegular(dirs.archive.path, archiveName).text}${suffix ? `${readRegular(dirs.archive.path, archiveName).text.endsWith("\n") ? "" : "\n"}${suffix}\n` : ""}`
      : `${suffix}\n`;
  if (suffix) {
    const archiveTmp: Loc = { area: "tmp", within: "archive", name: `.pt-${n}-${seq}-c.tmp` };
    contents.set(locKey(archiveTmp), archiveBody);
    if (archiveObs.kind === "file") {
      const before = asIdent(archiveObs);
      if (before)
        ops.push({
          op: {
            prim: "REPLACE",
            target: archiveLoc,
            before,
            afterSha: sha256Hex(archiveBody),
            backup: { area: "backup", name: `s${seq}-${seq}-archive--${archiveName}` },
            tmpBackup: { area: "tmp", within: "backup", name: `.pt-${n}-${seq}-b.tmp` },
            tmpContent: archiveTmp,
          },
          seq,
          phase: "archive",
        });
    } else if (archiveObs.kind === "absent") {
      ops.push({
        op: { prim: "CREATE", target: archiveLoc, afterSha: sha256Hex(archiveBody), tmpContent: archiveTmp },
        seq,
        phase: "archive",
      });
    }
    seq++;
  }
  if (!ops.length) return false;
  refreshBatchLease(leaseState);
  try {
    await runTransaction(dir, {
      id,
      kind: "batch",
      phase: "archive",
      ops,
      contents,
      probe: true,
      epoch: leaseState.payload.epoch,
      owner: owner(),
    });
    return true;
  } catch (err) {
    if (epochRevoked(err)) throw new MemoryError(formatRevokedMessage(id, leaseState.payload.epoch, readEpoch(dir)));
    throw err;
  }
}

export async function normalizeBatches(
  ctx: ExtensionCommandContext,
  snap: TidySnapshot,
  port: TidyPort,
  cwd: string,
  settings: TidyBatchSettings,
  memorySettings: {
    coreBytes: number;
    topicMaxBytes: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    agentType: string;
    model: string;
    timeoutMs: number;
    paths?: MemoryPaths;
  },
  deadlineAt: number,
  timing?: BatchTiming,
  leaseState?: BatchLeaseState,
): Promise<number> {
  const ref = modelRef(ctx, memorySettings);
  if (!ref) return 0;
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  const candidates: BatchCandidate[] = snap.files
    .filter((f) => !f.isPrimaryCore && !f.handWritten)
    .map((f) => ({ name: f.name, body: f.body, size: Buffer.byteLength(f.body, "utf8") }));
  let overhead = overheadFloorBytes;
  let plan = planBatches(candidates, {
    targetBytes: settings.targetBytes,
    maxInputBytes: memorySettings.maxInputBytes,
    headroomBytes: settings.targetBytes,
    topicMaxBytes: memorySettings.topicMaxBytes,
  });
  let batches = [...plan.batches];
  let ledger = createLedger(settings.maxTotalCostUsd);
  let runs = 0;
  let applied = 0;
  for (let i = 0; i < batches.length && runs < settings.maxModelRuns; i++) {
    const batch = batches[i];
    const remainingMs = timing ? remainingActivityMs(timing, deadlineAt) : Math.max(0, deadlineAt - Date.now());
    if (!batch || remainingMs < MIN_DISPATCH_REMAINING_MS) break;
    const files = batch.files
      .map((candidate) => snap.files.find((file) => file.name === candidate.name))
      .filter((file): file is TidySnapshotFile => file !== undefined);
    const prompt = buildTidyPrompt({
      cwd,
      files: files.map((f) => ({ name: f.name, body: f.body, isPrimaryCore: false, handWritten: false })),
      migrationMode: false,
      coreBytes: memorySettings.coreBytes,
      topicMaxBytes: memorySettings.topicMaxBytes,
      batch: {
        index: batch.index,
        total: plan.batches.length,
        otherNames: snap.files.map((f) => f.name).filter((n) => !files.some((f) => f.name === n)),
      },
    });
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    const rates = model ? tidyRatesFromModelCost(model.cost, Math.ceil((promptBytes + overhead) / 2)) : undefined;
    const priced = rates !== undefined && isPricedRates(rates);
    const est =
      priced && rates
        ? estimateTidyUsd({ promptBytes: promptBytes + overhead, maxOutputBytes: memorySettings.maxOutputBytes, rates })
        : 0;
    const runId = `batch-${String(i + 1)}`;
    const reservation = reserve(ledger, runId, est);
    if (priced && !reservation.ok) {
      ctx.ui.notify(`batch ${batch.index} not dispatched: bounded cost cap reached`, "warning");
      break;
    }
    if (reservation.ok) ledger = reservation.state;
    runs++;
    const spawned = await port.spawn({
      type: memorySettings.agentType,
      prompt,
      label: `mem-tidy-batch-${String(batch.index)}`,
      cwd,
      modelOverride: ref,
      thinkingOverride: "low",
      totalMs: Math.min(memorySettings.timeoutMs, Math.max(1, remainingMs - MIN_DISPATCH_REMAINING_MS)),
      schema: TIDY_SCHEMA,
      inputBudget: { maxInputTokens: Math.max(1, Math.floor((batch.bytes + overhead) / 2)), bytesPerToken: 2 },
      toolDomain: "readonly",
      expectAck: true,
      suppressDelivery: true,
    });
    if ("error" in spawned) {
      if (reservation.ok) ledger = settle(ledger, { runId, costUsd: Number.NaN, estimatedUsd: est }).state;
      ctx.ui.notify(`batch ${batch.index} failed: ${spawned.error.message}`, "warning");
      continue;
    }
    if (leaseState) refreshBatchLease(leaseState, [spawned.runId]);
    const waited = await port.waitOutcome(
      spawned.runId,
      Math.min(
        memorySettings.timeoutMs + 15_000,
        Math.max(1, timing ? remainingActivityMs(timing, deadlineAt) : deadlineAt - Date.now()),
      ),
    );
    let outcome: RunOutcome | undefined = waited.kind === "settled" ? waited.outcome : undefined;
    if (!outcome) {
      await port.abort(spawned.runId, "timeout");
      const drained = await port.waitOutcome(spawned.runId, 15_000);
      outcome = drained.kind === "settled" ? drained.outcome : undefined;
      if (!outcome && leaseState) {
        refreshBatchLease(leaseState, [spawned.runId]);
        void port.waitOutcome(spawned.runId, memorySettings.timeoutMs + 30_000).then((late) => {
          if (late.kind === "settled") {
            try {
              refreshBatchLease(leaseState, []);
              leaseRelease(leaseState.dir, leaseState.payload.token);
            } catch {
              /* owner may have exited */
            }
          }
        });
      }
    }
    if (outcome && leaseState) refreshBatchLease(leaseState, []);
    if (reservation.ok)
      ledger = settle(ledger, { runId, costUsd: outcome?.usage?.costUsd ?? Number.NaN, estimatedUsd: est }).state;
    if (!outcome || outcome.status !== "completed" || outcome.structuredResult === undefined) {
      if (!outcome) {
        ctx.ui.notify(`batch ${batch.index} aborted but did not settle; remaining batches withheld`, "warning");
        break;
      }
      const failure = outcome.error?.message ?? "no terminal proposal";
      // A measured input-budget rejection is evidence that dispatch overhead
      // was larger than the planning floor. Re-split the failed batch before
      // spending another model run; a one-file batch is reported instead of
      // being retried forever.
      if (/input-budget/i.test(failure) && files.length > 1 && runs < settings.maxModelRuns) {
        const measured = /measured\s+(\d+)\s+tokens/iu.exec(failure)?.[1];
        if (measured !== undefined) {
          const measuredBytes = Number(measured) * 2;
          if (Number.isFinite(measuredBytes)) overhead = Math.max(overhead, Math.max(0, measuredBytes - promptBytes));
        }
        const learnedHeadroom = Math.max(1, settings.targetBytes - overhead);
        const split = planBatches(
          files.map((file) => ({ name: file.name, body: file.body, size: file.size })),
          {
            targetBytes: Math.max(1, Math.min(Math.floor(batch.bytes / 2), learnedHeadroom)),
            maxInputBytes: memorySettings.maxInputBytes,
            headroomBytes: learnedHeadroom,
            topicMaxBytes: memorySettings.topicMaxBytes,
          },
        );
        batches.splice(i, 1, ...split.batches);
        i--;
      }
      ctx.ui.notify(`batch ${batch.index} discarded: ${failure}`, "warning");
      continue;
    }
    const proposal = outcome.structuredResult as TidyProposal;
    const original = new Map(files.map((f) => [f.name, f]));
    const checked = validateTidyProposal(proposal, {
      original,
      coreBytes: memorySettings.coreBytes,
      topicMaxBytes: memorySettings.topicMaxBytes,
      maxOutputBytes: memorySettings.maxOutputBytes,
    });
    if (!checked.ok) {
      ctx.ui.notify(`batch ${batch.index} discarded: invalid proposal`, "warning");
      continue;
    }
    const targets = proposal.files.filter((f) => f.action !== "keep");
    const choice = await withDialog(timing ?? newBatchTiming(), (signal) =>
      ctx.ui.select(
        `Batch ${batch.index}: review ${targets.length} suggestion(s)`,
        [`Apply suggested (${targets.length})`, "View diff…", "Discard all"],
        { signal },
      ),
    );
    if (choice !== `Apply suggested (${targets.length})`) continue;
    const decisions = new Map(targets.map((f) => [f.name, "apply" as const]));
    const result = await (
      await import("./apply.js")
    ).applyTidy({
      cwd,
      proposal,
      decisions,
      originalSha: new Map(files.map((f) => [f.name, f.sha256])),
      kind: "tidy",
      nowIso: new Date().toISOString(),
      ...(memorySettings.paths === undefined ? {} : { paths: memorySettings.paths }),
      ...(leaseState === undefined ? {} : { lease: leaseState.payload }),
    });
    applied += result.applied.length;
    if (outcome.diag?.dispatchMeasure?.payloadBytes !== undefined)
      overhead = Math.max(overhead, outcome.diag.dispatchMeasure.payloadBytes - promptBytes);
  }
  return applied;
}

export interface BatchCommandDeps {
  paths?: MemoryPaths;
  settings: {
    tidy: {
      batch: TidyBatchSettings;
      maxInputBytes: number;
      maxOutputBytes: number;
      maxCostUsd: number;
      maxTurns: number;
      timeoutMs: number;
      agentType: string;
      model: string;
    };
    coreBytes: number;
    topicMaxBytes: number;
  };
  port?: TidyPort;
  onAfterWrite?: (cwd: string) => void;
}

export async function handleBatchTidyCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: BatchCommandDeps,
): Promise<void> {
  const parsed = parseBatchArgs(args);
  const cwd = resolveWorktreeOrigin(ctx.cwd) ?? ctx.cwd;
  const display = memoryDirFor(cwd, deps.paths);
  const canon = canonicalDir(display);
  if (!canon) {
    ctx.ui.notify(`no memory directory for ${cwd}`, "warning");
    return;
  }
  const timing = newBatchTiming();
  if (parsed.breakLock) {
    await breakLockCommand(ctx, canon.real, timing);
    return;
  }
  if (!parsed.batch) return;
  if (!deps.settings.tidy.batch.enabled) {
    ctx.ui.notify("memory tidy batch is disabled", "warning");
    return;
  }
  if (parsed.triage) {
    ctx.ui.notify("memory tidy --batch --triage is not available yet (P3b optional)", "warning");
    return;
  }
  if (parsed.status) {
    ctx.ui.notify(statusText(canon.real), "info");
    return;
  }
  if (ctx.mode === "print") {
    ctx.ui.notify("memory tidy --batch is unavailable in print mode", "warning");
    return;
  }
  if (ctx.mode !== "tui" || isWebInvocation(ctx)) {
    if (!parsed.dryRun && !parsed.status) {
      ctx.ui.notify("memory tidy --batch needs the terminal UI; --dry-run and --status work here", "warning");
      return;
    }
  }
  if (!parsed.dryRun) {
    await recoverInterruptedRuns(canon.real);
    const invalid = invalidManifestIds(canon.real);
    if (invalid.length) {
      ctx.ui.notify(
        `tidy --batch refused: invalid manifest ${invalid.map((entry) => `${entry.id} (${entry.reason})`).join(", ")}`,
        "warning",
      );
      return;
    }
  }
  let snap: TidySnapshot;
  try {
    snap = snapshotMemoryDir(cwd, {
      ...(parsed.files.length ? { names: parsed.files } : { includeArchived: true }),
      ...(deps.paths ? { paths: deps.paths } : {}),
    });
  } catch (err) {
    ctx.ui.notify(`memory tidy --batch: ${(err as Error).message}`, "warning");
    return;
  }
  if (parsed.dryRun) {
    const candidates = selectArchiveCandidates(snap.files, { now: Date.now() });
    const plan = planBatches(
      snap.files.filter((f) => !f.handWritten).map((f) => ({ name: f.name, body: f.body, size: f.size })),
      {
        targetBytes: deps.settings.tidy.batch.targetBytes,
        maxInputBytes: deps.settings.tidy.maxInputBytes,
        headroomBytes: deps.settings.tidy.batch.targetBytes,
      },
    );
    ctx.ui.notify(
      `tidy --batch --dry-run: archive candidates ${candidates.length}; normalize batches ${plan.batches.length}; reported ${plan.reported.length}`,
      "info",
    );
    return;
  }
  const leasePayload = makeLeasePayload(readEpoch(canon.real), []);
  if (!leaseCreate(canon.real, leasePayload)) {
    ctx.ui.notify("memory directory already has an active tidy run", "warning");
    return;
  }
  const leaseState: BatchLeaseState = { dir: canon.real, payload: leasePayload };
  try {
    const dialog = timing;
    const selected = await selectArchives(ctx, snap, dialog);
    let archived: Set<string>;
    try {
      archived = await applyArchives(snap.dir, selected, leaseState);
      if (archived.size > 0) deps.onAfterWrite?.(cwd);
      const indexChanged = await applyArchiveIndex(snap.dir, archived, leaseState);
      if (indexChanged) deps.onAfterWrite?.(cwd);
    } catch (err) {
      if (epochRevoked(err) || (err instanceof Error && /ownership was revoked/u.test(err.message))) {
        const runMatch = /tidy run ([0-9]{8}T[0-9]{9}Z-[0-9]+-[0-9a-f]{6})/u.exec(String(err));
        ctx.ui.notify(
          runMatch?.[1] ? (err instanceof Error ? err.message : revokedMessage(runMatch[1], snap.dir)) : String(err),
          "warning",
        );
        return;
      }
      throw err;
    }
    let normalized = 0;
    if (!parsed.archiveOnly && deps.port) {
      const fresh = snapshotMemoryDir(cwd, { ...(deps.paths ? { paths: deps.paths } : {}) });
      normalized = await normalizeBatches(
        ctx,
        fresh,
        deps.port,
        cwd,
        deps.settings.tidy.batch,
        {
          ...deps.settings.tidy,
          coreBytes: deps.settings.coreBytes,
          topicMaxBytes: deps.settings.topicMaxBytes,
          ...(deps.paths === undefined ? {} : { paths: deps.paths }),
        },
        deps.settings.tidy.batch.totalTimeoutMs,
        timing,
        leaseState,
      );
      if (normalized > 0) deps.onAfterWrite?.(cwd);
    }
    if (archived.size || normalized)
      ctx.ui.notify(`tidy --batch: archived ${archived.size}, normalized ${normalized}`, "info");
    else ctx.ui.notify("tidy --batch: no changes", "info");
  } finally {
    if (leaseState.payload.draining.length === 0) leaseRelease(leaseState.dir, leaseState.payload.token);
  }
}

export const formatTidyRevokedMessage = formatRevokedMessage;

export const parseTidyBatchArgs = parseBatchArgs;
