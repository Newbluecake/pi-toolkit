/**
 * worktree-graph plan v2 §3 (P0 协议冻结验收): `protocol/worktree-graph.ts`'s frozen surface —
 * endpoint/caps/budget constants, `WTGRAPH_HUB_CAP` (`version.ts`, append-only), and
 * `parseWtGraphPayload`'s key-whitelist + hex/length/cap + `complete`⇔`degrade` consistency
 * rules — plus §2.4's two time-budget relations, pinned with REAL arithmetic against the
 * `WTDIFF_*` constants `src/git/graph.ts`/P2 will actually schedule against.
 *
 * Per §7 P0 row, every parser rejection condition gets at least one example: unknown key
 * (top-level + each nested object), hex length/format inconsistency, non-integer `t`, every
 * cap's ±1 boundary, and the `complete`/`degrade` contradiction (both directions).
 */
import { describe, expect, it } from "vitest";
import { WTGRAPH_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import {
  WTDIFF_ADMIT_MS,
  WTDIFF_CLOSE_MS,
  WTDIFF_STEP_MS,
  WTDIFF_TRANSFER_RESERVE_MS,
} from "../../../src/web-hub/protocol/worktree-diff.js";
import {
  parseWtGraphPayload,
  WTGRAPH_AUTHOR_MAX_BYTES,
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_CLIENT_TIMEOUT_MS,
  WTGRAPH_GIT_PHASE_MS,
  WTGRAPH_LOG_MAX_BYTES,
  WTGRAPH_LOG_MS,
  WTGRAPH_N,
  WTGRAPH_PARENTS_MAX,
  WTGRAPH_PATH,
  WTGRAPH_PATH_MAX_BYTES,
  WTGRAPH_REFNAME_MAX_BYTES,
  WTGRAPH_REFS_MAX,
  WTGRAPH_REFS_MAX_BYTES,
  WTGRAPH_REFS_SCAN_MAX,
  WTGRAPH_SUBJECT_MAX_BYTES,
  WTGRAPH_TIPS_MAX,
  WTGRAPH_WT_HEADS_MAX,
  type WtGraphCommit,
  type WtGraphPayload,
  type WtGraphRef,
  type WtGraphWtHead,
} from "../../../src/web-hub/protocol/worktree-graph.js";

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;

/** Deterministic distinct lowercase-hex sha1-length oid (never all-zero). */
function hex(i: number): string {
  return (i + 1).toString(16).padStart(40, "0");
}
const H1 = hex(0);
const H2 = hex(1);
const H3 = hex(2);

function clone<T>(v: T): T {
  return structuredClone(v);
}

function basePayload(): WtGraphPayload {
  return {
    v: 1,
    n: WTGRAPH_N,
    format: "sha1",
    commits: [{ h: H1, p: [], a: "Alice", t: 1_700_000_000, s: "init" }],
    refs: [{ k: "branch", n: "main", h: H1 }],
    wtHeads: [{ h: H1, path: "/repo" }],
    degrade: {},
    complete: true,
  };
}

function genCommits(count: number): WtGraphCommit[] {
  return Array.from({ length: count }, (_, i) => ({ h: hex(i), p: [], a: "A", t: 1, s: "s" }));
}
function genRefs(count: number): WtGraphRef[] {
  return Array.from({ length: count }, (_, i) => ({ k: "branch" as const, n: `b${i}`, h: H1 }));
}
function genWtHeads(count: number): WtGraphWtHead[] {
  return Array.from({ length: count }, (_, i) => ({ h: H1, path: `/repo/${i}` }));
}
function genParents(count: number): string[] {
  // distinct from H1 (the commit's own oid) so no accidental self-parent
  return Array.from({ length: count }, (_, i) => hex(i + 100));
}

// ---------------------------------------------------------------------------
// frozen constants (§3)
// ---------------------------------------------------------------------------

describe("protocol/worktree-graph — frozen constants (§3)", () => {
  it("pins the endpoint path and the hub cap (version.ts, append-only)", () => {
    expect(WTGRAPH_PATH).toBe("/api/worktree-graph");
    expect(WTGRAPH_HUB_CAP).toBe("wtgraph.v1");
  });

  it("pins the caps (§3)", () => {
    expect(WTGRAPH_N).toBe(200);
    expect(WTGRAPH_PARENTS_MAX).toBe(8);
    expect(WTGRAPH_SUBJECT_MAX_BYTES).toBe(200);
    expect(WTGRAPH_AUTHOR_MAX_BYTES).toBe(64);
    expect(WTGRAPH_REFNAME_MAX_BYTES).toBe(200);
    expect(WTGRAPH_REFS_SCAN_MAX).toBe(2_000);
    expect(WTGRAPH_REFS_MAX).toBe(400);
    expect(WTGRAPH_TIPS_MAX).toBe(2_048);
    expect(WTGRAPH_WT_HEADS_MAX).toBe(32);
    expect(WTGRAPH_REFS_MAX_BYTES).toBe(256 * 1024);
    expect(WTGRAPH_LOG_MAX_BYTES).toBe(512 * 1024);
    expect(WTGRAPH_BODY_MAX_BYTES).toBe(512 * 1024);
  });

  it("pins the budget constants (§2.4)", () => {
    expect(WTGRAPH_LOG_MS).toBe(6_000);
    expect(WTGRAPH_GIT_PHASE_MS).toBe(14_000);
    expect(WTGRAPH_CLIENT_TIMEOUT_MS).toBe(35_000);
  });
});

// ---------------------------------------------------------------------------
// §2.4 time-budget relations — real arithmetic against the SAME WTDIFF_* constants P2 will
// actually schedule S1–S4/finally/transfer against.
// ---------------------------------------------------------------------------

describe("protocol/worktree-graph — §2.4 time-budget relations", () => {
  it("4 × WTDIFF_STEP_MS + WTGRAPH_LOG_MS = 14s ≤ WTGRAPH_GIT_PHASE_MS (S5/Gl always gets its full 6s cap)", () => {
    expect(4 * WTDIFF_STEP_MS + WTGRAPH_LOG_MS).toBe(14_000);
    expect(4 * WTDIFF_STEP_MS + WTGRAPH_LOG_MS).toBeLessThanOrEqual(WTGRAPH_GIT_PHASE_MS);
  });

  it("server wall clock 8 + 14 + 1 = 23s; 23 + 10 = 33 ≤ WTGRAPH_CLIENT_TIMEOUT_MS (35s)", () => {
    expect(WTDIFF_ADMIT_MS + WTGRAPH_GIT_PHASE_MS + WTDIFF_CLOSE_MS).toBe(23_000);
    expect(23_000 + WTDIFF_TRANSFER_RESERVE_MS).toBe(33_000);
    expect(23_000 + WTDIFF_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(WTGRAPH_CLIENT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// parseWtGraphPayload — the canonical accepted shape
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — accepts the canonical shape", () => {
  it("accepts a minimal valid payload byte-for-byte", () => {
    const payload = basePayload();
    expect(parseWtGraphPayload(payload)).toEqual(payload);
  });

  it("accepts a fuller payload: shallow, head, pT, ref up/sym, wtHead b/self, degrade+complete:false", () => {
    const payload: WtGraphPayload = {
      v: 1,
      n: WTGRAPH_N,
      format: "sha1",
      shallow: true,
      head: { h: H1, b: "main" },
      commits: [
        { h: H1, p: [H2], a: "Alice", t: 1_700_000_000, s: "init" },
        { h: H2, p: genParents(WTGRAPH_PARENTS_MAX), pT: true, a: "Bob", t: 1_700_000_001, s: "octopus" },
      ],
      refs: [
        { k: "branch", n: "main", h: H1, up: "origin/main" },
        { k: "remote", n: "origin/HEAD", h: H1, sym: true },
        { k: "tag", n: "v1.0", h: H2 },
      ],
      wtHeads: [{ h: H1, path: "/repo", b: "main", self: true }],
      degrade: { more: true, trimmed: 3, parentsTruncated: 1 },
      complete: false,
    };
    expect(parseWtGraphPayload(payload)).toEqual(payload);
  });

  it("accepts a true empty repo (empty:true, commits:[], complete:true)", () => {
    const payload: WtGraphPayload = { ...basePayload(), commits: [], empty: true };
    expect(parseWtGraphPayload(payload)).toEqual(payload);
  });

  it("accepts the degraded zero-commits state (commits:[] without empty, ≥1 real marker, complete:false)", () => {
    const payload: WtGraphPayload = {
      ...basePayload(),
      commits: [],
      degrade: { badRecords: 1 },
      complete: false,
    };
    expect(parseWtGraphPayload(payload)).toEqual(payload);
  });

  it("never throws on wildly-shaped garbage", () => {
    for (const bad of [null, undefined, 42, "x", [], true, new Date(), () => {}]) {
      expect(() => parseWtGraphPayload(bad)).not.toThrow();
      expect(parseWtGraphPayload(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// unknown key (every object level is a whitelist — §3 header comment)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — rejects an unknown key at every object level", () => {
  it("top-level", () => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.extra = 1;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("commit", () => {
    const p = clone(basePayload());
    (p.commits[0] as unknown as Record<string, unknown>).extra = 1;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("ref", () => {
    const p = clone(basePayload());
    (p.refs[0] as unknown as Record<string, unknown>).extra = 1;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("wtHead", () => {
    const p = clone(basePayload());
    (p.wtHeads[0] as unknown as Record<string, unknown>).extra = 1;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("head", () => {
    const p = clone(basePayload());
    p.head = { h: H1, extra: 1 } as unknown as WtGraphPayload["head"];
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("degrade", () => {
    const p = clone(basePayload());
    p.degrade = { extra: 1 } as unknown as WtGraphPayload["degrade"];
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hex length / format inconsistency
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — hex length/format inconsistency", () => {
  it("rejects a commit hash whose length doesn't match the declared format (sha1 vs sha256)", () => {
    const p = clone(basePayload());
    p.commits[0].h = "a".repeat(64); // sha256-length oid under format:"sha1"
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects uppercase hex", () => {
    const p = clone(basePayload());
    p.commits[0].h = "A".repeat(40);
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects non-hex characters", () => {
    const p = clone(basePayload());
    p.commits[0].h = "g".repeat(40);
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects a mixed-length parent oid under a sha1 payload", () => {
    const p = clone(basePayload());
    p.commits[0].p = ["a".repeat(64)];
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects a ref/wtHead/head hash whose length doesn't match format", () => {
    const pRef = clone(basePayload());
    pRef.refs[0].h = "b".repeat(64);
    expect(parseWtGraphPayload(pRef)).toBeNull();

    const pWt = clone(basePayload());
    pWt.wtHeads[0].h = "b".repeat(64);
    expect(parseWtGraphPayload(pWt)).toBeNull();

    const pHead = clone(basePayload());
    pHead.head = { h: "b".repeat(64) };
    expect(parseWtGraphPayload(pHead)).toBeNull();
  });

  it("accepts a valid sha256-format payload (64-hex everywhere)", () => {
    const h256 = "a".repeat(64);
    const payload: WtGraphPayload = {
      ...basePayload(),
      format: "sha256",
      commits: [{ h: h256, p: [], a: "A", t: 1, s: "s" }],
      refs: [{ k: "branch", n: "main", h: h256 }],
      wtHeads: [{ h: h256, path: "/repo" }],
    };
    expect(parseWtGraphPayload(payload)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// t non-integer
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — rejects a non-integer/negative/non-numeric author time", () => {
  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, "1700000000", null, undefined])("t = %p", (bad) => {
    const p = clone(basePayload());
    (p.commits[0] as unknown as Record<string, unknown>).t = bad as unknown;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts t = 0 (epoch is a legal, non-negative integer)", () => {
    const p = clone(basePayload());
    p.commits[0].t = 0;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });
});

// ---------------------------------------------------------------------------
// over-cap ±1 (every numeric cap in §3)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — over-cap ±1 boundaries", () => {
  it("n is pinned to WTGRAPH_N (§0 G3): 201, 199, 0 and MAX_SAFE_INTEGER are all rejected", () => {
    for (const bad of [WTGRAPH_N + 1, WTGRAPH_N - 1, 0, Number.MAX_SAFE_INTEGER]) {
      const p = { ...basePayload(), n: bad };
      expect(parseWtGraphPayload(p)).toBeNull();
    }
  });

  it("commits.length ≤ WTGRAPH_N with the REAL frozen n=200 boundary: exactly 200 ok, 201 rejected", () => {
    const ok: WtGraphPayload = { ...basePayload(), commits: genCommits(WTGRAPH_N) };
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over: WtGraphPayload = { ...basePayload(), commits: genCommits(WTGRAPH_N + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("commits cap holds even when n matches WTGRAPH_N but the array itself is oversized (defense in depth, not merely the n-equality check)", () => {
    const over: WtGraphPayload = { ...basePayload(), n: WTGRAPH_N, commits: genCommits(WTGRAPH_N + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("refs.length ≤ WTGRAPH_REFS_MAX: 400 ok, 401 rejected", () => {
    const ok: WtGraphPayload = { ...basePayload(), refs: genRefs(WTGRAPH_REFS_MAX) };
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over: WtGraphPayload = { ...basePayload(), refs: genRefs(WTGRAPH_REFS_MAX + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("wtHeads.length ≤ WTGRAPH_WT_HEADS_MAX: 32 ok, 33 rejected", () => {
    const ok: WtGraphPayload = { ...basePayload(), wtHeads: genWtHeads(WTGRAPH_WT_HEADS_MAX) };
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over: WtGraphPayload = { ...basePayload(), wtHeads: genWtHeads(WTGRAPH_WT_HEADS_MAX + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("commit.p.length ≤ WTGRAPH_PARENTS_MAX: 8 ok, 9 rejected", () => {
    const ok = clone(basePayload());
    ok.commits[0].p = genParents(WTGRAPH_PARENTS_MAX);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.commits[0].p = genParents(WTGRAPH_PARENTS_MAX + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("subject byte cap: 200 ok, 201 rejected", () => {
    const ok = clone(basePayload());
    ok.commits[0].s = "x".repeat(WTGRAPH_SUBJECT_MAX_BYTES);
    expect(byteLen(ok.commits[0].s)).toBe(WTGRAPH_SUBJECT_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.commits[0].s = "x".repeat(WTGRAPH_SUBJECT_MAX_BYTES + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("author byte cap: 64 ok, 65 rejected", () => {
    const ok = clone(basePayload());
    ok.commits[0].a = "x".repeat(WTGRAPH_AUTHOR_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.commits[0].a = "x".repeat(WTGRAPH_AUTHOR_MAX_BYTES + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("ref name byte cap: 200 ok, 201 rejected", () => {
    const ok = clone(basePayload());
    ok.refs[0].n = "x".repeat(WTGRAPH_REFNAME_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.refs[0].n = "x".repeat(WTGRAPH_REFNAME_MAX_BYTES + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("wtHeads[].path byte cap: WTGRAPH_PATH_MAX_BYTES ok, +1 rejected", () => {
    const ok = clone(basePayload());
    ok.wtHeads[0].path = "/" + "x".repeat(WTGRAPH_PATH_MAX_BYTES - 1);
    expect(byteLen(ok.wtHeads[0].path)).toBe(WTGRAPH_PATH_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.wtHeads[0].path = "/" + "x".repeat(WTGRAPH_PATH_MAX_BYTES);
    expect(parseWtGraphPayload(over)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pT ⇔ exactly WTGRAPH_PARENTS_MAX parents
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — pT truncation marker consistency", () => {
  it("rejects pT:true when p.length !== WTGRAPH_PARENTS_MAX", () => {
    const under = clone(basePayload());
    under.commits[0].p = genParents(WTGRAPH_PARENTS_MAX - 1);
    under.commits[0].pT = true;
    under.degrade = { parentsTruncated: 1 };
    under.complete = false;
    expect(parseWtGraphPayload(under)).toBeNull();
  });

  it("rejects a visible pT with NO parentsTruncated degrade marker at all (can't be waved off as complete)", () => {
    const p = clone(basePayload());
    p.commits[0].p = genParents(WTGRAPH_PARENTS_MAX);
    p.commits[0].pT = true;
    // degrade: {} / complete: true (inherited from basePayload()) — exactly the combination the
    // verifier found wrongly ACCEPTED before this fix.
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects a visible pT whose parentsTruncated counter is present but UNDER the visible count", () => {
    const p: WtGraphPayload = {
      ...basePayload(),
      commits: [
        { h: H1, p: genParents(WTGRAPH_PARENTS_MAX), pT: true, a: "A", t: 1, s: "a" },
        { h: H2, p: genParents(WTGRAPH_PARENTS_MAX), pT: true, a: "B", t: 2, s: "b" },
      ],
      degrade: { parentsTruncated: 1 }, // only covers 1 of the 2 visible pT commits
      complete: false,
    };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts pT:true with exactly WTGRAPH_PARENTS_MAX parents WHEN parentsTruncated covers it and complete:false", () => {
    const p = clone(basePayload());
    p.commits[0].p = genParents(WTGRAPH_PARENTS_MAX);
    p.commits[0].pT = true;
    p.degrade = { parentsTruncated: 1 };
    p.complete = false;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it("accepts a visible pT when parentsTruncated is STRICTLY GREATER than the visible count (a trimmed pT commit left the wire, but the hub's counter was taken before the trim)", () => {
    const p = clone(basePayload());
    p.commits[0].p = genParents(WTGRAPH_PARENTS_MAX);
    p.commits[0].pT = true;
    p.degrade = { parentsTruncated: 5 }; // ≥ 1 visible pT, not ===
    p.complete = false;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });
});

// ---------------------------------------------------------------------------
// duplicate commit oid (consult 2026-10-10, pinned in the header comment)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — rejects duplicate commit oids", () => {
  it("two commits sharing the same h", () => {
    const p: WtGraphPayload = {
      ...basePayload(),
      commits: [
        { h: H1, p: [], a: "A", t: 1, s: "a" },
        { h: H1, p: [], a: "B", t: 2, s: "b" },
      ],
    };
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// complete ⇔ degrade contradiction (both directions)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — complete vs degrade contradiction", () => {
  it("rejects complete:true with a real degrade marker present (flag)", () => {
    const p = clone(basePayload());
    p.complete = true;
    p.degrade = { logCapped: true };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects complete:true with a real degrade marker present (counter)", () => {
    const p = clone(basePayload());
    p.complete = true;
    p.degrade = { trimmed: 1 };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects complete:false with no real degrade marker at all", () => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = {};
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects complete:false with ONLY `more` set (more never counts as degradation)", () => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = { more: true };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts complete:true with ONLY `more` set", () => {
    const p = clone(basePayload());
    p.complete = true;
    p.degrade = { more: true };
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it("accepts complete:false with a real marker present", () => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = { refsTruncated: true };
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it("rejects a degrade counter of literal 0 (omitted-when-zero is off-contract)", () => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = { badRecords: 0 } as unknown as WtGraphPayload["degrade"];
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// empty ⇔ commits consistency
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — empty/commits one-directional consistency", () => {
  it("rejects empty:true with non-empty commits", () => {
    const p = clone(basePayload());
    p.empty = true;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects commits:[] without empty and without any real degrade marker", () => {
    const p: WtGraphPayload = { ...basePayload(), commits: [] };
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// illegal top-level scalar values (v/format/complete) and wrong array/object types
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — illegal top-level scalars and wrong container types", () => {
  it.each([0, "1", true, null, 1.5, [1]])("rejects v = %p", (bad) => {
    const p = { ...basePayload(), v: bad as unknown } as unknown;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["sha3", "", 1, null, "SHA1", "sha1 "])("rejects format = %p", (bad) => {
    const p = { ...basePayload(), format: bad as unknown } as unknown;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["true", 1, 0, null, undefined])("rejects complete = %p", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.complete = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([false, 1, "true", 0])("rejects shallow = %p (must be true or absent)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.shallow = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([false, 1, "true", 0])("rejects empty = %p (must be true or absent)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.empty = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, {}, true])("rejects commits = %p (must be an array)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.commits = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, {}, true])("rejects refs = %p (must be an array)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.refs = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, {}, true])("rejects wtHeads = %p (must be an array)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.wtHeads = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, [], true])("rejects degrade = %p (must be a plain object)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.degrade = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, [], true])("rejects head = %p when present (must be a plain object)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    p.head = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, [], true])("rejects a commits[] entry of %p (must be a plain object)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    (p.commits as unknown[]) = [bad];
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, [], true])("rejects a refs[] entry of %p (must be a plain object)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    (p.refs as unknown[]) = [bad];
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, "x", 42, [], true])("rejects a wtHeads[] entry of %p (must be a plain object)", (bad) => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    (p.wtHeads as unknown[]) = [bad];
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// field type/emptiness: a/s/n/up/b/path
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — field type and emptiness rejections (a/s/n/up/b/path)", () => {
  it.each([42, null, undefined, {}])("rejects commit.a = %p (must be a string)", (bad) => {
    const p = clone(basePayload());
    (p.commits[0] as unknown as Record<string, unknown>).a = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts commit.a = '' (author name may be empty)", () => {
    const p = clone(basePayload());
    p.commits[0].a = "";
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it.each([42, null, undefined, {}])("rejects commit.s = %p (must be a string)", (bad) => {
    const p = clone(basePayload());
    (p.commits[0] as unknown as Record<string, unknown>).s = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts commit.s = '' (subject may be empty)", () => {
    const p = clone(basePayload());
    p.commits[0].s = "";
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it.each(["", 42, null, undefined, {}])("rejects ref.n = %p (non-empty string required)", (bad) => {
    const p = clone(basePayload());
    (p.refs[0] as unknown as Record<string, unknown>).n = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["", 42, {}])("rejects ref.up = %p when present (non-empty string required)", (bad) => {
    const p = clone(basePayload());
    (p.refs[0] as unknown as Record<string, unknown>).up = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["", 42, {}])("rejects wtHead.b = %p when present (non-empty string required)", (bad) => {
    const p = clone(basePayload());
    (p.wtHeads[0] as unknown as Record<string, unknown>).b = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["", 42, null, undefined, {}, "repo"])(
    "rejects wtHead.path = %p (non-empty absolute string required)",
    (bad) => {
      const p = clone(basePayload());
      (p.wtHeads[0] as unknown as Record<string, unknown>).path = bad;
      expect(parseWtGraphPayload(p)).toBeNull();
    },
  );

  it("rejects wtHead.path containing a NUL byte", () => {
    const p = clone(basePayload());
    p.wtHeads[0].path = "/repo\0evil";
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wtHead.path: Linux absolute-path requirement (Minor finding)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — wtHead.path must be an absolute (Linux) path", () => {
  it.each(["repo", "./repo", "../repo", "~/repo", "repo/sub", " /repo"])("rejects relative-looking path %p", (bad) => {
    const p = clone(basePayload());
    p.wtHeads[0].path = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts a plain absolute path and a multi-byte absolute path exactly at the byte cap", () => {
    const ok = clone(basePayload());
    ok.wtHeads[0].path = "/repo/worktrees/pi-agent-1";
    expect(parseWtGraphPayload(ok)).toEqual(ok);

    const multibyte = clone(basePayload());
    // "/" (1B) + 2047 × 2-byte char (4094B) + 1 ASCII char (1B) = 4096B exactly
    multibyte.wtHeads[0].path = "/" + "α".repeat((WTGRAPH_PATH_MAX_BYTES - 2) / 2) + "b";
    expect(byteLen(multibyte.wtHeads[0].path)).toBe(WTGRAPH_PATH_MAX_BYTES);
    expect(parseWtGraphPayload(multibyte)).toEqual(multibyte);
  });
});

// ---------------------------------------------------------------------------
// degrade flags/counters: illegal values, independently of complete's truth value
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — degrade flag/counter illegal values", () => {
  it.each(["more", "logCapped", "refsTruncated", "wtHeadsCapped"] as const)(
    "rejects degrade.%s = non-true values",
    (flag) => {
      for (const bad of [false, 1, "true", 0]) {
        const p = clone(basePayload());
        p.complete = false;
        p.degrade = { [flag]: bad } as unknown as WtGraphPayload["degrade"];
        expect(parseWtGraphPayload(p)).toBeNull();
      }
    },
  );

  it.each(["badRecords", "refsSkipped", "refsOmitted", "trimmed"] as const)(
    "rejects degrade.%s = illegal counter values (0, negative, non-integer, string)",
    (counter) => {
      for (const bad of [0, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
        const p = clone(basePayload());
        p.complete = false;
        p.degrade = { [counter]: bad } as unknown as WtGraphPayload["degrade"];
        expect(parseWtGraphPayload(p)).toBeNull();
      }
    },
  );

  it("rejects degrade.parentsTruncated illegal values even with a covering visible pT", () => {
    for (const bad of [0, -1, 1.5, "1"]) {
      const p = clone(basePayload());
      p.commits[0].p = genParents(WTGRAPH_PARENTS_MAX);
      p.commits[0].pT = true;
      p.complete = false;
      p.degrade = { parentsTruncated: bad } as unknown as WtGraphPayload["degrade"];
      expect(parseWtGraphPayload(p)).toBeNull();
    }
  });

  it("each counter accepts exactly 1 (the minimum legal value) and flips complete to false", () => {
    for (const counter of ["badRecords", "refsSkipped", "refsOmitted", "trimmed"] as const) {
      const p = clone(basePayload());
      p.complete = false;
      p.degrade = { [counter]: 1 };
      expect(parseWtGraphPayload(p)).toEqual(p);
    }
  });
});

// ---------------------------------------------------------------------------
// sha256 format: parent/head length consistency
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — sha256 format oid-length consistency", () => {
  const H256 = "a".repeat(64);

  it("rejects a sha1-length parent under format:sha256", () => {
    const p: WtGraphPayload = {
      ...basePayload(),
      format: "sha256",
      commits: [{ h: H256, p: [H1], a: "A", t: 1, s: "s" }], // H1 is 40-hex (sha1 length)
      refs: [{ k: "branch", n: "main", h: H256 }],
      wtHeads: [{ h: H256, path: "/repo" }],
    };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("rejects a sha1-length head.h under format:sha256", () => {
    const p: WtGraphPayload = {
      ...basePayload(),
      format: "sha256",
      head: { h: H1 },
      commits: [{ h: H256, p: [], a: "A", t: 1, s: "s" }],
      refs: [{ k: "branch", n: "main", h: H256 }],
      wtHeads: [{ h: H256, path: "/repo" }],
    };
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// safe-integer boundaries (t)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — safe-integer boundary for t", () => {
  it("accepts t = Number.MAX_SAFE_INTEGER", () => {
    const p = clone(basePayload());
    p.commits[0].t = Number.MAX_SAFE_INTEGER;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it("rejects t = 2**53 (one past the largest safe integer)", () => {
    const p = clone(basePayload());
    p.commits[0].t = 2 ** 53;
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// multi-byte boundaries on author/subject/refname caps
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — multi-byte byte-cap boundaries", () => {
  it("author: 2-byte char × 32 = exactly 64 bytes ok, +1 char rejected", () => {
    const ok = clone(basePayload());
    ok.commits[0].a = "α".repeat(WTGRAPH_AUTHOR_MAX_BYTES / 2);
    expect(byteLen(ok.commits[0].a)).toBe(WTGRAPH_AUTHOR_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.commits[0].a = "α".repeat(WTGRAPH_AUTHOR_MAX_BYTES / 2 + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("subject: surrogate-pair char × 50 = exactly 200 bytes ok, +1 char rejected", () => {
    const ok = clone(basePayload());
    ok.commits[0].s = "𝄞".repeat(WTGRAPH_SUBJECT_MAX_BYTES / 4);
    expect(byteLen(ok.commits[0].s)).toBe(WTGRAPH_SUBJECT_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.commits[0].s = "𝄞".repeat(WTGRAPH_SUBJECT_MAX_BYTES / 4) + "x";
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("ref name: 2-byte char × 100 = exactly 200 bytes ok, +1 char rejected", () => {
    const ok = clone(basePayload());
    ok.refs[0].n = "α".repeat(WTGRAPH_REFNAME_MAX_BYTES / 2);
    expect(byteLen(ok.refs[0].n)).toBe(WTGRAPH_REFNAME_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.refs[0].n = "α".repeat(WTGRAPH_REFNAME_MAX_BYTES / 2 + 1);
    expect(parseWtGraphPayload(over)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hostile inputs: throwing getters/Proxies, revoked Proxy, inherited fields,
// Object.prototype pollution, exotic prototypes, non-enumerable sneaked keys.
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — hostile objects never throw and are rejected", () => {
  it("never throws and rejects a Proxy whose `get` trap throws", () => {
    const hostile = new Proxy(basePayload() as unknown as object, {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => parseWtGraphPayload(hostile)).not.toThrow();
    expect(parseWtGraphPayload(hostile)).toBeNull();
  });

  it("never throws and rejects a Proxy whose `ownKeys` trap throws", () => {
    const hostile = new Proxy(basePayload() as unknown as object, {
      ownKeys() {
        throw new Error("boom");
      },
    });
    expect(() => parseWtGraphPayload(hostile)).not.toThrow();
    expect(parseWtGraphPayload(hostile)).toBeNull();
  });

  it("never throws and rejects a Proxy whose `getOwnPropertyDescriptor` trap throws", () => {
    const hostile = new Proxy(basePayload() as unknown as object, {
      getOwnPropertyDescriptor() {
        throw new Error("boom");
      },
    });
    expect(() => parseWtGraphPayload(hostile)).not.toThrow();
    expect(parseWtGraphPayload(hostile)).toBeNull();
  });

  it("never throws and rejects a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable(basePayload() as unknown as object, {});
    revoke();
    expect(() => parseWtGraphPayload(proxy)).not.toThrow();
    expect(parseWtGraphPayload(proxy)).toBeNull();
  });

  it("never throws and rejects an object with a throwing getter on a protocol field", () => {
    const hostile: Record<string, unknown> = { ...basePayload() };
    Object.defineProperty(hostile, "v", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => parseWtGraphPayload(hostile)).not.toThrow();
    expect(parseWtGraphPayload(hostile)).toBeNull();
  });

  it("rejects an object whose own prototype is not Object.prototype/null (class instance)", () => {
    class Fake {
      v = 1;
      n = WTGRAPH_N;
      format = "sha1" as const;
      commits: unknown[] = [];
      refs: unknown[] = [];
      wtHeads: unknown[] = [];
      degrade = {};
      complete = true;
    }
    expect(parseWtGraphPayload(new Fake())).toBeNull();
  });

  it("rejects an object built via Object.create(proto) carrying the real payload ONLY on the prototype (inherited-field attack)", () => {
    const proto = basePayload();
    const inherited = Object.create(proto) as object;
    // `inherited` has ZERO own properties; every field it exposes is inherited.
    expect(Object.getOwnPropertyNames(inherited)).toHaveLength(0);
    expect(parseWtGraphPayload(inherited)).toBeNull();
  });

  it("rejects an otherwise-plain object whose required field lives only on a polluted Object.prototype", () => {
    const base = basePayload() as unknown as Record<string, unknown>;
    const { v: _v, ...rest } = base;
    const empty: Record<string, unknown> = { ...rest }; // own props for everything except `v`
    // @ts-expect-error -- deliberate, temporary Object.prototype pollution for this one test
    Object.prototype.v = 1;
    try {
      expect(Object.prototype.hasOwnProperty.call(empty, "v")).toBe(false);
      expect(parseWtGraphPayload(empty)).toBeNull();
    } finally {
      // @ts-expect-error -- clean up the pollution unconditionally
      delete Object.prototype.v;
    }
  });

  it("rejects a non-enumerable own key that isn't in the whitelist (hasOnlyKeys must see it)", () => {
    const p = clone(basePayload()) as unknown as Record<string, unknown>;
    Object.defineProperty(p, "sneaky", { value: 1, enumerable: false });
    expect(Object.keys(p)).not.toContain("sneaky"); // invisible to Object.keys
    expect(Object.getOwnPropertyNames(p)).toContain("sneaky"); // but IS an own property
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("still accepts a plain Object.create(null) payload (no prototype, not hostile)", () => {
    const p = Object.assign(Object.create(null), basePayload()) as WtGraphPayload;
    expect(parseWtGraphPayload(p)).toEqual(basePayload());
  });
});

// ---------------------------------------------------------------------------
// B4 (verifier re-check): __proto__ / constructor as genuine OWN keys at every level
// ---------------------------------------------------------------------------

/** Adds `key` as a genuine OWN data property (via `defineProperty`, never assignment — an
 *  assignment to `.__proto__` would invoke the inherited accessor instead of creating an own
 *  property). Never touches the object's actual prototype. */
function withDangerousOwnKey<T extends object>(obj: T, key: "__proto__" | "constructor", value: unknown): T {
  const copy = { ...(obj as object) } as T;
  return Object.defineProperty(copy, key, { value, enumerable: true, configurable: true, writable: true });
}

describe("parseWtGraphPayload — __proto__/constructor as genuine OWN keys at every object level", () => {
  const originalProto: unknown = Object.getPrototypeOf({});

  it.each(["__proto__", "constructor"] as const)(
    "rejects an own %s key at the top level; the real prototype is untouched",
    (key) => {
      const p = withDangerousOwnKey(basePayload(), key, { polluted: true });
      expect(Object.getOwnPropertyNames(p)).toContain(key);
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
      expect(parseWtGraphPayload(p)).toBeNull();
    },
  );

  it.each(["__proto__", "constructor"] as const)("rejects an own %s key on a commit entry", (key) => {
    const p = clone(basePayload());
    p.commits[0] = withDangerousOwnKey(p.commits[0], key, { polluted: true });
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["__proto__", "constructor"] as const)("rejects an own %s key on a ref entry", (key) => {
    const p = clone(basePayload());
    p.refs[0] = withDangerousOwnKey(p.refs[0], key, { polluted: true });
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["__proto__", "constructor"] as const)("rejects an own %s key on a wtHead entry", (key) => {
    const p = clone(basePayload());
    p.wtHeads[0] = withDangerousOwnKey(p.wtHeads[0], key, { polluted: true });
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["__proto__", "constructor"] as const)("rejects an own %s key on head", (key) => {
    const p = clone(basePayload());
    p.head = withDangerousOwnKey({ h: H1 }, key, { polluted: true });
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each(["__proto__", "constructor"] as const)("rejects an own %s key on degrade", (key) => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = withDangerousOwnKey({ trimmed: 1 }, key, { polluted: true });
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("leaves the real Object.prototype completely unpolluted after every case above", () => {
    expect(Object.getPrototypeOf({})).toBe(originalProto);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B4: pT / sym / self must be exactly `true` or absent (not merely truthy)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — pT/sym/self reject any non-true value", () => {
  it.each([false, 1, "true", null])("rejects commit.pT = %p", (bad) => {
    const p = clone(basePayload());
    (p.commits[0] as unknown as Record<string, unknown>).pT = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([false, 1, "true", null])("rejects ref.sym = %p", (bad) => {
    const p = clone(basePayload());
    (p.refs[0] as unknown as Record<string, unknown>).sym = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([false, 1, "true", null])("rejects wtHead.self = %p", (bad) => {
    const p = clone(basePayload());
    (p.wtHeads[0] as unknown as Record<string, unknown>).self = bad;
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B4: head.b illegal values (type, emptiness, byte cap, multi-byte boundary)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — head.b illegal values", () => {
  it.each([42, "", null, {}, true])("rejects head.b = %p", (bad) => {
    const p = clone(basePayload());
    p.head = { h: H1, b: bad as unknown as string };
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts head.b exactly at WTGRAPH_REFNAME_MAX_BYTES, rejects one byte over", () => {
    const ok = clone(basePayload());
    ok.head = { h: H1, b: "x".repeat(WTGRAPH_REFNAME_MAX_BYTES) };
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.head = { h: H1, b: "x".repeat(WTGRAPH_REFNAME_MAX_BYTES + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });

  it("multi-byte boundary: 2-byte char × 100 = exactly 200 bytes ok, +1 char rejected", () => {
    const ok = clone(basePayload());
    ok.head = { h: H1, b: "α".repeat(WTGRAPH_REFNAME_MAX_BYTES / 2) };
    expect(byteLen(ok.head.b as string)).toBe(WTGRAPH_REFNAME_MAX_BYTES);
    expect(parseWtGraphPayload(ok)).toEqual(ok);
    const over = clone(basePayload());
    over.head = { h: H1, b: "α".repeat(WTGRAPH_REFNAME_MAX_BYTES / 2 + 1) };
    expect(parseWtGraphPayload(over)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B4: EACH of the 8 real degrade markers independently flips complete (bidirectional)
// ---------------------------------------------------------------------------

describe("parseWtGraphPayload — each real degrade marker independently gates complete (both directions)", () => {
  const REAL_MARKERS: ReadonlyArray<[string, true | number]> = [
    ["logCapped", true],
    ["badRecords", 1],
    ["parentsTruncated", 1],
    ["refsTruncated", true],
    ["refsSkipped", 1],
    ["refsOmitted", 1],
    ["trimmed", 1],
    ["wtHeadsCapped", true],
  ];

  it.each(REAL_MARKERS)("degrade.%s present + complete:false => accepted", (marker, value) => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = { [marker]: value } as unknown as WtGraphPayload["degrade"];
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it.each(REAL_MARKERS)("degrade.%s present + complete:true => rejected", (marker, value) => {
    const p = clone(basePayload());
    p.complete = true;
    p.degrade = { [marker]: value } as unknown as WtGraphPayload["degrade"];
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("`more` alone: complete:true is accepted, complete:false is rejected (never a real marker)", () => {
    const acceptedTrue = clone(basePayload());
    acceptedTrue.complete = true;
    acceptedTrue.degrade = { more: true };
    expect(parseWtGraphPayload(acceptedTrue)).toEqual(acceptedTrue);

    const rejectedFalse = clone(basePayload());
    rejectedFalse.complete = false;
    rejectedFalse.degrade = { more: true };
    expect(parseWtGraphPayload(rejectedFalse)).toBeNull();
  });

  it("complete:false with a truly empty degrade object (no markers at all) is rejected", () => {
    const p = clone(basePayload());
    p.complete = false;
    p.degrade = {};
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// merged-plan r3 P0 (append-only extension; the legacy tests above are unchanged).
// ---------------------------------------------------------------------------

import { PROTO, WTGRAPH_MERGED_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import {
  WTGRAPH_CHERRY_MAX_BYTES,
  WTGRAPH_CHERRY_MS,
  WTGRAPH_MERGED_CLIENT_TIMEOUT_MS,
  WTGRAPH_MERGED_E_MAX,
  WTGRAPH_MERGED_MAX,
  WTGRAPH_MERGED_MAX_BYTES,
  WTGRAPH_MERGED_PHASE_MS,
  WTGRAPH_MERGED_QUERY,
  WTGRAPH_MERGED_TAIL_MS,
  type WtGraphMergedEntry,
  type WtGraphMergedSkip,
  type WtGraphMergedUnknown,
} from "../../../src/web-hub/protocol/worktree-graph.js";

const MERGED_SKIP_CASES: WtGraphMergedSkip[] = [
  "no-head",
  "shallow",
  "filter-config",
  "git-too-old",
  "attr-changed",
  "unconfirmed",
  "bytes",
];
const MERGED_UNKNOWN_CASES: WtGraphMergedUnknown[] = [
  "budget",
  "timeout",
  "too-many",
  "missing-object",
  "git-failed",
  "attr-changed",
];

function mergedPayload(
  entries: WtGraphMergedEntry[] = [{ n: "topic", h: H2, v: "part", k: 1, t: 2, e: [H2] }],
): WtGraphPayload {
  return {
    ...basePayload(),
    head: { h: H1, b: "main" },
    commits: genCommits(3),
    refs: [{ k: "branch", n: "main", h: H1 }, ...entries.map(({ n, h }) => ({ k: "branch" as const, n, h }))],
    merged: { v: 1, base: H1, branches: entries },
  };
}

function badMerged(patch: Record<string, unknown>): unknown {
  const p = mergedPayload();
  return { ...p, merged: { ...p.merged, ...patch } };
}

function badMergedEntry(patch: Record<string, unknown>): unknown {
  const p = mergedPayload();
  return { ...p, merged: { ...p.merged, branches: [{ ...p.merged!.branches[0], ...patch }] } };
}

function multiTipMerged(): WtGraphPayload {
  return mergedPayload([
    { n: "topic", h: H2, v: "part", k: 2, t: 3, e: [H2] },
    { n: "alias", h: H2, v: "part", k: 2, t: 3 },
  ]);
}

/** Uses the pre-extension parser's exact output property order, not the input's order. */
function legacyParsedBytes(p: WtGraphPayload): string {
  return JSON.stringify({
    v: 1,
    n: p.n,
    format: p.format,
    commits: p.commits,
    refs: p.refs,
    wtHeads: p.wtHeads,
    degrade: p.degrade,
    complete: p.complete,
    ...(p.shallow === true ? { shallow: true } : {}),
    ...(p.empty === true ? { empty: true } : {}),
    ...(p.head === undefined ? {} : { head: p.head }),
  });
}

describe("merged protocol — constants and independent budget ledger", () => {
  it("pins the optional query, cap, limits and unchanged PROTO", () => {
    expect(WTGRAPH_MERGED_QUERY).toBe("merged");
    expect(WTGRAPH_MERGED_HUB_CAP).toBe("wtgraph.merged.v1");
    expect(PROTO).toEqual({ major: 1, minor: 2 });
    expect(WTGRAPH_MERGED_MAX).toBe(24);
    expect(WTGRAPH_MERGED_E_MAX).toBe(200);
    expect(WTGRAPH_CHERRY_MS).toBe(2_000);
    expect(WTGRAPH_CHERRY_MAX_BYTES).toBe(64 * 1024);
    expect(WTGRAPH_MERGED_PHASE_MS).toBe(14_000);
    expect(WTGRAPH_MERGED_TAIL_MS).toBe(4_000);
    expect(WTGRAPH_MERGED_MAX_BYTES).toBe(32 * 1024);
    expect(WTGRAPH_MERGED_CLIENT_TIMEOUT_MS).toBe(48_000);
  });

  it("keeps old 23 / 33 ≤ 35 and adds 37 / 47 ≤ 48 using the actual shared constants", () => {
    const legacyServer = WTDIFF_ADMIT_MS + WTGRAPH_GIT_PHASE_MS + WTDIFF_CLOSE_MS;
    const mergedServer = legacyServer + WTGRAPH_MERGED_PHASE_MS;
    expect(legacyServer).toBe(23_000);
    expect(legacyServer + WTDIFF_TRANSFER_RESERVE_MS).toBe(33_000);
    expect(legacyServer + WTDIFF_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(WTGRAPH_CLIENT_TIMEOUT_MS);
    expect(WTGRAPH_CLIENT_TIMEOUT_MS).toBe(35_000);
    expect(mergedServer).toBe(37_000);
    expect(mergedServer + WTDIFF_TRANSFER_RESERVE_MS).toBe(47_000);
    expect(mergedServer + WTDIFF_TRANSFER_RESERVE_MS).toBeLessThanOrEqual(WTGRAPH_MERGED_CLIENT_TIMEOUT_MS);
  });

  it("accounts for 6s head + 4s tail: the 4s loop does not promise even one 8s worst-case candidate", () => {
    const head = 3 * WTDIFF_STEP_MS;
    const tail = 2 * WTDIFF_STEP_MS;
    const perCandidate = WTDIFF_STEP_MS + WTGRAPH_CHERRY_MS + 2 * WTDIFF_STEP_MS;
    expect(head).toBe(6_000);
    expect(tail).toBe(WTGRAPH_MERGED_TAIL_MS);
    const loop = WTGRAPH_MERGED_PHASE_MS - head - tail;
    expect(loop).toBe(4_000);
    expect(perCandidate).toBe(8_000);
    expect(Math.floor(loop / perCandidate)).toBe(0);
  });
});

describe("merged protocol — legacy bytes stay identical", () => {
  it.each(["minimal", "head+shallow", "empty", "degraded", "sha256"])("%s without merged", (shape) => {
    const p = basePayload();
    if (shape === "head+shallow") {
      p.head = { h: H1, b: "main" };
      p.shallow = true;
    }
    if (shape === "empty") {
      p.commits = [];
      p.empty = true;
    }
    if (shape === "degraded") {
      p.degrade = { more: true, refsOmitted: 2 };
      p.complete = false;
    }
    if (shape === "sha256") {
      p.format = "sha256";
      p.commits[0].h = "a".repeat(64);
      p.refs[0].h = "a".repeat(64);
      p.wtHeads[0].h = "a".repeat(64);
    }
    const before = JSON.stringify(p);
    const parsed = parseWtGraphPayload(p);
    expect(parsed).toEqual(p);
    expect(JSON.stringify(parsed)).toBe(legacyParsedBytes(p));
    expect(Object.hasOwn(parsed!, "merged")).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("does not add a merged:undefined own slot or adopt an inherited merged field", () => {
    const p = { ...basePayload(), merged: undefined };
    expect(JSON.stringify(parseWtGraphPayload(p))).toBe(legacyParsedBytes(p));
    Object.defineProperty(Object.prototype, "merged", { value: { invalid: true }, configurable: true });
    try {
      const parsed = parseWtGraphPayload(basePayload());
      expect(parsed).not.toBeNull();
      expect(Object.hasOwn(parsed!, "merged")).toBe(false);
      expect(JSON.stringify(parsed)).toBe(legacyParsedBytes(basePayload()));
    } finally {
      delete (Object.prototype as Record<string, unknown>).merged;
    }
  });
});

describe("merged protocol — accepted shapes", () => {
  it.each([
    { n: "topic", h: H2, v: "eq", k: 3, t: 3, co: true },
    { n: "topic", h: H2, v: "part", k: 1, t: 2, e: [H2], eP: true },
    { n: "topic", h: H2, v: "part", k: 1, t: 2, eP: true },
    { n: "topic", h: H2, v: "part", k: 1, t: 2, e: [] },
    { n: "topic", h: H2, v: "part", k: 1, t: 2 },
    { n: "topic", h: H2, v: "none", k: 0, t: 2 },
    { n: "topic", h: H2, v: "anc" },
  ] satisfies WtGraphMergedEntry[])("accepts $v (e=$e, eP=$eP)", (entry) => {
    const p = mergedPayload([entry]);
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it.each(MERGED_UNKNOWN_CASES)("accepts unk:%s", (why) => {
    const p = mergedPayload([{ n: "topic", h: H2, v: "unk", why }]);
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it.each([0, 1, 376])("accepts 24 entries and omitted overflow %i (24 / 25 / 400 candidates)", (omitted) => {
    const entries: WtGraphMergedEntry[] = Array.from({ length: 24 }, (_, i) => ({
      n: `topic-${i}`,
      h: H2,
      v: "eq",
      k: 1,
      t: 1,
    }));
    const p = mergedPayload(entries);
    if (omitted > 0) p.merged!.omitted = omitted;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  for (const withHead of [false, true]) {
    it.each(MERGED_SKIP_CASES)(`accepts skipped:%s, head/base ${withHead ? "present" : "absent"}`, (skipped) => {
      const p = mergedPayload([]);
      if (withHead) {
        p.merged!.skipped = skipped;
      } else {
        delete p.head;
        p.merged = { v: 1, skipped, branches: [] };
      }
      expect(parseWtGraphPayload(p)).toEqual(p);
    });
  }

  it("accepts no-head empty graph with the exact skipped wire shape", () => {
    const p: WtGraphPayload = {
      ...basePayload(),
      commits: [],
      refs: [],
      wtHeads: [],
      empty: true,
      merged: { v: 1, skipped: "no-head", branches: [] },
    };
    expect(parseWtGraphPayload(p)).toEqual(p);
    expect(Object.keys(parseWtGraphPayload(p)!.merged!)).toEqual(["v", "branches", "skipped"]);
  });

  it("accepts same-tip e only on its first entry, including partial e on both entries", () => {
    const p = multiTipMerged();
    p.merged!.branches[0].eP = true;
    p.merged!.branches[1].eP = true;
    expect(parseWtGraphPayload(p)).toEqual(p);
    const before = JSON.stringify(p);
    const parsed = parseWtGraphPayload(p)!;
    expect(parsed.merged).not.toBe(p.merged);
    expect(parsed.merged!.branches[0].e).not.toBe(p.merged!.branches[0].e);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("accepts format-matching sha256 metadata", () => {
    const h = "a".repeat(64);
    const p = mergedPayload([{ n: "topic", h, v: "part", k: 1, t: 2, e: [h] }]);
    p.format = "sha256";
    p.head = { h };
    p.commits = [{ h, p: [], a: "A", t: 1, s: "s" }];
    p.refs = [{ k: "branch", n: "topic", h }];
    p.wtHeads = [];
    p.merged!.base = h;
    expect(parseWtGraphPayload(p)).toEqual(p);
  });

  it("accepts the maximum cherry-output-derived t and rejects its next integer", () => {
    const max = Math.floor(WTGRAPH_CHERRY_MAX_BYTES / 41);
    const p = mergedPayload([{ n: "topic", h: H2, v: "eq", k: max, t: max }]);
    expect(parseWtGraphPayload(p)).toEqual(p);
    p.merged!.branches[0].k = max + 1;
    p.merged!.branches[0].t = max + 1;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("accepts 200 e oids globally; rejects 201 even when each entry is individually under its k", () => {
    const p = mergedPayload([
      { n: "one", h: H2, v: "part", k: 150, t: 151, e: genCommits(150).map((c) => c.h) },
      { n: "two", h: H3, v: "part", k: 51, t: 52, e: genCommits(50).map((c) => c.h) },
    ]);
    p.commits = genCommits(200);
    expect(parseWtGraphPayload(p)).toEqual(p);
    p.merged!.branches[1].e!.push(hex(50));
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it("24 sha256 part refs with 200 total e oids fit the reserved 32KiB, and the existing 512KiB cap is not raised", () => {
    const oid = (i: number): string => hex(i).padStart(64, "0");
    const entries: WtGraphMergedEntry[] = Array.from({ length: 24 }, (_, i) => ({
      n: `${i}`.padEnd(200, "x"),
      h: oid(i),
      v: "part",
      k: 200,
      t: 201,
      ...(i === 0 ? { e: Array.from({ length: 200 }, (_, j) => oid(j)) } : { eP: true as const }),
    }));
    const p = mergedPayload(entries);
    p.format = "sha256";
    p.head = { h: oid(199) };
    p.merged!.base = p.head.h;
    p.wtHeads = [];
    p.commits = genCommits(200).map((c, i) => ({ ...c, h: oid(i) }));
    p.refs = entries.map(({ n, h }) => ({ k: "branch", n, h }));
    expect(parseWtGraphPayload(p)).toEqual(p);
    const extensionBytes = byteLen(JSON.stringify(p.merged));
    expect(extensionBytes).toBeLessThan(WTGRAPH_MERGED_MAX_BYTES);
    const reservedBase = WTGRAPH_BODY_MAX_BYTES - WTGRAPH_MERGED_MAX_BYTES;
    expect(reservedBase).toBe(491_520);
    expect(reservedBase + extensionBytes + byteLen(',"merged":')).toBeLessThanOrEqual(WTGRAPH_BODY_MAX_BYTES);
  });
});

describe("merged protocol — rejects malformed envelopes and cross-fields", () => {
  it.each([null, [], "x", 1, true, new Date()])("rejects merged=%p", (bad) => {
    expect(parseWtGraphPayload({ ...basePayload(), merged: bad })).toBeNull();
  });

  it.each([undefined, 0, 2, "1", null])("rejects merged.v=%p", (v) => {
    expect(parseWtGraphPayload(badMerged({ v }))).toBeNull();
  });

  it("rejects unknown keys in merged and entry, including non-enumerable keys", () => {
    expect(parseWtGraphPayload(badMerged({ extra: 1 }))).toBeNull();
    expect(parseWtGraphPayload(badMergedEntry({ extra: 1 }))).toBeNull();
    const p = mergedPayload();
    Object.defineProperty(p.merged!, "extra", { value: 1, enumerable: false });
    expect(parseWtGraphPayload(p)).toBeNull();
    const q = mergedPayload();
    Object.defineProperty(q.merged!.branches[0], "extra", { value: 1, enumerable: false });
    expect(parseWtGraphPayload(q)).toBeNull();
  });

  it.each([undefined, H2, "a".repeat(64), H1.toUpperCase().replace(/1$/, "A"), null])(
    "rejects base=%p when head exists",
    (base) => {
      expect(parseWtGraphPayload(badMerged({ base }))).toBeNull();
    },
  );

  it("rejects base without head", () => {
    const p = mergedPayload([]);
    delete p.head;
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([null, undefined, {}, true, "x"])("rejects branches=%p", (branches) => {
    expect(parseWtGraphPayload(badMerged({ branches }))).toBeNull();
  });

  it("rejects 25 entries even when all refs exist and all names are unique", () => {
    const p = mergedPayload(Array.from({ length: 25 }, (_, i) => ({ n: `b${i}`, h: H2, v: "eq", k: 1, t: 1 })));
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([0, -1, 0.5, "1", null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("rejects omitted=%p", (omitted) => {
    expect(parseWtGraphPayload(badMerged({ omitted }))).toBeNull();
  });

  it.each(["unknown", "", null, true, 1])("rejects skipped=%p", (skipped) => {
    expect(parseWtGraphPayload(badMerged({ skipped, branches: [] }))).toBeNull();
  });

  it.each(MERGED_SKIP_CASES)("rejects skipped:%s with entries", (skipped) => {
    expect(parseWtGraphPayload(badMerged({ skipped }))).toBeNull();
  });

  it("rejects an omitted count on the fixed skipped wire shape", () => {
    expect(parseWtGraphPayload(badMerged({ skipped: "bytes", branches: [], omitted: 1 }))).toBeNull();
  });
});

describe("merged protocol — rejects malformed entries and all §6 consistency violations", () => {
  it.each([null, [], "x", 1, true])("rejects branch entry=%p", (entry) => {
    expect(parseWtGraphPayload(badMerged({ branches: [entry] }))).toBeNull();
  });

  it.each([undefined, "", null, 1, "x".repeat(201), "α".repeat(101)])("rejects entry.n=%p", (n) => {
    expect(parseWtGraphPayload(badMergedEntry({ n }))).toBeNull();
  });

  it.each([undefined, null, "a".repeat(64), "A".repeat(40), "g".repeat(40)])("rejects entry.h=%p", (h) => {
    expect(parseWtGraphPayload(badMergedEntry({ h }))).toBeNull();
  });

  it("rejects nonexistent branch, wrong tip and a remote/tag in place of the matching branch", () => {
    expect(parseWtGraphPayload(badMergedEntry({ n: "absent" }))).toBeNull();
    expect(parseWtGraphPayload(badMergedEntry({ h: H3 }))).toBeNull();
    for (const k of ["remote", "tag"] as const) {
      const p = mergedPayload();
      p.refs[1].k = k;
      expect(parseWtGraphPayload(p)).toBeNull();
    }
  });

  it("rejects duplicate branch names even when their refs have different tips", () => {
    const p = mergedPayload([
      { n: "topic", h: H2, v: "anc" },
      { n: "topic", h: H3, v: "anc" },
    ]);
    expect(parseWtGraphPayload(p)).toBeNull();
  });

  it.each([undefined, "merged", "", 1, null])("rejects entry.v=%p", (v) => {
    expect(parseWtGraphPayload(badMergedEntry({ v }))).toBeNull();
  });

  for (const field of ["co", "eP"] as const) {
    it.each([false, 1, "true", null])(`rejects ${field}=%p (true-only)`, (value) => {
      expect(parseWtGraphPayload(badMergedEntry({ [field]: value }))).toBeNull();
    });
  }

  for (const v of ["eq", "part", "none"] as const) {
    for (const field of ["k", "t"] as const) {
      it.each([undefined, -1, 0.5, "1", null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
        `rejects ${v}.${field}=%p`,
        (value) => {
          const valid = v === "eq" ? { k: 1, t: 1 } : v === "none" ? { k: 0, t: 1 } : { k: 1, t: 2 };
          expect(parseWtGraphPayload(badMergedEntry({ v, ...valid, e: undefined, [field]: value }))).toBeNull();
        },
      );
    }
    it(`rejects ${v} with t above the cherry byte-derived maximum`, () => {
      const t = Math.floor(WTGRAPH_CHERRY_MAX_BYTES / 41) + 1;
      expect(
        parseWtGraphPayload(badMergedEntry({ v, k: v === "eq" ? t : v === "part" ? 1 : 0, t, e: undefined })),
      ).toBeNull();
    });
  }

  it.each([
    { v: "eq", k: 0, t: 0 },
    { v: "eq", k: 0, t: 1 },
    { v: "eq", k: 1, t: 2 },
    { v: "eq", k: 2, t: 1 },
    { v: "part", k: 0, t: 2 },
    { v: "part", k: 2, t: 2 },
    { v: "part", k: 3, t: 2 },
    { v: "part", k: 1, t: 0 },
    { v: "none", k: 1, t: 2 },
    { v: "none", k: 0, t: 0 },
  ])("rejects inconsistent $v k=$k t=$t", (fields) => {
    expect(parseWtGraphPayload(badMergedEntry({ ...fields, e: undefined }))).toBeNull();
  });

  for (const v of ["anc", "unk"] as const) {
    for (const [field, value] of [
      ["k", 0],
      ["t", 1],
      ["e", []],
      ["eP", true],
    ] as const) {
      it(`rejects ${field} on ${v}`, () => {
        expect(
          parseWtGraphPayload(
            badMergedEntry({
              v,
              k: undefined,
              t: undefined,
              e: undefined,
              ...(v === "unk" ? { why: "timeout" } : {}),
              [field]: value,
            }),
          ),
        ).toBeNull();
      });
    }
  }

  for (const v of ["eq", "none"] as const) {
    for (const [field, value] of [
      ["e", []],
      ["eP", true],
    ] as const) {
      it(`rejects ${field} on ${v}`, () => {
        expect(
          parseWtGraphPayload(badMergedEntry({ v, k: v === "eq" ? 2 : 0, e: undefined, [field]: value })),
        ).toBeNull();
      });
    }
  }

  it.each([undefined, "unknown", "", null, 1, true])("rejects unk.why=%p", (why) => {
    expect(parseWtGraphPayload(badMergedEntry({ v: "unk", k: undefined, t: undefined, e: undefined, why }))).toBeNull();
  });

  it.each(["eq", "part", "none", "anc"])("rejects why on %s", (v) => {
    expect(
      parseWtGraphPayload(
        badMergedEntry({
          v,
          k: v === "anc" ? undefined : v === "none" ? 0 : 1,
          t: v === "anc" ? undefined : v === "eq" ? 1 : 2,
          e: undefined,
          why: "timeout",
        }),
      ),
    ).toBeNull();
  });

  it.each([null, {}, "x", 1, [H2, H3], [hex(999)], ["a".repeat(64)], ["A".repeat(40)]])(
    "rejects malformed / out-of-window / over-k e=%p",
    (e) => {
      expect(parseWtGraphPayload(badMergedEntry({ e }))).toBeNull();
    },
  );

  it("rejects duplicate e oids even when |e| ≤ k", () => {
    expect(parseWtGraphPayload(badMergedEntry({ k: 2, t: 3, e: [H2, H2] }))).toBeNull();
  });

  it("rejects e on a later same-tip entry even if the first entry has no e", () => {
    for (const firstHasE of [false, true]) {
      const p = multiTipMerged();
      if (!firstHasE) delete p.merged!.branches[0].e;
      p.merged!.branches[1].e = [];
      expect(parseWtGraphPayload(p)).toBeNull();
    }
  });

  it.each([{ v: "none", k: 0, t: 3 }, { k: 1 }, { t: 4 }])("rejects inconsistent same-tip v/k/t %p", (patch) => {
    const p = multiTipMerged();
    Object.assign(p.merged!.branches[1], patch);
    expect(parseWtGraphPayload(p)).toBeNull();
  });
});

describe("merged protocol — preserves defensive own-field/plain-object semantics", () => {
  for (const level of ["merged", "entry"] as const) {
    it.each(["__proto__", "constructor"] as const)(`rejects genuine own %s on ${level}`, (key) => {
      const p = mergedPayload();
      if (level === "merged") p.merged = withDangerousOwnKey(p.merged!, key, {});
      else p.merged!.branches[0] = withDangerousOwnKey(p.merged!.branches[0], key, {});
      expect(parseWtGraphPayload(p)).toBeNull();
    });

    it(`rejects exotic prototype on ${level}`, () => {
      const p = mergedPayload();
      Object.setPrototypeOf(level === "merged" ? p.merged : p.merged!.branches[0], { v: 1 });
      expect(parseWtGraphPayload(p)).toBeNull();
    });

    it(`rejects throwing getters on ${level} through the existing catch`, () => {
      const p = mergedPayload();
      Object.defineProperty(level === "merged" ? p.merged : p.merged!.branches[0], "v", {
        get() {
          throw new Error("getter");
        },
      });
      expect(parseWtGraphPayload(p)).toBeNull();
    });
  }

  it("ignores inherited optional flags and rejects inherited required fields", () => {
    Object.defineProperties(Object.prototype, {
      co: { value: true, configurable: true },
      why: { value: "timeout", configurable: true },
    });
    try {
      const p = mergedPayload();
      const parsed = parseWtGraphPayload(p);
      expect(parsed).toEqual(p);
      expect(Object.hasOwn(parsed!.merged!.branches[0], "co")).toBe(false);
      const unk = mergedPayload([{ n: "topic", h: H2, v: "unk" }]);
      expect(parseWtGraphPayload(unk)).toBeNull();
    } finally {
      delete (Object.prototype as Record<string, unknown>).co;
      delete (Object.prototype as Record<string, unknown>).why;
    }
  });

  it("accepts null-prototype merged data objects", () => {
    const p = mergedPayload();
    Object.setPrototypeOf(p.merged!, null);
    Object.setPrototypeOf(p.merged!.branches[0], null);
    expect(parseWtGraphPayload(p)).toEqual(p);
  });
});
