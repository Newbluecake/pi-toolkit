// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { shallowReactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewTextStream } from "../../../src/web-hub/ui/src/types.js";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";

/**
 * `PreviewText.vue` (web-hub-preview plan v3 §4.6, package PV5; dir-plan v3.1 §4.1/§4.3 PM):
 * monospace `<pre>` body, the truncated badge + note, the copy VALUE (exactly the DISPLAYED
 * part — published to PreviewHost's header via `update:copyValue` since 2026-10-20, when the
 * copy button moved out of this toolbar) — plus the markdown features: default rendered view
 * (transcript's MdBlock), rendered⇄source toggle (`aria-pressed`), truncated-md
 * last-half-line drop, and the AST-node budget's forced-source degradation.
 */

describe("PreviewText.vue", () => {
  it("renders the text in a <pre> (verbatim, whitespace preserved)", () => {
    const text = "line 1\n  indented\nline 3";
    const wrapper = mount(PreviewText, { props: { text, truncated: false } });
    expect(wrapper.get("pre.preview-text-body").text()).toBe(text);
    expect(wrapper.find(".preview-truncated").exists()).toBe(false);
  });

  it("shows the truncated badge + note only when truncated", () => {
    const wrapper = mount(PreviewText, {
      props: { text: "abc", truncated: true, loadedLabel: "256.0 KiB", totalLabel: "2.3 MiB" },
    });
    const note = wrapper.get(".preview-truncated");
    expect(note.text()).toContain("Truncated");
    expect(note.text()).toContain("256.0 KiB");
    expect(note.text()).toContain("2.3 MiB");
    // bug fix: "first {loaded} of {total}" — never the total as the shown amount
    expect(note.text()).toContain("first 256.0 KiB of 2.3 MiB");
  });

  it("publishes the copy value (the displayed text, never the path) via update:copyValue", async () => {
    const wrapper = mount(PreviewText, { props: { text: "shown part only", truncated: true } });
    expect(wrapper.emitted("update:copyValue")).toEqual([["shown part only"]]);
    // no copy button in this toolbar anymore (2026-10-20 — the header owns it); the bar itself
    // is hidden when empty (a plain non-md file has no other actions)
    expect(wrapper.find(".preview-text-actions").exists()).toBe(false);
    wrapper.unmount();
    expect(wrapper.emitted("update:copyValue")!.at(-1)).toEqual([null]);
  });

  it("L1: ANSI escapes are stripped from the display AND the copy value (terminal logs)", async () => {
    const text = "\u001b[36m==>\u001b[0m 正在安装…\n\u001b[1;32mOK\u001b[0m\n";
    const wrapper = mount(PreviewText, { props: { text, truncated: false, filename: "x.log", path: "/tmp/x.log" } });
    expect(wrapper.get("pre.preview-text-body").text()).toBe("==> 正在安装…\nOK"); // DOM text() trims the trailing newline
    expect(wrapper.emitted("update:copyValue")).toEqual([["==> 正在安装…\nOK\n"]]); // copy keeps the trailing newline
    wrapper.unmount();
  });
});

