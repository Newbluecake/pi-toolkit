// @vitest-environment happy-dom
/**
 * Preview line numbers (2026-10-23, L1) — the component suite:
 *  - non-stream source view: one `.pv-line` per logical line by default, `textContent`
 *    byte-identical to the legacy `<pre>` body (each line carries its own "\n"), numbers as
 *    CSS counters (never in the DOM ⇒ selection/copy stay pure), copy value untouched;
 *  - the shared `pwh_linenumbers` pref: default ON, `"0"` ⇒ the exact pre-feature DOM,
 *    toggling persists and re-renders; the PreviewWindow header toggle (compact `1#` glyph,
 *    aria-pressed, source views only);
 *  - highlight parity: cross-line tokens are cut, class carried; large-text gates degrade
 *    to plain LINES (numbers stay); over PREVIEW_NUMBERED_LINES_MAX ⇒ legacy body + note;
 *  - stream: numbering continues across segments (per-segment `counter-reset`), old
 *    segments keep node identity, a §4.3.4 force cut leaves an unnumbered `.pv-line-cont`
 *    continuation head, the pref can flip on mid-stream;
 *  - rendered md/html views never show a gutter; the toggle hides there.
 */
import { mount } from "@vue/test-utils";
import { nextTick, shallowReactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import {
  LINE_NUMBERS_STORAGE_KEY,
  resetLineNumbersPrefForTests,
  useLineNumbersPref,
} from "../../../src/web-hub/ui/src/composables/useLineNumbersPref.js";
import { PREVIEW_NUMBERED_LINES_MAX } from "../../../src/web-hub/ui/src/logic/previewLines.js";
import type { PreviewTextStream } from "../../../src/web-hub/ui/src/types.js";
import { fakeWindowHandle, fakeWindowsFace } from "./helpers/preview-windows-fake.js";

/** Wait until `cond()` holds (real timers — the highlight debounce + dynamic import are real). */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  await vi.waitFor(
    () => {
      expect(cond()).toBe(true);
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

afterEach(() => {
  window.localStorage.removeItem(LINE_NUMBERS_STORAGE_KEY);
  resetLineNumbersPrefForTests();
  document.body.innerHTML = "";
});

const linesOf = (el: Element): string[] => [...el.querySelectorAll(".pv-line")].map((l) => l.textContent ?? "");

describe("PreviewText.vue — line numbers (non-stream source view)", () => {
  it("default ON: one .pv-line per logical line; textContent is byte-identical to the legacy pre", () => {
    const text = "line 1\n  indented\n\nline 4";
    const wrapper = mount(PreviewText, { props: { text, truncated: false }, attachTo: document.body });
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.element.textContent).toBe(text); // fidelity: terminators ride their lines
    expect(linesOf(pre.element)).toEqual(["line 1\n", "  indented\n", "\n", "line 4"]);
    // the numbers are CSS counters — no DOM node carries them
    expect(pre.element.querySelector(".pv-line")!.textContent).not.toMatch(/^1/);
    wrapper.unmount();
  });

  it("a source-final newline spawns no phantom numbered line", () => {
    const wrapper = mount(PreviewText, { props: { text: "a\nb\n", truncated: false }, attachTo: document.body });
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.element.querySelectorAll(".pv-line")).toHaveLength(2);
    expect(pre.element.textContent).toBe("a\nb\n");
    wrapper.unmount();
  });

  it("copy value is exactly the displayed source (no line numbers, unchanged channel)", () => {
    const wrapper = mount(PreviewText, { props: { text: "x\ny", truncated: false }, attachTo: document.body });
    expect(wrapper.emitted("update:copyValue")).toEqual([["x\ny"]]);
    wrapper.unmount();
  });

  it("cross-line tokens are cut with the class carried to both pieces (block comment)", async () => {
    const text = "/* one\ntwo\nthree */\nconst x = 1;"; // one comment token spanning three lines
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.js" },
      attachTo: document.body,
    });
    await waitFor(() => wrapper.element.querySelector("span.tok-comment") !== null);
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.element.textContent).toBe(text); // highlighting must not alter the text
    const comments = [...pre.element.querySelectorAll("span.tok-comment")];
    // the trailing "\n" belongs to the PLAIN part after the comment token (flattenTokens
    // keeps each char in its own token's run) — the class still crosses every line break.
    expect(comments.map((s) => s.textContent)).toEqual(["/* one\n", "two\n", "three */"]);
    // each piece sits on its own line
    for (const s of comments) expect((s as HTMLElement).closest(".pv-line")).not.toBeNull();
    wrapper.unmount();
  });

  it('pref "0" ⇒ the exact pre-feature DOM (no .pv-line, single text node pre-highlight)', async () => {
    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    const wrapper = mount(PreviewText, { props: { text: "a\nb", truncated: false }, attachTo: document.body });
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.element.querySelectorAll(".pv-line")).toHaveLength(0);
    expect(pre.element.childNodes.length).toBe(1);
    expect(pre.element.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
    expect(pre.element.textContent).toBe("a\nb");
    wrapper.unmount();
  });

  it("toggling the shared pref persists and re-renders every mounted preview", async () => {
    const a = mount(PreviewText, { props: { text: "one\ntwo", truncated: false }, attachTo: document.body });
    const b = mount(PreviewText, { props: { text: "three\nfour", truncated: false }, attachTo: document.body });
    expect(document.querySelectorAll(".pv-line").length).toBe(4);
    const pref = useLineNumbersPref({ storage: window.localStorage });
    pref.setOn(false);
    await tick();
    expect(window.localStorage.getItem(LINE_NUMBERS_STORAGE_KEY)).toBe("0");
    expect(document.querySelectorAll(".pv-line").length).toBe(0);
    pref.setOn(true);
    await tick();
    expect(window.localStorage.getItem(LINE_NUMBERS_STORAGE_KEY)).toBe("1");
    expect(document.querySelectorAll(".pv-line").length).toBe(4);
    a.unmount();
    b.unmount();
  });

  it(`over ${PREVIEW_NUMBERED_LINES_MAX} lines ⇒ legacy body + the degradation note (r0: virtualEnabled=false)`, () => {
    const text = "x\n".repeat(PREVIEW_NUMBERED_LINES_MAX) + "y";
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, virtualEnabled: false },
      attachTo: document.body,
    });
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.element.querySelectorAll(".pv-line")).toHaveLength(0);
    expect(pre.element.textContent).toBe(text);
    const note = wrapper.get(".preview-md-note");
    expect(note.text()).toContain(String(PREVIEW_NUMBERED_LINES_MAX));
    wrapper.unmount();
  });

  it("a huge plain text under the line cap still gets numbers (no highlight needed)", () => {
    const text = "row\n".repeat(4000) + "end"; // over the 3000-line HIGHLIGHT gate, under the number cap
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.txt", virtualEnabled: false },
      attachTo: document.body,
    });
    expect(wrapper.get("pre.preview-text-body").element.querySelectorAll(".pv-line")).toHaveLength(4001);
    wrapper.unmount();
  });

  it("reports the source-view channel: md rendered ⇒ hidden toggle, source ⇒ shown", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# Hi\n\nbody", truncated: false, filename: "R.md", path: "/p/R.md" },
      attachTo: document.body,
    });
    // rendered md: no gutter anywhere
    expect(wrapper.find(".preview-md").exists()).toBe(true);
    expect(wrapper.find(".pv-line").exists()).toBe(false);
    expect(wrapper.emitted("update:sourceView")).toEqual([[false]]);
    await wrapper.findAll(".preview-toggle-btn")[1]!.trigger("click"); // → source
    expect(wrapper.emitted("update:sourceView")).toEqual([[false], [true]]);
    expect(wrapper.get("pre.preview-text-body").element.querySelectorAll(".pv-line").length).toBe(3);
    wrapper.unmount();
    expect(wrapper.emitted("update:sourceView")!.at(-1)).toEqual([false]);
  });
});

