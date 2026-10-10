// @vitest-environment happy-dom
/**
 * `LoadPill.vue` + `TopBar.vue`'s hosting of it (sysload plan docs/dev/sysload/plan.md §7.4 —
 * mirrors `quota-pill.test.ts`'s structure: TopBar wiring first, then the pill component in
 * isolation). `LoadCard.vue` is covered by the sibling `load-card.test.ts` file.
 */
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoadPill from "../../../src/web-hub/ui/src/components/load/LoadPill.vue";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";
import type { LoadWire } from "../../../src/web-hub/protocol/messages.js";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
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
    level: "ok",
    thresholds: {
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
    },
    ...over,
  };
}

function fakeHub(state: Partial<HubState>): HubHandle {
  return {
    state: ref({
      agents: new Map(),
      order: [],
      conn: "open",
      clientId: null,
      hub: null,
      selected: null,
      ...state,
    }) as unknown as HubState,
  } as unknown as HubHandle;
}

describe("TopBar: no load data ⇒ no .ld-pill node (I8, mirrors QuotaPill's own invariant)", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  it("with no HUB_CTX at all", () => {
    const wrapper = m(mount(TopBar, { props: baseProps }));
    expect(wrapper.find(".ld-pill").exists()).toBe(false);
  });

  it("with a live hub whose state carries no `load` slot", () => {
    const hub = fakeHub({});
    const wrapper = m(mount(TopBar, { props: baseProps, global: { provide: { [HUB_CTX as symbol]: hub } } }));
    expect(wrapper.find(".ld-pill").exists()).toBe(false);
  });

  it("renders the pill once hub.state.value.load is set", () => {
    const hub = fakeHub({ load: load({ cpu: { busyPct: 72, level: "ok", cores: 8 } }), loadReceivedAt: Date.now() });
    const wrapper = m(mount(TopBar, { props: baseProps, global: { provide: { [HUB_CTX as symbol]: hub } } }));
    expect(wrapper.find(".ld-pill").exists()).toBe(true);
  });
});

describe("LoadPill.vue — segments and the four-level color ladder", () => {
  it("renders nothing when load is undefined", () => {
    const wrapper = m(mount(LoadPill, { props: { load: undefined, receivedAt: undefined } }));
    expect(wrapper.find(".ld-pill").exists()).toBe(false);
  });

  it("renders nothing once stale (>4×intervalMs since receipt, re-evaluated on the component's own tick)", () => {
    vi.useFakeTimers();
    const l = load({ intervalMs: 1_000, cpu: { busyPct: 10, level: "ok", cores: 4 } });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    expect(wrapper.find(".ld-pill").exists()).toBe(true);
    // 4×intervalMs = 4000ms; the pill's own 5s tick re-evaluates staleness off the browser clock.
    vi.advanceTimersByTime(10_000);
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find(".ld-pill").exists()).toBe(false);
    });
  });

  it("builds CPU · MEM · DISK segments (視覚稿: `CPU 72% · MEM 81% · DISK 64%`)", () => {
    const l = load({
      cpu: { busyPct: 72, level: "ok", cores: 8 },
      mem: { usedPct: 81, availPct: 19, level: "ok" },
      disks: [{ label: "/", path: "/", usedPct: 64, freeBytes: 1, totalBytes: 2, level: "ok" }],
    });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    expect(wrapper.get(".ld-pill").text().replace(/\s+/g, " ")).toContain("CPU 72%");
    expect(wrapper.get(".ld-pill").text()).toContain("MEM 81%");
    expect(wrapper.get(".ld-pill").text()).toContain("DISK 64%");
  });

  it.each([
    ["ok", "0"],
    ["warn", "1"],
    ["crit", "3"],
  ] as const)("overall level %s ⇒ data-level=%s (worst-segment ladder)", (level, dataLevel) => {
    const l = load({ level, cpu: { busyPct: 90, level, cores: 8 } });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    expect(wrapper.get(".ld-pill").attributes("data-level")).toBe(dataLevel);
  });

  it("the worst segment gets the `.hot` class; a calmer sibling does not", () => {
    const l = load({
      level: "crit",
      cpu: { busyPct: 40, level: "ok", cores: 8 },
      mem: { usedPct: 94, availPct: 6, level: "crit" },
    });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    const segs = wrapper.findAll(".ld-seg");
    const cpuSeg = segs.find((s) => s.text().includes("CPU"))!;
    const memSeg = segs.find((s) => s.text().includes("MEM"))!;
    expect(cpuSeg.classes()).not.toContain("hot");
    expect(memSeg.classes()).toContain("hot");
    expect(memSeg.attributes("data-level")).toBe("3");
  });

  it("clicking toggles the LoadCard popover open/closed", async () => {
    const l = load({ cpu: { busyPct: 50, level: "ok", cores: 4 } });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    expect(wrapper.find("#load-panel").exists()).toBe(false);
    await wrapper.get(".ld-pill").trigger("click");
    expect(wrapper.find("#load-panel").exists()).toBe(true);
    await wrapper.get(".ld-pill").trigger("click");
    expect(wrapper.find("#load-panel").exists()).toBe(false);
  });
});

describe("LoadPill.vue — mobile (≤480px) shows only the worst segment", () => {
  it("collapses to a single segment on a narrow viewport", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("480px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const l = load({
      level: "crit",
      cpu: { busyPct: 40, level: "ok", cores: 8 },
      mem: { usedPct: 94, availPct: 6, level: "crit" },
      disks: [{ label: "/", path: "/", usedPct: 30, freeBytes: 1, totalBytes: 2, level: "ok" }],
    });
    const wrapper = m(mount(LoadPill, { props: { load: l, receivedAt: Date.now() } }));
    const segs = wrapper.findAll(".ld-seg");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text()).toContain("MEM 94%");
  });
});
