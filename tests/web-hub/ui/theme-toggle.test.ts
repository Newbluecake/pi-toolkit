// @vitest-environment happy-dom
/**
 * `ThemeToggle.vue` compact mode (ui-design.md §3.9, vue-plan.md v2.1 §3.9 — P3): on ≤480px the
 * segmented radiogroup collapses into a single icon button (monitor/sun/moon per current pref)
 * whose accessible name announces the current and next state. Regression for the W3 finding where
 * the compact button rendered the first letter of the localized label ("S") instead of an icon.
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThemeToggle from "../../../src/web-hub/ui/src/components/shell/ThemeToggle.vue";

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeToggle.vue compact (≤480px)", () => {
  it.each([
    ["system", "monitor"],
    ["light", "sun"],
    ["dark", "moon"],
  ] as const)("pref %s renders the %s icon and no text label", (pref, icon) => {
    stubMatchMedia(true);
    const wrapper = mount(ThemeToggle, { props: { modelValue: pref } });
    const button = wrapper.find("button");
    expect(button.find("use").attributes("href")).toBe(`#i-${icon}`);
    expect(button.text()).toBe("");
    expect(button.attributes("aria-label")).toMatch(/→/);
  });

  it("clicking cycles to the next preference", async () => {
    stubMatchMedia(true);
    const wrapper = mount(ThemeToggle, { props: { modelValue: "system" } });
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["light"]);
  });

  it("wide screens keep the three-button radiogroup", () => {
    stubMatchMedia(false);
    const wrapper = mount(ThemeToggle, { props: { modelValue: "dark" } });
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(true);
    expect(wrapper.findAll('[role="radio"]')).toHaveLength(3);
  });
});
