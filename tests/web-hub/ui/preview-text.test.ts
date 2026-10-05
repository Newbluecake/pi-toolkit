// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";

/**
 * `PreviewText.vue` (web-hub-preview plan v3 §4.6, package PV5): monospace `<pre>` body, the
 * truncated badge + note, and a copy button that copies exactly the DISPLAYED part.
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
