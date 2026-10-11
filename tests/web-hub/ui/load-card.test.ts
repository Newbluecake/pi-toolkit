// @vitest-environment happy-dom
/**
 * `LoadCard.vue` (sysload plan docs/dev/sysload/plan.md §7.4 — the host-load popover). Covers:
 * section rendering off the actual frozen `LoadWire` shape (no PSI-mem/Swap — honest deviation
 * from the pre-freeze mockup, see the component's own header), the disk row's GiB free-space
 * annex (mockup tweak ②), skipped-disk "—" rendering, the footer's threshold-source disclosure
 * (never "派发已暂停" — §7.2), `fetchLoadTop()` firing on mount + its three states (loading /
 * data / error-keeps-stale-data), and top-process row expand/collapse to per-pid breakdown.
 */
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoadCard from "../../../src/web-hub/ui/src/components/load/LoadCard.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { LoadWire } from "../../../src/web-hub/protocol/messages.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  resetLangForTests();
  localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});
function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}

function load(over: Partial<LoadWire> = {}): LoadWire {
  return {
    v: 1,
    at: 1_000,
    intervalMs: 5_000,
    scope: "host",
    level: "crit",
    thresholds: {
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
    },
    ...over,
  };
}

function hubWithLoadTop(loadTop: HubState["loadTop"], fetchLoadTop = vi.fn()): HubHandle {
  return {
    state: ref({
      agents: new Map(),
      order: [],
      conn: "open",
      clientId: null,
      hub: null,
      selected: null,
      loadTop,
    }) as unknown as HubState,
    fetchLoadTop,
  } as unknown as HubHandle;
}

function mountCard(l: LoadWire, hub?: HubHandle) {
  return m(
    mount(LoadCard, {
      props: { load: l, receivedAt: Date.now(), now: Date.now(), anchorEl: null },
      global: hub ? { provide: { [HUB_CTX as symbol]: hub } } : {},
    }),
  );
}

describe("LoadCard.vue — sections off the frozen LoadWire shape", () => {
  it("CPU & PSI section: busy + PSI cpu + PSI io (display-only), no PSI-mem row", () => {
    const l = load({ cpu: { busyPct: 90, psiPct: 61, level: "crit", cores: 8 }, io: { psiPct: 22 } });
    const wrapper = mountCard(l);
    const text = wrapper.text();
    expect(text).toContain("CPU busy");
    expect(text).toContain("PSI cpu");
    expect(text).toContain("PSI io");
    expect(text).not.toContain("PSI mem");
    expect(wrapper.text()).not.toContain("Swap");
  });

  it("omits the CPU/PSI section entirely when neither cpu nor io is present", () => {
    const wrapper = mountCard(load({ cpu: undefined, io: undefined }));
    expect(wrapper.text()).not.toContain("CPU busy");
  });

  it("MEM section: usedPct + available annex, no absolute GiB (wire carries no byte totals)", () => {
    const l = load({ mem: { usedPct: 94, availPct: 6, level: "crit" } });
    const wrapper = mountCard(l);
    expect(wrapper.text()).toContain("MEM used");
    expect(wrapper.text()).toContain("94%");
    expect(wrapper.text()).toMatch(/6%/);
  });

  it("Loadavg section renders 1/5/15 + cores when present", () => {
    const l = load({ loadavg: [14.2, 11.8, 9.1], cpu: { busyPct: 90, level: "crit", cores: 8 } });
    const wrapper = mountCard(l);
    expect(wrapper.text()).toContain("14.2");
    expect(wrapper.text()).toContain("11.8");
    expect(wrapper.text()).toContain("9.1");
    expect(wrapper.text()).toMatch(/8/);
  });

  it("the footer discloses the threshold SOURCE, never dispatch-pause copy (§7.2: hub carries no gate concept)", () => {
    const wrapper = mountCard(load());
    const foot = wrapper.get(".ld-foot").text();
    expect(foot.length).toBeGreaterThan(0);
    expect(wrapper.text()).not.toContain("派发已暂停");
    expect(wrapper.text().toLowerCase()).not.toContain("dispatch paused");
  });

  // User report: the old footer copy ("阈值取自 hub 启动配置" / "Thresholds from the hub's startup
  // config") was too cryptic — it never said WHAT the thresholds are for or how to change them.
  it("the footer explains what the thresholds are for and how to change them", () => {
    const wrapper = mountCard(load());
    const foot = wrapper.get(".ld-foot").text();
    expect(foot).toContain("load.*");
    expect(foot.toLowerCase()).toContain("/webhub restart");
  });
});

