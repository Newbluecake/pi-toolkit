// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../../../src/web-hub/ui/src/App.vue";
import IconSprite from "../../../src/web-hub/ui/src/icons/IconSprite.vue";
import { ICON_NAMES } from "../../../src/web-hub/ui/src/icons/names.js";

/**
 * Mount-level smoke test (vue-plan.md v2.1 §5.2 — P0): proves the whole build/mount pipeline
 * (SFC compile → `@vue/test-utils` mount → happy-dom render) actually works end-to-end before
 * any real feature exists — a signal P1–P5 can trust once they add real components.
 */
describe("App.vue placeholder", () => {
  it("mounts without throwing and renders the icon sprite + a placeholder", () => {
    const wrapper = mount(App);
    expect(wrapper.find("svg.sprite").exists()).toBe(true);
    expect(wrapper.text()).toContain("under construction");
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
