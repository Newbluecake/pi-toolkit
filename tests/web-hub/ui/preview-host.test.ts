// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "../../../src/web-hub/ui/src/components/preview/PreviewHost.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";
import { usePreviewWindows } from "../../../src/web-hub/ui/src/composables/usePreviewWindows.js";
import type { PreviewHandle, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type { HubState } from "../../../src/web-hub/ui/src/types.js";
import type {
  PreviewDirListing,
  PreviewDirOutcome,
  PreviewTransport,
} from "../../../src/web-hub/ui/src/transport/types.js";
import {
  fakeWindowHandle,
  fakeWindowsFace,
  type FakeWindow,
  type FakeWindowsFace,
} from "./helpers/preview-windows-fake.js";

/**
 * `PreviewHost.vue` — preview-windows plan r2 §10.2 (W2): the MIGRATED host suite.
 *
 * Which describe drives what (评审 #14 — the legacy single-window face is gone):
 * - "phases / copy / download / chunked / html" → the helpers/preview-windows-fake.ts DOUBLE
 *   (they cover the production PreviewWindow component's rendering, through the new host);
 * - "close paths / focus (desktop)" → the fake face, new §5.4/§5.5 semantics (modeless: no
 *   scrim, no scroll lock, no Tab trap; Esc closes exactly the focused window);
 * - "dir + in-window routing" → the REAL `usePreviewWindows` manager over a stub transport
 *   (the production path): file rows and unprobed md refs open NEW windows, dir rows and
 *   dir-hinted refs navigate IN PLACE.
 * The phone band (scroll lock, top-window trap, inert, cross-breakpoint) lives in
 * preview-windows-phone.test.ts; the full desktop window algebra in preview-windows.test.ts.
 */

function mountHost(ctx: PreviewContext | null, hub?: unknown): ReturnType<typeof mount> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return mount(PreviewHost, {
    attachTo: host,
    global: {
      provide: {
        ...(ctx === null ? {} : { [PREVIEW_CTX as symbol]: ctx }),
        ...(hub === undefined ? {} : { [HUB_CTX as symbol]: hub }),
      },
    },
  });
}

const overlay = (): HTMLElement | null => document.querySelector(".preview-overlay");
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-panel")];
const windowsEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".preview-window")];

const tick = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

afterEach(() => {
  resetBodyScrollLock();
  window.localStorage.removeItem("pwh_hide_plaintext_warn");
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  document.body.classList.remove("pwh-pw-dragging");
});

