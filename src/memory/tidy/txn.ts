// P2b journaled transaction executor.  The executor is deliberately small and
// synchronous at the filesystem boundary: callers hold the memory directory
// lock while invoking it.  All recovery decisions are delegated to the pure
// journal truth table; this module only observes, performs identity-checked
// primitives, and appends events.
import { randomBytes } from "node:crypto";
import {
  observeLoc,
  openRunDirs,
  probeHardlinks,
  readRegular,
  resolveLoc,
  unlinkObservedLoc,
  moveLocNoClobber,
  createLocExclusive,
  replaceLocAtomic,
  type RunDirs,
  type TxnFsError,
} from "../safe-fs.js";
import { withMemoryDirLock } from "../lock.js";
import type {
  Ident,
  JournalEvent,
  Loc,
  Obs,
  OpSpec,
  Owner,
  Phase,
  TidyManifestV2,
  TidyRunState,
} from "../contracts.js";
import { decide, foldEvents, isTerminalState, type JournalAction, type Verdict } from "./journal.js";
import { appendJournal, createManifestV2, manifestPath, readManifestV2 } from "./manifest.js";

export const BLOCK_BUDGET_MS = 2_000;
export const MAX_OPS_PER_BLOCK = 20;

export class TxnCrash extends Error {
  readonly causeValue: unknown;
  constructor(cause: unknown) {
    super("transaction crash injection");
    this.name = "TxnCrash";
    this.causeValue = cause;
  }
}

export interface TxnHookContext {
  opId: string;
  event?: JournalEvent;
  op?: OpSpec;
}
export interface TxnHooks {
  /** Test/crash injection seam. Throwing simulates a process dying at a journal boundary. */
  onEvent?: (event: JournalEvent, context: TxnHookContext) => void;
  beforeAction?: (context: TxnHookContext) => void;
  afterAction?: (context: TxnHookContext) => void;
  beforeResult?: (context: TxnHookContext) => void;
}

export interface PlannedTxnOp {
  opId: string;
  seq: number;
  step: number;
  group?: number;
  phase: Phase;
  op: OpSpec;
}
export interface TxnRunOptions {
  id: string;
  kind?: TidyManifestV2["kind"];
  phase?: Phase;
  epoch?: number;
  owner?: Owner;
  hooks?: TxnHooks;
  /** Content addressed by a tmp or target location. */
  contents?: ReadonlyMap<string, Buffer | string>;
  createArchive?: boolean;
  createBackup?: boolean;
  probe?: boolean;
  /** Full operation plan recorded in the initial run event before intents. */
  planned?: readonly PlannedTxnOp[];
  /** Caller-supplied continuation plan for a legacy manifest without `planned`. */
  ops?: readonly TxnOperation[];
}
export interface RunStepOptions extends TxnRunOptions {
  dirs: RunDirs;
  ops: readonly TxnOperation[];
  step?: number;
}
export interface TxnOperation {
  opId?: string;
  seq?: number;
  group?: number;
  phase?: Phase;
  op: OpSpec;
}
export interface TxnRunResult {
  manifest: TidyManifestV2;
  results: readonly Extract<JournalEvent, { ev: "result" }>[];
  state: TidyRunState;
  /** Planned operations with no result; caller may resume with the same run id. */
  pending: readonly PlannedTxnOp[];
}

