/** P50 E: the ONLY revision commit coordinator (factory-only, no F binding).
 * Host-owned proposal/frozen input and runtime/confirmation ports are trusted
 * capabilities, not tool/model arguments. No models/UI/await run in the lock. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryWriteGate } from "../contracts.js";
import type {
  CommitActionResult,
  FrozenRevisionInput,
  RevisionAuditPort,
  RevisionProposal,
  RevisionGenerateRequest,
  RevisionCoverageRequest,
  ApplyObservation,
} from "../jev/contracts.js";
import { independentCoverageSources, prepareRevisionOutbound, revisionRequestDigests } from "../jev/client.js";
import { readIndex, mergeReview, suggestionKey } from "../jev/index-store.js";
import { parseBlockFile, isExpired } from "../blocks/format.js";
import { withMemoryDirLock } from "../lock.js";
import { canonicalDir, listRevisionNamesBounded, readRegularBytes } from "../safe-fs.js";
import {
  revisionCanonicalJson,
  revisionFrozenRelationDigest,
  revisionInputIsLiveLocked,
  revisionGenerationRequestMatchesInput,
  revisionRetireEvidenceIsLiveLocked,
  revisionProposalMatchesInput,
  revisionRelationContext,
  validateRevisionProposal,
} from "./revision.js";
import { createRevisionAuditPort } from "./revision-audit.js";
import { governanceGate, governanceToday, AUTO_PER_WRITE_MAX } from "./supersede.js";
import { prepareRevisionApplicationLocked } from "./revision-applier.js";
import { validateRevisionOutput } from "./revision-output.js";

export interface CommitActionRequest {
  readonly origin: "p50-auto" | "web-b3";
  readonly actionId: string;
  readonly expectedRev: string;
  readonly proposalDigest: string;
  readonly signal?: AbortSignal;
}
export interface OwnedRevisionAction {
  readonly frozen: FrozenRevisionInput;
  readonly proposal: RevisionProposal;
  /** Actual request limits privately captured by the generation owner. Never
   * infer request expectations by copying returned provenance or proposal. */
  readonly generationMaxOutputTokens?: number;
  readonly coverageMaxOutputTokens?: number;
}
export interface RevisionCommitRuntime {
  readonly plainMain: boolean;
  readonly enabled: boolean;
  readonly autoEnabled: boolean;
  readonly sessionEpoch: number;
  readonly policyVersion: string;
  readonly dateRuleVersion: string;
}
export interface RevisionCommitDeps {
  readonly gate?: MemoryWriteGate;
  readonly signal?: AbortSignal;
  /** Local proposal owner, synchronous and invoked only under the directory lock. */
  actionLocked(actionId: string): OwnedRevisionAction | undefined;
  runtime(): RevisionCommitRuntime;
  isCurrent(): boolean;
  leaseValid(frozen: FrozenRevisionInput): boolean;
  now(): Date;
  /** B3 may inject its EXISTING one-shot exact confirmation capability. This
   * factory neither creates a dialog nor treats origin/web strings as proof.
   * Missing port refuses; check/consume must be synchronous and one attempt. */
  consumeConfirmedLocked?(request: Readonly<CommitActionRequest>, proposal: RevisionProposal): boolean;
}
const hash = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const canonical = revisionCanonicalJson;
class Refused extends Error {
  constructor(readonly reason: "stale" | "permission" | "gate" | "digest" | "unavailable") {
    super(reason);
  }
}
function refuse(reason: Refused["reason"]): never {
  throw new Refused(reason);
}
function expectedEvidence(p: RevisionProposal, owned: OwnedRevisionAction): boolean {
  if (
    (p.action !== "rewrite-single" && p.action !== "merge-survivor") ||
    p.generatedBody === undefined ||
    !p.generationInputComplete ||
    !owned.frozen.context ||
    !p.relation ||
    p.relation.p < 0.9 ||
    !p.coverage
  )
    return false;
  const f = owned.frozen;
  const gcap = p.generationRequest?.maxOutputTokens ?? owned.generationMaxOutputTokens,
    ccap = owned.coverageMaxOutputTokens;
  if (!Number.isSafeInteger(gcap) || !Number.isSafeInteger(ccap) || gcap! < 1 || ccap! < 1) return false;
  const generation: RevisionGenerateRequest = {
    registry: {},
    mode: "sync",
    budgetMs: 1,
    maxOutputTokens: gcap!,
    instruction: p.action,
    target: f.target.block,
    ...(p.action === "merge-survivor" ? { context: f.context!.block } : {}),
  };
  const coverage: RevisionCoverageRequest = {
    registry: {},
    mode: "sync",
    budgetMs: 1,
    maxOutputTokens: ccap!,
    target: f.target.block,
    context: f.context!.block,
    candidateBody: p.generatedBody,
  };
  const g = prepareRevisionOutbound(generation, "generate"),
    c = prepareRevisionOutbound(coverage, "coverage");
  if (!g?.inputComplete || !c?.inputComplete) return false;
  const relation = revisionRelationContext(f);
  const expected = {
    relation: { requestDigest: hash(canonical(relation)), inputDigest: hash(canonical(relation.state)) },
    generation: revisionRequestDigests(g.outbound, gcap!),
    coverage: revisionRequestDigests(c.outbound, ccap!),
  };
  return (
    canonical(expected) === canonical(p.evidenceBindings) &&
    p.relation.inputDigest === revisionFrozenRelationDigest(f) &&
    p.coverage.beforeDigest === hash(f.target.block.body) &&
    p.coverage.candidateDigest === p.outputDigest &&
    independentCoverageSources(p.relation.provenance, p.generationProvenance!, p.coverage.provenance, expected)
  );
}
/** Strict read of the sole review owner. Never let a tolerant sanitizer erase a
 * malformed tombstone/revision and accidentally grant a commit. */
