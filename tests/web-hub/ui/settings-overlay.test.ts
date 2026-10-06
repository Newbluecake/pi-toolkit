// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsOverlay from "../../../src/web-hub/ui/src/components/shell/SettingsOverlay.vue";

/**
 * `shell/SettingsOverlay.vue` (floating settings panel, revised 2026-10 field report): desktop
 * renders a small non-modal `role="dialog"` popover (Esc / outside-click close, focus-in on
 * open, focus-return to the gear on close); phones delegate to `control/PickerSheet.vue`
 * (imported unmodified — its own scrim/focus-trap/scroll-lock/Esc apply). happy-dom's
 * `matchMedia` always reports no match, so `mobile` is `false` here unless stubbed — i.e. every
 * test below exercises the desktop branch unless it opts into the mobile stub.
 */

function stubMatchMedia(mobile: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)" ? mobile : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsOverlay.vue — desktop popover", () => {
  it("renders a non-modal role=dialog panel labelled by the settings title, not the mobile sheet", () => {
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    const panel = wrapper.get('[role="dialog"]');
    expect(panel.attributes("id")).toBe("settings-panel");
    expect(panel.attributes("aria-labelledby")).toBe("settings-panel-title");
    expect(panel.attributes("aria-modal")).toBeUndefined(); // non-modal per spec
    expect(wrapper.find(".picker-scrim").exists()).toBe(false);
    wrapper.unmount();
  });

  it("moves focus into the panel on mount", async () => {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);
    wrapper.unmount();
    anchorEl.remove();
  });

  it("Escape emits close with preventDefault (so a global handler sees defaultPrevented)", () => {
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("a pointerdown outside the panel AND outside the anchor emits close AND preventDefault()s (P1 fix: a real browser's own mousedown-focus-steal default action would otherwise win the race against the `anchorEl.focus()` call below, since it is a synchronous default action of THIS pointerdown rather than a later microtask — confirmed via real Chromium repro, not reproducible in happy-dom)", () => {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    const ev = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
    wrapper.unmount();
    anchorEl.remove();
    outside.remove();
  });

  it("restores focus to anchorEl after an outside-click close (preventDefault on the triggering pointerdown is what makes this reliable in a real browser — see the code comment)", async () => {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 0));
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(wrapper.emitted("close")).toHaveLength(1);
    // Mounting SettingsOverlay standalone (no TopBar parent) means emitting `close` does not by
    // itself unmount it — that is normally the parent's `v-if="open"` reacting to the event.
    // Simulate that reaction here (same pattern the pre-existing "restores focus to anchorEl on
    // unmount" test above already uses) so `onUnmounted`'s focus-restore logic actually runs.
    wrapper.unmount();
    expect(document.activeElement).toBe(anchorEl);
    anchorEl.remove();
    outside.remove();
  });

  it("a pointerdown on the anchor (the gear) does NOT emit close (its own click handler toggles instead)", () => {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    anchorEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
    anchorEl.remove();
  });

  it("a pointerdown inside the panel does NOT emit close", async () => {
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    const inner = wrapper.get(".settings-option");
    inner.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });

  it("restores focus to anchorEl on unmount (close)", async () => {
    const anchorEl = document.createElement("button");
    document.body.appendChild(anchorEl);
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    await new Promise((r) => setTimeout(r, 0));
    wrapper.unmount();
    expect(document.activeElement).toBe(anchorEl);
    anchorEl.remove();
  });

  it("SettingsView's own close button (×) bubbles up as the overlay's close", async () => {
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    await wrapper.find("button.settings-close").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("SettingsOverlay.vue — mobile sheet (delegates to PickerSheet)", () => {
  it("renders the PickerSheet scrim/sheet instead of the desktop dialog (Teleport'd to <body>)", () => {
    stubMatchMedia(true);
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    expect(document.body.querySelector(".picker-scrim")).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"][aria-labelledby="settings-panel-title"]')).toBeNull();
    wrapper.unmount();
  });

  it("scrim click closes (PickerSheet's own contract) and SettingsOverlay forwards it", async () => {
    stubMatchMedia(true);
    const anchorEl = document.createElement("button");
    const wrapper = mount(SettingsOverlay, { props: { anchorEl }, attachTo: document.body });
    const scrim = document.body.querySelector(".picker-scrim");
    expect(scrim).not.toBeNull();
    scrim!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
