// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
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
  window.localStorage.removeItem("pwh_hide_plaintext_warn");
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
    window.localStorage.setItem("pwh_hide_plaintext_warn", "0"); // 2026-10-20: hidden by default; opt in to show
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
    // DOM order of focusables (2026-10-20: the copy button moved into the header, before
    // download/close): header copy button → header close button → pre[tabindex=0].
    const first = document.querySelector(".preview-copy button") as HTMLElement;
    const mid = document.querySelector(".preview-close") as HTMLElement;
    const last = document.querySelector(".preview-text-body") as HTMLElement;
    expect(first).not.toBeNull(); // the header copy button IS present for a text phase
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

/** The REAL composable over a deferred stub transport — the true P3 host ↔ handle pair.
 *  `hub` (preview-download tests): an optional HUB_CTX fake riding the same mount. */
function rigDir(hub?: unknown) {
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
    global: {
      provide: {
        [PREVIEW_CTX as symbol]: { handle, plaintext: false } satisfies PreviewContext,
        ...(hub === undefined ? {} : { [HUB_CTX as symbol]: hub }),
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

  it("dir row double-click navigates (dir:true); 返回 restores the previous listing with no refetch", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    // 2026-10 交互调整：目录行单击 = 内联展开（延迟窗），双击 = 钻取。连点两次 = 双击。
    const row = document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement;
    row.click();
    row.click();
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

  it("a file inside an INLINE-expanded subfolder opens <dir>/<sub>/<file> (regression: subfolder segment was dropped ⇒ E_NOT_FOUND)", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    (document.querySelector(".preview-dir-chevron") as HTMLElement).click(); // inline expand
    await tick();
    r.dir("/p/src/sub", [{ name: "note.md", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    const rows = [...document.querySelectorAll<HTMLElement>(".preview-dir-list button.preview-dir-row")];
    const fileRow = rows.find((b) => b.textContent?.includes("note.md"));
    expect(fileRow).toBeDefined();
    fileRow!.click();
    await tick();
    expect(r.calls.at(-1)!.req).toMatchObject({ path: "/p/src/sub/note.md" });
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

  it("up from ~/snap requests bare ~ and stops at home", async () => {
    const r = rigDir();
    r.handle.open({ path: "~/snap", dir: true });
    r.dir("~/snap", []);
    await tick();
    const up = document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn")[1]!;
    expect(up.disabled).toBe(false);
    up.click();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "~", dir: true });
    r.dir("~", []);
    await tick();
    expect(document.querySelector(".preview-path")!.textContent).toBe("~");
    const homeUp = document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn")[1]!;
    expect(homeUp.disabled).toBe(true);
    homeUp.click();
    expect(r.calls).toHaveLength(2);
    r.handle.close();
    await tick();
  });

  it("a file row navigates without the dir flag (the admission chain decides)", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "a.ts", type: "file", size: 3, mtimeMs: 1 }]);
    await tick();
    // `.preview-dir-row` — the NAME button (preview-tree adds a leading chevron button)
    (document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement).click();
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

  it("path bar: submitting navigates (history push), pre-fills with the new listing's path", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    const input = document.querySelector<HTMLInputElement>(".preview-dir-pathbar-input")!;
    expect(input.value).toBe("/p/src"); // pre-filled with the current directory
    input.value = "~/snap/x.png";
    input.dispatchEvent(new Event("input"));
    document.querySelector<HTMLFormElement>(".preview-dir-pathbar")!.requestSubmit();
    await tick();
    expect(r.calls[1]!.req).toMatchObject({ path: "~/snap/x.png" }); // no dir hint forced
    r.dir("~/snap", [{ name: "x.png", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("x.png");
    expect(document.querySelector<HTMLInputElement>(".preview-dir-pathbar-input")!.value).toBe("~/snap/x.png");
    // 返回 restores the original listing with no refetch (same history stack as a row click)
    const callsBefore = r.calls.length;
    (document.querySelector(".preview-nav-btn") as HTMLElement).click();
    await tick();
    expect(r.calls.length).toBe(callsBefore);
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("sub");
    r.handle.close();
    await tick();
  });

  it("path bar: an invalid/denied path surfaces through the existing error view, no special-casing", async () => {
    const r = rigDir();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", []);
    await tick();
    const input = document.querySelector<HTMLInputElement>(".preview-dir-pathbar-input")!;
    input.value = "/etc/shadow";
    input.dispatchEvent(new Event("input"));
    document.querySelector<HTMLFormElement>(".preview-dir-pathbar")!.requestSubmit();
    await tick();
    const w = r.waits.shift();
    w?.resolve({ ok: false, status: 403, error: "E_PREVIEW_DENIED", reason: "denylist" });
    await tick();
    expect(document.querySelector(".preview-note-title")).not.toBeNull();
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
    // 2026-10 交互调整：目录行双击 = 钻取（单击只是内联展开）。
    const row = document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement;
    row.click();
    row.click();
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

describe("PreviewHost.vue — directory browsing keeps the panel height stable", () => {
  it("holds the tall panel after a dir listing (through loading / shorter listings) and resets on close", async () => {
    const listing = (n: number) => ({
      entries: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: "file" })),
      total: n,
      scanned: n,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    });
    const view = ref<PreviewView>({ phase: "loading", path: "/p" } as unknown as PreviewView) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view,
      scope: ref({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true }) as Ref<never>,
      open: vi.fn(),
      close: vi.fn(() => {
        view.value = { phase: "closed" };
      }),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    mountHost({ handle, plaintext: false });
    await tick();
    const panel = () => document.querySelector(".preview-panel") as HTMLElement | null;
    expect(panel()!.classList.contains("is-hold-tall")).toBe(false); // nothing browsed yet
    view.value = { phase: "dir", path: "/p", listing: listing(80) } as unknown as PreviewView;
    await tick();
    expect(panel()!.classList.contains("is-hold-tall")).toBe(true);
    view.value = { phase: "loading", path: "/p/a" } as unknown as PreviewView;
    await tick();
    expect(panel()!.classList.contains("is-hold-tall")).toBe(true); // still tall while loading
    view.value = { phase: "dir", path: "/p/a", listing: listing(2) } as unknown as PreviewView;
    await tick();
    expect(panel()!.classList.contains("is-hold-tall")).toBe(true); // short listing: no shrink
    view.value = { phase: "closed" };
    await tick();
    view.value = { phase: "loading", path: "/p/x.ts" } as unknown as PreviewView;
    await tick();
    expect(panel()!.classList.contains("is-hold-tall")).toBe(false); // a fresh open starts compact
    view.value = { phase: "closed" };
    await tick();
  });
});

describe("PreviewHost.vue — header 复制 button (2026-10-20: copy moved next to download)", () => {
  it("text phase: header order is copy → download → close; the copy value is exactly the shown text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { handle, view } = makeHandle();
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 4, truncated: false, text: "body" }));
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/a.txt", text: "shown part only", truncated: true, size: 262144 };
    await tick();

    // CopyButton's root is a <span> — assert the order over the header's direct children
    // (icon / title / path / copy span / download button / close button).
    const kids = Array.from(document.querySelector(".preview-header")!.children).map((el) => el.className);
    const idx = (cls: string) => kids.findIndex((c) => c.includes(cls));
    expect(idx("preview-copy")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-download")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-close")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-copy")).toBeLessThan(idx("preview-download"));
    expect(idx("preview-download")).toBeLessThan(idx("preview-close"));

    // the header button carries tooltip + aria-label and the CopyButton feedback markup
    const copyBtn = document.querySelector<HTMLButtonElement>(".preview-copy button")!;
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy");
    expect(copyBtn.getAttribute("title")).toBe("Copy");
    copyBtn.click();
    await tick();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("shown part only"); // exactly the DISPLAYED text
    view.value = { phase: "closed" };
    await tick();
  });

  it("copy value keeps the chunked/ANSI semantics: ANSI-stripped, truncated prepared source (same as before the move)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = {
      phase: "text",
      path: "/p/x.log",
      text: "\u001b[36m==>\u001b[0m hi\n",
      truncated: false,
      size: 12,
    };
    await tick();
    (document.querySelector(".preview-copy button") as HTMLElement).click();
    await tick();
    expect(writeText).toHaveBeenCalledWith("==> hi\n"); // ANSI-stripped, trailing newline kept
    view.value = { phase: "closed" };
    await tick();
  });

  it("markdown rendered mode: the header copy still copies the SOURCE text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "text", path: "/p/README.md", text: "# Hi\n\nbody", truncated: false, size: 10 };
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull(); // rendered mode
    (document.querySelector(".preview-copy button") as HTMLElement).click();
    await tick();
    expect(writeText).toHaveBeenCalledWith("# Hi\n\nbody");
    view.value = { phase: "closed" };
    await tick();
  });

  it("image / loading phases have no copy value ⇒ no header copy button; a text → image switch drops it", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "text", path: "/p/a.txt", text: "body", truncated: false, size: 4 };
    await tick();
    expect(document.querySelector(".preview-copy")).not.toBeNull();
    view.value = {
      phase: "image",
      path: "/p/a.png",
      dataUrl: "data:image/png;base64,AAAA",
      mime: "image/png",
      dims: { w: 4, h: 2 },
      size: 2048,
    };
    await tick();
    expect(document.querySelector(".preview-copy")).toBeNull();
    view.value = { phase: "loading", path: "/p/b.ts" };
    await tick();
    expect(document.querySelector(".preview-copy")).toBeNull();
    view.value = { phase: "closed" };
    await tick();
  });
});