function checkReview(mem: string, p: RevisionProposal): void {
  const raw = readRegularBytes(join(mem, "blocks", ".jev"), "index.json", { maxBytes: 1024 * 1024 }).bytes;
  const disk = JSON.parse(raw.toString("utf8")) as { review?: unknown };
  const result = readIndex(mem),
    review = result.index.review;
  if (result.rebuilt || !review || canonical(disk.review) !== canonical(review)) refuse("unavailable");
  const row = review.suggestions.find((s) => s.id === `revision:${p.actionId}`);
  if (!row?.revision || row.revision.proposalDigest !== p.proposalDigest || canonical(row.revision) !== canonical(p))
    refuse("stale");
  const key = suggestionKey(row);
  if (
    review.resolved?.includes(key) ||
    !mergeReview(review, { lastRunAt: "", corpusFp: "", suggestions: [row], dismissed: [] }).suggestions.some(
      (s) => s.id === row.id && s.revision?.proposalDigest === p.proposalDigest,
    )
  )
    refuse("stale");
}
/** Persisted proposed/unknown also count: absence of a success marker is NOT
 * evidence that no syscall ran. Count survives a fresh factory/process. */
function batchAttempts(mem: string, p: RevisionProposal, audit: RevisionAuditPort): number {
  let count = 0;
  for (const actionId of listRevisionNamesBounded(join(mem, "blocks", ".jev", "revisions", p.batchId), 256)) {
    if (!/^[a-f0-9]{64}$/.test(actionId)) refuse("unavailable");
    const r = audit.readActionLocked(p.batchId, actionId);
    if (r.kind !== "ok") refuse("unavailable");
    if (!["prepared", "skipped", "failed"].includes(r.audit.state)) count++;
  }
  return count;
}
function requestCopy(request: CommitActionRequest): Readonly<CommitActionRequest> | undefined {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.getOwnPropertySymbols(request).length)
    return;
  const d = Object.getOwnPropertyDescriptors(request);
  if (
    Object.keys(d).some(
      (k) => !["origin", "actionId", "expectedRev", "proposalDigest", "signal"].includes(k) || !("value" in d[k]!),
    )
  )
    return;
  const r = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value])) as unknown as CommitActionRequest;
  if (
    !["p50-auto", "web-b3"].includes(r.origin) ||
    typeof r.actionId !== "string" ||
    typeof r.proposalDigest !== "string" ||
    typeof r.expectedRev !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.actionId) ||
    !/^[a-f0-9]{64}$/.test(r.proposalDigest) ||
    !/^[1-9][0-9]*-[a-f0-9]{6}$/.test(r.expectedRev) ||
    (r.signal !== undefined && !(r.signal instanceof AbortSignal))
  )
    return;
  return Object.freeze(r);
}

/** One synchronous locked transaction coordinator; no second authorization or
 * applier path exists for automatic vs confirmed callers. */
