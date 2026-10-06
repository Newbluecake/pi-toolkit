// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";

/** Gear = toggle (user 2026-10): second click while `#/settings` shows closes it. */
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
  it("first click (not on settings) lets the href navigate and marks no aria-current", async () => {
    setHash("#/agent/a1");
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get("a.settings-link");
    expect(gear.attributes("aria-current")).toBeUndefined();
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    gear.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it("second click after opening in-app goes history.back()", async () => {
    setHash("#/agent/a1");
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get("a.settings-link");
    gear.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    setHash("#/settings");
    await wrapper.vm.$nextTick();
    expect(gear.attributes("aria-current")).toBe("page");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    gear.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("deep-linked #/settings: click replaces to #/ instead of leaving the app", async () => {
    setHash("#/settings");
    const wrapper = mount(TopBar, { props: baseProps });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    wrapper.get("a.settings-link").element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("#/");
    wrapper.unmount();
  });

  it("modifier / non-left clicks are never intercepted, even on settings", () => {
    setHash("#/settings");
    const wrapper = mount(TopBar, { props: baseProps });
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    const gear = wrapper.get("a.settings-link").element;
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
      gear.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(replace).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("matches the router exactly: #/settings/foo is not the settings page", async () => {
    setHash("#/settings/foo");
    const wrapper = mount(TopBar, { props: baseProps });
    expect(wrapper.get("a.settings-link").attributes("aria-current")).toBeUndefined();
    wrapper.unmount();
  });

  it("leaving settings by other means resets the in-app flag (next close replaces)", async () => {
    setHash("#/agent/a1");
    const wrapper = mount(TopBar, { props: baseProps });
    const gear = wrapper.get("a.settings-link");
    gear.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    setHash("#/settings");
    setHash("#/agent/a1"); // left via SettingsView's own back button
    setHash("#/settings"); // re-entered without the gear (e.g. browser forward)
    await wrapper.vm.$nextTick();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
    gear.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("#/");
    wrapper.unmount();
  });
});
