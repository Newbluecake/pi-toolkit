/** P50 bounded local discovery. Pure scheduling/suggestion policy, never authority.
 * No FS, client, timers or progress owner; the host owns fixed-page consumption. */
import type { IncrementalCandidate } from "./incremental.js";
import type { RevisionFreezeAction, RevisionFreezeSpec } from "./revision.js";
import type { JevIndexV1, RevisionProposal } from "../jev/contracts.js";
import { lexicalTokens } from "../jev/match.js";
import { entryHash } from "../jev/entries.js";
import { revisionSemanticSuppression } from "../jev/index-store.js";
import { parseBlockName } from "../blocks/naming.js";

export const REVISION_SELECTOR_VERSION = "selector-v1/action-v2";
export interface SelectorBlock {
  readonly side: IncrementalCandidate;
  readonly body: string;
  readonly rawDigest: string;
  readonly effectiveTags: readonly string[];
}
export interface RelationHint {
  readonly pair: readonly [IncrementalCandidate, IncrementalCandidate];
  readonly kind: "conflict" | "duplicate" | "supersedes";
  readonly survivorId?: string;
}
export interface SourceHint {
  readonly old: IncrementalCandidate;
  readonly survivor: IncrementalCandidate;
  readonly source: NonNullable<RevisionFreezeSpec["retireSource"]>;
}
export interface SelectorInput {
  readonly policyVersion: string;
  readonly blocks: readonly SelectorBlock[];
  readonly hints: readonly RelationHint[];
  readonly sources: readonly SourceHint[];
}
export interface PairPlan {
  readonly pairKey: string;
  readonly sides: readonly [IncrementalCandidate, IncrementalCandidate];
  /** Proposal location, NOT a fact/survivor authorization. */
  readonly carrierId: string;
  readonly actions: readonly RevisionFreezeAction[];
  readonly signals: readonly ("hint" | "same-body" | "tag" | "topic" | "lexical")[];
  readonly hintKind?: RelationHint["kind"];
  readonly score: number;
}
export interface DiscoveryPool {
  readonly ordinary: readonly PairPlan[];
  readonly sources: readonly SourceHint[];
  readonly rejectedSourceOldIds: readonly string[];
  readonly localPairs: number;
}
export interface SelectorPage {
  readonly ordinaryPairKeys: readonly string[];
  readonly sourceKeys: readonly string[];
}
export interface SelectorPlan {
  readonly policyVersion: string;
  readonly pairs: readonly PairPlan[];
  readonly sourceRetires: readonly { readonly action: RevisionFreezeAction; readonly source: SourceHint["source"] }[];
  readonly actions: readonly RevisionFreezeAction[];
  readonly counts: Readonly<{
    blocks: number;
    localPairs: number;
    eligiblePairs: number;
    selectedPairs: number;
    omittedPairs: number;
    omittedSources: number;
  }>;
}
export const compareRevisionKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const revisionPairKey = (a: string, b: string): string => JSON.stringify([a, b].sort(compareRevisionKeys));
export const revisionSourceKey = (s: SourceHint): string =>
  JSON.stringify([s.old.id, s.survivor.id, s.source.batchId, s.source.actionId, s.source.proposalDigest]);
const same = (a: IncrementalCandidate, b: IncrementalCandidate): boolean =>
  a.id === b.id && a.rev === b.rev && a.authority === b.authority && a.topic === b.topic;
