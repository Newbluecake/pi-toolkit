// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// default-model plan F1 (A1, §9 #7): the desktop popover's width rule is a FROZEN literal —
// `min(720px, calc(100vw - 32px))`, the 32px written literally (never via a token) so the
// computed width is exactly `min(720, innerWidth − 32)` px at the 1440/1024/768 acceptance
// viewports. happy-dom never applies the stylesheet, so the declaration is pinned here (same
// source-pinning precedent as settings-view.test.ts's slider-immunity block); the computed-
// style half is the DevEye real-browser walkthrough (plan A1).
describe("SettingsOverlay desktop panel width (default-model plan F1 A1)", () => {
  it(".settings-panel is exactly min(720px, calc(100vw - 32px))", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui/src/styles/shell.css"),
      "utf8",
    );
    const block = /\.settings-panel\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/width:\s*min\(720px,\s*calc\(100vw - 32px\)\)\s*;/);
  });

  it("settings.css has the F1 card grid (theme+font side by side, wide cards span) and dropped the 640px cap", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui/src/styles/settings.css"),
      "utf8",
    );
    const inner = /\.settings-inner\s*\{([^}]*)\}/.exec(css);
    expect(inner).not.toBeNull();
    expect(inner![1]).not.toMatch(/max-width/);
    const grid = /\.settings-grid\s*\{([^}]*)\}/.exec(css);
    expect(grid).not.toBeNull();
    expect(grid![1]).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(300px,\s*1fr\)\)/);
    expect(css).toMatch(/\.settings-card-wide\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    // the model row's long provider/id must never overflow horizontally (A1)
    expect(css).toMatch(/\.settings-model-input\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