describe("LoadCard.vue — disk rows (mockup tweak ②: free space in GiB)", () => {
  it("shows a usedPct bar plus a GiB free-space subline for a sampled mount", () => {
    const l = load({
      disks: [
        {
          label: "~",
          path: "/home/u",
          usedPct: 58,
          freeBytes: 112 * 2 ** 30,
          totalBytes: 200 * 2 ** 30,
          level: "warn",
        },
      ],
    });
    const wrapper = mountCard(l);
    expect(wrapper.get(".ld-mount-path").text()).toBe("$HOME");
    expect(wrapper.text()).toContain("58%");
    expect(wrapper.text()).toContain("112G");
  });

  it("a skipped (remote/unresolved) mount shows — instead of a fabricated percent", () => {
    const l = load({
      disks: [{ label: "/", path: "/", usedPct: 0, freeBytes: 0, totalBytes: 0, level: "unknown", skipped: "remote" }],
    });
    const wrapper = mountCard(l);
    expect(wrapper.get(".ld-val").text()).toBe("—");
    expect(wrapper.find(".ld-bar i").exists()).toBe(false);
  });

  it("omits the DISK section when there are no disks at all", () => {
    const wrapper = mountCard(load({ disks: [] }));
    expect(wrapper.text()).not.toContain("DISK");
  });
});

describe("LoadCard.vue — top processes (fetchLoadTop single-flight + three states)", () => {
  it("fires fetchLoadTop() once on mount when the hub provides it", () => {
    const fetchLoadTop = vi.fn();
    mountCard(load(), hubWithLoadTop(undefined, fetchLoadTop));
    expect(fetchLoadTop).toHaveBeenCalledTimes(1);
  });

  it("never throws without a HUB_CTX at all (degrades to the unavailable copy)", () => {
    const wrapper = mountCard(load());
    expect(wrapper.text()).toContain(wrapper.get(".ld-top-note").text());
  });

  it("loading state shows the loading copy", () => {
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: true }));
    expect(wrapper.get(".ld-top-note").exists()).toBe(true);
  });

  it("renders comm-aggregated rows for byCpu/byRss once data arrives", () => {
    const data = {
      at: 1,
      byCpu: [
        {
          comm: "node",
          count: 3,
          cpuPct: 312,
          rssBytes: 1,
          avg: undefined,
          pids: [{ pid: 1, cpuPct: 200, rssBytes: 1 }],
        },
      ],
      byRss: [
        {
          comm: "pi",
          count: 1,
          cpuPct: 1,
          rssBytes: 640 * 2 ** 20,
          pids: [{ pid: 2, cpuPct: 1, rssBytes: 640 * 2 ** 20 }],
        },
      ],
    };
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false, data } as HubState["loadTop"]));
    expect(wrapper.text()).toContain("node");
    expect(wrapper.text()).toContain("312%");
    expect(wrapper.text()).toContain("pi");
    expect(wrapper.text()).toContain("640M");
  });

  it("renders unavailable top units as n/a", () => {
    const data = { at: 1, byCpu: [{ comm: "node", count: 1, pids: [{ pid: 777 }] }], byRss: [] };
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false, data } as HubState["loadTop"]));
    expect(wrapper.text()).toContain("n/a");
  });

  it("expanding a row reveals its per-pid breakdown; collapsing hides it again", async () => {
    const data = {
      at: 1,
      byCpu: [{ comm: "node", count: 2, cpuPct: 100, rssBytes: 1, pids: [{ pid: 777, cpuPct: 60, rssBytes: 1 }] }],
      byRss: [],
    };
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false, data } as HubState["loadTop"]));
    expect(wrapper.find(".ld-proc-pids").exists()).toBe(false);
    await wrapper.get(".ld-proc-item").trigger("click");
    expect(wrapper.get(".ld-proc-pids").text()).toContain("777");
    await wrapper.get(".ld-proc-item").trigger("click");
    expect(wrapper.find(".ld-proc-pids").exists()).toBe(false);
  });

  it("an error with prior data keeps showing the stale rows, not a blank state", () => {
    const data = { at: 1, byCpu: [{ comm: "node", count: 1, cpuPct: 10, rssBytes: 1, pids: [] }], byRss: [] };
    const wrapper = mountCard(
      load(),
      hubWithLoadTop({ loading: false, data, error: "E_DEADLINE" } as HubState["loadTop"]),
    );
    expect(wrapper.text()).toContain("node");
  });

  it("an error with NO prior data shows the unavailable copy + a retry that re-fires fetchLoadTop", async () => {
    const fetchLoadTop = vi.fn();
    const wrapper = mountCard(
      load(),
      hubWithLoadTop({ loading: false, error: "E_NETWORK" } as HubState["loadTop"], fetchLoadTop),
    );
    expect(fetchLoadTop).toHaveBeenCalledTimes(1); // the mount-time fire
    await wrapper.get(".ld-top-retry").trigger("click");
    expect(fetchLoadTop).toHaveBeenCalledTimes(2);
  });

  // Bug fix (user report): the "unavailable" note's `v-else-if` used to fire alongside the
  // loading note too (`!topError` is true while loading AND no data exist yet), so a card that
  // was simply still waiting on its first `GET /api/load/top` round-trip showed BOTH
  // "正在加载 top 进程…" and "top 快照不可用" at once. `topUnavailable` must only ever render once
  // loading has actually settled with nothing to show.
  it("loading-only: shows the loading copy and NEVER the unavailable copy at the same time", () => {
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: true }));
    expect(wrapper.text()).toContain("Loading top processes");
    expect(wrapper.text()).not.toContain("Top-process snapshot unavailable");
  });

  it("data: shows neither the loading nor the unavailable copy", () => {
    const data = { at: 1, byCpu: [{ comm: "node", count: 1, cpuPct: 10, rssBytes: 1, pids: [] }], byRss: [] };
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false, data } as HubState["loadTop"]));
    expect(wrapper.text()).not.toContain("Loading top processes");
    expect(wrapper.text()).not.toContain("Top-process snapshot unavailable");
  });

  it("error (no prior data): shows the unavailable copy, never the loading copy", () => {
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false, error: "E_NETWORK" } as HubState["loadTop"]));
    expect(wrapper.text()).toContain("Top-process snapshot unavailable");
    expect(wrapper.text()).not.toContain("Loading top processes");
  });

  it("empty (not loading, no data, no error): shows ONLY the unavailable copy", () => {
    const wrapper = mountCard(load(), hubWithLoadTop({ loading: false } as HubState["loadTop"]));
    expect(wrapper.text()).toContain("Top-process snapshot unavailable");
    expect(wrapper.text()).not.toContain("Loading top processes");
  });
});

