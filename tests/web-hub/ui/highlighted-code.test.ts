// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import HighlightedCode from "../../../src/web-hub/ui/src/components/shared/HighlightedCode.vue";
import CodeBlock from "../../../src/web-hub/ui/src/components/transcript/CodeBlock.vue";

/**
 * `HighlightedCode.vue` + its PreviewText/CodeBlock integration (syntax-highlight package,
 * 2026-10): Prism loads through a dynamic `import()`; until it settles the DOM is the exact
 * pre-highlight plain-text DOM, and once loaded the token tree renders as VNode
 * `<span class="tok-*">` — never v-html — so hostile file content stays inert text.
 *
 * Direct `HighlightedCode` mounts query the HOST element's DOM (not VTU wrappers): the
 * component's root is a text node pre-highlight and a span fragment after, which VTU's
 * `wrapper.element` tracks unreliably — the browser DOM is the ground truth here.
 */

const JS_SNIPPET = "const x = 1;\n// done";

function mountOnHost(props: { text: string; lang?: string | null }): { host: HTMLElement; app: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mount(HighlightedCode, { props, attachTo: host });
  return { host, app: host.querySelector<HTMLElement>("div[data-v-app]")! };
}

/** Wait until `cond()` holds (real timers — the debounce + dynamic import are both real). */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  // NOTE: vitest's vi.waitFor retries while the callback THROWS — a `false` return resolves
  // it immediately. Assert inside instead.
  await vi.waitFor(
    () => {
      expect(cond()).toBe(true);
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

const textNodeOnly = (el: Element): boolean =>
  el.childNodes.length === 1 && el.childNodes[0]!.nodeType === Node.TEXT_NODE;

describe("HighlightedCode.vue", () => {
  it("renders the plain-text DOM (single text node) before the lazy chunk arrives", () => {
    const { app } = mountOnHost({ text: JS_SNIPPET, lang: "javascript" });
    expect(app.textContent).toBe(JS_SNIPPET);
    expect(app.querySelectorAll("span").length).toBe(0);
    expect(textNodeOnly(app)).toBe(true);
  });

  it("highlights after the lazy load + debounce: tok-* spans appear, text stays identical", async () => {
    const { host } = mountOnHost({ text: JS_SNIPPET, lang: "javascript" });
    await waitFor(() => host.querySelector("span.tok-keyword") !== null);
    expect(host.querySelector("span.tok-keyword")!.textContent).toBe("const");
    expect(host.querySelector("span.tok-comment")).not.toBeNull();
    // highlighting must not alter the visible text — concatenation is byte-identical
    expect(host.textContent).toBe(JS_SNIPPET);
  });

  it("never creates elements from code content: <script> stays an inert text node (no v-html)", async () => {
    const hostile = 'const s = "<script>alert(1)</script>";';
    const { host } = mountOnHost({ text: hostile, lang: "javascript" });
    await waitFor(() => host.querySelectorAll("span").length > 0);
    expect(host.textContent).toBe(hostile);
    expect(host.querySelector("script")).toBeNull(); // no <script> ELEMENT was created
  });

  it("unknown language ⇒ plain text forever (even after the engine loads)", async () => {
    const { host } = mountOnHost({ text: "?? nope ??", lang: "brainfuck" });
    await new Promise((r) => setTimeout(r, 400)); // engine + debounce window well past
    expect(host.querySelectorAll("span").length).toBe(0);
    expect(host.textContent).toBe("?? nope ??");
  });

  it("degrades huge texts to plain (100 KiB gate — never tokenizes, never blocks)", async () => {
    const big = `const x = 1;\n`.repeat(9000); // ~117 KB > HIGHLIGHT_MAX_BYTES
    const { host } = mountOnHost({ text: big, lang: "javascript" });
    await new Promise((r) => setTimeout(r, 400)); // engine + debounce window well past
    expect(host.querySelectorAll("span").length).toBe(0);
    expect(host.textContent).toBe(big);
  });

  it("streaming: rapid text changes render the LATEST text plain, highlight only the settled tail", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const wrapper = mount(HighlightedCode, { props: { text: "const a", lang: "javascript" }, attachTo: host });
    await wrapper.setProps({ text: "const a =" });
    await wrapper.setProps({ text: "const a = 1;" });
    // mid-stream the latest text must be visible verbatim (plain), not a stale highlight
    expect(host.textContent).toBe("const a = 1;");
    await waitFor(() => host.querySelector("span.tok-number") !== null);
    expect(host.querySelector("span.tok-number")!.textContent).toBe("1");
    expect(host.textContent).toBe("const a = 1;");
  });
});

describe("CodeBlock.vue — highlight integration", () => {
  it("keeps header/tabindex/translate and highlights js fences after the lazy load", async () => {
    const wrapper = mount(CodeBlock, { props: { lang: "js", text: JS_SNIPPET } });
    const pre = wrapper.get("pre");
    expect(pre.attributes("tabindex")).toBe("0");
    expect(pre.attributes("translate")).toBe("no");
    expect(wrapper.get(".codeblock-head span").text()).toBe("js"); // header still the raw fence lang
    await waitFor(() => wrapper.find("pre code span.tok-keyword").exists());
    expect(wrapper.get("pre code").text()).toBe(JS_SNIPPET);
  });

  it("unknown fence lang keeps the pre-highlight DOM (single text node in <code>)", async () => {
    const wrapper = mount(CodeBlock, { props: { lang: "brainfuck", text: "+++---" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(textNodeOnly(wrapper.get("pre code").element)).toBe(true);
  });

  it("the copy button still copies the ORIGINAL text once highlighted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = mount(CodeBlock, { props: { lang: "js", text: JS_SNIPPET } });
    await waitFor(() => wrapper.find("span.tok-keyword").exists());
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(JS_SNIPPET));
  });
});

describe("PreviewText.vue — filename-driven highlight", () => {
  it("renders the plain pre DOM without a filename prop (back-compat)", async () => {
    const wrapper = mount(PreviewText, { props: { text: "const x = 1;", truncated: false } });
    await new Promise((r) => setTimeout(r, 300));
    const pre = wrapper.get("pre.preview-text-body");
    expect(pre.attributes("tabindex")).toBe("0");
    expect(textNodeOnly(pre.element)).toBe(true);
  });

  it("highlights by file extension (a.ts ⇒ typescript) once the lazy chunk lands", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: JS_SNIPPET, truncated: false, filename: "a.ts" },
    });
    await waitFor(() => wrapper.find("pre.preview-text-body span.tok-keyword").exists());
    expect(wrapper.get("pre.preview-text-body").text()).toBe(JS_SNIPPET);
  });

  it("unknown extension (a.txt) stays plain; truncation badge is unaffected", async () => {
    const wrapper = mount(PreviewText, {
      props: { text: JS_SNIPPET, truncated: true, sizeLabel: "256.0 KiB", filename: "a.txt" },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(wrapper.findAll("pre span").length).toBe(0);
    expect(wrapper.get(".preview-truncated").text()).toContain("256.0 KiB");
    expect(wrapper.get("pre.preview-text-body").text()).toBe(JS_SNIPPET);
  });
});