// --- shared helpers for the two download suites (preview-download) ---
/** HUB_CTX fake: one online selected agent + a scripted preview.fetch (+
 *  preview.download when `opts.download` is given; `opts.caps` overrides the hub caps). */
function hubWithFetch(
  fetch: (req: { agentKey: string; sessionId: string; path: string }) => Promise<unknown>,
  opts: {
    download?: (req: { agentKey: string; sessionId: string; path: string }) => Promise<unknown>;
    caps?: string[];
  } = {},
) {
  const calls: Array<{ agentKey: string; sessionId: string; path: string }> = [];
  const downloadCalls: Array<{ agentKey: string; sessionId: string; path: string }> = [];
  const hub = {
    state: ref({
      selected: "A",
      agents: new Map([["A", { down: false, session: { sessionId: "s1", cwd: "/p" } }]]),
      hub: { caps: opts.caps ?? ["preview.v1"] },
    }),
    preview: {
      fetch: (req: { agentKey: string; sessionId: string; path: string }) => {
        calls.push(req);
        return fetch(req);
      },
      ...(opts.download === undefined
        ? {}
        : {
            download: (req: { agentKey: string; sessionId: string; path: string }) => {
              downloadCalls.push(req);
              return opts.download!(req);
            },
          }),
    },
    dispatch: () => {},
  };
  return { hub, calls, downloadCalls };
}

