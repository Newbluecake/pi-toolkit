/**
 * jev-reflex · #25 B2 draft generation (BA §4.4, plan B2 step 3). Turns train-set clusters into
 * `origin:"extracted"` draft scripts + `needs-port` candidates + a skip distribution. Everything
 * template-shaped is produced through `regex-safe.ts` (DRX ASTs, never hand-written regexes) and
 * every survivor passes `validateDraft` (the same gate the runtime loader applies) before it is
 * returned — a draft that cannot load is never emitted.
 *
 * Port binding: signed ports (`jobs.list`/`fleet.status`/`git.status`) auto-label via
 * `portLabel` purity; toolless ports (`quota.summary`, K10) are NEVER auto-labelled — a cluster
 * whose modal `toolCount===0` lexically intersects the toolless port's builtin weak vocabulary
 * becomes a `needsPort` candidate (cluster id, size, redacted skeletons, suggested port) and only
 * produces a draft after an explicit `assign` (the `--assign` human-in-the-loop). We do NOT claim
 * all four ports generate automatically.
 *
 * Refinement (BD3): `refineDrafts` re-feeds replay misfires (write-turns / diverging model turns)
 * through `tightenDraft`, which is strictly MONOTONE (the tightened draft's high-match set is a
 * subset of the original's: branches only drop, excludes only grow). The replay itself is
 * INJECTED (`ReplayFn`) so B2 never imports B1's replay module; refine input must be train-only
 * (BD7 — non-train turns throw). Negative re-feeding only ever sees training-set suspects.
 *
 * Pure, pi-free (R-I10), no fs, no module-scope mutable state (I4).
 */

import { createHash } from "node:crypto";
import { judgeAgreement } from "../agreement.js";
import { BUILTIN_SCRIPTS } from "../catalog.js";
import { DRAFT_CAPS, validateDraft } from "../draft-schema.js";
import { evaluateGate } from "../gate.js";
import { compileCatalog, type Matcher } from "../match.js";
import { MVP_PORTS, TOOLLESS_PORTS, portDefaultsOf } from "../port-defaults.js";
import { normalizeInput } from "../normalize.js";
import type { Capability, PortId, RScriptV1, SkipReason, Turn } from "../types.js";
import { redactForJev } from "../../../memory/jev/redact.js";
import { portLabel, skeletonize, skeletonTokens, SKELETON_N, type TurnCluster } from "./cluster.js";
import { branchSource, literalSource, type StrongPart } from "./regex-safe.js";

/** BA §4.4 `minGroup` default. */
export const DEFAULT_MIN_GROUP = 3;
/** Modal-port-label fraction a cluster must reach for an auto port (defence against mixed intents). */
export const PORT_PURITY = 0.6;
/** weak n-gram gates (BA §4.4): ≥60% in-cluster coverage, ≤2% whole-corpus occurrence. */
export const WEAK_COVERAGE = 0.6;
export const WEAK_CORPUS_RATE = 0.02;
/** weak entries per draft (BA §4.4 "1–3"). */
export const MAX_WEAK_NGRAMS = 3;
/** Representative `<n>` instantiations (BA §4.4 Major 11: 2、3、10…, all ≤4 digits, redaction-safe). */
export const REPRESENTATIVE_VALUES: readonly number[] = [2, 3, 10, 5, 20, 8, 99, 123, 1000, 7, 42, 16];
/** Synthetic examples.miss padding — every entry is hard-vetoed by S0, so it can never be high
 *  for ANY draft (length/prefix/short-reply/multiline/imperative rows). */
export const SYNTHETIC_MISSES: readonly string[] = [
  "帮我看一下这个问题",
  "/reflex status",
  "继续",
  "第一行\n第二行",
  "跑一下测试",
];

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_SCRIPTS.map((s) => s.id));
/** Toolless ports' builtin weak vocabularies (the `needsPort` lexical signal, K10). */
const TOOLLESS_WEAK: ReadonlyMap<PortId, readonly string[]> = new Map(
  TOOLLESS_PORTS.map(
    (p) => [p, BUILTIN_SCRIPTS.filter((s) => s.port.id === p).flatMap((s) => [...s.intent.weak])] as const,
  ),
);

