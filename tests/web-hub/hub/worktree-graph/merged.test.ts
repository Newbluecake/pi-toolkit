/**
 * merged-plan r3 §3 (P2): the PURE half of `hub/worktree-graph/merged.ts` — candidate selection
 * (§3.2), verdict/`e` assembly and the byte policy (§3.4). No fs, no runner: payloads are built
 * by hand and every output is also run through the frozen strict parser.
 */

import { describe, expect, it } from "vitest";

import {
  ancestorsInWindow,
  buildMergedBranches,
  finalizeMergedPayload,
  mergedCandidates,
  type MergedCandidate,
  type TipOutcome,
} from "../../../../src/web-hub/hub/worktree-graph/merged.js";
import {
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_MERGED_E_MAX,
  WTGRAPH_MERGED_MAX,
  WTGRAPH_MERGED_MAX_BYTES,
  parseWtGraphPayload,
  type WtGraphMerged,
  type WtGraphPayload,
} from "../../../../src/web-hub/protocol/worktree-graph.js";
import { oidOf } from "./helpers.js";

const HEAD = oidOf(5000);

interface Spec {
  /** window commits, newest first: [oid, parents] */
  commits: Array<[string, string[]]>;
  branches?: Array<[name: string, oid: string]>;
  headBranch?: string | undefined;
}

function payloadOf(spec: Spec): WtGraphPayload {
  return {
    v: 1,
    n: 200,
    format: "sha1",
    commits: spec.commits.map(([h, p], i) => ({ h, p, a: "a", t: 10_000 - i, s: "s" })),
    refs: (spec.branches ?? []).map(([n, h]) => ({ k: "branch" as const, n, h })),
    wtHeads: [],
    degrade: {},
    complete: true,
    head: spec.headBranch === undefined ? { h: HEAD } : { h: HEAD, b: spec.headBranch },
  };
}

describe("ancestorsInWindow", () => {
  it("walks parents inside the window only; a start outside the window is empty", () => {
    const commits = payloadOf({
      commits: [
        [HEAD, [oidOf(1)]],
        [oidOf(1), [oidOf(2)]],
        [oidOf(2), [oidOf(99)]], // 99 is outside the window
      ],
    }).commits;
    expect([...ancestorsInWindow(commits, HEAD)].sort()).toEqual([HEAD, oidOf(1), oidOf(2)].sort());
    expect(ancestorsInWindow(commits, oidOf(77)).size).toBe(0);
  });
});

describe("mergedCandidates §3.2", () => {
  const base: Spec = {
    commits: [
      [HEAD, [oidOf(10)]],
      [oidOf(1), [oidOf(10)]],
      [oidOf(2), [oidOf(10)]],
      [oidOf(10), []],
    ],
  };

  it("drops the HEAD branch, the HEAD oid and window ancestors of HEAD; keeps others", () => {
    const p = payloadOf({
      ...base,
      headBranch: "dev",
      branches: [
        ["dev", HEAD],
        ["alias-of-head", HEAD],
        ["old", oidOf(10)], // ancestor of HEAD
        ["side-a", oidOf(1)],
        ["side-b", oidOf(2)],
      ],
    });
    const { selected, omitted } = mergedCandidates(p, []);
    expect(selected.map((c) => c.n)).toEqual(["side-a", "side-b"]);
    expect(omitted).toBe(0);
  });

  it("branches whose tip is outside the window, and remote/tag refs, are never candidates", () => {
    const p = payloadOf({
      ...base,
      branches: [
        ["far", oidOf(404)],
        ["side", oidOf(1)],
      ],
    });
    p.refs.push({ k: "remote", n: "origin/x", h: oidOf(2) }, { k: "tag", n: "t", h: oidOf(2) });
    expect(mergedCandidates(p, []).selected.map((c) => c.n)).toEqual(["side"]);
  });

  it("co:true marks a branch checked out by ANY worktree row (labelled, still a candidate)", () => {
    const p = payloadOf({
      ...base,
      branches: [
        ["side-a", oidOf(1)],
        ["side-b", oidOf(2)],
      ],
    });
    const { selected } = mergedCandidates(p, [{ branch: "main" }, { branch: "side-b" }, {}]);
    expect(selected).toEqual<MergedCandidate[]>([
      { n: "side-a", h: oidOf(1), co: false },
      { n: "side-b", h: oidOf(2), co: true },
    ]);
  });

  it("orders by window row (newest first), ties by ref order, regardless of ref order", () => {
    const p = payloadOf({
      ...base,
      branches: [
        ["z-late", oidOf(2)],
        ["a-early", oidOf(1)],
        ["b-early", oidOf(1)],
      ],
    });
    expect(mergedCandidates(p, []).selected.map((c) => c.n)).toEqual(["a-early", "b-early", "z-late"]);
  });

  it.each([24, 25, 400])("%i candidates ⇒ at most 24 selected, the rest only counted in omitted", (count) => {
    const commits: Array<[string, string[]]> = [[HEAD, [oidOf(10)]]];
    const branches: Array<[string, string]> = [];
    for (let i = 0; i < count; i++) {
      commits.push([oidOf(100 + i), [oidOf(10)]]);
      branches.push([`b${i}`, oidOf(100 + i)]);
    }
    commits.push([oidOf(10), []]);
    const { selected, omitted } = mergedCandidates(payloadOf({ commits, branches }), []);
    expect(selected).toHaveLength(Math.min(count, WTGRAPH_MERGED_MAX));
    expect(omitted).toBe(Math.max(0, count - WTGRAPH_MERGED_MAX));
    expect(selected.map((c) => c.n)).toEqual(branches.slice(0, selected.length).map(([n]) => n));
  });

  it("a payload without head selects nothing", () => {
    const p = payloadOf({ ...base, branches: [["side", oidOf(1)]] });
    delete p.head;
    expect(mergedCandidates(p, [])).toEqual({ selected: [], omitted: 0 });
  });
});

