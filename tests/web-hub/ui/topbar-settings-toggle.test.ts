// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";

/**
 * Settings gear toggle (revised 2026-10 field report: settings is a floating panel, not a
 * route — opening it no longer unmounts the session view behind it). The gear is a plain
 * `aria-expanded`/`aria-controls` toggle button that mounts/unmounts `SettingsOverlay.vue`;
 * an old `#/settings` deep link (or hash edited while the app is already running) opens the
 * panel and is immediately replaced with `#/`.
 */
const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

function setHash(h: string): void {
  window.location.hash = h;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

afterEach(() => {
  vi.restoreAllMocks();
  setHash("#/");
});

describe("TopBar settings gear toggle", () => {
  it("is a plain button (not a link) — no more href-based navigation", () => {
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get(".settings-link");
    expect(gear.element.tagName).toBe("BUTTON");
    expect(gear.attributes("href")).toBeUndefined();
    wrapper.unmount();
  });

  it("starts closed, aria-expanded false, no panel mounted", () => {
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get(".settings-link");
    expect(gear.attributes("aria-expanded")).toBe("false");
    expect(gear.attributes("aria-controls")).toBe("settings-panel");
    expect(wrapper.find("#settings-panel").exists()).toBe(false);
    wrapper.unmount();
  });

  it("click opens the panel (aria-expanded true, panel mounted); click again closes it", async () => {
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get(".settings-link");
    await gear.trigger("click");
    expect(gear.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find("#settings-panel").exists()).toBe(true);
    await gear.trigger("click");
    expect(gear.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find("#settings-panel").exists()).toBe(false);
    wrapper.unmount();
  });

  it("the panel's own close emit closes it and aria-expanded flips back to false", async () => {
    const wrapper = mount(TopBar, { props: baseProps });
    await wrapper.get(".settings-link").trigger("click");
    expect(wrapper.find("#settings-panel").exists()).toBe(true);
    await wrapper.find("button.settings-close").trigger("click");
    expect(wrapper.find("#settings-panel").exists()).toBe(false);
    expect(wrapper.get(".settings-link").attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("deep-linked #/settings: panel opens on mount and the hash is replaced with #/", async () => {
    setHash("#/settings");
    const replace = vi.spyOn(window.history, "replaceState");
    const wrapper = mount(TopBar, { props: baseProps });
    expect(wrapper.get(".settings-link").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find("#settings-panel").exists()).toBe(true);
    expect(replace).toHaveBeenCalledWith(null, "", "#/");
    wrapper.unmount();
  });

  it("matches the router exactly: #/settings/foo never opens the panel on mount", () => {
    setHash("#/settings/foo");
    const wrapper = mount(TopBar, { props: baseProps });
    expect(wrapper.get(".settings-link").attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("hash becoming #/settings WHILE the app is already running opens the panel and replaces the hash", async () => {
    const wrapper = mount(TopBar, { props: baseProps });
    const replace = vi.spyOn(window.history, "replaceState");
    setHash("#/settings");
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".settings-link").attributes("aria-expanded")).toBe("true");
    expect(replace).toHaveBeenCalledWith(null, "", "#/");
    wrapper.unmount();
  });

  it("a hashchange to a non-settings hash never opens the panel", async () => {
    const wrapper = mount(TopBar, { props: baseProps });
    setHash("#/agent/a1");
    await wrapper.vm.$nextTick();
    expect(wrapper.get(".settings-link").attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });
});
