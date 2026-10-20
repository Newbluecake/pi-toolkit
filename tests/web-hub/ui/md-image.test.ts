// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import MdBlock from "../../../src/web-hub/ui/src/components/transcript/MdBlock.vue";
import MdInline from "../../../src/web-hub/ui/src/components/transcript/MdInline.vue";
import {
  MD_IMAGE_LOADER,
  PREVIEW_BASE_DIR,
  PREVIEW_CTX,
} from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type {
  MdImageFailReason,
  MdImageSlot,
  MdImageSlotState,
} from "../../../src/web-hub/ui/src/composables/useMdImageLoader.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/**
 * The preview-mode rendering half (md-preview-html plan): `MdBlock`'s `html_block` wrapper
 * and `MdInline`'s `image`/`br`/`sub`/`sup` branches through `MdImage.vue`. Pinned here:
 * only a verified `data:image/` URL ever reaches `<img src>` (D1 backstop), external http(s)
 * images are NEVER fetched (placeholder chip link), failures render the placeholder chip
 * with a reason, unmount releases (aborts) the load, and a click on a loaded image opens the
 * normal image preview.
 */

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function fakeSlot(state: MdImageSlotState, dataUrl: string | null = null, reason: MdImageFailReason | null = null) {
  return {
    state: ref(state) as Ref<MdImageSlotState>,
    dataUrl: ref(dataUrl) as Ref<string | null>,
    reason: ref(reason) as Ref<MdImageFailReason | null>,
    release: vi.fn(),
  } satisfies MdImageSlot;
}

const SC: PreviewPathScope = { agentKey: "A", sessionId: "s", cwd: "/repo", uploads: false, abs: true, dirs: true };

function provides(slot: MdImageSlot, scope: PreviewPathScope | null = SC) {
  const open = vi.fn();
  const handle: PreviewHandle = {
    view: ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>,
    scope: ref(scope),
    open,
    close: vi.fn(),
    retry: vi.fn(),
    dispose: vi.fn(),
  };
  const load = vi.fn(() => slot);
  return {
    open,
    load,
    provide: {
      [PREVIEW_CTX as symbol]: { handle, plaintext: false },
      [PREVIEW_BASE_DIR as symbol]: ref("/repo"),
      [MD_IMAGE_LOADER as symbol]: { load, dispose: vi.fn() },
    },
  };
}

const htmlBlock = (children: unknown[], align = "center") => [{ type: "html_block", align, children }] as never;