function cleanIdent(value: Ident & { kind?: "file" }): Ident {
  return { dev: value.dev, ino: value.ino, sha: value.sha, size: value.size };
}
function normalizeOp(op: OpSpec): OpSpec {
  if (op.prim === "MOVE") return { ...op, obj: cleanIdent(op.obj as Ident & { kind?: "file" }) };
  if (op.prim === "REPLACE") return { ...op, before: cleanIdent(op.before as Ident & { kind?: "file" }) };
  return op;
}
function key(loc: Loc): string {
  return loc.area === "tmp" ? `tmp:${loc.within}:${loc.name}` : `${loc.area}:${loc.name}`;
}
function event(hooks: TxnHooks | undefined, e: JournalEvent, context: TxnHookContext): void {
  try {
    hooks?.onEvent?.(e, context);
  } catch (err) {
    throw new TxnCrash(err);
  }
}
function hook(call: (() => void) | undefined): void {
  if (!call) return;
  try {
    call();
  } catch (err) {
    throw new TxnCrash(err);
  }
}
function identObs(obs: Obs): Ident | undefined {
  return obs.kind === "file" ? obs : undefined;
}
function allLocs(op: OpSpec): Loc[] {
  if (op.prim === "MOVE") return [op.src, op.dst];
  if (op.prim === "CREATE") return [op.target, op.tmpContent];
  return [op.target, op.backup, op.tmpBackup, op.tmpContent];
}
function observations(dirs: RunDirs, op: OpSpec): { loc: Loc; obs: Obs }[] {
  return allLocs(op).map((loc) => {
    try {
      return { loc, obs: observeLoc(dirs, loc) };
    } catch {
      return { loc, obs: { kind: "other", reason: "unreadable" } as Obs };
    }
  });
}
function bytesFor(contents: ReadonlyMap<string, Buffer | string> | undefined, loc: Loc): Buffer {
  const value = contents?.get(key(loc));
  if (value !== undefined) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  throw new Error(`transaction content is missing for ${key(loc)}`);
}
function sourceBytes(dirs: RunDirs, loc: Loc): Buffer {
  const resolved = resolveLoc(dirs, loc);
  return Buffer.from(readRegular(resolved.dir.path, resolved.name).text, "utf8");
}
function stagedFor(events: readonly JournalEvent[], opId: string): Extract<JournalEvent, { ev: "staged" }>[] {
  return events.filter((e): e is Extract<JournalEvent, { ev: "staged" }> => e.ev === "staged" && e.opId === opId);
}
function resultState(verdict: Verdict, skipped = false): Extract<JournalEvent, { ev: "result" }>["state"] {
  if (verdict.outcome === "conflict") return "conflict";
  if (skipped) return "skipped";
  return verdict.outcome === "roll-forward" ? "done" : "rolled-back";
}
function resultEvent(
  dirs: RunDirs,
  opId: string,
  op: OpSpec,
  verdict: Verdict,
  reason?: string,
  skipped = false,
): Extract<JournalEvent, { ev: "result" }> {
  return {
    ev: "result",
    opId,
    state: resultState(verdict, skipped),
    ...(reason ? { reason } : {}),
    final: observations(dirs, op),
    ...(verdict.leftovers.length ? { leftovers: verdict.leftovers } : {}),
  };
}
function appendChecked(
  dirs: RunDirs,
  id: string,
  e: JournalEvent,
  hooks: TxnHooks | undefined,
  context: TxnHookContext,
  epoch: number,
): TidyManifestV2 {
  const manifest = appendJournal(dirs, manifestPath(dirs, id), e, epoch);
  event(hooks, e, context);
  return manifest;
}

function performAction(
  dirs: RunDirs,
  op: OpSpec,
  staged: readonly Extract<JournalEvent, { ev: "staged" }>[],
  contents: ReadonlyMap<string, Buffer | string> | undefined,
  epoch: number,
  appendStaged: (e: Extract<JournalEvent, { ev: "staged" }>) => void,
): void {
  if (op.prim === "MOVE") {
    moveLocNoClobber(dirs, op.src, op.dst, op.obj, { epoch });
    return;
  }
  if (op.prim === "CREATE") {
    const bytes = bytesFor(contents, op.tmpContent);
    createLocExclusive(
      dirs,
      op.target,
      op.tmpContent,
      bytes,
      (ident) => appendStaged({ ev: "staged", opId: "", which: "content", tmp: op.tmpContent, ident }),
      { epoch },
    );
    return;
  }
  // A REPLACE always stages the old bytes in the backup before swapping the
  // live name.  The staged callback is patched by the caller with opId.
  const backupBytes = sourceBytes(dirs, op.target);
  createLocExclusive(
    dirs,
    op.backup,
    op.tmpBackup,
    backupBytes,
    (ident) => appendStaged({ ev: "staged", opId: "", which: "backup", tmp: op.tmpBackup, ident }),
    { epoch },
  );
  const after = bytesFor(contents, op.tmpContent);
  replaceLocAtomic(
    dirs,
    op.target,
    op.tmpContent,
    after,
    op.before,
    (ident) => appendStaged({ ev: "staged", opId: "", which: "content", tmp: op.tmpContent, ident }),
    { epoch },
  );
  void staged;
}