describe("PreviewText.vue — line numbers (chunked stream)", () => {
  function mkStream(over: Partial<PreviewTextStream> = {}): PreviewTextStream {
    return shallowReactive<PreviewTextStream>({
      ident: "i1.AAAAAAAAAAAAAAAAAAAAAA",
      total: 3 * 1024 * 1024,
      cap: 8 * 1024 * 1024,
      firstBytes: 256 * 1024,
      chunks: ["a\nb\nc\nd\n"],
      loaded: 256 * 1024,
      state: "more",
      autoRetries: 0,
      ...over,
    });
  }
  // preview-perf P3 (§6.3): the stream numbering/continuation/cap-degrade assertions pin
  // the r0 per-segment renderer — with the virtual switch ON a stream is ALWAYS virtual, so
  // they run under `virtualEnabled: false` (the virtual stream path has its own suite below).
  const mountStream = (stream: PreviewTextStream, extra: Record<string, unknown> = {}) =>
    mount(PreviewText, {
      props: {
        text: stream.chunks[0]!,
        truncated: true,
        stream,
        filename: "x.log",
        path: "/p/x.log",
        virtualEnabled: false,
        ...extra,
      },
      attachTo: document.body,
    });
  const segReset = (el: Element): string => (el as HTMLElement).style.getPropertyValue("counter-reset");

  it("numbering continues across segments; old segment elements are never re-patched", async () => {
    const stream = mkStream();
    const w = mountStream(stream);
    const before = w.findAll(".preview-seg").map((e) => e.element);
    expect(before).toHaveLength(1);
    expect(segReset(before[0]!)).toBe("pvline 0"); // lines 1..4
    expect(before[0]!.querySelectorAll(".pv-line")).toHaveLength(4);
    stream.chunks = [...stream.chunks, "e\nf"];
    stream.state = "done";
    await tick();
    const after = w.findAll(".preview-seg").map((e) => e.element);
    expect(after).toHaveLength(3); // "a…d" + "e" + final "f"
    expect(after[0]).toBe(before[0]); // append-only: same node identity
    expect(segReset(after[1]!)).toBe("pvline 4"); // next numbered line = 5
    expect(segReset(after[2]!)).toBe("pvline 5"); // final line = 6
    expect(after[2]!.textContent).toBe("f");
    w.unmount();
  });

  it("a §4.3.4 force cut leaves an unnumbered continuation head on the next segment", async () => {
    const big = "x".repeat(520 * 1024); // > SOURCE_FORCE_CHARS, no "\n" ⇒ forced cut
    const stream = mkStream({ chunks: [big] });
    const w = mountStream(stream);
    stream.chunks = [...stream.chunks, "\ny\n"];
    stream.state = "done";
    await tick();
    const segs = w.findAll(".preview-seg").map((e) => e.element);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.textContent).toBe(big); // line 1, sep ""
    expect(segReset(segs[1]!)).toBe("pvline 2"); // start 2, continuation head ⇒ reset 2
    const rows = [...segs[1]!.querySelectorAll(".pv-line")];
    expect(rows.map((r) => r.classList.contains("pv-line-cont"))).toEqual([true, false]);
    expect(rows[1]!.textContent).toBe("y"); // logical line 2
    w.unmount();
  });

  it("pref off ⇒ legacy plain .preview-seg divs; flipping on mid-stream re-renders numbered", async () => {
    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    const stream = mkStream({ chunks: ["l1\nl2\nl3"] });
    const w = mountStream(stream);
    expect(w.findAll(".preview-seg")).toHaveLength(1);
    expect(w.find(".pv-line").exists()).toBe(false);
    expect(w.get(".preview-seg").text()).toBe("l1\nl2");
    const pref = useLineNumbersPref({ storage: window.localStorage });
    pref.setOn(true);
    await tick();
    const segs = w.findAll(".preview-seg");
    expect(segs[0]!.element.querySelectorAll(".pv-line")).toHaveLength(2);
    expect(segReset(segs[0]!.element)).toBe("pvline 0");
    w.unmount();
  });

  it("segments past the line cap degrade to the plain .preview-seg div", async () => {
    const head = "h\n".repeat(PREVIEW_NUMBERED_LINES_MAX); // exactly at the cap: still numbered
    const stream = mkStream({ chunks: [head] });
    const w = mountStream(stream);
    stream.chunks = [...stream.chunks, "t1\nt2\n"];
    await tick();
    const segs = w.findAll(".preview-seg").map((e) => e.element);
    expect(segs[0]!.querySelectorAll(".pv-line").length).toBeGreaterThan(0);
    // the second segment (lines cap+1…) degrades to the legacy plain div
    expect(segs[1]!.querySelectorAll(".pv-line")).toHaveLength(0);
    expect(segs[1]!.textContent).toContain("t1");
    w.unmount();
  });
});

