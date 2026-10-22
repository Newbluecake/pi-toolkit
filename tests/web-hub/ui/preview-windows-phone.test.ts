// @vitest-environment happy-dom
/**
 * web-hub-preview-windows plan r2 §10.2 (W2): the PHONE band (<768px) over the REAL
 * `usePreviewWindows` manager — the fullscreen z60 stack with scroll lock, only the TOP
 * window interactive (`inert` on the rest, `aria-modal=true` on the top panel only), the
 * Tab trap confined to the top window with `focusablesIn()`'s inert filtering (评审 #4), the
 * `2/3` badge, and the §6.3 cross-breakpoint behaviour (gesture end, focus into the top
 * window, scroll-lock release).
 *
 * The desktop band lives in preview-windows.test.ts; happy-dom's default innerWidth (1024)
 * is the desktop band, so every test here stubs `matchMedia` (useMedia reads it once per
 * mount and listens for `change` — the stub keeps a listener registry so a test can flip
 * the band live, which is exactly the cross-breakpoint case).
 */
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { usePreviewWindows } from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { HubState } from "../../../src/web-hub/ui/src/types.js";
import type { PreviewDirOutcome, PreviewTransport } from "../../../src/web-hub/ui/src/transport/types.js";

const DESKTOP_QUERY = "(min-width: 768px)";

/** A matchMedia stub with a listener registry — `flip()` drives useMedia's `change` events. */
function stubMedia(desktop: boolean): { flip(next: boolean): void } {
  const state = new Map<string, boolean>([[DESKTOP_QUERY, desktop]]);
  const listeners = new Map<string, Set<(ev: { matches: boolean }) => void>>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return state.get(query) ?? false;
    },
    addEventListener(_type: "change", listener: (ev: { matches: boolean }) => void): void {
      const set = listeners.get(query) ?? new Set();
      set.add(listener);
      listeners.set(query, set);
    },
    removeEventListener(_type: "change", listener: (ev: { matches: boolean }) => void): void {
      listeners.get(query)?.delete(listener);
    },
  }));
  return {
    flip(next: boolean): void {
      state.set(DESKTOP_QUERY, next);
      for (const fn of listeners.get(DESKTOP_QUERY) ?? []) fn({ matches: next });
    },
  };
}

function rig(desktop: boolean): {
  handle: ReturnType<typeof usePreviewWindows>;
  resolveText(path: string, body: string): void;
  resolveDir(entries: Array<{ name: string; type: "dir" | "file"; size?: number; mtimeMs: number }>): void;
} {
  const state = ref({
    clientId: "c1",
    hub: { caps: ["preview.v1", "preview.dir.v1"] },
    conn: "open",
    selected: "A",
    agents: new Map<string, unknown>([["A", { session: { sessionId: "s1", cwd: "/p" } }]]),
    order: ["A"],
  } as unknown as HubState);
  const waits: Array<{ resolve: (o: PreviewDirOutcome) => void }> = [];
  const transport: PreviewTransport = {
    fetch: () => new Promise<PreviewDirOutcome>((resolve) => waits.push({ resolve })),
  };
  const hub = {
    state,
    preview: {
      fetch: () => new Promise((resolve) => waits.push({ resolve: resolve as (o: PreviewDirOutcome) => void })),
    },
    dispatch: () => {},
  };
  const handle = usePreviewWindows({ preview: transport, mode: "token", state, coarse: ref(false) });
  const host = document.createElement("div");
  document.body.appendChild(host);
  mount(PreviewHost, {
    attachTo: host,
    global: {
      provide: {
        [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext,
        [HUB_CTX as symbol]: hub,
      },
    },
  });
  return {
    handle,
    resolveText(path: string, body: string): void {
      waits.shift()?.resolve({ ok: true, kind: "text", size: body.length, truncated: false, text: body });
    },
    resolveDir(entries): void {
      waits.shift()?.resolve({
        ok: true,
        kind: "dir",
        listing: {
          entries,
          total: entries.length,
          scanned: entries.length,
          complete: true,
          truncated: false,
          limits: { scan: false, entries: false, bytes: false },
          vanished: 0,
          dropped: 0,
        },
      } as unknown as PreviewDirOutcome);
    },
  };
}

const sections = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-window")];
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-panel")];
const overlay = (): HTMLElement => document.querySelector(".preview-overlay") as HTMLElement;

const openTwo = async (r: ReturnType<typeof rig>): Promise<void> => {
  r.handle.open({ path: "/p/a.txt" });
  await nextTick();
  await nextTick();
  r.resolveText("/p/a.txt", "aaa");
  await nextTick();
  await nextTick();
  r.handle.open({ path: "/p/b.txt" });
  await nextTick();
  await nextTick();
  r.resolveText("/p/b.txt", "bbb");
  await nextTick();
  await nextTick();
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  document.body.classList.remove("pwh-pw-dragging");
});

