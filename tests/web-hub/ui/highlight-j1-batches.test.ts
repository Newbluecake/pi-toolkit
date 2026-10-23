// @vitest-environment happy-dom
/**
 * J1 #2 (jank-20kb LT-3) — BATCHED highlight application: once parts arrive, the highlight
 * swaps in row blocks (≤48 lines / ≤512 parts per batch, one macrotask per batch) instead of
 * one whole-body re-cloak. Pins:
 *  - an INTERMEDIATE state exists (leading rows highlighted, tail still plain) for a body
 *    large enough to need >1 batch, and the FINAL DOM is fully highlighted with a
 *    textContent that never changes;
 *  - a non-collapsed selection inside the body DEFERS the remaining batches (selection is
 *    never collapsed under a row rewrite); clearing it resumes and completes;
 *  - a text change mid-run cancels the staging (no further batches apply);
 *  - `immediate` (§5.2 small-file sync swap) skips staging — the first render is complete.
 *
 * The worker client is a spans-replying fake (deterministic, no engine timing); the parts it
 * returns are REAL engine output so the DOM matches production shapes.
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HighlightedCode from "../../../src/web-hub/ui/src/components/shared/HighlightedCode.vue";
import NumberedCode from "../../../src/web-hub/ui/src/components/shared/NumberedCode.vue";
import {
  loadPrism,
  setHighlightWorkerClientForTests,
} from "../../../src/web-hub/ui/src/components/shared/highlight-core.js";
import { encodeHighlightSpans, flattenTokens } from "../../../src/web-hub/ui/src/logic/highlight.js";
import type { HighlightSpans } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";
import type {
  HighlightWorkerClient,
  HighlightWorkerHandle,
  HighlightWorkerOutcome,
} from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";

/** A spans-replying worker fake: resolves every request with the REAL engine's spans. */
function spansClient(onRequest?: (text: string) => void): HighlightWorkerClient {
  return {
    unavailable: false,
    request(text: string, lang: string): HighlightWorkerHandle {
      onRequest?.(text);
      let resolveFn!: (o: HighlightWorkerOutcome) => void;
      const result = new Promise<HighlightWorkerOutcome>((res) => {
        resolveFn = res;
      });
      void loadPrism().then((prism) => {
        const grammar = prism === null ? undefined : prism.languages[lang];
        if (grammar === undefined) {
          resolveFn({ status: "plain" });
          return;
        }
        const parts = flattenTokens(prism.tokenize(text, grammar));
        const spans: HighlightSpans | null = parts === null ? null : encodeHighlightSpans(parts);
        resolveFn(spans === null ? { status: "plain" } : { status: "spans", spans });
      });
      return { result, cancel: (): void => resolveFn({ status: "cancelled" }) };
    },
  };
}

beforeEach(async () => {
  await loadPrism();
});

afterEach(() => {
  setHighlightWorkerClientForTests(null);
  document.body.innerHTML = "";
  const sel = document.getSelection();
  sel?.removeAllRanges();
});

/** n lines of real TypeScript (each line carries keyword/comment/number tokens). */
const TS_LINES = (n: number): string => `${"const v1 = 42; // c\n".repeat(n)}`;