describe("PreviewWindow — the header 行号 toggle", () => {
  function rigText(text: string, path = "/p/a.ts") {
    const win = fakeWindowHandle(1, { phase: "text", path, text, truncated: false, size: text.length });
    const face = fakeWindowsFace([win]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    mount(PreviewHost, {
      attachTo: host,
      global: { provide: { [PREVIEW_CTX as symbol]: { handle: face, plaintext: false } as PreviewContext } },
    });
    return { win, face };
  }

  it("shows in a text source view, toggles the shared pref + persists, re-renders the body", async () => {
    rigText("const x = 1;\nconst y = 2;");
    await tick();
    const btn = document.querySelector<HTMLButtonElement>(".pw-ln-btn")!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Line numbers");
    expect(btn.querySelector(".pw-ln-glyph")!.textContent).toBe("1#");
    expect(document.querySelectorAll(".pv-line")).toHaveLength(2);
    btn.click();
    await tick();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(LINE_NUMBERS_STORAGE_KEY)).toBe("0");
    expect(document.querySelectorAll(".pv-line")).toHaveLength(0);
    expect(document.querySelector(".preview-text-body")!.textContent).toBe("const x = 1;\nconst y = 2;");
    btn.click();
    await tick();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll(".pv-line")).toHaveLength(2);
  });

  it("stays hidden in the rendered-md view and on non-text phases", async () => {
    const { win } = rigText("# title\n\nbody", "/p/a.md");
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull(); // rendered by default
    expect(document.querySelector(".pw-ln-btn")).toBeNull();
    // switch to source ⇒ the toggle appears
    (document.querySelectorAll(".preview-toggle-btn")[1] as HTMLElement).click();
    await tick();
    expect(document.querySelector(".pw-ln-btn")).not.toBeNull();
    // a dir phase never offers it
    win.view.value = { phase: "closed" };
    await tick();
    expect(document.querySelector(".pw-ln-btn")).toBeNull();
  });
});