describe("LoadCard.vue — zh labels (2026-10 user ruling)", () => {
  it('sectionLoadavg: "Loadavg" → "平均负载"', () => {
    setLangOverride("zh");
    const wrapper = mountCard(load({ loadavg: [1.2, 1.1, 0.9] }));
    expect(wrapper.text()).toContain("平均负载");
    expect(wrapper.text()).not.toContain("Loadavg");
  });

  it('memUsed: "MEM used" → "内存占用"', () => {
    setLangOverride("zh");
    const wrapper = mountCard(load({ mem: { usedPct: 81, availPct: 19, level: "ok" } }));
    expect(wrapper.text()).toContain("内存占用");
    expect(wrapper.text()).not.toContain("MEM used");
  });

  it('cpuBusy: "CPU busy" → "CPU 占用" (PSI labels and "CPU & PSI" stay as-is)', () => {
    setLangOverride("zh");
    const wrapper = mountCard(load({ cpu: { busyPct: 72, psiPct: 10, level: "ok", cores: 8 }, io: { psiPct: 5 } }));
    expect(wrapper.text()).toContain("CPU 占用");
    expect(wrapper.text()).not.toContain("CPU busy");
    expect(wrapper.text()).toContain("CPU & PSI");
    expect(wrapper.text()).toContain("PSI cpu");
    expect(wrapper.text()).toContain("PSI io");
  });

  it("en stays unchanged (sectionLoadavg/memUsed/cpuBusy keep their English copy)", () => {
    const wrapper = mountCard(
      load({
        loadavg: [1.2, 1.1, 0.9],
        mem: { usedPct: 81, availPct: 19, level: "ok" },
        cpu: { busyPct: 72, level: "ok", cores: 8 },
      }),
    );
    expect(wrapper.text()).toContain("Loadavg");
    expect(wrapper.text()).toContain("MEM used");
    expect(wrapper.text()).toContain("CPU busy");
  });
});
