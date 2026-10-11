// @vitest-environment node
/**
 * worktree-graph plan v2 §7 P3 (UI 逻辑) — `ui/src/logic/gitGraph.ts` + `ui/src/logic/
 * gitGraphScope.ts` acceptance. Everything pure (node env, no DOM/Vue/timers):
 *
 * - varA dataset (the user-approved mockup `/home/bluecake/snap/chromium/common/pwh-gitgraph/
 *   varA.html`, synthetic-but-plausible 16-commit history) as a REAL wire payload through the
 *   frozen P0 parser, then a row-by-row layout snapshot + topo validation (§4.1: every in-set
 *   parent edge has exactly one route, endpoints real, no route's straight run passes another
 *   node — no false connections).
 * - Bounds + timing (#6): the consecutive 8-parent octopus merge ×125 fixture (1001 nodes —
 *   8M+1, the closest exact form of the plan's「各 1000 节点」with every merge at the full
 *   P=8) and the 100-way wide DAG (1000 nodes, 100 parallel lanes): `ops ≤ N·(E+1)`,
 *   `routes + stubs ≤ E + N·P` (P = `WTGRAPH_PARENTS_MAX`), single layout ≤ 100 ms (median
 *   of 3, generous for CI).
 * - Fold (#6): hidden lanes never produce connected segments; fold node/stub/⋮-mark markers
 *   correct on varA (limit 1), the wide DAG (limits 4/12) and the octopus (limit 4) — plus
 *   the VERIFIER ROUND-2 invariants everywhere a fold is asserted: a kept route must have its
 *   run lane AND BOTH endpoint node lanes below the cap (an origin sitting in the fold column
 *   must never hand P5 a connected curve — the blocker), and every route with exactly one
 *   hidden endpoint yields the matching depart/arrive arrow stub at its visible end; pinned
 *   by an explicit adversarial regression fixture (a pk≥1 merge into an early low-lane wait
 *   whose originating commit lands in a hidden lane).
 * - §4.2: `refChipsOf` (local+same-oid same-name remote merged `master | origin`, standalone
 *   remotes, `sym` small chips, tags, `HEAD → …`, detached HEAD, multi-remote merge, full
 *   deterministic ordering), `wtRingsOf` (FULL-oid matching — the 7-char `StatusInfo` head
 *   never matches; label by exact `path` row, else basename), `formatCommitDate` (absolute,
 *   any TZ — instants are built from local wall-clock parts), `pathD`/`stubPathD` geometry.
 * - Scope truth table: `wtgraphScopeOf` (wtgraph.v1, LAN rides preview.lan.v1), `pickGraphWt`
 *   (current → main → null), `graphSigOf` (change detection).
 * - Seeded (#6): fixed-seed (mulberry32, never `Math.random`) 1000-case random DAG property
 *   test — layoutGraph/foldLayout never throw, topo invariants hold on every case.
 */
import { describe, expect, it } from "vitest";
import {
  foldLayout,
  formatCommitDate,
  commitDateParts,
  GRAPH_LANE_COLORS,
  GRAPH_STUB_LEN,
  layoutGraph,
  pathD,
  refChipsOf,
  rowLaneExtent,
  stubPathD,
  wtRingsOf,
  type FoldLayout,
  type GraphLayout,
  type GraphNode,
  type GraphRoute,
} from "../../../src/web-hub/ui/src/logic/gitGraph.js";
import { graphSigOf, pickGraphWt, wtgraphScopeOf } from "../../../src/web-hub/ui/src/logic/gitGraphScope.js";
import {
  parseWtGraphPayload,
  WTGRAPH_N,
  WTGRAPH_PARENTS_MAX,
  type WtGraphCommit,
  type WtGraphPayload,
  type WtGraphRef,
} from "../../../src/web-hub/protocol/worktree-graph.js";
import { PREVIEW_LAN_HUB_CAP, WTGRAPH_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { WorktreeRowWire } from "../../../src/web-hub/protocol/messages.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 40-hex sha1 from a short prefix (mockup hashes are 7 chars) — distinct, wire-legal. */
function oid(short: string): string {
  return (short + "0".repeat(40)).slice(0, 40);
}

/** Collision-proof fixture id: pads with `f`, so `m12` and `m120` stay distinct (`oid`'s
 *  zero-padding would collapse them — digit-terminated ids are prefixes of each other). */
function fid(id: string): string {
  return (id + "f".repeat(40)).slice(0, 40);
}

function snapLayout(l: GraphLayout): string {
  const rows = l.nodes.map((n, i) => `${i} lane=${n.lane} c${n.color}`).join("\n");
  const routes = l.routes.map((r) => `${r.from}->${r.to}@${r.lane}#c${r.color}`).join(" ");
  const stubs = l.stubs.map((s) => `${s.from}@${s.lane}#c${s.color}`).join(" ");
  return `lanes=${l.laneCount}\n${rows}\nroutes: ${routes}\nstubs: ${stubs}`;
}

/** §4.1 topo validation: route⇔edge bijection, endpoints real, no false connections.
 *  The no-false-connection check is O(E log N): nodes pre-bucketed per lane (ascending row
 *  order), one binary search per route — the naive per-row scan would make the 1000-case
 *  property test dominate the suite through per-row `expect` overhead. */
function assertTopo(label: string, commits: WtGraphCommit[], layout: GraphLayout): void {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.h, i));
  const expected = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    for (const p of commits[i]!.p) {
      const j = rowOf.get(p);
      if (j !== undefined && j > i) {
        const key = `${i}>${j}`;
        expected.set(key, (expected.get(key) ?? 0) + 1);
      }
    }
  }
  const rowsByLane = new Map<number, number[]>();
  layout.nodes.forEach((nd, i) => {
    const arr = rowsByLane.get(nd.lane);
    if (arr === undefined) rowsByLane.set(nd.lane, [i]);
    else arr.push(i);
  });
  const got = new Map<string, number>();
  for (const r of layout.routes) {
    if (!(r.from >= 0 && r.to > r.from && r.to < layout.nodes.length)) {
      throw new Error(`${label}: route endpoints broken: ${r.from}->${r.to} (N=${layout.nodes.length})`);
    }
    const key = `${r.from}>${r.to}`;
    got.set(key, (got.get(key) ?? 0) + 1);
    const rows = rowsByLane.get(r.lane) ?? [];
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]! <= r.from) lo = mid + 1;
      else hi = mid;
    }
    if (lo < rows.length && rows[lo]! < r.to) {
      throw new Error(`${label}: route ${r.from}->${r.to}@${r.lane} passes node row ${rows[lo]} — false connection`);
    }
  }
  expect([...got.entries()].sort(), `${label}: route multiset === in-set edge multiset`).toEqual(
    [...expected.entries()].sort(),
  );
  for (const [i, nd] of layout.nodes.entries()) {
    if (nd.lane >= layout.laneCount) throw new Error(`${label}: node ${i} lane ${nd.lane} ≥ laneCount`);
    if (nd.color >= GRAPH_LANE_COLORS) throw new Error(`${label}: node ${i} color ${nd.color} ≥ palette`);
  }
  for (const s of layout.stubs) {
    if (!(s.from >= 0 && s.from < layout.nodes.length && s.lane >= 0 && s.lane < layout.laneCount)) {
      throw new Error(`${label}: stub out of range: ${s.from}@${s.lane}`);
    }
  }
}

