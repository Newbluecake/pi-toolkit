// Pure decision functions: effective metadata and recall/error/tag/review
// verdicts (jev-arch §4.4/§6.1.1/§6.1.4/§6.2.2–§6.2.3/§6.3.4, jev-plan J2).
// The gate decision table and verdict cache were removed with the gate
// feature (2026-11).
//
// Pi-free root; no module-scope state (I4).

import {
  type EffectiveMeta,
  type EntryHash,
  type EntryTags,
  type EntryType,
  type JevAnswer,
  type JevConfig,
  type MemEntry,
  type ReviewSuggestion,
  type Taxonomy,
} from "./contracts.js";
import type { ErrorCandidate, RecallCandidate } from "./questions.js";

// ───────────────────────────── effective metadata (§4.4) ─────────────────────────────

/** Inline authority ⊕ sidecar derived ⊕ defaults (jev-arch §4.4). `tags`
 *  being `undefined` means the entry is pending (no sidecar record under its
 *  current hash) — `importance`/`type` come back `undefined` in that case;
 *  the fast path's own pending-handling (§6.1.3) lives at the call site, not
 *  here. */
export function effectiveMeta(entry: MemEntry, tags: EntryTags | undefined, _taxonomy: Taxonomy): EffectiveMeta {
  const pending = tags === undefined;
  const tagIds = new Set<string>(
    tags === undefined
      ? []
      : Object.entries(tags.tags)
          .filter(([, v]) => v.p >= 0.6)
          .map(([id]) => id),
  );
  for (const id of entry.inline.tagsAdd ?? []) tagIds.add(id);
  for (const id of entry.inline.tagsRemove ?? []) tagIds.delete(id);

  return {
    tags: [...tagIds].sort(),
    authority: entry.authority,
    importance: pending ? undefined : tags.importance,
    type: pending ? undefined : tags.type,
    pending,
  };
}

// ───────────────────────────── answer helpers ─────────────────────────────

function boolProbability(answer: JevAnswer | undefined): number | undefined {
  return answer?.type === "bool" ? answer.probability : undefined;
}

// ───────────────────────────── U/E layer decisions (§6.1.1/§6.1.4) ─────────────────────────────

export interface RecallDecision {
  readonly id: string;
  readonly p: number;
}

/** U-layer cut (jev-arch §6.1.1): `p ≥ threshold`, sorted p desc, ties broken
 *  user-authority-first → importance-desc → file name; capped at
 *  `maxEntries` and cumulative `maxBytes` (counted against each candidate's
 *  `excerpt` size — a candidate that alone would blow the budget is only
 *  excluded once at least one entry has already been taken). */
export function decideRecall(
  answers: Record<string, JevAnswer>,
  cands: readonly RecallCandidate[],
  cfg: JevConfig,
): readonly RecallDecision[] {
  const scored = cands
    .map((c) => ({ c, p: boolProbability(answers[c.id]) }))
    .filter((x): x is { c: RecallCandidate; p: number } => x.p !== undefined && x.p >= cfg.recall.threshold);
  scored.sort((x, y) => {
    if (y.p !== x.p) return y.p - x.p;
    const userX = x.c.authority === "user" ? 0 : 1;
    const userY = y.c.authority === "user" ? 0 : 1;
    if (userX !== userY) return userX - userY;
    const impX = x.c.importance ?? -1;
    const impY = y.c.importance ?? -1;
    if (impY !== impX) return impY - impX;
    return x.c.file < y.c.file ? -1 : x.c.file > y.c.file ? 1 : 0;
  });
  const out: RecallDecision[] = [];
  let bytes = 0;
  for (const s of scored) {
    if (out.length >= cfg.recall.maxEntries) break;
    const size = Buffer.byteLength(s.c.excerpt, "utf8");
    if (out.length > 0 && bytes + size > cfg.recall.maxBytes) break;
    bytes += size;
    out.push({ id: s.c.id, p: s.p });
  }
  return out;
}

/** E-layer cut (jev-arch §6.1.4): fixed threshold 0.7, top 2, p desc. */
export function decideErrorRecall(
  answers: Record<string, JevAnswer>,
  cands: readonly ErrorCandidate[],
): readonly RecallDecision[] {
  const scored = cands
    .map((c) => ({ c, p: boolProbability(answers[c.id]) }))
    .filter((x): x is { c: ErrorCandidate; p: number } => x.p !== undefined && x.p >= 0.7);
  scored.sort((x, y) => y.p - x.p);
  return scored.slice(0, 2).map((s) => ({ id: s.c.id, p: s.p }));
}

// ───────────────────────────── tagging (§6.2.2) ─────────────────────────────

function clampImportance(n: number): 0 | 1 | 2 | 3 {
  const r = Math.round(n);
  return r <= 0 ? 0 : r >= 3 ? 3 : (r as 1 | 2);
}

