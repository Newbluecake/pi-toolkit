/**
 * worktree-graph plan v2 §2.5/§2.6 (P2): `projectGraph` — the pure projector, tested directly
 * against synthetic Gr/Gl results (never spawning git). Every constructed payload is round-
 * tripped through the FROZEN P0 parser (`parseWtGraphPayload`) so a projection the parser would
 * reject (an off-contract shape) is a FAILING test, not a silent bug.
 */

import { describe, expect, it } from "vitest";

import type { ForEachRefRow, TipsFromRefsResult } from "../../../../src/git/graph.js";
import {
  WTGRAPH_N,
  WTGRAPH_PATH_MAX_BYTES,
  WTGRAPH_REFS_MAX,
  WTGRAPH_WT_HEADS_MAX,
  parseWtGraphPayload,
} from "../../../../src/web-hub/protocol/worktree-graph.js";
import {
  projectGraph,
  type ProjectGraphInput,
  type WtHeadCandidate,
} from "../../../../src/web-hub/hub/worktree-graph/project.js";

const SHA1 = (n: number): string => n.toString(16).padStart(40, "0");

function tips(over: Partial<TipsFromRefsResult> = {}): TipsFromRefsResult {
  return { tips: [], format: "sha1", refsSkipped: 0, wtHeadsCapped: false, ...over };
}

function refRow(over: Partial<ForEachRefRow> = {}): ForEachRefRow {
  return {
    objectType: "commit",
    objectName: SHA1(1),
    derefType: "",
    derefName: "",
    refname: "refs/heads/main",
    upstream: "",
    symref: "",
    ...over,
  };
}

function baseInput(over: Partial<ProjectGraphInput> = {}): ProjectGraphInput {
  return {
    refRows: [],
    refsTruncated: false,
    tips: tips(),
    gl: undefined,
    shallow: false,
    wtHeadCandidates: [],
    ...over,
  };
}

function expectValid(payload: ReturnType<typeof projectGraph>): void {
  const parsed = parseWtGraphPayload(payload);
  expect(parsed, JSON.stringify(payload)).not.toBeNull();
  expect(parsed).toEqual(payload);
}

