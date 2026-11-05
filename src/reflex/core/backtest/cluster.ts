/**
 * jev-reflex · #25 B2 clustering (BA §4.4, plan B2 step 2). Turns train-set candidate questions
 * into deterministic skeleton clusters plus the per-turn port label. Pure, pi-free (R-I10),
 * no module-scope mutable state (I4); never touches fs — the corpus (B1) feeds it `Turn`s.
 *
 * Candidate definition (BA §4.4): `split==="train"` (non-train input THROWS — BD7/U3, drafts may
 * only ever see the training side) ∧ `origin∈{tui,replay}` ∧ lenient S0 pass (ideal TUI facts with
 * the turn's REAL imageCount — the gate facts offline cannot prove are the lenient ones) ∧ builtin
 * match is miss/ambiguous (builtin-high turns are not ours to draft for).
 *
 * Skeletonization: paths → `<path>`, quoted spans → `<q>`, digit runs → `<n>` (in that order, so
 * paths/quotes with digits inside collapse wholesale). Skeletons containing `<path>`/`<q>` can
 * never enter a strong template (DRX cannot express them) — they still count toward cluster size
 * and weak statistics. A literal `<n>`/`<path>`/`<q>` typed by the user is neutralized first so it
 * can never masquerade as a placeholder.
 *
 * Clustering: greedy leader over distinct skeletons, Jaccard ≥0.6 on token sets (CJK runs
 * contribute unigrams AND bigrams — bigrams alone split 「quota 今天…」/「quota 这周…」 paraphrases
 * that share 5/9 tokens; ascii runs contribute the whole word; placeholders are single tokens),
 * stable order (member count desc, skeleton asc) ⇒ deterministic output regardless of input order.
 */

import { createHash } from "node:crypto";
import { BUILTIN_SCRIPTS } from "../catalog.js";
import { evaluateGate } from "../gate.js";
import { compileCatalog, type Matcher } from "../match.js";
import { MVP_PORTS, TOOLLESS_PORTS, portSignatureOf } from "../port-defaults.js";
import type { Capability, PortId, Turn } from "../types.js";

/** Skeleton placeholders (BA §4.4). Exported for draft-gen's `<n>` instantiation. */
export const SKELETON_N = "<n>";
export const SKELETON_PATH = "<path>";
export const SKELETON_Q = "<q>";

/** Default leader-clustering threshold (BA §4.4). */
export const CLUSTER_JACCARD = 0.6;

const PLACEHOLDER_LITERALS_RE = /<(n|path|q)>/g;
const PATH_LIKE_RE = /\S*\/\S*/g;
const QUOTED_RE = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|‘[^’\n]*’/g;
const PLACEHOLDER_SPLIT_RE = /(<n>|<path>|<q>)/;
const CJK_RE = /[^\u0000-\u007f]/;

/** All capabilities — offline replay cannot know a session's real capability set; assuming all
 *  makes the builtin pre-filter STRONGER (fewer candidates), never weaker. */
const ALL_CAPS: ReadonlySet<Capability> = new Set<Capability>(["bashJobs", "fleet", "quota", "git", "sessionDir"]);

/** norm → skeleton (path → quote → digit runs). Pure; the input is a NORMALIZED text. */
export function skeletonize(norm: string): string {
  // A literal "<n>"/"<path>"/"<q>" typed by the user must never become a real placeholder.
  const guarded = norm.replace(PLACEHOLDER_LITERALS_RE, "〈$1〉");
  return guarded.replace(PATH_LIKE_RE, SKELETON_PATH).replace(QUOTED_RE, SKELETON_Q).replace(/\d+/g, SKELETON_N);
}

/** Jaccard tokens of a skeleton: placeholders whole, CJK runs as unigrams+bigrams, ascii runs whole. */
export function skeletonTokens(skeleton: string): readonly string[] {
  const out: string[] = [];
  for (const piece of skeleton.split(PLACEHOLDER_SPLIT_RE)) {
    if (piece === "" || piece === undefined) continue;
    if (piece === SKELETON_N || piece === SKELETON_PATH || piece === SKELETON_Q) {
      out.push(piece);
      continue;
    }
    for (const run of piece.split(/\s+/)) {
      if (run === "") continue;
      if (!CJK_RE.test(run)) {
        out.push(run);
        continue;
      }
      const cps = Array.from(run);
      out.push(...cps);
      for (let i = 0; i + 1 < cps.length; i++) out.push(cps[i]! + cps[i + 1]!);
    }
  }
  return out;
}

/**
 * BA §4.4 port labeling — SIGNED ports only (`TOOLLESS_PORTS` never auto-label, K10): the turn's
 * tool shapes must intersect exactly one port signature, with `!hasWrite` and `toolCount ≤ 3`.
 * Returns the port, or undefined when the turn carries no safe single-port signal.
 */
export function portLabel(turn: {
  readonly shapes: readonly string[];
  readonly toolCount: number;
  readonly hasWrite: boolean;
}): PortId | undefined {
  if (turn.hasWrite || turn.toolCount > 3) return undefined;
  let hit: PortId | undefined;
  for (const port of MVP_PORTS) {
    if (TOOLLESS_PORTS.includes(port)) continue;
    const sig = portSignatureOf(port);
    if (sig === undefined || sig.empty) continue;
    if (!turn.shapes.some((s) => sig.tools.has(s))) continue;
    if (hit !== undefined) return undefined; // exactly one — two signatures is not a label
    hit = port;
  }
  return hit;
}

