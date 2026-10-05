// @vitest-environment happy-dom
/**
 * `ThemeToggle.vue` dropdown form (2026-10-05 user field report: the segmented radiogroup /
 * compact cycle button crowded the header — now a ghost icon trigger + menu at every width).
 * Menu semantics mirror `spawn/NewSessionMenu.vue` (aria-haspopup/expanded, Esc, outside click).
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ThemeToggle from "../../../src/web-hub/ui/src/components/shell/ThemeToggle.vue";

describe("ThemeToggle.vue dropdown", () => {
  it.each([
    ["system", "monitor"],
    ["light", "sun"],
    ["dark", "moon"],
  ] as const)("pref %s renders the %s icon on the trigger", (pref, icon) => {
    const wrapper = mount(ThemeToggle, { props: { modelValue: pref } });
    const trigger = wrapper.get("button.theme-trigger");
    expect(trigger.find("use").attributes("href")).toBe(`#i-${icon}`);
    expect(trigger.attributes("aria-haspopup")).toBe("menu");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".theme-menu").exists()).toBe(false);
  });

  it("clicking the trigger opens a menu with three menuitemradio options, active one checked", async () => {
    const wrapper = mount(ThemeToggle, { props: { modelValue: "system" }, attachTo: document.body });
    await wrapper.get("button.theme-trigger").trigger("click");
    expect(wrapper.get("button.theme-trigger").attributes("aria-expanded")).toBe("true");
    const items = wrapper.findAll('[role="menuitemradio"]');
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.attributes("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(items[0]!.find(".theme-menu-check").exists()).toBe(true);
    wrapper.unmount();
  });

  it("choosing an option emits update:modelValue and closes the menu", async () => {
    const wrapper = mount(ThemeToggle, { props: { modelValue: "system" }, attachTo: document.body });
    await wrapper.get("button.theme-trigger").trigger("click");
    await wrapper.findAll('[role="menuitemradio"]')[2]!.trigger("click"); // dark
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["dark"]);
    expect(wrapper.find(".theme-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("Escape closes without emitting; outside click closes", async () => {
    const wrapper = mount(ThemeToggle, { props: { modelValue: "light" }, attachTo: document.body });
    const trigger = wrapper.get("button.theme-trigger");
    await trigger.trigger("click");
    await trigger.trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".theme-menu").exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    await trigger.trigger("click");
    expect(wrapper.find(".theme-menu").exists()).toBe(true);
    document.body.click();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".theme-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("aria-label announces the current preference", () => {
    const wrapper = mount(ThemeToggle, { props: { modelValue: "dark" } });
    expect(wrapper.get("button.theme-trigger").attributes("aria-label")).toContain("Dark");
  });
});