function applyVerdictActions(dirs: RunDirs, verdict: Verdict, epoch: number): void {
  for (const action of verdict.actions) {
    if (action.kind === "unlink") unlinkObservedLoc(dirs, action.loc, action.expect, { epoch });
  }
}

function plannedOf(input: RunStepOptions): PlannedTxnOp[] {
  return input.ops.map((item, index) => ({
    opId: item.opId ?? `${input.id}-op-${item.seq ?? index + 1}`,
    seq: item.seq ?? index + 1,
    step: input.step ?? 1,
    ...(item.group === undefined ? {} : { group: item.group }),
    phase: item.phase ?? input.phase ?? "normalize",
    op: normalizeOp(item.op),
  }));
}
function plannedFromRun(manifest: TidyManifestV2): PlannedTxnOp[] | undefined {
  const run = [...manifest.events].reverse().find((event) => event.ev === "run") as
    (Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedTxnOp[] }) | undefined;
  return run?.planned === undefined ? undefined : [...run.planned];
}
function ensureInitialManifest(
  dirs: RunDirs,
  options: TxnRunOptions,
  planned?: readonly PlannedTxnOp[],
): TidyManifestV2 {
  const existing = readManifestV2(dirs, options.id);
  if (existing) return existing;
  const epoch = options.epoch ?? 0;
  const run = {
    ev: "run" as const,
    state: "applying" as const,
    epoch,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(planned ? { planned } : {}),
  } as Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedTxnOp[] };
  return createManifestV2(dirs, options.id, options.kind ?? "batch", run);
}

/** Execute at most one bounded block.  A caller may call this repeatedly with
 * the same manifest; intents/results make the operation idempotent. */