describe("buildMergedBranches §3.4", () => {
  const sel = (...names: Array<[string, string, boolean?]>): MergedCandidate[] =>
    names.map(([n, h, co]) => ({ n, h, co: co === true }));
  const ok = (eq: string[], plus: number): TipOutcome => ({ ok: true, value: { eq, plus } });

  it("derives eq / part / none / anc / unk from (k, t)", () => {
    const outcomes = new Map<string, TipOutcome>([
      [oidOf(1), ok([oidOf(901), oidOf(902)], 0)],
      [oidOf(2), ok([oidOf(903)], 2)],
      [oidOf(3), ok([], 4)],
      [oidOf(4), ok([], 0)],
      [oidOf(5), { ok: false, why: "too-many" }],
    ]);
    const rows = buildMergedBranches(
      sel(["a", oidOf(1)], ["b", oidOf(2)], ["c", oidOf(3)], ["d", oidOf(4)], ["e", oidOf(5)], ["f", oidOf(6)]),
      outcomes,
      new Set([oidOf(903)]),
    );
    expect(rows).toEqual([
      { n: "a", h: oidOf(1), v: "eq", k: 2, t: 2 },
      { n: "b", h: oidOf(2), v: "part", k: 1, t: 3, e: [oidOf(903)] },
      { n: "c", h: oidOf(3), v: "none", k: 0, t: 4 },
      { n: "d", h: oidOf(4), v: "anc" },
      { n: "e", h: oidOf(5), v: "unk", why: "too-many" },
      { n: "f", h: oidOf(6), v: "unk", why: "budget" }, // no outcome at all ⇒ unknown, never merged
    ]);
  });

  it("e keeps only window members; a part tip with no window equivalents carries no e and no eP", () => {
    const rows = buildMergedBranches(
      sel(["a", oidOf(1)]),
      new Map([[oidOf(1), ok([oidOf(801), oidOf(802)], 1)]]),
      new Set(),
    );
    expect(rows[0]).toEqual({ n: "a", h: oidOf(1), v: "part", k: 2, t: 3 });
  });

  it("e appears only on the FIRST entry of a shared tip; co is per-branch", () => {
    const rows = buildMergedBranches(
      sel(["a", oidOf(1)], ["b", oidOf(1), true], ["c", oidOf(1)]),
      new Map([[oidOf(1), ok([oidOf(801)], 1)]]),
      new Set([oidOf(801)]),
    );
    expect(rows.map((r) => r.e)).toEqual([[oidOf(801)], undefined, undefined]);
    expect(rows.map((r) => r.co)).toEqual([undefined, true, undefined]);
    expect(rows.every((r) => r.v === "part" && r.k === 1 && r.t === 2)).toBe(true);
  });

  it("global e budget: Σ|e| ≤ 200, a truncated list carries eP, and later same-tip entries inherit eP", () => {
    const window = Array.from({ length: 150 }, (_, i) => oidOf(2000 + i));
    const outcomes = new Map<string, TipOutcome>([
      [oidOf(1), ok(window, 1)],
      [oidOf(2), ok(window, 1)],
      [oidOf(3), ok(window, 1)],
    ]);
    const rows = buildMergedBranches(
      sel(["a", oidOf(1)], ["a2", oidOf(1)], ["b", oidOf(2)], ["c", oidOf(3)]),
      outcomes,
      new Set(window),
    );
    expect(rows[0]!.e).toHaveLength(150);
    expect(rows[0]!.eP).toBeUndefined();
    expect(rows[2]!.e).toHaveLength(WTGRAPH_MERGED_E_MAX - 150); // truncated to the remaining budget
    expect(rows[2]!.eP).toBe(true);
    expect(rows[3]!.e).toBeUndefined(); // budget exhausted ⇒ no e, but marked partial
    expect(rows[3]!.eP).toBe(true);
    expect(rows.reduce((n, r) => n + (r.e?.length ?? 0), 0)).toBe(WTGRAPH_MERGED_E_MAX);
  });

  it("output of every shape passes the frozen strict parser", () => {
    const commits: Array<[string, string[]]> = [[HEAD, [oidOf(10)]]];
    const branches: Array<[string, string]> = [];
    const outcomes = new Map<string, TipOutcome>();
    const kinds: TipOutcome[] = [
      ok([oidOf(7001)], 0),
      ok([oidOf(7002)], 2),
      ok([], 3),
      ok([], 0),
      { ok: false, why: "attr-changed" },
    ];
    kinds.forEach((o, i) => {
      commits.push([oidOf(100 + i), [oidOf(10)]]);
      branches.push([`b${i}`, oidOf(100 + i)]);
      outcomes.set(oidOf(100 + i), o);
    });
    commits.push([oidOf(7002), [oidOf(10)]], [oidOf(10), []]);
    const p = payloadOf({ commits, branches });
    const sel = mergedCandidates(p, []).selected;
    const merged: WtGraphMerged = {
      v: 1,
      base: HEAD,
      branches: buildMergedBranches(sel, outcomes, new Set(commits.map(([h]) => h))),
    };
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify({ ...p, merged })))).not.toBeNull();
  });
});