/** Verifier round-2 fold invariants (#6 blocker + major): (a) every KEPT route is fully
 *  visible — run lane AND both endpoint node lanes below the cap (an origin/destination
 *  drawn in the fold column must never yield a connected path through the fold region);
 *  (b) every route with exactly ONE hidden endpoint yields the matching arrow stub at its
 *  visible end (depart from a visible origin / arrive into a visible destination). */
function assertFoldVisible(label: string, layout: GraphLayout, folded: FoldLayout, limit: number): void {
  for (const r of folded.routes) {
    if (!(r.lane < limit)) {
      throw new Error(`${label}: kept route ${r.from}->${r.to}@${r.lane} has a hidden run lane`);
    }
    const a = layout.nodes[r.from];
    const b = layout.nodes[r.to];
    if (a === undefined || b === undefined) {
      throw new Error(`${label}: kept route ${r.from}->${r.to} has a missing endpoint node`);
    }
    if (a.lane >= limit) {
      throw new Error(
        `${label}: kept route ${r.from}->${r.to}@${r.lane} origin node lane ${a.lane} >= ${limit} (fold-column origin — connected curve through the fold region)`,
      );
    }
    if (b.lane >= limit) {
      throw new Error(`${label}: kept route ${r.from}->${r.to}@${r.lane} destination node lane ${b.lane} >= ${limit}`);
    }
  }
  const n = layout.nodes.length;
  for (const r of layout.routes) {
    if (r.from < 0 || r.to <= r.from || r.from >= n || r.to >= n) continue; // defensive records
    const a = layout.nodes[r.from];
    const b = layout.nodes[r.to];
    if (a === undefined || b === undefined) continue;
    const fromHidden = a.lane >= limit;
    const toHidden = b.lane >= limit;
    if (fromHidden === toHidden) continue; // both visible (kept) or both hidden (no stub)
    const want = fromHidden
      ? { from: r.to, lane: b.lane, at: "arrive" as const }
      : { from: r.from, lane: a.lane, at: "depart" as const };
    const has = folded.foldStubs.some((s) => s.from === want.from && s.lane === want.lane && s.at === want.at);
    if (!has) {
      throw new Error(
        `${label}: route ${r.from}->${r.to}@${r.lane} with a hidden ${fromHidden ? "origin" : "destination"} lacks its ${want.at} arrow stub at row ${want.from}`,
      );
    }
  }
}

/** Deterministic PRNG (mulberry32) — §7 P3: no `Math.random` anywhere in this suite. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function medianOf3(fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  return times[1]!;
}

// ---------------------------------------------------------------------------
// varA dataset (mockup varA.html — 16 commits, master + merged feat + 2 agent worktrees)
// ---------------------------------------------------------------------------

const H = {
  e02: oid("e02a5f9"),
  d1b: oid("d1b4c60"),
  w897: oid("897baf5"),
  w8eb: oid("8ebf1e0"),
  t3bb: oid("3bb87a2"),
  a71: oid("a71e2c0"),
  s944: oid("944367a"),
  f50: oid("f5037f2"),
  c51: oid("c513380"),
  m6a9: oid("6a9e7e5"),
  b41: oid("b41d77c"),
  e5e0: oid("5e0a91c"),
  r309: oid("309e2c3"),
  r77c: oid("77c0d3a"),
  n955: oid("955cceb"),
  ee4: oid("ee4459b"),
} as const;

function varACommits(): WtGraphCommit[] {
  const mk = (h: string, p: string[], s: string): WtGraphCommit => ({ h, p, a: "Blue Cake", t: 1_790_000_000, s });
  return [
    mk(H.e02, [H.d1b], "chore: scratch build matrix probe"),
    mk(H.d1b, [H.w8eb], "wip: rebuild loop with pinned fds"),
    mk(H.w897, [H.w8eb], "feat(consult): core types for consult A/B instrumentation"),
    mk(H.w8eb, [H.m6a9], "feat(exp): consult A/B arm-draw and analysis scripts"),
    mk(H.t3bb, [H.a71], "wip(worktree): probe retry ladder"),
    mk(H.a71, [H.s944], "fix(worktree): sampler zombie rerun dropped"),
    mk(H.s944, [H.f50], "feat(worktree): fingerprint-gated publish"),
    mk(H.f50, [H.c51], "feat(worktree): diff-index plumbing via pinned fds"),
    mk(H.c51, [H.m6a9], "feat(worktree): bounded git executor"),
    mk(H.m6a9, [H.r309, H.b41], "Merge branch 'feat/session-nav-rewrite'"),
    mk(H.b41, [H.e5e0], "feat(session-nav): resume-list title cleaning"),
    mk(H.e5e0, [H.r77c], "refactor(session-nav): editor wrapper pre-submit"),
    mk(H.r309, [H.n955], "feat(topic-switch): judge model chain failover"),
    mk(H.r77c, [H.n955], "docs(session-nav): usage notes"),
    mk(H.n955, [H.ee4], "fix(web-hub): composer row aligns with the transcript column"),
    mk(H.ee4, [], "feat(web-hub): compact session-history dialog"),
  ];
}

function varARefs(): WtGraphRef[] {
  return [
    { k: "branch", n: "master", h: H.w897, up: "origin/master" },
    { k: "remote", n: "origin/master", h: H.w897 },
    { k: "branch", n: "feat/session-nav-rewrite", h: H.b41 },
    { k: "branch", n: "pi-agent-r_7KQ2Z9XA", h: H.t3bb },
    { k: "branch", n: "pi-agent-r_M4T8WP1D", h: H.e02 },
  ];
}

/** The mockup's four `StatusInfo.worktrees` rows (labels/paths/branches verbatim). */
const VARA_ROWS: readonly WorktreeRowWire[] = [
  {
    label: "~/ai/pi-toolkit",
    path: "/home/bluecake/ai/pi-toolkit",
    branch: "master",
    head: "897baf5",
    current: true,
    main: true,
  },
  {
    label: "~/ai/wt-session-nav",
    path: "/home/bluecake/ai/wt-session-nav",
    branch: "feat/session-nav-rewrite",
    head: "b41d77c",
  },
  {
    label: "/tmp/pi-subagent-worktrees/r_7KQ2Z9XA",
    path: "/tmp/pi-subagent-worktrees/r_7KQ2Z9XA",
    branch: "pi-agent-r_7KQ2Z9XA",
    head: "3bb87a2",
    agentRunId: "r_7KQ2Z9XA",
  },
  {
    label: "/tmp/pi-subagent-worktrees/r_M4T8WP1D",
    path: "/tmp/pi-subagent-worktrees/r_M4T8WP1D",
    branch: "pi-agent-r_M4T8WP1D",
    head: "e02a5f9",
    agentRunId: "r_M4T8WP1D",
  },
];