function mountWithHub(ctx: PreviewContext, hub: unknown): ReturnType<typeof mount> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return mount(PreviewHost, {
    attachTo: host,
    global: {
      provide: { [PREVIEW_CTX as symbol]: ctx, [HUB_CTX as symbol]: hub },
    },
  });
}

/** Stub the objectURL pair + anchor click; returns the captured save intents. */
function stubSave() {
  const saved: Array<{ href: string; download: string }> = [];
  const blobs: Blob[] = [];
  const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob) => `blob:fake-${blobs.push(b)}`);
  const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
  return { saved, blobs, createSpy, revokeSpy, clickSpy };
}

describe("PreviewHost.vue — 下载 (preview-download)", () => {
  it("text phase: the button re-fetches through the same endpoint and saves basename + text/plain blob", async () => {
    const { handle, view } = makeHandle();
    const { hub, calls } = hubWithFetch(async () => ({
      ok: true,
      kind: "text",
      size: 4,
      truncated: false,
      text: "body",
    }));
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/src/a.ts", size: 4, truncated: false, text: "body" };
    await tick();

    const s = stubSave();
    const btn = document.querySelector<HTMLButtonElement>(".preview-download")!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Download");
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(calls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/p/src/a.ts" }]);
    expect(s.saved[0]).toEqual({ href: "blob:fake-1", download: "a.ts" });
    expect(s.blobs[0]!.type).toBe("text/plain;charset=utf-8");
    expect(await s.blobs[0]!.text()).toBe("body");
    await vi.waitFor(() => expect(s.revokeSpy).toHaveBeenCalledWith("blob:fake-1")); // 用后 revoke
    expect(document.querySelector(".preview-download-error")).toBeNull();
  });

  it("image phase: the response Blob (with the header mime) is saved verbatim", async () => {
    const { handle, view } = makeHandle();
    const blob = new Blob(["PNG"], { type: "image/png" });
    const { hub } = hubWithFetch(async () => ({
      ok: true,
      kind: "image",
      mime: "image/png",
      size: 3,
      dims: { w: 1, h: 1 },
      blob,
    }));
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = {
      phase: "image",
      path: "/p/shot.png",
      dataUrl: "data:image/png;base64,AAA",
      mime: "image/png",
      dims: { w: 1, h: 1 },
      size: 3,
    };
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(s.blobs[0]).toBe(blob);
    expect(s.saved[0]!.download).toBe("shot.png");
  });

  it('a lossy basename (U+FFFD) degrades to "download"', async () => {
    const { handle, view } = makeHandle();
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }));
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/bad\uFFFD", size: 1, truncated: false, text: "x" };
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(s.saved[0]!.download).toBe("download");
  });

  it("dir phase never shows the button; failure shows the error line and a retry re-fetches", async () => {
    // dir phase (via the real usePreview rig — the nav face renders the listing); a hub with
    // a working preview transport is provided, so the button's absence is the phase's doing.
    const { hub: dirHub } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }));
    const r = rigDir(dirHub);
    r.handle.open({ path: "/p/src", dir: true });
    await tick();
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    expect(document.querySelector(".preview-download")).toBeNull();
    r.handle.close();
    await tick();

    // failure ⇒ classified error line; a second click re-fetches
    const { handle, view } = makeHandle();
    let n = 0;
    const { hub, calls } = hubWithFetch(async () => {
      n += 1;
      return n === 1
        ? { ok: false, error: "E_NETWORK", status: 0 }
        : { ok: true, kind: "text", size: 1, truncated: false, text: "x" };
    });
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/a.ts", size: 1, truncated: false, text: "x" };
    await tick();
    const btn = document.querySelector<HTMLButtonElement>(".preview-download")!;
    btn.click();
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).not.toBeNull());
    expect(document.querySelector(".preview-download-error")!.textContent).toContain("Download failed");
    const s = stubSave();
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(calls).toHaveLength(2);
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).toBeNull());
  });
});

