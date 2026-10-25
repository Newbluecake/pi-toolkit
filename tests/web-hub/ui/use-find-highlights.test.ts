/**
 * preview-perf P3 §6.3 — `composables/useFindHighlights.ts` (the singleton CSS Custom
 * Highlight manager): two owners UNION their ranges under the document-level `pv-find` /
 * `pv-find-cur` registry names; `release()` removes ONLY the releasing owner's ranges; a
 * missing `CSS.highlights` (K9 old engines) makes `acquire` return null and every later
 * call a no-op (the caller then uses the native-selection fallback).
 *
 * Node environment on purpose: the module is DOM-free (it only touches `globalThis.CSS` /
 * `Highlight`), so the engine is stubbed with a Map registry and a constructor capturing
 * its ranges — exactly the observable surface the manager may use.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireFindHighlights,
  resetFindHighlightsForTests,
} from "../../../src/web-hub/ui/src/composables/useFindHighlights.js";

/** A stand-in Range — the manager never inspects range internals. */
const r = (id: string): object => ({ id });

class FakeHighlight {
  readonly ranges: readonly object[];
  constructor(...ranges: object[]) {
    this.ranges = ranges;
  }
}

interface Registry {
  highlights: Map<string, FakeHighlight>;
  Highlight: typeof FakeHighlight;
}

function installEngine(): Registry {
  const reg: Registry = { highlights: new Map(), Highlight: FakeHighlight };
  (globalThis as { CSS?: unknown }).CSS = { highlights: reg.highlights };
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  return reg;
}

function dropEngine(): void {
  delete (globalThis as { CSS?: unknown }).CSS;
  delete (globalThis as { Highlight?: unknown }).Highlight;
}

const ids = (hl: FakeHighlight | undefined): string[] =>
  hl === undefined ? [] : hl.ranges.map((x) => (x as { id: string }).id);

afterEach(() => {
  resetFindHighlightsForTests();
  dropEngine();
});

describe("useFindHighlights — the singleton manager (§4.6/§6.3)", () => {
  it("two owners UNION their ranges; `cur` unions the current hits", () => {
    const reg = installEngine();
    const a = acquireFindHighlights("win-a")!;
    const b = acquireFindHighlights("win-b")!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a.setRanges([r("a1"), r("a2")], r("a1"));
    b.setRanges([r("b1"), r("b2")], r("b2"));
    expect(ids(reg.highlights.get("pv-find"))).toEqual(["a1", "a2", "b1", "b2"]);
    expect(ids(reg.highlights.get("pv-find-cur"))).toEqual(["a1", "b2"]);
  });

  it("release() removes ONLY that owner's ranges — the other window keeps its marks", () => {
    const reg = installEngine();
    const a = acquireFindHighlights("win-a")!;
    const b = acquireFindHighlights("win-b")!;
    a.setRanges([r("a1")], r("a1"));
    b.setRanges([r("b1")], r("b1"));
    a.release();
    expect(ids(reg.highlights.get("pv-find"))).toEqual(["b1"]);
    expect(ids(reg.highlights.get("pv-find-cur"))).toEqual(["b1"]);
    // the released owner is gone for good — a late setRanges is a no-op
    a.setRanges([r("a9")], null);
    expect(ids(reg.highlights.get("pv-find"))).toEqual(["b1"]);
  });

  it("releasing the LAST owner deletes both registry keys (clean state)", () => {
    const reg = installEngine();
    const a = acquireFindHighlights("win-a")!;
    a.setRanges([r("a1")], null);
    a.release();
    expect(reg.highlights.has("pv-find")).toBe(false);
    expect(reg.highlights.has("pv-find-cur")).toBe(false);
  });

  it("setRanges REPLACES the owner's previous ranges (no accumulation)", () => {
    const reg = installEngine();
    const a = acquireFindHighlights("win-a")!;
    a.setRanges([r("a1"), r("a2"), r("a3")], r("a2"));
    a.setRanges([r("a4")], r("a4"));
    expect(ids(reg.highlights.get("pv-find"))).toEqual(["a4"]);
    expect(ids(reg.highlights.get("pv-find-cur"))).toEqual(["a4"]);
  });

  it("no CSS.highlights / Highlight (K9) ⇒ acquire returns null and nothing throws", () => {
    dropEngine();
    expect(acquireFindHighlights("win-a")).toBeNull();
    // a re-acquire after the engine appears still works (engines do not go away mid-flight)
    const reg = installEngine();
    const a = acquireFindHighlights("win-b")!;
    a.setRanges([r("b1")], r("b1"));
    expect(ids(reg.highlights.get("pv-find"))).toEqual(["b1"]);
  });
});
