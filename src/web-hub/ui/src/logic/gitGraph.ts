/**
 * web-hub worktree commit-graph — layout, chips, rings, dates (worktree-graph plan v2 §4.1/§4.2,
 * package P3). Pure, DOM-free, Vue-free, timer-free: every export runs unchanged under vitest
 * (node) and in the browser, the same discipline as `./wtdiff.js` / `./sessionHistory.ts`.
 * EVERYTHING here is total and never throws — a hostile/degenerate payload yields a degraded
 * (possibly empty) layout, never an exception; the whole layout body additionally runs inside
 * a try/catch that falls back to the farthest consistent prefix.
 *
 * Only this file (and P5's `components/graph/*`) may know the layout algorithm — the worktree
 * panel imports ONLY `./gitGraphScope.ts` so none of this rides the main chunk (§4.3/#13).
 *
 * §4.1 algorithm (edge-routed lanes, VS Code "Git Graph" reading):
 * - `layoutGraph(commits)` walks rows newest-first keeping `lanes: ({want, color} | null)[]`:
 *   a lane either is a reusable hole or waits for ONE parent oid (carrying the open routes
 *   that will terminate there). A commit lands on the LEFTMOST lane already waiting for it
 *   (inheriting that lane's color), else the leftmost hole with a fresh color
 *   (`nextColor++ % GRAPH_LANE_COLORS`). Every OTHER lane waiting for the same oid has its
 *   open routes terminated at this row (each becomes one Route arcing into the node) and is
 *   released.
 * - Parents: `p0` in-set ⇒ the node's own lane re-waits for it, INHERITING the node's color
 *   (branch continuity — the first-parent edge runs straight down the child's lane); `p0`
 *   out-of-set (or a root, `p: []`) ⇒ one short fade Stub. `pk (k≥1)` in-set ⇒ if some lane
 *   already waits for it, a new Route MERGES into that lane (no duplicate lanes for the same
 *   target), else the leftmost hole opens a fresh lane; out-of-set ⇒ Stub. Stubs all depart
 *   from the node's own lane (deduped per row — ≤1 stub per row).
 * - Edge color = the color of the lane the edge RUNS in (the parent side, VS Code-consistent).
 * - Bounds (§4.1, pinned by tests on the two 1000-node fixtures): in-set edges E ≤ N·P; any
 *   row boundary's live lanes ≤ crossing edges ≤ E, so the work is O(Σ live lanes) ≤ N·(E+1)
 *   (`ops` counts every lane-slot visit + finalization — the diagnostic the bound tests read);
 *   SVG paths = |routes| + |stubs| ≤ E + N·P, each path ≤ 3 segments (M + C/L + C/L).
 * - Structural invariant (topo tests): a route's straight run (rows from+1..to−1 in
 *   `route.lane`) never passes through another node — a lane with an open wait cannot host a
 *   node, and a hole is only reused BELOW the row that freed it.
 *
 * §4.2 chips/rings/dates:
 * - `refChipsOf(payload, h)` — local `X` merges with same-oid same-name remotes into
 *   `X | R[,R2]`; unmerged remotes stand alone (outlined); `sym` refs (`origin/HEAD`) are
 *   small chips; tags; the current checkout becomes `HEAD → …` (or a bare `HEAD` when
 *   detached). The ≤3-chips + `+n` row cap is P5's rendering concern — this returns the full
 *   deterministic list (order: HEAD, locals by name, unmerged remotes, syms, tags).
 * - `wtRingsOf(payload, h, rows)` — worktree HEAD rings match by FULL oid (`wtHeads[].h ===
 *   commit.h`, never the 7-char `StatusInfo` head); the label is the `StatusInfo` row whose
 *   `path` equals `wtHeads[].path` exactly, else the path basename.
 * - `formatCommitDate(tSec, lang, parts?)` — absolute, LOCAL timezone (tests run under
 *   `TZ=UTC`): en `23 Sep 2026 09:55` (fixed month table), zh `2026-09-23 09:55`; `parts`
 *   injectable for the component.
 *
 * Runtime imports use the `.js` suffix (`@protocol/…`) — TS-importer style, the same
 * convention `./sessionHistory.ts` documents; `protocol/worktree-graph.ts` is `node:*`-free
 * by design (P0) so pulling its TYPES into the browser bundle is free (this module needs no
 * runtime values from it — the caps it references live in the tests).
 */

