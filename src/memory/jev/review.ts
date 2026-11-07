// Tidy/review pure logic: candidate pairing, obsolescence candidates,
// dismissed-pair matching, staleness marking and the review pass itself
// (jev-arch §6.3.2–§6.3.4 — the PURE parts only; the interactive `/mem
// review` flow and `/mem expired` are J8).
//
// Pairing: every entry pairs with entries sharing at least one effective
// tag (sidecar p ≥ 0.6 ∪ inline `+` − inline `-`, via `effectiveMeta`) plus
// its top-5 lexical-Jaccard neighbours; dismissed pairs (hashKey OR
// anchorKey — see `DismissedPair`) are dropped; the list is capped at 600
// with user-order and non-permanent pairs kept first.
//
// `runReviewPass` asks the questions (batched at QUESTION_BATCH_TOKENS),
// fails fast on the first failed call, and returns a fresh `ReviewState`
// that CARRIES OVER the previous `dismissed` list. All outbound excerpts go
// through `redactForJev`; private/secret entries never participate (§7.2).
//
// Pi-free root; no module-scope state (I4).

import { createHash } from "node:crypto";
import { lexicalTokens } from "./match.js";
import { redactForJev } from "./redact.js";
import { buildReviewQuestions, splitBatches } from "./questions.js";
import { decideReview, decideUserLikeSuggestion, effectiveMeta } from "./decide.js";
import type {
  ClassifierRegistryLike,
  DismissedPair,
  EntryHash,
  JevAnswer,
  JevClient,
  JevIndexV1,
  JevOutcome,
  MemEntry,
  ReviewState,
  ReviewSuggestion,
  ReviewSuggestionView,
  Taxonomy,
} from "./contracts.js";
import type { ReviewPairCandidate, StaleCandidate } from "./decide.js";

/** arch §6.3.2: at most 600 candidate pairs per review pass. */
export const REVIEW_PAIR_CAP = 600;
/** arch §6.3.2: each entry also pairs with its 5 most lexically similar entries. */
const JACCARD_NEIGHBOURS = 5;

/** `effectiveMeta` ignores its `taxonomy` parameter entirely (J2's
 *  implementation only reads the sidecar record and inline data), so a
 *  constant minimal value is passed — no import-time preset merge, no
 *  throw path at module load (verifier item 4). */
const UNUSED_TAXONOMY: Taxonomy = { rev: "", types: [], importance: [], tags: [] };

/** Never paired, never asked: private or secret entries (§7.2). */
function reviewableEntries(entries: readonly MemEntry[]): readonly MemEntry[] {
  return entries.filter((e) => e.inline.isPrivate !== true && !e.secret);
}

// ───────────────────────────── anchors & dismissed keys ─────────────────────────────

/** `file|section|first 24 code points of the normalized body` (jev-arch
 *  §4.4 `DismissedPair.anchorKey` component). The body is already
 *  comment-stripped and line-normalized on `MemEntry`. */
export function anchorOf(entry: MemEntry): string {
  const head = Array.from(entry.body).slice(0, 24).join("");
  return `${entry.file}|${entry.section}|${head}`;
}

function hashKeyOf(a: { hash: EntryHash }, b: { hash: EntryHash } | undefined): string {
  return b === undefined ? a.hash : [a.hash, b.hash].sort().join("+");
}

function anchorKeyOf(a: { anchor: string }, b: { anchor: string } | undefined): string {
  return b === undefined ? a.anchor : [a.anchor, b.anchor].sort().join("+");
}

export interface DismissablePair {
  readonly a: { readonly hash: EntryHash; readonly anchor: string };
  readonly b?: { readonly hash: EntryHash; readonly anchor: string };
}

/** Dismissed iff hashKey OR anchorKey matches any stored pair (§4.4): editing
 *  past the first 24 code points keeps the pair dismissed (hash changed,
 *  anchor stable); rewriting the head or renaming the section re-opens it. */
export function isDismissed(pair: DismissablePair, dismissed: readonly DismissedPair[]): boolean {
  const hashKey = hashKeyOf(pair.a, pair.b);
  const anchorKey = anchorKeyOf(pair.a, pair.b);
  return dismissed.some((d) => d.hashKey === hashKey || d.anchorKey === anchorKey);
}

// ───────────────────────────── candidate pairs (§6.3.2) ─────────────────────────────

export interface ReviewPair {
  readonly a: MemEntry;
  readonly b: MemEntry;
}

