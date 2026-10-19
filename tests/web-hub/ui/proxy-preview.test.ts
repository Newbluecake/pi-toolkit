// @vitest-environment happy-dom
/**
 * link-preview plan §4.3 (LP3): `useProxyPreview` (the App-level `closed | opening | ready |
 * error` state machine) and `ProxyPreview.vue` (the in-page dialog).
 *
 * Covers: generation/abort/same-href dedupe/reload; the exact §2.5 iframe attributes (D5 — no
 * `credentialless`, no `allow-top-navigation*`); the same-origin enter-URL mount guard; the
 * absence of any `message` listener; the standing hint in `ready`; 「新标签打开」's synchronous
 * `window.open` + popup-blocked fallback; the D9 「直接打开原链接」 anchor; focus/Esc/scrim/
 * scroll-lock restore; and close-on-agent-route-change.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import ProxyPreview from "../../../src/web-hub/ui/src/components/proxy/ProxyPreview.vue";
import { PROXY_PREVIEW_CTX } from "../../../src/web-hub/ui/src/components/proxy/proxyPreviewContext.js";
import { CONTROL_ENV, HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { useProxyPreview } from "../../../src/web-hub/ui/src/composables/useProxyPreview.js";
import { resetBodyScrollLock } from "../../../src/web-hub/ui/src/composables/useScrollLock.js";
import { PROXY_FRAME_ALLOW, PROXY_FRAME_SANDBOX } from "../../../src/web-hub/protocol/proxy.js";
import type { ProxyTransport } from "../../../src/web-hub/ui/src/transport/types.js";

// happy-dom would otherwise REALLY fetch every iframe `src` over the network (ECONNREFUSED noise).
(
  window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
).happyDOM.settings.disableIframePageLoading = true;

const ORIGIN = "http://127.0.0.1:7900";
const ENTER = `${ORIGIN}/__pwh_proxy__/enter?c=` + "C".repeat(43);
const OPEN_OK = {
  ok: true as const,
  instanceId: "inst_12345678",
  origin: ORIGIN,
  enterUrl: ENTER,
  target: { host: "127.0.0.1", port: 3000, cls: "loopback" as const },
};

function fakeProxy(over: Partial<ProxyTransport> = {}) {
  const t = {
    open: vi.fn(async () => OPEN_OK),
    list: vi.fn(),
    stop: vi.fn(),
    ...over,
  };
  return t as unknown as ProxyTransport & { open: ReturnType<typeof vi.fn> };
}

const CAPS_FRAME = ["proxy.v1", "proxy.frame.v1"];

function stateOf(caps: string[], selected: string | null = "a1") {
  return ref({ hub: { caps }, agents: new Map(), selected, conn: "open" });
}

function makeHandle(caps = CAPS_FRAME, proxy = fakeProxy(), extra: { locationOrigin?: string } = {}) {
  const state = stateOf(caps);
  const handle = useProxyPreview({ proxy, state, mode: "token", ...extra });
  return { handle, state, proxy };
}

afterEach(() => {
  resetBodyScrollLock();
  document.body.style.overflow = "";
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useProxyPreview — scope gating (§4.1)", () => {
  it("no frame cap / no proxy cap / no transport ⇒ scope null and open() is a no-op", () => {
    const noFrame = makeHandle(["proxy.v1"]);
    expect(noFrame.handle.scope.value).toBeNull();
    noFrame.handle.open("http://127.0.0.1:3000/ui");
    expect(noFrame.proxy.open).not.toHaveBeenCalled();
    expect(noFrame.handle.view.value.phase).toBe("closed");

    const noProxy = makeHandle(["proxy.frame.v1"]);
    expect(noProxy.handle.scope.value).toBeNull();

    const noTransport = useProxyPreview({ proxy: undefined, state: stateOf(CAPS_FRAME), mode: "token" });
    expect(noTransport.scope.value).toBeNull();
    noTransport.open("http://127.0.0.1:3000/ui");
    expect(noTransport.view.value.phase).toBe("closed");
  });

  it("proxy scope + proxy.frame.v1 ⇒ scope non-null", () => {
    const { handle } = makeHandle();
    expect(handle.scope.value).toEqual({ lan: false });
  });
});

describe("useProxyPreview — state machine (§4.3)", () => {
  it("open POSTs the full normalized href verbatim and enters ready with the returned enter URL unmodified", async () => {
    const { handle, proxy } = makeHandle();
    const href = "http://127.0.0.1:3000/ui?tab=a";
    handle.open(href);
    expect(handle.view.value).toMatchObject({ phase: "opening", href });
    expect(proxy.open).toHaveBeenCalledTimes(1);
    const [body, opts] = proxy.open.mock.calls[0]!;
    expect(body).toEqual({ target: href }); // path + query preserved (the 「lands on /」 report)
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "ready", href, origin: ORIGIN, enterUrl: ENTER });
  });

  it("a same-href open while opening is a no-op; a different href aborts and supersedes", async () => {
    let releaseFirst!: (v: typeof OPEN_OK) => void;
    const proxy = fakeProxy();
    proxy.open
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r as never)))
      .mockImplementation(async () => OPEN_OK);
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    handle.open("http://127.0.0.1:3000/a");
    handle.open("http://127.0.0.1:3000/a"); // dedupe
    expect(proxy.open).toHaveBeenCalledTimes(1);

    const firstSignal = proxy.open.mock.calls[0]![1]?.signal;
    handle.open("http://127.0.0.1:3000/b");
    expect(proxy.open).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
    const genB = (handle.view.value as { gen: number }).gen;

    // The stale first request resolves late — its result must be dropped by the generation.
    releaseFirst({ ...OPEN_OK, enterUrl: `${ORIGIN}/__pwh_proxy__/enter?c=stale` });
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "ready", href: "http://127.0.0.1:3000/b", gen: genB });
  });

  it("close aborts the in-flight request and returns to closed", async () => {
    const { handle, proxy } = makeHandle();
    handle.open("http://127.0.0.1:3000/a");
    const signal = proxy.open.mock.calls[0]![1]?.signal;
    handle.close();
    expect(signal?.aborted).toBe(true);
    expect(handle.view.value.phase).toBe("closed");
    await flushPromises();
    expect(handle.view.value.phase).toBe("closed"); // the late resolve stays dropped
  });

  it("reload() in ready navigates the frame IN PLACE (no POST, no new code; 2026-10-19 ruling)", async () => {
    const { handle, proxy } = makeHandle();
    handle.open("http://127.0.0.1:3000/ui?tab=a");
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "ready", frameUrl: ENTER, nonce: 0 });
    const gen1 = (handle.view.value as { gen: number }).gen;
    handle.reload();
    expect(proxy.open).toHaveBeenCalledTimes(1); // the open token bucket is NOT touched
    expect(handle.view.value).toMatchObject({
      phase: "ready",
      gen: gen1, // gen only moves for real opens
      nonce: 1,
      frameUrl: `${ORIGIN}/ui?tab=a`, // origin + the initial target's path+query
    });
    handle.reload();
    expect(proxy.open).toHaveBeenCalledTimes(1);
    expect(handle.view.value).toMatchObject({ phase: "ready", nonce: 2, frameUrl: `${ORIGIN}/ui?tab=a` });
  });

  it("reload() in error keeps calling open(href) (fresh one-time code)", async () => {
    const proxy = fakeProxy();
    proxy.open.mockResolvedValueOnce({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" } as never);
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    handle.open("http://127.0.0.1:3000/a");
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "error", key: "proxy.reason.public" });
    handle.reload(); // retry from error re-opens
    expect(proxy.open).toHaveBeenCalledTimes(2);
    expect(proxy.open.mock.calls[1]![0]).toEqual({ target: "http://127.0.0.1:3000/a" });
  });

  it("proxyFrameReloadUrl: the mount guard rejects a same-origin (hub) reload target and non-http hrefs", async () => {
    const { proxyFrameReloadUrl } = await import("../../../src/web-hub/ui/src/composables/useProxyPreview.js");
    const page = "http://192.168.1.10:9000";
    expect(proxyFrameReloadUrl(ORIGIN, "http://127.0.0.1:3000/ui?tab=a", page)).toBe(`${ORIGIN}/ui?tab=a`);
    expect(proxyFrameReloadUrl(ORIGIN, "http://127.0.0.1:3000", page)).toBe(`${ORIGIN}/`);
    // same-origin to the hub page ⇒ rejected (the frame must never navigate onto the hub itself)
    expect(proxyFrameReloadUrl(page, "http://127.0.0.1:3000/ui", page)).toBeNull();
    // the constructed URL must stay on the open result's origin, and http only
    expect(proxyFrameReloadUrl(ORIGIN, "https://127.0.0.1:3000/ui", page)).toBeNull();
    expect(proxyFrameReloadUrl(ORIGIN, "not a url", page)).toBeNull();
    expect(proxyFrameReloadUrl(ORIGIN, "http://127.0.0.1:3000/ui", null)).toBeNull(); // unknown page origin: closed
  });

  it("an off-contract or same-origin enter URL never reaches ready (§2.5 mount guard)", async () => {
    const bad = fakeProxy();
    bad.open.mockResolvedValueOnce({ ...OPEN_OK, enterUrl: "https://evil.test/x" } as never);
    const a = makeHandle(CAPS_FRAME, bad);
    a.handle.open("http://127.0.0.1:3000/a");
    await flushPromises();
    expect(a.handle.view.value).toMatchObject({ phase: "error", key: "proxy.error" });

    // Same-origin to the hub page: structurally valid enter URL, still refused.
    const same = fakeProxy();
    const b = makeHandle(CAPS_FRAME, same, { locationOrigin: ORIGIN });
    b.handle.open("http://127.0.0.1:3000/a");
    await flushPromises();
    expect(b.handle.view.value).toMatchObject({ phase: "error", key: "proxy.error" });
  });

  it("closes on an agent-route change and when the frame scope is lost", async () => {
    const { handle, state } = makeHandle();
    handle.open("http://127.0.0.1:3000/a");
    await flushPromises();
    expect(handle.view.value.phase).toBe("ready");
    state.value = { ...state.value, selected: "a2" };
    await nextTick();
    expect(handle.view.value.phase).toBe("closed");

    handle.open("http://127.0.0.1:3000/a");
    await flushPromises();
    expect(handle.view.value.phase).toBe("ready");
    state.value = { ...state.value, hub: { caps: ["proxy.v1"] } }; // cap dropped on reconnect
    await nextTick();
    expect(handle.view.value.phase).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// ProxyPreview.vue
// ---------------------------------------------------------------------------

const ENV = { authMode: "token" as const, plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };

function mountDialog(caps: string[], proxy: ProxyTransport, handle = makeHandle(caps, proxy).handle) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const hub = { state: stateOf(caps), transport: { proxy } };
  const w = mount(ProxyPreview, {
    attachTo: host,
    global: {
      provide: {
        [PROXY_PREVIEW_CTX as symbol]: { handle },
        [HUB_CTX as symbol]: hub,
        [CONTROL_ENV as symbol]: ENV,
      },
    },
  });
  return { w, handle };
}

const overlay = (): HTMLElement | null => document.querySelector(".proxy-preview-overlay");
const panel = (): HTMLElement | null => document.querySelector(".proxy-preview-panel");
const frame = (): HTMLIFrameElement | null => document.querySelector(".proxy-preview-frame");

async function openToReady(handle: ReturnType<typeof useProxyPreview>, href = "http://127.0.0.1:3000/ui") {
  handle.open(href);
  await flushPromises();
  await nextTick();
}

describe("ProxyPreview.vue — rendering", () => {
  it("nothing renders while closed (or without PROXY_PREVIEW_CTX)", () => {
    const { handle } = makeHandle();
    mountDialog(CAPS_FRAME, fakeProxy(), handle);
    expect(overlay()).toBeNull();
    const bare = mount(ProxyPreview, { attachTo: document.body.appendChild(document.createElement("div")) });
    expect(overlay()).toBeNull();
    bare.unmount();
  });

  it("opening: centered spinner status, the typed target in the header, no iframe yet", async () => {
    const proxy = fakeProxy();
    proxy.open.mockImplementationOnce(() => new Promise(() => {})) as never; // never settles
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    mountDialog(CAPS_FRAME, proxy, handle);
    handle.open("http://127.0.0.1:3000/ui");
    await nextTick();
    expect(document.querySelector(".proxy-preview-loading")?.getAttribute("role")).toBe("status");
    expect(panel()!.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".proxy-preview-target")!.textContent).toBe("http://127.0.0.1:3000/ui");
    expect(frame()).toBeNull();
    expect(document.querySelector(".proxy-preview-hint")).toBeNull(); // hint is ready-only
  });

  it("ready: the §2.5 iframe with EXACT attributes (no credentialless), origin line, standing hint", async () => {
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    const f = frame()!;
    expect(f.getAttribute("src")).toBe(ENTER); // the enter URL, unmodified
    expect(f.getAttribute("sandbox")).toBe(PROXY_FRAME_SANDBOX);
    expect(f.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(f.getAttribute("allow")).toBe(PROXY_FRAME_ALLOW);
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.hasAttribute("allowfullscreen")).toBe(true);
    expect(f.hasAttribute("credentialless")).toBe(false); // D5: would drop the gate cookie
    expect(document.querySelector(".proxy-preview-origin")!.textContent).toContain(ORIGIN);
    const hint = document.querySelector(".proxy-preview-hint")!;
    expect(hint.getAttribute("role")).toBe("note");
    expect(hint.textContent!.length).toBeGreaterThan(10);
  });

  it("iframe: no `message` listener is ever registered", async () => {
    const spy = vi.spyOn(window, "addEventListener");
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    const { w } = mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    expect(spy.mock.calls.filter((c) => c[0] === "message")).toHaveLength(0);
    w.unmount();
  });

  it("the 10 s no-`load` escalation shows 「仍在加载…」; a load event clears the overlay", async () => {
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    const { w } = mountDialog(CAPS_FRAME, proxy, handle);
    vi.useFakeTimers();
    await openToReady(handle);
    expect(document.querySelector(".proxy-preview-frame-loading")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(document.querySelector(".proxy-preview-frame-loading")!.textContent).toContain("Still loading");
    w.unmount();
    vi.useRealTimers();

    // second mount: a frame load hides the loading overlay
    const proxy2 = fakeProxy();
    const m2 = makeHandle(CAPS_FRAME, proxy2);
    mountDialog(CAPS_FRAME, proxy2, m2.handle);
    await openToReady(m2.handle, "http://127.0.0.1:3000/b");
    frame()!.dispatchEvent(new Event("load"));
    await nextTick();
    expect(document.querySelector(".proxy-preview-frame-loading")).toBeNull();
  });

  it("error: prose reason, 「重试」 re-opens, and the D9 native anchor to the original link", async () => {
    const proxy = fakeProxy();
    proxy.open.mockResolvedValueOnce({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" } as never);
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    mountDialog(CAPS_FRAME, proxy, handle);
    handle.open("http://127.0.0.1:3000/ui");
    await flushPromises();
    await nextTick();
    expect(frame()).toBeNull();
    expect(document.querySelector(".proxy-preview-error")).not.toBeNull();
    const a = document.querySelector<HTMLAnchorElement>(".proxy-preview-original")!;
    expect(a.getAttribute("href")).toBe("http://127.0.0.1:3000/ui");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
    document.querySelector<HTMLButtonElement>(".proxy-preview-retry")!.click();
    await flushPromises();
    expect(proxy.open).toHaveBeenCalledTimes(2);
    expect(proxy.open.mock.calls[1]![0]).toEqual({ target: "http://127.0.0.1:3000/ui" });
  });

  it("「新标签打开」 calls window.open SYNCHRONOUSLY in the click handler; blocked ⇒ fallback link", async () => {
    // Synchronous: window.open must fire inside the click handler, BEFORE the transport
    // resolves (popup blockers) — assert without any flush in between.
    const proxy = fakeProxy();
    const tab = { opener: "x" as unknown, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    const { w } = mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    const callsBefore = open.mock.calls.length;
    document.querySelector<HTMLButtonElement>(".proxy-preview-open-tab")!.click();
    expect(open.mock.calls.length).toBe(callsBefore + 1); // BEFORE any await/flush
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    await flushPromises();
    expect(proxy.open.mock.calls.at(-1)![0]).toEqual({ target: "http://127.0.0.1:3000/ui" });
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER); // the enter URL, unmodified
    w.unmount();

    // Blocked popup ⇒ the one-time enter URL surfaces as a manual link (existing fallback).
    const proxy2 = fakeProxy();
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    const m2 = makeHandle(CAPS_FRAME, proxy2);
    mountDialog(CAPS_FRAME, proxy2, m2.handle);
    await openToReady(m2.handle, "http://127.0.0.1:3000/b");
    document.querySelector<HTMLButtonElement>(".proxy-preview-open-tab")!.click();
    await flushPromises();
    await nextTick();
    const note = document.querySelector(".proxy-preview-note")!;
    expect(note.getAttribute("role")).toBe("status");
    const link = note.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(ENTER);
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("focus enters the panel, Esc closes (preventDefault + stopPropagation), focus and scroll restore", async () => {
    const prior = document.body.appendChild(document.createElement("button"));
    prior.focus();
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    const { w } = mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    expect(document.body.style.overflow).toBe("hidden");
    await nextTick();
    expect(document.activeElement).toBe(panel());

    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    let propagated = false;
    document.body.addEventListener("keydown", () => (propagated = true), { once: true });
    overlay()!.dispatchEvent(ev);
    await nextTick();
    expect(ev.defaultPrevented).toBe(true);
    expect(propagated).toBe(false); // stopPropagation
    expect(handle.view.value.phase).toBe("closed");
    await nextTick();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(prior);
    w.unmount();
  });

  it("scrim click closes; a click inside the panel does not; scroll lock releases on unmount", async () => {
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    const { w } = mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    panel()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); // bubbles to overlay, not .self
    await nextTick();
    expect(handle.view.value.phase).not.toBe("closed");
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(handle.view.value.phase).toBe("closed");

    await openToReady(handle, "http://127.0.0.1:3000/c");
    expect(document.body.style.overflow).toBe("hidden");
    w.unmount(); // unmount mid-open: the lock is ALWAYS restored
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on an agent-route change (the overlay disappears)", async () => {
    const proxy = fakeProxy();
    const { handle, state } = makeHandle(CAPS_FRAME, proxy);
    mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    expect(overlay()).not.toBeNull();
    state.value = { ...state.value, selected: "a2" };
    await nextTick();
    await nextTick();
    expect(overlay()).toBeNull();
  });

  it("header buttons carry aria-label + title tooltips; reload remounts the frame in place (no POST)", async () => {
    const proxy = fakeProxy();
    const { handle } = makeHandle(CAPS_FRAME, proxy);
    mountDialog(CAPS_FRAME, proxy, handle);
    await openToReady(handle);
    for (const sel of [".proxy-preview-reload", ".proxy-preview-open-tab", ".proxy-preview-close"]) {
      const btn = document.querySelector<HTMLButtonElement>(sel)!;
      expect(btn.getAttribute("aria-label")).toBeTruthy();
      expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
    }
    const before = frame();
    expect(before!.getAttribute("src")).toBe(ENTER);
    document.querySelector<HTMLButtonElement>(".proxy-preview-reload")!.click();
    await nextTick();
    expect(proxy.open).toHaveBeenCalledTimes(1); // zero additional opens (token-bucket ruling)
    const after = frame();
    expect(after).not.toBe(before); // remounted via the nonce in :key
    expect(after!.getAttribute("src")).toBe(`${ORIGIN}/ui`); // origin + the initial target's path
  });
});
