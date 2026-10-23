// @vitest-environment happy-dom
/**
 * `PreviewHtml.vue` + the PreviewText html integration (web-hub-html-preview plan v2 §5,
 * package P2) — the T-U1/T-U2 rows of the §8 test plan:
 *
 * - T-U1 the iframe is bound to the protocol's `PV_SANDBOX` (no `allow-same-origin`),
 *   `referrerpolicy="no-referrer"`, the minted cap URL as `src`, and the new-tab anchor is a
 *   plain `rel="noopener noreferrer"` link to the `/pvw` wrapper;
 * - T-U1 TTL (§R1-8): idle expiry shows the 「可能需刷新」 hint + reload, hard expiry the
 *   banner + reload — and the iframe's element/src stay UNTOUCHED until 「重新加载」 re-mints;
 * - T-U1 a mint 403 surfaces as `mint-error` (the parent switches to source); no `window`
 *   `message` listener is ever registered;
 * - T-U2 cap present ⇒ PreviewText shows the render/source toggle (default rendered); cap
 *   absent ⇒ the pre-feature DOM (plain `<pre>`, no toggle).
 */

import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PV_SANDBOX } from "../../../src/web-hub/protocol/preview-html.js";
import PreviewHtml from "../../../src/web-hub/ui/src/components/preview/PreviewHtml.vue";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import { PREVIEW_CTX } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import {
  createPreviewHtmlLedger,
  PREVIEW_HTML_LEDGER,
} from "../../../src/web-hub/ui/src/components/preview/previewHtmlLedger.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";
import type { PreviewHtmlCapOutcome, PreviewTransport } from "../../../src/web-hub/ui/src/transport/types.js";

type HtmlCapImpl = (
  req: { agentKey: string; sessionId: string; path: string },
  opts: { signal: AbortSignal },
) => Promise<PreviewHtmlCapOutcome>;

const CAP_OK: PreviewHtmlCapOutcome = {
  ok: true,
  url: "/pv/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
  openUrl: "/pvw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  idleMs: 15 * 60_000,
  hardRemainingMs: 60 * 60_000,
};

interface MintCall {
  agentKey: string;
  sessionId: string;
  path: string;
}

function makeHub(impl: HtmlCapImpl): { hub: HubHandle; calls: MintCall[] } {
  const calls: MintCall[] = [];
  const preview = {
    htmlCap: (req: { agentKey: string; sessionId: string; path: string }, opts: { signal: AbortSignal }) => {
      calls.push({ agentKey: req.agentKey, sessionId: req.sessionId, path: req.path });
      return impl(req, opts);
    },
  } as unknown as PreviewTransport;
  const hub = {
    state: ref({ clientId: "c1", hub: { caps: ["preview.v1", "preview.html.v1"] }, conn: "open", selected: null }),
    preview,
    dispatch: () => {},
  } as unknown as HubHandle;
  return { hub, calls };
}