export function runStep(input: RunStepOptions): TxnRunResult {
  const options = input as RunStepOptions;
  let manifest = ensureInitialManifest(input.dirs, options, plannedOf(input));
  const hooks = input.hooks;
  const epoch = input.epoch ?? foldEvents(manifest).epoch;
  const started = Date.now();
  let processed = 0;
  let stop = false;
  for (const item of input.ops) {
    if (stop || processed >= MAX_OPS_PER_BLOCK || Date.now() - started >= BLOCK_BUDGET_MS) break;
    const opId = item.opId ?? `${input.id}-op-${item.seq ?? processed + 1}`;
    const op = normalizeOp(item.op);
    const step = input.step ?? 1;
    const folded = foldEvents(manifest);
    if (folded.results.has(opId)) continue;
    const intent: Extract<JournalEvent, { ev: "intent" }> = {
      ev: "intent",
      opId,
      seq: item.seq ?? processed + 1,
      step,
      phase: item.phase ?? input.phase ?? "normalize",
      op,
      ...(item.group === undefined ? {} : { group: item.group }),
    };
    if (!folded.intents.has(opId)) {
      manifest = appendChecked(input.dirs, input.id, intent, hooks, { opId, op, event: intent }, epoch);
    }
    const current = foldEvents(manifest);
    const staged = stagedFor(manifest.events, opId);
    const obs = observations(input.dirs, op);
    const verdictBefore = decide({ intent, staged, observations: obs });
    const hasAttempt = current.attempts.has(opId);
    let verdict = verdictBefore;
    let reason: string | undefined;
    let skipped = false;
    try {
      if (hasAttempt) {
        // M-T3: an attempt is a one-shot fence. Recovery only observes.
        reason = "attempt already recorded; observation only";
      } else {
        const attempt: Extract<JournalEvent, { ev: "attempt" }> = { ev: "attempt", opId, by: "owner", n: 1 };
        manifest = appendChecked(input.dirs, input.id, attempt, hooks, { opId, op, event: attempt }, epoch);
        hook(hooks?.beforeAction ? () => hooks.beforeAction!({ opId, op }) : undefined);
        performAction(input.dirs, op, staged, input.contents, epoch, (s) => {
          const fixed = { ...s, opId } as Extract<JournalEvent, { ev: "staged" }>;
          manifest = appendChecked(input.dirs, input.id, fixed, hooks, { opId, op, event: fixed }, epoch);
        });
        hook(hooks?.afterAction ? () => hooks.afterAction!({ opId, op }) : undefined);
        verdict = decide({
          intent,
          staged: stagedFor(manifest.events, opId),
          observations: observations(input.dirs, op),
        });
      }
    } catch (err) {
      if (err instanceof TxnCrash) throw err;
      reason = err instanceof Error ? err.message : String(err);
      if (err && typeof err === "object" && "code" in err && (err as TxnFsError).code === "EPOCH_REVOKED") throw err;
      // A failed mutating primitive is resolved from observations.  Do not
      // retry its action: the attempt event is already the retry fence.
      const after = observations(input.dirs, op);
      verdict = decide({ intent, staged: stagedFor(manifest.events, opId), observations: after });
      const mutated = err && typeof err === "object" && "mutated" in err && (err as TxnFsError).mutated;
      if (mutated && verdict.actions.length > 0) {
        try {
          applyVerdictActions(input.dirs, verdict, epoch);
          verdict = decide({
            intent,
            staged: stagedFor(manifest.events, opId),
            observations: observations(input.dirs, op),
          });
        } catch (compensationError) {
          reason = `${reason}; compensation failed: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`;
          verdict = {
            ...verdict,
            outcome: "conflict",
            disposition: "conflict",
            kind: "conflict",
            leftovers: observations(input.dirs, op).filter((item) => item.obs.kind !== "absent"),
          };
        }
      }
      if (!mutated) skipped = true;
    }
    hooks?.beforeResult?.({ opId, op });
    // Final observation is authoritative, including mutations introduced by a
    // crash/test hook after the primitive's postcondition.
    verdict = decide({ intent, staged: stagedFor(manifest.events, opId), observations: observations(input.dirs, op) });
    const finalResult = resultEvent(input.dirs, opId, op, verdict, reason, skipped);
    manifest = appendChecked(input.dirs, input.id, finalResult, hooks, { opId, op, event: finalResult }, epoch);
    processed++;
    if (verdict.outcome === "conflict" || reason?.includes("DIR_SWAPPED") || reason?.includes("NO_HARDLINK"))
      stop = true;
  }
  const afterFold = foldEvents(manifest);
  const planned = plannedFromRun(manifest);
  const all = planned
    ? planned.every((item) => afterFold.results.has(item.opId))
    : [...afterFold.intents.keys()].every((id) => afterFold.results.has(id));
  const conflict = [...afterFold.results.values()].some((r) => r.state === "conflict");
  if (all && (planned ? planned.length > 0 : afterFold.intents.size > 0) && !isTerminalState(afterFold.run?.state)) {
    const finalState: Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedTxnOp[] } = {
      ev: "run",
      state: conflict ? "conflict-reported" : afterFold.run?.state === "interrupted" ? "recovered" : "complete",
      epoch,
      ...(planned ? { planned } : {}),
    };
    manifest = appendChecked(input.dirs, input.id, finalState, hooks, { opId: "run", event: finalState }, epoch);
  }
  const folded = foldEvents(manifest);
  const pending = (plannedFromRun(manifest) ?? []).filter((item) => !folded.results.has(item.opId));
  return { manifest, results: [...folded.results.values()], state: folded.run?.state ?? "applying", pending };
}

/** Start and execute a run while acquiring the directory lock.  `ops` are
 * intentionally supplied by the caller so planning remains pure. */
export async function runTransaction(liveReal: string, options: Omit<RunStepOptions, "dirs">): Promise<TxnRunResult> {
  const dirs = openRunDirs(liveReal, options.id, {
    createArchive: options.createArchive ?? true,
    createBackup: options.createBackup ?? true,
  });
  return withMemoryDirLock(liveReal, () => {
    if (options.probe !== false) probeHardlinks(dirs, { epoch: options.epoch ?? 0 });
    return runStep({ ...options, dirs });
  });
}

