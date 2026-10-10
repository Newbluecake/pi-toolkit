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