function mountHtml(impl: HtmlCapImpl) {
  const { hub, calls } = makeHub(impl);
  const wrapper = mount(PreviewHtml, {
    props: { agentKey: "A", sessionId: "s1", path: "/srv/site/index.html" },
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
  return { wrapper, calls };
}

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Wait for the lazy async component inside PreviewText to load + mount + mint. */
const settle = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await flush();
    await nextTick();
  }
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PreviewHtml.vue — sandboxed iframe (T-U1)", () => {
  it("mints on mount with the exact scope triple and binds src/sandbox/referrerpolicy to the answer", async () => {
    const { wrapper, calls } = mountHtml(async () => ({ ...CAP_OK }));
    await settle();
    expect(calls).toEqual([{ agentKey: "A", sessionId: "s1", path: "/srv/site/index.html" }]);
    const frame = wrapper.get("iframe.preview-html-frame");
    expect(frame.attributes("sandbox")).toBe(PV_SANDBOX);
    expect(PV_SANDBOX).not.toContain("allow-same-origin");
    expect(frame.attributes("referrerpolicy")).toBe("no-referrer");
    expect(frame.attributes("src")).toBe(CAP_OK.url);
    expect(frame.attributes("credentialless")).toBeDefined();
    expect(frame.attributes("allow")).toBe("");
    expect(frame.attributes("title")).toBe("index.html");
    wrapper.unmount();
  });

  it("the new-tab action is a plain anchor to the /pvw wrapper with noopener noreferrer", async () => {
    const { wrapper } = mountHtml(async () => ({ ...CAP_OK }));
    await settle();
    const a = wrapper.get("a.preview-html-open");
    expect(a.attributes("href")).toBe(CAP_OK.openUrl);
    expect(a.attributes("target")).toBe("_blank");
    expect(a.attributes("rel")).toBe("noopener noreferrer");
    wrapper.unmount();
  });

  it("@load hides the spinner; >10 s without it shows the slow note (spinner stays)", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper } = mountHtml(async () => ({ ...CAP_OK }));
      await settle();
      expect(wrapper.find(".preview-html-loading").exists()).toBe(true);
      expect(wrapper.get(".preview-html-loading").text()).not.toContain("Still loading");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(wrapper.get(".preview-html-loading").text()).toContain("Still loading");
      await wrapper.get("iframe").trigger("load");
      expect(wrapper.find(".preview-html-loading").exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreviewHtml.vue — TTL UX (§R1-8: hint/banner only, never auto-unload)", () => {
  it("idle expiry: the hint + reload appear; hard expiry: the banner appears — iframe src UNCHANGED until reload", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const { wrapper, calls } = mountHtml(async () => {
        n++;
        return { ...CAP_OK, url: `${CAP_OK.url}?mint=${n}` };
      });
      await settle();
      const srcBefore = wrapper.get("iframe").attributes("src");
      expect(srcBefore).toBe(`${CAP_OK.url}?mint=1`);
      expect(wrapper.find(".preview-html-stale").exists()).toBe(false);
      expect(wrapper.find(".preview-html-expired").exists()).toBe(false);

      await vi.advanceTimersByTimeAsync(CAP_OK.idleMs + 1);
      expect(wrapper.get(".preview-html-stale").text()).toContain("may have expired");
      expect(wrapper.find(".preview-html-expired").exists()).toBe(false);
      expect(wrapper.get("iframe").attributes("src")).toBe(srcBefore);

      await vi.advanceTimersByTimeAsync(CAP_OK.hardRemainingMs - CAP_OK.idleMs + 1);
      expect(wrapper.find(".preview-html-expired").exists()).toBe(true);
      // the banner supersedes the idle hint line, and the running iframe is still untouched
      expect(wrapper.find(".preview-html-stale").exists()).toBe(false);
      expect(wrapper.get("iframe").attributes("src")).toBe(srcBefore);

      // 「重新加载」 re-mints; only THEN does the frame swap to the new cap's URL
      expect(calls).toHaveLength(1);
      await wrapper.get(".preview-html-expired button").trigger("click");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      const srcAfter = wrapper.get("iframe").attributes("src");
      expect(srcAfter).not.toBe(srcBefore);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the idle-hint reload button re-mints too (a maybe-stale cap is not presumed dead)", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, calls } = mountHtml(async () => ({ ...CAP_OK }));
      await settle();
      await vi.advanceTimersByTimeAsync(CAP_OK.idleMs + 1);
      expect(wrapper.find(".preview-html-bar button").exists()).toBe(true);
      await wrapper.get(".preview-html-bar button").trigger("click");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreviewHtml.vue — mint failures", () => {
  it("403 dir-too-broad ⇒ mint-error carries status/error/reason (the parent owns the source switch)", async () => {
    const { wrapper } = mountHtml(async () => ({
      ok: false,
      status: 403,
      error: "E_PREVIEW_DENIED",
      reason: "dir-too-broad",
    }));
    await settle();
    const emitted = wrapper.emitted<[{ status: number; error: string; reason?: string }]>();
    expect(emitted?.["mint-error"]?.[0]?.[0]).toEqual({
      status: 403,
      error: "E_PREVIEW_DENIED",
      reason: "dir-too-broad",
    });
    // standalone fallback view: one-line reason, NO retry (a 403 is not retryable)
    expect(wrapper.get(".preview-md-note").text()).toContain("E_PREVIEW_DENIED");
    expect(wrapper.find("button").exists()).toBe(false);
    wrapper.unmount();
  });

  it("429 ⇒ retry affordance; clicking it re-mints", async () => {
    let n = 0;
    const { wrapper, calls } = mountHtml(async () => {
      n++;
      return n === 1 ? { ok: false, status: 429, error: "E_RATE" } : { ...CAP_OK };
    });
    await settle();
    expect(calls).toHaveLength(1);
    await wrapper.get("button").trigger("click");
    await settle();
    expect(calls).toHaveLength(2);
    expect(wrapper.get("iframe").attributes("src")).toBe(CAP_OK.url);
    wrapper.unmount();
  });

  it("no transport method ⇒ the defensive E_UNSUPPORTED error, never an eternal spinner", async () => {
    const hub = { state: ref({}), dispatch: () => {} } as unknown as HubHandle;
    const wrapper = mount(PreviewHtml, {
      props: { agentKey: "A", sessionId: "s1", path: "/x/a.html" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    await settle();
    const emitted = wrapper.emitted<[{ status: number; error: string }]>();
    expect(emitted?.["mint-error"]?.[0]?.[0]?.error).toBe("E_UNSUPPORTED");
    wrapper.unmount();
  });
});

describe("PreviewHtml.vue — no postMessage surface", () => {
  it("never registers a window message listener (T-U1: what the page sends is never read)", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { wrapper } = mountHtml(async () => ({ ...CAP_OK }));
    await settle();
    const kinds = addSpy.mock.calls.map((c) => c[0]);
    expect(kinds).not.toContain("message");
    addSpy.mockRestore();
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------------
// PreviewText integration (T-U2): cap ⇒ toggle + default rendered; no cap ⇒ pre-feature DOM.
// ---------------------------------------------------------------------------

function makePreviewCtx(scope: PreviewPathScope | null) {
  const view = ref<PreviewView>({ phase: "closed" });
  const handle: PreviewHandle = {
    view,
    scope: ref(scope),
    open: () => {},
    close: () => {},
    retry: () => {},
    dispose: () => {},
  };
  return { handle, plaintext: false };
}

function mountText(p: { text: string; path: string }, scope: PreviewPathScope | null, hub: HubHandle | null) {
  return mount(PreviewText, {
    props: { text: p.text, truncated: false, path: p.path, filename: "index.html" },
    global: {
      provide: {
        ...(scope === null ? {} : { [PREVIEW_CTX as symbol]: makePreviewCtx(scope) }),
        ...(hub === null ? {} : { [HUB_CTX as symbol]: hub }),
      },
    },
  });
}

const HTML_SCOPE: PreviewPathScope = {
  agentKey: "A",
  sessionId: "s1",
  cwd: "/srv/site",
  uploads: true,
  html: true,
};

describe("PreviewText.vue — html render/source toggle (T-U2)", () => {
  it("cap present ⇒ toggle (htmlToggleLabel) + default RENDERED (PreviewHtml iframe via the lazy chunk)", async () => {
    const { hub } = makeHub(async () => ({ ...CAP_OK }));
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, HTML_SCOPE, hub);
    await settle(6);
    // the lazy async component resolved: the sandboxed frame is in the dialog
    expect(wrapper.find("iframe.preview-html-frame").exists()).toBe(true);
    expect(wrapper.find("pre.preview-text-body").exists()).toBe(false);
    const toggle = wrapper.get(".preview-toggle");
    expect(toggle.attributes("role")).toBe("group");
    expect(toggle.attributes("aria-label")).toBe("HTML view mode");
    // W3 (preview-windows §8.2): PreviewHtml's standing 「重新加载」 also carries
    // `.preview-toggle-btn` — scope the toggle-pair assertions to the toggle GROUP.
    const btns = wrapper.get(".preview-toggle").findAll(".preview-toggle-btn");
    expect(btns).toHaveLength(2);
    expect(btns[0]!.attributes("aria-pressed")).toBe("true");
    expect(btns[1]!.attributes("aria-pressed")).toBe("false");
    // source view = today's exact <pre> source
    await btns[1]!.trigger("click");
    await settle();
    expect(wrapper.find("pre.preview-text-body").exists()).toBe(true);
    expect(wrapper.find("iframe.preview-html-frame").exists()).toBe(false);
    wrapper.unmount();
  });

  it("no html cap on the scope ⇒ byte-identical pre-feature DOM (plain source, no toggle)", () => {
    const { hub } = makeHub(async () => ({ ...CAP_OK }));
    const scope: PreviewPathScope = { ...HTML_SCOPE };
    delete (scope as { html?: true }).html;
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, scope, hub);
    expect(wrapper.find(".preview-toggle").exists()).toBe(false);
    expect(wrapper.find(".preview-html").exists()).toBe(false);
    expect(wrapper.get("pre.preview-text-body").text()).toBe("<p>hi</p>");
    wrapper.unmount();
  });

  it("cap on the scope but transport without htmlCap ⇒ no toggle either (old-hub degradation)", () => {
    const hub = { state: ref({}), dispatch: () => {} } as unknown as HubHandle;
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, HTML_SCOPE, hub);
    expect(wrapper.find(".preview-toggle").exists()).toBe(false);
    expect(wrapper.get("pre.preview-text-body").exists()).toBe(true);
    wrapper.unmount();
  });

  it("mint 403 ⇒ falls back to source with the prose note; retry (or the toggle) re-mints", async () => {
    let n = 0;
    const { hub } = makeHub(async () => {
      n++;
      return n === 1 ? { ok: false, status: 403, error: "E_PREVIEW_DENIED", reason: "dir-too-broad" } : { ...CAP_OK };
    });
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, HTML_SCOPE, hub);
    await settle(6);
    // auto-switched to the source view + the prose note + a retry (403 ⇒ no retry button)
    expect(wrapper.find("pre.preview-text-body").exists()).toBe(true);
    const note = wrapper.get(".preview-md-note");
    expect(note.text()).toContain("source view only");
    expect(note.find("button").exists()).toBe(false);
    // flipping back to rendered clears the note and remounts PreviewHtml (a fresh mint)
    await wrapper.findAll(".preview-toggle-btn")[1]!.trigger("click"); // ensure source
    await wrapper.findAll(".preview-toggle-btn")[0]!.trigger("click"); // back to rendered
    await settle(6);
    expect(wrapper.find("iframe.preview-html-frame").exists()).toBe(true);
    expect(wrapper.find(".preview-md-note").exists()).toBe(false);
    wrapper.unmount();
  });

  it("a generic mint error (429) keeps the source view + one-line reason + a retry button", async () => {
    const { hub } = makeHub(async () => ({ ok: false, status: 429, error: "E_RATE" }));
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, HTML_SCOPE, hub);
    await settle(6);
    const note = wrapper.get(".preview-md-note");
    expect(note.text()).toContain("E_RATE");
    expect(note.find("button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("the standing sandbox note renders under the frame (§5 htmlNote)", async () => {
    const { hub } = makeHub(async () => ({ ...CAP_OK }));
    const wrapper = mountText({ text: "<p>hi</p>", path: "/srv/site/index.html" }, HTML_SCOPE, hub);
    await settle(6);
    expect(wrapper.get(".preview-html-note").text()).toContain("sandboxed");
    wrapper.unmount();
  });
});

describe("PreviewHtml.vue — eviction ledger + standing reload (preview-windows §8.2, W3)", () => {
  /** Mint impl answering a FRESH url per call (each mint is a new capability/token). */
  function uniqueUrlImpl(): { impl: HtmlCapImpl; urls: string[] } {
    const urls: string[] = [];
    let n = 0;
    const impl: HtmlCapImpl = async () => {
      n += 1;
      const cap = `${String(n).padStart(3, "0")}${"a".repeat(40)}`;
      const url = `/pv/${cap}/index.html`;
      urls.push(url);
      return { ...CAP_OK, url, openUrl: `/pvw/${cap}` };
    };
    return { impl, urls };
  }

  it("「重新加载」is STANDING in the toolbar (shown before any TTL hint, no ledger needed)", async () => {
    const { wrapper } = mountHtml(async () => ({ ...CAP_OK }));
    await settle();
    const bar = wrapper.get(".preview-html-bar");
    const reload = bar.get("button.preview-html-reload");
    expect(reload.text()).toContain("Reload");
    expect(bar.find('[role="status"]').exists()).toBe(false); // no idle hint yet either
    wrapper.unmount();
  });

  it("with the ledger: 8 later mints evict this cap ⇒ role=status notice; reload clears it", async () => {
    const ledger = createPreviewHtmlLedger();
    const { impl, urls } = uniqueUrlImpl();
    const { hub, calls } = makeHub(impl);
    const wrapper = mount(PreviewHtml, {
      props: { agentKey: "A", sessionId: "s1", path: "/srv/site/index.html" },
      global: { provide: { [HUB_CTX as symbol]: hub, [PREVIEW_HTML_LEDGER as symbol]: ledger } },
    });
    await settle();
    expect(ledger.liveCount()).toBe(1); // our own mint is recorded
    expect(wrapper.find(".preview-html-note[role='status']").exists()).toBe(false);
    // 8 later mints elsewhere in the same tab (other windows / reloads) displace ours.
    for (let i = 0; i < 8; i++) ledger.minted(`other-${i}`);
    await nextTick();
    const notice = wrapper.get("p.preview-html-note[role='status']");
    expect(notice.text()).toContain("8 per login");
    // 「重新加载」 re-mints a FRESH token ⇒ not evicted ⇒ the notice clears.
    await wrapper.get(".preview-html-bar button.preview-html-reload").trigger("click");
    await settle();
    expect(wrapper.find("p.preview-html-note[role='status']").exists()).toBe(false);
    expect(calls.length).toBe(2);
    expect(ledger.liveCount()).toBe(8); // the 8th slot was freed by evicting `other-0` for our fresh mint
    wrapper.unmount();
  });

  it("unmount records unmounted() — the slot keeps occupying the tab-local FIFO", async () => {
    const ledger = createPreviewHtmlLedger();
    const { impl } = uniqueUrlImpl();
    const { hub } = makeHub(impl);
    const wrapper = mount(PreviewHtml, {
      props: { agentKey: "A", sessionId: "s1", path: "/srv/site/index.html" },
      global: { provide: { [HUB_CTX as symbol]: hub, [PREVIEW_HTML_LEDGER as symbol]: ledger } },
    });
    await settle();
    expect(ledger.liveCount()).toBe(1);
    wrapper.unmount();
    expect(ledger.liveCount()).toBe(1); // unmounted ≠ freed — the hub does not know
  });

  it("NO injected ledger ⇒ byte-identical pre-W3 behavior: no notice, mints still fine", async () => {
    const { wrapper } = mountHtml(async () => ({ ...CAP_OK }));
    await settle();
    // nothing here observes other tabs' mints — the notice is structurally impossible
    expect(wrapper.find("p.preview-html-note[role='status']").exists()).toBe(false);
    expect(wrapper.get(".preview-html-bar button.preview-html-reload").exists()).toBe(true);
    wrapper.unmount();
  });
});
