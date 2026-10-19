// @vitest-environment happy-dom
/**
 * web-hub-proxy plan v2 §8 (X2): T-U2 (PathText / MdInline / TopBar: identical DOM without a
 * scope, interception with one), T-U3 (open flow), T-U4 (dialog list/open/stop, no polling).
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import PathText from "../../../src/web-hub/ui/src/components/preview/PathText.vue";
import MdInline from "../../../src/web-hub/ui/src/components/transcript/MdInline.vue";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import ProxyDialog from "../../../src/web-hub/ui/src/components/proxy/ProxyDialog.vue";
import { CONTROL_ENV, HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { PATH_REFERENCES_SUSPENDED } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { openProxyTab } from "../../../src/web-hub/ui/src/composables/useProxyOpen.js";
import { PROXY_PREVIEW_CTX } from "../../../src/web-hub/ui/src/components/proxy/proxyPreviewContext.js";
import { useProxyPreview } from "../../../src/web-hub/ui/src/composables/useProxyPreview.js";
import type { ProxyTransport } from "../../../src/web-hub/ui/src/transport/types.js";

const ENTER = "http://127.0.0.1:7900/__pwh_proxy__/enter?c=" + "C".repeat(43);
const OPEN_OK = {
  ok: true as const,
  instanceId: "inst_12345678",
  origin: "http://127.0.0.1:7900",
  enterUrl: ENTER,
  target: { host: "127.0.0.1", port: 23434, cls: "loopback" as const },
};
const LIST_OK = {
  ok: true as const,
  items: [
    {
      instanceId: "inst_12345678",
      target: { host: "127.0.0.1", port: 23434, cls: "loopback" as const },
      origin: "http://127.0.0.1:7900",
      createdAt: 1,
      mine: true,
    },
  ],
  policy: { maxProxies: 8, portRange: [7900, 7949] as const, lan: true },
};

function fakeProxy(over: Partial<ProxyTransport> = {}) {
  const t = {
    open: vi.fn(async () => OPEN_OK),
    list: vi.fn(async () => LIST_OK),
    stop: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
  return t as typeof t & ProxyTransport;
}

function hubOf(caps: string[], proxy?: ProxyTransport) {
  return {
    state: ref({ hub: { caps }, agents: new Map(), selected: null, conn: "open" }),
    ...(proxy === undefined ? {} : { transport: { proxy } }),
  };
}
const ENV = { authMode: "token" as const, plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };
const provideOf = (hub: unknown): Record<symbol, unknown> => ({
  [HUB_CTX as symbol]: hub,
  [CONTROL_ENV as symbol]: ENV,
});

function fakeWin(returnNull = false) {
  const tab = { opener: "x" as unknown, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn(() => (returnNull ? null : tab));
  return { tab, win: { open }, open };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Dispatch a click; resolves whether the COMPONENT's handler prevented it (a trailing listener then
 * prevents the navigation itself so happy-dom does not try to fetch the href). */
function clickPrevented(el: Element, init: MouseEventInit = {}): boolean {
  let prevented = false;
  const tail = (e: Event): void => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  el.addEventListener("click", tail);
  el.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, ...init }));
  el.removeEventListener("click", tail);
  return prevented;
}

function htmlOf(comp: unknown, props: Record<string, unknown>, provide: Record<symbol, unknown>) {
  const w = mount(comp as never, { props, global: { provide } });
  const html = w.html();
  w.unmount();
  return html;
}

