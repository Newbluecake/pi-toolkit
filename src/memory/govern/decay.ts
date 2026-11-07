// #36 memory-governance arch r5 §6.2 — time-decay and the name-mention
// requirement for stale-by-nature agent blocks. Pi-free by contract
// (tests/boundary/pi-free.test.ts); no module-scope mutable state (I4);
// no timers, no settings — the constants are code (arch §6.2).
//
// Decay targets are agent blocks with no `expires` whose content is a state
// snapshot (govern/snapshot.ts regex set) or sidecar `temporal ∈
// {dated,event}`. Such blocks record transient project state (quota
// readings, run ids, current-commit facts) that silently goes stale; they
// are the evaluation's Top2/Top5 irrelevant-injection sources.
//
//   U layer: the classifier probability is scaled p × m BEFORE the
//            threshold cut and sort (wire.ts adjusts the answers;
//            decide.ts stays untouched);
//   P layer: the candidate sort key is multiplied by m
//            (predict/select.ts `Candidate.decay`);
//   P/A layers additionally require the turn text to NAME the block
//            (namesSubject) — a decay target with zero token overlap with
//            the current turn never enters the candidate pool at all.
//
// User blocks and blocks with `expires` never decay (they carry their own
// deadline semantics, arch §5.1/§6.2). Files-layout entries have no
// `updated`, so they are never decay targets.

import { lexicalTokens } from "../jev/match.js";
import { looksLikeStateSnapshot } from "./snapshot.js";
import type { EntryTags, MemEntry } from "../jev/contracts.js";

/** ≤ {@link DECAY_MILD_DAYS} days old ⇒ 1.0; ≤ {@link DECAY_STEEP_DAYS} ⇒
 *  0.8; older ⇒ 0.6 (arch §6.2, by `updated`). */
export const DECAY_MILD_DAYS = 7;
export const DECAY_STEEP_DAYS = 30;

/** U-candidate trimming (wire.ts `recallCandidates`): topic user rules
 *  (authority=user, scope≠global) enter the pool FIRST, up to this many,
 *  before the predicted-tag priority slots and the lexical prefilter take
 *  the rest (arch §3.3.1 "topic 类用户令先入池"). 64 covers a realistic
 *  topic-rule population (pi-toolkit: 32) with headroom; PG's G2 gate tunes
 *  recall ONLY through this constant (plan r3 裁定 12 — P6b-fix doubles it
 *  when recall falls short; nothing else may define it). */
export const TOPIC_USER_POOL_CAP = 64;

/** The narrow decay subject — everything isDecayTarget/decayFactor need.
 *  Build via {@link decaySubjectOf}; tests construct literals. */
export interface DecaySubject {
  readonly authority: "user" | "agent";
  /** Deadline semantics (arch §5.1/§6.2, V26 带期限的块不受影响): a block
   *  with `expires` OR `until` carries its own expiry handling and never
   *  decays — both deadline kinds are exempt. */
  readonly expires?: string;
  readonly until?: string;
  /** ISO timestamp of the block's last update; absent ⇒ never a target. */
  readonly updated?: string;
  /** The `MemEntry.block.snapshot` frontmatter flag. NOTE: no writer sets
   *  it today (P1–P5a never persist it; the §5.3 regex is the live
   *  detector) — read-side marker only, deliberately not expanded. */
  readonly snapshot?: boolean;
  /** Sidecar temporal class; `dated`/`event` mark time-bound facts. */
  readonly temporal?: "permanent" | "dated" | "event";
  readonly body: string;
}

/** Fold a MemEntry + its sidecar record into a {@link DecaySubject} (pure;
 *  block fields map 1:1 — the snapshot regex runs inside isDecayTarget). */
export function decaySubjectOf(entry: MemEntry, tags: EntryTags | undefined): DecaySubject {
  return {
    authority: entry.authority,
    ...(entry.inline.expires === undefined ? {} : { expires: entry.inline.expires }),
    ...(entry.inline.until === undefined ? {} : { until: entry.inline.until }),
    ...(entry.block?.updated === undefined ? {} : { updated: entry.block.updated }),
    ...(entry.block?.snapshot === true ? { snapshot: true } : {}),
    ...(tags?.temporal === undefined ? {} : { temporal: tags.temporal }),
    body: entry.body,
  };
}

/** arch §6.2 decay object: agent ∧ no expires ∧ no until ∧ (snapshot
 *  flag/body regex ∨ temporal ∈ {dated,event}). User blocks never decay;
 *  deadline blocks (either kind) carry their own expiry; files-layout
 *  entries have no `updated`. */
export function isDecayTarget(s: DecaySubject): boolean {
  if (s.authority !== "agent") return false;
  if (s.expires !== undefined || s.until !== undefined) return false;
  if (s.updated === undefined) return false;
  if (s.snapshot === true || looksLikeStateSnapshot(s.body)) return true;
  return s.temporal === "dated" || s.temporal === "event";
}

/** Whole days between `updated` and `today` (`YYYY-MM-DD`, both parsed at
 *  UTC midnight; clamped ≥ 0). An unparseable `updated` reads as age 0 —
 *  fail-open for freshness rather than wrongly decaying. */
function ageDays(updatedIso: string, today: string): number {
  const at = Date.parse(updatedIso);
  const day = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(at) || !Number.isFinite(day)) return 0;
  return Math.max(0, Math.floor((day - at) / 86_400_000));
}

/** The decay multiplier m(age) for a subject (1.0 when not a target):
 *  ≤7 days 1.0, ≤30 days 0.8, >30 days 0.6 (arch §6.2). */
export function decayFactor(s: DecaySubject, today: string): number {
  if (!isDecayTarget(s)) return 1;
  const age = ageDays(s.updated ?? "", today);
  if (age <= DECAY_MILD_DAYS) return 1;
  if (age <= DECAY_STEEP_DAYS) return 0.8;
  return 0.6;
}

/** The P/A name-mention requirement (arch §6.2 点名要求): the current
 *  turn's text must share at least one distinctive token with the block's
 *  first non-empty body line. "Distinctive token" reuses match.ts's lexical
 *  tokenizer (ASCII/latin word runs + CJK bigrams) — the same machinery
 *  prefilter scores with. A stale state fact nobody is talking about stays
 *  out of P/A; naming its subject (a run id, a quota word, a line name)
 *  brings it back. */
export function namesSubject(text: string, s: { readonly body: string }): boolean {
  const firstLine = s.body.split("\n").find((l) => l.trim() !== "");
  if (firstLine === undefined) return false;
  const subject = new Set(lexicalTokens(firstLine));
  if (subject.size === 0) return false;
  for (const t of lexicalTokens(text)) {
    if (subject.has(t)) return true;
  }
  return false;
}