/** Lane color palette size (`--gg-lane-0..7`, §4.3); colors cycle `nextColor++ % this`. */
export const GRAPH_LANE_COLORS = 8;

/** §4.1/#6 visible-lane cap, desktop. */
export const GRAPH_LANE_LIMIT_DESKTOP = 12;

/** §0.2 Q3 visible-lane cap, ≤480px. */
export const GRAPH_LANE_LIMIT_MOBILE = 4;

/** §4.1 stub fade length in px (the mockup's 14); CSS dashes it, this is the geometry. */
export const GRAPH_STUB_LEN = 14;

import type { WtGraphCommit, WtGraphPayload } from "@protocol/worktree-graph.js";
import type { WorktreeRowWire } from "@protocol/messages.js";

// ---------------------------------------------------------------------------
// layout (§4.1)
// ---------------------------------------------------------------------------

/** One commit dot: lane column + palette color index. */
export interface GraphNode {
  lane: number;
  color: number;
}

/** One in-set parent edge: departs (nodes[from].lane, from), runs rows from+1..to−1 in `lane`,
 *  arcs into (nodes[to].lane, to). `color` = the running lane's color (parent side). */
export interface GraphRoute {
  from: number;
  to: number;
  lane: number;
  color: number;
}

/** One out-of-set parent fade (N truncation / shallow boundary / root): short dashed line
 *  fading below row `from` in column `lane`. */
export interface GraphStub {
  from: number;
  lane: number;
  color: number;
}

/** `layoutGraph` result. `laneCount` = total lanes used (raw, pre-fold); `ops` is a
 *  DIAGNOSTIC work counter (lane-slot visits + route finalizations) exported for the §4.1
 *  `ops ≤ N·(E+1)` bound tests — renderers ignore it. */
export interface GraphLayout {
  nodes: GraphNode[];
  routes: GraphRoute[];
  stubs: GraphStub[];
  laneCount: number;
  ops: number;
}

/** A lane's open wait: which parent oid lands here next, and the running color. */
interface LaneWait {
  want: string;
  color: number;
}

/**
 * §4.1 layout. Total, never throws: non-array input yields the empty layout; a throwing
 * accessor on a malformed entry aborts to the consistent prefix built so far (try/catch);
 * a parent oid that points at THIS row or an EARLIER one (a contract violation — the hub's
 * `--date-order` guarantees parents later) is treated as out-of-set (a stub), so no route is
 * ever drawn upward.
 */
