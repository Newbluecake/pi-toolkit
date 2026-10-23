// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PickerSheet from "../../../src/web-hub/ui/src/components/control/PickerSheet.vue";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { acquireBodyScrollLock, resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import type { PreviewView } from "../../../src/web-hub/ui/src/types.js";
import { fakeWindowHandle, fakeWindowsFace } from "./helpers/preview-windows-fake.js";

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

/**
 * preview-windows W2: PreviewHost is now the WINDOWS shell — it locks body scroll only on the
 * PHONE band (the ≥768px band is modeless, §5), so every stacking case here runs the phone
 * band with a fake windows face (helpers/preview-windows-fake.ts) carrying one open window.
 */
function stubPhoneBand(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

type PreviewRig = {
  wrapper: ReturnType<typeof mount>;
  view: Ref<PreviewView>;
  face: ReturnType<typeof fakeWindowsFace>;
  close(): void;
};

function mountPreview(view: PreviewView): PreviewRig {
  stubPhoneBand();
  const win = fakeWindowHandle(1, view);
  const face = fakeWindowsFace([win]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PreviewHost, {
    attachTo: host,
    global: { provide: { [PREVIEW_CTX as symbol]: { handle: face, plaintext: false } satisfies PreviewContext } },
  });
  mounted.push(wrapper);
  return {
    wrapper,
    view: win.view as Ref<PreviewView>,
    face,
    /** the shell's normal close path: the window leaves the face (§4.4) */
    close(): void {
      win.view.value = { phase: "closed" };
      face.closeWindow(1);
    },
  };
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
    preview.close(); // PreviewHost's normal close path (§4.4)
    await tick();
    expect(document.body.style.overflow).toBe("");
  });

  it("interleaved acquire/release order never restores before the last hold (acquire PV, sheet, close PV, close sheet)", async () => {
    document.body.style.overflow = "auto";
    const preview = mountPreview({ phase: "loading", path: "/p/a.ts" });
    await tick();
    const sheet = mountSheet();
    await tick();
    preview.close(); // preview closes while the sheet is still open
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
    preview.close();
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
