/** P50 F host kernel. Construct ONCE in the existing activation/client owner.
 * Consumes that owner's sole client, C/D/review/E. No hooks/timers/client/ledger
 * construction. Production wire, trusted binding and settings remain separate. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import type {
  ClassifierRegistryLike,
  FrozenRevisionBlock,
  FrozenRevisionInput,
  JevOutcome,
  RelationEvidence,
  RevisionAuditPort,
  RevisionProposal,
  RevisionRegistryLike,
} from "../jev/contracts.js";
import type { JevClientHandle } from "../jev/client.js";
import { readIndex } from "../jev/index-store.js";
import { entryHash } from "../jev/entries.js";
import { effectiveMeta } from "../jev/decide.js";
import { blockToEntry } from "../blocks/adapter.js";
import { parseBlockFile } from "../blocks/format.js";
import { readRegularBytes } from "../safe-fs.js";
import { withMemoryDirLock } from "../lock.js";
import type { IncrementalAttemptContext, IncrementalBatch } from "./incremental.js";
import { REVISION_RAW_MAX_BYTES, createRevisionAuditPort } from "./revision-audit.js";
import {
  freezeRevisionInputsLocked,
  planRevisionActions,
  prepareRevisionProposal,
  revisionBlockFromRaw,
  revisionCanonicalJson,
  revisionFrozenRelationDigest,
  revisionProposalMatchesInput,
  revisionInputRetainedBytes,
  validateRevisionProposal,
  type RevisionCustodyLifetime,
  revisionRelationContextForBlocks,
  type RevisionFreezeAction,
} from "./revision.js";
import { revisionSuggestionSuppressed, upsertRevisionSuggestion } from "./review-lite.js";
import { commitAction, type OwnedRevisionAction } from "./revision-commit.js";
import {
  buildRevisionDiscoveryPool,
  compareRevisionKeys,
  revisionPairKey,
  revisionRelationHints,
  revisionSourceKey,
  selectPairOutcome,
  selectRevisionWork,
  type DiscoveryPool,
  type FreshPairDirection,
  type SelectorBlock,
  type SelectorInput,
  type SelectorPage,
  type SelectorPlan,
} from "./revision-selector.js";

export const REVISION_HOST_POLICY_VERSION = "p50-selection-v1/selector-v1/action-v2";
export interface RevisionHostBinding {
  readonly registry: ClassifierRegistryLike & RevisionRegistryLike;
  readonly budgetMs: number;
  readonly maxOutputTokens: number;
}
/** Supplied by the existing actual owner, never by an attempt or JSON. */
export interface RevisionHostCustody extends RevisionCustodyLifetime {
  readonly owner: object;
  readonly manager: object;
  readonly epoch: number;
}
export const REVISION_HOST_CUSTODY_LIMITS = Object.freeze({
  actions: 16,
  directories: 8,
  actionBytes: 128 * 1024,
  totalBytes: 2 * 1024 * 1024,
});
export interface RevisionHostDeps {
  /** Existing unique client, not a factory. Guard lifetime MUST match it. */
  readonly client: JevClientHandle;
  /** Identity changes revoke in-flight work, including registry remaps. */
  binding(): RevisionHostBinding | undefined;
  /** Existing plain-main/enabled/scopes/owner/epoch/gate admission. */
  isCurrent(batch: IncrementalBatch): boolean;
  /** Existing client budget/capability admission, synchronous/read-only. */
  canAttempt(batch: IncrementalBatch): boolean;
  autoEnabled(): boolean;
  /** Optional actual-owner lifetime, captured BEFORE the first D freeze. I1
   * supplies this from the original scopes owner/manager, not running/lease. */
  custody?(batch: IncrementalBatch): RevisionHostCustody | undefined;
  readonly policyVersion?: string;
  readonly gate?: MemoryWriteGate;
  now(): Date;
  onAfterWrite(memDir: string, origin: "p50-auto"): void;
  diagnostic?(line: string): void;
}
export type RevisionWorkState =
  | "pending"
  | "in-flight"
  | "attempted-none"
  | "suggested"
  | "dismissed"
  | "failed"
  | "attempted-source"
  | "blocked-job"
  | "blocked-freeze";