describe("preview windows — phone band (<768px, real manager)", () => {
  it("§6.1: fullscreen stack — no hot zones, no geometry vars, inert non-top, top-only aria-modal, scroll lock, 2/2 badge", async () => {
    stubMedia(false);
    const r = rig(false);
    await openTwo(r);
    expect(overlay().classList.contains("is-modeless")).toBe(false); // keeps the modal z60 base
    expect(document.querySelectorAll(".pw-rz")).toHaveLength(0); // no resize handles
    const [s1, s2] = sections();
    expect(s1!.getAttribute("inert")).not.toBeNull(); // lower window: inert
    expect(s2!.getAttribute("inert")).toBeNull(); // top window: interactive
    expect(s1!.style.getPropertyValue("--pw-x")).toBe(""); // geometry vars only on desktop
    expect(s2!.style.getPropertyValue("--pw-z")).not.toBe("");
    expect(panels()[0]!.getAttribute("aria-modal")).toBe("false"); // non-top: NOT modal
    expect(panels()[1]!.getAttribute("aria-modal")).toBe("true"); // top: the one modal (评审 #3)
    expect(document.body.style.overflow).toBe("hidden"); // scroll lock while stacked
    const badges = [...document.querySelectorAll<HTMLElement>(".pw-count")];
    expect(badges.map((b) => b.textContent)).toEqual(["1/2", "2/2"]); // compact token (§6.1)
    expect(badges[1]!.getAttribute("aria-label")).toBe("Window 2 of 2");
    r.handle.close();
    await nextTick();
    await nextTick();
  });

  it("§6.2: the Tab trap cycles INSIDE the top window only — bidirectional + panel-self + inert filtering", async () => {
    stubMedia(false);
    const r = rig(false);
    await openTwo(r);
    const top = sections()[1]!;
    const focusables = [
      ...top.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])"),
    ];
    expect(focusables.length).toBeGreaterThan(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    // Tab from the last focusable wraps to the first — inside the TOP window
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    // Shift+Tab from the first wraps to the last
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    // Shift+Tab with focus on the PANEL ITSELF (tabindex=-1) goes to the last
    const panel = panels()[1]!;
    panel.focus();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    // a plain Tab with focus OUTSIDE the top window is pulled back in (never the lower window)
    const lowerBtn = sections()[0]!.querySelector<HTMLElement>("button")!;
    lowerBtn.focus();
    lowerBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(top.contains(document.activeElement)).toBe(true);
    r.handle.close();
    await nextTick();
    await nextTick();
  });

  it("§6.1/§5.4: Esc closes the TOP window; focus lands on the new top; the LAST close releases the lock and returns pageFocus", async () => {
    stubMedia(false);
    const r = rig(false);
    const pageBtn = document.createElement("button");
    document.body.appendChild(pageBtn);
    await openTwo(r);
    expect(document.body.style.overflow).toBe("hidden");
    // Esc from the LOWER window is ignored by the shell (phone: top-only close, §6.1)
    sections()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(panels()).toHaveLength(2); // nothing closed
    const topPanel = panels()[1]!;
    topPanel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(panels()).toHaveLength(1);
    expect(document.activeElement).toBe(panels()[0]); // focus landed on the new top
    // close the last one: lock released, focus back on the page
    pageBtn.focus(); // any outside focusin refreshes pageFocus (r2 复审处置)
    await nextTick();
    panels()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(panels()).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(pageBtn);
  });

  it("§6.3: crossing INTO the phone band ends an in-flight drag, focuses the top window and locks; crossing back releases the lock", async () => {
    const media = stubMedia(true);
    const r = rig(true);
    r.handle.open({ path: "/p/a.txt" });
    await nextTick();
    await nextTick();
    r.resolveText("/p/a.txt", "a");
    await nextTick();
    await nextTick();
    // start a desktop drag and move past the threshold
    const sec = sections()[0]!;
    const header = sec.querySelector<HTMLElement>(".preview-header")!;
    header.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 3, button: 0, clientX: 200, clientY: 30, bubbles: true }),
    );
    header.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 260, clientY: 90, bubbles: true }));
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(true);
    // cross into the phone band
    media.flip(false);
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(false); // gesture ended (sync)
    await nextTick();
    await nextTick();
    expect(document.querySelector(".pw-rz")).toBeNull(); // handles gone with the band
    expect(document.body.style.overflow).toBe("hidden"); // the phone stack locks
    expect(sections()[0]!.contains(document.activeElement)).toBe(true); // focus entered the top window
    // cross back to desktop: lock released, geometry restored (vars re-bound)
    media.flip(true);
    await nextTick();
    await nextTick();
    expect(document.body.style.overflow).toBe("");
    expect(sections()[0]!.style.getPropertyValue("--pw-x")).not.toBe("");
    r.handle.close();
    await nextTick();
    await nextTick();
  });

  it("§5.5 (r2 复审处置): crossing into the phone band closes an open pw-menu", async () => {
    const media = stubMedia(true);
    const r = rig(true);
    r.handle.open({ path: "/p/a.txt" });
    await nextTick();
    await nextTick();
    r.resolveText("/p/a.txt", "a");
    await nextTick();
    await nextTick();
    document.querySelector<HTMLElement>(".pw-menu-btn")!.click();
    await nextTick();
    await nextTick();
    expect(document.querySelector(".pw-menu")).not.toBeNull();
    media.flip(false);
    await nextTick();
    await nextTick();
    expect(document.querySelector(".pw-menu")).toBeNull(); // closed with the band crossing
    r.handle.close();
    await nextTick();
    await nextTick();
  });

  it("back button (phone): empty history ⇒ enabled, labelled close, and closes the top window", async () => {
    stubMedia(false);
    const r = rig(false);
    await openTwo(r);
    const topBack = panels()[1]!.querySelector<HTMLButtonElement>(".preview-nav-btn")!;
    expect(topBack.disabled).toBe(false);
    expect(topBack.getAttribute("aria-label")).toBe(
      panels()[1]!.querySelector(".preview-close")!.getAttribute("aria-label"),
    );
    topBack.click();
    await nextTick();
    await nextTick();
    expect(panels()).toHaveLength(1); // only the top closed
    expect(panels()[0]!.querySelector(".preview-close")).not.toBeNull();
  });

  it("back button (phone): non-empty history ⇒ in-window back, window stays open", async () => {
    stubMedia(false);
    const r = rig(false);
    r.handle.open({ path: "/p/src", dir: true });
    await nextTick();
    await nextTick();
    r.resolveDir([{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await nextTick();
    await nextTick();
    const row = document.querySelector<HTMLElement>(".preview-dir-list button.preview-dir-row")!;
    row.click();
    row.click();
    await nextTick();
    r.resolveDir([{ name: "x.ts", type: "file", size: 1, mtimeMs: 1 }]);
    await nextTick();
    await nextTick();
    const back = document.querySelector<HTMLButtonElement>(".preview-nav-btn")!;
    expect(back.disabled).toBe(false);
    back.click();
    await nextTick();
    await nextTick();
    expect(panels()).toHaveLength(1);
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("sub");
  });

  it("back button (desktop): empty history ⇒ still disabled", async () => {
    stubMedia(true);
    const r = rig(true);
    r.handle.open({ path: "/p/a.txt" });
    await nextTick();
    await nextTick();
    r.resolveText("/p/a.txt", "aaa");
    await nextTick();
    await nextTick();
    expect(document.querySelector<HTMLButtonElement>(".preview-nav-btn")!.disabled).toBe(true);
  });
});
