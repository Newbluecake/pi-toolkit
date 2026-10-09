// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentTray from "../../../src/web-hub/ui/src/components/control/AttachmentTray.vue";
import {
  ATTACH_PREVIEW_MAX_BYTES,
  THUMB_MAX_EDGE,
  useAttachmentPreview,
  type AttachmentViewerState,
} from "../../../src/web-hub/ui/src/composables/useAttachmentPreview.js";
import type { CanvasLike } from "../../../src/web-hub/ui/src/composables/useAttachmentPreview.js";
import type { FileReaderLike } from "../../../src/web-hub/ui/src/composables/usePreview.js";
import type { Attachment } from "../../../src/web-hub/ui/src/types.js";

/**
 * attachment-preview (2026-10: 「通过输入框上传的图片支持预览（不点击发送的情况下，并且
 * 放大）」): `useAttachmentPreview` (thumbnails via canvas-downscaled `data:` URLs — never
 * `blob:`/`createObjectURL`, D1/HP8 — plus the viewer state machine) and the
 * `AttachmentTray` wiring (thumbnail/name open the `AttachmentImagePreview` dialog; Esc
 * closes with focus return; entries whose item left the tray are dropped — the data:-URL
 * analog of "revoke on remove", there being nothing to revoke for a data: URL).
 */

const THUMB_URL = "data:image/webp;base64,THUMB";
const FULL_URL = "data:image/png;base64,R1VMTA==";

function imageAttachment(over: Partial<Attachment> = {}): Attachment {
  return { id: "a1", name: "shot.png", size: 1024, mime: "image/png", state: "ready", ...over };
}

function fileAttachment(over: Partial<Attachment> = {}): Attachment {
  return { id: "f1", name: "notes.txt", size: 32, mime: "text/plain", state: "ready", ...over };
}

function makeCanvas(): CanvasLike & { draw: ReturnType<typeof vi.fn> } {
  const draw = vi.fn();
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: draw }),
    toDataURL: () => THUMB_URL,
    draw,
  };
}

function makeFileReader(result: string, event: "load" | "error" = "load"): FileReaderLike {
  return {
    get result() {
      return result;
    },
    addEventListener(type, listener) {
      if (type === event) queueMicrotask(() => listener());
    },
    readAsDataURL() {},
  };
}

/** happy-dom's canvas cannot 2d-draw — the default `createCanvas` is fed through a
 * `document.createElement("canvas")` spy so the component tests exercise the REAL default
 * pipeline end to end (only the DOM canvas object itself is fake). */
function stubCanvasPipeline() {
  const canvas = makeCanvas();
  const realCreate = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation(((tag: string) =>
      tag === "canvas"
        ? (canvas as unknown as HTMLCanvasElement)
        : realCreate(tag)) as unknown as typeof document.createElement);
  const bitmap = vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }));
  vi.stubGlobal("createImageBitmap", bitmap);
  return { canvas, bitmap, spy };
}

class StubFileReader {
  private listeners: Record<string, Array<() => void>> = {};
  readonly result: unknown = FULL_URL;
  addEventListener(type: "load" | "error", listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  readAsDataURL(): void {
    queueMicrotask(() => {
      for (const l of this.listeners["load"] ?? []) l();
    });
  }
}

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  vi.stubGlobal("FileReader", StubFileReader);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const w of mounted.splice(0)) w.unmount();
});

// --------------------------------------------------------------------- composable

