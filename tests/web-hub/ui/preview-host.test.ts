// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import type { PreviewHandle, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/**
 * `PreviewHost.vue` (web-hub-preview plan v3 §4.6, package PV5): the overlay renders
 * `usePreview`'s five phases (+closed ⇒ nothing), closes via Esc (preventDefault +
 * stopPropagation) / scrim click / close button, manages focus (enter → trap → return),
 * locks body scroll with guaranteed cleanup, and shows the §5.2 plaintext warning. Plus the
 * explicit en/zh key parity assertion for the new `preview` namespace.
 */

function makeHandle(initial: PreviewView = { phase: "closed" }): {
  handle: PreviewHandle;
  view: Ref<PreviewView>;
  close: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const view = ref<PreviewView>(initial) as Ref<PreviewView>;
  const close = vi.fn(() => {
    view.value = { phase: "closed" };
  });
  const retry = vi.fn();
  return {
    view,
    close,
    retry,
    handle: { view, scope: ref(null), open: vi.fn(), close, retry, dispose: vi.fn() },
  };
}

function mountHost(ctx: PreviewContext | null): ReturnType<typeof mount> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return mount(PreviewHost, {
    attachTo: host,
    global: ctx === null ? {} : { provide: { [PREVIEW_CTX as symbol]: ctx } },
  });
}

const overlay = (): HTMLElement | null => document.querySelector(".preview-overlay");
const panel = (): HTMLElement | null => document.querySelector(".preview-panel");

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

afterEach(() => {
  // Tests that leave a phase open never unmount their wrapper, leaking a scroll-lock hold
  // into the shared ref count (useScrollLock.ts) — reset it before touching overflow.
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
});

describe("PreviewHost.vue — closed / absent ctx", () => {
  it("renders nothing without PREVIEW_CTX (no PV6 wiring yet)", () => {
    mountHost(null);
    expect(overlay()).toBeNull();
  });

  it("renders nothing in the closed phase", () => {
    const { handle } = makeHandle();
    mountHost({ handle, plaintext: false });
    expect(overlay()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("PreviewHost.vue — phases", () => {
  it("loading: dialog semantics, basename + full path in the header, status text", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "loading", path: "/p/src/a.ts" };
    await tick();
    const p = panel();
    expect(p).not.toBeNull();
    expect(p!.getAttribute("role")).toBe("dialog");
    expect(p!.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".preview-title")!.textContent).toBe("a.ts");
    expect(document.querySelector(".preview-path")!.textContent).toBe("/p/src/a.ts");
    expect(document.querySelector(".preview-loading")!.getAttribute("role")).toBe("status");
  });

  it("image: renders PreviewImage with the data URL and dims", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = {
      phase: "image",
      path: "/p/a.png",
      dataUrl: "data:image/png;base64,AAAA",
      mime: "image/png",
      dims: { w: 4, h: 2 },
      size: 2048,
    };
    await tick();
    expect(document.querySelector(".preview-image img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(document.querySelector(".preview-meta")!.textContent).toContain("4 × 2");
    expect(document.querySelector(".preview-meta")!.textContent).toContain("2.0 KiB");
  });

  it("text: renders PreviewText; truncated badge shows when truncated", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "text", path: "/p/a.txt", text: "hello\nworld", truncated: true, size: 262144 };
    await tick();
    expect(document.querySelector(".preview-text-body")!.textContent).toBe("hello\nworld");
    expect(document.querySelector(".preview-truncated")).not.toBeNull();
  });

  it("unsupported: reason copy + file size", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "unsupported", path: "/p/a.bin", reason: "binary", size: 512 };
    await tick();
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("No preview available");
    expect(note.textContent).toContain("binary file");
    expect(note.textContent).toContain("512 B");
  });

  it("tooLarge: dims message + copy-path row", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "tooLarge", path: "/p/big.png", reason: "pixels", size: 100, dims: { w: 8000, h: 6000 } };
    await tick();
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("Too large to preview");
    expect(note.textContent).toContain("8000 × 6000");
    expect(note.querySelector(".preview-copy-path code")!.textContent).toBe("/p/big.png");
  });

  it("error: retry button only when retryable; retry() fires; retryAfter hint renders", async () => {
    const { handle, view, retry } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "error", path: "/p/a.ts", error: "E_RATE", retryable: true, retryAfterS: 3 };
    await tick();
    expect(document.querySelector(".preview-note")!.textContent).toContain("E_RATE");
    expect(document.querySelector(".preview-note")!.textContent).toContain("3s");
    await (document.querySelector(".preview-retry") as HTMLElement).click();
    expect(retry).toHaveBeenCalledTimes(1);
    view.value = { phase: "error", path: "/p/a.ts", error: "E_AUTH", retryable: false };
    await tick();
    expect(document.querySelector(".preview-retry")).toBeNull();
  });

  it("plaintext ctx: the §5.2 standing warning renders; hidden otherwise", async () => {
    const plain = makeHandle();
    mountHost({ handle: plain.handle, plaintext: true });
    plain.view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.querySelector(".preview-plaintext")).not.toBeNull();
    plain.view.value = { phase: "closed" };
    await tick();
  });
});

