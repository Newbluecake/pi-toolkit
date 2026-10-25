/**
 * `@logic/previewVirtual.ts` (preview-perf plan r3 §4.1/§4.3/§4.5, P1) — the renderer
 * decision table (incl. the kill-switch-off r0 delegation), the virtual window computation
 * (overscan, half-block hysteresis, selection grow-only retention + 2048-line cap), the
 * line-count ceiling and the row-height scroll re-anchoring. Pure functions, injected
 * measurements — no DOM.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chooseSourceRenderer,
  computeWindow,
  maxLines,
  reanchor,
  type ComputeWindowInput,
} from "../../../src/web-hub/ui/src/logic/previewVirtual.js";
import { PREVIEW_NUMBERED_LINES_MAX } from "../../../src/web-hub/ui/src/logic/previewLines.js";
import {
  PREVIEW_VIRTUAL_ENABLED,
  PREVIEW_VIRTUAL_MIN_LINES,
  VIRTUAL_MAX_LINES,
  VIRTUAL_SELECTION_MAX_LINES,
} from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

describe("chooseSourceRenderer — full §4.1 table", () => {
  const base = { fullView: false, stream: false, lineCount: 10 } as const;

  it("virtualEnabled=false delegates to r0 exactly (§4.1 row 1, §R2 #4)", () => {
    const off = { virtualEnabled: false };
    // 行号关 ⇒ legacy, stream or not
    expect(chooseSourceRenderer({ ...base, lineNumbers: false }, off)).toBe("legacy");
    expect(chooseSourceRenderer({ ...base, lineNumbers: false, stream: true }, off)).toBe("legacy");
    // 行号开、非流式 ≤8000 ⇒ NumberedCode; >8000 ⇒ HighlightedCode + linesTooMany
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 8000 }, off)).toBe("numbered");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: PREVIEW_NUMBERED_LINES_MAX }, off)).toBe(
      "numbered",
    );
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 8001 }, off)).toBe("numbered-capped");
    // 行号开、流式 ⇒ 每段一个 CodeLines（累计 8000 降级由 P3 的 syncLineSegs 持有）
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, stream: true, lineCount: 99999 }, off)).toBe(
      "stream-lines",
    );
    // full view ⇒ same DOM as line numbers off, in either mode (§4.7)
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, fullView: true }, off)).toBe("legacy");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, fullView: true, lineCount: 9000 }, off)).toBe("legacy");
  });

  it("default options follow the build-time PREVIEW_VIRTUAL_ENABLED=true branch", () => {
    expect(PREVIEW_VIRTUAL_ENABLED).toBe(true); // the production default the table runs on
    expect(chooseSourceRenderer({ ...base, lineNumbers: false })).toBe("legacy");
    expect(chooseSourceRenderer({ ...base, lineNumbers: false, stream: true })).toBe("legacy");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, fullView: true, lineCount: 99999 })).toBe("legacy");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 0 })).toBe("numbered");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: PREVIEW_VIRTUAL_MIN_LINES })).toBe("numbered");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: PREVIEW_VIRTUAL_MIN_LINES + 1 })).toBe(
      "virtual",
    );
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 8001 })).toBe("virtual"); // 8000-cap unreachable
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, stream: true, lineCount: 5 })).toBe("virtual"); // streams always
  });

  it("virtualEnabled=true explicit matches the default", () => {
    const on = { virtualEnabled: true };
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 601 }, on)).toBe("virtual");
    expect(chooseSourceRenderer({ ...base, lineNumbers: true, lineCount: 600 }, on)).toBe("numbered");
  });
});

describe("computeWindow — basic geometry (§4.5)", () => {
  // 1000 lines × 10px; 20 visible lines; overscan 1 screen = 20 lines; blocks of 32.
  const input = (over: Partial<ComputeWindowInput>): ComputeWindowInput => ({
    scrollTop: 0,
    viewportH: 200,
    rowH: 10,
    lineCount: 1000,
    overscan: 1,
    retain: null,
    ...over,
  });

  it("top / middle / bottom / viewport-larger-than-text", () => {
    expect(computeWindow(input({ scrollTop: 0 }))).toEqual({ lo: 0, hi: 1, capped: false });
    expect(computeWindow(input({ scrollTop: 5000 }))).toEqual({ lo: 15, hi: 16, capped: false });
    expect(computeWindow(input({ scrollTop: 9800 }))).toEqual({ lo: 30, hi: 31, capped: false });
    expect(computeWindow(input({ viewportH: 20000 }))).toEqual({ lo: 0, hi: 31, capped: false });
    expect(computeWindow(input({ lineCount: 32 }))).toEqual({ lo: 0, hi: 0, capped: false });
  });

  it("empty body / unusable geometry ⇒ the empty window", () => {
    const empty = { lo: 0, hi: -1, capped: false };
    expect(computeWindow(input({ lineCount: 0 }))).toEqual(empty);
    expect(computeWindow(input({ rowH: 0 }))).toEqual(empty);
    expect(computeWindow(input({ viewportH: 0 }))).toEqual(empty);
    expect(computeWindow(input({ scrollTop: Number.NaN }))).toEqual(empty);
  });

  it("never mounts past the last block; scrollTop clamps at 0", () => {
    expect(computeWindow(input({ scrollTop: -500 }))).toEqual({ lo: 0, hi: 1, capped: false });
    expect(computeWindow(input({ lineCount: 40, scrollTop: 10000 }))).toEqual({ lo: 1, hi: 1, capped: false });
  });
});

describe("computeWindow — half-block hysteresis (§4.5 滞回)", () => {
  // overscan 0, 10 visible lines, so the target edges track the viewport exactly.
  const input = (over: Partial<ComputeWindowInput>): ComputeWindowInput => ({
    scrollTop: 0,
    viewportH: 100,
    rowH: 10,
    lineCount: 1000,
    overscan: 0,
    retain: null,
    ...over,
  });

  it("scrolling down: a block shrinks away only half a block(+1) past the pure flip", () => {
    // pure flip (no retain): first line 32 ⇒ top block 1
    expect(computeWindow(input({ scrollTop: 320 }))).toMatchObject({ lo: 1 });
    // with block 0 previously mounted it SURVIVES until first line 49 (0 + 32 + 16 + 1)
    expect(computeWindow(input({ scrollTop: 320, retain: { lo: 0, hi: 3 } }))).toMatchObject({ lo: 0 });
    expect(computeWindow(input({ scrollTop: 480, retain: { lo: 0, hi: 3 } }))).toMatchObject({ lo: 0 });
    expect(computeWindow(input({ scrollTop: 490, retain: { lo: 0, hi: 3 } }))).toMatchObject({ lo: 1 });
  });

  it("scrolling up: growth is immediate — no hysteresis band on the way back", () => {
    expect(computeWindow(input({ scrollTop: 310, retain: { lo: 1, hi: 3 } }))).toMatchObject({ lo: 0 });
    expect(computeWindow(input({ scrollTop: 310 }))).toMatchObject({ lo: 0 });
  });

  it("the bottom edge lags on the way up the same way", () => {
    // pure target at scrollTop 200: last line 29 ⇒ bottom block 0; block 1 (rHi 63) is kept
    // while last ≥ 63 − 48 = 15
    expect(computeWindow(input({ scrollTop: 200, retain: { lo: 0, hi: 1 } }))).toMatchObject({ hi: 1 });
    expect(computeWindow(input({ scrollTop: 200 }))).toMatchObject({ hi: 0 });
    expect(computeWindow(input({ scrollTop: 0, retain: { lo: 0, hi: 1 } }))).toMatchObject({ hi: 0 });
  });

  it("property: the window always contains the target and extends it by ≤1 block per edge", () => {
    const target = (i: ComputeWindowInput) => computeWindow({ ...i, retain: null });
    fc.assert(
      fc.property(
        fc.nat({ max: 9999 }),
        fc.nat({ max: 100 }),
        fc.nat({ max: 40 }),
        fc.option(fc.record({ lo: fc.nat({ max: 40 }), hi: fc.nat({ max: 40 }) }), { nil: null }),
        (st, vh, lc, retain) => {
          const i: ComputeWindowInput = {
            scrollTop: st,
            viewportH: 50 + vh,
            rowH: 10,
            lineCount: 100 + lc,
            overscan: 1,
            retain,
          };
          const w = computeWindow(i);
          const t = target(i);
          if (t.hi < t.lo) return w.hi < w.lo;
          expect(w.lo).toBeGreaterThanOrEqual(Math.max(0, t.lo - 1));
          expect(w.lo).toBeLessThanOrEqual(t.lo);
          expect(w.hi).toBeGreaterThanOrEqual(t.hi);
          expect(w.hi).toBeLessThanOrEqual(t.hi + 1);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("computeWindow — selection retention (§4.5 只增不减 + 2048 cap)", () => {
  const input = (over: Partial<ComputeWindowInput>): ComputeWindowInput => ({
    scrollTop: 0,
    viewportH: 200,
    rowH: 10,
    lineCount: 100_000,
    overscan: 1,
    retain: null,
    ...over,
  });

  it("grows over the retained range, stays contiguous, 64 blocks exactly is still fine", () => {
    // target at top = blocks 0..1; retained far below ⇒ union
    const w = computeWindow(input({ retain: { lo: 60, hi: 63 }, selectionActive: true }));
    expect(w).toEqual({ lo: 0, hi: 63, capped: false }); // exactly 64 blocks = 2048 lines
    // target moved away but the union still fits under the cap — both sides stay mounted
    const w2 = computeWindow(input({ scrollTop: 50000, retain: { lo: 150, hi: 152 }, selectionActive: true }));
    expect(w2).toEqual({ lo: 150, hi: 157, capped: false });
    // a union that would span past 64 blocks caps out and returns the normal window instead
    const far = computeWindow(input({ scrollTop: 50000, retain: { lo: 0, hi: 1 }, selectionActive: true }));
    expect(far.capped).toBe(true);
    expect(far).toEqual({ ...computeWindow(input({ scrollTop: 50000, retain: null })), capped: true });
  });

  it("past 64 blocks the NORMAL window returns and capped flags the notice", () => {
    const w = computeWindow(input({ retain: { lo: 60, hi: 64 }, selectionActive: true }));
    expect(w.capped).toBe(true);
    expect(w).toEqual({ ...computeWindow(input({ retain: null })), capped: true });
  });

  it("selectionActive without a retain range is just the normal window", () => {
    expect(computeWindow(input({ selectionActive: true }))).toEqual({
      ...computeWindow(input({})),
      capped: false,
    });
  });

  it("property: selection windows are contiguous, ⊇ target ∪ retain, ≤64 blocks (or capped)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 999_000 }),
        fc.nat({ max: 300 }),
        fc.record({ lo: fc.nat({ max: 500 }), hi: fc.nat({ max: 500 }) }),
        (st, vh, retain) => {
          const [a, b] = retain.lo <= retain.hi ? [retain.lo, retain.hi] : [retain.hi, retain.lo];
          const i: ComputeWindowInput = {
            scrollTop: st,
            viewportH: 100 + vh,
            rowH: 10,
            lineCount: 100_000,
            overscan: 1,
            retain: { lo: a, hi: b },
            selectionActive: true,
          };
          const w = computeWindow(i);
          const t = computeWindow({ ...i, retain: null });
          const spanBlocks = Math.max(t.hi, b) - Math.min(t.lo, a) + 1;
          if (spanBlocks > VIRTUAL_SELECTION_MAX_LINES / 32) {
            // would exceed the cap ⇒ the NORMAL window returns, flagged (§4.5)
            expect(w).toEqual({ ...t, capped: true });
          } else {
            expect(w.capped).toBe(false);
            expect(w.lo).toBeLessThanOrEqual(Math.min(t.lo, a));
            expect(w.hi).toBeGreaterThanOrEqual(Math.max(t.hi, b));
            expect(w.hi - w.lo + 1).toBeLessThanOrEqual(VIRTUAL_SELECTION_MAX_LINES / 32);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("maxLines / reanchor (§4.3)", () => {
  it("maxLines = min(500k, floor(15e6 px / rowH))", () => {
    expect(maxLines(19.5)).toBe(500_000); // floor(15e6/19.5) ≈ 769k ⇒ capped
    expect(maxLines(58.5)).toBe(256_410); // 300% font scale
    expect(maxLines(30)).toBe(500_000); // exactly at the px boundary
    expect(maxLines(31)).toBe(483_870);
    expect(maxLines(0.02)).toBe(500_000); // px budget huge ⇒ line bound wins
    expect(maxLines(0)).toBe(VIRTUAL_MAX_LINES); // unusable ⇒ line-count bound only
    expect(maxLines(Number.NaN)).toBe(VIRTUAL_MAX_LINES);
    expect(maxLines(-5)).toBe(VIRTUAL_MAX_LINES);
  });

  it("reanchor re-projects the anchor line + fraction onto the new row height", () => {
    expect(reanchor(100, 20, 40)).toBe(200); // exactly line 5
    expect(reanchor(105, 20, 40)).toBe(210); // line 5 + 0.25
    expect(reanchor(37, 10, 20)).toBeCloseTo(74, 10); // line 3 + 0.7
    expect(reanchor(0, 20, 40)).toBe(0);
    expect(reanchor(-5, 20, 40)).toBe(0);
  });

  it("reanchor passes scrollTop through when the heights are unusable", () => {
    expect(reanchor(50, 0, 10)).toBe(50);
    expect(reanchor(50, Number.NaN, 10)).toBe(50);
    expect(reanchor(50, 10, Number.NaN)).toBe(50);
    expect(reanchor(Number.NaN, 10, 20)).toBe(0);
  });
});