function varAPayload(): WtGraphPayload {
  const raw = {
    v: 1,
    n: WTGRAPH_N,
    format: "sha1" as const,
    commits: varACommits(),
    refs: varARefs(),
    wtHeads: [
      { h: H.w897, path: "/home/bluecake/ai/pi-toolkit", b: "master", self: true },
      { h: H.b41, path: "/home/bluecake/ai/wt-session-nav", b: "feat/session-nav-rewrite" },
      { h: H.t3bb, path: "/tmp/pi-subagent-worktrees/r_7KQ2Z9XA", b: "pi-agent-r_7KQ2Z9XA" },
      { h: H.e02, path: "/tmp/pi-subagent-worktrees/r_M4T8WP1D", b: "pi-agent-r_M4T8WP1D" },
    ],
    degrade: {},
    complete: true,
    head: { h: H.w897, b: "master" },
  };
  const parsed = parseWtGraphPayload(raw);
  expect(parsed, "varA raw payload must pass the frozen P0 parser").not.toBeNull();
  return parsed!;
}

// ---------------------------------------------------------------------------
// stress fixtures (#6)
// ---------------------------------------------------------------------------

/** 125 consecutive 8-parent octopus merges, oldest m_1 … newest m_125: m_1 merges 8 fresh
 *  roots, every m_k (k≥2) takes [m_{k-1}, 7 fresh roots]. 8×125+1 = 1001 nodes, E = 1000, all
 *  in-set — the exact-P form of the plan's「连续 8 父章鱼 merge × 125 … 各 1000 节点」.
 *  Emission is newest-first (parents strictly later): m_125, its 7 roots, m_124, …, m_1, its 8. */
function octopusFixture(): WtGraphCommit[] {
  const out: WtGraphCommit[] = [];
  const mk = (id: string, p: string[]): WtGraphCommit => ({ h: fid(id), p, a: "A", t: 1, s: "s" });
  for (let m = 125; m >= 1; m--) {
    const parents: string[] = [];
    if (m > 1) parents.push(fid(`m${m - 1}`)); // p0 = the OLDER merge (emitted later)
    const fresh = m === 1 ? 8 : 7;
    for (let f = 1; f <= fresh; f++) parents.push(fid(`f${m}_${f}`));
    out.push(mk(`m${m}`, parents));
    for (let f = 1; f <= fresh; f++) out.push(mk(`f${m}_${f}`, []));
  }
  return out;
}

/** 100 parallel chains × 10 levels, interleaved level-major (all 100 heads first): 1000
 *  nodes, E = 900, laneCount = 100 — the wide DAG. */
function wideFixture(): WtGraphCommit[] {
  const out: WtGraphCommit[] = [];
  for (let t = 9; t >= 0; t--) {
    for (let c = 0; c < 100; c++) {
      const p = t >= 1 ? [fid(`c${c}_t${t - 1}`)] : [];
      out.push({ h: fid(`c${c}_t${t}`), p, a: "A", t: 1, s: "s" });
    }
  }
  return out;
}

/** Verifier round-2 blocker regression (44 rows): row 0 `E` opens the EARLY LOW-LANE WAIT
 *  for `F` (lane 0); rows 1..20 are placeholder branches whose waits fill lanes 1..20; row
 *  21 `G` (p0 = Groot, p1 = F) therefore lands in the HIGH lane 21 while its p1 edge MERGES
 *  into lane 0's wait — the「origin hidden, route visible」shape: route 21->22 runs in a
 *  visible lane but its origin node sits in the fold column. layoutGraph produces exactly
 *  `nodes[21].lane = 21`, route `{from: 21, to: 22, lane: 0}`. */
function adversarialMergeFixture(): WtGraphCommit[] {
  const out: WtGraphCommit[] = [];
  const mk = (id: string, p: string[]): WtGraphCommit => ({ h: fid(id), p, a: "A", t: 1, s: "s" });
  out.push(mk("E", [fid("F")])); // row 0: lane 0 waits for F
  for (let i = 1; i <= 20; i++) out.push(mk(`P${i}`, [fid(`R${i}`)])); // rows 1..20 fill lanes 1..20
  out.push(mk("G", [fid("Groot"), fid("F")])); // row 21: HIGH lane 21; p1 merges into lane 0
  out.push(mk("F", [])); // row 22: arrives in lane 0, both lane-0 routes terminate here
  out.push(mk("Groot", [])); // row 23: arrives in lane 21 (G's p0 wait)
  for (let i = 1; i <= 20; i++) out.push(mk(`R${i}`, [])); // rows 24..43
  return out;
}

function inSetEdgeCount(commits: WtGraphCommit[]): number {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.h, i));
  let e = 0;
  for (let i = 0; i < commits.length; i++) {
    for (const p of commits[i]!.p) {
      const j = rowOf.get(p);
      if (j !== undefined && j > i) e++;
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// scope helpers (§4.3)
// ---------------------------------------------------------------------------

describe("logic/gitGraphScope wtgraphScopeOf — truth table", () => {
  const session = { sessionId: "sess-1" };
  const caps = [WTGRAPH_HUB_CAP];

  it("null/undefined input ⇒ null", () => {
    expect(wtgraphScopeOf(null)).toBeNull();
    expect(wtgraphScopeOf()).toBeNull();
  });
  it("no transport / no cap / non-array caps ⇒ null", () => {
    expect(wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: false, agentKey: "a", session })).toBeNull();
    expect(wtgraphScopeOf({ mode: "token", hubCaps: [], hasTransport: true, agentKey: "a", session })).toBeNull();
    expect(
      wtgraphScopeOf({ mode: "token", hubCaps: "wtgraph.v1", hasTransport: true, agentKey: "a", session }),
    ).toBeNull();
  });
  it("token mode with wtgraph.v1 ⇒ scope", () => {
    expect(wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: "a", session })).toEqual({
      agentKey: "a",
      sessionId: "sess-1",
    });
  });
  it("loopback (non-password) mode does not need preview.lan.v1", () => {
    expect(wtgraphScopeOf({ mode: "loopback", hubCaps: caps, hasTransport: true, agentKey: "a", session })).toEqual({
      agentKey: "a",
      sessionId: "sess-1",
    });
  });
  it("password (LAN) mode additionally requires preview.lan.v1 (§0.2 Q1)", () => {
    expect(wtgraphScopeOf({ mode: "password", hubCaps: caps, hasTransport: true, agentKey: "a", session })).toBeNull();
    expect(
      wtgraphScopeOf({
        mode: "password",
        hubCaps: [WTGRAPH_HUB_CAP, PREVIEW_LAN_HUB_CAP],
        hasTransport: true,
        agentKey: "a",
        session,
      }),
    ).toEqual({ agentKey: "a", sessionId: "sess-1" });
  });
  it("bad agentKey / session ⇒ null", () => {
    expect(wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: "", session })).toBeNull();
    expect(wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: 7, session })).toBeNull();
    expect(
      wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: "a", session: null }),
    ).toBeNull();
    expect(wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: "a", session: {} })).toBeNull();
    expect(
      wtgraphScopeOf({ mode: "token", hubCaps: caps, hasTransport: true, agentKey: "a", session: { sessionId: "" } }),
    ).toBeNull();
  });
});

