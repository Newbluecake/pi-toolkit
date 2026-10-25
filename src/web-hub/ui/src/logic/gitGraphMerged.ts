/**
 * worktree-graph merged-plan §7.2 (P3). Pure, DOM/Vue/timer-free; runtime imports belong
 * only in components/graph/* so this pass stays in the graph's lazy chunk. No wire changes.
 * All exports are total: malformed/accessor-throwing inputs disable annotation/folding,
 * never delete a speculative prefix. Input arrays, entries, maps and sets are never mutated.
 */
import type { WorktreeRowWire } from "@protocol/messages.js";
import type { WtGraphCommit, WtGraphMergedEntry, WtGraphPayload } from "@protocol/worktree-graph.js";

export interface MergedView {
  byBranch: Map<string, WtGraphMergedEntry>;
  /** eq's window ancestors minus HEAD's window ancestors, plus part's explicit e only. */
  landed: Set<string>;
  /** Local branch names in merged entry order, not oids (aliases count separately). */
  targets: string[];
  foldBlocked?: "refs" | "wtheads" | "records" | "parents";
  /** Diagnostic node + parent-edge visits; add foldMerged's ops for the combined bound. */
  ops: number;
}

export interface FoldMergedResult {
  commits: WtGraphCommit[];
  hiddenNow: string[];
  wouldHide: string[];
  hiddenCommits: number;
  ops: number;
}

export interface MergedBadge {
  kind: "eq" | "part";
  k: number;
  t: number;
  branches: string[];
}

function emptyView(): MergedView {
  return { byBranch: new Map(), landed: new Set(), targets: [], ops: 0 };
}

/** Index only, no recursive calls. A malformed graph aborts to the caller's no-fold fallback. */
function indexOf(commits: readonly WtGraphCommit[]): Map<string, WtGraphCommit> {
  const index = new Map<string, WtGraphCommit>();
  for (const c of commits) {
    if (typeof c.h !== "string" || c.h === "" || !Array.isArray(c.p) || index.has(c.h)) {
      throw new Error("invalid graph");
    }
    for (const parent of c.p) {
      if (typeof parent !== "string") throw new Error("invalid parent");
    }
    index.set(c.h, c);
  }
  return index;
}

/** Multi-source window BFS computes the union directly (no per-target repeated walks).
 * Enqueue once per node, inspect every parent once, and never follow an out-of-window oid.
 * A stop set is already ancestor-closed, so stopping there cannot miss a deletable node. */
function ancestors(
  index: ReadonlyMap<string, WtGraphCommit>,
  tips: Iterable<string>,
  meter: { ops: number },
  stop: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const queue: WtGraphCommit[] = [];
  const enqueue = (h: string): void => {
    if (seen.has(h) || stop.has(h)) return;
    const c = index.get(h);
    if (c === undefined) return;
    seen.add(h);
    queue.push(c);
  };
  for (const h of tips) enqueue(h);
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    meter.ops++;
    for (const h of c.p) {
      meter.ops++;
      enqueue(h);
    }
  }
  return seen;
}

/** Four independent protections; annotations remain available even for protected eq tips. */
export function mergedViewOf(p: WtGraphPayload, rows: readonly WorktreeRowWire[]): MergedView {
  try {
    const v = emptyView();
    const merged = p.merged;
    if (merged === undefined || merged.v !== 1 || merged.skipped !== undefined || merged.base !== p.head?.h) {
      return v;
    }
    const index = indexOf(p.commits);
    const locals = new Map<string, Set<string>>();
    for (const r of p.refs) {
      if (r.k !== "branch") continue;
      const tips = locals.get(r.n) ?? new Set<string>();
      tips.add(r.h);
      locals.set(r.n, tips);
    }
    const checkedOut = new Set(rows.map((r) => r.branch).filter((b): b is string => typeof b === "string"));
    const wtTips = new Set(p.wtHeads.map((w) => w.h));
    const eqTips = new Set<string>();
    for (const e of merged.branches) {
      if (!locals.get(e.n)?.has(e.h) || v.byBranch.has(e.n)) continue;
      v.byBranch.set(e.n, e);
      if (e.v === "eq") {
        eqTips.add(e.h);
        if (e.n !== p.head?.b && e.co !== true && !checkedOut.has(e.n) && !wtTips.has(e.h)) {
          v.targets.push(e.n);
        }
      } else if (e.v === "part") {
        // eP never licenses inference: absent/unlisted e oids stay unmarked.
        for (const h of e.e ?? []) if (index.has(h)) v.landed.add(h);
      }
    }
    if (eqTips.size > 0) {
      const headAnc = ancestors(index, p.head === undefined ? [] : [p.head.h], v);
      for (const h of ancestors(index, eqTips, v, headAnc)) v.landed.add(h);
    }
    if (v.targets.length > 0) {
      const d = p.degrade;
      if (d.refsTruncated || d.refsOmitted) v.foldBlocked = "refs";
      else if (d.wtHeadsCapped) v.foldBlocked = "wtheads";
      else if (d.badRecords) v.foldBlocked = "records";
      else if (d.parentsTruncated) v.foldBlocked = "parents";
    }
    return v;
  } catch {
    return emptyView();
  }
}

