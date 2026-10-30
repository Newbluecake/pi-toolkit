// Pure decision functions: effective metadata, recall/error/gate/review/tag
// verdicts, and the gate verdict cache (jev-arch §4.4/§6.1.1/§6.1.4/§6.2.2–
// §6.2.3/§6.3.4/§6.4.4–§6.4.5, jev-plan J2).
//
// Pi-free root; no module-scope state — `createVerdictCache` returns an
// instance the wire closure holds (I4).

import {
  VERDICT_CACHE_MAX,
  VERDICT_CACHE_TTL_MS,
  type EffectiveMeta,
  type EntryHash,
  type EntryTags,
  type EntryType,
  type GateAction,
  type GateCandidate,
  type GateDecision,
  type JevAnswer,
  type JevConfig,
  type MemEntry,
  type ReviewSuggestion,
  type Taxonomy,
  type VerdictKey,
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

  const inlineGate = entry.inline.gate;
  const guard = tags?.guard ?? 0;
  const guarded =
    inlineGate === "gate" || inlineGate === "hold"
      ? true
      : inlineGate === "nogate"
        ? false
        : guard >= 0.7 && (tags?.type === "rule" || tags?.type === "procedure");

  return {
    tags: [...tagIds].sort(),
    guarded,
    hold: inlineGate === "hold",
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

// ───────────────────────────── gate (§6.4.4/§6.4.5) ─────────────────────────────

export interface DecideGateInput {
  readonly entryHash: EntryHash;
  readonly anchor: string;
  readonly authority: "user" | "agent";
  readonly a: number;
  readonly v: number;
  readonly hold: boolean;
  /** This segment already latched a non-hold block for this entry. */
  readonly latched: boolean;
  readonly threshold: number;
}

/** jev-arch §6.4.4 decision table, taken top-to-bottom. */
export function decideGate(input: DecideGateInput): GateDecision {
  const action: GateAction =
    input.a + input.v < input.threshold
      ? "pass"
      : input.hold && input.v >= input.threshold
        ? "hold"
        : !input.latched
          ? "once"
          : "pass";
  return {
    entryHash: input.entryHash,
    anchor: input.anchor,
    authority: input.authority,
    action,
    a: input.a,
    v: input.v,
  };
}

function entryAnchor(entry: MemEntry): string {
  return entry.heading === undefined ? `${entry.file} #${entry.ordinal}` : `${entry.file} › ${entry.heading}`;
}

/** jev-arch §6.4.5: when Jev could not judge (timeout/error/missing/partial),
 *  only a `gate=hold` entry whose named program is confirmed running blocks
 *  (`hold`); everything else passes (the caller injects its body as
 *  "unjudged", a separate formatting concern — jev/format.ts
 *  `formatUnjudged`). */
export function evidenceTier(
  cands: readonly GateCandidate[],
  runningPrograms: ReadonlySet<string>,
): readonly GateDecision[] {
  return cands.map((c) => {
    const hit = c.meta.hold && c.entry.namedPrograms.some((p) => runningPrograms.has(p));
    return {
      entryHash: c.entry.hash,
      anchor: entryAnchor(c.entry),
      authority: c.meta.authority,
      action: hit ? "hold" : "pass",
      a: 0,
      v: 0,
    } satisfies GateDecision;
  });
}

const GATE_SEVERITY: Record<GateAction, number> = { pass: 0, once: 1, hold: 2 };

/** Multiple guarding entries hitting the same call ⇒ take the strictest
 *  (hold > once > pass, jev-arch §6.4.4). `undefined` for an empty input. */
export function strictest(decisions: readonly GateDecision[]): GateDecision | undefined {
  if (decisions.length === 0) return undefined;
  return decisions.reduce((best, d) => (GATE_SEVERITY[d.action] > GATE_SEVERITY[best.action] ? d : best));
}

/** Verdict-cache key: entryHash + evidence fingerprint + command shape
 *  (jev-arch §6.4.4) — the fingerprint/shape strings are the caller's job
 *  (`sha1` of sorted running programs + branch + sorted staged, and sorted
 *  "program subcommand" pairs respectively). */
export function verdictKey(entryHash: EntryHash, evidenceFp: string, shape: string): VerdictKey {
  return `${entryHash}:${evidenceFp}:${shape}`;
}

export interface VerdictCache {
  get(key: VerdictKey): GateDecision | undefined;
  set(key: VerdictKey, decision: GateDecision): void;
  readonly size: number;
  clear(): void;
}

/** Per-session gate verdict cache (jev-arch §6.4.4): ≤64 entries, 10-minute
 *  TTL, LRU eviction. Held by the wire closure (I4), never at module scope. */
export function createVerdictCache(now: () => number): VerdictCache {
  const map = new Map<VerdictKey, { decision: GateDecision; at: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.at > VERDICT_CACHE_TTL_MS) {
        map.delete(key);
        return undefined;
      }
      return entry.decision;
    },
    set(key, decision) {
      map.delete(key); // move-to-end (LRU)
      map.set(key, { decision, at: now() });
      while (map.size > VERDICT_CACHE_MAX) {
        const oldest = map.keys().next();
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    },
    get size() {
      return map.size;
    },
    clear: () => map.clear(),
  };
}