// ---------------------------------------------------------------------------
// shell gating
// ---------------------------------------------------------------------------
describe("PreviewHost.vue — absent ctx / non-windows face / zero windows", () => {
  it("renders nothing without PREVIEW_CTX", () => {
    mountHost(null);
    expect(overlay()).toBeNull();
  });

  it("renders NOTHING for a handle without the windows face (frozen fakes, 评审 #14)", () => {
    const view = ref<PreviewView>({ phase: "loading", path: "/p/a.ts" }) as Ref<PreviewView>;
    const handle: PreviewHandle = {
      view,
      scope: ref(null),
      open: vi.fn(),
      close: vi.fn(),
      retry: vi.fn(),
      dispose: vi.fn(),
    };
    mountHost({ handle, plaintext: false });
    expect(overlay()).toBeNull();
  });

  it("renders nothing with a windows face holding zero windows", () => {
    const face = fakeWindowsFace();
    mountHost({ handle: face, plaintext: false });
    expect(overlay()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// phases — the fake face driving the production PreviewWindow
// ---------------------------------------------------------------------------
function rigPhase(initial: PreviewView, hub?: unknown): { fake: FakeWindowsFace; win: FakeWindow } {
  const win = fakeWindowHandle(1, initial);
  const face = fakeWindowsFace([win]);
  mountHost({ handle: face, plaintext: false }, hub);
  return { fake: face, win };
}

describe("PreviewWindow.vue — phases (fake face)", () => {
  it("loading: dialog semantics (desktop aria-modal=false), basename + full path, status text", async () => {
    rigPhase({ phase: "loading", path: "/p/src/a.ts" });
    await tick();
    const p = panels()[0]!;
    expect(p).not.toBeUndefined();
    expect(p.getAttribute("role")).toBe("dialog");
    expect(p.getAttribute("aria-modal")).toBe("false"); // desktop: NON-modal (§5.3)
    expect(p.getAttribute("aria-labelledby")).toBe("pw-title-1");
    expect(p.getAttribute("aria-label")).toBeNull(); // §5.3: labelledby ONLY — no competing label
    const title = document.getElementById("pw-title-1")!;
    expect(title.textContent).toContain("a.ts"); // the basename stays the visible title
    expect(title.querySelector(".sr-only")).not.toBeNull(); // sr-only 「文件预览：」prefix (§5.3)
    expect(p.getAttribute("aria-describedby")).toBe("pw-hint-1");
    expect(document.querySelector(".preview-path")!.textContent).toBe("/p/src/a.ts");
    expect(document.querySelector(".preview-loading")!.getAttribute("role")).toBe("status");
  });

  it("image: renders PreviewImage with the data URL and dims", async () => {
    rigPhase({
      phase: "image",
      path: "/p/a.png",
      dataUrl: "data:image/png;base64,AAAA",
      mime: "image/png",
      dims: { w: 4, h: 2 },
      size: 2048,
    });
    await tick();
    expect(document.querySelector(".preview-image img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(document.querySelector(".preview-meta")!.textContent).toContain("4 × 2");
    expect(document.querySelector(".preview-meta")!.textContent).toContain("2.0 KiB");
  });

  it("text: renders PreviewText; truncated badge shows when truncated", async () => {
    rigPhase({ phase: "text", path: "/p/a.txt", text: "hello\nworld", truncated: true, size: 262144 });
    await tick();
    expect(document.querySelector(".preview-text-body")!.textContent).toBe("hello\nworld");
    expect(document.querySelector(".preview-truncated")).not.toBeNull();
  });

  it("md: switching to another path RESETS the mode to rendered (dir-plan §4.1 B4, :key)", async () => {
    const { win } = rigPhase({ phase: "text", path: "/p/a.md", text: "# one", truncated: false, size: 6 });
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull(); // default = rendered
    const buttons = document.querySelectorAll(".preview-toggle-btn");
    (buttons[1] as HTMLElement).click();
    await tick();
    expect(document.querySelector(".preview-md")).toBeNull();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    // same path, new content (retry shape) ⇒ selection KEPT (source)
    win.view.value = { phase: "text", path: "/p/a.md", text: "# one again", truncated: false, size: 11 };
    await tick();
    expect(document.querySelector(".preview-text-body")).not.toBeNull();
    // a DIFFERENT path ⇒ remount ⇒ back to rendered
    win.view.value = { phase: "text", path: "/p/b.md", text: "# two", truncated: false, size: 6 };
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull();
    expect(document.querySelector(".preview-text-body")).toBeNull();
  });

  it("unsupported: reason copy + file size", async () => {
    rigPhase({ phase: "unsupported", path: "/p/a.bin", reason: "binary", size: 512 });
    await tick();
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("No preview available");
    expect(note.textContent).toContain("binary file");
    expect(note.textContent).toContain("512 B");
  });

  it("tooLarge: dims message + copy-path row", async () => {
    rigPhase({ phase: "tooLarge", path: "/p/big.png", reason: "pixels", size: 100, dims: { w: 8000, h: 6000 } });
    await tick();
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("Too large to preview");
    expect(note.textContent).toContain("8000 × 6000");
    expect(note.querySelector(".preview-copy-path code")!.textContent).toBe("/p/big.png");
  });

  it("error: retry button only when retryable; retry() fires; retryAfter hint renders", async () => {
    const { win } = rigPhase({ phase: "error", path: "/p/a.ts", error: "E_RATE", retryable: true, retryAfterS: 3 });
    await tick();
    expect(document.querySelector(".preview-note")!.textContent).toContain("E_RATE");
    expect(document.querySelector(".preview-note")!.textContent).toContain("3s");
    await (document.querySelector(".preview-retry") as HTMLElement).click();
    expect(win.retrySpy).toHaveBeenCalledTimes(1);
    win.view.value = { phase: "error", path: "/p/a.ts", error: "E_AUTH", retryable: false };
    await tick();
    expect(document.querySelector(".preview-retry")).toBeNull();
  });

  it("plaintext ctx: the §5.2 standing warning renders; hidden otherwise", async () => {
    window.localStorage.setItem("pwh_hide_plaintext_warn", "0"); // opt in to show
    const win = fakeWindowHandle(1, { phase: "closed" });
    const face = fakeWindowsFace([win]);
    mountHost({ handle: face, plaintext: true });
    win.view.value = { phase: "loading", path: "/p/a.ts" };
    await tick();
    expect(document.querySelector(".preview-plaintext")).not.toBeNull();
  });

  it("directory browsing keeps the panel height stable (holdTall through loading/shorter)", async () => {
    const listing = (n: number) => ({
      entries: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: "file" as const })),
      total: n,
      scanned: n,
      complete: true,
      truncated: false,
      limits: { scan: false, entries: false, bytes: false },
      vanished: 0,
      dropped: 0,
    });
    const { win } = rigPhase({ phase: "loading", path: "/p" });
    await tick();
    const panel = () => panels()[0]!;
    expect(panel().classList.contains("is-hold-tall")).toBe(false);
    win.view.value = { phase: "dir", path: "/p", listing: listing(80) };
    await tick();
    expect(panel().classList.contains("is-hold-tall")).toBe(true);
    win.view.value = { phase: "loading", path: "/p/a" };
    await tick();
    expect(panel().classList.contains("is-hold-tall")).toBe(true);
    win.view.value = { phase: "dir", path: "/p/a", listing: listing(2) };
    await tick();
    expect(panel().classList.contains("is-hold-tall")).toBe(true);
  });

  it("stream wiring: load-more / reopen / retry-stream reach the handle's navigation face", async () => {
    const { win } = rigPhase({ phase: "closed" });
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
    win.view.value = { phase: "text", path: "/p/x.log", size: 900_000, truncated: true, text: "a\nb\n", stream };
    await tick();
    // preview-perf P3: a line-numbered stream is ALWAYS virtual — the body is the virtual
    // `<pre>` (the legacy `.preview-stream` container survives under `virtualEnabled: false`,
    // pinned in preview-text/preview-line-numbers). The sentinel + action buttons are
    // renderer-independent.
    expect(document.querySelector("pre.pv-virtual")).not.toBeNull();
    expect(document.querySelector(".preview-stream-sentinel")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".preview-stream-btn")!.click(); // 重新打开
    expect(win.handle.reopen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// close paths + focus (desktop §5.4/§5.5) — modeless, no scrim/lock/trap
// ---------------------------------------------------------------------------
describe("PreviewHost.vue — close paths (desktop, §5.5)", () => {
  it("Esc inside a window closes THAT window with preventDefault + stopPropagation", async () => {
    const a = fakeWindowHandle(1, { phase: "text", path: "/p/a.txt", text: "x", truncated: false, size: 1 });
    const b = fakeWindowHandle(2, { phase: "text", path: "/p/b.txt", text: "y", truncated: false, size: 1 });
    const face = fakeWindowsFace([a, b]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    expect(panels()).toHaveLength(2);
    const winListener = vi.fn();
    window.addEventListener("keydown", winListener);
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    panels()[1]!.dispatchEvent(ev); // focus context: window 2's panel
    expect(face.closeWindowSpy).toHaveBeenCalledWith(2);
    expect(face.closeWindowSpy).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(winListener).not.toHaveBeenCalled(); // DashboardView's window-level Esc never fires
    window.removeEventListener("keydown", winListener);
  });

  it("Esc with the event target OUTSIDE every window closes nothing", async () => {
    const a = fakeWindowHandle(1, { phase: "text", path: "/p/a.txt", text: "x", truncated: false, size: 1 });
    const face = fakeWindowsFace([a]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    const pageBtn = document.createElement("button");
    document.body.appendChild(pageBtn);
    pageBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(face.closeWindowSpy).not.toHaveBeenCalled();
    expect(panels()).toHaveLength(1);
  });

  it("the header close button closes its own window; no scrim — a root background click closes nothing", async () => {
    const a = fakeWindowHandle(1, { phase: "loading", path: "/p/a.ts" });
    const b = fakeWindowHandle(2, { phase: "loading", path: "/p/b.ts" });
    const face = fakeWindowsFace([a, b]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); // the modeless root (no scrim semantics)
    expect(face.closeAllSpy).not.toHaveBeenCalled();
    const closes = [...document.querySelectorAll<HTMLElement>(".preview-close")];
    (closes[1] as HTMLElement).click();
    expect(face.closeWindowSpy).toHaveBeenCalledWith(2);
  });

  it("desktop modeless: no body scroll lock; the root does not intercept pointer events", async () => {
    const a = fakeWindowHandle(1, { phase: "loading", path: "/p/a.ts" });
    const face = fakeWindowsFace([a]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    expect(document.body.style.overflow).toBe(""); // §5: no scroll lock on desktop
    expect(overlay()!.classList.contains("is-modeless")).toBe(true);
    expect(windowsEls()[0]!.getAttribute("aria-modal")).toBeNull(); // sections carry no aria; the panel does
  });
});

describe("PreviewHost.vue — focus (desktop, §5.4)", () => {
  it("focusRequest lands on the target window's panel (new window open)", async () => {
    const a = fakeWindowHandle(1, { phase: "text", path: "/p/a.txt", text: "x", truncated: false, size: 1 });
    const face = fakeWindowsFace([a]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    expect(document.activeElement).not.toBe(panels()[0]); // nothing armed yet — no steal
    face.focusRequestRef.value = { id: 1, seq: 1 }; // what the manager emits at open
    await tick();
    expect(document.activeElement).toBe(panels()[0]);
  });

  it("closing the focused window moves focus to the new active window; the LAST close returns pageFocus", async () => {
    const prior = document.createElement("button");
    document.body.appendChild(prior);
    const a = fakeWindowHandle(1, { phase: "text", path: "/p/a.txt", text: "x", truncated: false, size: 1 });
    const b = fakeWindowHandle(2, { phase: "text", path: "/p/b.txt", text: "y", truncated: false, size: 1 });
    const face = fakeWindowsFace([a, b]);
    mountHost({ handle: face, plaintext: false });
    await tick();
    prior.focus(); // any OUTSIDE focusin refreshes pageFocus (r2 复审处置)
    await tick();
    const closes = [...document.querySelectorAll<HTMLElement>(".preview-close")];
    closes[1]!.focus(); // focus INSIDE window 2 (focusin → focusedWin=2)
    await tick();
    closes[1]!.click(); // close window 2
    await tick();
    expect(face.windowsRef.value).toHaveLength(1);
    expect(document.activeElement).toBe(panels()[0]); // landed on the new active window
    const last = document.querySelector<HTMLElement>(".preview-close")!;
    last.focus();
    await tick();
    last.click(); // the last one
    await tick();
    expect(document.activeElement).toBe(prior); // pageFocus return
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
// dir + in-window routing — the REAL usePreviewWindows manager (production path)
// ---------------------------------------------------------------------------
function rigWindows(hub?: unknown) {
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
  const handle = usePreviewWindows({ preview: transport, mode: "token", state, coarse: ref(false) });
  const wrapper = mountHost({ handle, plaintext: false }, hub);
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

describe("PreviewHost × usePreviewWindows — dir phase + routing (production)", () => {
  it("a dir listing renders in window 1; 返回 disabled at the bottom, 上级 enabled mid-tree", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    await tick();
    r.dir("/p/src", [
      { name: "sub", type: "dir", mtimeMs: 1 },
      { name: "a.ts", type: "file", size: 12, mtimeMs: 1 },
      { name: "pipe", type: "other", mtimeMs: 1 },
      { name: ".hiddendir", type: "dir", mtimeMs: 1 },
    ]);
    await tick();
    expect(panels()).toHaveLength(1);
    expect(document.querySelectorAll(".preview-dir-list button.preview-dir-row")).toHaveLength(3);
    expect(document.querySelector(".preview-dir-row.is-inert")).not.toBeNull();
    const navBtns = document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn");
    expect(navBtns).toHaveLength(2);
    expect(navBtns[0]!.disabled).toBe(true);
    expect(navBtns[1]!.disabled).toBe(false);
    expect(document.querySelector(".preview-header-icon use")!.getAttribute("href")).toBe("#i-folder");
    r.handle.close();
    await tick();
  });

  it("dir row double-click navigates IN PLACE (dir:true); 返回 restores with no refetch", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    const row = document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement;
    row.click();
    row.click(); // double-click = drill down (2026-10 interaction)
    await tick();
    expect(panels()).toHaveLength(1); // IN PLACE — no second window
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/sub", dir: true });
    expect((document.querySelector(".preview-nav-btn") as HTMLButtonElement).disabled).toBe(false);
    r.dir("/p/src/sub", [{ name: "deep.ts", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    const callsBefore = r.calls.length;
    (document.querySelector(".preview-nav-btn") as HTMLElement).click(); // 返回
    await tick();
    expect(r.calls.length).toBe(callsBefore); // snapshot restore — zero requests
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("sub");
    r.handle.close();
    await tick();
  });

  it("a FILE row click opens a NEW window with the joined path (用户拍板 2)", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "a.ts", type: "file", size: 3, mtimeMs: 1 }]);
    await tick();
    (document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement).click();
    await tick();
    expect(panels()).toHaveLength(2); // a NEW window, not an in-place navigation
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/a.ts" });
    expect(r.calls[1]!.req.dir).toBeUndefined();
    r.text("/p/src/a.ts", "abc");
    await tick();
    expect(panels()[1]!.textContent).toContain("abc");
    r.handle.close();
    await tick();
  });

  it("a file inside an INLINE-expanded subfolder opens <dir>/<sub>/<file> as a new window", async () => {
    const r = rigWindows();
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
    expect(panels()).toHaveLength(2);
    expect(r.calls.at(-1)!.req).toMatchObject({ path: "/p/src/sub/note.md" });
    r.handle.close();
    await tick();
  });

  it("上级 fetches the parent listing in place and greys out at one segment; up from ~/snap stops at ~", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", []);
    await tick();
    document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn")[1]!.click();
    await tick();
    expect(panels()).toHaveLength(1);
    expect(r.calls[1]!.req).toMatchObject({ path: "/p", dir: true });
    r.dir("/p", [{ name: "src", type: "dir", mtimeMs: 1 }]);
    await tick();
    expect((document.querySelectorAll<HTMLButtonElement>(".preview-nav-btn")[1] as HTMLButtonElement).disabled).toBe(
      true,
    );
    r.handle.close();
    await tick();
  });

  it("path bar: submitting navigates IN PLACE (no dir hint forced)", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    const input = document.querySelector<HTMLInputElement>(".preview-dir-pathbar-input")!;
    expect(input.value).toBe("/p/src");
    input.value = "~/snap/x.png";
    input.dispatchEvent(new Event("input"));
    document.querySelector<HTMLFormElement>(".preview-dir-pathbar")!.requestSubmit();
    await tick();
    expect(panels()).toHaveLength(1);
    expect(r.calls[1]!.req).toMatchObject({ path: "~/snap/x.png" });
    r.dir("~/snap", [{ name: "x.png", type: "file", size: 1, mtimeMs: 1 }]);
    await tick();
    expect(document.querySelector(".preview-dir-list")!.textContent).toContain("x.png");
    r.handle.close();
    await tick();
  });

  it("B6/§3.2: an UNPROBED path ref inside a rendered md opens a speculative window; settling as text KEEPS it", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/readme.md" });
    r.text("/p/readme.md", "see `src/deep/x.ts` for details");
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull();
    const refEl = document.querySelector(".preview-md .path-ref") as HTMLElement;
    expect(refEl).not.toBeNull();
    refEl.click();
    await tick();
    expect(panels()).toHaveLength(2); // unknown route ⇒ speculative window B
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/src/deep/x.ts" });
    r.text("/p/src/deep/x.ts", "export {}");
    await tick();
    expect(panels()).toHaveLength(2); // a FILE settles ⇒ B stays a normal window
    expect(panels()[1]!.textContent).toContain("export");
    r.handle.close();
    await tick();
  });

  it("an md link with a trailing slash (dir:true) navigates IN PLACE inside the clicking window", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/readme.md" });
    r.text("/p/readme.md", "see [docs](docs/) inside");
    await tick();
    const link = document.querySelector(".preview-md .path-ref") as HTMLElement;
    expect(link).not.toBeNull();
    link.click();
    await tick();
    expect(panels()).toHaveLength(1);
    expect(r.calls[1]!.req).toMatchObject({ path: "/p/docs", dir: true });
    r.dir("/p/docs", []);
    await tick();
    expect((document.querySelector(".preview-nav-btn") as HTMLButtonElement).disabled).toBe(false);
    r.handle.close();
    await tick();
  });

  it("Esc closes the window containing the target and aborts ITS in-flight fetch only", async () => {
    const r = rigWindows();
    r.handle.open({ path: "/p/src", dir: true });
    r.dir("/p/src", [{ name: "sub", type: "dir", mtimeMs: 1 }]);
    await tick();
    const row = document.querySelectorAll(".preview-dir-list button.preview-dir-row")[0] as HTMLElement;
    row.click();
    row.click();
    await tick();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    panels()[0]!.dispatchEvent(ev);
    await tick();
    expect(panels()).toHaveLength(0);
    expect(r.calls[1]!.opts.signal.aborted).toBe(true); // the in-flight listing fetch was aborted
    r.handle.dispose();
  });
});

// --- shared helpers for the download suites (preview-download, moved chain) ---
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

function rigDownload(view: PreviewView, hub: unknown): FakeWindow {
  const win = fakeWindowHandle(1, view);
  const face = fakeWindowsFace([win]);
  mountHost({ handle: face, plaintext: false }, hub);
  return win;
}

describe("PreviewWindow — 下载 (preview-download, per-window chain)", () => {
  it("text phase: the button re-fetches through the same endpoint and saves basename + text/plain blob", async () => {
    const { hub, calls } = hubWithFetch(async () => ({
      ok: true,
      kind: "text",
      size: 4,
      truncated: false,
      text: "body",
    }));
    rigDownload({ phase: "text", path: "/p/src/a.ts", size: 4, truncated: false, text: "body" }, hub);
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
    await vi.waitFor(() => expect(s.revokeSpy).toHaveBeenCalledWith("blob:fake-1"));
    expect(document.querySelector(".preview-download-error")).toBeNull();
  });

  it("image phase: the response Blob (with the header mime) is saved verbatim", async () => {
    const blob = new Blob(["PNG"], { type: "image/png" });
    const { hub } = hubWithFetch(async () => ({
      ok: true,
      kind: "image",
      mime: "image/png",
      size: 3,
      dims: { w: 1, h: 1 },
      blob,
    }));
    rigDownload(
      {
        phase: "image",
        path: "/p/shot.png",
        dataUrl: "data:image/png;base64,AAA",
        mime: "image/png",
        dims: { w: 1, h: 1 },
        size: 3,
      },
      hub,
    );
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(s.blobs[0]).toBe(blob);
    expect(s.saved[0]!.download).toBe("shot.png");
  });

  it('a lossy basename (U+FFFD) degrades to "download"', async () => {
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }));
    rigDownload({ phase: "text", path: "/p/bad\uFFFD", size: 1, truncated: false, text: "x" }, hub);
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(s.saved[0]!.download).toBe("download");
  });

  it("dir phase never shows the button; failure shows the error line and a retry re-fetches", async () => {
    const { hub } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }));
    rigDownload(
      {
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
      },
      hub,
    );
    await tick();
    expect(document.querySelector(".preview-download")).toBeNull();

    let n = 0;
    const { hub: hub2, calls } = hubWithFetch(async () => {
      n += 1;
      return n === 1
        ? { ok: false, error: "E_NETWORK", status: 0 }
        : { ok: true, kind: "text", size: 1, truncated: false, text: "x" };
    });
    rigDownload({ phase: "text", path: "/p/a.ts", size: 1, truncated: false, text: "x" }, hub2);
    await tick();
    const btn = document.querySelector<HTMLButtonElement>(".preview-download")!;
    btn.click();
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).not.toBeNull());
    const s = stubSave();
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(calls).toHaveLength(2);
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).toBeNull());
  });
});

describe("PreviewWindow — 不可预览类型的下载 (download=1)", () => {
  const DL_CAPS = ["preview.v1", "preview.download.v1"];

  it("unsupported phase WITH the cap: 「不支持预览 — 可下载」 + a button that saves via download=1", async () => {
    const blob = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: "application/octet-stream" });
    const { hub, downloadCalls } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }), {
      caps: DL_CAPS,
      download: async () => ({ ok: true, kind: "download", blob, size: 4 }),
    });
    rigDownload({ phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 4 }, hub);
    await tick();
    const note = document.querySelector(".preview-note")!;
    expect(note.textContent).toContain("cannot be previewed");
    expect(note.textContent).toContain("download it instead");
    const btn = document.querySelector<HTMLButtonElement>(".preview-download-unsupported")!;
    const s = stubSave();
    btn.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(downloadCalls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/p/bundle.zip" }]);
    expect(s.saved[0]!.download).toBe("bundle.zip");
    expect(s.blobs[0]).toBe(blob);
  });

  it("unsupported phase WITHOUT preview.download.v1 (old hub): no button, reason text", async () => {
    const { hub } = hubWithFetch(async () => ({ ok: false, error: "E_NETWORK", status: 0 }), {
      caps: ["preview.v1"],
      download: async () => ({ ok: true, kind: "download", blob: new Blob([]), size: 0 }),
    });
    rigDownload({ phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 4 }, hub);
    await tick();
    expect(document.querySelector(".preview-download-unsupported")).toBeNull();
    expect(document.querySelector(".preview-note")!.textContent).toContain("binary file");
  });

  it("download=1 failure shows the error line; the button stays for a retry", async () => {
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
    rigDownload({ phase: "unsupported", path: "/p/bundle.zip", reason: "binary", size: 1 }, hub);
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
describe("PreviewWindow — chunked preview (P2b)", () => {
  it("truncated note regression: shows the DISPLAYED bytes, not the file size", async () => {
    rigPhase({
      phase: "text",
      path: "/p/big.log",
      size: Math.round(2.3 * 1024 * 1024),
      bytes: 256 * 1024,
      truncated: true,
      text: "x",
    });
    await tick();
    const note = document.querySelector(".preview-truncated")!.textContent!;
    expect(note).toContain("first 256 KiB of 2.3 MiB");
    expect(note).not.toContain("first 2.3 MiB");
  });

  it("falls back to the UTF-8 length of the text when the view carries no bytes", async () => {
    rigPhase({ phase: "text", path: "/p/a.log", size: 4096, truncated: true, text: "héllo" });
    await tick();
    expect(document.querySelector(".preview-truncated")!.textContent).toContain("first 6 B of 4.0 KiB");
  });

  it("text download with the preview.download.v1 cap saves the COMPLETE file via download=1 (D11)", async () => {
    const full = new Blob(["whole file"], { type: "application/octet-stream" });
    const { hub, calls, downloadCalls } = hubWithFetch(
      async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }),
      {
        caps: ["preview.v1", "preview.download.v1"],
        download: async () => ({ ok: true, blob: full }),
      },
    );
    rigDownload({ phase: "text", path: "/p/big.log", size: 9_000_000, truncated: true, text: "part" }, hub);
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(downloadCalls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/p/big.log" }]);
    expect(calls).toEqual([]);
    expect(s.blobs[0]).toBe(full);
    expect(s.saved[0]!.download).toBe("big.log");
  });

  it("without the download cap the text download keeps the legacy fetch path", async () => {
    const { hub, calls, downloadCalls } = hubWithFetch(
      async () => ({ ok: true, kind: "text", size: 4, truncated: false, text: "body" }),
      { download: async () => ({ ok: true, blob: new Blob(["x"]) }) },
    );
    rigDownload({ phase: "text", path: "/p/a.ts", size: 4, truncated: false, text: "body" }, hub);
    await tick();
    const s = stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(s.saved).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(downloadCalls).toEqual([]);
  });

  it("a failed full download surfaces the download error line", async () => {
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 1, truncated: false, text: "x" }), {
      caps: ["preview.v1", "preview.download.v1"],
      download: async () => ({ ok: false, status: 500, error: "E_X" }),
    });
    rigDownload({ phase: "text", path: "/p/a.log", size: 9, truncated: true, text: "x" }, hub);
    await tick();
    stubSave();
    document.querySelector<HTMLButtonElement>(".preview-download")!.click();
    await vi.waitFor(() => expect(document.querySelector(".preview-download-error")).not.toBeNull());
  });
});

