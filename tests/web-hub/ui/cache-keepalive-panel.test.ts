// @vitest-environment happy-dom
/**
 * `CacheKeepalivePanel.vue` (cache-keepalive-web plan §4.3, P-B). Driven by handwritten
 * fixtures typed against the frozen P0 wire (`@protocol/messages.js`, commit 95f7a6f) — the
 * agent side (P-A) is a parallel package and is NOT a dependency here. Covers: collapsed
 * marker text (English tokens in BOTH locales) + fold/unfold with aria; the full expanded kv
 * (mode + note, enabled, last ping with kind/http/transient/permanent/attempts/age, window,
 * session totals, disabled reason) and the breaker list (label, `http N`, `trips N`,
 * `retry in Xm` / `eligible now`, current/legacy/history chips, omitted tail, empty state);
 * the browser-clock ticker discipline (30s ticker ONLY while a future retryAt exists — even
 * folded — or the panel is expanded with a lastPing age; neither ⇒ zero timers; unmount
 * disposes); the lastPing age advancing with the fake clock (never frozen off `wire.at`);
 * `<script>` payloads rendering as inert text; and the read-only rulings (aria-readonly, no
 * reset button, no armed display — D5/D11).
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CacheKeepalivePanel from "../../../src/web-hub/ui/src/components/detail/CacheKeepalivePanel.vue";
import type { CacheKeepaliveWire } from "../../../src/web-hub/protocol/messages.js";

const NOW = 1_700_000_000_000;

const wire = (over: Record<string, unknown> = {}): CacheKeepaliveWire =>
  ({
    v: 1,
    at: NOW,
    mode: "on",
    dirty: true,
    enabled: true,
    modeText: "cache 1h*",
    ping: { text: "ping 3/11 Σ12 · 450k · ≈$0.12", state: "active" },
    window: { pings: 3, max: 11 },
    session: {
      pings: 12,
      cacheReadTokens: 450_000,
      costUsd: 0.12,
      avoidedMissTokens: 1_234,
      loadBearingWindows: 2,
      unnecessaryWindows: 1,
      discardedWindows: 0,
    },
    lastPing: { at: NOW - 5 * 60_000, kind: "proven-hit" },
    lines: [],
    ...over,
  }) as unknown as CacheKeepaliveWire;

const mountPanel = (w: CacheKeepaliveWire) => mount(CacheKeepalivePanel, { props: { keepalive: w } });
const openPanel = async (w: CacheKeepaliveWire) => {
  const wrapper = mountPanel(w);
  await wrapper.find(".ck-sum").trigger("click");
  return wrapper;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("CacheKeepalivePanel.vue — collapsed marker (§4.2)", () => {
  it("renders the TUI-parallel marker, starts collapsed, aria-readonly", () => {
    const wrapper = mountPanel(wire());
    expect(wrapper.find(".ck-sum-text").text()).toBe("cache 1h* · ping 3/11 Σ12 · 450k · ≈$0.12");
    expect(wrapper.find(".ck-sum").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".ck-body").exists()).toBe(false);
    expect(wrapper.find(".ck-panel").attributes("aria-readonly")).toBe("true");
    // D5/D11: read-only surface — no reset button, no armed display anywhere
    expect(wrapper.findAll("button")).toHaveLength(1); // the fold toggle only
  });

  it("line-off marker carries the locally-computed `·retry Xm ·tN` suffixes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = mountPanel(
      wire({
        ping: { text: "ping off:http 403", state: "line-off", retryAt: NOW + 25 * 60_000, tail: "·t3" },
      }),
    );
    expect(wrapper.find(".ck-sum-text").text()).toBe("cache 1h* · ping off:http 403 ·retry 25m ·t3");
    wrapper.unmount();
  });

  it("marker tone maps to data-tone (bad/warn/neutral from ping.state)", () => {
    expect(
      mountPanel(wire({ ping: { text: "x", state: "line-off" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("bad");
    expect(
      mountPanel(wire({ ping: { text: "x", state: "disabled" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("bad");
    expect(
      mountPanel(wire({ ping: { text: "x", state: "paused" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("warn");
    expect(
      mountPanel(wire({ ping: { text: "x", state: "capped" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("warn");
    expect(
      mountPanel(wire({ ping: { text: "x", state: "active" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("neutral");
    expect(
      mountPanel(wire({ ping: { text: "x", state: "????" } }))
        .find(".ck-panel")
        .attributes("data-tone"),
    ).toBe("neutral");
  });

  it("enabled:false appends `keepalive off` (D6)", () => {
    const wrapper = mountPanel(wire({ enabled: false, ping: undefined }));
    expect(wrapper.find(".ck-sum-text").text()).toBe("cache 1h* · keepalive off");
  });

  it("fold/unfold via the summary button (aria-expanded flips, prose aria-label)", async () => {
    const wrapper = await openPanel(wire());
    expect(wrapper.find(".ck-sum").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".ck-body").exists()).toBe(true);
    expect(wrapper.find(".ck-sum").attributes("aria-label")).toContain("Prompt-cache keepalive:");
    await wrapper.find(".ck-sum").trigger("click");
    expect(wrapper.find(".ck-body").exists()).toBe(false);
  });
});

describe("CacheKeepalivePanel.vue — expanded kv (§4.2 items 1–6)", () => {
  it("mode row: token + explanation; enabled row", async () => {
    const wrapper = await openPanel(wire());
    const kv = wrapper.find(".ck-kv");
    expect(kv.text()).toContain("on*");
    expect(kv.text()).toContain("Follows pi/provider default");
    expect(kv.text()).toContain("enabled");
    expect(wrapper.find(".ck-kv").find("dt").text()).toBe("Mode"); // first row label
  });

  it("lastPing row: kind, http status, transient/permanent tag, attempts, `{age} ago` (browser clock)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await openPanel(
      wire({ lastPing: { at: NOW - 5 * 60_000, kind: "http", status: 403, transient: true, attempts: 4 } }),
    );
    const kv = wrapper.find(".ck-kv").text();
    expect(kv).toContain("http");
    expect(kv).toContain("403");
    expect(kv).toContain("transient");
    expect(kv).toContain("attempts 4");
    expect(kv).toContain("5m ago");
    wrapper.unmount();
  });

  it("lastPing proven-hit carries no transient/permanent tag; no attempts when absent", async () => {
    const wrapper = await openPanel(wire());
    const kv = wrapper.find(".ck-kv").text();
    expect(kv).toContain("proven-hit");
    expect(kv).not.toContain("transient");
    expect(kv).not.toContain("permanent");
    expect(kv).not.toContain("attempts");
  });

  it("line-scoped lastPing (proven-write / no-usage) shows the per-line tag, never `permanent` (2026-10-20)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const kind of ["proven-write", "no-usage"]) {
      const w = await openPanel(wire({ lastPing: { at: NOW - 60_000, kind, transient: false, line: true } }));
      const kv = w.find(".ck-kv").text();
      expect(kv).toContain(kind);
      expect(kv).toContain("per-line");
      expect(kv).not.toContain("permanent");
      expect(w.find('.ck-chip[data-kind="line"]').exists()).toBe(true);
      expect(w.find('.ck-chip[data-kind="permanent"]').exists()).toBe(false);
      w.unmount();
    }
  });

  it("permanent tag shows when transient === false; lastPing absent ⇒ placeholder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const permanent = await openPanel(wire({ lastPing: { at: NOW - 60_000, kind: "malformed", transient: false } }));
    expect(permanent.find(".ck-kv").text()).toContain("permanent");
    permanent.unmount();

    const none = await openPanel(wire({ lastPing: undefined }));
    expect(none.find(".ck-kv").text()).toContain("no ping yet");
  });

  it("window + session totals render as tokens (3/11, 12 ping, 450k, ≈$0.12, avoided/load-bearing/unnecessary/discarded)", async () => {
    const wrapper = await openPanel(wire());
    const kv = wrapper.find(".ck-kv").text();
    expect(kv).toContain("3/11");
    expect(kv).toContain("12 ping");
    expect(kv).toContain("450k");
    expect(kv).toContain("≈$0.12");
    expect(kv).toContain("1k tok");
    expect(kv).toContain("2");
    expect(kv).toContain("1");
    expect(kv).toContain("0");
  });

  it("disabled block: reason, http status, permanent/transient tag, since-age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await openPanel(
      wire({ disabled: { reason: "http", at: NOW - 30 * 60_000, httpStatus: 403, transient: true } }),
    );
    const kv = wrapper.find(".ck-kv").text();
    expect(kv).toContain("http");
    expect(kv).toContain("403");
    expect(kv).toContain("transient");
    expect(kv).toContain("30m");
    wrapper.unmount();
  });
});

describe("CacheKeepalivePanel.vue — breaker list (§4.2 item 7)", () => {
  const lines = [
    {
      label: "cr-anthropic/claude-opus-5-5@api.example.com",
      open: true,
      status: 403,
      trips: 3,
      retryAt: NOW + 25 * 60_000,
      current: true,
    },
    { label: "* legacy wildcard", open: false, trips: 1, wildcard: true },
    { label: "kimi/k2@relay.example.com", open: true, status: 429, trips: 1 },
  ];

  it("renders label, http N, trips N, retry-in, eligible-now, chips; history rows dimmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await openPanel(wire({ lines }));
    const rows = wrapper.findAll(".ck-line");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.find(".ck-line-label").text()).toBe("cr-anthropic/claude-opus-5-5@api.example.com");
    expect(rows[0]?.find(".ck-line-label").attributes("title")).toBe("cr-anthropic/claude-opus-5-5@api.example.com");
    expect(rows[0]?.text()).toContain("http 403");
    expect(rows[0]?.text()).toContain("trips 3");
    expect(rows[0]?.text()).toContain("retry in 25m");
    expect(rows[0]?.text()).toContain("current");
    expect(rows[0]?.attributes("data-open")).toBe("true");
    // no retryAt on the third row ⇒ open + elapsed semantics ⇒ `eligible now`
    expect(rows[2]?.text()).toContain("eligible now");
    expect(rows[1]?.attributes("data-open")).toBe("false"); // history row
    expect(rows[1]?.text()).toContain("legacy");
    expect(rows[1]?.text()).toContain("history");
    wrapper.unmount();
  });

  it("open row whose retryAt elapsed shows `eligible now` (browser clock, not wire.at)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 26 * 60_000);
    const wrapper = await openPanel(wire({ lines }));
    expect(wrapper.findAll(".ck-line")[0]?.text()).toContain("eligible now");
    wrapper.unmount();
  });

  it("omitted tail `(+N more)`; zero rows ⇒ the empty-state line, no list", async () => {
    const more = await openPanel(wire({ lines, omitted: 5 }));
    expect(more.find(".ck-more").text()).toBe("(+5 more)");

    const empty = await openPanel(wire());
    expect(empty.find(".ck-lines-list").exists()).toBe(false);
    expect(empty.find(".ck-lines-empty").text()).toBe("No line breakers recorded");
  });

  it("a `<script>` payload in a label renders as inert text (no element, no v-html)", async () => {
    const payload = "<script>alert(1)</script>";
    const wrapper = await openPanel(wire({ lines: [{ label: payload, open: false, trips: 1 }] }));
    const label = wrapper.find(".ck-line-label");
    expect(label.text()).toBe(payload);
    expect(wrapper.find("script").exists()).toBe(false);
    // the label's own innerHTML carries the payload only as ESCAPED text (the raw string may
    // still appear inside the `title` attribute binding, which is inert attribute data)
    expect(label.element.innerHTML).not.toContain("<script>");
    expect(wrapper.find(".ck-line-label script").exists()).toBe(false);
  });
});

describe("CacheKeepalivePanel.vue — ticker discipline (§4.2: 30s, only while needed)", () => {
  it("a future retryAt keeps a 30s ticker alive even while FOLDED (collapsed `·retry` counts down)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = mountPanel(
      wire({ ping: { text: "ping off:http 403", state: "line-off", retryAt: NOW + 25 * 60_000, tail: "·t3" } }),
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const marker = () => wrapper.find(".ck-sum-text").text();
    expect(marker()).toBe("cache 1h* · ping off:http 403 ·retry 25m ·t3");
    vi.advanceTimersByTime(30_000);
    await wrapper.vm.$nextTick();
    expect(marker()).toBe("cache 1h* · ping off:http 403 ·retry 25m ·t3"); // still 25m at minute granularity
    vi.advanceTimersByTime(5 * 60_000);
    await wrapper.vm.$nextTick();
    expect(marker()).toBe("cache 1h* · ping off:http 403 ·retry 20m ·t3");
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("line-row retryAt alone also arms the ticker; collapsing/expanding with no age stops it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rowOnly = mountPanel(
      wire({ ping: undefined, lines: [{ label: "a@h", open: true, trips: 1, retryAt: NOW + 60_000 }] }),
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    rowOnly.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // expanded + lastPing present ⇒ ticker (age display); collapsed again + no retryAt ⇒ stopped
    const withAge = await openPanel(wire()); // lastPing present, no retryAt anywhere
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await withAge.find(".ck-sum").trigger("click");
    expect(vi.getTimerCount()).toBe(0);
    withAge.unmount();
  });

  it("no future retryAt and no lastPing ⇒ zero timers, folded or expanded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const idle = mountPanel(wire({ ping: undefined, lastPing: undefined, lines: [] }));
    expect(vi.getTimerCount()).toBe(0);
    idle.unmount();
    const idleOpen = await openPanel(wire({ ping: undefined, lastPing: undefined, lines: [] }));
    expect(vi.getTimerCount()).toBe(0);
    idleOpen.unmount();
  });

  it("the lastPing age advances with the browser clock (never frozen off `wire.at`)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = await openPanel(wire({ lastPing: { at: NOW - 5 * 60_000, kind: "proven-hit" } }));
    const kv = () => wrapper.find(".ck-kv").text();
    expect(kv()).toContain("5m ago");
    vi.advanceTimersByTime(2 * 60_000);
    await wrapper.vm.$nextTick();
    expect(kv()).toContain("7m ago");
    wrapper.unmount();
  });

  it("unmount disposes the ticker (no leaked 30s timer)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const wrapper = mountPanel(wire({ ping: { text: "x", state: "line-off", retryAt: NOW + 60_000 } }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("dynamic cap ended window", () => {
  it("expanded row shows ended, not the previous 20/new 11 ratio", async () => {
    const wrapper = await openPanel(
      wire({
        window: { pings: 20, max: 11, maxSource: "fallback", ended: true },
        ping: { text: "ping Σ20 · 450k · ≈$0.12", state: "active" },
      }),
    );
    expect(wrapper.find(".ck-kv").text()).toContain("ended");
    expect(wrapper.text()).not.toContain("20/11");
    expect(wrapper.text()).not.toContain("capped");
    wrapper.unmount();
  });
  it("missing ended (old agent) preserves n/max; explicit false also preserves it", async () => {
    for (const window of [
      { pings: 3, max: 48 },
      { pings: 3, max: 48, ended: false },
    ]) {
      const wrapper = await openPanel(wire({ window }));
      expect(wrapper.find(".ck-kv").text()).toContain("3/48");
      expect(wrapper.find(".ck-kv").text()).not.toContain("ended");
      wrapper.unmount();
    }
  });
});

describe("dynamic cap source hints", () => {
  it.each([
    ["priced", "Prefix budget from model cache read/write prices"],
    ["clamped", "Price-derived prefix budget clamped to 96"],
    ["fallback", "Unpriced fallback 11; no profitability proof"],
  ])("%s has an English title without changing the ratio", async (maxSource, title) => {
    const wrapper = await openPanel(wire({ window: { pings: 3, max: 48, maxSource } }));
    const token = wrapper.findAll(".ck-kv .ck-token").find((t) => t.text() === "3/48");
    expect(token?.attributes("title")).toBe(title);
    wrapper.unmount();
  });
});