/** Recover an interrupted run.  A recovery owner may call this repeatedly;
 * once an attempt exists this function never invokes a mutating action for
 * that op, and therefore converges without retry loops. */
export function recoverRun(dirs: RunDirs, id: string, options: Omit<TxnRunOptions, "id"> = {}): TxnRunResult {
  let manifest = readManifestV2(dirs, id);
  if (!manifest) throw new Error(`no v2 manifest ${id}`);
  let folded = foldEvents(manifest);
  const epoch = options.epoch ?? folded.epoch;
  const results: Extract<JournalEvent, { ev: "result" }>[] = [];
  if (folded.run && !isTerminalState(folded.run.state) && folded.run.state !== "interrupted") {
    const interruptionPlan = plannedFromRun(manifest);
    const interrupted: Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedTxnOp[] } = {
      ev: "run",
      state: "interrupted",
      epoch,
      ...(options.owner ? { recoveryOwner: options.owner } : {}),
      ...(interruptionPlan ? { planned: interruptionPlan } : {}),
    };
    manifest = appendJournal(dirs, manifestPath(dirs, id), interrupted, epoch);
    folded = foldEvents(manifest);
  }
  for (const intent of folded.intents.values()) {
    if (foldEvents(manifest).results.has(intent.opId)) continue;
    let verdict = decide({
      intent,
      staged: stagedFor(manifest.events, intent.opId),
      observations: observations(dirs, intent.op),
    });
    let reason = "recovered by observation";
    const hadAttempt = foldEvents(manifest).attempts.has(intent.opId);
    if (hadAttempt && verdict.actions.length > 0) {
      reason = "attempt already recorded; recovery is observation-only";
      verdict = {
        ...verdict,
        outcome: "conflict",
        disposition: "conflict",
        kind: "conflict",
        leftovers: observations(dirs, intent.op).filter((x) => x.obs.kind !== "absent"),
      };
    } else if (!hadAttempt && verdict.actions.length > 0) {
      const attempt: Extract<JournalEvent, { ev: "attempt" }> = {
        ev: "attempt",
        opId: intent.opId,
        by: "recovery",
        n: 1,
      };
      manifest = appendJournal(dirs, manifestPath(dirs, id), attempt, epoch);
      try {
        applyVerdictActions(dirs, verdict, epoch);
        verdict = decide({
          intent,
          staged: stagedFor(manifest.events, intent.opId),
          observations: observations(dirs, intent.op),
        });
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
        verdict = {
          ...verdict,
          outcome: "conflict",
          disposition: "conflict",
          kind: "conflict",
          leftovers: observations(dirs, intent.op).filter((x) => x.obs.kind !== "absent"),
        };
      }
    }
    const final = resultEvent(dirs, intent.opId, intent.op, verdict, reason, false);
    manifest = appendJournal(dirs, manifestPath(dirs, id), final, epoch);
    results.push(final);
  }
  const end = foldEvents(manifest);
  const planned = plannedFromRun(manifest);
  const plannedComplete = planned ? planned.every((item) => end.results.has(item.opId)) : true;
  if (!isTerminalState(end.run?.state) && plannedComplete && (planned ? planned.length > 0 : end.intents.size > 0)) {
    const conflict = [...end.results.values()].some((r) => r.state === "conflict");
    const terminal: Extract<JournalEvent, { ev: "run" }> & { planned?: readonly PlannedTxnOp[] } = {
      ev: "run",
      state: conflict ? "conflict-reported" : "recovered",
      epoch,
      ...(planned ? { planned } : {}),
    };
    manifest = appendJournal(dirs, manifestPath(dirs, id), terminal, epoch);
  }
  const final = foldEvents(manifest);
  const pending = (plannedFromRun(manifest) ?? []).filter((item) => !final.results.has(item.opId));
  return { manifest, results: [...final.results.values()], state: final.run?.state ?? "recovered", pending };
}