// ---------------------------------------------------------------------------
// corpus stats
// ---------------------------------------------------------------------------

/** What the generator needs to know about the training corpus (built by B3's orchestrate). */
export interface CorpusStats {
  /** All train turns — the denominator for weak n-gram corpus rates. */
  readonly turns: readonly Turn[];
  /** Training-set negative norms (write turns): the `exclude` pool and the `examples.miss` seed. */
  readonly negatives: readonly string[];
}

export type SkipCounts = Record<SkipReason, number>;

/** A fresh all-zero skip record (every key present, stable order). */
export function emptySkips(): SkipCounts {
  return {
    small: 0,
    "low-purity": 0,
    unmapped: 0,
    examples: 0,
    regex: 0,
    "exclude-cap": 0,
    validate: 0,
  };
}

/** BA §4.4 needs-port candidate — a suggestion for `generate --assign`, never a draft. */
export interface NeedsPortCandidate {
  readonly clusterId: string;
  readonly size: number;
  /** ≤5 distinct skeletons, redacted, head-clipped to 24cp. */
  readonly skeletons: readonly string[];
  readonly suggestedPort: PortId;
}

export interface GenerateOptions {
  /** Cluster size gate (default {@link DEFAULT_MIN_GROUP}); smaller clusters ⇒ skip `small`. */
  readonly minGroup?: number;
}

export interface GenerateResult {
  /** validateDraft-clean drafts, id-sorted. */
  readonly drafts: readonly RScriptV1[];
  readonly needsPort: readonly NeedsPortCandidate[];
  readonly skips: SkipCounts;
}

const normOf = (turn: Turn): string => normalizeInput(turn.text).norm;

/** token → number of turns containing it (the weak-rate index; built once per generate call). */
function corpusTokenIndex(turns: readonly Turn[]): ReadonlyMap<string, number> {
  const idx = new Map<string, number>();
  for (const t of turns) {
    for (const tok of new Set(skeletonTokens(normOf(t)))) idx.set(tok, (idx.get(tok) ?? 0) + 1);
  }
  return idx;
}

/** Ideal-TUI gate for generated examples (image-free by construction). */
function gateNorm(text: string): string | undefined {
  const gate = evaluateGate({
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
  });
  return gate.pass ? gate.norm.norm : undefined;
}

function isHighFor(matcher: Matcher, caps: ReadonlySet<Capability>, id: string, text: string): boolean {
  const norm = gateNorm(text);
  if (norm === undefined) return false;
  const m = matcher.match(norm, caps);
  return m.kind === "hit" && m.band === "high" && m.scriptId === id;
}

// ---------------------------------------------------------------------------
// port decision
// ---------------------------------------------------------------------------

type PortDecision = { readonly port: PortId } | { readonly needsPort: PortId } | undefined;

