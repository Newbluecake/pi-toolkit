// @vitest-environment node
/** merged-plan §7.2 / §8.1 P3 / §9. No DOM, real git, wall-clock sleeps or random seeds. */
import { describe, expect, it } from "vitest";
import { foldMerged, mergedBadgeOf, mergedViewOf } from "../../../src/web-hub/ui/src/logic/gitGraphMerged.js";
import { layoutGraph } from "../../../src/web-hub/ui/src/logic/gitGraph.js";
import {
  parseWtGraphPayload,
  WTGRAPH_N,
  type WtGraphCommit,
  type WtGraphDegrade,
  type WtGraphMergedEntry,
  type WtGraphPayload,
  type WtGraphRef,
} from "../../../src/web-hub/protocol/worktree-graph.js";
import type { WorktreeRowWire } from "../../../src/web-hub/protocol/messages.js";

const oid = (i: number): string => i.toString(16).padStart(40, "0");
const commit = (i: number, parents: number[]): WtGraphCommit => ({
  h: oid(i),
  p: parents.map(oid),
  a: "A",
  t: 1,
  s: "same subject is not evidence",
});
const branch = (n: string, i: number): WtGraphRef => ({ k: "branch", n, h: oid(i) });
const eq = (n: string, i: number): WtGraphMergedEntry => ({ n, h: oid(i), v: "eq", k: 2, t: 2 });
const ids = (p: readonly WtGraphCommit[]): string[] => p.map((c) => c.h);