describe("PreviewText.vue — markdown (dir-plan §4.1, PM package)", () => {
  const toggle = (wrapper: ReturnType<typeof mount>, i: 0 | 1) => wrapper.findAll(".preview-toggle-btn")[i]!;

  it("a .md file defaults to the rendered view (MdBlock AST, no <pre>), toggle present", () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# Hi\n\nbody", truncated: false, filename: "README.md", path: "/p/README.md" },
    });
    expect(wrapper.find(".preview-md").exists()).toBe(true);
    expect(wrapper.find("pre.preview-text-body").exists()).toBe(false);
    // whitelist renderer: heading level 1 downgrades to h3 (transcript contract), prose intact
    expect(wrapper.get(".preview-md h3.md-h").text()).toBe("Hi");
    expect(wrapper.get(".preview-md p.md-p").text()).toBe("body");
    // B3 segmented buttons with aria-pressed; rendered pressed by default
    expect(wrapper.findAll(".preview-toggle-btn")).toHaveLength(2);
    expect(toggle(wrapper, 0).attributes("aria-pressed")).toBe("true");
    expect(toggle(wrapper, 1).attributes("aria-pressed")).toBe("false");
  });

  it("switching to source shows today's exact <pre> view; switching back re-renders", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# Hi", truncated: false, filename: "README.md", path: "/p/README.md" },
    });
    await toggle(wrapper, 1).trigger("click");
    expect(wrapper.find(".preview-md").exists()).toBe(false);
    expect(wrapper.get("pre.preview-text-body").text()).toBe("# Hi");
    expect(toggle(wrapper, 0).attributes("aria-pressed")).toBe("false");
    expect(toggle(wrapper, 1).attributes("aria-pressed")).toBe("true");
    await toggle(wrapper, 0).trigger("click");
    expect(wrapper.find(".preview-md").exists()).toBe(true);
  });

  it("L1: markdown strips ANSI before parsing (rendered and source views)", async () => {
    const wrapper = mount(PreviewText, {
      props: {
        text: "\u001b[36m# 标题\u001b[0m\n\n\u001b[1m正文\u001b[0m body",
        truncated: false,
        filename: "README.md",
        path: "/p/README.md",
      },
    });
    expect(wrapper.get(".preview-md h3.md-h").text()).toBe("标题");
    expect(wrapper.get(".preview-md p.md-p").text()).toBe("正文 body");
    await toggle(wrapper, 1).trigger("click");
    expect(wrapper.get("pre.preview-text-body").text()).toBe("# 标题\n\n正文 body");
  });

  it("non-md files keep the exact pre-change DOM (no toggle, no extra nodes)", () => {
    for (const [text, filename] of [
      ["line 1\nline 2", "notes.txt"],
      ['{"a":1}', undefined],
    ] as const) {
      const wrapper = mount(PreviewText, { props: { text, truncated: false, filename } });
      expect(wrapper.find(".preview-toggle").exists()).toBe(false);
      expect(wrapper.find(".preview-md").exists()).toBe(false);
      expect(wrapper.get("pre.preview-text-body").text()).toBe(text);
      expect(wrapper.findAll("button")).toHaveLength(0); // 2026-10-20: the copy button moved to the header
      expect(wrapper.find(".preview-text-actions").exists()).toBe(false); // …and an empty bar is hidden
    }
  });

  // web-hub-html-preview plan v2 §5 (P2): without PREVIEW_CTX/`html` cap a `.html` entry is
  // exactly this shape too — the render/source toggle, the iframe and the mint call are all
  // cap-gated (T-U2's no-cap half; the cap-present half lives in preview-html.test.ts).
  it("an .html path without the html cap keeps the same plain-source DOM (no toggle, no mint)", () => {
    const wrapper = mount(PreviewText, {
      props: { text: "<p>plain</p>", truncated: false, filename: "index.html", path: "/p/index.html" },
    });
    expect(wrapper.find(".preview-toggle").exists()).toBe(false);
    expect(wrapper.find(".preview-html").exists()).toBe(false);
    expect(wrapper.get("pre.preview-text-body").text()).toBe("<p>plain</p>");
    expect(wrapper.findAll("button")).toHaveLength(0); // 2026-10-20: the copy button moved to the header
  });

  it("a truncated md drops its incomplete final line and shows the render-specific note", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# Hi\nhalf lin", truncated: true, sizeLabel: "256.0 KiB", filename: "a.md", path: "/p/a.md" },
    });
    // the half line is gone from the RENDERED body and from the shown source alike
    expect(wrapper.get(".preview-md").text()).not.toContain("half");
    expect(wrapper.get(".preview-truncated").text()).toContain("incomplete");
    // source mode shows the prepared source (last line dropped) and the plain truncated note
    await toggle(wrapper, 1).trigger("click");
    expect(wrapper.get("pre.preview-text-body").text()).toBe("# Hi");
    expect(wrapper.get(".preview-truncated").text()).not.toContain("incomplete");
  });

  it("a truncated md with no newline keeps the (single) incomplete line, still noting it", () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# half heading", truncated: true, filename: "a.md", path: "/p/a.md" },
    });
    expect(wrapper.get(".preview-md").text()).toContain("half heading");
    expect(wrapper.get(".preview-truncated").text()).toContain("incomplete");
  });

  it("copy always takes the DISPLAYED part's source (truncated md ⇒ prepared text)", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: "shown\nhalf", truncated: true, filename: "a.md", path: "/p/a.md" },
    });
    // rendered mode by default — the published copy value is the prepared source either way
    expect(wrapper.emitted("update:copyValue")).toEqual([["shown"]]);
    // switching to source keeps the SAME copy value (the toolbar keeps only the toggle now)
    await toggle(wrapper, 1).trigger("click");
    expect(wrapper.emitted("update:copyValue")!.at(-1)).toEqual(["shown"]);
    expect(wrapper.findAll(".preview-text-actions button")).toHaveLength(2); // just the toggle pair
    wrapper.unmount();
  });

  it("mode survives a same-path content change (retry keeps the selection, B4)", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: "# one", truncated: false, filename: "a.md", path: "/p/a.md" },
    });
    await toggle(wrapper, 1).trigger("click");
    await wrapper.setProps({ text: "# two" });
    expect(wrapper.get("pre.preview-text-body").text()).toBe("# two");
  });

  it("over the AST-node budget (B7): forced source mode, note shown, rendered button disabled", () => {
    const wrapper = mount(PreviewText, {
      props: { text: "*a* ".repeat(30000), truncated: false, filename: "big.md", path: "/p/big.md" },
    });
    expect(wrapper.find(".preview-md").exists()).toBe(false);
    expect(wrapper.get("pre.preview-text-body").text()).toContain("*a* ");
    expect(wrapper.get(".preview-md-note").text()).toContain("too complex");
    expect(toggle(wrapper, 0).attributes("disabled")).toBeDefined();
    expect(toggle(wrapper, 1).attributes("aria-pressed")).toBe("true");
  });

  it("a normal large md (this repo's AGENTS.md shape) renders, not degrades", () => {
    const text = Array.from(
      { length: 2000 },
      (_, i) => `## Section ${i}\n\nsome *text* with a [link](https://x.example/${i})\n`,
    ).join("");
    const wrapper = mount(PreviewText, {
      props: { text, truncated: false, filename: "AGENTS.md", path: "/p/AGENTS.md" },
    });
    expect(wrapper.find(".preview-md").exists()).toBe(true);
    expect(wrapper.find(".preview-md-note").exists()).toBe(false);
    expect(toggle(wrapper, 0).attributes("disabled")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// chunked-plan §4.4–§4.6 / §6.3 (P2b): stream mode
// ---------------------------------------------------------------------------------------
describe("PreviewText.vue — chunked stream mode", () => {
  class FakeIO {
    static instances: FakeIO[] = [];
    readonly observed: Element[] = [];
    disconnected = false;
    constructor(
      readonly cb: (entries: Array<{ isIntersecting: boolean }>) => void,
      readonly options: IntersectionObserverInit,
    ) {
      FakeIO.instances.push(this);
    }
    observe(el: Element): void {
      this.observed.push(el);
    }
    disconnect(): void {
      this.disconnected = true;
    }
    fire(isIntersecting: boolean): void {
      this.cb([{ isIntersecting }]);
    }
  }
  const liveIO = (): FakeIO => FakeIO.instances.filter((i) => !i.disconnected).at(-1)!;

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIO.instances = [];
  });

  function mkStream(over: Partial<PreviewTextStream> = {}): PreviewTextStream {
    return shallowReactive<PreviewTextStream>({
      ident: "i1.AAAAAAAAAAAAAAAAAAAAAA",
      total: 3 * 1024 * 1024,
      cap: 8 * 1024 * 1024,
      firstBytes: 256 * 1024,
      chunks: ["a\nb\n"],
      loaded: 256 * 1024,
      state: "more",
      autoRetries: 0,
      ...over,
    });
  }
  const mountStream = (stream: PreviewTextStream, extra: Record<string, unknown> = {}) =>
    mount(PreviewText, {
      props: { text: stream.chunks[0]!, truncated: true, stream, filename: "x.log", path: "/p/x.log", ...extra },
      attachTo: document.body,
    });

  it("source view: segments are .preview-seg divs in a .preview-stream container with a sentinel; no top truncated note", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const stream = mkStream();
    const w = mountStream(stream);
    expect(w.find(".preview-truncated").exists()).toBe(false);
    expect(w.find("pre").exists()).toBe(false);
    const body = w.get(".preview-text-body.preview-stream");
    expect(body.attributes("tabindex")).toBe("0");
    expect(body.findAll(".preview-seg").map((e) => e.text())).toEqual(["a\nb"]); // the trailing "\n" is the consumed separator
    const sentinel = body.get(".preview-stream-sentinel");
    expect(sentinel.attributes("aria-hidden")).toBe("true");
    expect(sentinel.element.parentElement).toBe(body.element);
    w.unmount();
  });

  it("appending a chunk keeps the OLD segment elements (same node identity)", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const stream = mkStream({ chunks: ["l1\nl2\nl3"] });
    const w = mountStream(stream);
    const before = w.findAll(".preview-seg").map((e) => e.element);
    expect(before.map((e) => e.textContent)).toEqual(["l1\nl2"]);
    stream.chunks = [...stream.chunks, "\nl4\nl5"];
    await w.vm.$nextTick();
    const after = w.findAll(".preview-seg").map((e) => e.element);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]!.textContent).toBe("l3\nl4");
    w.unmount();
  });

  it("done flushes the pending tail; status text disappears; observer disconnects; copy = consumed source", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const stream = mkStream({ chunks: ["a\n\nb\nc"] });
    const w = mountStream(stream);
    expect(w.find(".preview-stream-status").exists()).toBe(true);
    stream.chunks = [...stream.chunks, "\nd\n"];
    stream.state = "done";
    await w.vm.$nextTick();
    expect(w.find(".preview-stream-status").exists()).toBe(false);
    expect(liveIO()).toBeUndefined();
    // the published copy value is the consumed source (header button reads this, 2026-10-20)
    expect(w.emitted("update:copyValue")!.at(-1)).toEqual(["a\n\nb\nc\nd\n"]);
    // a terminal (done) non-md stream leaves the actions bar EMPTY ⇒ it is hidden
    expect(w.find(".preview-text-actions").exists()).toBe(false);
    w.unmount();
  });

  it("L1: an escape sequence split across chunk boundaries leaves no residue (display + copy)", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    // chunk 1 ends INSIDE `\u001b[36m`; chunk 2 completes it — the cut may also split a CJK char
    const stream = mkStream({ chunks: ["\u001b[36m==>\u001b[0m line one\nline two \u001b[3"] });
    const w = mountStream(stream);
    expect(w.findAll(".preview-seg").map((e) => e.text())).toEqual(["==> line one"]); // `\u001b[3` held back
    stream.chunks = [...stream.chunks, "6m彩色\u001b[0m tail\n"];
    await w.vm.$nextTick();
    stream.state = "done";
    await w.vm.$nextTick();
    expect(w.findAll(".preview-seg").map((e) => e.text())).toEqual(["==> line one", "line two 彩色 tail"]);
    expect(w.emitted("update:copyValue")!.at(-1)).toEqual(["==> line one\nline two 彩色 tail\n"]);
    w.unmount();
  });

  it("IO: observes the sentinel under the scroll container with an 800px bottom margin; intersecting ⇒ load-more", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const w = mountStream(mkStream());
    const io = liveIO();
    expect(io.options.rootMargin).toBe("0px 0px 800px 0px");
    expect(io.options.root).toBe(w.get(".preview-stream").element);
    expect(io.observed[0]).toBe(w.get(".preview-stream-sentinel").element);
    io.fire(false);
    expect(w.emitted("load-more")).toBeUndefined();
    io.fire(true);
    expect(w.emitted("load-more")).toHaveLength(1);
    w.unmount();
    expect(io.disconnected).toBe(true);
  });

  it("returning to `more` while the sentinel is still visible re-emits load-more", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const stream = mkStream();
    const w = mountStream(stream);
    liveIO().fire(true);
    expect(w.emitted("load-more")).toHaveLength(1);
    stream.state = "loading";
    await w.vm.$nextTick();
    stream.state = "more";
    await w.vm.$nextTick();
    expect(w.emitted("load-more")).toHaveLength(2);
    w.unmount();
  });

  it("works without IntersectionObserver; the 加载更多 button is always there and disabled while loading", async () => {
    const stream = mkStream();
    const w = mountStream(stream);
    const btn = () => w.get(".preview-stream-btn");
    expect(btn().text()).toBe("Load more");
    expect(btn().attributes("disabled")).toBeUndefined();
    await btn().trigger("click");
    expect(w.emitted("load-more")).toHaveLength(1);
    stream.state = "loading";
    await w.vm.$nextTick();
    expect(btn().attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("status line per state (progress / loading / waiting / cap / changed / error) + the right action buttons", async () => {
    const stream = mkStream();
    const w = mountStream(stream);
    const status = () => w.find(".preview-stream-status").text();
    expect(status()).toBe("Loaded 256 KiB / 3.0 MiB");
    stream.state = "loading";
    await w.vm.$nextTick();
    expect(status()).toBe("Loading next part…");
    stream.state = "waiting";
    stream.retryAt = Date.now() + 2000;
    await w.vm.$nextTick();
    expect(status()).toMatch(/^Server busy, retrying in [12]s…$/);
    stream.state = "cap";
    await w.vm.$nextTick();
    expect(status()).toContain("preview limit reached");
    expect(w.find(".preview-stream-btn").exists()).toBe(false);
    stream.state = "changed";
    await w.vm.$nextTick();
    expect(status()).toContain("changed during preview");
    await w.get(".preview-stream-btn").trigger("click");
    expect(w.emitted("reopen")).toHaveLength(1);
    stream.state = "error";
    stream.error = "E_DEADLINE";
    stream.retryable = true;
    await w.vm.$nextTick();
    expect(status()).toContain("E_DEADLINE");
    await w.get(".preview-stream-btn").trigger("click");
    expect(w.emitted("retry-stream")).toHaveLength(1);
    stream.retryable = false;
    await w.vm.$nextTick();
    expect(w.find(".preview-stream-btn").exists()).toBe(false);
    w.unmount();
  });

  it("markdown: rendered view segments per top-level block; over-budget block degrades alone; toggle re-observes", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const stream = mkStream({ chunks: ["# One\n\npara\n\n```js\nx\n\ny\n```\n\ntail"] });
    const w = mountStream(stream, { filename: "R.md", path: "/p/R.md", text: stream.chunks[0] });
    expect(w.find(".preview-md.preview-stream").exists()).toBe(true);
    const segs = w.findAll(".preview-seg");
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(w.find(".preview-seg h3.md-h").text()).toBe("One");
    const first = w.get(".preview-seg").element;
    stream.chunks = [...stream.chunks, "\n\nmore\n\nend"];
    await w.vm.$nextTick();
    expect(w.get(".preview-seg").element).toBe(first); // old segment never re-patched
    // B7 is a non-stream rule: the rendered button stays enabled
    expect(w.findAll(".preview-toggle-btn")[0]!.attributes("disabled")).toBeUndefined();
    const ioBefore = liveIO();
    await w.findAll(".preview-toggle-btn")[1]!.trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.find(".preview-text-body.preview-stream").exists()).toBe(true);
    expect(liveIO()).not.toBe(ioBefore);
    expect(w.get(".preview-stream-sentinel").element).toBe(liveIO().observed[0]);
    w.unmount();
  });

  it("markdown stop-flush marks the tail incomplete", async () => {
    const stream = mkStream({ chunks: ["para one\n\npara two partial"], state: "more" });
    const w = mountStream(stream, { filename: "R.md", path: "/p/R.md" });
    stream.state = "cap";
    await w.vm.$nextTick();
    expect(w.text()).toContain("The ending may be incomplete");
    w.unmount();
  });

  it("non-stream DOM is unchanged: <pre> body, top note, no stream bits", () => {
    const w = mount(PreviewText, { props: { text: "x", truncated: true, loadedLabel: "1 B", totalLabel: "2 B" } });
    expect(w.find("pre.preview-text-body").exists()).toBe(true);
    expect(w.find(".preview-truncated").exists()).toBe(true);
    expect(w.find(".preview-stream-sentinel").exists()).toBe(false);
    expect(w.find(".preview-stream-status").exists()).toBe(false);
  });
});