/** Audit counts for turns that were considered and not made candidates. */
export interface NonCandidateCounts {
  /** origin web/injected/steer — never corpus candidates (BA §4.2 origin table). */
  readonly origin: number;
  /** lenient S0 vetoed (length/multiline/prefix/short-reply/anaphora/cancel/imperative/image). */
  readonly veto: number;
  /** builtin judged high — the draft layer may only see builtin miss/ambiguous (K2). */
  readonly builtinHigh: number;
}

/** One cluster: leader skeleton + its members, in deterministic order. */
export interface TurnCluster {
  /** Deterministic: `"c" + sha256(leader)[0..10]` — stable across runs for the same corpus. */
  readonly id: string;
  readonly leader: string;
  /** Distinct member skeletons — leader first, then attach order (both deterministic). */
  readonly skeletons: readonly string[];
  /** Member turn count (evidence weight; `generateDrafts` applies `minGroup` to this). */
  readonly size: number;
  /** Member turns — skeleton groups in (count desc, skeleton asc) order, turns in (at, entryId). */
  readonly turns: readonly Turn[];
}

export interface ClusterResult {
  /** Deterministic order: size desc, then leader asc. Includes clusters below minGroup —
   *  `generateDrafts` owns the `minGroup` skip so the report can count them. */
  readonly clusters: readonly TurnCluster[];
  readonly nonCandidates: NonCandidateCounts;
}

export interface ClusterOptions {
  /** Jaccard threshold (default {@link CLUSTER_JACCARD}). */
  readonly jaccard?: number;
  /** Builtin matcher for the candidate pre-filter (default: the builtin catalog). */
  readonly matcher?: Matcher;
  /** Capabilities for the builtin pre-filter (default: all). */
  readonly caps?: ReadonlySet<Capability>;
}

/** Lenient S0 for offline turns: ideal TUI facts, the turn's real imageCount, lenient unknowns. */
function lenientNorm(text: string, imageCount: number): { pass: true; norm: string } | { pass: false } {
  const gate = evaluateGate({
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  });
  return gate.pass ? { pass: true, norm: gate.norm.norm } : { pass: false };
}

const clusterIdOf = (leader: string): string =>
  `c${createHash("sha256").update(leader, "utf8").digest("hex").slice(0, 10)}`;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Cluster train turns (BA §4.4). THROWS on any non-train turn (plan B2 step 2 — mixing the
 * holdout side into generation is the U3 leak this guards).
 */
export function clusterTurns(turns: readonly Turn[], opts?: ClusterOptions): ClusterResult {
  for (const t of turns)
    if (t.split !== "train")
      throw new Error(`clusterTurns: non-train turn ${t.session}/${t.entryId} (split=${t.split}) — BD7/U3`);

  const matcher = opts?.matcher ?? compileCatalog(BUILTIN_SCRIPTS);
  const caps = opts?.caps ?? ALL_CAPS;
  const nonCandidates = { origin: 0, veto: 0, builtinHigh: 0 };
  const bySkeleton = new Map<string, Turn[]>();
  const ordered = [...turns].sort(
    (a, b) =>
      a.at - b.at || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0) || (a.session < b.session ? -1 : 1),
  );
  for (const turn of ordered) {
    if (turn.origin !== "tui" && turn.origin !== "replay") {
      nonCandidates.origin += 1;
      continue;
    }
    const g = lenientNorm(turn.text, turn.imageCount);
    if (!g.pass) {
      nonCandidates.veto += 1;
      continue;
    }
    const m = matcher.match(g.norm, caps);
    if (m.kind === "hit" && m.band === "high") {
      nonCandidates.builtinHigh += 1;
      continue;
    }
    const skeleton = skeletonize(g.norm);
    const bucket = bySkeleton.get(skeleton);
    if (bucket === undefined) bySkeleton.set(skeleton, [turn]);
    else bucket.push(turn);
  }

  interface Entry {
    skeleton: string;
    turns: Turn[];
    tokens: ReadonlySet<string>;
  }
  const entries: Entry[] = [...bySkeleton.entries()].map(([skeleton, ts]) => ({
    skeleton,
    turns: ts,
    tokens: new Set(skeletonTokens(skeleton)),
  }));
  entries.sort((a, b) => b.turns.length - a.turns.length || (a.skeleton < b.skeleton ? -1 : 1));

  const threshold = opts?.jaccard ?? CLUSTER_JACCARD;
  const used = new Set<number>();
  const clusters: TurnCluster[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const leader = entries[i]!;
    used.add(i);
    const members: Entry[] = [leader];
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      if (jaccard(leader.tokens, entries[j]!.tokens) >= threshold) {
        members.push(entries[j]!);
        used.add(j);
      }
    }
    clusters.push({
      id: clusterIdOf(leader.skeleton),
      leader: leader.skeleton,
      skeletons: members.map((m) => m.skeleton),
      size: members.reduce((n, m) => n + m.turns.length, 0),
      turns: members.flatMap((m) => m.turns),
    });
  }
  clusters.sort((a, b) => b.size - a.size || (a.leader < b.leader ? -1 : 1));
  return { clusters, nonCandidates };
}