function effectiveTags(entry: MemEntry, index: JevIndexV1): ReadonlySet<string> {
  return new Set(effectiveMeta(entry, index.entries[entry.hash], UNUSED_TAXONOMY).tags);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Candidate pairs: shared-effective-tag pairs + top-5 Jaccard neighbours per
 * entry, deduped, minus dismissed, capped at `cap` with priority for pairs
 * involving a user order or a non-permanent sidecar temporal (§6.3.2).
 */
export function buildPairs(
  entries: readonly MemEntry[],
  index: JevIndexV1,
  dismissed: readonly DismissedPair[],
  cap: number = REVIEW_PAIR_CAP,
): readonly ReviewPair[] {
  const eligible = reviewableEntries(entries);
  const tagsOf = new Map<EntryHash, ReadonlySet<string>>();
  const tokensOf = new Map<EntryHash, ReadonlySet<string>>();
  for (const e of eligible) {
    tagsOf.set(e.hash, effectiveTags(e, index));
    tokensOf.set(e.hash, new Set(lexicalTokens(e.body)));
  }

  const byKey = new Map<string, ReviewPair>();
  const addPair = (a: MemEntry, b: MemEntry): void => {
    if (a.hash === b.hash) return; // never self-pair
    const key = hashKeyOf(a, b);
    if (!byKey.has(key)) byKey.set(key, { a, b });
  };

  // Shared-tag pairs, deterministic order: tag id, then corpus order.
  const byTag = new Map<string, MemEntry[]>();
  for (const e of eligible) {
    for (const tag of [...tagsOf.get(e.hash)!].sort()) {
      const list = byTag.get(tag) ?? [];
      list.push(e);
      byTag.set(tag, list);
    }
  }
  for (const tag of [...byTag.keys()].sort()) {
    const list = byTag.get(tag)!;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) addPair(list[i]!, list[j]!);
    }
  }

  // Jaccard top-5 neighbours per entry.
  for (let i = 0; i < eligible.length; i++) {
    const e = eligible[i]!;
    const scored: { entry: MemEntry; score: number; idx: number }[] = [];
    for (let j = 0; j < eligible.length; j++) {
      if (j === i) continue;
      const other = eligible[j]!;
      if (e.hash === other.hash) continue;
      scored.push({ entry: other, score: jaccard(tokensOf.get(e.hash)!, tokensOf.get(other.hash)!), idx: j });
    }
    scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.idx - y.idx));
    for (const s of scored.slice(0, JACCARD_NEIGHBOURS)) {
      if (s.score <= 0) break;
      addPair(e, s.entry);
    }
  }

  const pairs = [...byKey.values()].filter(
    (p) =>
      isDismissed(
        { a: { hash: p.a.hash, anchor: anchorOf(p.a) }, b: { hash: p.b.hash, anchor: anchorOf(p.b) } },
        dismissed,
      ) === false,
  );

  // Cap with priority: any user side, or any non-permanent temporal side.
  const priorityOf = (p: ReviewPair): number => {
    const nonPermanent = (e: MemEntry): boolean => {
      const t = index.entries[e.hash]?.temporal;
      return t === "dated" || t === "event";
    };
    return p.a.authority === "user" || p.b.authority === "user" || nonPermanent(p.a) || nonPermanent(p.b) ? 1 : 0;
  };
  const annotated = pairs.map((p, i) => ({ p, i, pr: priorityOf(p) }));
  annotated.sort((x, y) => (y.pr !== x.pr ? y.pr - x.pr : x.i - y.i));
  return annotated.slice(0, cap).map((x) => x.p);
}

// ───────────────────────────── obsolescence candidates (§6.3.2) ─────────────────────────────

export interface StaleReviewCandidate {
  readonly entry: MemEntry;
  readonly temporal: "dated" | "event";
  /** Sidecar `at` of the entry's record; "" when it has none yet. */
  readonly updatedAt: string;
}

const DATE_OR_VERSION_RE = /\b\d{4}-\d{2}-\d{2}\b|\bv\d+\.\d+/i;

/**
 * Entries asked the obsolescence question: sidecar `temporal` is dated/event,
 * or the body literally carries a date or version number. Pattern-only
 * entries (sidecar says permanent) are labelled `dated` — their body is
 * explicitly tied to a date or version.
 */
export function staleCandidates(entries: readonly MemEntry[], index: JevIndexV1): readonly StaleReviewCandidate[] {
  const out: StaleReviewCandidate[] = [];
  for (const e of reviewableEntries(entries)) {
    const rec = index.entries[e.hash];
    if (rec?.temporal === "dated" || rec?.temporal === "event") {
      out.push({ entry: e, temporal: rec.temporal, updatedAt: rec.at });
      continue;
    }
    if (DATE_OR_VERSION_RE.test(e.body)) {
      out.push({ entry: e, temporal: "dated", updatedAt: rec?.at ?? "" });
    }
  }
  return out;
}

// ───────────────────────────── suggestions & the pass (§6.3.3/§6.3.4) ─────────────────────────────

/** Thin wrapper over `decideReview` for pair-only callers (the frozen
 *  two-argument form); `staleCands` defaults to none. */
export function suggestionsFrom(
  answers: Record<string, JevAnswer>,
  pairs: readonly ReviewPairCandidate[],
  staleCands: readonly StaleCandidate[] = [],
  now: string = new Date().toISOString(),
): readonly ReviewSuggestion[] {
  return decideReview(answers, pairs, staleCands, now);
}