/** Whether this remote is exactly <R>/<target-name> at that target's oid. Split only the
 * remote prefix, preserving slash-containing local names (e.g. origin/feat/topic). */
function followsTarget(n: string, h: string, targets: ReadonlyMap<string, string>): boolean {
  const slash = n.indexOf("/");
  return slash > 0 && targets.get(n.slice(slash + 1)) === h;
}

/** Delete only target ancestry not needed by any retained tip, keeping original row order.
 * No parent rewrites: retained-tip ancestor closure means folding cannot create new stubs.
 * wouldHide is show-independent; a target depended on by a retained branch is not counted. */
export function foldMerged(p: WtGraphPayload, v: MergedView, show: boolean): FoldMergedResult {
  let commits: WtGraphCommit[] = [];
  const unchanged = (): FoldMergedResult => ({ commits, hiddenNow: [], wouldHide: [], hiddenCommits: 0, ops: 0 });
  try {
    if (Array.isArray(p.commits)) commits = p.commits;
    if (v.foldBlocked !== undefined || v.targets.length === 0) return unchanged();
    const index = indexOf(commits);
    const targets = new Map<string, string>();
    for (const name of v.targets) {
      const e = v.byBranch.get(name);
      if (e?.v === "eq" && p.refs.some((r) => r.k === "branch" && r.n === name && r.h === e.h)) {
        targets.set(name, e.h);
      }
    }
    const keepTips: string[] = p.head === undefined ? [] : [p.head.h];
    for (const w of p.wtHeads) keepTips.push(w.h);
    for (const r of p.refs) {
      if (r.k === "branch" && targets.get(r.n) === r.h) continue;
      if (r.k === "remote" && followsTarget(r.n, r.h, targets)) continue;
      keepTips.push(r.h); // tags, unrelated remotes and every non-target local branch
    }
    const meter = { ops: 0 };
    const keep = ancestors(index, keepTips, meter);
    const deleted = ancestors(index, targets.values(), meter, keep);
    const wouldHide = [...targets].filter(([, h]) => deleted.has(h)).map(([name]) => name);
    return {
      commits: show ? commits : commits.filter((c) => !deleted.has(c.h)),
      hiddenNow: show ? [] : wouldHide,
      wouldHide,
      hiddenCommits: show ? 0 : deleted.size,
      ops: meter.ops,
    };
  } catch {
    return unchanged();
  }
}

/** One badge per visible tip. Same-tip aliases share k/t, never add the same count twice.
 * none/anc/unk and HEAD-side copies get no badge (F1/F2); no reverse patch-id inference. */
export function mergedBadgeOf(p: WtGraphPayload, v: MergedView, h: string): MergedBadge | null {
  try {
    if (!p.commits.some((c) => c.h === h)) return null;
    let badge: MergedBadge | null = null;
    for (const e of v.byBranch.values()) {
      if (e.h !== h || (e.v !== "eq" && e.v !== "part")) continue;
      if (!p.refs.some((r) => r.k === "branch" && r.n === e.n && r.h === h)) continue;
      if (!Number.isSafeInteger(e.k) || !Number.isSafeInteger(e.t) || e.k! <= 0 || e.t! < e.k!) continue;
      if (badge === null) badge = { kind: e.v, k: e.k!, t: e.t!, branches: [] };
      if (badge.kind !== e.v || badge.k !== e.k || badge.t !== e.t) return null;
      badge.branches.push(e.n);
    }
    return badge;
  } catch {
    return null;
  }
}