describe("J1 #2 — NumberedCode progressive line-block application", () => {
  it("applies in batches: an intermediate PARTIAL state exists, the final DOM is complete", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const text = TS_LINES(149); // ~1.3k parts ⇒ ≥3 batches of 512
    const w = mount(NumberedCode, { props: { text, lang: "typescript" } });
    expect(w.element.querySelectorAll(".pv-line").length).toBe(149);
    expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(0); // plain first frame

    // wait for SOME highlight, then assert a partial state exists (batches in flight)
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    const kw = () => w.element.querySelectorAll("span.tok-keyword").length;
    const total = () => w.element.querySelectorAll(".pv-line").length;
    // intermediate: not all 149 lines highlighted yet (line count never changes).
    // Poll every MACROTASK — each batch is one timer slot, so a 0 ms sweep catches the
    // in-between states a coarse waitFor would sleep through.
    let sawPartial = false;
    for (let i = 0; i < 400 && !sawPartial; i++) {
      sawPartial = kw() > 0 && kw() < 149 && total() === 149;
      if (!sawPartial) await new Promise((r) => setTimeout(r, 0));
    }
    expect(sawPartial).toBe(true); // the staging is observable — no single whole-body swap
    // final: everything highlighted, content byte-identical throughout
    await vi.waitFor(() => {
      expect(kw()).toBe(149);
    });
    expect(w.element.textContent).toBe(text);
    w.unmount();
  });

  it("a non-collapsed selection INSIDE the body defers the remaining batches", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const text = TS_LINES(200); // ≥4 batches
    const w = mount(NumberedCode, { props: { text, lang: "typescript" } });
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    // select across two plain lines near the tail (a Range the next batch would rewrite)
    const lines = [...w.element.querySelectorAll<HTMLElement>(".pv-line")];
    const a = lines[100]!.firstChild!;
    const b = lines[101]!.lastChild!;
    const range = document.createRange();
    range.setStart(a, 0);
    range.setEnd(b, Math.min(2, (b.textContent ?? "").length)); // clamp — staging rewrites line shapes
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(sel?.isCollapsed).toBe(false);

    await new Promise((r) => setTimeout(r, 120)); // several batch intervals pass…
    const kwHeld = w.element.querySelectorAll("span.tok-keyword").length;
    expect(kwHeld).toBeGreaterThan(0);
    expect(kwHeld).toBeLessThan(200); // …and the run is HELD (not completed)

    sel?.removeAllRanges(); // clear ⇒ resume
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(200);
    });
    expect(w.element.textContent).toBe(text);
    w.unmount();
  });

  it("a selection ELSEWHERE (outside the body) does NOT hold the run", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const outside = document.createElement("div");
    outside.textContent = "some other selectable text";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const text = TS_LINES(120);
    const w = mount(NumberedCode, { props: { text, lang: "typescript" } });
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(120);
    }); // completes despite the (foreign) selection
    w.unmount();
  });

  it("a text change mid-run cancels the staging — the new text starts plain again", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const text = TS_LINES(150);
    const w = mount(NumberedCode, { props: { text, lang: "typescript" } });
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
    });
    await w.setProps({ text: TS_LINES(30) }); // mid-run swap
    // the OLD run's remaining batches must never land on the NEW text: after settling, the
    // count either restarts from 0 (new run) or completes 30 — never mixed overshoot.
    await vi.waitFor(() => {
      expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(30);
    });
    expect(w.element.textContent).toBe(TS_LINES(30));
    w.unmount();
  });

  it("`immediate` (small-file §5.2 contract): NO staging — the first render is complete", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const text = "const one = 1; // c\nconst two = 2; // c\n";
    const w = mount(NumberedCode, { props: { text, lang: "typescript", immediate: true } });
    // synchronous assertion: fully highlighted on the very first render (no plain phase)
    expect(w.element.querySelectorAll("span.tok-keyword").length).toBe(2);
    expect(w.element.querySelectorAll(".pv-line").length).toBe(2);
    expect(w.element.textContent).toBe(text);
    w.unmount();
  });
});

describe("J1 #2 — HighlightedCode progressive part-block application", () => {
  it("applies in part batches; the pending tail renders as one plain text node", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const text = `${"const v = 1; // c\n".repeat(300)}`; // ~2.4k parts ⇒ ≥4 batches of 512
    const host = document.createElement("div");
    document.body.appendChild(host);
    const w = mount(HighlightedCode, { props: { text, lang: "typescript" }, attachTo: host });
    await vi.waitFor(
      () => {
        expect(host.querySelectorAll("span.tok-keyword").length).toBeGreaterThan(0);
      },
      { timeout: 4000, interval: 1 },
    );
    // intermediate: partial spans present AND textContent already complete (plain tail)
    let sawPartial = false;
    for (let i = 0; i < 400 && !sawPartial; i++) {
      const kw = host.querySelectorAll("span.tok-keyword").length;
      sawPartial = kw > 0 && kw < 300 && host.textContent === text;
      if (!sawPartial) await new Promise((r) => setTimeout(r, 0));
    }
    expect(sawPartial).toBe(true);
    await vi.waitFor(() => {
      expect(host.querySelectorAll("span.tok-keyword").length).toBe(300);
    });
    expect(host.textContent).toBe(text);
    w.unmount();
  });

  it("degradation stays byte-identical: unknown lang ⇒ single plain text node forever", async () => {
    setHighlightWorkerClientForTests(spansClient());
    const host = document.createElement("div");
    document.body.appendChild(host);
    const w = mount(HighlightedCode, { props: { text: "x = 1;", lang: "brainfuck" }, attachTo: host });
    await new Promise((r) => setTimeout(r, 300));
    expect(host.querySelectorAll("span").length).toBe(0);
    expect(host.textContent).toBe("x = 1;");
    w.unmount();
  });
});
