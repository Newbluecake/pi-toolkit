import { describe, expect, it } from "vitest";
import { createSourceSegmenter } from "../../../src/web-hub/ui/src/logic/previewStream.js";
import {
  loadSegParityCases,
  containsPlaceholderAppMarker,
  isStrictBodyMode,
  PLACEHOLDER_APP_MARKER,
} from "../../../scripts/web-hub/visual/checks-body.js";

/**
 * Verifier P1 fix: `checks-body.ts` used to degrade every missing-target-DOM check to an
 * informational pass unconditionally, which would keep silently passing even after P3 replaces
 * `App.vue` and a check's target DOM is genuinely missing (a real regression). These pure
 * helpers gate that degrade behind confirming the mounted app still carries P0's placeholder
 * marker, plus a strict-mode escape hatch (`PWH_VISUAL_STRICT_BODY=1`) that always fails instead.
 */
describe("checks-body.ts placeholder-App detection", () => {
  it("recognizes the exact P0 placeholder text as present in a larger body textContent", () => {
    const body = `\n    pi web-hub — UI under construction. See docs/dev/web-hub/vue-plan.md.\n  `;
    expect(containsPlaceholderAppMarker(body)).toBe(true);
  });

  it("does not recognize a real P3+ shell's body text as the placeholder", () => {
    const body = "Dashboard Agents Fleet worker-1 running";
    expect(containsPlaceholderAppMarker(body)).toBe(false);
  });

  it("does not false-positive on partial/mangled marker text", () => {
    expect(containsPlaceholderAppMarker("pi web-hub is under construction somewhere")).toBe(false);
    expect(containsPlaceholderAppMarker("")).toBe(false);
  });

  it("exports the marker string itself so callers/tests share one source of truth", () => {
    expect(PLACEHOLDER_APP_MARKER).toBe("pi web-hub — UI under construction");
  });

  describe("isStrictBodyMode", () => {
    it('is false when PWH_VISUAL_STRICT_BODY is unset or not exactly "1"', () => {
      expect(isStrictBodyMode({})).toBe(false);
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "0" })).toBe(false);
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "true" })).toBe(false);
    });

    it('is true only when PWH_VISUAL_STRICT_BODY is exactly "1"', () => {
      expect(isStrictBodyMode({ PWH_VISUAL_STRICT_BODY: "1" })).toBe(true);
    });
  });
});

/**
 * chunked-plan §6.5 (r2 #1): the seg-parity corpus embedded in `seg-parity-snippet.js` must be
 * exactly what the REAL source segmenter produces (the harness cannot import it itself).
 */
describe("seg-parity-snippet.js corpus", () => {
  const cases = loadSegParityCases();

  it("covers the §4.3.4 inference-table shapes", () => {
    const names = cases.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "blank-line",
        "two-blank-lines",
        "leading-blank-lines",
        "crlf-blank-line",
        "eof-single-newline",
        "eof-only-newlines",
        "many-boundaries",
        "crlf-many-blank-lines",
        "mixed-lf-crlf",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s: embedded segments == live createSourceSegmenter", (_n, c) => {
    const seg = createSourceSegmenter();
    const out: Array<{ text: string; sep: string }> = [];
    for (let i = 0; i < c.text.length; i += c.chunk) {
      for (const s of seg.push(c.text.slice(i, i + c.chunk))) out.push({ text: s.text, sep: s.sep });
    }
    for (const s of seg.flush("eof")) out.push({ text: s.text, sep: s.sep });
    expect(c.segs).toEqual(out);
    // the copy-conservation law: the consumed text is the original, byte for byte
    expect(out.map((x) => x.text + x.sep).join("")).toBe(c.text);
  });

  it("the snippet is self-contained: no imports, one CASES literal, prints PASS/FAIL", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../scripts/web-hub/visual/seg-parity-snippet.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*(import|export)\s/m);
    expect(src.match(/^const CASES = /gm)).toHaveLength(1);
    expect(src).toContain("PASS");
    expect(src).toContain("FAIL");
  });
});