describe("useAttachmentPreview (composable)", () => {
  it("generates a downscaled data: thumbnail for image items only", async () => {
    const items = ref<Attachment[]>([imageAttachment(), fileAttachment()]);
    const canvas = makeCanvas();
    const bitmap = vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }));
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: (id) =>
          id === "a1" ? { name: "shot.png", size: 1024, type: "image/png", slice: () => {} } : undefined,
        createBitmap: bitmap,
        createCanvas: () => canvas,
        createFileReader: () => makeFileReader(FULL_URL),
      }),
    )!;
    await flushPromises();
    expect(ap.thumbs.value["a1"]).toBe(THUMB_URL);
    // 640×480 → scale 128/640 ⇒ ≤THUMB_MAX_EDGE on the long edge
    expect(canvas.width).toBe(THUMB_MAX_EDGE);
    expect(canvas.height).toBe(96);
    expect(canvas.draw).toHaveBeenCalledTimes(1);
    expect(ap.thumbs.value["f1"]).toBeUndefined(); // non-image never enters the cache
    scope.stop();
  });

  it("skips thumbnails for oversized files, missing sources, and decode failures (silent icon fallback)", async () => {
    const big = imageAttachment({ id: "big", size: ATTACH_PREVIEW_MAX_BYTES + 1 });
    const nosrc = imageAttachment({ id: "nosrc" });
    const broken = imageAttachment({ id: "broken" });
    const items = ref<Attachment[]>([big, nosrc, broken]);
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: (id) => (id === "big" || id === "nosrc" ? undefined : { slice: () => {} }),
        createBitmap: async () => {
          throw new Error("undecodable");
        },
        createCanvas: () => makeCanvas(),
        createFileReader: () => makeFileReader(FULL_URL),
      }),
    )!;
    await flushPromises();
    expect(Object.keys(ap.thumbs.value)).toEqual([]);
    expect(ap.thumbOf("big")).toBeUndefined();
    scope.stop();
  });

  it("prunes cache entries when the item leaves the tray and closes an open viewer (revoke-on-remove analog)", async () => {
    const items = ref<Attachment[]>([imageAttachment()]);
    const src = { name: "shot.png", size: 1024, type: "image/png", slice: () => {} };
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: () => src,
        createBitmap: async () => ({ width: 640, height: 480 }),
        createCanvas: () => makeCanvas(),
        createFileReader: () => makeFileReader(FULL_URL),
      }),
    )!;
    await flushPromises();
    expect(ap.thumbs.value["a1"]).toBe(THUMB_URL);
    ap.openPreview(items.value[0]!);
    expect(ap.viewer.value?.phase).toBe("loading");
    items.value = []; // removed / sent
    await nextTick();
    expect(ap.thumbs.value).toEqual({}); // nothing retained for a gone item
    expect(ap.viewer.value).toBeNull(); // its viewer cannot outlive it
    scope.stop();
  });

  it("viewer: loading → ready on read; superseded reads never commit; errors map to error", async () => {
    const item = imageAttachment();
    const items = ref<Attachment[]>([item]);
    let delay = false;
    const pending: Array<() => void> = [];
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: () => ({ slice: () => {} }),
        createBitmap: async () => ({ width: 10, height: 10 }),
        createCanvas: () => makeCanvas(),
        createFileReader: () =>
          ({
            result: FULL_URL,
            addEventListener(type, listener) {
              if (type === "load") {
                if (delay) pending.push(listener);
                else queueMicrotask(listener);
              }
            },
            readAsDataURL() {},
          }) satisfies FileReaderLike,
      }),
    )!;
    ap.openPreview(item);
    expect(ap.viewer.value?.phase).toBe("loading");
    await flushPromises();
    expect(ap.viewer.value?.phase).toBe("ready");
    expect((ap.viewer.value as Extract<AttachmentViewerState, { phase: "ready" }>).dataUrl).toBe(FULL_URL);

    // supersede: two opens park their reads; the STALE read must never commit
    delay = true;
    ap.openPreview(item); // seq A — read parked
    ap.openPreview(item); // seq B — read parked, supersedes A
    const parked = pending.splice(0);
    expect(parked).toHaveLength(2);
    parked[0]!(); // stale read (seq A) fires first
    await flushPromises();
    expect(ap.viewer.value?.phase).toBe("loading"); // stale read did NOT commit
    parked[1]!(); // the live read (seq B) fires
    await flushPromises();
    expect(ap.viewer.value?.phase).toBe("ready");
    scope.stop();
  });

  it("viewer: non-image and removing items are a no-op; oversized opens tooLarge; missing source errors", () => {
    const items = ref<Attachment[]>([fileAttachment(), imageAttachment({ state: "removing" })]);
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: () => undefined,
        createBitmap: async () => ({ width: 10, height: 10 }),
        createCanvas: () => makeCanvas(),
        createFileReader: () => makeFileReader(FULL_URL),
      }),
    )!;
    ap.openPreview(items.value[0]!); // non-image
    ap.openPreview(items.value[1]!); // removing
    expect(ap.viewer.value).toBeNull();
    ap.openPreview(imageAttachment({ id: "big", size: ATTACH_PREVIEW_MAX_BYTES + 1 }));
    expect(ap.viewer.value?.phase).toBe("tooLarge");
    ap.openPreview(imageAttachment({ id: "gone" })); // no source
    expect(ap.viewer.value?.phase).toBe("error");
    scope.stop();
  });

  it("scope dispose clears everything and drops late async results", async () => {
    const items = ref<Attachment[]>([imageAttachment()]);
    const scope = effectScope();
    const ap = scope.run(() =>
      useAttachmentPreview({
        items: () => items.value,
        sourceOf: () => ({ slice: () => {} }),
        createBitmap: async () => ({ width: 640, height: 480 }),
        createCanvas: () => makeCanvas(),
        createFileReader: () => makeFileReader(FULL_URL),
      }),
    )!;
    scope.stop();
    await flushPromises();
    expect(ap.thumbs.value).toEqual({}); // disposed: late thumb result dropped
    expect(ap.viewer.value).toBeNull();
    ap.openPreview(imageAttachment());
    expect(ap.viewer.value).toBeNull(); // disposed: no viewer can open
  });
});