// ---------------------------------------------------------------------------
// web-hub-html-preview plan v2 §5 (P2): html text phase holds the panel height
// ---------------------------------------------------------------------------
describe("PreviewWindow — html text phase holds the panel height (web-hub-html-preview §5)", () => {
  const TEXT_VIEW = { phase: "text", path: "/p/index.html", text: "<p>x</p>", truncated: false, size: 8 };

  function rigHtml(html: boolean, htmlCap: boolean): void {
    const scope = html
      ? ({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true, html: true } as never)
      : ({ agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true } as never);
    const win = fakeWindowHandle(1, TEXT_VIEW as unknown as PreviewView, scope);
    const face = fakeWindowsFace([win], scope);
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
    mountHost({ handle: face, plaintext: false }, hub);
  }

  it("cap present ⇒ is-hold-tall from the very first html text phase", async () => {
    rigHtml(true, true);
    await tick();
    expect(panels()[0]!.classList.contains("is-hold-tall")).toBe(true);
  });

  it("cap absent (no scope.html or no transport htmlCap) ⇒ no class flip (pre-feature DOM)", async () => {
    rigHtml(false, true);
    await tick();
    expect(panels()[0]!.classList.contains("is-hold-tall")).toBe(false);
    document.body.innerHTML = "";
    rigHtml(true, false);
    await tick();
    expect(panels()[0]!.classList.contains("is-hold-tall")).toBe(false);
  });

  it("a non-html text phase never triggers the hold, cap or not", async () => {
    const scope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true, html: true } as never;
    const win = fakeWindowHandle(1, TEXT_VIEW as unknown as PreviewView, scope);
    const face = fakeWindowsFace([win], scope);
    const hub = {
      state: ref({ selected: "A", agents: new Map(), hub: { caps: ["preview.v1"] } }),
      preview: {
        fetch: () => Promise.resolve({ ok: true, kind: "text", text: "x", truncated: false, size: 1 }),
        htmlCap: () =>
          Promise.resolve({ ok: true, url: "/pv/x/index.html", openUrl: "/pvw/x", idleMs: 1, hardRemainingMs: 1 }),
      },
      dispatch: () => {},
    };
    mountHost({ handle: face, plaintext: false }, hub);
    await tick();
    expect(panels()[0]!.classList.contains("is-hold-tall")).toBe(true); // html first: held
    win.view.value = { phase: "closed" };
    await tick();
    win.view.value = { phase: "text", path: "/p/x.log", text: "y", truncated: false, size: 1 };
    await tick();
    expect(panels()[0]!.classList.contains("is-hold-tall")).toBe(false); // fresh open starts compact
  });
});