describe("node budget — 3000-line TS file, numbers on vs off", () => {
  it("numbered mode adds exactly one element per line (the gutter is CSS-only)", async () => {
    // ~5 token parts per line on average — kept under flattenTokens' HIGHLIGHT_MAX_TOKENS
    // budget so the highlight actually settles (a fatter line degrades BOTH modes to plain).
    const text = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? `const v${i} = ${i};` : `y${i}=${i}`)).join(
      "\n",
    );
    const countNodes = (root: Element): { elements: number; textNodes: number } => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let textNodes = 0;
      while (walker.nextNode()) textNodes++;
      return { elements: root.querySelectorAll("*").length, textNodes };
    };

    const on = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.ts", virtualEnabled: false },
      attachTo: document.body,
    });
    await waitFor(() => on.element.querySelector("span.tok-keyword") !== null);
    const onPre = on.get("pre.preview-text-body").element;
    const onCount = countNodes(onPre);
    expect(onPre.querySelectorAll(".pv-line")).toHaveLength(3000);
    expect(onPre.textContent).toBe(text);
    on.unmount();
    document.body.innerHTML = "";

    window.localStorage.setItem(LINE_NUMBERS_STORAGE_KEY, "0");
    const off = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.ts", virtualEnabled: false },
      attachTo: document.body,
    });
    await waitFor(() => off.element.querySelector("span.tok-keyword") !== null);
    const offCount = countNodes(off.get("pre.preview-text-body").element);
    off.unmount();

    // 主会话约束 ③: the report quotes these numbers.
    console.log(
      `[line-numbers] 3000-line TS highlight settled — elements on:${onCount.elements} off:${offCount.elements} ` +
        `(Δ ${onCount.elements - offCount.elements} = 1/line + 1 container), ` +
        `textNodes on:${onCount.textNodes} off:${offCount.textNodes}`,
    );
    // the gutter itself is zero-cost: the delta is exactly the per-line elements plus the
    // single `.pv-lines` container — render-function CodeLines, no template anchor nodes.
    expect(onCount.elements - offCount.elements).toBe(3001);
    // text nodes: cutting a PLAIN run that crosses a line boundary splits one text node
    // into two — bounded by one extra per line, no per-part anchor nodes (see CodeLines).
    expect(onCount.textNodes - offCount.textNodes).toBeGreaterThanOrEqual(0);
    expect(onCount.textNodes - offCount.textNodes).toBeLessThanOrEqual(3000);
  }, 15000);
});