function corpusFingerprint(entries: readonly MemEntry[]): string {
  const lines = reviewableEntries(entries)
    .map((e) => `${e.file}|${e.hash}`)
    .sort();
  return createHash("sha1").update(lines.join("\n"), "utf8").digest("hex").slice(0, 12);
}

function userLikeSuggestions(
  entries: readonly MemEntry[],
  index: JevIndexV1,
  now: string,
): readonly ReviewSuggestion[] {
  const out: ReviewSuggestion[] = [];
  for (const e of reviewableEntries(entries)) {
    const rec = index.entries[e.hash];
    if (rec === undefined) continue;
    const s = decideUserLikeSuggestion(e.hash, anchorOf(e), e.authority, rec.userLike, now);
    if (s !== undefined) out.push(s);
  }
  return out;
}

export interface RunReviewPassInput {
  readonly client: JevClient;
  readonly registry: ClassifierRegistryLike;
  readonly entries: readonly MemEntry[];
  readonly index: JevIndexV1;
  readonly today: string;
  /** State's `project` field (§6.3.3); optional addition, default "". */
  readonly project?: string;
  readonly signal?: AbortSignal;
}

const REVIEW_BUDGET_MS = 10_000;

/** A failed pass is always the `ok:false` variant — narrowing the plan's
 *  `ReviewState | JevOutcome` so consumers get `.reason`/`.detail` without a
 *  cast (still assignable to the frozen signature's wider union). */
export type ReviewPassResult = ReviewState | Extract<JevOutcome, { ok: false }>;

/**
 * One review pass: build questions from the candidate pairs + obsolescence
 * candidates, ask them in ≤12k-token batches (duty `review`, background
 * mode), fail fast on the first failed call, and return a fresh
 * `ReviewState` carrying over the previous `dismissed` list. Never throws.
 */
export async function runReviewPass(input: RunReviewPassInput): Promise<ReviewPassResult> {
  const prev = input.index.review;
  const pairs = buildPairs(input.entries, input.index, prev?.dismissed ?? []);
  const stale = staleCandidates(input.entries, input.index);
  const pairCands: ReviewPairCandidate[] = pairs.map((p, i) => ({
    id: `p${i + 1}`,
    a: { hash: p.a.hash, anchor: anchorOf(p.a) },
    b: { hash: p.b.hash, anchor: anchorOf(p.b) },
  }));
  const staleCands: StaleCandidate[] = stale.map((s, i) => ({
    id: `o${i + 1}`,
    hash: s.entry.hash,
    anchor: anchorOf(s.entry),
  }));
  const updatedAtOf = (e: MemEntry): string => input.index.entries[e.hash]?.at ?? input.today;
  const { state, questions } = buildReviewQuestions(
    input.project ?? "",
    input.today,
    pairs.map((p, i) => ({
      id: `p${i + 1}`,
      a: { file: p.a.file, updatedAt: updatedAtOf(p.a), excerpt: redactForJev(p.a.body, "entry") },
      b: { file: p.b.file, updatedAt: updatedAtOf(p.b), excerpt: redactForJev(p.b.body, "entry") },
    })),
    stale.map((s, i) => ({
      id: `o${i + 1}`,
      updatedAt: s.updatedAt === "" ? input.today : s.updatedAt,
      temporal: s.temporal,
      excerpt: redactForJev(s.entry.body, "entry"),
    })),
  );

  const answers: Record<string, JevAnswer> = {};
  for (const batch of splitBatches(state, questions)) {
    if (input.signal?.aborted === true) return { ok: false, reason: "aborted", detail: "aborted" };
    const outcome = await input.client.ask({
      duty: "review",
      registry: input.registry,
      state: batch.state,
      questions: batch.questions,
      budgetMs: REVIEW_BUDGET_MS,
      mode: "background",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!outcome.ok) return outcome;
    Object.assign(answers, outcome.answers);
  }

  const now = new Date().toISOString();
  return {
    lastRunAt: now,
    corpusFp: corpusFingerprint(input.entries),
    suggestions: [
      ...suggestionsFrom(answers, pairCands, staleCands, now),
      ...userLikeSuggestions(input.entries, input.index, now),
    ],
    dismissed: prev?.dismissed ?? [],
  };
}

// ───────────────────────────── staleness marking (§6.3.4) ─────────────────────────────

/** A suggestion is `stale` when either referenced hash is no longer in the
 *  live corpus — zero-call, works under `partial`. */
export function markStale(
  suggestions: readonly ReviewSuggestion[],
  liveHashes: ReadonlySet<EntryHash>,
): readonly ReviewSuggestionView[] {
  return suggestions.map((suggestion) => ({
    suggestion,
    stale: !liveHashes.has(suggestion.a.hash) || (suggestion.b !== undefined && !liveHashes.has(suggestion.b.hash)),
  }));
}