const sideRef = (s: IncrementalCandidate) => ({ id: s.id, rev: s.rev });
const normalized = (s: string): string => s.replace(/\r\n/g, "\n").trim();
function score(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n === 0 ? 0 : n / (a.size + b.size - n);
}
function menu(a: IncrementalCandidate, b: IncrementalCandidate): readonly RevisionFreezeAction[] {
  const carrier = a.authority !== b.authority ? (a.authority === "agent" ? a : b) : a;
  const other = carrier === a ? b : a;
  return [
    { action: "merge-survivor", target: sideRef(carrier), context: sideRef(other) },
    ...[
      [a, b],
      [b, a],
    ].flatMap(([target, context]) =>
      target!.authority === "user" && context!.authority === "agent"
        ? []
        : [{ action: "retire" as const, target: sideRef(target!), context: sideRef(context!) }],
    ),
  ];
}
export function buildRevisionDiscoveryPool(input: SelectorInput): DiscoveryPool {
  if (!input.policyVersion || input.blocks.length > 16 || input.sources.length > 256 || input.hints.length > 600)
    throw new Error("selector bounds");
  const blocks = [...input.blocks].sort((a, b) => compareRevisionKeys(a.side.id, b.side.id));
  if (
    new Set(blocks.map((b) => b.side.id)).size !== blocks.length ||
    blocks.some(
      (b) =>
        !parseBlockName(`${b.side.id}.md`) ||
        !/^[1-9][0-9]*-[a-f0-9]{6}$/.test(b.side.rev) ||
        !/^[a-f0-9]{64}$/.test(b.rawDigest) ||
        !["agent", "user"].includes(b.side.authority),
    )
  )
    throw new Error("selector identity");
  const byId = new Map(blocks.map((b) => [b.side.id, b]));
  const hints = new Map<string, RelationHint>();
  const rank = { conflict: 0, supersedes: 1, duplicate: 2 };
  for (const h of input.hints) {
    if (!h.pair.every((s) => byId.has(s.id) && same(byId.get(s.id)!.side, s)) || h.pair[0].id === h.pair[1].id)
      continue;
    const key = revisionPairKey(h.pair[0].id, h.pair[1].id),
      old = hints.get(key);
    if (!old || rank[h.kind] < rank[old.kind]) hints.set(key, h);
  }
  const tokens = blocks.map((b) => new Set(lexicalTokens(b.body)));
  const lexical = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const neighbours = blocks
      .flatMap((b, j) => (i === j ? [] : [{ id: b.side.id, p: score(tokens[i]!, tokens[j]!) }]))
      .filter((n) => n.p > 0)
      .sort((a, b) => b.p - a.p || compareRevisionKeys(a.id, b.id))
      .slice(0, 2);
    for (const n of neighbours) lexical.add(revisionPairKey(blocks[i]!.side.id, n.id));
  }
  const pairs: PairPlan[] = [];
  for (let i = 0; i < blocks.length; i++)
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!,
        b = blocks[j]!,
        key = revisionPairKey(a.side.id, b.side.id),
        hint = hints.get(key);
      const signals: PairPlan["signals"][number][] = [];
      if (hint) signals.push("hint");
      if (normalized(a.body) === normalized(b.body)) signals.push("same-body");
      if (a.effectiveTags.some((t) => b.effectiveTags.includes(t))) signals.push("tag");
      if (a.side.topic === b.side.topic) signals.push("topic");
      if (lexical.has(key)) signals.push("lexical");
      if (!signals.length) continue;
      const actions = menu(a.side, b.side);
      pairs.push({
        pairKey: key,
        sides: [a.side, b.side],
        carrierId: actions[0]!.target.id,
        actions,
        signals,
        ...(hint ? { hintKind: hint.kind } : {}),
        score: score(tokens[i]!, tokens[j]!),
      });
    }
  const coldRank = (p: PairPlan): number =>
    p.signals.includes("same-body") ? 0 : p.signals.includes("tag") ? 1 : p.signals.includes("topic") ? 2 : 3;
  const order = (a: PairPlan, b: PairPlan): number =>
    (a.hintKind ? rank[a.hintKind] : coldRank(a)) - (b.hintKind ? rank[b.hintKind] : coldRank(b)) ||
    Number(b.sides.some((s) => s.authority === "user")) - Number(a.sides.some((s) => s.authority === "user")) ||
    b.score - a.score ||
    compareRevisionKeys(a.pairKey, b.pairKey);
  const hinted = pairs.filter((p) => p.hintKind).sort(order),
    cold = pairs.filter((p) => !p.hintKind).sort(order);
  const ordinary: PairPlan[] = [];
  // Fixed nonrepeating pages: at most two hints, then a cold slot, then best remaining.
  while (hinted.length || cold.length) {
    ordinary.push(...hinted.splice(0, 2), ...cold.splice(0, 1));
    const remaining = 4 - (ordinary.length % 4);
    // When exactly four entries already accumulated do not append a second page here.
    if (remaining < 4 || ordinary.length === 0) {
      for (let n = 0; n < remaining && (hinted.length || cold.length); n++) {
        if (!cold.length || (hinted.length && order(hinted[0]!, cold[0]!) <= 0)) ordinary.push(hinted.shift()!);
        else ordinary.push(cold.shift()!);
      }
    }
  }
  const grouped = new Map<string, SourceHint[]>();
  for (const s of input.sources) {
    if (
      s.old.id === s.survivor.id ||
      !byId.has(s.old.id) ||
      !byId.has(s.survivor.id) ||
      !same(byId.get(s.old.id)!.side, s.old) ||
      !same(byId.get(s.survivor.id)!.side, s.survivor) ||
      (s.old.authority === "user" && s.survivor.authority === "agent")
    )
      continue;
    const refs = grouped.get(s.old.id) ?? [];
    refs.push(s);
    grouped.set(s.old.id, refs);
  }
  const sources: SourceHint[] = [],
    rejectedSourceOldIds: string[] = [];
  for (const [id, refs] of grouped) {
    if (new Set(refs.map((s) => JSON.stringify([s.old.rev, s.survivor.id, s.survivor.rev]))).size !== 1) {
      rejectedSourceOldIds.push(id);
      continue;
    }
    sources.push([...refs].sort((a, b) => compareRevisionKeys(revisionSourceKey(a), revisionSourceKey(b)))[0]!);
  }
  sources.sort((a, b) => compareRevisionKeys(revisionSourceKey(a), revisionSourceKey(b)));
  return {
    ordinary,
    sources,
    rejectedSourceOldIds: rejectedSourceOldIds.sort(compareRevisionKeys),
    localPairs: (blocks.length * (blocks.length - 1)) / 2,
  };
}
/** Latest suppression filters only this already selected page; never refill it. */
export function selectRevisionWork(
  input: SelectorInput,
  pool: DiscoveryPool,
  page: SelectorPage,
  index: Pick<JevIndexV1, "review">,
): SelectorPlan {
  if (
    page.ordinaryPairKeys.length > 4 ||
    page.sourceKeys.length > 2 ||
    new Set(page.ordinaryPairKeys).size !== page.ordinaryPairKeys.length ||
    new Set(page.sourceKeys).size !== page.sourceKeys.length
  )
    throw new Error("page bounds");
  const suppressed = (a: RevisionFreezeAction): boolean => {
    const target = input.blocks.find((b) => b.side.id === a.target.id),
      context = input.blocks.find((b) => b.side.id === a.context?.id);
    if (!target) throw new Error("unknown page block");
    return !!revisionSemanticSuppression(index, {
      action: a.action,
      target: { id: target.side.id, hash: entryHash(target.body) },
      ...(context ? { context: { id: context.side.id, hash: entryHash(context.body) } } : {}),
    });
  };
  const sourceRetires = page.sourceKeys
    .map((key) => {
      const s = pool.sources.find((s) => revisionSourceKey(s) === key);
      if (!s) throw new Error("unknown source key");
      return {
        source: s.source,
        action: { action: "retire" as const, target: sideRef(s.old), context: sideRef(s.survivor) },
      };
    })
    .filter((s) => !suppressed(s.action));
  const sourcePairs = new Set(sourceRetires.map((s) => revisionPairKey(s.action.target.id, s.action.context!.id)));
  const pairs = page.ordinaryPairKeys.flatMap((key) => {
    const p = pool.ordinary.find((p) => p.pairKey === key);
    if (!p) throw new Error("unknown pair key");
    if (sourcePairs.has(key)) return [];
    const actions = p.actions.filter((a) => !suppressed(a));
    return actions.length ? [{ ...p, actions }] : [];
  });
  const actions = [...pairs.flatMap((p) => p.actions), ...sourceRetires.map((s) => s.action)];
  if (actions.length > 16) throw new Error("action bounds");
  return {
    policyVersion: input.policyVersion,
    pairs,
    sourceRetires,
    actions,
    counts: {
      blocks: input.blocks.length,
      localPairs: pool.localPairs,
      eligiblePairs: pool.ordinary.length,
      selectedPairs: pairs.length,
      omittedPairs: pool.ordinary.length - pairs.length,
      omittedSources: pool.sources.length - sourceRetires.length,
    },
  };
}
export interface FreshPairDirection {
  /** Verified against the independently calculated exact directional DTO. */
  readonly kind: "conflict" | "supersedes" | "unrelated";
  readonly p: number;
}
export type PairOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "merge-suggestion" | "ambiguous-suggestion" | "retire-suggestion";
      readonly action: RevisionFreezeAction;
      readonly reason: RevisionProposal["reason"];
      readonly bodyless: boolean;
    };