export function layoutGraph(commits: readonly WtGraphCommit[]): GraphLayout {
  if (!Array.isArray(commits)) return { nodes: [], routes: [], stubs: [], laneCount: 0, ops: 0 };
  const nodes: GraphNode[] = [];
  const routes: GraphRoute[] = [];
  const stubs: GraphStub[] = [];
  const lanes: (LaneWait | null)[] = [];
  const openByLane: number[][] = []; // route indices still missing their `to`
  const rowOf = new Map<string, number>();
  const stubSeen = new Set<string>();
  let nextColor = 0;
  let ops = 0;

  const leftmostEmpty = (): number => {
    for (let k = 0; k < lanes.length; k++) {
      ops++;
      if (lanes[k] === null) return k;
    }
    return lanes.length;
  };
  const leftmostWaiting = (oid: string): number => {
    for (let k = 0; k < lanes.length; k++) {
      ops++;
      const w = lanes[k];
      if (w != null && w.want === oid) return k;
    }
    return -1;
  };
  const occupy = (lane: number, wait: LaneWait): void => {
    lanes[lane] = wait;
  };
  const openRoute = (from: number, lane: number, color: number): void => {
    routes.push({ from, to: -1, lane, color });
    (openByLane[lane] ??= []).push(routes.length - 1);
    ops++;
  };
  const finalizeLane = (lane: number, to: number): void => {
    const open = openByLane[lane];
    if (open === undefined) return;
    for (const idx of open) {
      const r = routes[idx];
      if (r !== undefined && r.to === -1) r.to = to;
      ops++;
    }
    openByLane[lane] = [];
  };
  const addStub = (from: number, lane: number, color: number): void => {
    const key = `${from}:${lane}`;
    if (stubSeen.has(key)) return;
    stubSeen.add(key);
    stubs.push({ from, lane, color });
  };

  try {
    // pre-index every row BEFORE walking: a parent at a LATER row (the `--date-order`
    // contract) must already resolve here — an incrementally-built map would see every
    // in-set parent as out-of-set.
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      if (c === null || typeof c !== "object") continue;
      if (typeof c.h === "string" && c.h !== "") rowOf.set(c.h, i);
    }
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      if (c === null || typeof c !== "object") return prefix();
      const h = typeof c.h === "string" && c.h !== "" ? c.h : `!${i}`;
      rowOf.set(h, i);
      const parents = Array.isArray(c.p) ? c.p.filter((x: string) => typeof x === "string") : [];

      // arrival — leftmost lane waiting for h, else the leftmost hole with a fresh color
      const arrive = leftmostWaiting(h);
      let laneI: number;
      let colorI: number;
      if (arrive >= 0) {
        laneI = arrive;
        colorI = lanes[arrive]?.color ?? 0;
        for (let k = 0; k < lanes.length; k++) {
          ops++;
          const w = lanes[k];
          if (w != null && w.want === h) {
            finalizeLane(k, i);
            lanes[k] = null;
          }
        }
      } else {
        laneI = leftmostEmpty();
        colorI = nextColor++ % GRAPH_LANE_COLORS;
        if (laneI === lanes.length) lanes.push(null);
      }
      nodes.push({ lane: laneI, color: colorI });

      // parents
      if (parents.length === 0) {
        addStub(i, laneI, colorI); // a root: the lane ends here, fade below (mockup)
        continue;
      }
      for (let k = 0; k < parents.length; k++) {
        const pk = parents[k];
        if (typeof pk !== "string") continue;
        const row = rowOf.get(pk);
        const inSet = row !== undefined && row > i; // contract violation (≤ i) ⇒ out-of-set
        if (k === 0) {
          if (inSet) {
            occupy(laneI, { want: pk, color: colorI }); // first parent: own lane, inherit
            openRoute(i, laneI, colorI);
          } else {
            addStub(i, laneI, colorI);
          }
        } else {
          const w = leftmostWaiting(pk);
          if (inSet && w >= 0) {
            openRoute(i, w, lanes[w]?.color ?? 0); // merge into the existing wait
          } else if (inSet) {
            const lane = leftmostEmpty();
            const color = nextColor++ % GRAPH_LANE_COLORS;
            if (lane === lanes.length) lanes.push(null);
            occupy(lane, { want: pk, color });
            openRoute(i, lane, color);
          } else {
            addStub(i, laneI, colorI);
          }
        }
      }
    }
  } catch {
    // a throwing getter / revoked proxy on a malformed entry — deliver the prefix, never throw
    return prefix();
  }

  const done = routes.filter((r) => r.to !== -1); // none in practice (every wait resolves)
  return {
    nodes,
    routes: done,
    stubs,
    laneCount: lanes.length,
    ops,
  };

  function prefix(): GraphLayout {
    return { nodes, routes: routes.filter((r) => r.to !== -1), stubs, laneCount: lanes.length, ops };
  }
}

// ---------------------------------------------------------------------------
// fold (§4.1/#6)
// ---------------------------------------------------------------------------

/** A node plus its fold verdict: `folded` ⇔ `lane >= laneLimit` (drawn in the fold column
 *  as a hollow diamond, never in its own column). */
export interface FoldedNode extends GraphNode {
  folded: boolean;
}

/** A short arrow stub at the visible/hidden boundary: `depart` leaves the visible node at row
 *  `from` toward a hidden lane; `arrive` enters the visible node from a hidden lane. Rendered
 *  short — NEVER a connected line into or through the hidden region. */
export interface GraphFoldStub {
  from: number;
  lane: number;
  color: number;
  at: "depart" | "arrive";
}