describe("T-U2 PathText", () => {
  const text = "start http://127.0.0.1:3000/a and 8.8.8.8 end";
  const scoped = () => provideOf(hubOf(["proxy.v1"], fakeProxy()));

  it("no scope (no ctx / no cap / no transport method): DOM identical to today's bare text", () => {
    const base = htmlOf(PathText, { text }, {});
    expect(base).toBe(text);
    expect(htmlOf(PathText, { text }, provideOf(hubOf([], fakeProxy())))).toBe(base);
    expect(htmlOf(PathText, { text }, provideOf(hubOf(["proxy.v1"])))).toBe(base);
    expect(htmlOf(PathText, { text }, provideOf(hubOf(["proxy.lan.v1"], fakeProxy())))).toBe(base); // wrong cap for token auth
  });

  it("no scope, code mode: unchanged code.md-code", () => {
    expect(htmlOf(PathText, { text: "http://127.0.0.1:3000", code: true }, {})).toBe(
      '<code class="md-code">http://127.0.0.1:3000</code>',
    );
  });

  it("with a scope: the local URL becomes span.proxy-ref, other text stays bare", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const w = mount(PathText, { props: { text }, attachTo: host, global: { provide: scoped() } });
    const refs = w.findAll("span.proxy-ref");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text()).toBe("http://127.0.0.1:3000/a");
    expect(refs[0]!.attributes("role")).toBe("button");
    expect(refs[0]!.attributes("tabindex")).toBe("0");
    expect(host.textContent).toBe(text); // wrapper.text() trims each fragment root; the host does not
    w.unmount();
  });

  it("with a scope but no matching URL: still byte-identical", () => {
    const t = "nothing local, only https://127.0.0.1:3000 and example.com:80";
    expect(htmlOf(PathText, { text: t }, scoped())).toBe(t);
  });

  it("noRefs / streaming suspension keep it plain even with a scope", () => {
    expect(htmlOf(PathText, { text, noRefs: true }, scoped())).toBe(text);
    expect(htmlOf(PathText, { text }, { ...scoped(), [PATH_REFERENCES_SUSPENDED as symbol]: ref(true) })).toBe(text);
  });

  it("inline code that is exactly one local URL becomes code.md-code.proxy-ref", () => {
    const w = mount(PathText, {
      props: { text: "http://localhost:5173", code: true },
      global: { provide: scoped() },
    });
    expect(w.find("code.md-code.proxy-ref").exists()).toBe(true);
    w.unmount();
  });

  it("click opens through the proxy (blank tab first, then navigate); Enter works; errors show an inline note", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(PathText, { props: { text }, global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) } });
    await w.get("span.proxy-ref").trigger("click");
    await flushPromises();
    expect(win.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(proxy.open).toHaveBeenCalledWith({ target: "http://127.0.0.1:3000/a" }, undefined);
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    expect(w.find(".proxy-ref-note").exists()).toBe(false);

    proxy.open.mockResolvedValueOnce({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "self-port" } as never);
    await w.get("span.proxy-ref").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(tab.close).toHaveBeenCalled();
    expect(w.get(".proxy-ref-note").text()).toContain("hub");
    w.unmount();
  });
});

describe("T-U2 MdInline", () => {
  const nodes = [
    { type: "link", href: "http://127.0.0.1:3000/x", children: [{ type: "text", text: "demo" }] },
    { type: "link", href: "https://example.com/", children: [{ type: "text", text: "ext" }] },
  ];

  it("no scope: anchors carry no class/title and a click is not prevented", async () => {
    const w = mount(MdInline, { props: { nodes: nodes as never }, global: { provide: {} } });
    const a = w.findAll("a");
    expect(a[0]!.attributes("class")).toBeUndefined();
    expect(a[0]!.attributes("title")).toBeUndefined();
    expect(a[0]!.attributes("href")).toBe("http://127.0.0.1:3000/x");
    expect(w.find(".proxy-ref-note").exists()).toBe(false);
    expect(clickPrevented(a[0]!.element)).toBe(false);
    w.unmount();
  });

  it("with a scope: only the local link is intercepted; modified clicks pass through", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(MdInline, {
      props: { nodes: nodes as never },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    const a = w.findAll("a");
    expect(a[0]!.classes()).toContain("proxy-ref");
    expect(a[1]!.classes()).not.toContain("proxy-ref");

    expect(clickPrevented(a[1]!.element)).toBe(false);

    expect(clickPrevented(a[0]!.element, { ctrlKey: true })).toBe(false);
    expect(proxy.open).not.toHaveBeenCalled();

    expect(clickPrevented(a[0]!.element)).toBe(true);
    await flushPromises();
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    w.unmount();
  });
});

describe("T-U2 TopBar entry", () => {
  const props = { hubVersion: null, canSignOut: false, conn: "open" } as const;
  const stubMq = () =>
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));

  it("no scope ⇒ no entry and no extra DOM; scope ⇒ one button", () => {
    stubMq();
    const off = mount(TopBar, { props, global: { provide: provideOf(hubOf([], fakeProxy())) } });
    const bare = mount(TopBar, { props });
    expect(off.find(".proxy-entry").exists()).toBe(false);
    expect(off.html()).toBe(bare.html());
    off.unmount();
    bare.unmount();
    const on = mount(TopBar, { props, global: { provide: provideOf(hubOf(["proxy.v1"], fakeProxy())) } });
    const btn = on.findAll(".proxy-entry");
    expect(btn).toHaveLength(1);
    expect(btn[0]!.attributes("aria-label")).toBeTruthy();
    on.unmount();
  });
});

