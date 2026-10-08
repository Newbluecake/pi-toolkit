// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ThinkingBlock from "../../../src/web-hub/ui/src/components/transcript/ThinkingBlock.vue";

/**
 * `ThinkingBlock.vue` live-display + auto-collapse (transcript-improvements task, item ②).
 * `live` mirrors `TxAssistant.vue`'s "this is the block currently streaming" derivation — tested
 * here directly against the prop rather than through the full streaming pipeline.
 */

const SHORT_TEXT = "a short thought\nacross two lines";
const LONG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i} of a long chain of thought`).join("\n");

describe("ThinkingBlock.vue", () => {
  it("is expanded while live, even for long text", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
    expect(wrapper.get("details").attributes("open")).toBeDefined();
  });

  it("auto-collapses long text once it stops being live", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
    expect(wrapper.get("details").attributes("open")).toBeDefined();
    await wrapper.setProps({ live: false });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
  });

  it("keeps short text open even after it stops being live", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    await wrapper.setProps({ live: false });
    expect(wrapper.get("details").attributes("open")).toBeDefined();
  });

  it("a non-live, never-streamed long block renders collapsed by default (history replay)", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: false } });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
  });

  it("a non-live, never-streamed short block renders open by default", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: false } });
    expect(wrapper.get("details").attributes("open")).toBeDefined();
  });

  it("manually collapsing a live block overrides the forced-open and survives it staying live", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    await wrapper.get("summary").trigger("click");
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    // still live, text keeps growing — the user's manual collapse is not re-opened by the model
    await wrapper.setProps({ text: SHORT_TEXT + "\nmore" });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
  });

  it("manually expanding a finished long block overrides the auto-collapse", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: false } });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await wrapper.get("summary").trigger("click");
    expect(wrapper.get("details").attributes("open")).toBeDefined();
  });

  it("a manual override during streaming also sticks once the block finishes (not re-collapsed)", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: LONG_TEXT, live: true } });
    await wrapper.get("summary").trigger("click"); // user collapses while live
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await wrapper.setProps({ live: false }); // thinking ends — would normally auto-collapse anyway
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await wrapper.get("summary").trigger("click"); // user re-opens after it finished
    expect(wrapper.get("details").attributes("open")).toBeDefined();
  });

  it("never renders thinking text as markdown (plain text node only)", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: "**not bold** <b>not html</b>", live: false } });
    expect(wrapper.get(".thinking-text").text()).toBe("**not bold** <b>not html</b>");
    expect(wrapper.html()).not.toContain("<b>not html</b>");
  });
  it("trims the trailing blank lines models append (no visible empty line, correct line count)", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: "\nfirst line\nsecond line\n\n", live: false } });
    expect(wrapper.get(".thinking-text").element.textContent).toBe("first line\nsecond line");
    expect(wrapper.get("summary").text()).toContain("2");
  });

  /* --- streaming follow (2026-10-08): live blocks pin the capped panel to the newest line;
   * a USER scroll away from the bottom stops the follow, scrolling back resumes it, and the
   * follow's own scrollTop write must not count as a user gesture (one-shot suppress token).
   * happy-dom does not do layout, so scrollHeight/clientHeight are stubbed per element. */
  function stubBox(el: Element, box: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => box.scrollTop,
      set: (v: number) => {
        box.scrollTop = v;
      },
    });
  }

  it("follows the newest line while live and near the bottom", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    const el = wrapper.get(".thinking-text").element;
    const box = { scrollHeight: 1000, clientHeight: 320, scrollTop: 0 };
    stubBox(el, box);
    await wrapper.setProps({ text: SHORT_TEXT + "\nnew line" });
    expect(box.scrollTop).toBe(1000); // pinned to the bottom
  });

  it("the follow write's own scroll event does not unregister as a user scroll", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    const el = wrapper.get(".thinking-text").element;
    const box = { scrollHeight: 1000, clientHeight: 320, scrollTop: 0 };
    stubBox(el, box);
    await wrapper.setProps({ text: SHORT_TEXT + "\nline" }); // follow writes scrollTop
    el.dispatchEvent(new Event("scroll")); // the write's own event: consumed by the suppress token
    await wrapper.setProps({ text: SHORT_TEXT + "\nline\nmore" });
    expect(box.scrollTop).toBe(1000); // still following
  });

  it("stops following after the user scrolls up, resumes when scrolled back to the bottom", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    const el = wrapper.get(".thinking-text").element;
    const box = { scrollHeight: 1000, clientHeight: 320, scrollTop: 0 };
    stubBox(el, box);
    await wrapper.setProps({ text: SHORT_TEXT + "\nline" });
    el.dispatchEvent(new Event("scroll")); // consume the follow write's event
    // user scrolls up (distance from bottom 400 > threshold)
    box.scrollTop = 280;
    el.dispatchEvent(new Event("scroll"));
    box.scrollHeight = 1400;
    await wrapper.setProps({ text: SHORT_TEXT + "\nline\nmore\nmore" });
    expect(box.scrollTop).toBe(280); // untouched — the user's reading position wins
    // user scrolls back to the bottom → follow resumes
    box.scrollTop = 1400 - 320;
    el.dispatchEvent(new Event("scroll"));
    box.scrollHeight = 1800;
    await wrapper.setProps({ text: SHORT_TEXT + "\nline\nmore\nmore\nagain" });
    expect(box.scrollTop).toBe(1800);
  });

  it("never follows once the block is no longer live", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: SHORT_TEXT, live: true } });
    const el = wrapper.get(".thinking-text").element;
    const box = { scrollHeight: 1000, clientHeight: 320, scrollTop: 0 };
    stubBox(el, box);
    await wrapper.setProps({ live: false });
    box.scrollTop = 0;
    await wrapper.setProps({ text: SHORT_TEXT + "\nlate" });
    expect(box.scrollTop).toBe(0);
  });
});
