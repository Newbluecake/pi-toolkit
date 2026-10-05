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
});
