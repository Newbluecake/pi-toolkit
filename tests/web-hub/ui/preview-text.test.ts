// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";

/**
 * `PreviewText.vue` (web-hub-preview plan v3 §4.6, package PV5; dir-plan v3.1 §4.1/§4.3 PM):
 * monospace `<pre>` body, the truncated badge + note, a copy button that copies exactly the
 * DISPLAYED part — plus the markdown features: default rendered view (transcript's MdBlock),
 * rendered⇄source toggle (`aria-pressed`), truncated-md last-half-line drop, and the AST-node
 * budget's forced-source degradation.
 */

const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("PreviewText.vue", () => {
  it("renders the text in a <pre> (verbatim, whitespace preserved)", () => {
    const text = "line 1\n  indented\nline 3";
    const wrapper = mount(PreviewText, { props: { text, truncated: false } });
    expect(wrapper.get("pre.preview-text-body").text()).toBe(text);
    expect(wrapper.find(".preview-truncated").exists()).toBe(false);
  });

  it("shows the truncated badge + note only when truncated", () => {
    const wrapper = mount(PreviewText, { props: { text: "abc", truncated: true, sizeLabel: "256.0 KiB" } });
    const note = wrapper.get(".preview-truncated");
    expect(note.text()).toContain("Truncated");
    expect(note.text()).toContain("256.0 KiB");
  });

  it("the copy button copies the displayed text (never the path)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = mount(PreviewText, { props: { text: "shown part only", truncated: true } });
    await wrapper.get("button").trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("shown part only");
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

  it("non-md files keep the exact pre-change DOM (no toggle, no extra nodes)", () => {
    for (const [text, filename] of [
      ["line 1\nline 2", "notes.txt"],
      ['{"a":1}', undefined],
    ] as const) {
      const wrapper = mount(PreviewText, { props: { text, truncated: false, filename } });
      expect(wrapper.find(".preview-toggle").exists()).toBe(false);
      expect(wrapper.find(".preview-md").exists()).toBe(false);
      expect(wrapper.get("pre.preview-text-body").text()).toBe(text);
      expect(wrapper.findAll("button")).toHaveLength(1); // just the copy button
    }
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
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const wrapper = mount(PreviewText, {
      props: { text: "shown\nhalf", truncated: true, filename: "a.md", path: "/p/a.md" },
    });
    // copy button is the last button in the actions row (after the two toggle buttons)
    const copyBtn = wrapper.findAll("button").at(-1)!;
    await copyBtn.trigger("click");
    await flush();
    expect(writeText).toHaveBeenCalledWith("shown");
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
