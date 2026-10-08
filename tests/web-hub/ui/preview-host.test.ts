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

  it("md: switching to another path RESETS the mode to rendered (dir-plan §4.1 B4, :key)", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "text", path: "/p/a.md", text: "# one", truncated: false, size: 6 };
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull(); // default = rendered
    // switch to source
    const buttons = document.querySelectorAll(".preview-toggle-btn");
    (buttons[1] as HTMLElement).click();
    await tick();
    expect(document.querySelector(".preview-md")).toBeNull();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    // same path, new content (retry shape) ⇒ selection KEPT (source)
    view.value = { phase: "text", path: "/p/a.md", text: "# one again", truncated: false, size: 11 };
    await tick();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    // a DIFFERENT path ⇒ remount ⇒ back to rendered
    view.value = { phase: "text", path: "/p/b.md", text: "# two", truncated: false, size: 6 };
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull();
    expect(document.querySelector(".preview-text-body")).toBeNull();
    view.value = { phase: "closed" };
    await tick();
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

// ---------------------------------------------------------------------------
// dir-plan v3.1 §0.2 A3/§5 P3 — dir phase, 返回/上级, subtree provide override
// ---------------------------------------------------------------------------

import { usePreview } from "../../../src/web-hub/ui/src/composables/usePreview.js";
import type { PreviewDirListing } from "../../../src/web-hub/protocol/preview.js";
import type { HubState } from "../../../src/web-hub/ui/src/types.js";
import type { PreviewDirOutcome, PreviewTransport } from "../../../src/web-hub/ui/src/transport/types.js";