describe("MdImage via MdBlock/MdInline (preview mode)", () => {
  it("a resolved relative image loads through the loader and renders ONLY the data: URL", async () => {
    const slot = fakeSlot("ready", DATA_URL);
    const { load, provide } = provides(slot);
    const w = mount(MdBlock, {
      props: { nodes: htmlBlock([{ type: "image", src: "docs/x.png", alt: "shot", width: { n: 100, unit: "%" } }]) },
      global: { provide },
    });
    await w.vm.$nextTick(); // MdImage loads onMounted — one tick for the slot-driven re-render
    expect(load).toHaveBeenCalledWith("/repo/docs/x.png");
    const box = w.get(".md-hblock");
    expect(box.classes()).toContain("md-hblock-center");
    const img = w.get("img.md-img");
    expect(img.attributes("src")).toBe(DATA_URL);
    expect(img.attributes("alt")).toBe("shot");
    expect(img.attributes("style")).toContain("width: 100%");
    expect(w.find("a").exists()).toBe(false);
  });

  it("D1 backstop: a ready slot whose URL is not data:image/ renders the placeholder, never <img>", async () => {
    const slot = fakeSlot("ready", "https://evil.example/x.png");
    const { provide } = provides(slot);
    const w = mount(MdBlock, {
      props: { nodes: htmlBlock([{ type: "image", src: "docs/x.png", alt: "shot" }]) },
      global: { provide },
    });
    await w.vm.$nextTick();
    expect(w.find("img").exists()).toBe(false);
    expect(w.get(".md-img-chip").text()).toContain("shot");
  });

  it("external http(s) src ⇒ placeholder chip LINK, the loader is never called", () => {
    const slot = fakeSlot("loading");
    const { load, provide } = provides(slot);
    const w = mount(MdInline, {
      props: {
        nodes: [{ type: "image", src: "https://img.shields.io/badge/cov-90%25-green", alt: "coverage" }] as never,
      },
      global: { provide },
    });
    expect(load).not.toHaveBeenCalled();
    expect(w.find("img").exists()).toBe(false);
    const a = w.get("a.md-img-ext");
    expect(a.attributes("href")).toBe("https://img.shields.io/badge/cov-90%25-green");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toContain("noopener");
    expect(a.attributes("rel")).toContain("noreferrer");
    expect(a.text()).toContain("coverage");
  });

  it("protocol-relative //host src is external too: chip link, never loaded", () => {
    const slot = fakeSlot("loading");
    const { load, provide } = provides(slot);
    const w = mount(MdInline, {
      props: { nodes: [{ type: "image", src: "//cdn.example/x.png", alt: "" }] as never },
      global: { provide },
    });
    expect(load).not.toHaveBeenCalled();
    expect(w.find("img").exists()).toBe(false);
    expect(w.get("a.md-img-ext").text()).toContain("cdn.example");
  });

  it("placeholder on denied/tooLarge carries the alt text and the reason", async () => {
    for (const [reason, text] of [
      ["denied", "access denied"],
      ["tooLarge", "image preview limit"],
      ["failed", "failed to load"],
    ] as const) {
      const slot = fakeSlot("placeholder", null, reason);
      const { provide } = provides(slot);
      const w = mount(MdInline, {
        props: { nodes: [{ type: "image", src: "docs/x.png", alt: "diagram" }] as never },
        global: { provide },
      });
      await w.vm.$nextTick();
      expect(w.find("img").exists()).toBe(false);
      expect(w.get(".md-img-chip").text()).toContain("diagram");
      expect(w.get(".md-img-chip").text()).toContain(text);
    }
  });

  it("unresolvable src (no scope) ⇒ placeholder without any fetch", () => {
    const slot = fakeSlot("loading");
    const { load, provide } = provides(slot, null);
    const w = mount(MdInline, {
      props: { nodes: [{ type: "image", src: "../outside/x.png", alt: "far" }] as never },
      global: { provide },
    });
    expect(load).not.toHaveBeenCalled();
    expect(w.get(".md-img-chip").text()).toContain("far");
  });

  it("unmount releases the slot (aborts the in-flight fetch)", () => {
    const slot = fakeSlot("loading");
    const { provide } = provides(slot);
    const w = mount(MdInline, {
      props: { nodes: [{ type: "image", src: "docs/x.png", alt: "s" }] as never },
      global: { provide },
    });
    w.unmount();
    expect(slot.release).toHaveBeenCalledTimes(1);
  });

  it("clicking / Enter on a loaded image opens the normal image preview", async () => {
    const slot = fakeSlot("ready", DATA_URL);
    const { open, provide } = provides(slot);
    const w = mount(MdInline, {
      props: { nodes: [{ type: "image", src: "docs/x.png", alt: "s" }] as never },
      global: { provide },
    });
    await w.vm.$nextTick();
    await w.get("img.md-img").trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/repo/docs/x.png" });
    await w.get("img.md-img").trigger("keydown", { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("br / sub / sup render as real elements (never raw text)", () => {
    const { provide } = provides(fakeSlot("loading"));
    const w = mount(MdInline, {
      props: {
        nodes: [
          { type: "text", text: "a" },
          { type: "br" },
          { type: "sub", children: [{ type: "text", text: "cap" }] },
          { type: "sup", children: [{ type: "text", text: "2" }] },
        ] as never,
      },
      global: { provide },
    });
    expect(w.find("br").exists()).toBe(true);
    expect(w.get("sub.md-sub").text()).toBe("cap");
    expect(w.get("sup.md-sup").text()).toBe("2");
    expect(w.text()).not.toContain("<sub>");
  });

  it("left/right/no alignment map to their classes; empty align carries none", () => {
    const { provide } = provides(fakeSlot("loading"));
    for (const [align, cls] of [
      ["left", "md-hblock-left"],
      ["right", "md-hblock-right"],
    ] as const) {
      const w = mount(MdBlock, {
        props: { nodes: htmlBlock([{ type: "text", text: "x" }], align) },
        global: { provide },
      });
      expect(w.get(".md-hblock").classes()).toContain(cls);
    }
    const plain = mount(MdBlock, {
      props: { nodes: htmlBlock([{ type: "text", text: "x" }], "") },
      global: { provide },
    });
    const classes = plain.get(".md-hblock").classes();
    expect(classes).not.toContain("md-hblock-center");
    expect(classes).not.toContain("md-hblock-left");
    expect(classes).not.toContain("md-hblock-right");
  });
});