interface Snapshot {
  readonly key: string;
  readonly input: SelectorInput;
  readonly pool: DiscoveryPool;
  readonly ordinary: Map<string, RevisionWorkState>;
  readonly sources: Map<string, RevisionWorkState>;
  sourceDiagnosed: boolean;
}
interface JobExecution {
  readonly capUsd: number;
  readonly binding: RevisionHostBinding;
  state: "running" | "settled" | "blocked-job" | "aborted";
  generateClaims: number;
}
export interface RevisionHostResult {
  readonly kind: "settled" | "revision-unavailable" | "cap-reached";
  readonly reason:
    | "done"
    | "pending"
    | "lock-busy"
    | "input-invalidated"
    | "empty-page"
    | "freeze-rejected"
    | "blocked-job"
    | "capacity"
    | "running";
  readonly batchId?: string;
  readonly menuSize?: number;
  readonly saved?: number;
  readonly effects?: number;
}
const hash = (v: unknown): string => createHash("sha256").update(revisionCanonicalJson(v)).digest("hex");
const rowKey = (a: RevisionFreezeAction): string =>
  JSON.stringify([a.action, a.target.id, a.target.rev, a.context?.id, a.context?.rev]);
const unavailable = (reason: RevisionHostResult["reason"]): RevisionHostResult => ({
  // Reuse the scheduler's existing dormant/evidence-preserving result. A
  // temporary host denial must not look like successful pending consumption.
  kind: ["pending", "lock-busy", "capacity", "blocked-job", "input-invalidated"].includes(reason)
    ? "cap-reached"
    : "revision-unavailable",
  reason,
});
class InputInvalidated extends Error {}
function validBudget(client: JevClientHandle): boolean {
  const b = client.usage().budget;
  return (
    !!b &&
    !b.disposed &&
    !b.exhausted &&
    b.zombies === 0 &&
    b.queued.background < 4 &&
    [b.settledCostUsd, b.reservedCostUsd, b.reservedCalls, b.outstanding].every((n) => Number.isFinite(n) && n >= 0)
  );
}
/** Digest expectations MUST be computed before ask. This parser never derives an
 * expected binding from the returned provenance or requested model identity. */
