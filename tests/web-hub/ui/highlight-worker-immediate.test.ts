// @vitest-environment happy-dom
/**
 * preview-perf P5 addendum (user ruling 2026-10-23, evidence `docs/dev/preview-perf/PB-report.md`
 * §7.3): §5.2's `immediate` (first-frame highlight) is for SMALL files only — PreviewText passes
 * it to NumberedCode/HighlightedCode iff the text is ≤200 lines AND ≤8 KiB (`isImmediateHighlightSize`).
 * Larger in-gate files return to the plain-first-frame + debounced-swap path; the transcript's
 * CodeBlock keeps its own 150 ms contract (unchanged, covered by highlight-first-frame.test.ts);
 * the Worker path is orthogonal — it owns the widened-gate VIRTUAL bodies and never receives
 * `immediate` (they start plain by design).
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import {
  isImmediateHighlightSize,
  loadPrism,
  PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES,
  PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES,
} from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";
import {
  LINE_NUMBERS_STORAGE_KEY,
  resetLineNumbersPrefForTests,
} from "../../../src/web-hub/ui/src/composables/useLineNumbersPref.js";

beforeEach(() => {
  resetLineNumbersPrefForTests();
});
afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.removeItem(LINE_NUMBERS_STORAGE_KEY);
  resetLineNumbersPrefForTests();
});

/** n logical lines, each `len` ASCII bytes. */
function lines(n: number, len = 12): string {
  const unit = "x".repeat(Math.max(1, len - 1));
  const body = Array.from({ length: n }, () => unit).join("\n");
  return body;
}

describe("isImmediateHighlightSize (P5 addendum size gate)", () => {
  it("exports the ruled bounds", () => {
    expect(PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_LINES).toBe(200);
    expect(PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES).toBe(8 * 1024);
  });

  it("≤200 lines and ≤8 KiB ⇒ true; 201 lines ⇒ false", () => {
    expect(isImmediateHighlightSize(lines(200))).toBe(true);
    expect(isImmediateHighlightSize(lines(201))).toBe(false);
  });

  it("≤200 lines but over 8 KiB (ASCII) ⇒ false", () => {
    expect(isImmediateHighlightSize("a".repeat(PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES + 1))).toBe(false);
    expect(isImmediateHighlightSize("a".repeat(PREVIEW_IMMEDIATE_HIGHLIGHT_MAX_BYTES))).toBe(true);
  });

  it("counts UTF-8 bytes, not UTF-16 units (CJK = 3, surrogate pair = 4)", () => {
    // 2730 汉字 = 8190 bytes ⇒ true; +1 char = 8193 bytes ⇒ false (units stay under the bound)
    expect(isImmediateHighlightSize("汉".repeat(2730))).toBe(true);
    expect(isImmediateHighlightSize("汉".repeat(2731))).toBe(false);
    // 2048 astral chars = 8192 bytes ⇒ true; 2049 ⇒ false
    expect(isImmediateHighlightSize("𝐀".repeat(2048))).toBe(true);
    expect(isImmediateHighlightSize("𝐀".repeat(2049))).toBe(false);
  });

  it("empty ⇒ false (nothing to highlight)", () => {
    expect(isImmediateHighlightSize("")).toBe(false);
  });
});

describe("PreviewText first-frame highlight sizing (P5 addendum)", () => {
  it("SMALL file (≤200 lines / ≤8 KiB): the FIRST render is already highlighted", async () => {
    await loadPrism(); // warm engine — `immediate` tokenizes during setup
    const kw = "const one = 1; // c\n".repeat(10); // 10 lines, 150 bytes — well inside the bounds
    const w = mount(PreviewText, {
      props: { text: kw, truncated: false, filename: "a.ts" },
      attachTo: document.body,
    });
    // SYNCHRONOUS: no plain→highlight swap for a small file — the very first render carries spans
    expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    expect(w.element.querySelectorAll("span.tok-comment").length).toBeGreaterThan(0);
    w.unmount();
  });

  it("OVER the size gate but under 600 lines (NumberedCode path): plain first frame, swap lands later", async () => {
    await loadPrism();
    const text = `${"const v = 1; // c\n".repeat(300)}`; // 300 lines, ~5.1 KiB — > 200 lines ⇒ NOT immediate
    const w = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.ts" },
      attachTo: document.body,
    });
    // the ≤600-line numbered path (NumberedCode) — but first frame must be PLAIN now
    expect(w.find("pre.preview-text-body").exists()).toBe(true);
    expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(0);
    await vi.waitFor(
      () => {
        expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 4_000, interval: 20 },
    );
    expect(w.element.textContent).toBe(text); // highlighting never alters the text
    w.unmount();
  });

  it("line numbers OFF + small file: HighlightedCode's first render is highlighted; large file is not", async () => {
    await loadPrism();
    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    resetLineNumbersPrefForTests(); // re-read the pref

    const small = "let a = 1; // c\n".repeat(5);
    const w = mount(PreviewText, {
      props: { text: small, truncated: false, filename: "a.ts" },
      attachTo: document.body,
    });
    expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0); // immediate
    w.unmount();

    const large = `${"let v = 2; // c\n".repeat(300)}`; // > 200 lines ⇒ plain first frame
    const w2 = mount(PreviewText, {
      props: { text: large, truncated: false, filename: "a.ts" },
      attachTo: document.body,
    });
    expect(w2.element.querySelectorAll("span.tok-keyword").length).toBe(0);
    await vi.waitFor(
      () => {
        expect(w2.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 4_000, interval: 20 },
    );
    w2.unmount();
  });

  it("orthogonal to the Worker path: >600 lines go virtual (plain start, worker gates) — no `immediate` involved", async () => {
    await loadPrism();
    const text = `${"const v = 1;\n".repeat(650)}`; // 650 lines ⇒ VirtualCode, never NumberedCode
    const w = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.ts", rowHeight: 20, viewportHeight: 400 },
      attachTo: document.body,
    });
    expect(w.find("pre.pv-virtual").exists()).toBe(true);
    expect(w.find("pre.preview-text-body:not(.pv-virtual)").exists()).toBe(false); // the non-virtual body is gone
    // happy-dom has no Worker ⇒ the virtual highlighter sits on the sticky fallback path
    // (§5.1 original gates: 7 800 bytes / 650 lines pass) — the swap arrives, from the MAIN thread
    await vi.waitFor(
      () => {
        expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 8_000, interval: 20 },
    );
    w.unmount();
  });
});