const ENTRY_TYPE_IDS: readonly EntryType[] = ["rule", "pitfall", "procedure", "preference", "fact", "pointer"];

/** Builds the stored `EntryTags` from one tagging call's answers (jev-arch
 *  §6.2.2): only `p ≥ 0.3` tag judgments are kept (same gate as the sidecar
 *  storage rule, jev-arch §4.4). */
export function decideTagging(
  answers: Record<string, JevAnswer>,
  taxonomy: Taxonomy,
  model: string,
  now: string,
  file: string,
): EntryTags {
  const typeAnswer = answers["m_type"];
  const type: EntryType =
    typeAnswer?.type === "choice" && ENTRY_TYPE_IDS.includes(typeAnswer.choice as EntryType)
      ? (typeAnswer.choice as EntryType)
      : "fact";
  const typeP = typeAnswer?.type === "choice" ? (typeAnswer.probabilities[type] ?? typeAnswer.confidence) : 0;
  const importanceAnswer = answers["m_importance"];
  const importance = clampImportance(importanceAnswer?.type === "score" ? importanceAnswer.score : 0);
  const guard = boolProbability(answers["m_guard"]) ?? 0;
  const temporalAnswer = answers["m_temporal"];
  const temporal: "permanent" | "dated" | "event" =
    temporalAnswer?.type === "choice" &&
    (temporalAnswer.choice === "permanent" || temporalAnswer.choice === "dated" || temporalAnswer.choice === "event")
      ? temporalAnswer.choice
      : "permanent";
  const userLike = boolProbability(answers["m_userlike"]) ?? 0;

  const tags: Record<string, { p: number; rev: number }> = {};
  for (const tag of taxonomy.tags) {
    const p = boolProbability(answers[`t_${tag.id}`]);
    if (p !== undefined && p >= 0.3) tags[tag.id] = { p, rev: tag.rev };
  }
  return { file, type, typeP, importance, tags, guard, temporal, userLike, model, at: now, taxonomyRev: taxonomy.rev };
}

/** Q32/O10: an agent-attributed entry Jev thinks reads like a user order
 *  (jev-arch §6.3.4 "疑似用户令") — a single-entry review suggestion. */
export function decideUserLikeSuggestion(
  entryHash: EntryHash,
  anchor: string,
  authority: "user" | "agent",
  userLike: number,
  now: string,
): ReviewSuggestion | undefined {
  if (authority !== "agent" || userLike < 0.8) return undefined;
  return { id: `ul-${entryHash}`, kind: "user-like", a: { hash: entryHash, anchor }, p: userLike, at: now };
}

// ───────────────────────────── review (§6.3.4) ─────────────────────────────

export interface ReviewPairCandidate {
  readonly id: string; // `p<n>` question id
  readonly a: { readonly hash: EntryHash; readonly anchor: string };
  readonly b: { readonly hash: EntryHash; readonly anchor: string };
}

export interface StaleCandidate {
  readonly id: string; // `o<n>` question id
  readonly hash: EntryHash;
  readonly anchor: string;
}

/** jev-arch §6.3.4 thresholds: relation ∈ {duplicate, supersedes, conflict}
 *  at p ≥ 0.75, or obsolescence at p ≥ 0.8. `a`/`b` are swapped so `a` is
 *  always the surviving/older side the suggestion names first for
 *  `supersedes` (b_supersedes_a flips the pair). */
export function decideReview(
  answers: Record<string, JevAnswer>,
  pairs: readonly ReviewPairCandidate[],
  staleCands: readonly StaleCandidate[],
  now: string,
): readonly ReviewSuggestion[] {
  const out: ReviewSuggestion[] = [];
  for (const pair of pairs) {
    const answer = answers[pair.id];
    if (answer === undefined || answer.type !== "choice") continue;
    const relation = answer.choice;
    const p = answer.probabilities[relation] ?? answer.confidence;
    if (p < 0.75) continue;
    const kind: ReviewSuggestion["kind"] | undefined =
      relation === "duplicate"
        ? "duplicate"
        : relation === "a_supersedes_b" || relation === "b_supersedes_a"
          ? "supersedes"
          : relation === "conflict"
            ? "conflict"
            : undefined;
    if (kind === undefined) continue;
    const [a, b] = relation === "b_supersedes_a" ? [pair.b, pair.a] : [pair.a, pair.b];
    out.push({ id: pair.id, kind, a, b, p, at: now });
  }
  for (const stale of staleCands) {
    const p = boolProbability(answers[stale.id]);
    if (p === undefined || p < 0.8) continue;
    out.push({ id: stale.id, kind: "obsolete", a: { hash: stale.hash, anchor: stale.anchor }, p, at: now });
  }
  return out;
}
