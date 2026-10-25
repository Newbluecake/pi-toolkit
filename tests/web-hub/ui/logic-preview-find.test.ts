/**
 * `@logic/previewFind.ts` (preview-perf plan r3 §4.6, P1) — the case fold, the greedy
 * non-overlapping reference search, and the incremental engine's carry/resume protocol.
 *
 * The centrepiece is the r3 differential property test (§6.3): a random text over an
 * alphabet with `Σ`/`İ`, astral pairs and LONE surrogates, split at arbitrary cut points
 * (allowed to fall inside a surrogate pair), searched incrementally after every append —
 * each step must equal a full greedy search over the STABLE prefix, and after `flush()` a
 * full search over the whole text. Plus the r3 fixed counter-examples (`aaaa`+`a` / q=`aa`
 * ⇒ `[0,2]`, `aaa`+`a` ⇒ `[0,2]`, the cross-boundary surrogate pair) and the FIND_MAX cap /
 * current-hit-keeping rules.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createPreviewFinder,
  findAll,
  foldSameLength,
  type PreviewFinder,
} from "../../../src/web-hub/ui/src/logic/previewFind.js";
import { FIND_MAX } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

const HIGH = "\ud801"; // lone high surrogate
const LOW = "\udc00"; // lone low surrogate
const ASTRAL_A = "\ud801\udc00"; // 𐐀 (Deseret capital long I)
const ASTRAL_a = "\ud801\udc28"; // 𐐨 (its lowercase)

describe("foldSameLength (§4.6 length-preserving fold)", () => {
  it("is length-preserving for arbitrary unicode strings", () => {
    const arbText = fc
      .string({ unit: "binary", minLength: 0, maxLength: 64 })
      .chain((ascii) =>
        fc.constantFrom("İ", "Σ", "ẞ", ASTRAL_A, ASTRAL_a, HIGH, LOW, "中", "ß", "ﬁ").map((x) => ascii + x),
      );
    fc.assert(
      fc.property(fc.array(arbText, { maxLength: 12 }), (pieces) => {
        const s = pieces.join("");
        return foldSameLength(s).length === s.length;
      }),
      { numRuns: 300 },
    );
  });

  it("folds 1:1 code points and keeps length-changing mappings verbatim", () => {
    expect(foldSameLength("ABC xyz")).toBe("abc xyz");
    expect(foldSameLength("ΣΣΣ")).toBe("σσσ"); // Σ→σ, same length, context-free
    expect(foldSameLength("ẞ")).toBe("ß"); // 1:1 lowercase mapping folds
    expect(foldSameLength("İ")).toBe("İ"); // İ → "i̇" (2 units) ⇒ kept verbatim
    expect(foldSameLength("Iİ")).toBe("iİ");
    expect(foldSameLength(ASTRAL_A)).toBe(ASTRAL_a); // astral pair folds as ONE code point
    expect(foldSameLength("𝐀")).toBe("𝐀"); // U+1D400 → "a" (length change) ⇒ kept
    expect(foldSameLength(HIGH)).toBe(HIGH); // lone surrogates pass through
    expect(foldSameLength(LOW)).toBe(LOW);
    expect(foldSameLength("")).toBe("");
  });

  it("pure-ASCII folding matches toLowerCase", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-ascii", minLength: 0, maxLength: 128 }), (s) => {
        expect(foldSameLength(s)).toBe(s.toLowerCase());
      }),
      { numRuns: 200 },
    );
  });
});

describe("findAll (greedy non-overlapping reference, §4.6)", () => {
  it("collects the leftmost non-overlapping sequence", () => {
    expect(findAll("aXaXa", "a").hits).toEqual([0, 2, 4]);
    expect(findAll("aaaa", "aa").hits).toEqual([0, 2]); // greedy, no overlap
    expect(findAll("aaa", "aa").hits).toEqual([0]);
    expect(findAll("abc", "z").hits).toEqual([]);
    expect(findAll("abc", "")).toEqual({ hits: [], more: false }); // empty query ⇒ no hits
    expect(findAll("abc", "abcdef")).toEqual({ hits: [], more: false });
  });

  it("respects the end bound (hits must end within it)", () => {
    expect(findAll("aXaXa", "a", 3).hits).toEqual([0, 2]);
    expect(findAll("aaa", "aa", 2).hits).toEqual([0]); // [1,3) would end past the bound
    expect(findAll("aaa", "aa", 1).hits).toEqual([]);
  });

  it("caps at FIND_MAX with exactly one more-probe", () => {
    const q = "ab";
    const text = q.repeat(FIND_MAX + 2); // FIND_MAX+2 greedy hits available
    const r = findAll(text, q);
    expect(r.hits).toHaveLength(FIND_MAX);
    expect(r.hits[0]).toBe(0);
    expect(r.hits[FIND_MAX - 1]).toBe((FIND_MAX - 1) * 2);
    expect(r.more).toBe(true);
    // probe respects the end bound: no full hit past it ⇒ more false
    expect(findAll(text, q, FIND_MAX * 2).more).toBe(false);
    // exactly FIND_MAX available ⇒ capped but nothing more
    const exact = findAll(q.repeat(FIND_MAX), q);
    expect(exact.hits).toHaveLength(FIND_MAX);
    expect(exact.more).toBe(false);
  });
});

describe("createPreviewFinder — fixed counter-examples (§4.6 r3 / §6.3)", () => {
  it("aaaa + append 'a' with q='aa' ⇒ [0,2] (the r2 formula's overlap bug)", () => {
    const f = createPreviewFinder();
    f.search("aa", false, "aaaa");
    expect(f.hits).toEqual([0, 2]);
    f.append("aaaaa");
    expect(f.hits).toEqual([0, 2]); // resume = max(stable 4−2+1, lastKept.end 4) = 4 ⇒ nothing
  });

  it("aaa + append 'a' with q='aa' ⇒ [0,2]", () => {
    const f = createPreviewFinder();
    f.search("aa", false, "aaa");
    expect(f.hits).toEqual([0]);
    f.append("aaaa");
    expect(f.hits).toEqual([0, 2]);
  });

  it("surrogate pair split across the append boundary (insensitive): x+D801 | DC00+y, q=𐐨 ⇒ [1]", () => {
    const f = createPreviewFinder();
    f.search(ASTRAL_a, false, `x${HIGH}`);
    expect(f.stableLen).toBe(1); // trailing lone high surrogate not folded yet
    expect(f.hits).toEqual([]); // and no hit may end past the stable boundary
    const r = f.append(`x${HIGH}${LOW}y`);
    expect(r.hits).toEqual([1]); // the pair folds as one code point, offset 1 in the RAW text
    expect(f.stableLen).toBe(4);
  });

  it("carry: appending only the low surrogate folds the pending pair", () => {
    const f = createPreviewFinder();
    f.search(ASTRAL_a, false, `a${HIGH}`);
    expect(f.stableLen).toBe(1);
    f.append(`a${HIGH}${LOW}`);
    expect(f.stableLen).toBe(3);
    expect(f.hits).toEqual([1]);
  });
});

describe("createPreviewFinder — incremental ≡ full search (differential property, r3 §6.3)", () => {
  // Alphabet: a, b, Σ, İ, 𐐀 (D801 DC00), 𐐨, lone D801, lone DC00 (+ A for ASCII folding)
  const ALPHABET = ["a", "b", "A", "Σ", "İ", ASTRAL_A, ASTRAL_a, HIGH, LOW];

  const arbSymbol = fc.constantFrom(...ALPHABET);
  const arbText = fc.array(arbSymbol, { maxLength: 70 }).map((syms) => syms.join(""));
  const arbQuery = fc.array(arbSymbol, { maxLength: 4 }).map((syms) => syms.join("").slice(0, 3)); // 1–3 CODE UNITS (may cut a surrogate)
  const arbCaseMode = fc.constantFrom(true, false);

  /** Split points: 1–8 appends, cut anywhere (surrogate pairs included). */
  const arbSplits = fc
    .uniqueArray(fc.nat({ max: 500 }), { minLength: 1, maxLength: 8 })
    .map((ns) => [...ns].sort((x, y) => x - y));

  const haystackOf = (text: string, caseSensitive: boolean): string => (caseSensitive ? text : foldSameLength(text));

  const fullOnStable = (f: PreviewFinder, text: string, caseSensitive: boolean, q: string) =>
    findAll(haystackOf(text, caseSensitive), caseSensitive ? q : foldSameLength(q), f.stableLen);

  it("every append equals a full greedy search over the stable prefix; flush ⇒ over the full text", () => {
    fc.assert(
      fc.property(arbText, arbQuery, arbCaseMode, arbSplits, (text, q, caseSensitive, cuts) => {
        const points = [...new Set(cuts.filter((c) => c > 0 && c < text.length))].sort((x, y) => x - y);
        const bounds = [0, ...points, text.length];
        const f = createPreviewFinder();
        const first = text.slice(0, bounds[1] as number);
        f.search(q, caseSensitive, first);
        const firstFull = fullOnStable(f, first, caseSensitive, q);
        expect({ hits: [...f.hits], more: f.more }).toEqual({ hits: firstFull.hits, more: firstFull.more });
        for (let i = 1; i + 1 < bounds.length; i++) {
          const loaded = text.slice(0, bounds[i + 1] as number);
          f.append(loaded);
          expect(f.stableLen).toBe(stableExpect(loaded, caseSensitive));
          const full = fullOnStable(f, loaded, caseSensitive, q);
          expect({ hits: [...f.hits], more: f.more }).toEqual({ hits: full.hits, more: full.more });
        }
        f.flush();
        expect(f.stableLen).toBe(text.length);
        const full = findAll(haystackOf(text, caseSensitive), caseSensitive ? q : foldSameLength(q));
        expect({ hits: [...f.hits], more: f.more }).toEqual({ hits: full.hits, more: full.more });
      }),
      { numRuns: 250 },
    );
  });

  /** Stable length oracle: a trailing lone high surrogate defers (insensitive mode only). */
  function stableExpect(text: string, caseSensitive: boolean): number {
    if (caseSensitive) return text.length;
    const len = text.length;
    const last = len > 0 ? (text.charCodeAt(len - 1) as number) : 0;
    return len > 0 && last >= 0xd800 && last <= 0xdbff ? len - 1 : len;
  }

  it("case-mode switch mid-stream re-folds and matches a fresh engine", () => {
    fc.assert(
      fc.property(arbText, arbQuery, arbSplits, (text, q, cuts) => {
        const points = [...new Set(cuts.filter((c) => c > 0 && c < text.length))].sort((x, y) => x - y);
        const bounds = [0, ...points, text.length];
        const f = createPreviewFinder();
        const first = text.slice(0, bounds[1] as number);
        f.search(q, true, first);
        f.search(q, false, first); // mode switch on the same text ⇒ full re-fold path
        let step = 0;
        for (let i = 1; i + 1 < bounds.length; i++) {
          const loaded = text.slice(0, bounds[i + 1] as number);
          f.append(loaded); // insensitive incremental carry
          if (step++ === 1) {
            f.search(q, true, loaded); // same text + same mode ⇒ fold-reuse path
            const fullCs = findAll(loaded, q, f.stableLen);
            expect({ hits: [...f.hits], more: f.more }).toEqual({ hits: fullCs.hits, more: fullCs.more });
            f.search(q, false, loaded); // and back ⇒ re-fold again
          }
          const full = fullOnStable(f, loaded, false, q);
          expect({ hits: [...f.hits], more: f.more }).toEqual({ hits: full.hits, more: full.more });
        }
        const fresh = createPreviewFinder();
        fresh.search(q, false, text);
        f.flush();
        fresh.flush();
        expect([...f.hits]).toEqual([...fresh.hits]);
      }),
      { numRuns: 120 },
    );
  });
});