/** `foldLayout` result — everything P5 needs to draw a lane-capped graph. `routes`/`stubs`
 *  carry only entries whose straight run AND BOTH endpoint nodes live in VISIBLE lanes; a
 *  route touching the fold region in any way is replaced by `foldStubs` + `foldMarkRows`
 *  (the fold column's ⋮ rows). */
export interface FoldLayout {
  nodes: FoldedNode[];
  routes: GraphRoute[];
  stubs: GraphStub[];
  foldStubs: GraphFoldStub[];
  foldMarkRows: number[];
  /** True iff any lane index ≥ the limit is in use (the fold column exists). */
  folded: boolean;
}

/**
 * §4.1/#6 fold pass: apply the visible-lane cap (12 desktop / 4 ≤480px). A route is kept
 * VISIBLE only when THREE things are below the limit: its straight-run lane, the ORIGIN
 * node's lane and the DESTINATION node's lane. The origin check is not optional: a pk≥1
 * merge edge can join a pre-existing LOW-lane wait while its originating commit sits in a
 * HIGH (hidden) lane —「origin hidden, route visible」— and keeping such a route would hand
 * P5 a connected curve that starts in the fold column and crosses the fold region, exactly
 * the connected-segment shape #6 forbids. Anything else falls through to the hidden-run
 * logic: an arrow stub at each VISIBLE endpoint (depart from the child's dot / arrive into
 * the parent's dot) plus ⋮ fold marks on every row the route spans; folded nodes and hidden
 * stubs mark their rows too. Total, never throws; a non-safe-integer/≤0 `laneLimit` falls
 * back to the desktop cap.
 */
export function foldLayout(layout: GraphLayout, laneLimit: number): FoldLayout {
  const limit =
    typeof laneLimit === "number" && Number.isSafeInteger(laneLimit) && laneLimit >= 1
      ? laneLimit
      : GRAPH_LANE_LIMIT_DESKTOP;
  const n = layout.nodes.length;
  const nodes: FoldedNode[] = layout.nodes.map((nd) => ({ ...nd, folded: nd.lane >= limit }));
  const routes: GraphRoute[] = [];
  const stubs: GraphStub[] = [];
  const foldStubs: GraphFoldStub[] = [];
  const stubSeen = new Set<string>();
  const marks = new Set<number>();

  const addFoldStub = (from: number, lane: number, color: number, at: "depart" | "arrive"): void => {
    const key = `${from}:${lane}:${at}`;
    if (stubSeen.has(key)) return;
    stubSeen.add(key);
    foldStubs.push({ from, lane, color, at });
  };

  for (const r of layout.routes) {
    if (r.from < 0 || r.to <= r.from || r.from >= n || r.to >= n) continue; // defensive
    const a = layout.nodes[r.from];
    const b = layout.nodes[r.to];
    // fully visible ⇔ run lane AND both endpoint lanes below the cap (see doc comment —
    // an origin/destination drawn in the fold column must never emit a connected path)
    if (r.lane < limit && a !== undefined && a.lane < limit && b !== undefined && b.lane < limit) {
      routes.push(r);
      continue;
    }
    if (a !== undefined && a.lane < limit) addFoldStub(r.from, a.lane, r.color, "depart");
    if (b !== undefined && b.lane < limit) addFoldStub(r.to, b.lane, r.color, "arrive");
    for (let row = r.from; row <= r.to && row < n; row++) marks.add(row);
  }
  for (const s of layout.stubs) {
    if (s.from >= n) continue;
    if (s.lane < limit) stubs.push(s);
    else marks.add(s.from); // hidden fade: the fold mark stands in for it
  }
  for (let i = 0; i < n; i++) {
    if ((layout.nodes[i]?.lane ?? 0) >= limit) marks.add(i);
  }
  const foldMarkRows = [...marks].sort((x, y) => x - y);
  return { nodes, routes, stubs, foldStubs, foldMarkRows, folded: layout.laneCount > limit };
}

// ---------------------------------------------------------------------------
// path geometry (§4.1 `pathD` — P5 feeds MEASURED row centers, §4.3/#8)
// ---------------------------------------------------------------------------