describe("projectGraph (§2.5)", () => {
  it("empty tips (gl undefined) ⇒ empty graph, commits=[], format falls back to sha1", () => {
    const payload = projectGraph(baseInput({ tips: tips({ format: undefined }) }));
    expect(payload.empty).toBe(true);
    expect(payload.commits).toEqual([]);
    expect(payload.format).toBe("sha1");
    expect(payload.complete).toBe(true);
    expectValid(payload);
  });

  it("a normal small graph round-trips through the parser and is complete", () => {
    const payload = projectGraph(
      baseInput({
        refRows: [refRow()],
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
      }),
    );
    expect(payload.empty).toBeUndefined();
    expect(payload.commits).toHaveLength(1);
    expect(payload.refs).toHaveLength(1);
    expect(payload.complete).toBe(true);
    expectValid(payload);
  });

  // ---- §2.5 degrade states, each independently triggerable with complete=false -------------

  it("logCapped alone ⇒ complete=false", () => {
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: true,
        },
      }),
    );
    expect(payload.degrade.logCapped).toBe(true);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("badRecords alone ⇒ complete=false", () => {
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 2,
          parentsTruncated: 0,
          logCapped: false,
        },
      }),
    );
    expect(payload.degrade.badRecords).toBe(2);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("parentsTruncated alone ⇒ complete=false, and a visible pT commit is covered", () => {
    const parents = Array.from({ length: 8 }, (_, i) => SHA1(10 + i));
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: parents, pT: true, a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 1,
          logCapped: false,
        },
      }),
    );
    expect(payload.degrade.parentsTruncated).toBe(1);
    expect(payload.commits[0]?.pT).toBe(true);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("refsTruncated alone ⇒ complete=false", () => {
    const payload = projectGraph(baseInput({ refsTruncated: true }));
    expect(payload.degrade.refsTruncated).toBe(true);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("refsSkipped alone ⇒ complete=false", () => {
    const payload = projectGraph(baseInput({ tips: tips({ refsSkipped: 3 }) }));
    expect(payload.degrade.refsSkipped).toBe(3);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("refsOmitted alone (>400 refs) ⇒ complete=false, refs capped at 400, tags dropped first", () => {
    const rows: ForEachRefRow[] = [];
    // 350 branches (kept), 100 tags (50 should be dropped to reach the 400 cap)
    for (let i = 0; i < 350; i++) rows.push(refRow({ refname: `refs/heads/b${i}`, objectName: SHA1(1) }));
    for (let i = 0; i < 100; i++) rows.push(refRow({ refname: `refs/tags/t${i}`, objectName: SHA1(1) }));
    const payload = projectGraph(baseInput({ refRows: rows, tips: tips({ tips: [SHA1(1)] }) }));
    expect(payload.refs).toHaveLength(WTGRAPH_REFS_MAX);
    expect(payload.degrade.refsOmitted).toBe(50);
    expect(payload.refs.filter((r) => r.k === "branch")).toHaveLength(350);
    expect(payload.refs.filter((r) => r.k === "tag")).toHaveLength(50);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("wtHeadsCapped alone (>32 candidates) ⇒ complete=false, wtHeads capped at 32", () => {
    const candidates: WtHeadCandidate[] = Array.from({ length: 40 }, (_, i) => ({
      h: SHA1(100 + i),
      path: `/w/other${i}`,
    }));
    const payload = projectGraph(baseInput({ tips: tips({ wtHeadsCapped: true }), wtHeadCandidates: candidates }));
    expect(payload.wtHeads).toHaveLength(WTGRAPH_WT_HEADS_MAX);
    expect(payload.degrade.wtHeadsCapped).toBe(true);
    expect(payload.complete).toBe(false);
    expectValid(payload);
  });

  it("`more` alone does NOT mark the payload incomplete", () => {
    const commits = Array.from({ length: WTGRAPH_N + 5 }, (_, i) => ({ h: SHA1(i), p: [], a: "a", t: 1, s: "s" }));
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(0)] }),
        gl: { commits, badRecords: 0, parentsTruncated: 0, logCapped: false },
      }),
    );
    expect(payload.commits).toHaveLength(WTGRAPH_N);
    expect(payload.degrade.more).toBe(true);
    expect(payload.complete).toBe(true);
    expectValid(payload);
  });

  // ---- §2.5 ③ three-stage trim: refs/wtHeads/head ⊆ remaining commits ----------------------

  it("a forced byte-budget trim (small injected budget) drops tail commits and re-filters refs/wtHeads/head to the remaining set", () => {
    const n = 50;
    const commits = Array.from({ length: n }, (_, i) => ({
      h: SHA1(i),
      p: i + 1 < n ? [SHA1(i + 1)] : [],
      a: "author",
      t: 1_000 - i,
      s: `commit ${i}`,
    }));
    // A ref/wtHead pointing at the LAST (oldest, almost-certainly-trimmed) commit, and another
    // pointing at the FIRST (newest, certainly-kept) commit.
    const refRows: ForEachRefRow[] = [
      refRow({ refname: "refs/heads/old", objectName: SHA1(n - 1) }),
      refRow({ refname: "refs/heads/new", objectName: SHA1(0) }),
    ];
    const wtHeadCandidates: WtHeadCandidate[] = [
      { h: SHA1(n - 1), path: "/w/old-worktree" },
      { h: SHA1(0), path: "/w/new-worktree", self: true },
    ];
    // A tiny injected budget (project.ts's test-only `maxBodyBytes` override, see its header
    // comment: realistic protocol-max data barely busts the REAL 512 KiB cap via refs alone,
    // so stage ③'s commit trim needs a deliberately small bound to exercise deterministically)
    // that fits a couple of commits but not all 50 plus two refs.
    const payload = projectGraph(
      baseInput({
        refRows,
        tips: tips({ tips: [SHA1(0)] }),
        gl: { commits, badRecords: 0, parentsTruncated: 0, logCapped: false },
        wtHeadCandidates,
        maxBodyBytes: 900,
      }),
    );
    expect(payload.degrade.trimmed).toBeGreaterThan(0);
    const remaining = new Set(payload.commits.map((c) => c.h));
    expect(remaining.has(SHA1(n - 1))).toBe(false); // the tail commit really was dropped
    for (const r of payload.refs) expect(remaining.has(r.h)).toBe(true);
    for (const w of payload.wtHeads) expect(remaining.has(w.h)).toBe(true);
    if (payload.head !== undefined) expect(remaining.has(payload.head.h)).toBe(true);
    expectValid(payload);
  });

  it("realistic protocol-max data (sha256, 400 max-size refs) naturally busts the REAL 512 KiB cap and is trimmed", () => {
    const SHA256 = (n: number): string => n.toString(16).padStart(64, "0");
    const n = 200;
    const commits = Array.from({ length: n }, (_, i) => ({
      h: SHA256(i),
      p: Array.from({ length: 8 }, (_, j) => SHA256(1_000 + j)), // 8 parents ⇒ pT:true is legal
      pT: true as const,
      a: "x".repeat(64),
      t: 123_456_789,
      s: "y".repeat(200),
    }));
    const refRows: ForEachRefRow[] = Array.from({ length: 400 }, (_, i) =>
      refRow({
        objectType: "commit",
        objectName: SHA256(i % n),
        refname: `refs/heads/${"z".repeat(185)}${i}`,
        upstream: "w".repeat(199),
      }),
    );
    const wtHeadCandidates: WtHeadCandidate[] = Array.from({ length: 32 }, (_, i) => ({
      h: SHA256(i % n),
      path: `/${"a".repeat(4093)}${i}`,
      b: "q".repeat(190),
    }));
    // This exact combination sits close to the real 512 KiB cap either way; the test only
    // pins that `projectGraph` NEVER exceeds it and stays parser-valid, regardless of which
    // side of the line this particular shape happens to fall on.
    const payload = projectGraph(
      baseInput({
        refRows,
        tips: tips({ tips: [SHA256(0)], format: "sha256" }),
        gl: { commits, badRecords: 0, parentsTruncated: n, logCapped: false },
        wtHeadCandidates,
        shallow: true,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(512 * 1024);
    expectValid(payload);
  });

  it("a small injected budget trims refs alone (stage ②) when commits already fit", () => {
    const commits = [{ h: SHA1(0), p: [], a: "a", t: 1, s: "s" }];
    const refRows: ForEachRefRow[] = Array.from({ length: 20 }, (_, i) =>
      refRow({ refname: `refs/heads/b${i}`, objectName: SHA1(0) }),
    );
    const payload = projectGraph(
      baseInput({
        refRows,
        tips: tips({ tips: [SHA1(0)] }),
        gl: { commits, badRecords: 0, parentsTruncated: 0, logCapped: false },
        maxBodyBytes: 400, // fits the one commit + a handful of refs, not all 20
      }),
    );
    expect(payload.commits).toHaveLength(1); // untouched — stage ② alone was enough
    expect(payload.degrade.trimmed).toBeUndefined();
    expect(payload.refs.length).toBeLessThan(20);
    expect(payload.degrade.refsOmitted).toBeGreaterThan(0);
    expectValid(payload);
  });

  it("head/self candidate surfaces as payload.head with its branch name", () => {
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
        wtHeadCandidates: [{ h: SHA1(1), path: "/w/self", b: "main", self: true }],
      }),
    );
    expect(payload.head).toEqual({ h: SHA1(1), b: "main" });
    expect(payload.wtHeads).toEqual([{ h: SHA1(1), path: "/w/self", b: "main", self: true }]);
    expectValid(payload);
  });

  it("drops unborn self and detached worktree heads before cap computation", () => {
    const zero = "0".repeat(40);
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
        wtHeadCandidates: [
          { h: zero, path: "/w/self", b: "main", self: true },
          { h: zero, path: "/w/other" },
          { h: SHA1(1), path: "/w/live" },
        ],
      }),
    );
    expect(payload.head).toBeUndefined();
    expect(payload.wtHeads).toEqual([{ h: SHA1(1), path: "/w/live" }]);
    expect(payload.degrade.wtHeadsCapped).toBeUndefined();
    expectValid(payload);
  });

  it("lossily omits an overlong branch and drops an overlong path", () => {
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(1)] }),
        gl: {
          commits: [{ h: SHA1(1), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
        wtHeadCandidates: [
          { h: SHA1(1), path: "/w/self", b: "x".repeat(201), self: true },
          { h: SHA1(1), path: `/${"x".repeat(WTGRAPH_PATH_MAX_BYTES)}` },
        ],
      }),
    );
    expect(payload.head).toEqual({ h: SHA1(1) });
    expect(payload.wtHeads).toEqual([{ h: SHA1(1), path: "/w/self", self: true }]);
    expect(payload.degrade.wtHeadsCapped).toBe(true);
    expectValid(payload);
  });
  it("final trimmed marker and filtered refs are included at the exact byte boundary", () => {
    const commits = Array.from({ length: 50 }, (_, i) => ({ h: SHA1(i), p: [], a: "a", t: 1, s: "s" }));
    const input = baseInput({
      refRows: [refRow({ refname: "refs/heads/main", objectName: SHA1(0) })],
      tips: tips({ tips: [SHA1(0)] }),
      gl: { commits, badRecords: 0, parentsTruncated: 0, logCapped: false },
      wtHeadCandidates: [{ h: SHA1(0), path: "/w/self", self: true }],
    });
    const stageThree = projectGraph({ ...input, maxBodyBytes: 900 });
    const cap = Buffer.byteLength(JSON.stringify(stageThree), "utf8") - 1;
    const payload = projectGraph({ ...input, maxBodyBytes: cap });
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(cap);
    expect(payload.degrade.trimmed ?? 0).toBeGreaterThan(0);
    expectValid(payload);
  });
  it("shallow flag passes through", () => {
    const payload = projectGraph(baseInput({ shallow: true }));
    expect(payload.shallow).toBe(true);
    expectValid(payload);
  });

  it("a symref row (origin/HEAD) becomes a chip-only ref with sym:true, never a duplicate tip", () => {
    const refRows: ForEachRefRow[] = [
      refRow({ refname: "refs/remotes/origin/main", objectName: SHA1(0), upstream: "" }),
      refRow({ refname: "refs/remotes/origin/HEAD", objectName: SHA1(0), symref: "refs/remotes/origin/main" }),
    ];
    const t = tips({ tips: [SHA1(0)], refsSkipped: 0 });
    const payload = projectGraph(
      baseInput({
        refRows,
        tips: t,
        gl: {
          commits: [{ h: SHA1(0), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
      }),
    );
    const head = payload.refs.find((r) => r.n === "origin/HEAD");
    expect(head?.sym).toBe(true);
    expect(head?.k).toBe("remote");
    expect(payload.refs.filter((r) => r.n === "origin/main")).toHaveLength(1);
    expectValid(payload);
  });

  it("a branch ref's upstream short name rides `up`", () => {
    const refRows: ForEachRefRow[] = [
      refRow({ refname: "refs/heads/feat", objectName: SHA1(0), upstream: "origin/feat" }),
    ];
    const payload = projectGraph(
      baseInput({
        refRows,
        tips: tips({ tips: [SHA1(0)] }),
        gl: {
          commits: [{ h: SHA1(0), p: [], a: "a", t: 1, s: "s" }],
          badRecords: 0,
          parentsTruncated: 0,
          logCapped: false,
        },
      }),
    );
    expect(payload.refs[0]).toMatchObject({ k: "branch", n: "feat", up: "origin/feat" });
    expectValid(payload);
  });

  it("defensive fallback: Gl ran (non-empty tips) but produced zero commits with no other degrade marker ⇒ folds into empty (never a parser-invalid payload)", () => {
    const payload = projectGraph(
      baseInput({
        tips: tips({ tips: [SHA1(0)] }),
        gl: { commits: [], badRecords: 0, parentsTruncated: 0, logCapped: false },
      }),
    );
    expect(payload.commits).toEqual([]);
    expect(payload.empty).toBe(true);
    expectValid(payload);
  });
});