describe("createPreviewFinder — FIND_MAX cap on the incremental path", () => {
  it("keeps the first 10 000 greedy hits across appends; the probe tracks new range", () => {
    const q = "ab";
    const f = createPreviewFinder();
    f.search(q, false, q.repeat(FIND_MAX)); // exactly FIND_MAX hits, nothing more
    expect(f.hits).toHaveLength(FIND_MAX);
    expect(f.more).toBe(false);
    f.append(q.repeat(FIND_MAX + 3)); // +3 more hits past the cap
    expect(f.hits).toHaveLength(FIND_MAX);
    expect(f.hits[FIND_MAX - 1]).toBe((FIND_MAX - 1) * 2);
    expect(f.more).toBe(true);
    f.flush();
    expect(f.hits).toHaveLength(FIND_MAX); // full ⇒ no re-search, probe only
    expect(f.more).toBe(true);
  });

  it("hits collected incrementally equal the capped full search", () => {
    const q = "zq";
    const text = q.repeat(FIND_MAX + 1);
    const f = createPreviewFinder();
    f.search(q, true, text.slice(0, 15002));
    for (const cut of [16000, 18000, 19500, text.length]) f.append(text.slice(0, cut));
    expect([...f.hits]).toEqual(findAll(text, q).hits);
    expect(f.more).toBe(findAll(text, q).more);
  });
});

