// @vitest-environment happy-dom
/**
 * preview-perf P3 §6.3 — highlight-core's FIRST-RENDER behavior (plan r3 §5.2, 评审 r1 #11):
 * a one-shot preview body (`immediate`) renders the HIGHLIGHTED VNode on its very first
 * render once the Prism engine has settled (the synchronous `resolvedPrism` cache), instead
 * of a plain text node that is replaced a moment later. Cold engine (first load in this
 * file) still renders plain first and swaps EXACTLY once on arrival.
 *
 * File order matters and is deliberate: the "cold" test runs FIRST (the module registry is
 * per test file, so no other suite can have warmed the engine for us). The load-FAILURE
 * contract (plain forever) lives in its own file — its `vi.mock` must not poison this one.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import HighlightedCode from "../../../src/web-hub/ui/src/components/shared/HighlightedCode.vue";
import NumberedCode from "../../../src/web-hub/ui/src/components/shared/NumberedCode.vue";
import { loadPrism } from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";

const JS = "const one = 1;\nconst two = 2;\n";

describe("highlight-core first frame (§5.2)", () => {
  it("COLD engine: the first render is PLAIN; the swap happens exactly once on arrival", async () => {
    // Kick the shared load, then mount while the dynamic import is still in flight — the
    // first render must be the plain text node (identical pre-highlight DOM).
    const p = loadPrism();
    const w = mount(HighlightedCode, {
      props: { text: JS, lang: "javascript", immediate: true },
      attachTo: document.body,
    });
    expect(document.querySelectorAll("span.tok-keyword").length).toBe(0); // first render: plain
    const engine = await p;
    expect(engine).not.toBeNull(); // the real chunk must load under vitest
    await vi.waitFor(
      () => {
        expect(document.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0); // swapped once
      },
      { timeout: 4000, interval: 20 },
    );
    expect(w.element.textContent).toBe(JS); // highlighting never alters the text
    w.unmount();
    document.body.innerHTML = "";
  });

  it("WARM engine (resolvedPrism): `immediate` renders highlighted ON THE FIRST RENDER (no swap)", async () => {
    await loadPrism(); // the previous test (or this await) settled the engine
    const w = mount(NumberedCode, { props: { text: JS, lang: "javascript", immediate: true } });
    // SYNCHRONOUS assertion — the very first render already carries the token spans
    // (NumberedCode's root is the CodeLines span; query through the wrapper)
    expect(w.element.querySelectorAll(".pv-line").length).toBe(2);
    const kw = w.element.querySelectorAll("span.tok-keyword");
    expect(kw.length).toBeGreaterThan(0);
    expect(w.element.textContent).toBe(JS);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("without `immediate` the transcript contract is unchanged: plain first, debounced swap", async () => {
    await loadPrism(); // warm engine — immediate would highlight sync; the default must NOT
    const w = mount(HighlightedCode, { props: { text: JS, lang: "javascript" }, attachTo: document.body });
    expect(document.querySelectorAll("span.tok-keyword").length).toBe(0); // first render: plain
    await vi.waitFor(
      () => {
        expect(document.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 20 },
    );
    w.unmount();
    document.body.innerHTML = "";
  });
});
