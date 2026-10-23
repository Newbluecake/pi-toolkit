// @vitest-environment happy-dom
/**
 * 2026-10-22 L1 拍板「桌面端预览窗口最大化/恢复」— the DESKTOP window algebra over the REAL
 * `usePreviewWindows` manager + the real `usePreviewWindowLayout` controller (production
 * path, same rig family as preview-windows.test.ts): the header toggle button
 * (icon/aria-pressed/label), double-click on the title bar (and the interactive-control
 * exemption), the drag/resize disable while maximized, the viewport-follow + clamped
 * restore, the 「⋯」 menu entry, per-window independence, 「重置位置和大小」 cancelling a
 * maximize, and the phone band carrying none of it.
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

/** A matchMedia stub with a listener registry (preview-windows-phone.test.ts's helper). */
function stubMedia(desktop: boolean): void {
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
}

/** The production rig: the REAL manager over a scripted transport (+ optional phone band). */
function rig(opts: { phone?: boolean } = {}) {
  const state = ref({
    clientId: "c1",
    hub: { caps: ["preview.v1"] },
    conn: "open",
    selected: "A",
    agents: new Map<string, unknown>([["A", { session: { sessionId: "s1", cwd: "/p" } }]]),
    order: ["A"],
  } as unknown as HubState);
  const waits: Array<{ resolve: (o: PreviewDirOutcome) => void }> = [];
  const pend = (): Promise<PreviewDirOutcome> => new Promise<PreviewDirOutcome>((resolve) => waits.push({ resolve }));
  const transport: PreviewTransport = { fetch: () => pend() };
  const hub = {
    state,
    preview: { fetch: () => pend() },
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
  const open = async (path: string, body: string): Promise<void> => {
    handle.open({ path });
    await nextTick();
    await nextTick();
    waits.shift()?.resolve({ ok: true, kind: "text", size: body.length, truncated: false, text: body });
    await nextTick();
    await nextTick();
  };
  return { handle, open };
}

const sections = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-window")];

/** happy-dom's viewport setter (typed cast — proxy-preview.test.ts's convention). */
const setViewport = (width: number, height: number): void => {
  (
    window as unknown as {
      happyDOM?: { setViewport(o: { width: number; height: number }): void };
    }
  ).happyDOM?.setViewport({ width, height });
};

const cssVar = (el: HTMLElement, name: string): number => Number.parseFloat(el.style.getPropertyValue(name));
const varsOf = (el: HTMLElement): Record<string, number> => ({
  x: cssVar(el, "--pw-x"),
  y: cssVar(el, "--pw-y"),
  w: cssVar(el, "--pw-w"),
  h: cssVar(el, "--pw-h"),
});
const maxBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(".pw-max-btn")!;
const menuButtonByText = (needle: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>(".pw-menu-item")].find((b) =>
    (b.textContent ?? "").includes(needle),
  );
const openMenu = async (): Promise<void> => {
  document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
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

describe("preview windows — maximize/restore (desktop, real manager)", () => {
  it("拍板 1: the header button fills the usable box and restores the EXACT prior rect", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    const sec = sections()[0]!;
    const before = { ...varsOf(sec) };
    const btn = maxBtn();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Maximize window");
    btn.click();
    await nextTick();
    await nextTick();
    expect(sec.classList.contains("is-maximized")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Restore window size");
    // happy-dom default viewport 1024×768, no topbar ⇒ top=0; EDGE inset on every side
    expect(varsOf(sec)).toEqual({ x: 8, y: 8, w: window.innerWidth - 16, h: window.innerHeight - 16 });
    btn.click();
    await nextTick();
    await nextTick();
    expect(sec.classList.contains("is-maximized")).toBe(false);
    expect(varsOf(sec)).toEqual(before);
    r.handle.close();
    await nextTick();
  });

  it("拍板: double-click on the title bar toggles; double-click on BUTTONS never does", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    const sec = sections()[0]!;
    const header = sec.querySelector<HTMLElement>(".preview-header")!;
    const maxed = (): boolean => sec.classList.contains("is-maximized");
    header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(maxed()).toBe(true);
    // double-clicking the toggle button itself (bubbles to the header) must NOT flip again
    maxBtn().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await nextTick();
    expect(maxed()).toBe(true);
    // nor the close button, nor the 「⋯」 menu trigger
    sec.querySelector<HTMLElement>(".preview-close")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    sec.querySelector<HTMLElement>(".pw-menu-btn")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await nextTick();
    expect(maxed()).toBe(true);
    expect(sections()).toHaveLength(1); // and nothing closed
    header.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(maxed()).toBe(false);
    r.handle.close();
    await nextTick();
  });

  it("拍板 1: maximized ⇒ no resize hot zones and a header drag never moves the rect", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    const sec = sections()[0]!;
    maxBtn().click();
    await nextTick();
    await nextTick();
    expect(document.querySelectorAll(".pw-rz")).toHaveLength(0);
    const maxed = varsOf(sec);
    const header = sec.querySelector<HTMLElement>(".preview-header")!;
    header.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 3, button: 0, clientX: 300, clientY: 40, bubbles: true }),
    );
    header.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 700, clientY: 400, bubbles: true }));
    await nextTick();
    await nextTick();
    expect(varsOf(sec)).toEqual(maxed); // the drag never started
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(false);
    r.handle.close();
    await nextTick();
  });

  it("拍板 1: a maximized window FOLLOWS a viewport resize; restore clamps into the new viewport", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    const sec = sections()[0]!;
    maxBtn().click();
    await nextTick();
    await nextTick();
    setViewport(900, 700);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    await nextTick();
    expect(varsOf(sec)).toEqual({ x: 8, y: 8, w: 884, h: 684 }); // still desktop (≥768), fills the box
    maxBtn().click(); // restore — the pre-maximize rect (960 wide, placed for 1024) clamps in
    await nextTick();
    await nextTick();
    const restored = varsOf(sec);
    expect(restored.w).toBe(884); // 960 clamped down to the usable width
    // the canonical clampRect keeps the TITLE reachable (P4) — not full containment: the
    // body may overhang the right/bottom edge exactly like a manually-dragged window
    expect(restored.x).toBeGreaterThanOrEqual(96 - restored.w);
    expect(restored.x).toBeLessThanOrEqual(900 - 96);
    setViewport(1024, 768);
    r.handle.close();
    await nextTick();
  });

  it("拍板: the 「⋯」 menu carries 最大化/恢复 with the state-flipped label; other windows are untouched", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    await r.open("/p/b.txt", "b");
    await openMenu();
    const item = menuButtonByText("Maximize window");
    expect(item).toBeDefined();
    item!.click();
    await nextTick();
    await nextTick();
    expect(sections()[0]!.classList.contains("is-maximized")).toBe(true);
    expect(sections()[1]!.classList.contains("is-maximized")).toBe(false); // per-window state
    const otherVars = varsOf(sections()[1]!);
    expect(otherVars.w).toBeLessThan(window.innerWidth - 16); // still a normal cascade rect
    await openMenu();
    const restoreItem = menuButtonByText("Restore window size");
    expect(restoreItem).toBeDefined();
    restoreItem!.click();
    await nextTick();
    await nextTick();
    expect(sections()[0]!.classList.contains("is-maximized")).toBe(false);
    r.handle.close();
    await nextTick();
  });

  it("拍板 2: 「重置位置和大小」 cancels a maximize and recenters", async () => {
    const r = rig();
    await r.open("/p/a.txt", "a");
    const sec = sections()[0]!;
    maxBtn().click();
    await nextTick();
    await nextTick();
    expect(sec.classList.contains("is-maximized")).toBe(true);
    await openMenu();
    menuButtonByText("Reset position and size")!.click();
    await nextTick();
    await nextTick();
    expect(sec.classList.contains("is-maximized")).toBe(false);
    const v = varsOf(sec);
    expect(Math.abs(v.x - (window.innerWidth - (v.x + v.w)))).toBeLessThanOrEqual(1); // centered
    r.handle.close();
    await nextTick();
  });

  it("拍板 4: the phone band renders NO maximize button and NO menu entry", async () => {
    stubMedia(false);
    const r = rig({ phone: true });
    await r.open("/p/a.txt", "a");
    expect(document.querySelector(".pw-max-btn")).toBeNull();
    await openMenu();
    expect(menuButtonByText("Maximize window")).toBeUndefined();
    expect(menuButtonByText("Reset position and size")).toBeUndefined(); // desktop-only family
    expect(menuButtonByText("Close all")).toBeDefined(); // the menu itself still works
    r.handle.close();
    await nextTick();
  });
});
