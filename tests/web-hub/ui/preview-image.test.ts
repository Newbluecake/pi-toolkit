// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import PreviewImage from "../../../src/web-hub/ui/src/components/preview/PreviewImage.vue";

/**
 * `PreviewImage.vue` (web-hub-preview plan v3 §4.6, package PV5): only `data:` URLs reach
 * `<img src>` (D1 — CSP is not relaxed; a `blob:`/remote URL renders NOTHING), plus the
 * fit ↔ actual-size toggle and the 2026-10 zoom-enhance additions: cursor-centered wheel
 * zoom (50%–400%), the 50% zoom floor, and the Fullscreen API button.
 */

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

/** happy-dom returns zeroed rects; tests stub the geometry they exercise. */
function stubRect(el: Element, rect: { left?: number; top?: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left: rect.left ?? 0, top: rect.top ?? 0, width: rect.width, height: rect.height }) as DOMRect;
}

describe("PreviewImage.vue", () => {
  afterEach(() => {
    // fullscreen stubs are per-test; never leak them across cases
    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
    delete (document as { exitFullscreen?: () => Promise<void> }).exitFullscreen;
  });

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
    const all = wrapper.findAll(".preview-zoom-btn:not(.preview-fullscreen-btn)");
    expect(all).toHaveLength(2); // [−, +] — zoom-out first
    return { zoomOut: all[0]!, zoomIn: all[1]! };
  };

  it("+/− step the actual-size scale 1.25×; − goes below 100% down to the 50% floor", async () => {
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
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("100%");
    // zoom-enhance: − keeps going below 100% (100 → 80 → 64 → 51 → 50) and stops at 50%
    await zoomOut.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("80%");
    await zoomOut.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("64%");
    await zoomOut.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("51%");
    await zoomOut.trigger("click");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("50%");
    expect(zoomOut.attributes("disabled")).toBeDefined(); // floor reached
    await zoomOut.trigger("click"); // a guarded no-op: never leaves actual, never below 50%
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("50%");
    expect(wrapper.get("img").classes()).not.toContain("fit");
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
    stubRect(wrapper.get(".preview-image-body").element, { width: 400, height: 300 });
    stubRect(img.element, { width: 800, height: 600 });
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
    stubRect(wrapper.get(".preview-image-body").element, { width: 400, height: 300 });
    stubRect(img.element, { width: 800, height: 600 });
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

  // --- zoom-enhance (2026-10): wheel zoom, 50% floor, keyboard +/−, fullscreen -----------

  it("wheel zooms around the cursor: the anchored point stays fixed (cursor-centered)", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 } } });
    const body = wrapper.get(".preview-image-body");
    const img = wrapper.get("img");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 100, clientY: 100 }); // click → actual 100%
    // 800×600 image centered in a 400×300 body → layout box top-left at (−200,−150)
    stubRect(body.element, { left: 0, top: 0, width: 400, height: 300 });
    stubRect(img.element, { left: -200, top: -150, width: 800, height: 600 });
    // wheel-up 100px at (300,150) — 100px right of the image center (200,150)
    await body.trigger("wheel", { deltaY: -100, clientX: 300, clientY: 150 });
    // exp(0.2) ≈ 1.2214 → scale 1.221; anchor math: pan.x = 100·(1−1.221) = −22.1
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("122%");
    expect(img.attributes("style")).toContain("translate(-22.1px, 0px) scale(1.221)");
    // wheel at the exact center leaves the pan untouched
    await body.trigger("wheel", { deltaY: -100, clientX: 200, clientY: 150 });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("149%"); // 1.221·e^0.2 ≈ 1.491
    expect(img.attributes("style")).toContain("scale(1.491)");
  });

  it("first wheel tick in fit mode eases out from the measured fit ratio (no jump to 100%)", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 } } });
    const body = wrapper.get(".preview-image-body");
    const img = wrapper.get("img");
    expect(img.classes()).toContain("fit");
    // fit: 800×600 displayed at 400×300 inside the 400×300 body → fit ratio 0.5
    stubRect(body.element, { left: 0, top: 0, width: 400, height: 300 });
    stubRect(img.element, { left: 0, top: 0, width: 400, height: 300 });
    await body.trigger("wheel", { deltaY: -100, clientX: 200, clientY: 150 }); // wheel-up at center
    // 0.5·e^0.2 ≈ 0.6107 → 61%, NOT a jump to 100%/125%
    expect(wrapper.get(".preview-image-body").classes()).toContain("actual");
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("61%");
    expect(img.attributes("style")).toContain("translate(0px, 0px) scale(0.611)");
    // wheel-down from fit shrinks toward (and clamps at) the 50% floor, never jumping
    await img.trigger("keydown", { key: "Enter" }); // back to fit
    expect(img.classes()).toContain("fit");
    await body.trigger("wheel", { deltaY: 100, clientX: 200, clientY: 150 });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("50%"); // 0.5·e^−0.2 ≈ 0.41 → clamped to the floor
  });

  it("wheel clamps to 50% and re-clamps a stale pan against the new (zero) overflow", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 800, h: 600 } } });
    const body = wrapper.get(".preview-image-body");
    const img = wrapper.get("img");
    await img.trigger("pointerdown", { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await img.trigger("pointerup", { clientX: 100, clientY: 100 }); // click → actual
    stubRect(body.element, { left: 0, top: 0, width: 400, height: 300 });
    stubRect(img.element, { left: -200, top: -150, width: 800, height: 600 });
    await img.trigger("keydown", { key: "ArrowRight" }); // pan (40,0)
    expect(img.attributes("style")).toContain("translate(40px, 0px)");
    // a huge wheel-down: factor e^−2 → scale would be 0.135, clamped to the 0.5 floor;
    // at 50% the 800×600 image exactly fills the 400×300 body → overflow 0 → pan re-clamped to 0
    await body.trigger("wheel", { deltaY: 1000, clientX: 200, clientY: 150 });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("50%");
    expect(img.attributes("style")).toContain("translate(0px, 0px) scale(0.5)");
    // resting on the floor: further wheel-down is a no-op
    await body.trigger("wheel", { deltaY: 1000, clientX: 200, clientY: 150 });
    expect(img.attributes("style")).toContain("scale(0.5)");
  });

  it("keyboard +/= and −/_ zoom like the buttons, below 100% included", async () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const img = wrapper.get("img");
    await img.trigger("keydown", { key: "Enter" }); // → actual 100%
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("100%");
    await img.trigger("keydown", { key: "+" });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("125%");
    await img.trigger("keydown", { key: "=" });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("156%");
    await img.trigger("keydown", { key: "-" });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("125%");
    await img.trigger("keydown", { key: "_" });
    await img.trigger("keydown", { key: "-" });
    expect(wrapper.get(".preview-zoom-pct").text()).toBe("80%"); // below 100% via keyboard too
  });

  it("fullscreen button is hidden when the Fullscreen API is unavailable (degrade)", () => {
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    expect(wrapper.find(".preview-fullscreen-btn").exists()).toBe(false);
  });

  it("fullscreen button requests/exits fullscreen and tracks fullscreenchange", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const root = wrapper.get(".preview-image").element as HTMLElement;
    const setFs = (el: Element | null) => {
      Object.defineProperty(document, "fullscreenElement", { value: el, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    root.requestFullscreen = () => {
      setFs(root);
      return Promise.resolve();
    };
    Object.defineProperty(document, "exitFullscreen", {
      value: () => {
        setFs(null);
        return Promise.resolve();
      },
      configurable: true,
    });
    const btn = wrapper.get(".preview-fullscreen-btn");
    expect(btn.attributes("aria-pressed")).toBe("false");
    expect(btn.attributes("aria-label")).toBe("Full screen");
    await btn.trigger("click");
    expect(btn.attributes("aria-pressed")).toBe("true");
    expect(btn.attributes("aria-label")).toBe("Exit full screen");
    // a browser-side exit (native Esc) resyncs the button through fullscreenchange alone
    setFs(null);
    await wrapper.vm.$nextTick();
    expect(btn.attributes("aria-pressed")).toBe("false");
    // click again → enter → click exits through document.exitFullscreen
    await btn.trigger("click");
    expect(btn.attributes("aria-pressed")).toBe("true");
    await btn.trigger("click");
    expect(btn.attributes("aria-pressed")).toBe("false");
  });

  it("a rejected requestFullscreen leaves the button state untouched", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const wrapper = mount(PreviewImage, { props: { dataUrl: DATA_URL, dims: { w: 10, h: 10 } } });
    const root = wrapper.get(".preview-image").element as HTMLElement;
    root.requestFullscreen = () => Promise.reject(new Error("permission denied"));
    const btn = wrapper.get(".preview-fullscreen-btn");
    await btn.trigger("click");
    await Promise.resolve(); // let the rejection's catch settle
    expect(btn.attributes("aria-pressed")).toBe("false");
  });
});