describe("PreviewHost.vue — 不可预览类型的下载 (preview-download, download=1)", () => {
  const DL_CAPS = ["preview.v1", "preview.download.v1"];

  it("unsupported phase WITH the cap: 「不支持预览 — 可下载」 + a download button that saves via download=1", async () => {
    const { handle, view } = makeHandle();
    const blob = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: "application/octet-stream" });
    const { hub, downloadCalls } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }), {
      caps: DL_CAPS,
      download: async () => ({ ok: true, kind: "download", blob, size: 4 }),
    });
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 4 };
    await tick();

    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("cannot be previewed");
    expect(note.textContent).toContain("download it instead");
    const btn = document.querySelector<HTMLButtonElement>(".preview-download-unsupported")!;
    expect(btn).not.toBeNull();

    const s = stubSave();
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    // the download=1 transport path was used (never the preview fetch), path verbatim
    expect(downloadCalls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/p/bundle.zip" }]);
    expect(s.saved[0]!.download).toBe("bundle.zip");
    expect(s.blobs[0]).toBe(blob);
    expect(document.querySelector(".preview-download-error")).toBeNull();
  });

  it("unsupported phase WITHOUT preview.download.v1 (old hub): the pure error state stays — no button, reason text", async () => {
    const { handle, view } = makeHandle();
    const { hub } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }), {
      caps: ["preview.v1"], // no download cap
      download: async () => ({ ok: true, kind: "download", blob: new Blob([]), size: 0 }),
    });
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 4 };
    await tick();
    expect(document.querySelector(".preview-download-unsupported")).toBeNull();
    expect(document.querySelector(".preview-note")!.textContent).toContain("binary file");
  });

  it("download=1 failure shows the error line; the button stays for a retry", async () => {
    const { handle, view } = makeHandle();
    let n = 0;
    const { hub, downloadCalls } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }), {
      caps: DL_CAPS,
      download: async () => {
        n += 1;
        return n === 1
          ? { ok: false, error: "E_DEADLINE", status: 0 }
          : { ok: true, kind: "download", blob: new Blob(["z"]), size: 1 };
      },
    });
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 1 };
    await tick();
    const btn = document.querySelector<HTMLButtonElement>(".preview-download-unsupported")!;
    btn.click();
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).not.toBeNull());
    const s = stubSave();
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(downloadCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------
// chunked-plan §4.7/§4.8/D11 (P2b)
// ---------------------------------------------------------------------------------------
describe("PreviewHost.vue — chunked preview (P2b)", () => {
  it("truncated note regression: shows the DISPLAYED bytes, not the file size (2.3 MiB file, 256 KiB shown)", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = {
      phase: "text",
      path: "/p/big.log",
      size: Math.round(2.3 * 1024 * 1024),
      bytes: 256 * 1024,
      truncated: true,
      text: "x",
    };
    await tick();
    const note = document.querySelector(".preview-truncated")!.textContent!;
    expect(note).toContain("first 256 KiB of 2.3 MiB");
    expect(note).not.toContain("first 2.3 MiB");
  });

  it("falls back to the UTF-8 length of the text when the view carries no bytes", async () => {
    const { handle, view } = makeHandle();
    mountHost({ handle, plaintext: false });
    view.value = { phase: "text", path: "/p/a.log", size: 4096, truncated: true, text: "héllo" }; // 6 bytes
    await tick();
    expect(document.querySelector(".preview-truncated")!.textContent).toContain("first 6 B of 4.0 KiB");
  });

  it("text download with the preview.download.v1 cap saves the COMPLETE file via download=1 (D11)", async () => {
    const { handle, view } = makeHandle();
    const full = new Blob(["whole file"], { type: "application/octet-stream" });
    const { hub, calls, downloadCalls } = hubWithFetch(
      async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }),
      {
        caps: ["preview.v1", "preview.download.v1"],
        download: async () => ({ ok: true, blob: full }),
      },
    );
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/big.log", size: 9_000_000, truncated: true, text: "part" };
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(downloadCalls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/p/big.log" }]);
    expect(calls).toEqual([]); // no truncated re-fetch
    expect(s.blobs[0]).toBe(full);
    expect(s.saved[0]!.download).toBe("big.log");
  });

  it("without the download cap the text download keeps the legacy fetch path", async () => {
    const { handle, view } = makeHandle();
    const { hub, calls, downloadCalls } = hubWithFetch(
      async () => ({ ok: true, kind: "text", size: 4, truncated: false, text: "body" }),
      { download: async () => ({ ok: true, blob: new Blob(["x"]) }) }, // method present, cap absent
    );
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/a.ts", size: 4, truncated: false, text: "body" };
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(downloadCalls).toEqual([]);
  });

  it("a failed full download surfaces the download error line", async () => {
    const { handle, view } = makeHandle();
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }), {
      caps: ["preview.v1", "preview.download.v1"],
      download: async () => ({ ok: false, status: 500, error: "E_X" }),
    });
    mountWithHub({ handle, plaintext: false }, hub);
    view.value = { phase: "text", path: "/p/a.log", size: 9, truncated: true, text: "x" };
    await tick();
    stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).not.toBeNull());
  });

  it("stream wiring: load-more / reopen / retry-stream reach the handle's navigation face", async () => {
    const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
    const loadMore = vi.fn();
    const reopen = vi.fn();
    const handle = {
      view,
      scope: ref(null),
      open: vi.fn(),
      close: vi.fn(),
      retry: vi.fn(),
      dispose: vi.fn(),
      navigate: vi.fn(),
      back: vi.fn(),
      up: vi.fn(),
      loadMore,
      reopen,
      stackDepth: ref(0),
    } as unknown as PreviewHandle;
    mountHost({ handle, plaintext: false });
    const stream = {
      ident: "i1.AAAAAAAAAAAAAAAAAAAAAA",
      total: 900_000,
      cap: 8 * 1024 * 1024,
      firstBytes: 256 * 1024,
      chunks: ["a\nb\n"],
      loaded: 256 * 1024,
      state: "changed",
      autoRetries: 0,
    };
    view.value = {
      phase: "text",
      path: "/p/x.log",
      size: 900_000,
      truncated: true,
      text: "a\nb\n",
      stream,
    } as PreviewView;
    await tick();
    expect(document.querySelector(".preview-stream")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".preview-stream-btn")!.click(); // 重新打开
    expect(reopen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// web-hub-html-preview plan v2 §5 (P2): the html text phase holds the panel tall — the
// rendered iframe is clamp(320px,72vh,1400px), so toggling rendered⇄source (or the mint
// spinner between them) must not move the header buttons (the dir-phase `is-hold-tall`
// mechanism). Gated on scope.html AND the transport's htmlCap: an absent cap keeps a
// `.html` preview byte-identical (no class flip).
// ---------------------------------------------------------------------------
describe("PreviewHost.vue — html text phase holds the panel height (web-hub-html-preview §5)", () => {
  const TEXT_VIEW = { phase: "text", path: "/p/index.html", text: "<p>x</p>", truncated: false, size: 8 };

  function rigHtml(html: boolean, htmlCap: boolean) {
    const view = ref(TEXT_VIEW as unknown as PreviewView) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view,
      scope: ref(
        html
          ? ({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true, html: true } as never)
          : ({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true } as never),
      ) as Ref<never>,
      open: vi.fn(),
      close: vi.fn(),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    const hub = {
      state: ref({ selected: "A", agents: new Map(), hub: { caps: ["preview.v1"] } }),
      preview: {
        fetch: () => Promise.resolve({ ok: true, kind: "text", text: "x", truncated: false, size: 1 }),
        ...(htmlCap
          ? {
              htmlCap: () =>
                Promise.resolve({
                  ok: true,
                  url: "/pv/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
                  openUrl: "/pvw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  idleMs: 900_000,
                  hardRemainingMs: 3_600_000,
                }),
            }
          : {}),
      },
      dispatch: () => {},
    };
    mountWithHub({ handle, plaintext: false }, hub);
    return view;
  }

  it("cap present ⇒ is-hold-tall from the very first html text phase", async () => {
    rigHtml(true, true);
    await tick();
    const panel = document.querySelector(".preview-panel") as HTMLElement | null;
    expect(panel!.classList.contains("is-hold-tall")).toBe(true);
  });

  it("cap absent (no scope.html or no transport htmlCap) ⇒ no class flip (pre-feature DOM)", async () => {
    rigHtml(false, true);
    await tick();
    let panel = document.querySelector(".preview-panel") as HTMLElement | null;
    expect(panel!.classList.contains("is-hold-tall")).toBe(false);
    document.body.innerHTML = "";
    rigHtml(true, false);
    await tick();
    panel = document.querySelector(".preview-panel") as HTMLElement | null;
    expect(panel!.classList.contains("is-hold-tall")).toBe(false);
  });

  it("a non-html text phase never triggers the hold, cap or not", async () => {
    const view = rigHtml(true, true);
    // holdTall only ever SETS (the dir rule); a fresh open is what resets it.
    view.value = { phase: "closed" } as PreviewView;
    await tick();
    view.value = { phase: "text", path: "/p/x.log", text: "y", truncated: false, size: 1 } as PreviewView;
    await tick();
    const panel = document.querySelector(".preview-panel") as HTMLElement | null;
    expect(panel!.classList.contains("is-hold-tall")).toBe(false);
  });
});