/** HEAD and two two-commit side branches share only [6,7]. */
function fixture(): WtGraphPayload {
  return {
    v: 1,
    n: WTGRAPH_N,
    format: "sha1",
    head: { h: oid(1), b: "main" },
    commits: [
      commit(1, [6]),
      commit(2, [3]),
      commit(3, [6]),
      commit(4, [5]),
      commit(5, [6]),
      commit(6, [7]),
      commit(7, []),
    ],
    refs: [branch("main", 1), branch("a", 2), branch("b", 4)],
    wtHeads: [],
    degrade: {},
    complete: true,
    merged: { v: 1, base: oid(1), branches: [eq("a", 2), eq("b", 4)] },
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function assertUnchanged(p: WtGraphPayload): void {
  const view = mergedViewOf(p, []);
  const result = foldMerged(p, view, false);
  expect(result.commits).toBe(p.commits);
  expect(result.hiddenNow).toEqual([]);
  expect(result.wouldHide).toEqual([]);
  expect(result.hiddenCommits).toBe(0);
}

describe("mergedViewOf / foldMerged — table-driven protections and completeness", () => {
  it("wire-valid fixture: exact deletion, landed set, no input mutation, both toggle directions", () => {
    const p = freeze(fixture());
    expect(parseWtGraphPayload(p)).toEqual(p);
    const before = JSON.stringify(p);
    const v = mergedViewOf(p, freeze([]));
    expect([...v.byBranch.keys()]).toEqual(["a", "b"]);
    expect(v.targets).toEqual(["a", "b"]);
    expect([...v.landed].sort()).toEqual([2, 3, 4, 5].map(oid));
    expect(v.foldBlocked).toBeUndefined();
    const snapshot = { targets: [...v.targets], landed: [...v.landed], entries: [...v.byBranch] };
    for (const show of [false, true, false, true]) {
      const r = foldMerged(p, v, show);
      expect(ids(r.commits)).toEqual((show ? [1, 2, 3, 4, 5, 6, 7] : [1, 6, 7]).map(oid));
      expect(r.wouldHide).toEqual(["a", "b"]);
      expect(r.hiddenNow).toEqual(show ? [] : ["a", "b"]);
      expect(r.hiddenCommits).toBe(show ? 0 : 4);
      if (show) expect(r.commits).toBe(p.commits);
    }
    expect(JSON.stringify(p)).toBe(before);
    expect({ targets: v.targets, landed: [...v.landed], entries: [...v.byBranch] }).toEqual(snapshot);
  });

  const protections: { name: string; change: (p: WtGraphPayload) => void; rows: WorktreeRowWire[] }[] = [
    {
      name: "head.b (including moved branch)",
      change: (p) => {
        p.head!.b = "a";
      },
      rows: [],
    },
    {
      name: "entry co:true",
      change: (p) => {
        p.merged!.branches[0]!.co = true;
      },
      rows: [],
    },
    { name: "attached worktree row branch", change: () => {}, rows: [{ label: "other", path: "/other", branch: "a" }] },
    {
      name: "any wtHeads full oid (detached too)",
      change: (p) => {
        p.wtHeads = [{ h: oid(2), path: "/detached" }];
      },
      rows: [],
    },
  ];
  it.each(protections)("protects $name but keeps the eq annotation", ({ change, rows }) => {
    const p = fixture();
    change(p);
    const v = mergedViewOf(p, rows);
    expect(v.targets).toEqual(["b"]);
    expect(v.landed.has(oid(2))).toBe(true);
    expect(mergedBadgeOf(p, v, oid(2))).toEqual({ kind: "eq", k: 2, t: 2, branches: ["a"] });
    const r = foldMerged(p, v, false);
    expect(ids(r.commits)).toEqual([1, 2, 3, 6, 7].map(oid));
    expect(r.wouldHide).toEqual(["b"]);
    expect(r.hiddenCommits).toBe(2);
  });

  const blockers: { degrade: WtGraphDegrade; reason: string }[] = [
    { degrade: { refsTruncated: true }, reason: "refs" },
    { degrade: { refsOmitted: 1 }, reason: "refs" },
    { degrade: { wtHeadsCapped: true }, reason: "wtheads" },
    { degrade: { badRecords: 1 }, reason: "records" },
    { degrade: { parentsTruncated: 1 }, reason: "parents" },
  ];
  it.each(blockers)("blocks folding for $degrade, retaining badges", ({ degrade, reason }) => {
    const p = fixture();
    p.degrade = degrade;
    p.complete = false;
    const v = mergedViewOf(p, []);
    expect(v.foldBlocked).toBe(reason);
    expect(mergedBadgeOf(p, v, oid(2))?.kind).toBe("eq");
    for (const show of [false, true]) {
      const r = foldMerged(p, v, show);
      expect(r.commits).toBe(p.commits);
      expect(r.wouldHide).toEqual([]);
      expect(r.hiddenNow).toEqual([]);
      expect(r.hiddenCommits).toBe(0);
    }
  });
  it.each(blockers)("does not set foldBlocked for empty targets + $degrade", ({ degrade }) => {
    const p = fixture();
    p.degrade = degrade;
    p.complete = false;
    p.merged!.branches = p.merged!.branches.map((e) => ({ ...e, v: "none", k: 0 }));
    expect(mergedViewOf(p, []).foldBlocked).toBeUndefined();
    assertUnchanged(p); // all-none + degraded is the P5 DOM parity premise
    // Protected eq entries also leave targets empty, even when annotations exist.
    p.merged!.branches = [eq("a", 2), eq("b", 4)].map((e) => ({ ...e, co: true }));
    expect(mergedViewOf(p, []).targets).toEqual([]);
    expect(mergedViewOf(p, []).foldBlocked).toBeUndefined();
  });

  it.each<WtGraphDegrade>([{ more: true }, { logCapped: true }, { trimmed: 1 }, { refsSkipped: 1 }])(
    "tail-only or skipped-ref degradation does not block: %j",
    (degrade) => {
      const p = fixture();
      p.degrade = degrade;
      p.shallow = true;
      const v = mergedViewOf(p, []);
      expect(v.foldBlocked).toBeUndefined();
      expect(ids(foldMerged(p, v, false).commits)).toEqual([1, 6, 7].map(oid));
    },
  );
  it("block reason has deterministic refs > wtheads > records > parents precedence", () => {
    const p = fixture();
    p.degrade = { refsOmitted: 1, wtHeadsCapped: true, badRecords: 1, parentsTruncated: 1 };
    expect(mergedViewOf(p, []).foldBlocked).toBe("refs");
  });
});

describe("keep tips, remote followers and branch counts", () => {
  it.each(["origin/a", "upstream/a"])("same-name same-tip %s follows the target", (n) => {
    const p = fixture();
    p.refs.push({ k: "remote", n, h: oid(2) });
    expect(ids(foldMerged(p, mergedViewOf(p, []), false).commits)).toEqual([1, 6, 7].map(oid));
  });
  it("slash-containing branch names follow only the exact remote tail", () => {
    const p = fixture();
    p.refs[1]!.n = "feat/topic";
    p.merged!.branches[0]!.n = "feat/topic";
    p.refs.push({ k: "remote", n: "origin/feat/topic", h: oid(2) });
    expect(foldMerged(p, mergedViewOf(p, []), false).wouldHide).toEqual(["feat/topic", "b"]);
    p.refs.push({ k: "remote", n: "origin/other/topic", h: oid(2) });
    expect(foldMerged(p, mergedViewOf(p, []), false).wouldHide).toEqual(["b"]);
  });
  it.each<WtGraphRef>([
    { k: "remote", n: "origin/other", h: oid(2) },
    { k: "remote", n: "origin/a", h: oid(3) },
    { k: "remote", n: "origin/HEAD", h: oid(2), sym: true },
    { k: "tag", n: "a", h: oid(2) },
    { k: "branch", n: "unclassified-alias", h: oid(2) },
  ])("retains independent ref %j (no broad remote or tag removal)", (ref) => {
    const p = fixture();
    p.refs.push(ref);
    const r = foldMerged(p, mergedViewOf(p, []), false);
    expect(r.commits.some((c) => c.h === ref.h)).toBe(true);
    expect(r.wouldHide).toEqual(ref.h === oid(3) ? ["a", "b"] : ["b"]);
    expect(r.hiddenCommits).toBe(ref.h === oid(3) ? 3 : 2);
  });
  it("unmerged child on top of a target retains all dependencies and excludes that target from wouldHide", () => {
    const p = fixture();
    p.commits.unshift(commit(8, [2]));
    p.refs.push(branch("pending", 8));
    p.merged!.branches.push({ n: "pending", h: oid(8), v: "none", k: 0, t: 1 });
    const v = mergedViewOf(p, []);
    const r = foldMerged(p, v, false);
    expect(v.targets).toEqual(["a", "b"]);
    expect(ids(r.commits)).toEqual([8, 1, 2, 3, 6, 7].map(oid));
    expect(r.wouldHide).toEqual(["b"]);
    expect(r.hiddenNow).toEqual(["b"]);
    expect(v.landed.has(oid(2))).toBe(true); // retained dependency still carries its badge/color
    expect(layoutGraph(r.commits).stubs.length).toBeLessThanOrEqual(layoutGraph(p.commits).stubs.length);
  });
  it("same-tip target aliases count as branches but share the badge k/t", () => {
    const p = fixture();
    p.refs.push(branch("a-alias", 2));
    p.merged!.branches.push(eq("a-alias", 2));
    const v = mergedViewOf(p, []);
    const r = foldMerged(p, v, false);
    expect(r.wouldHide).toEqual(["a", "b", "a-alias"]);
    expect(r.hiddenCommits).toBe(4);
    expect(mergedBadgeOf(p, v, oid(2))).toEqual({ kind: "eq", k: 2, t: 2, branches: ["a", "a-alias"] });
    p.merged!.branches[2]!.co = true;
    expect(foldMerged(p, mergedViewOf(p, []), false).wouldHide).toEqual(["b"]);
  });
  it("HEAD ancestor targets have no unique rows and never increase hidden counts", () => {
    const p = fixture();
    p.refs.push(branch("ancestor", 6));
    p.merged!.branches.push(eq("ancestor", 6));
    const r = foldMerged(p, mergedViewOf(p, []), false);
    expect(r.wouldHide).toEqual(["a", "b"]);
    expect(r.hiddenCommits).toBe(4);
  });
  it("an unrelated orphan row remains in place (only target ancestry can be removed)", () => {
    const p = fixture();
    p.commits.splice(2, 0, commit(9, []));
    expect(ids(foldMerged(p, mergedViewOf(p, []), false).commits)).toEqual([1, 9, 6, 7].map(oid));
  });
});

describe("annotation validation, F1/F2 and eP", () => {
  it.each([true, false])("part e only (eP=%s), never infer remaining landed rows or fold part", (eP) => {
    const p = fixture();
    const entry: WtGraphMergedEntry = { n: "a", h: oid(2), v: "part", k: 1, t: 2, e: [oid(3)] };
    if (eP) entry.eP = true;
    p.merged!.branches = [entry];
    const v = mergedViewOf(p, []);
    expect([...v.landed]).toEqual([oid(3)]);
    expect(v.targets).toEqual([]);
    expect(v.byBranch.get("a")?.eP).toBe(eP ? true : undefined);
    expect(mergedBadgeOf(p, v, oid(2))).toEqual({ kind: "part", k: 1, t: 2, branches: ["a"] });
    expect(mergedBadgeOf(p, v, oid(1))).toBeNull(); // no HEAD-side reverse annotation
    assertUnchanged(p);
    delete entry.e;
    expect([...mergedViewOf(p, []).landed]).toEqual([]);
  });
  it.each<WtGraphMergedEntry>([
    { n: "a", h: oid(2), v: "none", k: 0, t: 2 },
    { n: "a", h: oid(2), v: "anc" },
    { n: "a", h: oid(2), v: "unk", why: "timeout" },
  ])("%j has no badge, weak heuristic or landed rows", (entry) => {
    const p = fixture();
    p.merged!.branches = [entry];
    const v = mergedViewOf(p, []);
    expect(mergedBadgeOf(p, v, oid(2))).toBeNull();
    expect(v.landed.size).toBe(0);
    expect(v.targets).toEqual([]);
    assertUnchanged(p);
  });
  it("accepts only matching local n/h entries (not remotes, absent names or moved tips)", () => {
    const p = fixture();
    p.refs.push({ k: "remote", n: "origin/a", h: oid(2) });
    p.merged!.branches = [eq("absent", 2), eq("a", 3), eq("origin/a", 2), eq("b", 4)];
    const v = mergedViewOf(p, []);
    expect([...v.byBranch.keys()]).toEqual(["b"]);
    expect(v.targets).toEqual(["b"]);
    expect(mergedBadgeOf(p, v, oid(2))).toBeNull();
  });
  it("same-tip part entries share e; eP only suppresses inference", () => {
    const p = fixture();
    p.refs.push(branch("alias", 2));
    p.merged!.branches = [
      { n: "a", h: oid(2), v: "part", k: 1, t: 2, e: [oid(3)], eP: true },
      { n: "alias", h: oid(2), v: "part", k: 1, t: 2, eP: true },
    ];
    const v = mergedViewOf(p, []);
    expect([...v.landed]).toEqual([oid(3)]);
    expect(mergedBadgeOf(p, v, oid(2))).toEqual({ kind: "part", k: 1, t: 2, branches: ["a", "alias"] });
  });
  it("no merged / skipped / stale base disable annotations and folding", () => {
    for (const state of ["absent", "skipped", "base"] as const) {
      const p = fixture();
      if (state === "absent") delete p.merged;
      else if (state === "skipped") p.merged = { v: 1, base: oid(1), skipped: "shallow", branches: [] };
      else p.merged!.base = oid(100);
      const v = mergedViewOf(p, []);
      expect(v.byBranch.size).toBe(0);
      expect(v.landed.size).toBe(0);
      expect(mergedBadgeOf(p, v, oid(2))).toBeNull();
      assertUnchanged(p);
    }
  });
  it("stray out-of-window tips never create a row badge or landed oid", () => {
    const p = fixture();
    p.refs.push(branch("outside", 99));
    p.merged!.branches = [eq("outside", 99)];
    const v = mergedViewOf(p, []);
    expect(v.landed.size).toBe(0);
    expect(mergedBadgeOf(p, v, oid(99))).toBeNull();
    expect(foldMerged(p, v, false).wouldHide).toEqual([]);
  });
  it("empty graph is a no-op", () => {
    const p: WtGraphPayload = {
      v: 1,
      n: WTGRAPH_N,
      format: "sha1",
      commits: [],
      refs: [],
      wtHeads: [],
      degrade: {},
      complete: true,
      empty: true,
    };
    assertUnchanged(p);
    expect(mergedBadgeOf(p, mergedViewOf(p, []), oid(2))).toBeNull();
  });
  it("degenerate/accessor-throwing input fails closed with exact fallback values", () => {
    const good = fixture();
    const empty = { byBranch: new Map(), landed: new Set(), targets: [], ops: 0 };
    const bad = {
      get merged(): never {
        throw new Error("unreadable");
      },
    } as unknown as WtGraphPayload;
    expect(mergedViewOf(bad, [])).toEqual(empty);
    expect(mergedViewOf(null as unknown as WtGraphPayload, [])).toEqual(empty);
    const p = fixture();
    Object.defineProperty(p.commits[1], "p", {
      get(): never {
        throw new Error("unreadable parents");
      },
    });
    expect(mergedViewOf(p, [])).toEqual(empty);
    const r = foldMerged(p, mergedViewOf(good, []), false);
    expect(r).toEqual({ commits: p.commits, hiddenNow: [], wouldHide: [], hiddenCommits: 0, ops: 0 });
    expect(mergedBadgeOf(good, null as never, oid(2))).toBeNull();
    expect(foldMerged(null as never, empty, false)).toEqual({
      commits: [],
      hiddenNow: [],
      wouldHide: [],
      hiddenCommits: 0,
      ops: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Independent oracle + fixed-seed DAG properties. Every maximal child has a ref: like
// Gl's real output, the graph is covered by snapshot tips, not arbitrary orphan children.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** DFS oracle deliberately does NOT share the production BFS, stop set, index or remote splitter. */
function oracleAnc(p: WtGraphPayload, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...tips];
  while (pending.length > 0) {
    const h = pending.pop()!;
    if (seen.has(h)) continue;
    const c = p.commits.find((c) => c.h === h);
    if (c === undefined) continue;
    seen.add(h);
    pending.push(...c.p);
  }
  return seen;
}

function randomPayload(rand: () => number): { p: WtGraphPayload; rows: WorktreeRowWire[] } {
  const n = 8 + Math.floor(rand() * 53);
  const p = fixture();
  p.commits = Array.from({ length: n }, (_, i) => {
    const parents = new Set<number>();
    const count = Math.floor(rand() * 5);
    for (let j = 0; j < count; j++) {
      const parent = i + 2 + Math.floor(rand() * (n - i + 3)); // some out-of-window tails
      parents.add(parent);
    }
    return commit(i + 1, [...parents]);
  });
  const hasChild = new Set(p.commits.flatMap((c) => c.p));
  p.refs = p.commits.filter((c) => !hasChild.has(c.h)).map((c, i) => ({ k: "branch", n: `tip/${i}`, h: c.h }));
  for (let i = 0; i < 5; i++) p.refs.push(branch(`extra-${i}`, 1 + Math.floor(rand() * n)));
  p.head = { h: p.refs[0]!.h, b: p.refs[0]!.n };
  p.merged = { v: 1, base: p.head.h, branches: [] };
  const rows: WorktreeRowWire[] = [];
  const locals = [...p.refs];
  for (const r of locals) {
    const kind = Math.floor(rand() * 5);
    const e: WtGraphMergedEntry = { n: r.n, h: r.h, v: "anc" };
    if (kind <= 1) Object.assign(e, { v: "eq", k: 2, t: 2 });
    else if (kind === 2) Object.assign(e, { v: "part", k: 1, t: 2, e: [r.h], eP: true });
    else if (kind === 3) Object.assign(e, { v: "none", k: 0, t: 2 });
    if (rand() < 0.08) e.co = true;
    if (p.merged.branches.length < 24) p.merged.branches.push(e);
    if (rand() < 0.08) rows.push({ label: r.n, branch: r.n });
    if (rand() < 0.08) p.wtHeads.push({ h: r.h, path: `/wt/${r.n}` });
    if (rand() < 0.15) p.refs.push({ k: "tag", n: `tag-${r.n}`, h: r.h });
    if (rand() < 0.3) p.refs.push({ k: "remote", n: `origin/${r.n}`, h: r.h });
    if (rand() < 0.15) p.refs.push({ k: "remote", n: `upstream/other-${r.n}`, h: r.h });
  }
  return { p, rows };
}

describe("fixed seed 0x48_5033 — 1000 random DAGs + refs/judgements", () => {
  it("only permitted target-unique rows disappear; all other rows and order survive; no new stubs", () => {
    const rand = mulberry32(0x48_5033);
    let deletedTotal = 0;
    let partialTotal = 0;
    for (let test = 0; test < 1000; test++) {
      const { p, rows } = randomPayload(rand);
      const before = JSON.stringify(p);
      const v = mergedViewOf(p, rows);
      const targets = p.merged!.branches.filter(
        (e) =>
          e.v === "eq" &&
          e.n !== p.head!.b &&
          !e.co &&
          !rows.some((r) => r.branch === e.n) &&
          !p.wtHeads.some((w) => w.h === e.h),
      );
      expect(v.targets, `case ${test} targets`).toEqual(targets.map((e) => e.n));
      const keepTips = [p.head!.h, ...p.wtHeads.map((w) => w.h)];
      for (const ref of p.refs) {
        const targetLocal = ref.k === "branch" && targets.some((e) => e.n === ref.n && e.h === ref.h);
        const targetRemote =
          ref.k === "remote" &&
          targets.some((e) => ref.h === e.h && ["origin", "upstream"].some((remote) => ref.n === `${remote}/${e.n}`));
        if (!targetLocal && !targetRemote) keepTips.push(ref.h);
      }
      const keep = oracleAnc(p, keepTips);
      const unique = oracleAnc(
        p,
        targets.map((e) => e.h),
      );
      const headAnc = oracleAnc(p, [p.head!.h]);
      const allowed = new Set([...unique].filter((h) => !headAnc.has(h) && !keep.has(h)));
      const r = foldMerged(p, v, false);
      const deleted = p.commits.filter((c) => !r.commits.includes(c));
      deletedTotal += deleted.length;
      partialTotal += p.merged!.branches.filter((e) => e.v === "part").length;
      expect(
        deleted.every((c) => allowed.has(c.h)),
        `case ${test} deletion subset`,
      ).toBe(true);
      expect(ids(r.commits), `case ${test} non-target survival + exact original order`).toEqual(
        p.commits.filter((c) => !allowed.has(c.h)).map((c) => c.h),
      );
      expect(r.hiddenCommits).toBe(deleted.length);
      expect(r.wouldHide).toEqual(targets.filter((e) => allowed.has(e.h)).map((e) => e.n));
      expect(r.hiddenNow).toEqual(r.wouldHide);
      expect(layoutGraph(r.commits).stubs.length, `case ${test} stubs`).toBeLessThanOrEqual(
        layoutGraph(p.commits).stubs.length,
      );
      const expanded = foldMerged(p, v, true);
      expect(expanded.commits).toBe(p.commits);
      expect(expanded.wouldHide).toEqual(r.wouldHide);
      expect(expanded.hiddenNow).toEqual([]);
      expect(expanded.hiddenCommits).toBe(0);
      expect(JSON.stringify(p)).toBe(before);
    }
    expect(deletedTotal).toBeGreaterThan(1000); // the seed actually exercises deletion, not vacuous no-ops
    expect(partialTotal).toBeGreaterThan(1000);
  });
});

// Same two topology builders as logic-git-graph.test.ts; kept local to avoid importing a
// test module (and registering its suites twice). Caps are intentionally exceeded for stress.
function octopusFixture(): WtGraphCommit[] {
  const out: WtGraphCommit[] = [];
  for (let m = 125; m >= 1; m--) {
    const fresh = m === 1 ? 8 : 7;
    const roots = Array.from({ length: fresh }, (_, i) => 2000 + m * 8 + i);
    out.push(commit(m, m > 1 ? [m - 1, ...roots] : roots));
    for (const root of roots) out.push(commit(root, []));
  }
  return out;
}
function wideFixture(): WtGraphCommit[] {
  const out: WtGraphCommit[] = [];
  for (let level = 9; level >= 0; level--) {
    for (let chain = 0; chain < 100; chain++) {
      out.push(commit(1 + level * 100 + chain, level > 0 ? [1 + (level - 1) * 100 + chain] : []));
    }
  }
  return out;
}

function stressPayload(commits: WtGraphCommit[]): WtGraphPayload {
  const p = fixture();
  p.commits = commits;
  // The octopus HEAD protects its ancestors; wide HEAD protects one chain. All other
  // source tips have local refs so both stress fixtures retain real Gl tip coverage.
  const hasChild = new Set(commits.flatMap((c) => c.p));
  p.refs = commits.filter((c) => !hasChild.has(c.h)).map((c, i) => ({ k: "branch", n: `source-${i}`, h: c.h }));
  p.head = { h: p.refs[0]!.h, b: p.refs[0]!.n };
  p.merged = { v: 1, base: p.head.h, branches: [] };
  const selected = commits.slice(1, 25);
  for (const [i, c] of selected.entries()) {
    // Reuse frontier refs: otherwise a retained source alias would make the wide
    // fixture a vacuous no-deletion benchmark instead of actually hiding 24 chains.
    const existing = p.refs.find((r) => r.h === c.h);
    const n = existing?.n ?? `merged-${i}`;
    if (existing === undefined) p.refs.push({ k: "branch", n, h: c.h });
    p.merged.branches.push({ n, h: c.h, v: "eq", k: 1, t: 1 });
  }
  while (p.refs.length < 400) p.refs.push({ k: "remote", n: `origin/retained-${p.refs.length}`, h: commits.at(-1)!.h });
  return p;
}

describe("§9 stress bounds and timing", () => {
  it.each([
    { name: "125 octopus merges", commits: octopusFixture(), n: 1001, edges: 1000 },
    { name: "100 parallel chains", commits: wideFixture(), n: 1000, edges: 900 },
  ])("$name + 400 refs + 24 judgements: ops ≤ 25×(N+E), median of 3 ×3 ≤20ms", ({ name, commits, n, edges }) => {
    expect(commits).toHaveLength(n);
    expect(commits.reduce((sum, c) => sum + c.p.length, 0)).toBe(edges);
    const p = stressPayload(commits);
    expect(p.refs).toHaveLength(400);
    expect(p.merged!.branches).toHaveLength(24);
    const folded = foldMerged(p, mergedViewOf(p, []), false);
    expect(folded.hiddenCommits).toBe(name === "100 parallel chains" ? 240 : 0);
    expect(folded.wouldHide).toHaveLength(name === "100 parallel chains" ? 24 : 0);
    expect(layoutGraph(folded.commits).stubs.length).toBeLessThanOrEqual(layoutGraph(p.commits).stubs.length);
    const run = (): number => {
      const v = mergedViewOf(p, []);
      const r = foldMerged(p, v, false);
      return v.ops + r.ops;
    };
    const ops = run();
    expect(ops).toBeGreaterThan(0);
    expect(ops).toBeLessThanOrEqual(25 * (n + edges));
    for (let i = 0; i < 5; i++) run(); // warm JIT outside measured samples
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[1]!;
    console.info(
      `[merged P3] ${name}: N=${n} E=${edges} refs=400 entries=24 ops=${ops} bound=${25 * (n + edges)} median=${median.toFixed(3)}ms x3=${(median * 3).toFixed(3)}ms`,
    );
    expect(median * 3).toBeLessThanOrEqual(20);
  });
});
