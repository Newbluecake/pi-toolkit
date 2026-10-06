// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PickerSheet from "../../../src/web-hub/ui/src/components/control/PickerSheet.vue";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { acquireBodyScrollLock, resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import type { PreviewHandle, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/**
 * `composables/useScrollLock.ts` (verify:model-switch-M3b 打回项): the body scroll lock must
 * COMPOSE — PickerSheet and PreviewHost used to each save/restore
 * `document.body.style.overflow`, so a stacked outer overlay unmounting first restored the
 * pre-hidden value and unlocked the page under the still-open inner overlay. The shared
 * ref-counted lock restores only when the LAST hold releases. Covers: outer-first/inner-last
 * unmount orders, PickerSheet×PreviewHost interleaving, and release idempotence. Plus the
 * single-instance regression: one overlay alone behaves exactly as before.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

function mountSheet(): ReturnType<typeof mount> {
  const wrapper = mount(PickerSheet, {
    attachTo: document.body,
    props: { label: "Picker" },
    slots: { default: `<button type="button">row</button>` },
  });
  mounted.push(wrapper);
  return wrapper;
}

function makePreviewCtx(initial: PreviewView): {
  ctx: PreviewContext;
  view: Ref<PreviewView>;
} {
  const view = ref(initial) as Ref<PreviewView>;
  const handle: PreviewHandle = {
    view,
    scope: ref(null),
    open: vi.fn(),
    close: vi.fn(() => {
      view.value = { phase: "closed" };
    }),
    retry: vi.fn(),
    dispose: vi.fn(),
  };
  return { ctx: { handle, plaintext: false }, view };
}

function mountPreview(view: PreviewView): { wrapper: ReturnType<typeof mount>; view: Ref<PreviewView> } {
  const { ctx, view: v } = makePreviewCtx(view);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PreviewHost, {
    attachTo: host,
    global: { provide: { [PREVIEW_CTX as symbol]: ctx } },
  });
  mounted.push(wrapper);
  return { wrapper, view: v };
}

describe("useScrollLock — composable contract (verify:model-switch-M3b)", () => {
  it("first acquire saves the original overflow and hides; last release restores it", () => {
    document.body.style.overflow = "scroll";
    const r1 = acquireBodyScrollLock();
    expect(document.body.style.overflow).toBe("hidden");
    const r2 = acquireBodyScrollLock();
    r1();
    expect(document.body.style.overflow).toBe("hidden"); // one hold remains
    r2();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("release is idempotent: a double release never unlocks early or drives the count negative", () => {
    const r1 = acquireBodyScrollLock();
    const r2 = acquireBodyScrollLock();
    r1();
    r1(); // duplicate — must be a no-op
    expect(document.body.style.overflow).toBe("hidden");
    r2();
    r2(); // duplicate again — count already 0, restored value must not be touched
    expect(document.body.style.overflow).toBe("");
    const r3 = acquireBodyScrollLock(); // a fresh cycle still works
    expect(document.body.style.overflow).toBe("hidden");
    r3();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("useScrollLock — PickerSheet × PreviewHost stacking", () => {
  it("OUTER (PreviewHost) unmounts first: page stays locked until the INNER (PickerSheet) unmounts", async () => {
    const preview = mountPreview({ phase: "loading", path: "/p/a.ts" });
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    const sheet = mountSheet();
    await tick();
    expect(document.body.style.overflow).toBe("hidden");

    preview.wrapper.unmount(); // outer first — the old per-component lock would have unlocked here
    expect(document.body.style.overflow).toBe("hidden");
    sheet.unmount(); // inner last ⇒ the original value comes back
    expect(document.body.style.overflow).toBe("");
  });

  it("INNER (PickerSheet) unmounts first: stays locked until PreviewHost closes (close path, not unmount)", async () => {
    const preview = mountPreview({ phase: "loading", path: "/p/a.ts" });
    await tick();
    const sheet = mountSheet();
    await tick();

    sheet.unmount(); // inner first
    expect(document.body.style.overflow).toBe("hidden");
    preview.view.value = { phase: "closed" }; // PreviewHost's normal close path
    await tick();
    expect(document.body.style.overflow).toBe("");
  });

  it("interleaved acquire/release order never restores before the last hold (acquire PV, sheet, close PV, close sheet)", async () => {
    document.body.style.overflow = "auto";
    const preview = mountPreview({ phase: "loading", path: "/p/a.ts" });
    await tick();
    const sheet = mountSheet();
    await tick();
    preview.view.value = { phase: "closed" }; // preview closes while the sheet is still open
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    sheet.unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("single instance: PreviewHost alone still restores its saved value (regression: behavior unchanged)", async () => {
    document.body.style.overflow = "scroll";
    const preview = mountPreview({ phase: "loading", path: "/p/a.ts" });
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    preview.view.value = { phase: "closed" };
    await tick();
    expect(document.body.style.overflow).toBe("scroll");
    // closing twice (close path then unmount) stays clean
    preview.wrapper.unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("single instance: PickerSheet alone restores on unmount (regression: behavior unchanged)", async () => {
    const sheet = mountSheet();
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    sheet.unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