describe("createPreviewFinder — current-hit keeping (§4.6 当前项保持)", () => {
  it("keeps the anchor offset (and index) across appends", () => {
    const f = createPreviewFinder();
    f.search("ab", false, "ab-ab-ab");
    f.setCurrent(6);
    expect(f.currentIndex()).toBe(2);
    f.append("ab-ab-ab-ab"); // append takes the new FULL text
    expect(f.hits).toEqual([0, 3, 6, 9]);
    expect(f.currentStart).toBe(6);
    expect(f.currentIndex()).toBe(2); // kept hit ⇒ index unchanged
  });

  it("resolves an anchor past the last hit to the last hit; between hits to the first ≥", () => {
    const f = createPreviewFinder();
    f.search("ab", false, "ab-ab-ab");
    f.setCurrent(4);
    expect(f.currentIndex()).toBe(2); // first hit with start ≥ 4 is the one at 6
    f.setCurrent(99);
    expect(f.currentIndex()).toBe(2); // none ≥ ⇒ last
    f.setCurrent(-1);
    expect(f.currentIndex()).toBe(0);
  });

  it("empty query / no hits ⇒ index −1", () => {
    const f = createPreviewFinder();
    expect(f.currentIndex()).toBe(-1);
    f.search("zz", false, "abc");
    expect(f.currentIndex()).toBe(-1);
    expect(f.query).toBe("zz");
    expect(f.stableLen).toBe(3);
  });
});

describe("createPreviewFinder — contract guards", () => {
  it("appending a non-prefix text throws in dev (vitest) instead of corrupting", () => {
    const f = createPreviewFinder();
    f.search("ab", false, "abXab");
    expect(() => f.append("zzzabXab")).toThrowError(/prefix/);
    expect(() => f.append("abYcd")).toThrowError(/prefix/); // same length class, not a prefix
  });

  it("no-op appends return the same state", () => {
    const f = createPreviewFinder();
    const r1 = f.search("a", false, "aaa");
    const r2 = f.append("aaa");
    expect(r2).toEqual(r1);
  });
});
