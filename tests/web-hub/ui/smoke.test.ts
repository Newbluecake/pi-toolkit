// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, afterEach } from "vitest";
import App from "../../../src/web-hub/ui/src/App.vue";
import IconSprite from "../../../src/web-hub/ui/src/icons/IconSprite.vue";
import { ICON_NAMES } from "../../../src/web-hub/ui/src/icons/names.js";

/**
 * Mount-level smoke test (vue-plan.md v2.1 §5.2 — P0/P3): proves the whole build/mount pipeline
 * (SFC compile → `@vue/test-utils` mount → happy-dom render) actually works end-to-end. Updated
 * for the P3 shell (`App.vue` no longer renders the P0 "under construction" placeholder text):
 * asserts the real icon sprite plus the real auth-mode-unknown gate (see `app-gate.test.ts` for
 * the full auth-mode matrix this is a minimal cross-check of).
 */
describe("App.vue shell", () => {
  afterEach(() => {
    delete document.documentElement.dataset["authMode"];
  });

  it("mounts without throwing and renders the icon sprite", () => {
    const wrapper = mount(App);
    expect(wrapper.find("svg.sprite").exists()).toBe(true);
  });

  it("missing data-auth-mode renders the TokenGate auth-mode-unknown gate, not the P0 placeholder", () => {
    const wrapper = mount(App);
    expect(wrapper.find(".login-page").exists()).toBe(true);
    expect(wrapper.find("button.notice-action").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("under construction");
  });

  it("IconSprite.vue defines exactly one <symbol> per ICON_NAMES entry, no more, no fewer", () => {
    const wrapper = mount(IconSprite);
    const ids = wrapper.findAll("symbol").map((s) => s.attributes("id"));
    const expected = ICON_NAMES.map((n) => `i-${n}`);
    expect(ids.sort()).toEqual([...expected].sort());
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });

  it("every <symbol> has a viewBox and at least one path/circle/rect child", () => {
    const wrapper = mount(IconSprite);
    for (const symbol of wrapper.findAll("symbol")) {
      expect(symbol.attributes("viewBox")).toBeTruthy();
      const hasShape = symbol.find("path").exists() || symbol.find("circle").exists() || symbol.find("rect").exists();
      expect(hasShape, `symbol#${symbol.attributes("id")} has no drawable child`).toBe(true);
    }
  });
});