export function selectPairOutcome(
  pair: PairPlan,
  blocks: readonly SelectorBlock[],
  fresh: readonly [FreshPairDirection | undefined, FreshPairDirection | undefined],
): PairOutcome {
  const [lr, rl] = fresh;
  if (!lr || !rl || [lr, rl].some((r) => !Number.isFinite(r.p) || r.p < 0 || r.p > 1)) return { kind: "none" };
  const coverL = lr.kind === "supersedes" && lr.p >= 0.75,
    coverR = rl.kind === "supersedes" && rl.p >= 0.75;
  const conflict = [lr, rl].some((r) => r.kind === "conflict" && r.p >= 0.75);
  const merge = pair.actions.find((a) => a.action === "merge-survivor");
  if (conflict)
    return merge ? { kind: "merge-suggestion", action: merge, reason: "conflict", bodyless: false } : { kind: "none" };
  const equal =
    normalized(blocks.find((b) => b.side.id === pair.sides[0].id)!.body) ===
    normalized(blocks.find((b) => b.side.id === pair.sides[1].id)!.body);
  if (coverL && coverR)
    return merge
      ? {
          kind: "ambiguous-suggestion",
          action: merge,
          reason: equal || pair.hintKind === "duplicate" ? "duplicate" : "supersedes",
          bodyless: true,
        }
      : { kind: "none" };
  if (coverL !== coverR) {
    // A low confidence/contradictory reverse answer does not establish uniqueness.
    const reverse = coverL ? rl : lr;
    if (reverse.p < 0.75 || reverse.kind !== "unrelated") return { kind: "none" };
    const target = pair.sides[coverL ? 0 : 1].id;
    const action = pair.actions.find((a) => a.action === "retire" && a.target.id === target);
    return action ? { kind: "retire-suggestion", action, reason: "supersedes", bodyless: true } : { kind: "none" };
  }
  if (equal && lr.kind === "unrelated" && rl.kind === "unrelated" && lr.p >= 0.75 && rl.p >= 0.75)
    return merge
      ? { kind: "ambiguous-suggestion", action: merge, reason: "duplicate", bodyless: true }
      : { kind: "none" };
  return { kind: "none" };
}
/** Only exact local block anchors with a CURRENT hash/revision can schedule hints. */
export function revisionRelationHints(index: JevIndexV1, blocks: readonly SelectorBlock[]): readonly RelationHint[] {
  const anchorId = (s: string): string | undefined => {
    if (parseBlockName(`${s}.md`)) return s;
    const prefix = /^([a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6})\.md(?:$|\|[^|]*\|[\s\S]*$)/.exec(s);
    return prefix?.[1];
  };
  return (index.review?.suggestions ?? []).slice(0, 600).flatMap((s) => {
    if (!s.b || !["conflict", "duplicate", "supersedes"].includes(s.kind)) return [];
    const a = blocks.find((b) => b.side.id === anchorId(s.a.anchor)),
      b = blocks.find((b) => b.side.id === anchorId(s.b!.anchor));
    if (!a || !b || a === b || entryHash(a.body) !== s.a.hash || entryHash(b.body) !== s.b.hash) return [];
    const r = s.revision;
    if (
      r &&
      (r.targetId !== a.side.id ||
        r.contextId !== b.side.id ||
        r.expectedRev !== a.side.rev ||
        r.contextExpectedRev !== b.side.rev)
    )
      return [];
    return [
      {
        pair: [a.side, b.side] as const,
        kind: s.kind as RelationHint["kind"],
        ...(s.kind === "supersedes" ? { survivorId: r ? b.side.id : a.side.id } : {}),
      },
    ];
  });
}