function decidePort(cluster: TurnCluster, skips: SkipCounts): PortDecision {
  const counts = new Map<PortId, number>();
  for (const t of cluster.turns) {
    const p = portLabel(t);
    if (p !== undefined) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let modal: PortId | undefined;
  let modalCount = 0;
  for (const p of MVP_PORTS) {
    const n = counts.get(p) ?? 0;
    if (n > modalCount) {
      modal = p;
      modalCount = n;
    }
  }
  if (modal !== undefined && modalCount / cluster.size >= PORT_PURITY) return { port: modal };
  if ([...counts.values()].filter((n) => n > 0).length >= 2) {
    skips["low-purity"] += 1; // labelled turns split across ≥2 ports — mixed intents
    return undefined;
  }
  // needs-port: modal toolCount 0 + lexical intersection with a toolless port's weak vocab (K10)
  const toolCounts = new Map<number, number>();
  for (const t of cluster.turns) toolCounts.set(t.toolCount, (toolCounts.get(t.toolCount) ?? 0) + 1);
  let modalTool: number | undefined;
  let modalToolN = 0;
  for (const [value, n] of [...toolCounts.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > modalToolN) {
      modalTool = value;
      modalToolN = n;
    }
  }
  if (modalTool === 0) {
    for (const p of TOOLLESS_PORTS) {
      const words = TOOLLESS_WEAK.get(p) ?? [];
      if (words.length > 0 && cluster.turns.some((t) => words.some((w) => normOf(t).includes(w))))
        return { needsPort: p };
    }
  }
  skips.unmapped += 1;
  return undefined;
}

// ---------------------------------------------------------------------------
// template building
// ---------------------------------------------------------------------------

interface Branch {
  readonly skeleton: string;
  readonly parts: readonly StrongPart[];
  readonly src: string;
  readonly hasN: boolean;
}

/** skeleton → branch, or undefined when DRX cannot express it (path/quote placeholders, >1 `<n>`,
 *  over-long emission) — such skeletons still count for size/weak but never enter strong. */
function branchOf(skeleton: string): Branch | undefined {
  if (skeleton.includes("<path>") || skeleton.includes("<q>")) return undefined;
  const segs = skeleton.split(SKELETON_N);
  if (segs.length > 2) return undefined; // more than one <n> — not expressible as one branch
  const parts: StrongPart[] = [];
  for (const [i, seg] of segs.entries()) {
    if (i > 0) parts.push({ t: "digits" });
    if (seg !== "") parts.push({ t: "lit", text: seg });
  }
  const r = branchSource(parts);
  if (!r.ok) return undefined;
  return { skeleton, parts, src: r.src, hasN: segs.length === 2 };
}

function weakNgrams(
  cluster: TurnCluster,
  corpusTokens: ReadonlyMap<string, number>,
  corpusSize: number,
): readonly string[] {
  const norms = cluster.turns.map(normOf);
  const memberTokens = norms.map((n) => new Set(skeletonTokens(n)));
  const candidates = new Set<string>();
  for (const toks of memberTokens) for (const tok of toks) candidates.add(tok);
  const corpusTotal = Math.max(corpusSize, 1);
  interface Cand {
    ng: string;
    src: string;
    coverage: number;
    rate: number;
    len: number;
  }
  const passing: Cand[] = [];
  for (const ng of candidates) {
    if (ng === SKELETON_N || ng === "<path>" || ng === "<q>") continue;
    const inCluster = memberTokens.filter((toks) => toks.has(ng)).length;
    const coverage = inCluster / Math.max(cluster.size, 1);
    if (coverage < WEAK_COVERAGE) continue;
    const rate = (corpusTokens.get(ng) ?? 0) / corpusTotal;
    if (rate > WEAK_CORPUS_RATE) continue;
    const lit = literalSource(ng, "weak"); // enforces ≤40 lits / ≤160 chars
    if (!lit.ok) continue;
    passing.push({ ng, src: lit.src, coverage, rate, len: Array.from(ng).length });
  }
  passing.sort((a, b) => b.coverage - a.coverage || a.rate - b.rate || b.len - a.len || (a.ng < b.ng ? -1 : 1));
  return passing.slice(0, MAX_WEAK_NGRAMS).map((c) => c.src);
}

function excludeSources(stats: CorpusStats): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // canonical order (codepoint asc): the output is invariant to the caller's negatives order
  for (const norm of [...new Set(stats.negatives)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (norm === "") continue;
    const r = literalSource(norm, "exclude"); // enforces ≤40 lits / ≤160 chars
    if (!r.ok || seen.has(r.src)) continue;
    seen.add(r.src);
    out.push(r.src);
    if (out.length >= DRAFT_CAPS.exclude) break;
  }
  return out;
}

function headClip(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : `${cps.slice(0, max).join("")}…`;
}

function draftIdOf(leader: string, used: Set<string>): string {
  const base = `draft.${createHash("sha256").update(leader, "utf8").digest("hex").slice(0, 10)}`;
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function assemble(
  id: string,
  port: PortId,
  strong: readonly string[],
  weak: readonly string[],
  exclude: readonly string[],
  hit: readonly string[],
  miss: readonly string[],
): RScriptV1 {
  const d = portDefaultsOf(port)!;
  return {
    schema: "rscript/1",
    id,
    version: 1,
    origin: "extracted",
    risk: "readonly",
    intent: {
      strong: [...strong],
      weak: [...weak],
      exclude: [...exclude],
      examples: { hit: [...hit], miss: [...miss] },
    },
    port: { id: port },
    requires: [...d.requires],
    render: { title: d.render.title, emptyText: d.render.emptyText, maxLines: d.render.maxLines },
    agreement: { tools: [...d.agreement.tools], bashShapes: [...d.agreement.bashShapes] },
  };
}

/** examples.hit generation with representative instantiation + small-cluster completion. */
function buildExamples(
  id: string,
  port: PortId,
  branches: readonly Branch[],
  weak: readonly string[],
  exclude: readonly string[],
  skips: SkipCounts,
): { strong: readonly string[]; hit: readonly string[] } | undefined {
  const defaults = portDefaultsOf(port)!;
  const caps = new Set<Capability>(defaults.requires);
  const hits: string[] = [];
  let strong = branches.map((b) => b.src);
  let matcher = compileCatalog([assemble(id, port, strong, weak, exclude, [], [])]);
  const tryPush = (text: string): void => {
    if (hits.length >= DRAFT_CAPS.examplesMax) return;
    const red = redactForJev(text, "user"); // Major 11: redact AFTER instantiation, BEFORE judging
    if (red === "" || hits.includes(red)) return;
    if (isHighFor(matcher, caps, id, red)) hits.push(red);
  };
  // phase 1 — bare literals + representative `<n>` instantiation (dedup by instantiated text)
  for (const b of branches) {
    if (b.hasN) {
      for (const v of REPRESENTATIVE_VALUES) {
        if (hits.length >= DRAFT_CAPS.examplesMax) break;
        tryPush(b.skeleton.split(SKELETON_N).join(String(v)));
      }
    } else {
      tryPush(b.skeleton);
    }
  }
  // phase 2 — small-cluster completion: upgrade pure-literal branches with the (?:吗|呢)? tail
  // and add the corresponding variants (still re-verified high). Digit branches already used all
  // representatives in phase 1.
  if (hits.length < DRAFT_CAPS.examplesMin) {
    const upgraded: string[] = [];
    let changed = false;
    for (const b of branches) {
      if (b.hasN) {
        upgraded.push(b.src);
        continue;
      }
      const t = branchSource(b.parts, { tail: true });
      if (t.ok) {
        upgraded.push(t.src);
        changed = true;
      } else upgraded.push(b.src);
    }
    if (changed) {
      strong = upgraded;
      matcher = compileCatalog([assemble(id, port, strong, weak, exclude, [], [])]);
      for (let i = hits.length - 1; i >= 0; i--) if (!isHighFor(matcher, caps, id, hits[i]!)) hits.splice(i, 1);
      for (const b of branches) {
        if (b.hasN) continue;
        const last = Array.from(b.skeleton).at(-1);
        if (last === "吗" || last === "呢") continue;
        tryPush(`${b.skeleton}吗`);
        tryPush(`${b.skeleton}呢`);
      }
    }
  }
  if (hits.length < DRAFT_CAPS.examplesMin) {
    skips.examples += 1;
    return undefined;
  }
  return { strong, hit: hits };
}

function buildDraft(
  cluster: TurnCluster,
  port: PortId,
  stats: CorpusStats,
  corpusTokens: ReadonlyMap<string, number>,
  usedIds: Set<string>,
  skips: SkipCounts,
): RScriptV1 | undefined {
  // 1. expressible branches (count desc, skeleton asc — deterministic), capped at 12 sources
  const skelCounts = new Map<string, number>();
  for (const t of cluster.turns) {
    const s = skeletonize(normOf(t));
    skelCounts.set(s, (skelCounts.get(s) ?? 0) + 1);
  }
  const ordered = [...skelCounts.keys()].sort(
    (a, b) => (skelCounts.get(b) ?? 0) - (skelCounts.get(a) ?? 0) || (a < b ? -1 : 1),
  );
  const branches: Branch[] = [];
  for (const skeleton of ordered) {
    const b = branchOf(skeleton);
    if (b !== undefined) branches.push(b);
  }
  if (branches.length === 0) {
    skips.regex += 1; // nothing in this cluster is DRX-expressible (paths/quotes/multi-<n>)
    return undefined;
  }
  const taken = branches.slice(0, DRAFT_CAPS.strong);
  // 2. weak n-grams + exclude pool
  const weak = weakNgrams(cluster, corpusTokens, stats.turns.length);
  const exclude = excludeSources(stats);
  // 3. id + examples
  const id = draftIdOf(cluster.leader, usedIds);
  const ex = buildExamples(id, port, taken, weak, exclude, skips);
  if (ex === undefined) return undefined;
  // 4. examples.miss — negatives that stay non-high for THIS draft + always-vetoed synthetics
  const caps = new Set<Capability>(portDefaultsOf(port)!.requires);
  const missMatcher = compileCatalog([assemble(id, port, ex.strong, weak, exclude, ex.hit, [])]);
  const missPool = [...new Set([...stats.negatives, ...SYNTHETIC_MISSES])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const misses = missPool.filter((t) => !isHighFor(missMatcher, caps, id, t)).slice(0, DRAFT_CAPS.examplesMax);
  if (misses.length < DRAFT_CAPS.examplesMin) {
    skips.examples += 1; // unreachable with the 5 synthetics; kept total anyway
    return undefined;
  }
  return assemble(id, port, ex.strong, weak, exclude, ex.hit, misses);
}

/**
 * BA §4.4 generation. `assign` maps cluster ids to ports (the `--assign` human decision for
 * toolless-port clusters; it overrides auto-labelling for any cluster it names). Deterministic:
 * same clusters + stats ⇒ byte-identical drafts, independent of cluster array order.
 */
export function generateDrafts(
  clusters: readonly TurnCluster[],
  corpusStats: CorpusStats,
  assign?: ReadonlyMap<string, PortId>,
  opts?: GenerateOptions,
): GenerateResult {
  const minGroup = opts?.minGroup ?? DEFAULT_MIN_GROUP;
  const skips = emptySkips();
  const drafts: RScriptV1[] = [];
  const needsPort: NeedsPortCandidate[] = [];
  const usedIds = new Set<string>();
  const corpusTokens = corpusTokenIndex(corpusStats.turns);
  for (const cluster of clusters) {
    if (cluster.size < minGroup) {
      skips.small += 1;
      continue;
    }
    const assigned = assign?.get(cluster.id);
    if (assigned !== undefined && !MVP_PORTS.includes(assigned)) {
      skips.unmapped += 1; // assign names a port with no builtin script — refuse, report
      continue;
    }
    let port: PortId | undefined = assigned;
    if (port === undefined) {
      const decision = decidePort(cluster, skips);
      if (decision === undefined) continue;
      if ("needsPort" in decision) {
        needsPort.push({
          clusterId: cluster.id,
          size: cluster.size,
          skeletons: [...new Set(cluster.skeletons)].slice(0, 5).map((s) => headClip(redactForJev(s, "user"), 24)),
          suggestedPort: decision.needsPort,
        });
        continue;
      }
      port = decision.port;
    }
    const draft = buildDraft(cluster, port, corpusStats, corpusTokens, usedIds, skips);
    if (draft === undefined) continue;
    const v = validateDraft(draft, BUILTIN_IDS);
    if ("code" in v) {
      skips.validate += 1; // the generator produced something the loader would refuse — bug signal
      continue;
    }
    drafts.push(v);
  }
  return {
    drafts: drafts.sort((a, b) => (a.id < b.id ? -1 : 1)),
    needsPort: needsPort.sort((a, b) => (a.clusterId < b.clusterId ? -1 : 1)),
    skips,
  };
}

// ---------------------------------------------------------------------------
// tightening + refinement (BD3 / BD7)
// ---------------------------------------------------------------------------

export interface TightenOutcome {
  /** Present unless `dead`. */
  readonly draft?: RScriptV1;
  /** `empty-strong`: every branch was dropped. `exclude-cap`: same, and exclude capacity was the
   *  binding constraint (a surgical exclude was refused for lack of a free slot). */
  readonly dead?: "empty-strong" | "exclude-cap";
  readonly droppedStrong: readonly string[];
  readonly excluded: readonly string[];
}

/**
 * Monotone tightening against bad norms: exclude-first (a ≤40cp whole-sentence DRX literal keeps
 * the branch for other sentences), then drop the strong branches that match what remains. The
 * result's high-match set is always a SUBSET of the input's (branch removal + exclude growth are
 * both match-shrinking; nothing is ever added).
 *
 * Every regex is compiled through `compileCatalog` — the ONE runtime compile entry (same
 * anchoring semantics as matching at run time); B2 never hand-builds a RegExp.
 */
export function tightenDraft(draft: RScriptV1, badNorms: readonly string[]): TightenOutcome {
  const droppedStrong: string[] = [];
  const excluded: string[] = [];
  const exclude = [...draft.intent.exclude];
  const excludeSet = new Set(exclude);
  let capped = false;
  const caps = new Set<Capability>(draft.requires);
  // One matcher per branch, compiled once via the runtime entry: `match` is high for this draft
  // id ⇔ that single strong source matches the norm whole-sentence (weak alone never yields high).
  interface Live {
    src: string;
    matches: (norm: string) => boolean;
  }
  let live: Live[] = draft.intent.strong.map((src) => {
    const single = compileCatalog([{ ...draft, intent: { ...draft.intent, strong: [src] } }]);
    return {
      src,
      matches: (norm: string): boolean => {
        const m = single.match(norm, caps);
        return m.kind === "hit" && m.band === "high" && m.scriptId === draft.id;
      },
    };
  });
  const hitsHigh = (norm: string): boolean => {
    const probe: RScriptV1 = { ...draft, intent: { ...draft.intent, strong: live.map((b) => b.src), exclude } };
    const m = compileCatalog([probe]).match(norm, caps);
    return m.kind === "hit" && m.band === "high" && m.scriptId === draft.id;
  };
  for (const norm of [...new Set(badNorms)]) {
    if (norm === "" || !hitsHigh(norm)) continue;
    const lit = literalSource(norm, "exclude");
    if (lit.ok && !excludeSet.has(lit.src)) {
      if (exclude.length < DRAFT_CAPS.exclude) {
        exclude.push(lit.src);
        excludeSet.add(lit.src);
        excluded.push(norm);
        continue; // surgically excluded — the branch lives on for other sentences
      }
      capped = true;
    }
    const matched = live.filter((b) => b.matches(norm));
    if (matched.length > 0) {
      const matchedSrcs = new Set(matched.map((b) => b.src));
      live = live.filter((b) => !matchedSrcs.has(b.src));
      droppedStrong.push(...matched.map((b) => b.src));
    }
    // A high hit always matched some strong source, so matched is non-empty here; if a replay
    // ever disagrees, the norm is left untouched and the final round keeps flagging it.
  }
  if (live.length === 0) return { dead: capped ? "exclude-cap" : "empty-strong", droppedStrong, excluded };
  return {
    draft: { ...draft, intent: { ...draft.intent, strong: live.map((b) => b.src), exclude } },
    droppedStrong,
    excluded,
  };
}

/** What B2 needs from one replayed hit (the narrow view of B1's ReplayRow; BD3 injection). */
export interface DraftReplayHit {
  readonly draftId: string;
  readonly turn: Turn;
  readonly band: "high" | "ambiguous";
}

/** Injected replay (BD3): adapts B1's two-layer replay — builtin first, miss ⇒ draft layer. */
export type ReplayFn = (drafts: readonly RScriptV1[], turns: readonly Turn[]) => readonly DraftReplayHit[];

export interface RefineResult {
  /** Survivors — every one validateDraft-clean, id-sorted. */
  readonly drafts: readonly RScriptV1[];
  readonly skips: SkipCounts;
  /** Tighten rounds consumed (≤ maxRounds). */
  readonly rounds: number;
  /** Total bad hits observed across all rounds (audit). */
  readonly misfires: number;
}

interface MisfireReport {
  readonly byDraft: ReadonlyMap<string, Set<string>>;
  readonly total: number;
}

/** A high hit is a misfire when the turn wrote something or the model diverged from the port. */
function collectMisfires(drafts: readonly RScriptV1[], turns: readonly Turn[], replayFn: ReplayFn): MisfireReport {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const byDraft = new Map<string, Set<string>>();
  let total = 0;
  for (const hit of replayFn(drafts, turns)) {
    if (hit.band !== "high") continue; // ambiguous never answers — nothing to tighten
    const draft = byId.get(hit.draftId);
    if (draft === undefined) continue;
    const bad = hit.turn.hasWrite || judgeAgreement(draft, hit.turn.shapes) === "diverge";
    if (!bad) continue;
    const norm = normalizeInput(hit.turn.text).norm;
    if (norm === "") continue;
    let set = byDraft.get(hit.draftId);
    if (set === undefined) {
      set = new Set<string>();
      byDraft.set(hit.draftId, set);
    }
    if (!set.has(norm)) total += 1;
    set.add(norm);
  }
  return { byDraft, total };
}

/** Re-filter examples.hit against the tightened draft; <5 survivors ⇒ the cluster no longer
 *  sustains a draft (completion was already maxed at generate time — refine only shrinks). */
function shrinkExamples(draft: RScriptV1): RScriptV1 | undefined {
  const matcher = compileCatalog([draft]);
  const caps = new Set<Capability>(draft.requires);
  const hits = draft.intent.examples.hit.filter((h) => isHighFor(matcher, caps, draft.id, h));
  if (hits.length < DRAFT_CAPS.examplesMin) return undefined;
  return {
    ...draft,
    intent: { ...draft.intent, examples: { hit: hits, miss: draft.intent.examples.miss } },
  };
}

/**
 * Negative re-feeding (BA §4.4, BD3/BD7): replay ⇒ tighten offending drafts ⇒ re-validate, for
 * up to `maxRounds` rounds; a final replay still flagging a draft (replay implementations that
 * never satisfy) drops it as `low-purity`. THROWS on non-train turns.
 */
export function refineDrafts(
  drafts: readonly RScriptV1[],
  turns: readonly Turn[],
  replayFn: ReplayFn,
  maxRounds = 3,
): RefineResult {
  for (const t of turns)
    if (t.split !== "train")
      throw new Error(`refineDrafts: non-train turn ${t.session}/${t.entryId} (split=${t.split}) — BD7`);
  const skips = emptySkips();
  let current = [...drafts];
  let rounds = 0;
  let misfires = 0;
  while (current.length > 0) {
    const report = collectMisfires(current, turns, replayFn);
    misfires += report.total;
    if (report.byDraft.size === 0) break;
    if (rounds >= maxRounds) {
      for (const _id of report.byDraft.keys()) skips["low-purity"] += 1; // never replay-clean
      current = current.filter((d) => !report.byDraft.has(d.id));
      break;
    }
    rounds += 1;
    const next: RScriptV1[] = [];
    for (const draft of current) {
      const norms = report.byDraft.get(draft.id);
      if (norms === undefined) {
        next.push(draft);
        continue;
      }
      const out = tightenDraft(draft, [...norms]);
      if (out.dead === "exclude-cap") {
        skips["exclude-cap"] += 1;
        continue;
      }
      if (out.dead === "empty-strong") {
        skips["low-purity"] += 1; // the cluster's whole pattern caught misfires — impure intent
        continue;
      }
      const shrunk = shrinkExamples(out.draft!);
      if (shrunk === undefined) {
        skips.examples += 1;
        continue;
      }
      const v = validateDraft(shrunk, BUILTIN_IDS);
      if ("code" in v) {
        skips.validate += 1;
        continue;
      }
      next.push(v);
    }
    current = next;
  }
  const survivors: RScriptV1[] = [];
  for (const draft of current) {
    const v = validateDraft(draft, BUILTIN_IDS);
    if ("code" in v) {
      skips.validate += 1;
      continue;
    }
    survivors.push(v);
  }
  return { drafts: survivors.sort((a, b) => (a.id < b.id ? -1 : 1)), skips, rounds, misfires };
}