/** x coordinate of a lane column (P5 maps ≥limit lanes to the fold column). */
export type LaneXFn = (lane: number) => number;

const fmt = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * SVG path data for one route, using MEASURED row centers (`centers[i]`, §4.3 — never a
 * computed row height). A lane change is confined to at most one row pitch next to each
 * endpoint; the middle stays vertical in the route lane. Adjacent two-lane rows retain the
 * compact mockup cubic. Degenerate inputs (missing nodes, non-finite centers, non-ascending
 * rows) yield `""` (skip) or a plain line — never a throw.
 */
export function pathD(
  route: GraphRoute,
  nodes: readonly GraphNode[],
  centers: readonly number[],
  laneX: LaneXFn,
  pitch: number,
): string {
  const a = nodes[route.from];
  const b = nodes[route.to];
  const y1 = centers[route.from];
  const y2 = centers[route.to];
  if (a === undefined || b === undefined || !fin(y1) || !fin(y2)) return "";
  const xa = laneX(a.lane);
  const xm = laneX(route.lane);
  const xb = laneX(b.lane);
  if (!fin(xa) || !fin(xm) || !fin(xb)) return "";
  const dy = y2 - y1;
  if (dy <= 0) return `M ${fmt(xa)} ${fmt(y1)} L ${fmt(xb)} ${fmt(y2)}`;
  if (xa === xm && xm === xb) return `M ${fmt(xa)} ${fmt(y1)} L ${fmt(xb)} ${fmt(y2)}`;

  const validPitch = fin(pitch) && pitch > 0;
  const h = validPitch ? Math.min(dy / 2, pitch) : dy / 2;
  const distinctLanes = new Set([xa, xm, xb]).size;
  if (distinctLanes === 2 && validPitch && dy <= pitch) {
    return `M ${fmt(xa)} ${fmt(y1)} C ${fmt(xa)} ${fmt(y1 + h)}, ${fmt(xb)} ${fmt(y2 - h)}, ${fmt(xb)} ${fmt(y2)}`;
  }

  const start = xa !== xm;
  const end = xm !== xb;
  let d = `M ${fmt(xa)} ${fmt(y1)}`;
  if (start) {
    d += ` C ${fmt(xa)} ${fmt(y1 + h / 2)}, ${fmt(xm)} ${fmt(y1 + h / 2)}, ${fmt(xm)} ${fmt(y1 + h)}`;
  }
  const endY = end ? y2 - h : y2;
  d += ` L ${fmt(xm)} ${fmt(endY)}`;
  if (end) {
    d += ` C ${fmt(xm)} ${fmt(y2 - h / 2)}, ${fmt(xb)} ${fmt(y2 - h / 2)}, ${fmt(xb)} ${fmt(y2)}`;
  }
  return d;
}

/**
 * Maximum SVG x-coordinate occupied by graph ink on each row. Folded nodes and marks use
 * `foldX`; visible topology uses the caller's lane mapper. The result is total so an invalid
 * row count or malformed layout simply yields zero extents for rows without usable geometry.
 */
export function rowLaneExtent(fold: FoldLayout, rowCount: number, laneX: LaneXFn, foldX: number): number[] {
  const count = Number.isSafeInteger(rowCount) && rowCount > 0 ? rowCount : 0;
  const extents = Array.from({ length: count }, () => Number.NEGATIVE_INFINITY);
  const add = (row: number, x: number): void => {
    if (!Number.isSafeInteger(row) || row < 0 || row >= count || !fin(x)) return;
    extents[row] = Math.max(extents[row]!, x);
  };
  const nodeX = (row: number): number => {
    const node = fold.nodes[row];
    if (node === undefined) return Number.NaN;
    return node.folded ? foldX : laneX(node.lane);
  };

  for (let row = 0; row < count; row++) add(row, nodeX(row));
  for (const route of fold.routes) {
    if (!Number.isSafeInteger(route.from) || !Number.isSafeInteger(route.to)) continue;
    const start = Math.max(0, route.from);
    const end = Math.min(count - 1, route.to);
    for (let row = start; row <= end; row++) add(row, laneX(route.lane));
    add(route.from, nodeX(route.from));
    add(route.to, nodeX(route.to));
  }
  for (const stub of fold.stubs) add(stub.from, laneX(stub.lane));
  for (const stub of fold.foldStubs) add(stub.from, laneX(stub.lane));
  for (const row of fold.foldMarkRows) add(row, foldX);
  return extents.map((x) => (fin(x) ? x : 0));
}

