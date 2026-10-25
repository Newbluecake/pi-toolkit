// @vitest-environment happy-dom
/**
 * preview-perf P3 §6.3 — highlight-core's load-FAILURE contract under `immediate` (§5.2):
 * a failed engine import resolves to `null` (the synchronous cache records it) and the
 * component stays PLAIN FOREVER — never highlighted, never retried.
 *
 * Its own file on purpose: the `vi.mock` of the engine chunk must not poison the cold/warm
 * suite (`highlight-first-frame.test.ts`).
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import HighlightedCode from "../../../src/web-hub/ui/src/components/shared/HighlightedCode.vue";
import { loadPrism } from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";

// The engine chunk resolves to a DEFAULTLESS module — exactly the shape a failed/corrupt
// load produces on the consumer side (`m.default` undefined ⇒ treated as a null engine).
vi.mock("../../../src/web-hub/ui/src/components/shared/highlight-impl.js", () => ({ default: null }));

const JS = "const one = 1;\n";

describe("highlight-core load failure (§5.2)", () => {
  it("a failed engine ⇒ immediate mode stays plain forever", async () => {
    const engine = await loadPrism();
    expect(engine).toBeNull(); // the mocked failure settled the sync cache to null
    const w = mount(HighlightedCode, {
      props: { text: JS, lang: "javascript", immediate: true },
      attachTo: document.body,
    });
    expect(document.querySelectorAll("span.tok-keyword").length).toBe(0); // first render: plain
    await new Promise((r) => setTimeout(r, 250)); // no debounce path may rescue it
    expect(document.querySelectorAll("span.tok-keyword").length).toBe(0); // …forever plain
    expect(w.element.textContent).toBe(JS);
    w.unmount();
    document.body.innerHTML = "";
  });
});