describe("T-U3 openProxyTab flow", () => {
  it("opens the blank window synchronously, before the request resolves", async () => {
    const { win, tab } = fakeWin();
    let release!: (v: typeof OPEN_OK) => void;
    const t = fakeProxy({ open: vi.fn(() => new Promise((r) => (release = r as never))) as never });
    const p = openProxyTab(t, "127.0.0.1:23434", { win });
    expect(win.open).toHaveBeenCalledTimes(1); // before any await resolved
    expect(win.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.location.replace).not.toHaveBeenCalled();
    release(OPEN_OK);
    const out = await p;
    expect(out).toMatchObject({ ok: true, blocked: false });
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("error closes the blank tab and yields a prose key; the code never navigates", async () => {
    const { win, tab } = fakeWin();
    const t = fakeProxy({
      open: vi.fn(async () => ({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" })) as never,
    });
    const out = await openProxyTab(t, "8.8.8.8:80", { win });
    expect(out).toMatchObject({ ok: false, key: "proxy.reason.public" });
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("transport throwing is a network error and still closes the tab", async () => {
    const { win, tab } = fakeWin();
    const t = fakeProxy({ open: vi.fn(async () => Promise.reject(new Error("x"))) as never });
    expect(await openProxyTab(t, "a:1", { win })).toMatchObject({ ok: false, key: "proxy.network" });
    expect(tab.close).toHaveBeenCalled();
  });

  it("popup blocked (window.open ⇒ null): success carries the URL for a manual link", async () => {
    const { win } = fakeWin(true);
    const out = await openProxyTab(fakeProxy(), "127.0.0.1:23434", { win });
    expect(out).toMatchObject({ ok: true, blocked: true });
    if (out.ok) expect(out.result.enterUrl).toBe(ENTER);
  });

  it("window.open throwing is treated like a blocked popup", async () => {
    const win = {
      open: vi.fn(() => {
        throw new Error("denied");
      }),
    };
    expect(await openProxyTab(fakeProxy(), "a:1", { win })).toMatchObject({ ok: true, blocked: true });
  });

  it("an off-contract enter URL is never navigated to", async () => {
    const { win, tab } = fakeWin();
    const t = fakeProxy({ open: vi.fn(async () => ({ ...OPEN_OK, enterUrl: "https://evil.test/" })) as never });
    expect(await openProxyTab(t, "a:1", { win })).toMatchObject({ ok: false, key: "proxy.error" });
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
  });

  it("a navigation failure closes the tab and falls back to the link", async () => {
    const { win, tab } = fakeWin();
    tab.location.replace.mockImplementation(() => {
      throw new Error("x");
    });
    expect(await openProxyTab(fakeProxy(), "a:1", { win })).toMatchObject({ ok: true, blocked: true });
    expect(tab.close).toHaveBeenCalled();
  });
});

describe("T-U4 ProxyDialog", () => {
  function mountDialog(proxy: ProxyTransport) {
    return mount(ProxyDialog, {
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)), stubs: { Teleport: true } },
      attachTo: document.body,
    });
  }

  it("fetches the list once on open, renders items + policy notes, focuses the input", async () => {
    const proxy = fakeProxy();
    const w = mountDialog(proxy);
    await flushPromises();
    expect(proxy.list).toHaveBeenCalledTimes(1);
    expect(w.findAll(".proxy-item")).toHaveLength(1);
    expect(w.get(".proxy-item-target").text()).toBe("127.0.0.1:23434");
    expect(w.text()).toContain("7900");
    expect(w.text()).toContain("LAN access"); // lan:true note (zh under the default test locale) or en fallback
    w.unmount();
  });

  it("empty list and list error (with retry) states", async () => {
    const proxy = fakeProxy({ list: vi.fn(async () => ({ ...LIST_OK, items: [] })) as never });
    const w = mountDialog(proxy);
    await flushPromises();
    expect(w.find(".proxy-items").exists()).toBe(false);
    expect(w.find(".proxy-muted").exists()).toBe(true);
    w.unmount();

    const bad = fakeProxy({
      list: vi.fn(async () => ({ ok: false, status: 0, error: "E_NETWORK" })) as never,
    });
    const w2 = mountDialog(bad);
    await flushPromises();
    expect(w2.find(".proxy-list-error [role=alert]").exists()).toBe(true);
    (bad.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LIST_OK as never);
    await w2.get(".proxy-list-error button").trigger("click");
    await flushPromises();
    expect(w2.findAll(".proxy-item")).toHaveLength(1);
    w2.unmount();
  });

  it("submit opens a tab with the typed target and refreshes the list afterwards", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mountDialog(proxy);
    await flushPromises();
    await w.get("#proxy-target").setValue("  127.0.0.1:23434 ");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(proxy.open).toHaveBeenCalledWith({ target: "127.0.0.1:23434" }, undefined);
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    expect(proxy.list).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("deny reason is shown as prose in an alert; the blank tab is closed", async () => {
    const proxy = fakeProxy({
      open: vi.fn(async () => ({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" })) as never,
    });
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mountDialog(proxy);
    await flushPromises();
    await w.get("#proxy-target").setValue("8.8.8.8:80");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.get(".proxy-error").text()).toMatch(/公网|public/);
    expect(tab.close).toHaveBeenCalled();
    expect(proxy.list).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("popup-blocked: shows the one-time link, and drops it when the dialog unmounts", async () => {
    const proxy = fakeProxy();
    vi.stubGlobal("open", fakeWin(true).win.open);
    const w = mountDialog(proxy);
    await flushPromises();
    await w.get("#proxy-target").setValue("127.0.0.1:23434");
    await w.get("form").trigger("submit");
    await flushPromises();
    const a = w.get(".proxy-blocked a");
    expect(a.attributes("href")).toBe(ENTER);
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toContain("noopener");
    w.unmount();
  });

  it("item 打开 re-opens by host:port; IPv6 hosts are bracketed", async () => {
    const proxy = fakeProxy({
      list: vi.fn(async () => ({
        ...LIST_OK,
        items: [{ ...LIST_OK.items[0]!, target: { host: "::1", port: 3000, cls: "loopback" } }],
      })) as never,
    });
    vi.stubGlobal("open", fakeWin().win.open);
    const w = mountDialog(proxy);
    await flushPromises();
    await w.findAll(".proxy-item-actions button")[0]!.trigger("click");
    await flushPromises();
    expect(proxy.open).toHaveBeenCalledWith({ target: "[::1]:3000" }, undefined);
    w.unmount();
  });

  it("item 停止 calls stop with the instance id and refreshes; 404 is not an error", async () => {
    const proxy = fakeProxy();
    const w = mountDialog(proxy);
    await flushPromises();
    await w.findAll(".proxy-item-actions button")[1]!.trigger("click");
    await flushPromises();
    expect(proxy.stop).toHaveBeenCalledWith("inst_12345678");
    expect(proxy.list).toHaveBeenCalledTimes(2);
    (proxy.stop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 404, error: "E_NOT_FOUND" });
    await w.findAll(".proxy-item-actions button")[1]!.trigger("click");
    await flushPromises();
    expect(w.find(".proxy-error").exists()).toBe(false);
    (proxy.stop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 0, error: "E_NETWORK" });
    await w.findAll(".proxy-item-actions button")[1]!.trigger("click");
    await flushPromises();
    expect(w.find(".proxy-error").exists()).toBe(true);
    w.unmount();
  });

  it("never polls: advancing time issues no further list requests", async () => {
    vi.useFakeTimers();
    const proxy = fakeProxy();
    const w = mountDialog(proxy);
    await flushPromises();
    const n = (proxy.list as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((proxy.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
    w.unmount();
  });

  it("Escape closes (emits close) and stops propagation", async () => {
    const w = mountDialog(fakeProxy());
    await flushPromises();
    await w.get(".proxy-scrim").trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeTruthy();
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// link-preview plan (LP3): §4.1 compatibility tiers + §4.2 normalized POST targets
// ---------------------------------------------------------------------------
const CAPS_FRAME = ["proxy.v1", "proxy.frame.v1"];

/** A real LP3 handle (frame scope derived from the caps) on top of the fake transport. */
function frameHandle(caps: string[], proxy: ProxyTransport) {
  const state = ref({ hub: { caps }, agents: new Map(), selected: "a1", conn: "open" });
  return useProxyPreview({ proxy, state, mode: "token" });
}

function provideFrame(caps: string[], proxy: ProxyTransport, handle: ReturnType<typeof useProxyPreview> | null) {
  const base = provideOf(hubOf(caps, proxy));
  return handle === null ? base : { ...base, [PROXY_PREVIEW_CTX as symbol]: { handle } };
}

describe("LP3 §4.1 tiers — PathText", () => {
  it("tier 2 (proxy cap, NO proxy.frame.v1): click keeps the new-tab flow with the normalized target", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const handle = frameHandle(["proxy.v1"], proxy); // real handle, but its frame scope is null
    expect(handle.scope.value).toBeNull();
    const w = mount(PathText, {
      props: { text: "open 127.0.0.1:3000/ui?tab=a now" },
      global: { provide: provideFrame(["proxy.v1"], proxy, handle) },
    });
    await w.get("span.proxy-ref").trigger("click");
    await flushPromises();
    expect(handle.view.value.phase).toBe("closed"); // no dialog without the frame cap
    expect(win.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(proxy.open).toHaveBeenCalledWith({ target: "http://127.0.0.1:3000/ui?tab=a" }, undefined);
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER); // enter URL used unmodified
    w.unmount();
  });

  it("tier 3 (proxy.frame.v1): a plain click / Enter opens the dialog, POSTing path+query verbatim; no window.open", async () => {
    const proxy = fakeProxy();
    const { win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const handle = frameHandle(CAPS_FRAME, proxy);
    expect(handle.scope.value).not.toBeNull();
    const w = mount(PathText, {
      props: { text: "open 127.0.0.1:3000/ui?tab=a now" },
      global: { provide: provideFrame(CAPS_FRAME, proxy, handle) },
    });
    // dispatch synchronously (trigger() awaits a tick, by which time the fake transport has
    // already resolved to `ready`).
    w.get("span.proxy-ref").element.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0 }),
    );
    expect(handle.view.value).toMatchObject({ phase: "opening", href: "http://127.0.0.1:3000/ui?tab=a" });
    expect(proxy.open).toHaveBeenCalledTimes(1);
    expect(proxy.open.mock.calls[0]![0]).toEqual({ target: "http://127.0.0.1:3000/ui?tab=a" });
    expect(win.open).not.toHaveBeenCalled(); // the dialog path never opens a tab
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "ready", enterUrl: ENTER });
    w.unmount();
  });

  it("tier 3 Enter/Space also open the dialog; Ctrl/Meta-click keeps the new-tab flow (D8)", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const handle = frameHandle(CAPS_FRAME, proxy);
    const w = mount(PathText, {
      props: { text: "see http://127.0.0.1:3000/x" },
      global: { provide: provideFrame(CAPS_FRAME, proxy, handle) },
    });
    w.get("span.proxy-ref").element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true }),
    );
    expect(handle.view.value.phase).toBe("opening");
    await flushPromises();
    expect(handle.view.value.phase).toBe("ready");
    handle.close();

    // Ctrl-click ⇒ the X2 new-tab flow, same normalized target.
    w.get("span.proxy-ref").element.dispatchEvent(
      new MouseEvent("click", { cancelable: true, bubbles: true, button: 0, ctrlKey: true }),
    );
    await flushPromises();
    expect(win.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(proxy.open).toHaveBeenCalledTimes(2);
    expect(proxy.open.mock.calls[1]![0]).toEqual({ target: "http://127.0.0.1:3000/x" });
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    expect(handle.view.value.phase).toBe("closed");
    w.unmount();
  });

  it("tier 3 wiring absent (no PROXY_PREVIEW_CTX): the frame cap alone stays on the new-tab flow", async () => {
    const proxy = fakeProxy();
    const { win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(PathText, {
      props: { text: "see http://127.0.0.1:3000/x" },
      global: { provide: provideOf(hubOf(CAPS_FRAME, proxy)) }, // §4.3: absent ctx ⇒ new tab
    });
    await w.get("span.proxy-ref").trigger("click");
    await flushPromises();
    expect(win.open).toHaveBeenCalled();
    expect(proxy.open).toHaveBeenCalledWith({ target: "http://127.0.0.1:3000/x" }, undefined);
    w.unmount();
  });

  it("inline code POSTs the normalized target in every flow: `127.0.0.1:3000/ui` and `http://127.0.0.1/`", async () => {
    // new-tab / legacy flow (tier 2): the §4.2 fix — the raw text used to be POSTed as-is.
    const proxy = fakeProxy();
    const { win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(PathText, {
      props: { text: "127.0.0.1:3000/ui", code: true },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    await w.get("code.md-code.proxy-ref").trigger("click");
    await flushPromises();
    expect(proxy.open).toHaveBeenCalledWith({ target: "http://127.0.0.1:3000/ui" }, undefined);
    w.unmount();

    const w2 = mount(PathText, {
      props: { text: "http://127.0.0.1/", code: true },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    await w2.get("code.md-code.proxy-ref").trigger("click");
    await flushPromises();
    expect(proxy.open).toHaveBeenLastCalledWith({ target: "http://127.0.0.1:80/" }, undefined);
    w2.unmount();

    // dialog flow (tier 3): same normalization into handle.open.
    const proxy3 = fakeProxy();
    const handle = frameHandle(CAPS_FRAME, proxy3);
    const w3 = mount(PathText, {
      props: { text: "127.0.0.1:3000/ui", code: true },
      global: { provide: provideFrame(CAPS_FRAME, proxy3, handle) },
    });
    await w3.get("code.md-code.proxy-ref").trigger("click");
    expect(proxy3.open.mock.calls[0]![0]).toEqual({ target: "http://127.0.0.1:3000/ui" });
    await flushPromises();
    expect(handle.view.value.phase).toBe("ready");
    w3.unmount();
  });
});

describe("LP3 §4.1 tiers — MdInline", () => {
  const nodes = [{ type: "link", href: "http://127.0.0.1:3000/x", children: [{ type: "text", text: "demo" }] }];

  it("tier 2: plain click POSTs the normalized href through the new-tab flow", async () => {
    const proxy = fakeProxy();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(MdInline, {
      props: { nodes: nodes as never },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    expect(clickPrevented(w.get("a").element)).toBe(true);
    await flushPromises();
    expect(proxy.open).toHaveBeenCalledWith({ target: "http://127.0.0.1:3000/x" }, undefined);
    expect(tab.location.replace).toHaveBeenCalledWith(ENTER);
    w.unmount();
  });

  it("tier 3: a plain click opens the dialog; modified clicks stay native", async () => {
    const proxy = fakeProxy();
    const { win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const handle = frameHandle(CAPS_FRAME, proxy);
    const w = mount(MdInline, {
      props: { nodes: nodes as never },
      global: { provide: provideFrame(CAPS_FRAME, proxy, handle) },
    });
    const a = w.get("a");
    expect(a.attributes("href")).toBe("http://127.0.0.1:3000/x"); // the attribute stays original
    expect(clickPrevented(a.element, { ctrlKey: true })).toBe(false); // native modified click
    expect(proxy.open).not.toHaveBeenCalled();

    expect(clickPrevented(a.element)).toBe(true);
    expect(proxy.open.mock.calls[0]![0]).toEqual({ target: "http://127.0.0.1:3000/x" });
    expect(win.open).not.toHaveBeenCalled();
    await flushPromises();
    expect(handle.view.value).toMatchObject({ phase: "ready", href: "http://127.0.0.1:3000/x", enterUrl: ENTER });
    w.unmount();
  });
});

describe("LP3 D9 — inline refusal notes carry the original-link anchor", () => {
  const refusal = () =>
    fakeProxy({
      open: vi.fn(async () => ({ ok: false, status: 403, error: "E_PROXY_DENIED", reason: "public" })) as never,
    });

  it("PathText plain text: a hub refusal note anchors the normalized href (exact target/rel, no auto-navigation)", async () => {
    const proxy = refusal();
    const { tab, win } = fakeWin();
    vi.stubGlobal("open", win.open);
    const w = mount(PathText, {
      props: { text: "see 127.0.0.1:3000/ui now" },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    await w.get("span.proxy-ref").trigger("click");
    await flushPromises();
    const a = w.get(".proxy-ref-note a");
    expect(a.attributes("href")).toBe("http://127.0.0.1:3000/ui");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toBe("noopener noreferrer");
    expect(tab.location.replace).not.toHaveBeenCalled(); // never an automatic navigation
    w.unmount();
  });

  it("PathText inline code: the refusal note anchors the NORMALIZED href (`127.0.0.1:3000/ui` ⇒ `http://127.0.0.1:3000/ui`)", async () => {
    const proxy = refusal();
    vi.stubGlobal("open", fakeWin().win.open);
    const w = mount(PathText, {
      props: { text: "127.0.0.1:3000/ui", code: true },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    await w.get("code.md-code.proxy-ref").trigger("click");
    await flushPromises();
    const a = w.get(".proxy-ref-note a");
    expect(a.attributes("href")).toBe("http://127.0.0.1:3000/ui");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toBe("noopener noreferrer");
    w.unmount();
  });

  it("MdInline: the refusal note anchors the link's normalized href; the blocked-popup branch is unchanged", async () => {
    const nodes = [{ type: "link", href: "http://127.0.0.1:3000/x", children: [{ type: "text", text: "demo" }] }];
    const proxy = refusal();
    vi.stubGlobal("open", fakeWin().win.open);
    const w = mount(MdInline, {
      props: { nodes: nodes as never },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy)) },
    });
    expect(clickPrevented(w.get("a").element)).toBe(true);
    await flushPromises();
    const a = w.get(".proxy-ref-note a");
    expect(a.attributes("href")).toBe("http://127.0.0.1:3000/x");
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toBe("noopener noreferrer");
    w.unmount();

    // blocked-popup branch (url !== null): still the one-time enter URL, no D9 anchor swap.
    const proxy2 = fakeProxy();
    vi.stubGlobal("open", fakeWin(true).win.open);
    const w2 = mount(MdInline, {
      props: { nodes: nodes as never },
      global: { provide: provideOf(hubOf(["proxy.v1"], proxy2)) },
    });
    expect(clickPrevented(w2.get("a").element)).toBe(true);
    await flushPromises();
    const note = w2.get(".proxy-ref-note");
    expect(note.findAll("a")).toHaveLength(1);
    expect(note.get("a").attributes("href")).toBe(ENTER);
    w2.unmount();
  });
});