/** SVG path data for one stub: a short vertical line fading below the row (dashes are CSS).
 *  Default length `GRAPH_STUB_LEN`; never throws. */
export function stubPathD(
  stub: GraphStub,
  centers: readonly number[],
  laneX: LaneXFn,
  len: number = GRAPH_STUB_LEN,
): string {
  const y = centers[stub.from];
  const x = laneX(stub.lane);
  const l = fin(len) && len > 0 ? len : GRAPH_STUB_LEN;
  if (!fin(y) || !fin(x)) return "";
  return `M ${fmt(x)} ${fmt(y)} L ${fmt(x)} ${fmt(y + l)}`;
}

// ---------------------------------------------------------------------------
// ref chips (§4.2/#14)
// ---------------------------------------------------------------------------

/** Chip rendering kind (P5 maps to `--gg-chip-*` tokens; `head` is the bold current chip). */
export type RefChipKind = "head" | "branch" | "remote" | "tag";

/** One ref chip. `sym: true` marks an `R/HEAD`-style small chip. */
export interface RefChip {
  text: string;
  kind: RefChipKind;
  sym?: true;
}

/** Does remote short name `n` equal `<remote>/<branch>`? Returns the remote prefix. */
function remotePrefixFor(n: string, branch: string): string | null {
  const idx = n.lastIndexOf("/");
  if (idx <= 0 || idx === n.length - 1) return null;
  const tail = n.slice(idx + 1);
  return tail === branch ? n.slice(0, idx) : null;
}

/**
 * §4.2 ref chips for the commit `h`. Deterministic order: the current checkout first
 * (`HEAD → <merged branch>` or a bare `HEAD` when detached), then local branches by name
 * (each merged with every same-oid `<remote>/<name>` into `X | R[,R2…]`), then unmerged
 * remotes by name, then `sym` (`origin/HEAD`) small chips, then tags by name. Refs pointing
 * at other oids are ignored (a straggler renders no chip — P0 header). The row-level ≤3 +
 * `+n` cap is P5's. Total, never throws.
 */
export function refChipsOf(payload: WtGraphPayload, h: string): RefChip[] {
  const refs = Array.isArray(payload.refs) ? payload.refs : [];
  const here = refs.filter((r) => r !== null && typeof r === "object" && r.h === h);
  const byName = (x: { n: string }, y: { n: string }): number => (x.n < y.n ? -1 : x.n > y.n ? 1 : 0);
  const locals = here.filter((r) => r.k === "branch").sort(byName);
  const remotes = here.filter((r) => r.k === "remote").sort(byName);
  const tags = here.filter((r) => r.k === "tag").sort(byName);
  const syms = remotes.filter((r) => r.sym === true);
  const plain = remotes.filter((r) => r.sym !== true);

  const mergedInto = new Set<string>(); // remote names consumed by a local merge chip
  const mergedText = (branch: string): string => {
    const prefixes = new Set<string>();
    for (const r of plain) {
      const p = remotePrefixFor(r.n, branch);
      if (p !== null) {
        prefixes.add(p);
        mergedInto.add(r.n);
      }
    }
    const list = [...prefixes].sort();
    return list.length > 0 ? `${branch} | ${list.join(",")}` : branch;
  };

  const chips: RefChip[] = [];
  const isCurrent = payload.head?.h === h;
  if (isCurrent) {
    const b = payload.head?.b;
    chips.push(b === undefined ? { text: "HEAD", kind: "head" } : { text: `HEAD → ${mergedText(b)}`, kind: "head" });
  }
  for (const r of locals) {
    const text = mergedText(r.n);
    if (isCurrent && payload.head?.b === r.n) continue; // already the HEAD chip
    chips.push({ text, kind: "branch" });
  }
  for (const r of plain) {
    if (mergedInto.has(r.n)) continue;
    chips.push({ text: r.n, kind: "remote" });
  }
  for (const r of syms) chips.push({ text: r.n, kind: "remote", sym: true });
  for (const r of tags) chips.push({ text: r.n, kind: "tag" });
  return chips;
}

