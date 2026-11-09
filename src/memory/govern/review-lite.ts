/** Governance-only review, including Jev-off. Block edits never use legacy
 * line editing: every action rechecks the live revision inside the lock. */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { redactForJev } from "../jev/redact.js";
import { looksSecret } from "../secret-patterns.js";
import type { MemoryWriteGate } from "../contracts.js";
import type {
  MemCommandUiLike,
  ReviewSuggestion,
  ReviewSuggestionKind,
  RevisionAuditPort,
  FrozenRevisionInput,
} from "../jev/contracts.js";
import { isDismissedRelation, mergeReview, readIndex, suggestionKey } from "../jev/index-store.js";
import { entryHash } from "../jev/entries.js";
import { readCorpus, trashBlockLocked } from "../blocks/store.js";
import { parseBlockFile, type ParsedBlock } from "../blocks/format.js";
import { parseBlockName } from "../blocks/naming.js";
import { inspectDirNoFollow, listRegular, readRegular } from "../safe-fs.js";
import { residentBlocksOf, residentMeteredBytes } from "../blocks/render.js";
import { withMemoryDirLock } from "../lock.js";
import {
  blockAnchor,
  governanceGate,
  governanceToday,
  readGovernBlock,
  replaceGovernBlockLocked,
  writeGovernIndexLocked,
} from "./supersede.js";
import { planSweep } from "./sweep-plan.js";
import {
  revisionInputIsLiveLocked,
  revisionRetireEvidenceIsLiveLocked,
  revisionProposalDigest,
  revisionProposalMatchesInput,
  validateRevisionProposal,
  type RevisionReviewInput,
} from "./revision.js";
import { archiveBlockLocked, createSweepRunner } from "./sweep.js";
export const GOVERNANCE_KINDS: readonly ReviewSuggestionKind[] = [
  "expired-user",
  "until-check",
  "snapshot",
  "pointer",
  "oversize",
  "resident-budget",
  "scope-check",
  "legacy-drift",
  "conflict",
  "supersedes",
];
export interface ReviewLiteOptions {
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  interactive: boolean;
  enabled: boolean;
  residentBudget: number;
  onAfterWrite?: () => void;
  now?: Date;
}
function days(today: string, n: number): string {
  return new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
}
export async function handleReviewLite(
  memDir: string,
  args: string,
  ui: MemCommandUiLike,
  opts: ReviewLiteOptions,
): Promise<void> {
  const now = opts.now ?? new Date(),
    today = governanceToday(now);
  let corpus = readCorpus(join(memDir, "blocks"));
  if (args.trim() === "--run" && opts.enabled && opts.interactive) {
    const runner = createSweepRunner({
      enabled: true,
      ...(opts.gate ? { gate: opts.gate } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: () => now.getTime(),
      render: {
        residentBytes: residentMeteredBytes(residentBlocksOf(corpus.blocks, { isChild: false, today }), today),
        residentBudget: opts.residentBudget,
        indexOverflow: false,
      },
    });
    await runner.runSweep(memDir, "budget", opts.signal);
    corpus = readCorpus(join(memDir, "blocks"));
  }
  const index = readIndex(memDir).index;
  const transient = planSweep(corpus, index, corpus.legacy, today, "startup").suggestions;
  const suggestions = [...(index.review?.suggestions ?? []), ...transient].filter(
    (s, i, all) =>
      all.findIndex((x) => x.id === s.id) === i &&
      (s.revision !== undefined || GOVERNANCE_KINDS.includes(s.kind)) &&
      corpus.blocks.some(
        (b) => entryHash(b.body) === s.a.hash && (blockAnchor(b) === s.a.anchor || b.id === s.a.anchor),
      ) &&
      (!s.b ||
        corpus.blocks.some(
          (b) => entryHash(b.body) === s.b!.hash && (blockAnchor(b) === s.b!.anchor || b.id === s.b!.anchor),
        )),
  );
  if (!opts.interactive || args.trim() === "--list") {
    ui.notify(
      suggestions.length
        ? `review: ${suggestions.length} governance suggestions\n${suggestions.map((s) => `[${s.kind}] ${s.a.anchor.split("|")[0]}`).join("\n")}`
        : "review: no suggestions",
    );
    return;
  }
  for (const s of suggestions) {
    const block = corpus.blocks.find(
      (b) => entryHash(b.body) === s.a.hash && (blockAnchor(b) === s.a.anchor || b.id === s.a.anchor),
    );
    if (!block) continue;
    const options = [
      { value: "open", label: "Open / hand to agent" },
      { value: "keep", label: "Keep" },
      { value: "skip", label: "Skip" },
    ];
    if (!s.revision && s.kind === "expired-user")
      options.unshift({ value: "extend", label: "Extend 30 days" }, { value: "delete", label: "Delete" });
    if (!s.revision && (s.kind === "until-check" || s.kind === "snapshot") && block.meta.authority === "agent")
      options.unshift({ value: "archive", label: "Archive" }, { value: "extend", label: "Set expires +30 days" });
    if (!s.revision && s.kind === "resident-budget") options.unshift({ value: "topic", label: "Downgrade to topic" });
    if (!s.revision && s.kind === "scope-check") options.unshift({ value: "global", label: "Set global" });
    const choice = await ui.select(`review · ${s.kind} · ${block.id}`, options);
    if (!choice || choice === "skip" || !options.some((option) => option.value === choice)) continue;
    if (choice === "open") {
      const instruction = `Review memory block ${block.id}${s.b ? ` vs ${s.b.anchor.split("|")[0]}` : ""} (${s.kind}); view before editing/merging.`;
      if (ui.setEditorText) ui.setEditorText(instruction);
      else ui.notify(instruction);
      continue;
    }
    try {
      governanceGate(memDir, opts.gate, opts.signal);
      await withMemoryDirLock(
        memDir,
        () => {
          governanceGate(memDir, opts.gate, opts.signal);
          const live = readGovernBlock(memDir, block.id);
          if (live.rev !== block.rev) throw new Error("entry changed — skipped");
          if (s.revision && (live.rev !== s.revision.expectedRev || choice !== "keep"))
            throw new Error("revision is read-only — skipped");
          const latest = readIndex(memDir).index,
            review = latest.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
          if (choice === "archive")
            archiveBlockLocked(memDir, live.id, live.rev, {
              ...(opts.gate ? { gate: opts.gate } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              now,
            });
          else if (choice === "delete")
            trashBlockLocked(join(memDir, "blocks"), `${live.id}.md`, live.rev, opts.gate ? { gate: opts.gate } : {});
          else if (choice !== "keep") {
            const meta = { ...live.meta };
            if (choice === "extend") meta.expires = days(today, 30);
            if (choice === "topic" || choice === "global") meta.scope = choice;
            // A user archive is deliberately not offered as an automatic action.
            replaceGovernBlockLocked(memDir, live, meta, {
              ...(opts.gate ? { gate: opts.gate } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              now,
            });
          }
          const dismissed =
            choice === "keep"
              ? [
                  ...review.dismissed,
                  {
                    suggestionKey: suggestionKey(s),
                    hashKey: s.b ? [s.a.hash, s.b.hash].sort().join("+") : s.a.hash,
                    anchorKey: s.b ? [s.a.anchor, s.b.anchor].sort().join("+") : s.a.anchor,
                    kind: s.kind,
                  },
                ]
              : review.dismissed;
          writeGovernIndexLocked(
            memDir,
            {
              ...latest,
              review: { ...review, suggestions: review.suggestions.filter((x) => x.id !== s.id), dismissed },
            },
            opts.gate,
            opts.signal,
          );
        },
        { timeoutMs: 500 },
      );
      opts.onAfterWrite?.();
    } catch (e) {
      ui.notify(`review: ${(e as Error).message}`);
    }
  }
}
/** Bounded migration review. Only the selected 32 blocks remain in memory;
 * the digest covers every eligible block in ID order. */
/** Fingerprint only authoritative local fields; projections such as inherited are irrelevant. */
export function firstReviewFingerprintRow(block: Pick<ParsedBlock, "id" | "rev" | "meta">): string {
  return (
    JSON.stringify([block.id, block.rev, block.meta.authority, block.meta.status, block.meta.private === true]) + "\n"
  );
}
export interface FirstReviewPair {
  a: string;
  b: string;
  aExcerpt: string;
  bExcerpt: string;
}
export interface FirstReviewPlan {
  pairs: readonly FirstReviewPair[];
  dismissed: readonly { a: string; b: string }[];
  corpusFp: string;
  eligibleUsers: number;
  selectedUsers: number;
  plannedPairs: number;
}
export interface FirstReviewResult {
  plan?: FirstReviewPlan;
  answeredPairs: number;
  casFailures: { a: string; b: string }[];
  suggestionsWritten: boolean;
  added: number;
  complete: boolean;
  reason?: string;
}
export interface FirstReviewOptions {
  gate?: MemoryWriteGate;
  signal?: AbortSignal;
  /** Throws when the owner, deadline or migration identity is no longer valid. */
  check?: () => void;
  remainingMs?: () => number;
  /** Numeric facade retains the pre-C3 suggestion threshold. */
  legacyAllAnswers?: boolean;
  /** Observe local, validated progress; never grants commit rights. */
  onProgress?: (result: FirstReviewResult) => void;
}
export async function firstUserReviewPass(
  memDir: string,
  judge: (
    plan: FirstReviewPlan,
    reportAnswer: (answer: { a: string; b: string; p: number }) => void,
  ) => Promise<readonly { a: string; b: string; p: number }[]>,
  opts: FirstReviewOptions = {},
): Promise<FirstReviewResult> {
  const result: FirstReviewResult = {
    answeredPairs: 0,
    casFailures: [],
    suggestionsWritten: false,
    added: 0,
    complete: false,
  };
  const check = () => {
    governanceGate(memDir, opts.gate, opts.signal);
    opts.check?.();
  };
  try {
    check();
    const scan = () => {
      const dir = join(memDir, "blocks"),
        identity = inspectDirNoFollow(dir);
      const listing = listRegular(dir, { names: "legacy" });
      if (
        listing.files.length + listing.skipped.length !==
        identity.names.filter((name) => name.endsWith(".md")).length
      )
        throw new Error("review: directory enumeration changed");
      if (listing.skipped.some((entry) => parseBlockName(entry.name))) throw new Error("review: unreadable block");
      const users: ReturnType<typeof readCorpus>["blocks"][number][] = [];
      let eligibleUsers = 0;
      const hash = createHash("sha256").update("bounded-neighbours-v1\n");
      // Block names are ASCII; their code-point order is ID order.
      for (const file of listing.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        check();
        if (!parseBlockName(file.name)) continue;
        const block = parseBlockFile(file.name, readRegular(dir, file.name).text, { softLimits: true });
        if (
          "stray" in block ||
          block.meta.authority !== "user" ||
          block.meta.status !== "active" ||
          block.meta.private === true ||
          block.meta.residue === true ||
          block.meta.storageScope === "hub" ||
          looksSecret(block.body)
        )
          continue;
        eligibleUsers++;
        hash.update(firstReviewFingerprintRow(block));
        if (users.length < 32) users.push(block);
      }
      const after = inspectDirNoFollow(dir);
      if (
        identity.dev !== after.dev ||
        identity.ino !== after.ino ||
        JSON.stringify(identity.names.filter((name) => name.endsWith(".md")).sort()) !==
          JSON.stringify(after.names.filter((name) => name.endsWith(".md")).sort())
      )
        throw new Error("review: directory changed");
      return { users, eligibleUsers, corpusFp: hash.digest("hex") };
    };
    const { users, eligibleUsers, corpusFp } = scan();
    const initialIndex = readIndex(memDir);
    if (initialIndex.rebuilt) throw new Error("review: invalid index");
    const dismissed = initialIndex.index.review?.dismissed ?? [];
    const pairs: FirstReviewPair[] = [],
      skipped: { a: string; b: string }[] = [];
    for (const distance of [1, 2])
      for (let i = 0; i + distance < users.length; i++) {
        if (pairs.length + skipped.length >= 64) throw new Error("review: pair limit exceeded");
        const a = users[i]!,
          b = users[i + distance]!;
        const pair = { a: a.id, b: b.id };
        if (
          isDismissedRelation(
            dismissed,
            { hash: entryHash(a.body), anchor: blockAnchor(a) },
            { hash: entryHash(b.body), anchor: blockAnchor(b) },
            "conflict",
          )
        )
          skipped.push(pair);
        else pairs.push({ ...pair, aExcerpt: redactForJev(a.body, "entry"), bExcerpt: redactForJev(b.body, "entry") });
      }
    const plan: FirstReviewPlan = {
      pairs,
      dismissed: skipped,
      corpusFp,
      eligibleUsers,
      selectedUsers: users.length,
      plannedPairs: pairs.length + skipped.length,
    };
    result.plan = plan;
    opts.onProgress?.(result);
    const expected = new Map(pairs.map((p) => [JSON.stringify([p.a, p.b]), p]));
    const reported = new Map<string, number>();
    const reportAnswer = (answer: { a: string; b: string; p: number }) => {
      const key = JSON.stringify([answer.a, answer.b]);
      if (!expected.has(key) || reported.has(key) || !Number.isFinite(answer.p) || answer.p < 0 || answer.p > 1)
        throw new Error("invalid, duplicate or unknown pair answer");
      reported.set(key, answer.p);
      result.answeredPairs = reported.size;
      opts.onProgress?.(result);
    };
    check();
    const answers = await judge(plan, reportAnswer);
    check();
    const seen = new Map<string, number>();
    for (const answer of answers) {
      const key = JSON.stringify([answer.a, answer.b]);
      if (
        !expected.has(key) ||
        seen.has(key) ||
        !Number.isFinite(answer.p) ||
        answer.p < 0 ||
        answer.p > 1 ||
        (reported.has(key) && reported.get(key) !== answer.p)
      )
        throw new Error("invalid, duplicate or unknown pair answer");
      seen.set(key, answer.p);
      result.answeredPairs = new Set([...reported.keys(), ...seen.keys()]).size;
      opts.onProgress?.(result);
    }
    if (seen.size !== pairs.length || [...reported.keys()].some((key) => !seen.has(key)))
      throw new Error("missing pair answer");
    check();
    await withMemoryDirLock(
      memDir,
      () => {
        check();
        const liveIndex = readIndex(memDir);
        if (liveIndex.rebuilt) throw new Error("review: invalid index");
        const index = liveIndex.index;
        const review = index.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
        const suggestions: ReviewSuggestion[] = [];
        for (const pair of [...pairs, ...skipped]) {
          const a = users.find((b) => b.id === pair.a)!,
            b = users.find((v) => v.id === pair.b)!;
          try {
            const liveA = readGovernBlock(memDir, a.id),
              liveB = readGovernBlock(memDir, b.id);
            if (
              [liveA, liveB].some(
                (v, i) =>
                  v.rev !== [a, b][i]!.rev ||
                  v.meta.authority !== "user" ||
                  v.meta.status !== "active" ||
                  v.meta.private === true ||
                  v.meta.residue === true ||
                  v.meta.storageScope === "hub" ||
                  looksSecret(v.body),
              )
            )
              throw new Error("changed");
          } catch {
            result.casFailures.push({ a: pair.a, b: pair.b });
            continue;
          }
          const isDismissed = isDismissedRelation(
            review.dismissed,
            { hash: entryHash(a.body), anchor: blockAnchor(a) },
            { hash: entryHash(b.body), anchor: blockAnchor(b) },
            "conflict",
          );
          if (isDismissed) continue;
          const p = seen.get(JSON.stringify([a.id, b.id]));
          if (p === undefined) {
            result.casFailures.push({ a: a.id, b: b.id });
            continue;
          }
          const id = `migration-${a.id}-${b.id}`;
          if ((!opts.legacyAllAnswers && p < 0.75) || review.suggestions.some((s) => s.id === id)) continue;
          suggestions.push({
            id,
            kind: "conflict",
            a: { hash: entryHash(a.body), anchor: blockAnchor(a) },
            b: { hash: entryHash(b.body), anchor: blockAnchor(b) },
            p,
            at: new Date().toISOString(),
          });
        }
        if (result.casFailures.length) return;
        if (scan().corpusFp !== plan.corpusFp) throw new Error("corpus changed");
        check();
        if (suggestions.length)
          writeGovernIndexLocked(
            memDir,
            { ...index, review: { ...review, suggestions: [...review.suggestions, ...suggestions] } },
            {
              check: () => {
                try {
                  check();
                  return { ok: true as const };
                } catch {
                  return { ok: false as const, reason: "identity-changed" as const };
                }
              },
              capture() {},
            },
            opts.signal,
          );
        result.added = suggestions.length;
        result.suggestionsWritten = true;
      },
      { timeoutMs: Math.max(0, Math.min(500, opts.remainingMs?.() ?? 500)) },
    );
    check();
    result.complete = result.suggestionsWritten && result.casFailures.length === 0;
    if (!result.complete) result.reason = "cas-failed";
  } catch (e) {
    result.reason = (e as Error).message;
  }
  return result;
}

/** Legacy numeric facade with strict completeness: a missing planned answer
 * throws instead of returning a partial count; it is not full compatibility. */
export async function firstUserReviewCount(
  memDir: string,
  judge: (pairs: readonly { a: string; b: string }[]) => Promise<readonly { a: string; b: string; p: number }[]>,
  opts: { gate?: MemoryWriteGate; signal?: AbortSignal } = {},
): Promise<number> {
  const result = await firstUserReviewPass(
    memDir,
    (plan) => (plan.pairs.length ? judge(plan.pairs.map(({ a, b }) => ({ a, b }))) : Promise.resolve([])),
    { ...opts, legacyAllAnswers: true },
  );
  if (!result.complete && result.reason !== "cas-failed") throw new Error(result.reason ?? "review incomplete");
  return result.added;
}

/** D factory-only review owner. Audit is an injected C0 port; no fallback
 * journal, no index lock nesting and no body/metadata mutation. */
export interface RevisionReviewDeps {
  readonly audit?: RevisionAuditPort;
  readonly gate?: MemoryWriteGate;
  readonly signal?: AbortSignal;
  isCurrent(): boolean;
  leaseValid(): boolean;
  now(): Date;
}
export type RevisionSuggestionSaveResult = "saved" | "dismissed" | "resolved" | "stale" | "unavailable";
function revisionSuggestion(input: RevisionReviewInput, at: string): ReviewSuggestion {
  const f = input.frozen,
    p = input.proposal;
  const side = (b: FrozenRevisionInput["target"]) => ({ hash: entryHash(b.block.body), anchor: b.id });
  const kind = p.reason === "expired" ? "expired-user" : p.reason === "budget" ? "oversize" : p.reason;
  return {
    id: `revision:${p.actionId}`,
    kind,
    a: side(f.target),
    ...(f.context ? { b: side(f.context) } : {}),
    p: p.relation?.p ?? 0,
    at,
    revision: p,
  };
}
function suppressedRevision(
  index: ReturnType<typeof readIndex>["index"],
  row: ReviewSuggestion,
): "dismissed" | "resolved" | false {
  const review = index.review;
  if (review?.resolved?.includes(suggestionKey(row))) return "resolved";
  if (
    !mergeReview(review, { lastRunAt: "", corpusFp: "", suggestions: [row], dismissed: [] }).suggestions.some(
      (s) => suggestionKey(s) === suggestionKey(row),
    )
  )
    return "dismissed";
  return false;
}
/** Host can use this before generation; the authoritative repeat is always in
 * upsert's lock. Stable identity intentionally excludes hash/rev/batch. */
export async function revisionSuggestionSuppressed(
  memDir: string,
  frozen: FrozenRevisionInput,
  deps: Pick<RevisionReviewDeps, "isCurrent" | "signal">,
): Promise<"dismissed" | "resolved" | false> {
  if (deps.signal?.aborted || !deps.isCurrent()) return false;
  return withMemoryDirLock(
    memDir,
    () => {
      if (deps.signal?.aborted || !deps.isCurrent()) return false;
      const key = JSON.stringify([
        "revision",
        frozen.action,
        ...[frozen.target.id, ...(frozen.context ? [frozen.context.id] : [])].sort(),
      ]);
      const review = readIndex(memDir).index.review;
      if (review?.resolved?.includes(key)) return "resolved" as const;
      if (review?.dismissed.some((d) => d.suggestionKey === key)) return "dismissed" as const;
      return false;
    },
    { timeoutMs: 0, log: () => {} },
  );
}
export async function upsertRevisionSuggestion(
  memDir: string,
  input: RevisionReviewInput,
  deps: RevisionReviewDeps,
): Promise<RevisionSuggestionSaveResult> {
  const current = () => {
    try {
      return !deps.signal?.aborted && deps.isCurrent();
    } catch {
      return false;
    }
  };
  try {
    if (!current()) return "stale";
    if (!deps.audit) return "unavailable";
    let proposal = validateRevisionProposal(input.proposal);
    if (
      !proposal ||
      !revisionProposalMatchesInput(proposal, input.frozen) ||
      memDir !== input.frozen.directory.realpath
    )
      return "unavailable";
    return await withMemoryDirLock(
      memDir,
      () => {
        if (!current() || !revisionInputIsLiveLocked(input.frozen)) return "stale";
        governanceGate(memDir, deps.gate, deps.signal);
        const sourceCurrent = () =>
          proposal!.action !== "retire" ||
          !proposal!.retireEvidence ||
          revisionRetireEvidenceIsLiveLocked(input.frozen, proposal!, deps.audit!);
        if (!sourceCurrent()) return "stale";
        // Lease loss is not epoch loss: keep only a suggestion, with its final
        // digest fixed BEFORE prepared audit. No post-barrier digest swapping.
        if (proposal!.autoEligible && !deps.leaseValid()) {
          const { proposalDigest: _old, ...payload } = proposal!;
          const next = { ...payload, autoEligible: false };
          proposal = validateRevisionProposal({ ...next, proposalDigest: revisionProposalDigest(next) });
          if (!proposal) return "unavailable";
        }
        const index = readIndex(memDir).index;
        const row = revisionSuggestion({ ...input, proposal: proposal! }, deps.now().toISOString());
        const suppression = suppressedRevision(index, row);
        if (suppression) return suppression;
        const existing = index.review?.suggestions.find((s) => suggestionKey(s) === suggestionKey(row));
        // A live newer/different proposal is not replaced by an in-flight result.
        if (
          existing?.revision &&
          existing.revision.proposalDigest !== proposal!.proposalDigest &&
          (existing.at >= row.at ||
            (existing.revision.expectedRev === proposal!.expectedRev &&
              existing.revision.contextExpectedRev === proposal!.contextExpectedRev))
        )
          return "stale";
        if (!current()) return "stale";
        const prepared = deps.audit!.persistPreparedBarrierLocked({ ...input, proposal: proposal! });
        if (
          prepared.kind !== "ok" ||
          prepared.audit.state !== "prepared" ||
          prepared.audit.actionId !== proposal!.actionId ||
          prepared.audit.batchId !== proposal!.batchId ||
          prepared.audit.proposalDigest !== proposal!.proposalDigest ||
          prepared.audit.beforeDigest !== input.frozen.target.rawDigest ||
          prepared.audit.action !== proposal!.action ||
          prepared.audit.targetId !== proposal!.targetId ||
          prepared.audit.expectedRev !== proposal!.expectedRev ||
          prepared.audit.contextId !== proposal!.contextId ||
          prepared.audit.contextExpectedRev !== proposal!.contextExpectedRev ||
          prepared.audit.directoryIdentityDigest !== proposal!.directoryIdentityDigest ||
          prepared.audit.policyVersion !== proposal!.policyVersion ||
          !prepared.before.equals(input.frozen.target.rawBefore)
        )
          return "unavailable";
        if (
          !current() ||
          !revisionInputIsLiveLocked(input.frozen) ||
          !sourceCurrent() ||
          (proposal!.autoEligible && !deps.leaseValid())
        )
          return "stale";
        const review = mergeReview(index.review, {
          lastRunAt: row.at,
          corpusFp: input.frozen.batchId,
          suggestions: [row],
          dismissed: [],
        });
        if (!review.suggestions.some((s) => s.id === row.id && s.revision?.proposalDigest === proposal!.proposalDigest))
          return "stale";
        governanceGate(memDir, deps.gate, deps.signal);
        if (!current()) return "stale";
        const writeGate: MemoryWriteGate = {
          // Never capture/adopt a directory here; the original owner already did.
          capture() {},
          check(dir) {
            const verdict = deps.gate?.check(dir) ?? { ok: true as const };
            return !current() || !sourceCurrent() || (proposal!.autoEligible && !deps.leaseValid())
              ? { ok: false as const, reason: "identity-changed" as const }
              : verdict;
          },
        };
        writeGovernIndexLocked(memDir, { ...index, review }, writeGate, deps.signal);
        return "saved";
      },
      { timeoutMs: 0, log: () => {} },
    );
  } catch {
    return current() ? "unavailable" : "stale";
  }
}
