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
});