/** The REAL composable over a deferred stub transport — the true P3 host ↔ handle pair. */
function rigDir() {
  const agents = new Map<string, unknown>([
    [
      "A",
      {
        key: "A",
        card: { session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" } },
        session: { sessionId: "s1", sessionFile: "/p/s.jsonl", cwd: "/p" },
        down: false,
        prompts: [],
        fleet: [],
        items: [],
        uid: 0,
        lastSeq: -1,
        streaming: null,
        tools: [],
        history: "none",
        hasMore: false,
        needsResync: false,
        sub: null,
      },
    ],
  ]);
  const state = ref({
    clientId: "c1",
    hub: { caps: ["preview.v1", "preview.dir.v1"] },
    conn: "open",
    selected: "A",
    agents,
    order: ["A"],
  } as unknown as HubState);
  const calls: Array<{ req: { path: string; dir?: true }; opts: { signal: AbortSignal; maxPixels: number } }> = [];
  const waits: Array<{ resolve: (o: PreviewDirOutcome) => void }> = [];
  const transport: PreviewTransport = {
    fetch: (req, opts) => {
      calls.push({ req, opts });
      return new Promise<PreviewDirOutcome>((resolve) => waits.push({ resolve }));
    },
  };
  const handle = usePreview({ preview: transport, mode: "token", state, coarse: ref(false) });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PreviewHost, {
    attachTo: host,
    global: { provide: { [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext } },
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
  return { handle, calls, waits, wrapper, text, dir };
}

describe("PreviewHost.vue — dir phase + 返回/上级 (dir-plan A3, P3)", () => {
  it("a dir listing renders PreviewDir; 返回 disabled at the bottom, 上级 enabled mid-tree", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    await tick();
    r.dir("/p/src", [
      { name: "sub", type: "dir", mtimeMs: 1 },
      { name: "a.ts", type: "file", size: 12, mtimeMs: 1 },
      { name: "pipe", type: "other", mtimeMs: 1 },
      { name: ".hiddendir", type: "dir", mtimeMs: 1 },
    ]);
    await tick();
    expect(document.querySelectorAll(".preview-dir-list button.preview-dir-row")).toHaveLength(3);
    expect(document.querySelector(".preview-dir-row.is-inert")).not.toBeNull();
    const navBtns = document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn");
    expect(navBtns).toHaveLength(2); // 返回 + 上级 (dir phase)
    expect(navBtns[0]!.disabled).toBe(true); // 返回: empty history
    expect(navBtns[1]!.disabled).toBe(false); // 上级: /p exists
    expect(document.querySelector(".preview-header-icon use")!.getAttribute("href")).toBe("#i-folder");
    r.handle.close();
    await tick();
  });

  it("row click navigates (dir:true for a dir row); 返回 restores the previous listing with no refetch", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    (document.querySelectorAll(".preview-dir-list button")[0] as HTMLElement).click();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/sub", dir: true });
    expect((document.querySelector(".preview-nav-btn") as HTMLButtonElement).disabled).toBe(false);
    r.dir("/p/src/sub", [{ name: "deep.ts", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    const callsBefore = r.calls.length;
    (document.querySelector(".preview-nav-btn") as HTMLElement).click(); // 返回
    await tick();
    expect(r.calls.length).toBe(callsBefore); // snapshot restore — zero requests
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("sub");
    // focus never falls out of the dialog (§4.6 trap contract survives navigation)
    expect(panel()!.contains(document.activeElement)).toBe(true);
    r.handle.close();
    await tick();
  });

  it("上级 fetches the parent listing with dir:true and greys out at one segment", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", []);
    await tick();
    const up = document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn")[1]!;
    up.click();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "/p", dir: true });
    r.dir("/p", [{ name: "src", type: "dir", mtimeMs: 1 }]);
    await tick();
    expect((document.querySelectorAll(".preview-nav-btn")[1] as HTMLButtonElement).disabled).toBe(true); // / has no parent
    r.handle.close();
    await tick();
  });

  it("a file row navigates without the dir flag (the admission chain decides)", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "a.ts", type: "file", size: 3, mtimeMs: 1 }]);
    await tick();
    (document.querySelectorAll(".preview-dir-list button")[0] as HTMLElement).click();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/a.ts" });
    expect(r.calls[1]!.req.dir).toBeUndefined();
    r.text("/p/src/a.ts", "abc");
    await tick();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    // 返回 still returns to the listing (D3: 下钻 → 打开文件 → 返回)
    (document.querySelector(".preview-nav-btn") as HTMLElement).click();
    await tick();
    expect(document.querySelector(".preview-dir-list")).not.toBeNull();
    r.handle.close();
    await tick();
  });

  it("B6/M2: a path ref inside a rendered md NAVIGATES in-dialog; 返回 returns to the rendered view", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/readme.md" });
    r.text("/p/readme.md", "see `src/deep/x.ts` for details");
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull(); // rendered mode
    const ref = document.querySelector(".preview-md .path-ref") as HTMLElement;
    expect(ref).not.toBeNull(); // relative code candidate — resolved against cwd /p
    ref.click();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/deep/x.ts" }); // navigate, not a fresh visit
    expect(r.calls[1]!.req.dir).toBeUndefined();
    r.text("/p/src/deep/x.ts", "export {}");
    await tick();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    (document.querySelector(".preview-nav-btn") as HTMLElement).click(); // 返回
    await tick();
    // back to the SAME rendered md view — rendered (not source), same content, zero refetch
    expect(document.querySelector(".preview-md")).not.toBeNull();
    expect(r.calls).toHaveLength(2);
    r.handle.close();
    await tick();
  });

  it("Esc still closes (and clears the history) with the P3 handle wired", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    (document.querySelectorAll(".preview-dir-list button")[0] as HTMLElement).click();
    await tick();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    overlay()!.dispatchEvent(ev);
    await tick();
    expect(overlay()).toBeNull();
    expect(r.calls[1]!.opts.signal.aborted).toBe(true); // the in-flight listing fetch was aborted
    r.handle.dispose();
  });

  it("a handle WITHOUT the navigation face degrades to open-only (frozen fakes stay valid)", async () => {
    const open = vi.fn();
    const view = ref<PreviewView>({
      phase: "text",
      path: "/p/a.md",
      text: "see /p/b.ts",
      truncated: false,
      size: 11,
    }) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view,
      scope: ref({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true }) as Ref<never>,
      open,
      close: vi.fn(() => {
        view.value = { phase: "closed" };
      }),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    mountHost({ handle, plaintext: false });
    await tick();
    expect(document.querySelector(".preview-nav")).toBeNull(); // no 返回/上级 at all
    // a (type-illegal for the frozen face, hence the cast) dir phase simply renders nothing
    (view as Ref<PreviewView>).value = {
      phase: "dir",
      path: "/p/src",
      listing: {
        entries: [],
        total: 0,
        scanned: 0,
        complete: true,
        truncated: false,
        limits: { scan: false, entries: false, bytes: false },
        vanished: 0,
        dropped: 0,
      },
    } as unknown as PreviewView;
    await tick();
    expect(document.querySelector(".preview-dir")).toBeNull();
    // an in-dialog ref click falls back to plain open — never a crash
    (view as Ref<PreviewView>).value = {
      phase: "text",
      path: "/p/a.md",
      text: "see /p/b.ts",
      truncated: false,
      size: 11,
    };
    await tick();
    const refEl = document.querySelector(".preview-md .path-ref") as HTMLElement;
    refEl.click();
    await tick();
    expect(open).toHaveBeenCalledWith({ path: "/p/b.ts" });
    view.value = { phase: "closed" };
    await tick();
  });
});