describe("logic/gitGraphScope pickGraphWt / graphSigOf", () => {
  it("current row path wins (even when main came first)", () => {
    const rows: WorktreeRowWire[] = [
      { label: "main", path: "/repo", main: true },
      { label: "wt", path: "/wt", current: true },
    ];
    expect(pickGraphWt(rows)).toBe("/wt");
  });
  it("no current ⇒ main row path; current without path falls back to main", () => {
    expect(
      pickGraphWt([
        { label: "main", path: "/repo", main: true },
        { label: "x", path: "/x" },
      ]),
    ).toBe("/repo");
    expect(
      pickGraphWt([
        { label: "main", path: "/repo", main: true },
        { label: "c", current: true },
      ]),
    ).toBe("/repo");
  });
  it("neither ⇒ null; rows without usable path ⇒ null; non-array ⇒ null", () => {
    expect(pickGraphWt([{ label: "x", path: "/x" }])).toBeNull();
    expect(pickGraphWt([{ label: "dropped" }])).toBeNull();
    expect(pickGraphWt(null)).toBeNull();
    expect(pickGraphWt(undefined)).toBeNull();
    expect(pickGraphWt([])).toBeNull();
  });
  it("graphSigOf: identical rows ⇒ identical; any watched field flips ⇒ different", () => {
    const a: WorktreeRowWire = { label: "l", path: "/p", branch: "b", head: "h1", current: true, main: true };
    const b: WorktreeRowWire = { label: "l", path: "/p", branch: "b", head: "h1", current: true, main: true };
    const other: WorktreeRowWire = { label: "l2", path: "/q", branch: "b2", head: "h2" };
    expect(graphSigOf([a])).toBe(graphSigOf([b]));
    expect(graphSigOf([a])).not.toBe(graphSigOf([{ ...a, head: "h2" }]));
    expect(graphSigOf([a])).not.toBe(graphSigOf([{ ...a, path: "/q" }]));
    expect(graphSigOf([a])).not.toBe(graphSigOf([{ ...a, branch: "c" }]));
    expect(graphSigOf([a])).not.toBe(graphSigOf([{ ...a, current: undefined }]));
    expect(graphSigOf([a])).not.toBe(graphSigOf([{ ...a, main: undefined }]));
    expect(graphSigOf([a, other])).not.toBe(graphSigOf([other, a])); // ranked order matters
  });
  it("graphSigOf: absent fields vs empty strings stay stable; non-array ⇒ empty string", () => {
    expect(graphSigOf([{ label: "x" }])).toBe(graphSigOf([{ label: "x", path: undefined }]));
    expect(graphSigOf(null)).toBe("");
    expect(graphSigOf(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// layout — varA row snapshot + topo (§4.1/#5)
// ---------------------------------------------------------------------------

describe("logic/gitGraph layoutGraph — varA row snapshot", () => {
  const payload = varAPayload();
  const layout = layoutGraph(payload.commits);

  it("parses varA through the frozen parser and snapshots every row (mockup history)", () => {
    expect(payload.commits).toHaveLength(16);
    expect(snapLayout(layout)).toBe(
      [
        "lanes=2",
        "0 lane=0 c0",
        "1 lane=0 c0",
        "2 lane=1 c1",
        "3 lane=0 c0",
        "4 lane=1 c2",
        "5 lane=1 c2",
        "6 lane=1 c2",
        "7 lane=1 c2",
        "8 lane=1 c2",
        "9 lane=0 c0",
        "10 lane=1 c3",
        "11 lane=1 c3",
        "12 lane=0 c0",
        "13 lane=1 c3",
        "14 lane=0 c0",
        "15 lane=0 c0",
        "routes: 0->1@0#c0 1->3@0#c0 2->3@1#c1 3->9@0#c0 4->5@1#c2 5->6@1#c2 6->7@1#c2 7->8@1#c2 8->9@1#c2 9->12@0#c0 9->10@1#c3 10->11@1#c3 11->13@1#c3 12->14@0#c0 13->14@1#c3 14->15@0#c0",
        "stubs: 15@0#c0",
      ].join("\n"),
    );
  });

  it("topo invariants hold (edge⇔route bijection, real endpoints, no false connections)", () => {
    assertTopo("varA", payload.commits, layout);
    expect(layout.routes).toHaveLength(16); // 15 single-parent edges + the merge's second edge
  });

  it("varA chips: merged master|origin with HEAD, plain branches elsewhere", () => {
    expect(refChipsOf(payload, H.w897)).toEqual([{ text: "HEAD → master | origin", kind: "head" }]);
    expect(refChipsOf(payload, H.t3bb)).toEqual([{ text: "pi-agent-r_7KQ2Z9XA", kind: "branch" }]);
    expect(refChipsOf(payload, H.e02)).toEqual([{ text: "pi-agent-r_M4T8WP1D", kind: "branch" }]);
    expect(refChipsOf(payload, H.b41)).toEqual([{ text: "feat/session-nav-rewrite", kind: "branch" }]);
    expect(refChipsOf(payload, H.m6a9)).toEqual([]); // merge row: no refs
  });

  it("varA rings: full-oid match, self first, labels from the exact-path StatusInfo row", () => {
    expect(wtRingsOf(payload, H.w897, VARA_ROWS)).toEqual([
      { label: "~/ai/pi-toolkit", path: "/home/bluecake/ai/pi-toolkit", self: true },
    ]);
    expect(wtRingsOf(payload, H.b41, VARA_ROWS)).toEqual([
      { label: "~/ai/wt-session-nav", path: "/home/bluecake/ai/wt-session-nav", self: false },
    ]);
    expect(wtRingsOf(payload, H.t3bb, VARA_ROWS)).toEqual([
      { label: "/tmp/pi-subagent-worktrees/r_7KQ2Z9XA", path: "/tmp/pi-subagent-worktrees/r_7KQ2Z9XA", self: false },
    ]);
    expect(wtRingsOf(payload, H.e02, VARA_ROWS)).toEqual([
      { label: "/tmp/pi-subagent-worktrees/r_M4T8WP1D", path: "/tmp/pi-subagent-worktrees/r_M4T8WP1D", self: false },
    ]);
    expect(wtRingsOf(payload, H.ee4, VARA_ROWS)).toEqual([]); // no worktree HEAD here
  });
});

// ---------------------------------------------------------------------------
// bounds + timing (#6)
// ---------------------------------------------------------------------------

describe("logic/gitGraph bounds + timing on the stress fixtures", () => {
  const octopus = octopusFixture();
  const wide = wideFixture();
  const octE = inSetEdgeCount(octopus);
  const wideE = inSetEdgeCount(wide);

  it("fixtures have the promised shape", () => {
    expect(octopus).toHaveLength(1001); // 8×125+1 (see builder comment)
    expect(octE).toBe(1000);
    expect(octopus.every((c) => c.p.length <= WTGRAPH_PARENTS_MAX)).toBe(true);
    expect(wide).toHaveLength(1000);
    expect(wideE).toBe(900);
  });

  it("octopus ×125: ops ≤ N·(E+1), paths ≤ E + N·P, topo, single layout ≤ 100 ms (median ×3)", () => {
    const layout = layoutGraph(octopus);
    const n = octopus.length;
    expect(layout.ops).toBeLessThanOrEqual(n * (octE + 1));
    expect(layout.routes.length + layout.stubs.length).toBeLessThanOrEqual(octE + n * WTGRAPH_PARENTS_MAX);
    expect(layout.laneCount).toBe(8); // p0 lane + 7 fresh-root lanes, holes reused every batch
    assertTopo("octopus", octopus, layout);
    expect(medianOf3(() => layoutGraph(octopus))).toBeLessThan(100);
  });

  it("wide 100-way DAG: ops ≤ N·(E+1), paths ≤ E + N·P, topo, single layout ≤ 100 ms (median ×3)", () => {
    const layout = layoutGraph(wide);
    const n = wide.length;
    expect(layout.ops).toBeLessThanOrEqual(n * (wideE + 1));
    expect(layout.routes.length + layout.stubs.length).toBeLessThanOrEqual(wideE + n * WTGRAPH_PARENTS_MAX);
    expect(layout.laneCount).toBe(100);
    assertTopo("wide", wide, layout);
    expect(medianOf3(() => layoutGraph(wide))).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// fold (#6)
// ---------------------------------------------------------------------------

describe("logic/gitGraph foldLayout", () => {
  it("varA limit 1: the hidden lane never produces connected segments; markers exact", () => {
    const layout = layoutGraph(varACommits());
    const folded = foldLayout(layout, 1);
    expect(folded.folded).toBe(true);
    assertFoldVisible("varA/1", layout, folded, 1);
    // visible straight runs only in lane 0 — the six master-lane edges
    expect(folded.routes.map((r) => `${r.from}->${r.to}@${r.lane}`)).toEqual([
      "0->1@0",
      "1->3@0",
      "3->9@0",
      "9->12@0",
      "12->14@0",
      "14->15@0",
    ]);
    expect(folded.stubs).toEqual([{ from: 15, lane: 0, color: 0 }]); // root fade visible
    // hidden runs: arrow stubs at their VISIBLE endpoints only, in route order
    expect(folded.foldStubs).toEqual([
      { from: 3, lane: 0, color: 1, at: "arrive" }, // 2->3@1#c1 arrives into lane 0
      { from: 9, lane: 0, color: 2, at: "arrive" }, // 8->9@1#c2 arrives into the merge
      { from: 9, lane: 0, color: 3, at: "depart" }, // 9->10@1#c3 departs toward lane 1
      { from: 14, lane: 0, color: 3, at: "arrive" }, // 13->14@1#c3 arrives into lane 0
    ]);
    expect(folded.foldMarkRows).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("varA limit 1: folded node rows are exactly the lane-1 rows", () => {
    const layout = layoutGraph(varACommits());
    const folded = foldLayout(layout, 1);
    assertFoldVisible("varA/1-nodes", layout, folded, 1);
    const rows = folded.nodes.map((nd, i) => (nd.folded ? i : -1)).filter((i) => i >= 0);
    expect(rows).toEqual([2, 4, 5, 6, 7, 8, 10, 11, 13]);
  });

  it("wide DAG limit 4: chains 4..99 fold entirely — no connected hidden segments", () => {
    const layout = layoutGraph(wideFixture());
    const folded = foldLayout(layout, 4);
    expect(folded.folded).toBe(true);
    assertFoldVisible("wide/4", layout, folded, 4);
    expect(folded.routes).toHaveLength(4 * 9); // chains 0..3 × 9 edges
    expect(folded.foldStubs).toEqual([]); // hidden endpoints are all folded nodes — no visible boundary
    expect(folded.stubs).toHaveLength(4); // the four visible chain roots
    expect(folded.foldMarkRows[0]).toBe(4);
    expect(folded.foldMarkRows[folded.foldMarkRows.length - 1]).toBe(999);
    expect(folded.foldMarkRows).toHaveLength(996); // rows 4..999 (chains 4..99 span [c, 900+c])
    expect(folded.nodes.filter((nd) => nd.folded)).toHaveLength(960); // rows with r%100 >= 4
    expect(folded.nodes[0]?.folded).toBe(false); // chain 0 head stays visible
    expect(folded.nodes[4]?.folded).toBe(true);
  });

  it("wide DAG limit 12 (desktop): chains 0..11 visible", () => {
    const layout = layoutGraph(wideFixture());
    const folded = foldLayout(layout, 12);
    assertFoldVisible("wide/12", layout, folded, 12);
    expect(folded.routes).toHaveLength(12 * 9);
    expect(folded.foldMarkRows[0]).toBe(12);
    expect(folded.foldMarkRows).toHaveLength(988); // rows 12..999
    expect(folded.stubs).toHaveLength(12);
  });

  it("octopus limit 4: one depart arrow stub per merge row (deduped), every row marked", () => {
    const layout = layoutGraph(octopusFixture());
    const folded = foldLayout(layout, 4);
    assertFoldVisible("octopus/4", layout, folded, 4);
    expect(folded.foldStubs).toHaveLength(125);
    expect(folded.foldStubs.every((s) => s.lane === 0 && s.at === "depart")).toBe(true);
    expect(folded.foldStubs[0]).toEqual({ from: 0, lane: 0, color: 4, at: "depart" });
    expect(folded.foldMarkRows).toHaveLength(1001); // rows 0..1000
    expect(folded.nodes.filter((nd) => nd.folded)).toHaveLength(500); // 4 folded roots per batch × 125
  });

  it("REGRESSION (verifier round-2 blocker): a pk≥1 merge into an early low-lane wait whose origin lands in a hidden lane is never kept as a visible route", () => {
    const commits = adversarialMergeFixture();
    const layout = layoutGraph(commits);
    expect(layout.nodes).toHaveLength(44);
    // the shape the verifier reproduced: origin node 21 in the HIGH lane 21, its p1 edge
    // merging into the early lane-0 wait for F (route 21->22 runs in a VISIBLE lane)
    expect(layout.nodes[21]).toEqual({ lane: 21, color: 5 });
    expect(layout.nodes[22]).toEqual({ lane: 0, color: 0 });
    expect(layout.routes.map((r) => `${r.from}->${r.to}@${r.lane}`)).toContain("21->22@0");

    for (const limit of [4, 12]) {
      const folded = foldLayout(layout, limit);
      assertFoldVisible(`adversarial/${limit}`, layout, folded, limit);
      // the blocker: 21->22@0 must NOT stay a connected route (origin is a fold-column
      // diamond); it becomes an arrive stub into the visible F node at row 22 instead
      // (routes legitimately TERMINATING at visible row 22 — e.g. E's 0->22@0 — stay)
      expect(
        folded.routes.some((r) => r.from === 21),
        `limit ${limit}: no kept route may originate at the fold-column node 21`,
      ).toBe(false);
      expect(folded.foldStubs).toEqual([{ from: 22, lane: 0, color: 0, at: "arrive" }]);
    }

    // exact markers at the desktop cap: lanes 12..21 folded (rows 12..21, 23, 35..43) plus
    // the hidden-run spans — P12..P20 edges cover rows 12..43, G's p0 21->23@21 and the
    // regression route 21->22@0 add rows 21..23 → every row 12..43 is marked
    const folded12 = foldLayout(layout, 12);
    expect(folded12.foldMarkRows).toEqual(Array.from({ length: 32 }, (_, i) => 12 + i));
    expect(folded12.routes.map((r) => `${r.from}->${r.to}@${r.lane}`)).toEqual([
      "0->22@0",
      "1->24@1",
      "2->25@2",
      "3->26@3",
      "4->27@4",
      "5->28@5",
      "6->29@6",
      "7->30@7",
      "8->31@8",
      "9->32@9",
      "10->33@10",
      "11->34@11",
    ]);

    // at the mobile cap the same regression route is one of the four visible-chain edges'
    // neighbors: only chains 0..3 stay connected, the fold marks start at row 4
    const folded4 = foldLayout(layout, 4);
    expect(folded4.foldMarkRows).toEqual(Array.from({ length: 40 }, (_, i) => 4 + i));
    expect(folded4.routes.map((r) => `${r.from}->${r.to}@${r.lane}`)).toEqual([
      "0->22@0",
      "1->24@1",
      "2->25@2",
      "3->26@3",
    ]);
  });

  it("below the cap: nothing folds (varA default desktop cap)", () => {
    const layout = layoutGraph(varACommits());
    const folded = foldLayout(layout, 12);
    assertFoldVisible("varA/12", layout, folded, 12);
    expect(folded.folded).toBe(false);
    expect(folded.foldStubs).toEqual([]);
    expect(folded.foldMarkRows).toEqual([]);
    expect(folded.routes).toHaveLength(layout.routes.length);
    expect(folded.nodes.every((nd) => !nd.folded)).toBe(true);
  });

  it("degenerate laneLimit falls back to the desktop cap; broken layouts never throw", () => {
    const layout = layoutGraph(varACommits());
    expect(foldLayout(layout, 0).folded).toBe(false); // 0 ⇒ fallback 12
    expect(foldLayout(layout, Number.NaN).folded).toBe(false);
    expect(() =>
      foldLayout({ nodes: [], routes: [{ from: 3, to: 1, lane: 0, color: 0 }], stubs: [], laneCount: 1, ops: 0 }, 4),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// path geometry (§4.1 pathD — measured centers)
// ---------------------------------------------------------------------------

describe("logic/gitGraph pathD / stubPathD", () => {
  const laneX = (lane: number): number => 8 + 14 * lane;

  it("one lane ⇒ straight line", () => {
    const nodes: GraphNode[] = [
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
    ];
    const route: GraphRoute = { from: 0, to: 2, lane: 0, color: 0 };
    expect(pathD(route, nodes, [10, 30, 50], laneX, 22)).toBe("M 8 10 L 8 50");
  });

  it("adjacent two-lane rows retain one smooth cubic", () => {
    const nodes: GraphNode[] = [
      { lane: 1, color: 0 },
      { lane: 0, color: 0 },
    ];
    const route: GraphRoute = { from: 0, to: 1, lane: 1, color: 0 };
    expect(pathD(route, nodes, [10, 32], laneX, 22)).toBe("M 22 10 C 22 21, 8 21, 8 32");
  });

  it("multi-row two-lane child-on-run route changes near the parent", () => {
    const nodes: GraphNode[] = [
      { lane: 1, color: 0 },
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
    ];
    const route: GraphRoute = { from: 0, to: 2, lane: 1, color: 0 };
    expect(pathD(route, nodes, [10, 30, 50], laneX, 22)).toBe("M 22 10 L 22 30 C 22 40, 8 40, 8 50");
  });

  it("multi-row two-lane run-lane-equals-parent route changes near the child", () => {
    const nodes: GraphNode[] = [
      { lane: 1, color: 0 },
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
    ];
    const route: GraphRoute = { from: 0, to: 2, lane: 0, color: 0 };
    expect(pathD(route, nodes, [10, 30, 50], laneX, 22)).toBe("M 22 10 C 22 20, 8 20, 8 30 L 8 50");
  });

  it("three lanes use one-pitch S-curves at both endpoints", () => {
    const nodes: GraphNode[] = [
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
      { lane: 0, color: 0 },
      { lane: 1, color: 0 },
    ];
    const route: GraphRoute = { from: 0, to: 3, lane: 2, color: 0 };
    expect(pathD(route, nodes, [0, 22, 44, 66], laneX, 22)).toBe(
      "M 8 0 C 8 11, 36 11, 36 22 L 36 44 C 36 55, 22 55, 22 66",
    );
  });

  it("invalid pitch falls back to half the route height", () => {
    const nodes: GraphNode[] = [
      { lane: 0, color: 0 },
      { lane: 1, color: 0 },
    ];
    expect(pathD({ from: 0, to: 1, lane: 0, color: 0 }, nodes, [0, 40], laneX, 0)).toBe(
      "M 8 0 L 8 20 C 8 30, 22 30, 22 40",
    );
  });

  it("rowLaneExtent follows visible ink, fold marks, and folded nodes", () => {
    const fold: FoldLayout = {
      nodes: [
        { lane: 0, color: 0, folded: false },
        { lane: 3, color: 1, folded: true },
        { lane: 1, color: 2, folded: false },
      ],
      routes: [{ from: 0, to: 2, lane: 1, color: 0 }],
      stubs: [{ from: 2, lane: 1, color: 0 }],
      foldStubs: [{ from: 1, lane: 0, color: 1, at: "depart" }],
      foldMarkRows: [1],
      folded: true,
    };
    expect(rowLaneExtent(fold, 3, laneX, 64)).toEqual([22, 64, 22]);
    expect(rowLaneExtent(fold, 0, laneX, 64)).toEqual([]);
  });

  it("degenerate inputs degrade (never throw): missing nodes/NaN centers/non-ascending rows", () => {
    const nodes: GraphNode[] = [{ lane: 0, color: 0 }];
    expect(pathD({ from: 0, to: 5, lane: 0, color: 0 }, nodes, [0, 1], laneX, 22)).toBe("");
    expect(
      pathD(
        { from: 0, to: 1, lane: 0, color: 0 },
        [
          { lane: 0, color: 0 },
          { lane: 0, color: 0 },
        ],
        [0, Number.NaN],
        laneX,
        22,
      ),
    ).toBe("");
    expect(
      pathD(
        { from: 1, to: 0, lane: 0, color: 0 },
        [
          { lane: 0, color: 0 },
          { lane: 0, color: 0 },
        ],
        [0, 10],
        laneX,
        22,
      ),
    ).toBe("M 8 10 L 8 0");
    expect(stubPathD({ from: 0, lane: 2, color: 0 }, [Number.NaN], laneX)).toBe("");
  });

  it("stubPathD: short vertical fade, default GRAPH_STUB_LEN", () => {
    expect(stubPathD({ from: 1, lane: 2, color: 0 }, [10, 30], laneX)).toBe(`M 36 30 L 36 ${30 + GRAPH_STUB_LEN}`);
    expect(stubPathD({ from: 1, lane: 0, color: 0 }, [10, 30], laneX, 7)).toBe("M 8 30 L 8 37");
  });
});

// ---------------------------------------------------------------------------
// ref chips (§4.2/#14)
// ---------------------------------------------------------------------------

/** Minimal wire-legal payload whose refs/head are the case under test. */
function chipPayload(refs: WtGraphRef[], head?: { h: string; b?: string }): WtGraphPayload {
  const oids = new Set<string>(refs.map((r) => r.h));
  if (head !== undefined) oids.add(head.h);
  const payload: WtGraphPayload = {
    v: 1,
    n: WTGRAPH_N,
    format: "sha1",
    commits: [...oids].map((h) => ({ h, p: [], a: "A", t: 1, s: "s" })),
    refs,
    wtHeads: [],
    degrade: {},
    complete: true,
  };
  if (head !== undefined) payload.head = head;
  return payload;
}

describe("logic/gitGraph refChipsOf", () => {
  const A = oid("aaaaaaaaaa");
  const B = oid("bbbbbbbbbb");

  it("local X merges with same-oid same-name remote into「X | R」", () => {
    const p = chipPayload([
      { k: "branch", n: "master", h: A, up: "origin/master" },
      { k: "remote", n: "origin/master", h: A },
    ]);
    expect(refChipsOf(p, A)).toEqual([{ text: "master | origin", kind: "branch" }]);
  });

  it("diverged local/remote (different oids) render as two standalone chips at their rows", () => {
    const p = chipPayload([
      { k: "branch", n: "master", h: A },
      { k: "remote", n: "origin/master", h: B },
    ]);
    expect(refChipsOf(p, A)).toEqual([{ text: "master", kind: "branch" }]);
    expect(refChipsOf(p, B)).toEqual([{ text: "origin/master", kind: "remote" }]);
  });

  it("same-oid remote with a DIFFERENT branch name does not merge", () => {
    const p = chipPayload([
      { k: "branch", n: "master", h: A },
      { k: "remote", n: "origin/main", h: A },
    ]);
    expect(refChipsOf(p, A)).toEqual([
      { text: "master", kind: "branch" },
      { text: "origin/main", kind: "remote" },
    ]);
  });

  it("multiple remotes for the same branch merge in sorted order", () => {
    const p = chipPayload([
      { k: "branch", n: "master", h: A },
      { k: "remote", n: "upstream/master", h: A },
      { k: "remote", n: "origin/master", h: A },
    ]);
    expect(refChipsOf(p, A)).toEqual([{ text: "master | origin,upstream", kind: "branch" }]);
  });

  it("sym refs (origin/HEAD) become small sym chips; tags carry the tag kind", () => {
    const p = chipPayload([
      { k: "remote", n: "origin/HEAD", h: A, sym: true },
      { k: "tag", n: "v1.0", h: A },
    ]);
    expect(refChipsOf(p, A)).toEqual([
      { text: "origin/HEAD", kind: "remote", sym: true },
      { text: "v1.0", kind: "tag" },
    ]);
  });

  it("current checkout: HEAD → merged branch name; detached: bare HEAD chip first", () => {
    const refs: WtGraphRef[] = [
      { k: "branch", n: "master", h: A },
      { k: "remote", n: "origin/master", h: A },
    ];
    expect(refChipsOf(chipPayload(refs, { h: A, b: "master" }), A)).toEqual([
      { text: "HEAD → master | origin", kind: "head" },
    ]);
    expect(refChipsOf(chipPayload(refs, { h: A }), A)).toEqual([
      { text: "HEAD", kind: "head" },
      { text: "master | origin", kind: "branch" },
    ]);
  });

  it("head.b pointing at a moved branch (ms race) still renders HEAD → <b>", () => {
    const p = chipPayload([{ k: "branch", n: "master", h: B }], { h: A, b: "master" });
    expect(refChipsOf(p, A)).toEqual([{ text: "HEAD → master", kind: "head" }]);
  });

  it("full deterministic order and no row cap here (P5 owns ≤3 + +n)", () => {
    const p = chipPayload([
      { k: "branch", n: "b2", h: A },
      { k: "branch", n: "b1", h: A },
      { k: "remote", n: "r2/x", h: A },
      { k: "remote", n: "r1/y", h: A },
      { k: "tag", n: "t2", h: A },
      { k: "tag", n: "t1", h: A },
    ]);
    expect(refChipsOf(p, A)).toEqual([
      { text: "b1", kind: "branch" },
      { text: "b2", kind: "branch" },
      { text: "r1/y", kind: "remote" },
      { text: "r2/x", kind: "remote" },
      { text: "t1", kind: "tag" },
      { text: "t2", kind: "tag" },
    ]);
  });

  it("refs at other oids never chip this row", () => {
    const p = chipPayload([{ k: "branch", n: "master", h: B }]);
    expect(refChipsOf(p, A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// worktree HEAD rings (§4.2/#14 — full-oid matching)
// ---------------------------------------------------------------------------

describe("logic/gitGraph wtRingsOf", () => {
  const A = oid("aaaaaaaaaa");

  it("matches by FULL oid — a 7-char StatusInfo head must never create a ring", () => {
    const p = chipPayload([{ k: "branch", n: "x", h: A }]);
    p.wtHeads = [{ h: oid("bbbbbbbbbb"), path: "/wt", b: "b" }];
    // row.head is the 7-char prefix of A, but the wtHead oid is B — no ring at A
    const rows: WorktreeRowWire[] = [{ label: "row", path: "/wt", head: A.slice(0, 7) }];
    expect(wtRingsOf(p, A, rows)).toEqual([]);
  });

  it("label: exact-path StatusInfo row wins; else basename; rows missing ⇒ basename", () => {
    const p = chipPayload([{ k: "branch", n: "x", h: A }]);
    p.wtHeads = [
      { h: A, path: "/srv/proj/main-wt" },
      { h: A, path: "/tmp/other" },
    ];
    const rows: WorktreeRowWire[] = [{ label: "proj ✔", path: "/srv/proj/main-wt" }];
    expect(wtRingsOf(p, A, rows)).toEqual([
      { label: "proj ✔", path: "/srv/proj/main-wt", self: false },
      { label: "other", path: "/tmp/other", self: false },
    ]);
    expect(wtRingsOf(p, A, null)).toEqual([
      { label: "main-wt", path: "/srv/proj/main-wt", self: false },
      { label: "other", path: "/tmp/other", self: false },
    ]);
  });

  it("self ring sorts first; a matching row with an empty label falls back to basename", () => {
    const p = chipPayload([{ k: "branch", n: "x", h: A }]);
    p.wtHeads = [
      { h: A, path: "/a/other-wt" },
      { h: A, path: "/a/self-wt", self: true },
    ];
    const rows: WorktreeRowWire[] = [{ label: "", path: "/a/self-wt" }];
    expect(wtRingsOf(p, A, rows)).toEqual([
      { label: "self-wt", path: "/a/self-wt", self: true },
      { label: "other-wt", path: "/a/other-wt", self: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// dates (§4.2/#14 — timezone-independent: instants are built from LOCAL wall-clock parts, so the
// local-time formatter must echo them back under any TZ)
// ---------------------------------------------------------------------------

describe("logic/gitGraph formatCommitDate / commitDateParts (any TZ)", () => {
  it("en: `23 Sep 2026 09:55` — day unpadded, fixed month table, 24h clock", () => {
    const t = new Date(2026, 8, 23, 9, 55).getTime() / 1000;
    expect(formatCommitDate(t, "en")).toBe("23 Sep 2026 09:55");
  });
  it("zh: `2026-09-23 09:55`", () => {
    const t = new Date(2026, 8, 23, 9, 55).getTime() / 1000;
    expect(formatCommitDate(t, "zh")).toBe("2026-09-23 09:55");
  });
  it("padding: single-digit day/hour keep the clock strict", () => {
    expect(formatCommitDate(new Date(2026, 0, 1, 0, 5).getTime() / 1000, "en")).toBe("1 Jan 2026 00:05");
    expect(formatCommitDate(new Date(2026, 10, 9, 23, 0).getTime() / 1000, "en")).toBe("9 Nov 2026 23:00");
  });
  it("commitDateParts reads the LOCAL timezone parts", () => {
    expect(commitDateParts(new Date(2026, 8, 23, 9, 55))).toEqual({ y: 2026, mo: 9, d: 23, h: 9, mi: 55 });
  });
  it("injectable parts extractor is honored", () => {
    const fixed = () => ({ y: 2026, mo: 9, d: 23, h: 9, mi: 55 });
    expect(formatCommitDate(0, "en", fixed)).toBe("23 Sep 2026 09:55");
    expect(formatCommitDate(0, "zh", fixed)).toBe("2026-09-23 09:55");
  });
  it('degrades to "" on non-finite/out-of-Date seconds — never throws', () => {
    expect(formatCommitDate(Number.NaN, "en")).toBe("");
    expect(formatCommitDate(Number.POSITIVE_INFINITY, "en")).toBe("");
    expect(formatCommitDate(Number.NaN, "zh")).toBe("");
    expect(formatCommitDate(1e15, "en")).toBe(""); // ms beyond Date's ±8.64e15 range
    expect(formatCommitDate(1e15, "zh")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// seeded property test (#6 — never throws)
// ---------------------------------------------------------------------------

describe("logic/gitGraph seeded 1000-case random DAG property test", () => {
  const rng = mulberry32(0xc0ffee);

  function oneCase(caseIdx: number): void {
    const n = 1 + Math.floor(rng() * 60);
    const hs = Array.from({ length: n }, (_, i) => fid(`c${caseIdx}_${i}`)); // precomputed: parents may sit in rows not built yet
    const commits: WtGraphCommit[] = [];
    const outOfSet = (k: number): string => fid(`o${caseIdx}_${k}`);
    for (let i = 0; i < n; i++) {
      const parentCount = Math.floor(rng() * 5); // 0..4 parents
      const p: string[] = [];
      for (let k = 0; k < parentCount; k++) {
        const roll = rng();
        if (roll < 0.15) {
          p.push(outOfSet(Math.floor(rng() * 50))); // beyond the window / shallow
        } else if (roll < 0.25 && p.length > 0) {
          p.push(p[p.length - 1]!); // duplicate parent (defensive shape)
        } else if (n - i - 1 > 0) {
          const j = i + 1 + Math.floor(rng() * (n - i - 1));
          p.push(hs[j]!); // in-set, strictly later row (date-order contract)
        } else {
          p.push(outOfSet(Math.floor(rng() * 50)));
        }
      }
      commits.push({ h: hs[i]!, p, a: "A", t: 1_700_000_000 - i, s: "s" });
    }

    let layout: GraphLayout | undefined;
    expect(() => {
      layout = layoutGraph(commits);
    }, `case ${caseIdx}: layoutGraph must not throw`).not.toThrow();
    expect(layout).toBeDefined();
    assertTopo(`case ${caseIdx}`, commits, layout!);
    expect(layout!.stubs.length).toBeLessThanOrEqual(n); // deduped per row
    expect(layout!.routes.length + layout!.stubs.length).toBeLessThanOrEqual(
      inSetEdgeCount(commits) + n * WTGRAPH_PARENTS_MAX,
    );

    const limit = rng() < 0.5 ? 4 : 12;
    let folded = foldLayout(layout!, limit);
    expect(() => {
      folded = foldLayout(layout!, limit);
    }, `case ${caseIdx}: foldLayout must not throw`).not.toThrow();
    assertFoldVisible(`case ${caseIdx}`, layout!, folded, limit); // verifier round-2 invariants
    expect(folded.nodes.length).toBe(n);
    expect(
      folded.foldMarkRows.every((r) => r >= 0 && r < n),
      `case ${caseIdx}: marks in range`,
    ).toBe(true);
  }

  it("1000 seeded cases: never throws, topo + fold invariants hold", () => {
    for (let c = 0; c < 1000; c++) oneCase(c);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// never-throws defensive inputs
// ---------------------------------------------------------------------------

describe("logic/gitGraph defensive inputs", () => {
  it("layoutGraph: non-array, malformed entries, throwing getters — never throws", () => {
    expect(layoutGraph([] as WtGraphCommit[])).toEqual({ nodes: [], routes: [], stubs: [], laneCount: 0, ops: 0 });
    expect(() => layoutGraph(undefined as never)).not.toThrow();
    expect(() => layoutGraph(null as never)).not.toThrow();
    expect(() => layoutGraph([{}, { h: "x" }] as never)).not.toThrow();
    const hostile = {
      get h(): string {
        throw new Error("boom");
      },
      p: [],
    };
    expect(() => layoutGraph([hostile] as never)).not.toThrow();
    // backward parent to a LATER row is drawable (downward) once rows are pre-indexed;
    // a parent at an EARLIER row (back1's parent back0) degrades to a stub — never upward
    const back: WtGraphCommit[] = [
      { h: oid("back1"), p: [oid("back2")], a: "A", t: 1, s: "s" },
      { h: oid("back2"), p: [oid("back1")], a: "A", t: 1, s: "s" },
    ];
    const l = layoutGraph(back);
    expect(l.routes).toEqual([{ from: 0, to: 1, lane: 0, color: 0 }]);
    expect(l.stubs.length).toBe(1);
  });

  it("refChipsOf / wtRingsOf: malformed payload pieces never throw", () => {
    const p = chipPayload([]);
    expect(() => refChipsOf({ ...p, refs: null as never }, oid("x"))).not.toThrow();
    expect(() => refChipsOf({ ...p, head: { h: 5 as never } }, oid("x"))).not.toThrow();
    expect(() => wtRingsOf({ ...p, wtHeads: [null as never] }, oid("x"), null)).not.toThrow();
    expect(wtRingsOf({ ...p, wtHeads: [{ h: oid("x"), path: "" }] }, oid("x"), null)).toEqual([]);
  });
});