describe("finalizeMergedPayload — byte policy (R2-2)", () => {
  function bigPartPayload(): { p: WtGraphPayload; merged: WtGraphMerged; window: string[] } {
    // 24 branches on ONE part tip, 150 window oids: e must appear once (dedupe), not 24 times
    const window = Array.from({ length: 150 }, (_, i) => oidOf(3000 + i));
    const commits: Array<[string, string[]]> = [
      [HEAD, [oidOf(10)]],
      [oidOf(1), [oidOf(10)]],
    ];
    for (const w of window) commits.push([w, [oidOf(10)]]);
    commits.push([oidOf(10), []]);
    const branches: Array<[string, string]> = Array.from({ length: 24 }, (_, i) => [
      `${"n".repeat(190)}${i}`,
      oidOf(1),
    ]);
    const p = payloadOf({ commits, branches });
    const selected = mergedCandidates(p, []).selected;
    const merged: WtGraphMerged = {
      v: 1,
      base: HEAD,
      branches: buildMergedBranches(
        selected,
        new Map([[oidOf(1), { ok: true, value: { eq: window, plus: 1 } }]]),
        new Set(window),
      ),
    };
    return { p, merged, window };
  }

  it("the reviewer's worst case (24 branches, one part tip, 150 window oids) fits well inside the 32 KiB reserve and the 512 KiB total", () => {
    const { p, merged } = bigPartPayload();
    expect(merged.branches).toHaveLength(24);
    expect(merged.branches.filter((b) => b.e !== undefined)).toHaveLength(1);
    const out = finalizeMergedPayload(p, merged);
    expect(out.merged).toEqual(merged); // untouched
    expect(Buffer.byteLength(JSON.stringify(out.merged))).toBeLessThan(WTGRAPH_MERGED_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(WTGRAPH_BODY_MAX_BYTES);
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(out)))).not.toBeNull();
  });

  it("over the cap ⇒ every e is stripped first (part entries marked eP), branch verdicts kept", () => {
    const { p, merged } = bigPartPayload();
    const withE = Buffer.byteLength(JSON.stringify({ ...p, merged }));
    const stripped: WtGraphMerged = {
      ...merged,
      branches: merged.branches.map(({ e: _e, ...rest }) => ({ ...rest, eP: true as const })),
    };
    const strippedBytes = Buffer.byteLength(JSON.stringify({ ...p, merged: stripped }));
    expect(strippedBytes).toBeLessThan(withE);
    // exactly fits only once e is gone
    const out = finalizeMergedPayload(p, merged, strippedBytes);
    expect(out.merged?.skipped).toBeUndefined();
    expect(out.merged?.branches).toHaveLength(24);
    expect(out.merged?.branches.every((b) => b.e === undefined && b.eP === true && b.v === "part")).toBe(true);
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(out)))).not.toBeNull();
  });

  it('still over after stripping ⇒ merged = { v:1, base, skipped:"bytes", branches:[] }', () => {
    const { p, merged } = bigPartPayload();
    const out = finalizeMergedPayload(p, merged, Buffer.byteLength(JSON.stringify(p)) + 10);
    expect(out.merged).toEqual({ v: 1, base: HEAD, skipped: "bytes", branches: [] });
    expect(parseWtGraphPayload(JSON.parse(JSON.stringify(out)))).not.toBeNull();
  });

  it("does not mutate the input payload", () => {
    const { p, merged } = bigPartPayload();
    const before = JSON.stringify(p);
    finalizeMergedPayload(p, merged, 1);
    expect(JSON.stringify(p)).toBe(before);
    expect(p.merged).toBeUndefined();
  });
});