describe("preview-perf P3 — the virtual source view (switch ON, §4.1/§4.8)", () => {
  /** N lines "L0001".."L####", all "\n"-terminated. */
  const linesText = (n: number): string =>
    Array.from({ length: n }, (_, i) => `L${String(i + 1).padStart(4, "0")}`).join("\n") + "\n";

  it(">600 lines (line numbers on) renders .pv-virtual; visible blocks equal the full-text slice", async () => {
    const text = linesText(700);
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.log", rowHeight: 20, viewportHeight: 400 },
      attachTo: document.body,
    });
    await tick(); // the window range lands after the mount patch flush
    const pre = wrapper.get("pre.preview-text-body.pv-virtual").element;
    const blocks = [...pre.querySelectorAll<HTMLElement>(".pv-vblock")];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(700 / 32);
    // first block is the file head; gutter numbering restarts per block at data-start − 1
    expect(blocks[0]!.dataset.start).toBe("1");
    expect(blocks[0]!.style.getPropertyValue("counter-reset")).toBe("pvline 0");
    const lines = [...blocks[0]!.querySelectorAll(".pv-line")];
    expect(lines).toHaveLength(32);
    for (let i = 0; i < 32; i++) expect(lines[i]!.textContent).toBe(`L${String(i + 1).padStart(4, "0")}\n`);
    // every mounted block's lines equal the corresponding slice of the FULL text (not a
    // subset): line k of block b carries its own terminator, byte-identical to lineText(k)
    for (const b of blocks) {
      const start = Number(b.dataset.start) - 1;
      const rows = [...b.querySelectorAll(".pv-line")];
      for (const [k, row] of rows.entries()) {
        expect(row.textContent).toBe(text.split("\n")[start + k] + "\n");
      }
    }
    // the copy channel still carries the WHOLE loaded text (textContent only has mounted lines)
    expect(wrapper.emitted("update:copyValue")).toEqual([[text]]);
    wrapper.unmount();
  });

  it("§5.1: the idle main-thread highlight lands on the virtual body (original gates, plain first)", async () => {
    const text = Array.from({ length: 700 }, (_, i) => (i % 2 === 0 ? `const v${i} = ${i};` : `x${i}=${i}`)).join("\n");
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.ts", rowHeight: 20, viewportHeight: 400 },
      attachTo: document.body,
    });
    await tick();
    const pre = wrapper.get("pre.pv-virtual").element;
    // first frame is PLAIN (one text node per line, no token spans)
    expect(pre.querySelectorAll("span.tok-keyword").length).toBe(0);
    // the idle scheduler (requestIdleCallback, setTimeout 50ms fallback) tokenizes once the
    // engine settles — 700 lines / <100 KiB sit INSIDE the original shouldHighlight gates
    await waitFor(() => pre.querySelectorAll("span.tok-keyword").length > 0);
    // highlighting never alters the text: every mounted line still equals its slice
    const block = pre.querySelector<HTMLElement>(".pv-vblock")!;
    const rows = [...block.querySelectorAll(".pv-line")] as HTMLElement[];
    for (const [k, row] of rows.entries()) expect(row.textContent).toBe(text.split("\n")[k] + "\n");
    wrapper.unmount();
  }, 15000);

  it("the r0 >8000 degrade is unreachable with the switch ON (>600 already virtual)", async () => {
    const text = linesText(8050);
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "a.log" },
      attachTo: document.body,
    });
    await tick();
    expect(wrapper.find("pre.pv-virtual").exists()).toBe(true);
    expect(wrapper.find(".preview-md-note").exists()).toBe(false); // no linesTooMany note
    wrapper.unmount();
  });

  describe("stream (always virtual, §4.8)", () => {
    class FakeIO2 {
      static instances: FakeIO2[] = [];
      readonly observed: Element[] = [];
      readonly options: IntersectionObserverInit;
      constructor(
        readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void,
        options: IntersectionObserverInit,
      ) {
        this.options = options;
        FakeIO2.instances.push(this);
      }
      observe(el: Element): void {
        this.observed.push(el);
      }
      disconnect(): void {}
    }

    function mkStream(over: Partial<PreviewTextStream> = {}): PreviewTextStream {
      return shallowReactive<PreviewTextStream>({
        ident: "i1.AAAAAAAAAAAAAAAAAAAAAA",
        total: 3 * 1024 * 1024,
        cap: 8 * 1024 * 1024,
        firstBytes: 256 * 1024,
        chunks: ["a\nb\nc\nd\n"],
        loaded: 256 * 1024,
        state: "more",
        autoRetries: 0,
        ...over,
      });
    }
    const mountVStream = (stream: PreviewTextStream, extra: Record<string, unknown> = {}) =>
      mount(PreviewText, {
        props: {
          text: stream.chunks[0]!,
          truncated: true,
          stream,
          filename: "x.log",
          path: "/p/x.log",
          rowHeight: 20,
          viewportHeight: 400,
          ...extra,
        },
        attachTo: document.body,
      });

    afterEach(() => {
      (FakeIO2 as unknown as { instances: FakeIO2[] }).instances = [];
    });

    it("numbering continues across chunks: block counter-reset + verbatim line text", async () => {
      const stream = mkStream();
      const w = mountVStream(stream);
      await tick();
      const pre = w.get("pre.pv-virtual").element as HTMLElement;
      const firstBlock = pre.querySelector<HTMLElement>(".pv-vblock")!;
      expect(firstBlock.dataset.start).toBe("1");
      expect(firstBlock.style.getPropertyValue("counter-reset")).toBe("pvline 0");
      expect((firstBlock.querySelectorAll(".pv-line")[0] as HTMLElement).textContent).toBe("a\n");
      stream.chunks = [...stream.chunks, "e\nf"];
      stream.state = "done";
      await tick();
      const block = w.get("pre.pv-virtual").element.querySelector<HTMLElement>(".pv-vblock")!;
      const rows = [...block.querySelectorAll(".pv-line")] as HTMLElement[];
      expect(rows.map((r) => r.textContent)).toEqual(["a\n", "b\n", "c\n", "d\n", "e\n", "f"]);
      w.unmount();
    });

    it("a §4.3.4 force cut MERGES back into one line in the virtual model (clip marker, not a split)", async () => {
      const big = "x".repeat(520 * 1024); // > SOURCE_FORCE_CHARS, no "\n" ⇒ forced cut
      const stream = mkStream({ chunks: [big] });
      const w = mountVStream(stream);
      await tick();
      stream.chunks = [...stream.chunks, "\ny\n"];
      stream.state = "done";
      await tick();
      const block = w.get("pre.pv-virtual").element.querySelector<HTMLElement>(".pv-vblock")!;
      const rows = [...block.querySelectorAll(".pv-line")] as HTMLElement[];
      expect(rows).toHaveLength(2); // one logical line + "y" — the segmenter's cut is invisible
      expect((rows[0]!.querySelector(".pv-vclip") as HTMLElement).dataset.clip).toBe(String(big.length - 4096));
      expect(rows[0]!.textContent).toBe("x".repeat(4096) + "\n"); // display prefix + terminator
      expect(rows[1]!.textContent).toBe("y\n");
      w.unmount();
    });

    it("the sentinel sits INSIDE the virtual scroll container and the IO root is that <pre>", async () => {
      vi.stubGlobal("IntersectionObserver", FakeIO2);
      const stream = mkStream();
      const w = mountVStream(stream);
      await tick();
      const pre = w.get("pre.pv-virtual").element as HTMLElement;
      const sentinel = w.get(".preview-stream-sentinel").element;
      expect(sentinel.parentElement).toBe(pre); // §4.8: after the spacer, inside the scroller
      const io = FakeIO2.instances.at(-1)!;
      expect(io.observed[0]).toBe(sentinel);
      expect(io.options.root).toBe(pre);
      expect(io.options.rootMargin).toBe("0px 0px 800px 0px");
      w.unmount();
      vi.unstubAllGlobals();
    });

    it("cap/changed/error state lines keep rendering in the actions row (regression)", async () => {
      for (const [state, frag] of [
        ["cap", "上限"],
        ["changed", "变更"],
        ["error", "失败"],
      ] as const) {
        const stream = mkStream({ state, error: "E_X" });
        const w = mountVStream(stream);
        await tick();
        const status = w.get(".preview-stream-status").text();
        expect(status).not.toBe("");
        expect(document.querySelector("pre.pv-virtual")).not.toBeNull();
        w.unmount();
        document.body.innerHTML = "";
        void frag;
      }
    });
  });
});