// ---------------------------------------------------------------------------
// header 复制 button (2026-10-20: copy moved next to download) — window-scoped now
// ---------------------------------------------------------------------------
describe("PreviewWindow — header 复制 button", () => {
  it("text phase: header order is copy → download → close; the copy value is exactly the shown text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { hub } = hubWithFetch(async () => ({ ok: true, kind: "text", size: 4, truncated: false, text: "body" }));
    const win = fakeWindowHandle(1, { phase: "closed" });
    const face = fakeWindowsFace([win]);
    mountHost({ handle: face, plaintext: false }, hub);
    win.view.value = { phase: "text", path: "/p/a.txt", text: "shown part only", truncated: true, size: 262144 };
    await tick();

    const header = document.querySelector(".preview-header")!;
    const kids = Array.from(header.children).map((el) => el.className);
    const idx = (cls: string) => kids.findIndex((c) => c.includes(cls));
    expect(idx("preview-copy")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-download")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-close")).toBeGreaterThanOrEqual(0);
    expect(idx("preview-copy")).toBeLessThan(idx("preview-download"));
    expect(idx("preview-download")).toBeLessThan(idx("preview-close"));

    const copyBtn = document.querySelector<HTMLButtonElement>(".preview-copy button")!;
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy");
    copyBtn.click();
    await tick();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("shown part only");
  });

  it("markdown rendered mode: the header copy still copies the SOURCE text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const { win } = rigPhase({ phase: "text", path: "/p/README.md", text: "# Hi\n\nbody", truncated: false, size: 10 });
    await tick();
    expect(document.querySelector(".preview-md")).not.toBeNull();
    (document.querySelector(".preview-copy button") as HTMLElement).click();
    await tick();
    expect(writeText).toHaveBeenCalledWith("# Hi\n\nbody");
  });

  it("image / loading phases have no copy value ⇒ no header copy button; a text → image switch drops it", async () => {
    const { win } = rigPhase({ phase: "text", path: "/p/a.txt", text: "body", truncated: false, size: 4 });
    await tick();
    expect(document.querySelector(".preview-copy")).not.toBeNull();
    win.view.value = {
      phase: "image",
      path: "/p/a.png",
      dataUrl: "data:image/png;base64,AAAA",
      mime: "image/png",
      dims: { w: 4, h: 2 },
      size: 2048,
    };
    await tick();
    expect(document.querySelector(".preview-copy")).toBeNull();
    win.view.value = { phase: "loading", path: "/p/b.ts" };
    await tick();
    expect(document.querySelector(".preview-copy")).toBeNull();
  });
});