export function verifyRevisionPairDirection(
  outcome: JevOutcome,
  expected: { readonly requestDigest: string; readonly inputDigest: string },
): FreshPairDirection | undefined {
  if (
    !outcome.ok ||
    outcome.missing.length ||
    outcome.sources?.length !== 1 ||
    Object.keys(outcome.answers).length !== 1
  )
    return undefined;
  const s = outcome.sources[0]!,
    p = s.provenance,
    a = outcome.answers.revisionRelation;
  if (
    s.questionIds.length !== 1 ||
    s.questionIds[0] !== "revisionRelation" ||
    !p.trusted ||
    !p.provider ||
    !p.model ||
    !p.adapterId ||
    !p.chainVersion ||
    !p.requestChainId ||
    (p.canonicalProvider !== undefined && p.canonicalProvider !== p.provider) ||
    (p.canonicalModel !== undefined && p.canonicalModel !== p.model) ||
    !/^[a-f0-9]{64}$/.test(p.routeIdentity) ||
    !p.routeAliases.includes(`${p.provider}/${p.model}`) ||
    !p.routeAliases.includes(p.requestChainId) ||
    p.requestDigest !== expected.requestDigest ||
    p.inputDigest !== expected.inputDigest ||
    !a ||
    a.type !== "choice" ||
    !["conflict", "supersedes", "unrelated"].includes(a.choice)
  )
    return undefined;
  const probability = a.probabilities[a.choice];
  return probability !== undefined && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? { kind: a.choice as FreshPairDirection["kind"], p: probability }
    : undefined;
}
export function createRevisionHost(deps: RevisionHostDeps) {
  const snapshots = new Map<string, Snapshot>();
  // Incomplete source enumeration is NOT a complete empty discovery pool.
  // Only directory metadata is retained until the next natural opportunity;
  // pending directories and complete snapshots share the same eight slots.
  const pendingSourceDirectories = new Set<string>();
  // Non-evictable, non-fee execution fence. Reset never clears this live-client map.
  const jobs = new Map<string, JobExecution>();
  const retained = new Map<string, { mem: string; owned: OwnedRevisionAction; current(): boolean; bytes: number }>();
  const reservations = new Set<{ mem: string }>();
  // Separate scope from handle: this lifetime cannot retain an attempt or its
  // execution state. A host reset and actual-owner change both revoke it.
  function captureCustody(batch: IncrementalBatch): RevisionCustodyLifetime | undefined {
    const c = deps.custody?.(batch),
      generation = epoch;
    if (
      !c ||
      !c.owner ||
      !c.manager ||
      !["object", "function"].includes(typeof c.owner) ||
      !["object", "function"].includes(typeof c.manager) ||
      !(c.signal instanceof AbortSignal) ||
      !Number.isSafeInteger(c.epoch) ||
      c.epoch !== batch.directory.sessionEpoch
    )
      return undefined;
    const owner = c.owner,
      manager = c.manager,
      ownerEpoch = c.epoch,
      signal = c.signal;
    let revoked = false;
    const isCurrent = () => {
      if (revoked) return false;
      try {
        const now = deps.custody?.(batch);
        const valid =
          !closed &&
          epoch === generation &&
          !signal.aborted &&
          c.isCurrent() === true &&
          now?.owner === owner &&
          now.manager === manager &&
          now.epoch === ownerEpoch &&
          now.signal === signal &&
          now.isCurrent() === true &&
          !signal.aborted &&
          !closed &&
          epoch === generation;
        revoked = !valid;
        return valid;
      } catch {
        revoked = true;
        return false;
      }
    };
    return Object.freeze({ signal, isCurrent });
  }
  function discardRevoked(): void {
    for (const [id, r] of retained) if (!r.current()) retained.delete(id);
  }
  const policyVersion = deps.policyVersion ?? REVISION_HOST_POLICY_VERSION;
  let epoch = 0,
    running = false,
    closed = false;
  let ownedAdmission: { readonly batch: IncrementalBatch; recheck(): boolean } | undefined;
  const diagnostic = (line: string): void => {
    try {
      deps.diagnostic?.(line);
    } catch {
      /* no authority */
    }
  };
  const budget = (batch: IncrementalBatch): boolean => {
    try {
      return (
        Number.isFinite(batch.limits.jobCostCapUsd) &&
        batch.limits.jobCostCapUsd > 0 &&
        validBudget(deps.client) &&
        deps.canAttempt(batch) &&
        (deps.gate === undefined || deps.gate.check(batch.directory.realpath).ok)
      );
    } catch {
      return false;
    }
  };
  const current = (
    batch: IncrementalBatch,
    binding: RevisionHostBinding,
    generation: number,
    attempt: IncrementalAttemptContext,
  ): boolean => {
    try {
      return (
        !closed &&
        epoch === generation &&
        !attempt.signal.aborted &&
        attempt.isCurrent() &&
        deps.isCurrent(batch) &&
        deps.binding() === binding &&
        Number.isFinite(binding.budgetMs) &&
        binding.budgetMs > 0 &&
        Number.isSafeInteger(binding.maxOutputTokens) &&
        binding.maxOutputTokens > 0
      );
    } catch {
      return false;
    }
  };
  function readSnapshot(
    batch: IncrementalBatch,
    audit: RevisionAuditPort,
  ): { input: SelectorInput; raw: Map<string, FrozenRevisionBlock>; sourceAvailable: boolean } {
    const candidates = batch.corpus.candidates;
    if (candidates.length > 16 || new Set(candidates.map((s) => s.id)).size !== candidates.length)
      throw new InputInvalidated();
    const index = readIndex(batch.directory.realpath).index,
      raw = new Map<string, FrozenRevisionBlock>();
    const blocks: SelectorBlock[] = candidates.map((side) => {
      const bytes = readRegularBytes(join(batch.directory.realpath, "blocks"), `${side.id}.md`, {
        maxBytes: REVISION_RAW_MAX_BYTES,
      }).bytes;
      const frozen = revisionBlockFromRaw(side.id, bytes, side.rev);
      if (side.authority !== frozen.block.authority || side.topic !== frozen.block.topic) throw new InputInvalidated();
      raw.set(side.id, frozen);
      // Strict raw already validated. Reparse only for the exact adapter/inline tag identity.
      const parsed = parseBlockFile(`${side.id}.md`, bytes.toString("utf8"));
      if ("stray" in parsed || parsed.errors.length) throw new InputInvalidated();
      const entry = blockToEntry(parsed, ""),
        record = index.entries[entry.hash];
      const tags = effectiveMeta(entry, record?.file === entry.file ? record : undefined, {
        rev: "",
        types: [],
        importance: [],
        tags: [],
      }).tags;
      return { side: { ...side }, body: frozen.block.body, rawDigest: frozen.rawDigest, effectiveTags: tags };
    });
    const scan = audit.listRetireSourceHintsLocked?.();
    const sources =
      scan?.kind === "ok"
        ? scan.refs.flatMap((r) => {
            const old = blocks.find((b) => b.side.id === r.oldId && b.side.rev === r.oldRev),
              survivor = blocks.find((b) => b.side.id === r.survivorId && b.side.rev === r.survivorAfterRev);
            return old && survivor ? [{ old: old.side, survivor: survivor.side, source: r.source }] : [];
          })
        : [];
    return {
      input: { policyVersion, blocks, hints: revisionRelationHints(index, blocks), sources },
      raw,
      sourceAvailable: scan?.kind === "ok",
    };
  }
  async function handle(batch: IncrementalBatch, attempt: IncrementalAttemptContext): Promise<RevisionHostResult> {
    if (running) return unavailable("running");
    let binding: RevisionHostBinding | undefined;
    try {
      binding = deps.binding();
    } catch {
      return unavailable("pending");
    }
    const generation = epoch;
    if (!binding || !current(batch, binding, generation, attempt)) return unavailable("pending");
    // Capture exact registry and request limits, not just a potentially mutable
    // binding container. In-place remaps revoke this execution as well.
    const registry = binding.registry,
      maxOutputTokens = binding.maxOutputTokens,
      budgetMs = binding.budgetMs;
    running = true;
    let execution: JobExecution | undefined, snapshot: Snapshot | undefined, page: SelectorPage | undefined;
    const isCurrent = () =>
      current(batch, binding, generation, attempt) &&
      binding.registry === registry &&
      binding.maxOutputTokens === maxOutputTokens &&
      binding.budgetMs === budgetMs &&
      (!execution || execution.state === "running");
    const leaseValid = () => {
      try {
        return isCurrent() && attempt.leaseValid();
      } catch {
        return false;
      }
    };
    // Scheduler.tryStartGenerate reuses its original admission callback. It
    // must recheck THIS claimed batch while handle stays mutually exclusive;
    // a new/equal-looking batch must not inherit its ownership.
    ownedAdmission = { batch, recheck: () => execution !== undefined && isCurrent() && leaseValid() && budget(batch) };
    const mem = batch.directory.realpath;
    let custody: RevisionCustodyLifetime | undefined;
    const reserved: { mem: string }[] = [];
    const specSizes = new Map<string, number>();
    const audit = createRevisionAuditPort(mem, {
      ...(deps.gate ? { gate: deps.gate } : {}),
      signal: attempt.signal,
      isCurrent,
      now: deps.now,
    });
    const mark = (state: RevisionWorkState): void => {
      if (!snapshot || snapshots.get(mem) !== snapshot || epoch !== generation || !page) return;
      for (const key of page.ordinaryPairKeys)
        if (["pending", "in-flight"].includes(snapshot.ordinary.get(key)!)) snapshot.ordinary.set(key, state);
      for (const key of page.sourceKeys)
        if (["pending", "in-flight"].includes(snapshot.sources.get(key)!)) snapshot.sources.set(key, state);
    };
    try {
      let prepared:
        | { plan: SelectorPlan; frozen: Map<string, FrozenRevisionInput>; raw: Map<string, FrozenRevisionBlock> }
        | undefined;
      const ready = await withMemoryDirLock(
        mem,
        () => {
          if (!isCurrent()) return "pending" as const;
          let read: ReturnType<typeof readSnapshot>;
          try {
            read = readSnapshot(batch, audit);
          } catch {
            snapshots.delete(mem);
            pendingSourceDirectories.delete(mem);
            return "input-invalidated" as const;
          }
          const key = hash([
            batch.directory,
            read.input.blocks
              .map((b) => [b.side.id, b.side.rev, b.rawDigest])
              .sort((a, b) => compareRevisionKeys(String(a[0]), String(b[0]))),
            policyVersion,
          ]);
          snapshot = snapshots.get(mem);
          if (!snapshot && !pendingSourceDirectories.has(mem) && snapshots.size + pendingSourceDirectories.size >= 8)
            return "capacity" as const;
          if (!read.sourceAvailable) {
            if (snapshot) {
              if (!snapshot.sourceDiagnosed) diagnostic("p50: source lane unavailable (not empty)");
              snapshot.sourceDiagnosed = true;
            } else if (!pendingSourceDirectories.has(mem)) {
              pendingSourceDirectories.add(mem);
              diagnostic("p50: source lane unavailable (not empty)");
            }
            // Conservatively park the whole opportunity. Do not freeze an
            // ordinary menu that would hide the missing source lane forever.
            return "pending" as const;
          }
          if (snapshot?.key !== key) {
            const pool = buildRevisionDiscoveryPool(read.input);
            if (pool.rejectedSourceOldIds.length)
              diagnostic(`p50: ambiguous retire sources refused (${pool.rejectedSourceOldIds.length})`);
            snapshot = {
              key,
              input: read.input,
              pool,
              ordinary: new Map(pool.ordinary.map((p) => [p.pairKey, "pending"])),
              sources: new Map(pool.sources.map((s) => [revisionSourceKey(s), "pending"])),
              sourceDiagnosed: false,
            };
            snapshots.set(mem, snapshot);
            pendingSourceDirectories.delete(mem);
          }
          page = {
            ordinaryPairKeys: [...snapshot.ordinary]
              .filter(([, s]) => s === "pending")
              .slice(0, 4)
              .map(([k]) => k),
            sourceKeys: [...snapshot.sources]
              .filter(([, s]) => s === "pending")
              .slice(0, 2)
              .map(([k]) => k),
          };
          const plan = selectRevisionWork(snapshot.input, snapshot.pool, page, readIndex(mem).index);
          if (!plan.actions.length) {
            mark("dismissed");
            return "empty-page" as const;
          }
          if (!budget(batch)) return "pending" as const;
          if (jobs.size >= 128) return "capacity" as const;
          discardRevoked();
          const limits = REVISION_HOST_CUSTODY_LIMITS;
          const dirs = new Set([...retained.values(), ...reservations].map((r) => r.mem));
          if (
            retained.size + reservations.size + plan.actions.length > limits.actions ||
            (!dirs.has(mem) && dirs.size >= limits.directories)
          )
            return "capacity" as const;
          custody = captureCustody(batch);
          if (deps.custody && (!custody || !custody.isCurrent())) return "pending" as const;
          // Full fixed-size slots are reserved before ANY freeze/generation.
          for (const _a of plan.actions) {
            const r = { mem };
            reserved.push(r);
            reservations.add(r);
          }
          const frozen = new Map<string, FrozenRevisionInput>();
          for (const a of plan.actions) {
            const source = plan.sourceRetires.find((s) => rowKey(s.action) === rowKey(a));
            const spec = {
              ...a,
              directory: batch.directory,
              selectionBatchId: batch.batchId,
              policyVersion,
              actions: plan.actions,
              ...(source ? { retireSource: source.source } : {}),
            };
            const f = freezeRevisionInputsLocked(mem, spec, {
              audit,
              signal: attempt.signal,
              isCurrent,
              ...(custody ? { custody } : {}),
              ...(deps.gate ? { gate: deps.gate } : {}),
            });
            if ("kind" in f) {
              if (f.reason === "stale") {
                snapshots.delete(mem);
                return "input-invalidated" as const;
              }
              mark("blocked-freeze");
              return "freeze-rejected" as const;
            }
            const specBytes = Buffer.byteLength(revisionCanonicalJson(spec));
            if (revisionInputRetainedBytes(f) + specBytes > limits.actionBytes) {
              mark("blocked-freeze");
              return "freeze-rejected" as const;
            }
            specSizes.set(f.actionId, specBytes);
            frozen.set(rowKey(a), f);
          }
          if (frozen.size !== plan.actions.length || new Set([...frozen.values()].map((f) => f.batchId)).size !== 1) {
            mark("blocked-freeze");
            return "freeze-rejected" as const;
          }
          prepared = { plan, frozen, raw: read.raw };
          return "ready" as const;
        },
        { timeoutMs: 0, log: () => {} },
      );
      if (!isCurrent()) return unavailable("input-invalidated");
      if (ready !== "ready" || !prepared || !snapshot || !page)
        return ready === "empty-page"
          ? { kind: "settled", reason: ready }
          : unavailable(ready === "ready" ? "pending" : ready);
      const { plan, frozen, raw } = prepared,
        jobId = [...frozen.values()][0]!.batchId;
      if (!budget(batch)) return unavailable("pending");
      if (jobs.has(jobId)) {
        mark("blocked-job");
        return { ...unavailable("blocked-job"), batchId: jobId };
      }
      if (jobs.size >= 128) return unavailable("capacity");
      execution = { capUsd: batch.limits.jobCostCapUsd, binding, state: "running", generateClaims: 0 };
      jobs.set(jobId, execution);
      mark("in-flight");
      const activeExecution = execution;
      // Suppressed items terminate only their fixed positions, never refill the page.
      const sourcePairs = new Set(
        plan.sourceRetires.map((s) => revisionPairKey(s.action.target.id, s.action.context!.id)),
      );
      for (const key of page.ordinaryPairKeys)
        if (!plan.pairs.some((p) => p.pairKey === key) && !sourcePairs.has(key))
          snapshot.ordinary.set(key, "dismissed");
      for (const key of page.sourceKeys)
        if (
          !plan.sourceRetires.some(
            (s) =>
              revisionSourceKey(
                snapshot!.pool.sources.find(
                  (x) => rowKey({ action: "retire", target: x.old, context: x.survivor }) === rowKey(s.action),
                )!,
              ) === key,
          )
        )
          snapshot.sources.set(key, "dismissed");
      const guardedAttempt: IncrementalAttemptContext = {
        signal: attempt.signal,
        isCurrent,
        leaseValid,
        tryStartGenerate() {
          if (!isCurrent() || !leaseValid() || activeExecution.generateClaims >= 2 || !budget(batch)) return false;
          // Both deductions are synchronous, before provider/await; never refund.
          if (!attempt.tryStartGenerate()) return false;
          activeExecution.generateClaims++;
          return true;
        },
        capReached() {
          activeExecution.state = "blocked-job";
          attempt.capReached();
        },
      };
      const requestBudget = {
        registry,
        mode: "background" as const,
        budgetMs,
        maxOutputTokens,
        signal: attempt.signal,
        jobId,
        jobCostCapUsd: activeExecution.capUsd,
      };
      const suppressed = (f: FrozenRevisionInput, reason?: RevisionProposal["reason"]) =>
        revisionSuggestionSuppressed(mem, f, { signal: attempt.signal, isCurrent }, reason);
      const pending: { frozen: FrozenRevisionInput; proposal: RevisionProposal; key: string; source: boolean }[] = [];
      const ordinary: {
        pair: SelectorPlan["pairs"][number];
        outcomes: [JevOutcome, JevOutcome];
        fresh: [FreshPairDirection | undefined, FreshPairDirection | undefined];
      }[] = [];
      // DISCOVERY: entire menu already frozen. Compute both expectations locally
      // before their dispatch. Source prepare owns its own R/C, never pre-ask it.
      for (const pair of plan.pairs) {
        const l = raw.get(pair.sides[0].id)!,
          r = raw.get(pair.sides[1].id)!;
        const dtos = [revisionRelationContextForBlocks(l, r), revisionRelationContextForBlocks(r, l)] as const;
        const expected = dtos.map((dto) => ({ requestDigest: hash(dto), inputDigest: hash(dto.state) }));
        const outcomes: JevOutcome[] = [],
          fresh: (FreshPairDirection | undefined)[] = [];
        for (let i = 0; i < 2; i++) {
          if (!isCurrent() || !budget(batch)) throw new Error("job unavailable");
          const out = await deps.client.ask({
            ...dtos[i]!,
            registry,
            mode: "background",
            duty: "review",
            budgetMs,
            signal: attempt.signal,
            jobId,
            jobCostCapUsd: activeExecution.capUsd,
          });
          if (!isCurrent() || !out.ok || !budget(batch)) throw new Error("relation failed");
          outcomes.push(out);
          fresh.push(verifyRevisionPairDirection(out, expected[i]!));
        }
        ordinary.push({
          pair,
          outcomes: outcomes as [JevOutcome, JevOutcome],
          fresh: fresh as [FreshPairDirection | undefined, FreshPairDirection | undefined],
        });
      }
      // PREPARE everything, including all source R/C, before any save/commit.
      for (const source of plan.sourceRetires) {
        const f = frozen.get(rowKey(source.action))!,
          key = revisionSourceKey(
            snapshot.pool.sources.find(
              (s) => rowKey({ action: "retire", target: s.old, context: s.survivor }) === rowKey(source.action),
            )!,
          );
        if (!isCurrent()) throw new Error("stale");
        if (await suppressed(f, "supersedes")) {
          snapshot.sources.set(key, "dismissed");
          continue;
        }
        if (!isCurrent()) throw new Error("stale");
        const result = leaseValid()
          ? await prepareRevisionProposal(f, {
              client: deps.client,
              requestBudget,
              attempt: guardedAttempt,
              isSuppressed: suppressed,
              reason: "supersedes",
              autoEnabled: deps.autoEnabled(),
            })
          : {
              kind: "ok" as const,
              proposal: planRevisionActions({
                candidates: [{ frozen: f, reason: "supersedes" }],
                autoEnabled: false,
                leaseValid: false,
              })[0]!,
            };
        if (!isCurrent() || !budget(batch)) throw new Error("source failed");
        if (result.kind === "dismissed" || result.kind === "resolved") {
          snapshot.sources.set(key, "dismissed");
          continue;
        }
        if (result.kind !== "ok" || !result.proposal) throw new Error("source unavailable");
        pending.push({ frozen: f, proposal: result.proposal, key, source: true });
      }
      let plannedGenerations = 0;
      for (const item of ordinary) {
        const { pair } = item,
          outcome = selectPairOutcome(pair, snapshot.input.blocks, item.fresh);
        if (outcome.kind === "none") {
          if (!item.fresh.every(Boolean)) {
            snapshot.ordinary.set(pair.pairKey, "failed");
            throw new Error("fresh directional evidence unavailable");
          }
          snapshot.ordinary.set(pair.pairKey, "attempted-none");
          continue;
        }
        const f = frozen.get(rowKey(outcome.action))!;
        if (!isCurrent()) throw new Error("stale");
        if (await suppressed(f, outcome.reason)) {
          snapshot.ordinary.set(pair.pairKey, "dismissed");
          continue;
        }
        if (!isCurrent()) throw new Error("stale");
        const direction = f.target.id === pair.sides[0].id ? 0 : 1,
          fresh = item.fresh[direction]!;
        const dto = revisionRelationContextForBlocks(f.target, f.context),
          bindingExpected = { requestDigest: hash(dto), inputDigest: hash(dto.state) };
        const rel: RelationEvidence | undefined =
          fresh.kind !== "unrelated"
            ? {
                kind: fresh.kind,
                p: fresh.p,
                inputDigest: revisionFrozenRelationDigest(f),
                provenance: (item.outcomes[direction] as Extract<JevOutcome, { ok: true }>).sources![0]!.provenance,
              }
            : undefined;
        const canGenerate =
          !outcome.bodyless && plannedGenerations < 2 && activeExecution.generateClaims < 2 && leaseValid();
        let proposal: RevisionProposal | undefined;
        if (canGenerate) {
          plannedGenerations++;
          const result = await prepareRevisionProposal(f, {
            client: deps.client,
            requestBudget,
            attempt: guardedAttempt,
            isSuppressed: suppressed,
            ...(rel ? { relation: { kind: rel.kind, p: rel.p, outcome: item.outcomes[direction] } } : {}),
            reason: outcome.reason,
            autoEnabled: false,
          });
          if (!isCurrent() || !budget(batch)) throw new Error("prepare failed");
          if (result.kind === "dismissed" || result.kind === "resolved") {
            snapshot.ordinary.set(pair.pairKey, "dismissed");
            continue;
          }
          if (result.kind !== "ok") throw new Error("prepare unavailable");
          proposal = result.proposal;
        } else {
          proposal = planRevisionActions({
            candidates: [
              {
                frozen: f,
                reason: outcome.reason,
                ...(rel ? { relation: rel, evidenceBindings: { relation: bindingExpected } } : {}),
              },
            ],
            autoEnabled: false,
            leaseValid: false,
          })[0];
        }
        if (!proposal) throw new Error("plan unavailable");
        pending.push({ frozen: f, proposal, key: pair.pairKey, source: false });
      }
      // SAVE: C barrier and authoritative live suppression are owned by review.
      const owned = new Map<string, OwnedRevisionAction>();
      let saved = 0,
        effects = 0;
      for (const p of pending) {
        if (!isCurrent() || !budget(batch)) throw new Error("save revoked");
        const result = await upsertRevisionSuggestion(
          mem,
          { frozen: p.frozen, proposal: p.proposal, origin: "p50-suggestion" },
          {
            audit,
            signal: attempt.signal,
            isCurrent,
            leaseValid,
            now: deps.now,
            ...(deps.gate ? { gate: deps.gate } : {}),
          },
        );
        if (!isCurrent()) throw new Error("save stale");
        const states = p.source ? snapshot.sources : snapshot.ordinary;
        if (result === "dismissed" || result === "resolved") {
          states.set(p.key, "dismissed");
          continue;
        }
        if (result !== "saved") throw new Error("save failed");
        const final = await withMemoryDirLock(
          mem,
          () =>
            validateRevisionProposal(
              readIndex(mem).index.review?.suggestions.find((s) => s.id === `revision:${p.frozen.actionId}`)?.revision,
            ),
          { timeoutMs: 0, log: () => {} },
        );
        if (
          !isCurrent() ||
          !final ||
          !validateRevisionProposal(final) ||
          !revisionProposalMatchesInput(final, p.frozen)
        )
          throw new Error("final proposal unavailable");
        const action: OwnedRevisionAction = Object.freeze({
          frozen: p.frozen,
          proposal: final,
          coverageMaxOutputTokens: maxOutputTokens,
        });
        owned.set(final.actionId, action);
        const bytes =
          revisionInputRetainedBytes(p.frozen) +
          (specSizes.get(final.actionId) ?? 0) +
          Buffer.byteLength(revisionCanonicalJson(final));
        if (bytes > REVISION_HOST_CUSTODY_LIMITS.actionBytes) throw new Error("custody size");
        // Readback must match the C barrier's final digest, not just the action
        // tuple. The review owner may legitimately demote autoEligible.
        const proof = await withMemoryDirLock(mem, () => audit.readActionLocked(final.batchId, final.actionId), {
          timeoutMs: 0,
          log: () => {},
        });
        if (!isCurrent() || proof.kind !== "ok" || proof.audit.proposalDigest !== final.proposalDigest)
          throw new Error("custody readback digest");
        if (custody && custody.isCurrent()) {
          retained.set(final.actionId, { mem, owned: action, current: custody.isCurrent, bytes });
          const reservation = reserved.pop();
          if (!reservation) throw new Error("missing custody reservation");
          reservations.delete(reservation);
        }
        states.set(p.key, "suggested");
        saved++;
        if (p.source) {
          const key = revisionPairKey(p.frozen.target.id, p.frozen.context!.id);
          if (snapshot.ordinary.get(key) === "pending" || snapshot.ordinary.get(key) === "in-flight")
            snapshot.ordinary.set(key, "attempted-source");
        }
      }
      // COMMIT LAST. Merge/ordinary retire/bodyless are never automatic. At most
      // one actual/unknown effect; after that no model or second automatic write.
      const targets = new Set<string>();
      for (const [actionId, o] of [...owned].sort(([a], [b]) => compareRevisionKeys(a, b))) {
        if (!isCurrent() || !leaseValid() || !deps.autoEnabled()) break;
        if (
          o.proposal.action !== "retire" ||
          !o.proposal.retireEvidence ||
          !o.proposal.autoEligible ||
          targets.has(o.proposal.targetId)
        )
          continue;
        targets.add(o.proposal.targetId);
        const result = await commitAction(
          mem,
          {
            origin: "p50-auto",
            actionId,
            expectedRev: o.proposal.expectedRev,
            proposalDigest: o.proposal.proposalDigest,
            signal: attempt.signal,
          },
          {
            actionLocked: (id) => owned.get(id),
            runtime: () => ({
              plainMain: true,
              enabled: true,
              autoEnabled: deps.autoEnabled(),
              sessionEpoch: batch.directory.sessionEpoch,
              policyVersion,
              dateRuleVersion: "",
            }),
            isCurrent,
            leaseValid: () => leaseValid(),
            now: deps.now,
            signal: attempt.signal,
            ...(deps.gate ? { gate: deps.gate } : {}),
          },
        );
        if (result.kind === "committed" || result.kind === "effect-unknown") {
          effects++;
          deps.onAfterWrite(mem, "p50-auto");
          break;
        }
        if (!isCurrent()) break;
      }
      mark("attempted-source");
      activeExecution.state = "settled";
      return { kind: "settled", reason: "done", batchId: jobId, menuSize: plan.actions.length, saved, effects };
    } catch (e) {
      if (execution) {
        execution.state = "blocked-job";
        mark("blocked-job");
        return unavailable("blocked-job");
      }
      if (e instanceof Error && e.message.startsWith("memory dir busy:")) return unavailable("lock-busy");
      diagnostic("p50: host input unavailable");
      return unavailable("input-invalidated");
    } finally {
      for (const r of reserved) reservations.delete(r);
      ownedAdmission = undefined;
      running = false;
    }
  }
  return {
    handle,
    /** Caller holds the original directory lock. Returns ONLY the original D
     * object after C+review readback. Not authority to commit: E still requires
     * the caller's fresh command lease, exact receipt and all current guards. */
    actionLocked(memDir: string, actionId: string): OwnedRevisionAction | undefined {
      const r = retained.get(actionId);
      if (!r || r.mem !== memDir) return undefined;
      if (!r.current()) {
        retained.delete(actionId);
        return undefined;
      }
      return r.owned;
    },
    canAttempt(batch: IncrementalBatch): boolean {
      try {
        if (running) return ownedAdmission?.batch === batch && ownedAdmission.recheck();
        return !closed && jobs.size < 128 && deps.binding() !== undefined && deps.isCurrent(batch) && budget(batch);
      } catch {
        return false;
      }
    },
    /** No LIVE/job authority is serialized by these metadata-only observations. */
    inspect() {
      return {
        custody: {
          actions: retained.size,
          reservedActions: reservations.size,
          retainedBytes: [...retained.values()].reduce((n, r) => n + r.bytes, 0),
          reservedBytes: reservations.size * REVISION_HOST_CUSTODY_LIMITS.actionBytes,
        },
        jobs: [...jobs].map(([id, j]) => ({ id, state: j.state, generateClaims: j.generateClaims })),
        pendingSources: [...pendingSourceDirectories],
        directories: [...snapshots].map(([directory, s]) => ({
          directory,
          key: s.key,
          ordinary: [...s.ordinary],
          sources: [...s.sources],
        })),
      };
    },
    reset(_reason: "abort" | "tree" | "session") {
      epoch++;
      ownedAdmission = undefined;
      snapshots.clear();
      retained.clear();
      reservations.clear();
      pendingSourceDirectories.clear();
      for (const j of jobs.values()) if (j.state === "running") j.state = "aborted";
    },
    /** Same owner MUST dispose the original client before releasing its fences. */
    dispose() {
      if (closed) return;
      closed = true;
      epoch++;
      deps.client.dispose();
      ownedAdmission = undefined;
      snapshots.clear();
      retained.clear();
      reservations.clear();
      pendingSourceDirectories.clear();
      jobs.clear();
    },
  };
}
