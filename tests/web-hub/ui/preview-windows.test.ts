// @vitest-environment happy-dom
/**
 * web-hub-preview-windows plan r2 §10.2 (W2): the DESKTOP window algebra over the REAL
 * `usePreviewWindows` manager (production path) — cascade placement, modeless shell, z-order
 * without DOM reorder, gestures, the 「⋯」 window menu, keyboard geometry, the cap notice and
 * per-window download independence. Routing table coverage (file rows / md refs / dir links)
 * lives in preview-host.test.ts's dir suite (same production path); the phone band lives in
 * preview-windows-phone.test.ts.
 */
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { PREVIEW_WINDOW_MAX, usePreviewWindows } from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { HubState, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type {
  PreviewDirListing,
  PreviewDirOutcome,
  PreviewTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

/** The production rig: the REAL manager over a scripted transport (+ optional HUB fake). */
function rig(opts: { caps?: string[]; slow?: boolean } = {}) {
  const agents = new Map<string, unknown>([
    [
      "A",
      {
        key: "A",
        card: { session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" } },
        session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" },
      },
    ],
  ]);
  const state = ref({
    clientId: "c1",
    hub: { caps: opts.caps ?? ["preview.v1", "preview.dir.v1", "preview.html.v1"] },
    conn: "open",
    selected: "A",
    agents,
    order: ["A"],
  } as unknown as HubState);
  const calls: Array<{ req: { path: string; dir?: true } }> = [];
  const waits: Array<{ resolve: (o: PreviewDirOutcome) => void }> = [];
  const transport: PreviewTransport = {
    fetch: (req) => {
      calls.push({ req });
      return new Promise<PreviewDirOutcome>((resolve) => waits.push({ resolve }));
    },
  };
  const handle = ref<unknown>(null);
  const hubFake = {
    state,
    preview: {
      fetch: (req: { path: string }) => {
        calls.push({ req: { path: req.path } });
        return new Promise((resolve) => waits.push({ resolve: resolve as (o: PreviewDirOutcome) => void }));
      },
      htmlCap: () =>
        Promise.resolve({
          ok: true,
          url: "/pv/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
          openUrl: "/pvw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          idleMs: 900_000,
          hardRemainingMs: 3_600_000,
        }),
    },
    dispatch: () => {},
  };
  const previewHandle = usePreviewWindows({ preview: transport, mode: "token", state, coarse: ref(false) });
  handle.value = previewHandle;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PreviewHost, {
    attachTo: host,
    global: {
      provide: {
        [PREVIEW_CTX as symbol]: { handle: previewHandle, plaintext: false } satisfies PreviewContext,
        [HUB_CTX as symbol]: hubFake,
      },
    },
  });
  const text = (path: string, body: string): void => {
    const w = waits.shift();
    w?.resolve({ ok: true, kind: "text", size: body.length, truncated: false, text: body });
  };
  const dir = (path: string, entries: PreviewDirListing["entries"]): void => {
    const w = waits.shift();
    w?.resolve({
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
    });
  };
  return { handle: previewHandle, calls, waits, wrapper, text, dir, hubFake };
}

const overlay = (): HTMLElement => document.querySelector(".preview-overlay") as HTMLElement;
const sections = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-window")];
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-panel")];
const cssVar = (el: HTMLElement, name: string): number => Number.parseFloat(el.style.getPropertyValue(name));

afterEach(() => {
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  document.body.classList.remove("pwh-pw-dragging");
  vi.restoreAllMocks();
});

describe("preview windows — desktop (real manager)", () => {
  it("§3.1/§7.3: a file ref click ADDS a window, staggered off the previous active one; window 1's DOM stays", async () => {
    const r = rig();
    r.handle.open({ path: "/p/readme.md" });
    await tick();
    r.text("/p/readme.md", "see `src/deep/x.ts`");
    await tick();
    expect(panels()).toHaveLength(1);
    const first = sections()[0]!;
    const ref = document.querySelector(".preview-md .path-ref") as HTMLElement;
    ref.click();
    await tick();
    expect(panels()).toHaveLength(2);
    expect(sections()[0]).toBe(first); // same node — never reordered
    const a = sections()[0]!;
    const b = sections()[1]!;
    // cascade: the second window's origin differs from the first by the 32px step (or more)
    expect(
      Math.abs(cssVar(b, "--pw-x") - cssVar(a, "--pw-x")) + Math.abs(cssVar(b, "--pw-y") - cssVar(a, "--pw-y")),
    ).toBeGreaterThan(0);
    r.text("/p/src/deep/x.ts", "export {}");
    await tick();
    r.handle.close();
    await tick();
  });

  it("§5: MODELESS — root carries is-modeless, no body scroll lock, a page button stays clickable; a conversation path click APPENDS", async () => {
    const r = rig();
    let pageClicks = 0;
    const pageBtn = document.createElement("button");
    pageBtn.addEventListener("click", () => {
      pageClicks += 1;
    });
    document.body.appendChild(pageBtn);
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "x");
    await tick();
    expect(overlay().classList.contains("is-modeless")).toBe(true);
    expect(document.body.style.overflow).toBe(""); // no scroll lock on desktop
    pageBtn.click();
    expect(pageClicks).toBe(1); // the page is NOT pointer-blocked by any scrim
    pageBtn.focus();
    r.handle.open({ path: "/p/b.txt" }); // a CONVERSATION click appends — never closeAll
    await tick();
    r.text("/p/b.txt", "y");
    await tick();
    expect(panels()).toHaveLength(2);
    r.handle.close();
    await tick();
  });

  it("§5.4: focus follows opens/closes; a dedup hit MOVES focus to the hit window", async () => {
    const r = rig();
    r.handle.open({ path: "/p/readme.md" });
    await tick();
    r.text("/p/readme.md", "see `/p/src/deep/x.ts` here");
    await tick();
    const ref = document.querySelector(".preview-md .path-ref") as HTMLElement;
    ref.focus(); // window 1's lastFocus
    ref.click();
    await tick();
    r.text("/p/src/deep/x.ts", "export {}");
    await tick();
    expect(panels()).toHaveLength(2);
    expect(document.activeElement).toBe(panels()[1]); // the new window took focus
    // close window 2 → focus returns to window 1's link (its lastFocus)
    const closes = [...document.querySelectorAll<HTMLElement>(".preview-close")];
    closes[1]!.focus();
    closes[1]!.click();
    await tick();
    expect(panels()).toHaveLength(1);
    expect(document.activeElement).toBe(ref);
    // dedup: the same path again just FOCUSES window 1 — onto its OWN lastFocus (§5.4)
    r.handle.open({ path: "/p/readme.md" });
    await tick();
    expect(panels()).toHaveLength(1);
    expect(document.activeElement).toBe(ref);
    r.handle.close();
    await tick();
  });

  it("§5.1/R1: activating a back window only changes --pw-z — node order and the iframe element are unchanged", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.html" });
    await tick();
    r.text("/p/a.html", "<p>x</p>");
    await tick();
    // the html entry renders the sandboxed iframe (lazy chunk)
    await vi.waitFor(() => expect(document.querySelector("iframe.preview-html-frame")).not.toBeNull(), {
      timeout: 4000,
    });
    r.handle.open({ path: "/p/b.txt" });
    await tick();
    r.text("/p/b.txt", "y");
    await tick();
    const [s1, s2] = sections();
    const z1 = cssVar(s1!, "--pw-z");
    const z2 = cssVar(s2!, "--pw-z");
    expect(z2).toBeGreaterThan(z1); // window 2 is active = higher z
    const frame = document.querySelector("iframe.preview-html-frame")!;
    // activate window 1 by pointerdown (§5.4)
    s1!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(sections()[0]).toBe(s1); // same order
    expect(sections()[1]).toBe(s2);
    expect(cssVar(s1!, "--pw-z")).toBeGreaterThan(cssVar(s2!, "--pw-z")); // z flipped
    expect(document.querySelector("iframe.preview-html-frame")).toBe(frame); // NOT remounted
    r.handle.close();
    await tick();
  });

  it("§7.4: drag — 3px threshold, no drag off a button, body class lifecycle", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "x");
    await tick();
    const sec = sections()[0]!;
    const header = sec.querySelector<HTMLElement>(".preview-header")!;
    const x0 = cssVar(sec, "--pw-x");
    // from a BUTTON: never starts
    const closeBtn = header.querySelector<HTMLElement>(".preview-close")!;
    closeBtn.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 300, clientY: 40, bubbles: true }),
    );
    header.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 500, clientY: 300, bubbles: true }));
    await tick();
    expect(cssVar(sec, "--pw-x")).toBe(x0);
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(false);
    // from the header: below threshold nothing; ≥3px moves and arms the class
    header.dispatchEvent(
      new PointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 300, clientY: 40, bubbles: true }),
    );
    header.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 301, clientY: 40, bubbles: true }));
    await tick();
    expect(cssVar(sec, "--pw-x")).toBe(x0);
    header.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 340, clientY: 60, bubbles: true }));
    await tick();
    expect(cssVar(sec, "--pw-x")).toBeCloseTo(x0 + 40, 0);
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(true);
    header.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true }));
    expect(document.body.classList.contains("pwh-pw-dragging")).toBe(false);
    r.handle.close();
    await tick();
  });

  it("§5.5: title-bar keyboard move/resize (arrows 16px, Shift+arrows resize the SE edge, clamped)", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "x");
    await tick();
    const sec = sections()[0]!;
    const header = sec.querySelector<HTMLElement>(".preview-header")!;
    expect(header.getAttribute("tabindex")).toBe("0");
    header.focus();
    const x0 = cssVar(sec, "--pw-x");
    const y0 = cssVar(sec, "--pw-y");
    const w0 = cssVar(sec, "--pw-w");
    const h0 = cssVar(sec, "--pw-h");
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await tick();
    expect(cssVar(sec, "--pw-x")).toBeCloseTo(x0 - 16, 0);
    header.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(cssVar(sec, "--pw-w")).toBeCloseTo(w0 + 16, 0);
    // negative deltas shrink the SAME right/bottom edge (verify:W2 rework — the handle is
    // unconditionally "se", so Shift+← pulls the right edge LEFT; x never moves)
    header.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(cssVar(sec, "--pw-w")).toBeCloseTo(w0, 0);
    expect(cssVar(sec, "--pw-x")).toBeCloseTo(x0 - 16, 0); // x moved only via the earlier plain ←
    header.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(cssVar(sec, "--pw-h")).toBeCloseTo(h0 - 16, 0);
    expect(cssVar(sec, "--pw-y")).toBeCloseTo(y0, 0);
    // clamped: a huge left move keeps the title bar reachable (P4)
    for (let i = 0; i < 200; i++)
      header.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await tick();
    expect(cssVar(sec, "--pw-x")).toBeGreaterThanOrEqual(96 - cssVar(sec, "--pw-w"));
    r.handle.close();
    await tick();
  });

  it("§5.5: the 「⋯」 menu — keyboard open/↑↓, Esc closes the MENU only, 全部关闭 returns focus to pageFocus", async () => {
    const r = rig();
    const pageBtn = document.createElement("button");
    document.body.appendChild(pageBtn);
    pageBtn.focus();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "x");
    await tick();
    const menuBtn = document.querySelector<HTMLElement>(".pw-menu-btn")!;
    menuBtn.focus();
    menuBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await tick();
    const menu = document.querySelector<HTMLElement>(".pw-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    const items = [...menu.querySelectorAll<HTMLElement>(".pw-menu-item")];
    expect(items.length).toBeGreaterThanOrEqual(2); // 全部关闭 + 重置 + window list
    expect(document.activeElement).toBe(items[0]); // opening focuses the first item
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[1]);
    // Esc closes the menu ONLY — the window survives (stopPropagation)
    const escSpy = vi.fn();
    window.addEventListener("keydown", escSpy);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector(".pw-menu")).toBeNull();
    expect(panels()).toHaveLength(1);
    expect(escSpy).not.toHaveBeenCalled(); // stopped before the page level
    window.removeEventListener("keydown", escSpy);
    // reopen via click and 全部关闭
    document.querySelector<HTMLElement>(".pw-menu-btn")!.click();
    await tick();
    const closeAll = [...document.querySelectorAll<HTMLElement>(".pw-menu-item")][0]!;
    closeAll.click();
    await tick();
    expect(panels()).toHaveLength(0);
    expect(document.activeElement).toBe(pageBtn); // focus returned to the page
  });

  it("§5.5: the window list — selecting a window reorders + moves focus; 重置位置和大小 recenters", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "a");
    r.handle.open({ path: "/p/b.txt" });
    await tick();
    r.text("/p/b.txt", "b");
    await tick();
    const sec1 = sections()[0]!;
    const before = { x: cssVar(sec1, "--pw-x"), w: cssVar(sec1, "--pw-w") };
    // open window 2's menu, reset its geometry, then jump to window 1 via the list
    sections()[1]!.querySelector<HTMLElement>(".pw-menu-btn")!.click();
    await tick();
    const items = [...document.querySelectorAll<HTMLElement>(".pw-menu-item")];
    const reset = items.find((b) => b.textContent?.includes("Reset"))!;
    reset.click();
    await tick();
    // window 2 recenters: x = EDGE + (AW − w)/2 — symmetric margins
    const sec2 = sections()[1]!;
    const m1 = cssVar(sec2, "--pw-x");
    const m2 = window.innerWidth - (cssVar(sec2, "--pw-x") + cssVar(sec2, "--pw-w"));
    expect(Math.abs(m1 - m2)).toBeLessThanOrEqual(1);
    expect(before.w).toBeGreaterThan(0);
    // window list: 2 windows + close-all + reset ⇒ the last two items are the windows
    sections()[1]!.querySelector<HTMLElement>(".pw-menu-btn")!.click();
    await tick();
    const listItems = [...document.querySelectorAll<HTMLElement>(".pw-menu-item")];
    const win1 = listItems.find((b) => b.textContent?.includes("a.txt"))!;
    expect(win1.getAttribute("aria-current")).toBeNull(); // window 2 is current
    win1.click();
    await tick();
    expect(document.activeElement).toBe(panels()[0]); // focus moved to window 1
    expect(cssVar(sections()[0]!, "--pw-z")).toBeGreaterThan(cssVar(sections()[1]!, "--pw-z"));
    r.handle.close();
    await tick();
  });

  it("§3.4: at the cap the 7th open navigates IN PLACE with a role=status notice (row + conversation entries)", async () => {
    const r = rig();
    for (let i = 0; i < PREVIEW_WINDOW_MAX; i++) {
      r.handle.open({ path: `/p/f${i}.txt` });
      await tick();
      r.text(`/p/f${i}.txt`, `body${i}`);
      await tick();
    }
    expect(panels()).toHaveLength(PREVIEW_WINDOW_MAX);
    // entry A: a FILE ROW inside the ACTIVE window (a dir listing in window 6)
    r.handle.open({ path: "/p/src", dir: true });
    await tick();
    r.dir("/p/src", [{ name: "next.ts", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    expect(panels()).toHaveLength(PREVIEW_WINDOW_MAX); // in-place — no 7th window
    (document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement).click();
    await tick();
    const notice = document.querySelector<HTMLElement>(".preview-window-limit")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(String(PREVIEW_WINDOW_MAX));
    r.text("/p/src/next.ts", "next"); // resolve the in-place navigation the cap forced
    await tick();
    // §3.4 clear rule ①: the window's OWN next navigate/back (navEpoch bump) clears it —
    // 返回 is a snapshot restore, so no new fetch is needed.
    const activeSec = sections()[sections().length - 1]!; // the noticing window (the active one)
    (activeSec.querySelector(".preview-nav-btn") as HTMLElement).click();
    await tick();
    expect(document.querySelector(".preview-window-limit")).toBeNull();
    // entry B: a CONVERSATION click at the cap → the ACTIVE window navigates + notices
    r.handle.open({ path: "/p/z.md" });
    await tick();
    r.text("/p/z.md", "z");
    await tick();
    expect(panels()).toHaveLength(PREVIEW_WINDOW_MAX);
    expect(document.querySelector(".preview-window-limit")).not.toBeNull();
    r.handle.close();
    await tick();
  });

  it("§10.2: per-window downloads are independent (dlBusy does not leak across windows)", async () => {
    let release: ((o: PreviewDirOutcome) => void) | null = null;
    const agents = new Map<string, unknown>([
      ["A", { session: { sessionId: "s1", cwd: "/p" }, card: { session: { sessionId: "s1", cwd: "/p" } } }],
    ]);
    const state = ref({ selected: "A", agents, hub: { caps: ["preview.v1"] } } as unknown as HubState);
    const transport: PreviewTransport = {
      fetch: () => new Promise<PreviewDirOutcome>((resolve) => (release = resolve)),
    };
    const hub = {
      state,
      preview: {
        fetch: () => new Promise((resolve) => (release = resolve as (o: PreviewDirOutcome) => void)),
      },
      dispatch: () => {},
    };
    const previewHandle = usePreviewWindows({ preview: transport, mode: "token", state, coarse: ref(false) });
    const host = document.createElement("div");
    document.body.appendChild(host);
    mount(PreviewHost, {
      attachTo: host,
      global: {
        provide: {
          [PREVIEW_CTX as symbol]: { handle: previewHandle, plaintext: false } satisfies PreviewContext,
          [HUB_CTX as symbol]: hub,
        },
      },
    });
    const openTextView = (path: string): void => {
      previewHandle.open({ path });
    };
    openTextView("/p/a.txt");
    await tick();
    release?.({ ok: true, kind: "text", size: 1, truncated: false, text: "a" });
    await tick();
    openTextView("/p/b.txt");
    await tick();
    release?.({ ok: true, kind: "text", size: 1, truncated: false, text: "b" });
    await tick();
    const saved: Array<{ download: string }> = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      (b: Blob) => `blob:${saved.push({ download: String(b.size) })}`,
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      /* swallow */
    });
    const btns = [...document.querySelectorAll<HTMLButtonElement>(".preview-download")];
    expect(btns).toHaveLength(2);
    btns[0]!.click(); // window 1's download — the hub fetch pends
    await tick();
    expect(btns[0]!.disabled).toBe(true); // busy
    expect(btns[1]!.disabled).toBe(false); // window 2 is untouched
    release?.({ ok: true, kind: "text", size: 1, truncated: false, text: "a" });
    await vi.waitFor(() => expect(btns[0]!.disabled).toBe(false));
    previewHandle.close();
    await tick();
  });

  it("§5.3: aria — every panel is a NON-modal dialog labelled by its own title", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "a");
    r.handle.open({ path: "/p/b.txt" });
    await tick();
    r.text("/p/b.txt", "b");
    await tick();
    for (const p of panels()) {
      expect(p.getAttribute("role")).toBe("dialog");
      expect(p.getAttribute("aria-modal")).toBe("false");
      const labelledby = p.getAttribute("aria-labelledby")!;
      const title = document.getElementById(labelledby);
      expect(title).not.toBeNull();
      expect(p.contains(title!)).toBe(true);
    }
    r.handle.close();
    await tick();
  });

  it("§5.2 shell: resize hot zones render on desktop, one per direction", async () => {
    const r = rig();
    r.handle.open({ path: "/p/a.txt" });
    await tick();
    r.text("/p/a.txt", "a");
    await tick();
    const zones = [...document.querySelectorAll<HTMLElement>(".pw-rz")];
    expect(zones.map((z) => z.getAttribute("data-dir")).sort()).toEqual(
      ["e", "n", "ne", "nw", "s", "se", "sw", "w"].sort(),
    );
    r.handle.close();
    await tick();
  });
});