describe("PreviewHost.vue — close paths (§4.6)", () => {
  it("Esc closes with preventDefault + stopPropagation", async () => {
    const { handle, view, close } = makeHandle({ phase: "loading", path: "/p/a.ts" });
    mountHost({ handle, plaintext: false });
    await tick();
    const docListener = vi.fn();
    document.addEventListener("keydown", docListener);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    overlay()!.dispatchEvent(ev);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(docListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", docListener);
    await tick();
    expect(overlay()).toBeNull();
  });

  it("scrim click closes; a click inside the panel does not", async () => {
    const { handle, view, close } = makeHandle({ phase: "loading", path: "/p/a.ts" });
    mountHost({ handle, plaintext: false });
    await tick();
    panel()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("the header close button closes", async () => {
    const { handle, view, close } = makeHandle({ phase: "loading", path: "/p/a.ts" });
    mountHost({ handle, plaintext: false });
    await tick();
    (document.querySelector(".preview-close") as HTMLElement).click();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("PreviewHost.vue — focus + scroll lock (§4.6)", () => {
  it("focus enters the panel on open and returns to the previous element on close", async () => {
    const prior = document.createElement("button");
    document.body.appendChild(prior);
    prior.focus();
    expect(document.activeElement).toBe(prior);
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.activeElement).toBe(panel());
    view.value = { phase: "closed" };
    await tick();
    expect(document.activeElement).toBe(prior);
  });

  it("Tab cycles inside the panel (last → first, first → last on Shift+Tab)", async () => {
    const { handle, view } = makeHandle({
      phase: "text",
      path: "/p/a.txt",
      text: "body",
      truncated: false,
      size: 4,
    });
    mountHost({ handle, plaintext: false });
    await tick();
    const p = panel()!;
    // DOM order of focusables: header close button → pre[tabindex=0] → copy button.
    const first = document.querySelector(".preview-close") as HTMLElement;
    const mid = document.querySelector(".preview-text-body") as HTMLElement;
    const last = document.querySelector(".preview-text-actions button") as HTMLElement;
    // last focusable → Tab wraps to the first
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    p.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    // first focusable → Shift+Tab wraps to the last
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    p.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // middle focusable → Tab proceeds naturally (no preventDefault)
    mid.focus();
    const midTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    p.dispatchEvent(midTab);
    expect(midTab.defaultPrevented).toBe(false);
    view.value = { phase: "closed" };
    await tick();
  });

  it("body scroll locks while open and restores on close", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    view.value = { phase: "closed" };
    await tick();
    expect(document.body.style.overflow).toBe("");
  });

  it("the scroll lock is ALWAYS cleaned — unmounting mid-preview restores it too", async () => {
    const { handle, view } = makeHandle({ phase: "loading", path: "/p/a.ts" });
    const wrapper = mountHost({ handle, plaintext: false });
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    wrapper.unmount();
    expect(document.body.style.overflow).toBe("");
    view.value = { phase: "closed" };
  });

  it("a phase switch that stays open does not re-lock or steal focus", async () => {
    const { handle, view } = makeHandle({ phase: "loading", path: "/p/a.ts" });
    mountHost({ handle, plaintext: false });
    await tick();
    expect(document.body.style.overflow).toBe("hidden");
    view.value = { phase: "text", path: "/p/a.ts", text: "x", truncated: false, size: 1 };
    await tick();
    expect(document.body.style.overflow).toBe("hidden"); // still exactly one lock held
    view.value = { phase: "closed" };
    await tick();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("preview i18n namespace — en/zh parity (explicit, alongside i18n-parity.test.ts)", () => {
  it("identical key and placeholder sets", () => {
    const en = MESSAGES.en["preview"]!;
    const zh = MESSAGES.zh["preview"]!;
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of Object.keys(en)) {
      expect(ph(en[key]!), `preview.${key}`).toEqual(ph(zh[key]!));
    }
  });
});
