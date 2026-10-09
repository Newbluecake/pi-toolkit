// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PreviewImage from "../../../src/web-hub/ui/src/components/preview/PreviewImage.vue";

/**
 * `PreviewImage.vue` (web-hub-preview plan v3 §4.6, package PV5): only `data:` URLs reach
 * `<img src>` (D1 — CSP is not relaxed; a `blob:`/remote URL renders NOTHING), plus the
 * fit ↔ actual-size toggle.
 */

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("PreviewImage.vue", () => {
  it("renders a data: URL image with dims and size in the meta line", () => {
    const wrapper = mount(PreviewImage, {
      props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 }, sizeLabel: "12.0 KiB", alt: "a.png" },
    });
    const img = wrapper.get("img");
    expect(img.attributes("src")).toBe(DATA_URL);
    expect(img.attributes("alt")).toBe("a.png");
    expect(wrapper.get(".preview-meta").text()).toContain("800 × 600");
    expect(wrapper.get(".preview-meta").text()).toContain("12.0 KiB");
  });

  it("rejects a non-data: URL outright — no <img> is ever rendered (D1 backstop)", () => {
    for (const src of ["https://evil.example/x.png", "blob:http://x/y", "file:///etc/passwd", "data:text/html,<p>"]) {
      const wrapper = mount(PreviewImage, { props: { dataUrl: src, dims: { w: 1, h: 1 } } });
      expect(wrapper.find("img").exists()).toBe(false);
    }
  });

  it("starts in fit mode and toggles to actual size and back", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    expect(wrapper.get("img").classes()).toContain("fit");
    expect(wrapper.get(".preview-image-body").classes()).not.toContain("actual");
    const toggle = wrapper.get(".preview-image-toggle");
    expect(toggle.text()).toBe("Actual size");
    await toggle.trigger("click");
    expect(wrapper.get("img").classes()).not.toContain("fit");
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
    expect(toggle.text()).toBe("Fit to window");
    await toggle.trigger("click");
    expect(wrapper.get("img").classes()).toContain("fit");
  });

  // --- attachment-preview (2026-10): minimal zoom — +/− steps, click/tap toggle, drag pan ---

  const zoomButtons = (wrapper: ReturnType<typeof mount>) => {
    const all = wrapper.findAll(".preview-zoom-btn");
    expect(all).toHaveLength(2); // [−, +] — zoom-out first
    return { zoomOut: all[0]!, zoomIn: all[1]! };
  };

  it("+/− step the actual-size scale 1.25×; − at 100% returns to fit (disabled in fit)", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const { zoomIn, zoomOut } = zoomButtons(wrapper);
    // fit mode: zoom-out disabled, zoom-in enters actual at 100%
    expect(zoomOut.attributes("disabled")).toBeDefined();
    await zoomIn.trigger("click");
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("100%");
    await zoomIn.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("125%");
    await zoomIn.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("156%");
    await zoomOut.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("125%");
    await zoomOut.trigger("click");
    await zoomOut.trigger("click"); // at 100% again — falls back to fit
    expect(wrapper.get("img").classes()).toContain("fit");
    expect(wrapper.find(".preview-zoom-pct").exists()).toBe(false);
  });

  it("+ stays within 400% (button disables at the ceiling)", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const { zoomIn } = zoomButtons(wrapper);
    await zoomIn.trigger("click"); // actual 100%
    for (let i = 0; i < 10; i++) await zoomIn.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("400%");
    expect(zoomIn.attributes("disabled")).toBeDefined();
  });

  it("click/tap on the image toggles fit ⇄ actual (press-release without travel)", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const img = wrapper.get("img");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 103, clientY: 102 }); // ≤5px travel = click
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 100, clientY: 100 });
    expect(wrapper.get("img").classes()).toContain("fit");
  });

  it("drag pans in actual mode, clamped to the overflow; a drag never toggles", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 } } });
    const img = wrapper.get("img");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 100, clientY: 100 }); // click → actual
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
    // 800×600 image in a 400×300 viewport → pan bounds ±200/±150
    (wrapper.get(".preview-image-body").element as HTMLElement).getBoundingClientRect = () =>
      ({ width: 400, height: 300 }) as DOMRect;
    (img.element as HTMLElement).getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointermove", { clientX: 130, clientY: 110 }); // +30/+10, past the 5px threshold
    expect(img.attributes("style")).toContain("translate(30px, 10px)");
    await img.trigger("pointermove", { clientX: 4000, clientY: 110 }); // clamped to +200
    expect(img.attributes("style")).toContain("translate(200px, 10px)");
    await img.trigger("pointerup", { clientX: 4000, clientY: 110 });
    // a real drag must NOT have toggled back to fit
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
  });

  it("drag does nothing in fit mode; arrow keys pan only in actual mode", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 } } });
    const img = wrapper.get("img");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointermove", { clientX: 150, clientY: 140 });
    await img.trigger("pointerup", { clientX: 150, clientY: 140 });
    expect(img.attributes("style") ?? "").not.toContain("translate"); // fit: no transform ever applied
    // arrow key in fit mode: swallowed (preventDefault), no pan
    await img.trigger("keydown", { key: "ArrowRight" });
    expect(img.attributes("style") ?? "").not.toContain("translate");
    // in actual mode arrows pan by 40px, clamped
    await img.trigger("pointerdown", { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 10, clientY: 10 }); // click → actual
    (wrapper.get(".preview-image-body").element as HTMLElement).getBoundingClientRect = () =>
      ({ width: 400, height: 300 }) as DOMRect;
    (img.element as HTMLElement).getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    await img.trigger("keydown", { key: "ArrowRight" });
    expect(img.attributes("style")).toContain("translate(40px, 0px)");
    await img.trigger("keydown", { key: "ArrowLeft" });
    await img.trigger("keydown", { key: "ArrowLeft" });
    expect(img.attributes("style")).toContain("translate(-40px, 0px)");
    // Enter toggles like a click
    await img.trigger("keydown", { key: "Enter" });
    expect(wrapper.get("img").classes()).toContain("fit");
  });

  it("dims are optional: the meta line picks natural dimensions up from the load event", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, sizeLabel: "3 B" } });
    expect(wrapper.get(".preview-meta").text()).toBe("3 B"); // no dims segment before load
    const el = wrapper.get("img").element as HTMLImageElement;
    Object.defineProperty(el, "naturalWidth", { value: 640, configurable: true });
    Object.defineProperty(el, "naturalHeight", { value: 480, configurable: true });
    await wrapper.get("img").trigger("load");
    expect(wrapper.get(".preview-meta").text()).toContain("640 × 480");
  });
});