// ---------------------------------------------------------------------------
// worktree HEAD rings (§4.2/#14 — FULL-oid matching)
// ---------------------------------------------------------------------------

/** One worktree HEAD ring (dashed ring + badge in P5). */
export interface WtRing {
  label: string;
  path: string;
  self: boolean;
}

/** POSIX basename of an absolute path (""/"/" degrade to the path itself). */
function basenameOf(path: string): string {
  const segs = path.split("/").filter((s) => s !== "");
  const last = segs[segs.length - 1];
  return typeof last === "string" && last !== "" ? last : path;
}

/**
 * §4.2 worktree HEAD rings for commit `h`: every `wtHeads[]` entry whose FULL oid equals the
 * commit's (never the 7-char `StatusInfo` head). `label` = the `StatusInfo.worktrees` row
 * whose `path` is byte-equal to the wtHead path, else the path basename. The request's own
 * worktree (`self`) is listed first, then payload order. Total, never throws.
 */
export function wtRingsOf(
  payload: WtGraphPayload,
  h: string,
  rows: readonly WorktreeRowWire[] | null | undefined,
): WtRing[] {
  const heads = Array.isArray(payload.wtHeads) ? payload.wtHeads : [];
  const labelOf = (path: string): string => {
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row !== null && typeof row === "object" && row.path === path) {
          return typeof row.label === "string" && row.label !== "" ? row.label : basenameOf(path);
        }
      }
    }
    return basenameOf(path);
  };
  const rings: WtRing[] = [];
  for (const w of heads) {
    if (w === null || typeof w !== "object" || w.h !== h) continue;
    if (typeof w.path !== "string" || w.path === "") continue;
    rings.push({ label: labelOf(w.path), path: w.path, self: w.self === true });
  }
  rings.sort((a, b) => (a.self === b.self ? 0 : a.self ? -1 : 1)); // stable in modern JS
  return rings;
}

// ---------------------------------------------------------------------------
// dates (§4.2/#14)
// ---------------------------------------------------------------------------

/** Local-timezone date parts (month 1-based). */
export interface GraphDateParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Fixed English month abbreviations (no `Intl` dependency — byte-stable output). */
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The default local-timezone parts extractor (P5 may inject its own). */
export function commitDateParts(d: Date): GraphDateParts {
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
}

/**
 * §4.2 absolute author-time formatting, LOCAL timezone: en `23 Sep 2026 09:55` (day unpadded,
 * fixed month table, 24h clock), zh `2026-09-23 09:55`. `parts` injects the extractor
 * (defaults to `commitDateParts`). Degrades to `""` on non-finite seconds or out-of-`Date`
 * range — never throws.
 */
export function formatCommitDate(
  tSec: number,
  lang: "en" | "zh",
  parts: (d: Date) => GraphDateParts = commitDateParts,
): string {
  if (typeof tSec !== "number" || !Number.isFinite(tSec)) return "";
  const ms = tSec * 1000;
  if (Math.abs(ms) > 8.64e15) return "";
  const p = parts(new Date(ms));
  if (
    !Number.isFinite(p.y) ||
    !Number.isFinite(p.mo) ||
    !Number.isFinite(p.d) ||
    !Number.isFinite(p.h) ||
    !Number.isFinite(p.mi)
  ) {
    return "";
  }
  const pad2 = (v: number): string => String(Math.trunc(v)).padStart(2, "0");
  if (lang === "zh") return `${Math.trunc(p.y)}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`;
  const mon = MONTHS_EN[Math.trunc(p.mo) - 1] ?? "";
  if (mon === "") return "";
  return `${Math.trunc(p.d)} ${mon} ${Math.trunc(p.y)} ${pad2(p.h)}:${pad2(p.mi)}`;
}