// ------------------------------------------------------------------- tray component

function mountTray(items: Attachment[], sourceOf?: (id: string) => unknown) {
  const w = mount(AttachmentTray, {
    props: { items, plaintext: false, ...(sourceOf === undefined ? {} : { sourceOf }) },
    attachTo: document.body, // focus assertions need a real connected activeElement
  });
  mounted.push(w);
  return w;
}

describe("AttachmentTray + AttachmentImagePreview (component)", () => {
  it("renders a thumbnail button for image items only (aria-label 预览/<Preview {name}>)", async () => {
    stubCanvasPipeline();
    const w = mountTray([imageAttachment(), fileAttachment()], () => ({ slice: () => {} }));
    await flushPromises();
    const thumb = w.get(".tray-thumb");
    expect(thumb.attributes("aria-label")).toBe("Preview shot.png");
    expect(thumb.get("img").attributes("src")).toBe(THUMB_URL);
    // image rows swap the name span for the previewable name button; files keep the span
    expect(w.get(".tray-name-btn").text()).toBe("shot.png");
    const rows = w.findAll(".tray-item");
    expect(rows[1]!.find(".tray-thumb").exists()).toBe(false);
    expect(rows[1]!.get(".tray-name").text()).toBe("notes.txt");
  });

  it("without a source accessor (or non-image rows) nothing changes — icon rows, no viewer", async () => {
    const w = mountTray([imageAttachment()]); // no sourceOf prop
    await flushPromises();
    expect(w.find(".tray-thumb").exists()).toBe(false);
    expect(w.get(".tray-icon").exists()).toBe(true);
    // the name is still a preview button (oversized/missing-source feedback lives in the dialog)
    await w.get(".tray-name-btn").trigger("click");
    await flushPromises();
    const note = document.querySelector(".preview-note p");
    expect(note?.textContent ?? "").not.toBe(""); // error phase note rendered
    expect(document.querySelector(".preview-overlay")).not.toBeNull();
  });

  it("clicking the thumbnail opens the zoomable dialog; Esc closes and focus returns", async () => {
    stubCanvasPipeline();
    const w = mountTray([imageAttachment()], () => ({ slice: () => {} }));
    await flushPromises();
    const thumb = w.get(".tray-thumb");
    thumb.element.focus();
    await thumb.trigger("click");
    await flushPromises();
    const overlay = document.querySelector(".preview-overlay");
    expect(overlay).not.toBeNull();
    const img = overlay?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(FULL_URL); // PreviewImage's D1-checked <img>
    expect(overlay?.querySelector(".preview-title")?.textContent).toBe("shot.png");
    expect(overlay?.querySelector(".preview-image-toggle")?.textContent).toBe("Actual size"); // zoom present
    overlay?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    await nextTick();
    expect(document.querySelector(".preview-overlay")).toBeNull();
    expect(document.activeElement).toBe(thumb.element); // focus returned to the opener
  });

  it("clicking the file name opens the same dialog; removing the item mid-view closes it", async () => {
    stubCanvasPipeline();
    const w = mountTray([imageAttachment()], () => ({ slice: () => {} }));
    await flushPromises();
    await w.get(".tray-name-btn").trigger("click");
    await flushPromises();
    expect(document.querySelector(".preview-overlay")).not.toBeNull();
    // item leaves the tray (removed/sent) → the viewer cannot outlive its pixels
    await w.setProps({ items: [] });
    await nextTick();
    expect(document.querySelector(".preview-overlay")).toBeNull();
  });
});