export async function commitAction(
  memDir: string,
  request: CommitActionRequest,
  deps: RevisionCommitDeps,
): Promise<CommitActionResult> {
  let req: Readonly<CommitActionRequest> | undefined;
  try {
    req = requestCopy(request);
  } catch {
    // In particular, a Proxy must not turn shape validation into an effectful
    // call of the owner. No payload getter or toString is intentionally read.
  }
  const actionId = req?.actionId ?? "";
  const skipped = (reason: Refused["reason"]): CommitActionResult => ({ kind: "skipped", actionId, reason });
  if (!req) return skipped("digest");
  let attemptStarted = false;
  let expectedAfterRev: string | undefined;
  try {
    // Never create/follow/adopt an absent or alias root on the write path.
    if (canonicalDir(memDir)?.real !== memDir) return skipped("stale");
    return await withMemoryDirLock(
      memDir,
      () => {
        const owned = deps.actionLocked(req.actionId);
        if (!owned) return skipped("unavailable");
        const p = validateRevisionProposal(owned.proposal),
          f = owned.frozen;
        if (
          !p ||
          p.actionId !== req.actionId ||
          p.expectedRev !== req.expectedRev ||
          p.proposalDigest !== req.proposalDigest ||
          !revisionProposalMatchesInput(p, f) ||
          f.directory.realpath !== memDir
        )
          return skipped("digest");
        const guard = (live: boolean) => {
          const r = deps.runtime();
          if (deps.signal?.aborted || req.signal?.aborted || deps.isCurrent() !== true) refuse("gate");
          if (r.plainMain !== true || r.enabled !== true || (req.origin === "p50-auto" && r.autoEnabled !== true))
            refuse("gate");
          if (
            r.sessionEpoch !== f.directory.sessionEpoch ||
            r.policyVersion !== p.policyVersion ||
            deps.leaseValid(f) !== true
          )
            refuse("stale");
          if (p.action === "expires" && r.dateRuleVersion !== p.expiry.dateRuleVersion) refuse("stale");
          governanceGate(memDir, deps.gate, req.signal ?? deps.signal);
          if (live && !revisionInputIsLiveLocked(f)) refuse("stale");
        };
        guard(false);
        // User deletion is a hard domain prohibition, not a confirmation
        // policy. C deliberately cannot restore it; no origin may authorize it.
        if (p.action === "delete" && f.target.block.authority === "user") return skipped("permission");
        const audit = createRevisionAuditPort(memDir, {
          ...(deps.gate ? { gate: deps.gate } : {}),
          isCurrent: () => {
            try {
              guard(false);
              return true;
            } catch {
              return false;
            }
          },
          now: deps.now,
        });
        const disk = audit.readActionLocked(p.batchId, p.actionId);
        if (disk.kind === "ok") {
          if (
            disk.audit.proposalDigest !== p.proposalDigest ||
            disk.audit.beforeDigest !== f.target.rawDigest ||
            !disk.before.equals(f.target.rawBefore)
          )
            return skipped("digest");
          // Check the frozen intent BEFORE every replay/terminal shortcut.
          // Legacy prepared evidence may acquire an intent at its first
          // expected-after barrier. Older attempted records without that field
          // remain readable by C, but E cannot invent their commit source.
          if (disk.audit.commitOrigin !== undefined) {
            if (disk.audit.commitOrigin !== req.origin) return skipped("digest");
          } else if (disk.audit.state !== "prepared") return skipped("unavailable");
          if (disk.audit.state === "committed")
            return {
              kind: "committed",
              actionId,
              ...(disk.audit.expectedAfter?.kind === "file" ? { afterRev: disk.audit.expectedAfter.rev } : {}),
            };
          if (disk.audit.state === "proposed" || disk.audit.state === "commit-unknown")
            return {
              kind: "effect-unknown",
              actionId,
              dataApplied: "unknown",
              reason: "finalization-failure",
              ...(disk.audit.expectedAfter?.kind === "file" ? { expectedAfterRev: disk.audit.expectedAfter.rev } : {}),
            };
          if (disk.audit.state !== "prepared") return skipped("stale");
        } else if (disk.kind !== "missing") return skipped("unavailable");
        guard(true);
        checkReview(memDir, p);
        if (f.target.block.authority === "user" && f.context?.block.authority === "agent") return skipped("permission");
        if (p.action === "rewrite-single" || p.action === "merge-survivor") {
          const output = validateRevisionOutput(p.generatedBody);
          if (!output.ok || output.body !== p.generatedBody || output.outputDigest !== p.outputDigest)
            return skipped("digest");
        }
        if (
          !revisionGenerationRequestMatchesInput(p, f) ||
          ((p.action === "rewrite-single" || p.action === "merge-survivor") &&
            p.generationRequest &&
            owned.generationMaxOutputTokens !== undefined &&
            owned.generationMaxOutputTokens !== p.generationRequest.maxOutputTokens)
        )
          return skipped("digest");
        const sourceCurrent = (automatic: boolean) =>
          p.action !== "retire" || !p.retireEvidence
            ? !automatic
            : revisionRetireEvidenceIsLiveLocked(f, p, audit, automatic);
        if (p.action === "retire" && p.retireEvidence && !sourceCurrent(false)) return skipped("stale");
        const now = new Date(deps.now().getTime());
        if (req.origin === "p50-auto") {
          if (p.action === "rewrite-single") {
            if (!expectedEvidence(p, owned)) return skipped("permission");
          } else if (p.action === "retire") {
            if (!sourceCurrent(true)) return skipped("permission");
          } else if (p.action === "expires") {
            if (f.target.block.authority !== "agent") return skipped("permission");
          } else if (p.action === "delete") {
            const old = parseBlockFile(`${f.target.id}.md`, f.target.rawBefore.toString("utf8"));
            if (f.target.block.authority !== "agent" || "stray" in old || !isExpired(old.meta, governanceToday(now)))
              return skipped("permission");
          } else return skipped("permission"); // merge first step remains suggestion-only.
        } else if (!deps.consumeConfirmedLocked) return skipped("unavailable");
        const prepared = audit.persistPreparedBarrierLocked({
          frozen: f,
          proposal: p,
          origin: disk.kind === "ok" ? disk.audit.origin : req.origin,
        });
        if (prepared.kind !== "ok" || prepared.audit.state !== "prepared") return skipped("unavailable");
        if (batchAttempts(memDir, p, audit) >= AUTO_PER_WRITE_MAX) return skipped("permission");
        const application = prepareRevisionApplicationLocked(memDir, f, p, now);
        const check = () => {
          guard(true);
          checkReview(memDir, p);
          // Independence was decided once above on immutable proposal routes.
          // Repeat the full independent binding/source snapshot match here;
          // any change invalidates that decision instead of judging a new route.
          if (p.action === "retire" && p.retireEvidence && !sourceCurrent(false)) refuse("stale");
          if (!revisionGenerationRequestMatchesInput(p, f)) refuse("digest");
        };
        check();
        if (req.origin === "web-b3" && deps.consumeConfirmedLocked!(req, p) !== true) return skipped("permission");
        check();
        const barrier = audit.persistExpectedAfterBarrierLocked({
          batchId: p.batchId,
          actionId,
          proposalDigest: p.proposalDigest,
          commitOrigin: req.origin,
          expected: application.expected,
        });
        if (barrier.kind !== "ok" || barrier.audit.state !== "proposed") return skipped("unavailable");
        // The durable proposed marker is an attempt fence. Re-entry can only
        // diagnose unknown/committed, never run this application a second time.
        attemptStarted = true;
        const expected = application.expected;
        expectedAfterRev = expected.kind === "file" ? expected.rev : undefined;
        const result = application.applyLocked(check);
        let observation: ApplyObservation = result.observation;
        if (result.error && observation.kind === "applied")
          observation = {
            kind: "unknown",
            reason: `post-apply-failure:${result.error}`.slice(0, 900),
            ...(observation.paths ? { paths: observation.paths } : {}),
          };
        const finalized = audit.finalizeCommitLocked({
          batchId: p.batchId,
          actionId,
          proposalDigest: p.proposalDigest,
          observation,
          dataDirectories: result.dataDirectories,
        });
        if (result.observation.kind === "applied" && finalized.kind === "effect-unknown")
          return { ...finalized, dataApplied: true };
        return finalized;
      },
      { timeoutMs: 500, log: () => {} },
    );
  } catch (error) {
    if (attemptStarted)
      return {
        kind: "effect-unknown",
        actionId,
        dataApplied: "unknown",
        reason: "post-apply-failure",
        ...(expectedAfterRev ? { expectedAfterRev } : {}),
      };
    return skipped(error instanceof Refused ? error.reason : "unavailable");
  }
}
/** Factory ONLY. No timer/hook/settings/UI/store owner or default is created. */
export function createRevisionCommitter(
  memDir: string,
  deps: RevisionCommitDeps,
): {
  commitAction(request: CommitActionRequest): Promise<CommitActionResult>;
} {
  return Object.freeze({ commitAction: (request: CommitActionRequest) => commitAction(memDir, request, deps) });
}
