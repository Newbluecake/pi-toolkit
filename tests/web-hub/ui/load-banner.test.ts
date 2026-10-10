// @vitest-environment happy-dom
/**
 * `FleetDrawer.vue`'s crit/warn dispatch-paused banner (sysload plan docs/dev/sysload/plan.md
 * §6.4/§7.4/§10, mockup `fleet-crit-light-760` + approved tweak ③: the duration annex stays on
 * the SAME line as the headline). Reads the SESSION's own `AgentState.loadGate`/
 * `loadGateReceivedAt` (mirrored off `StatusInfo.loadGate`) — never the hub-global `load` slot
 * `LoadPill`/`LoadCard` read (covered by `load-pill.test.ts`/`load-card.test.ts`).
 */
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";
import type { FleetRowWire, LoadGateWire } from "../../../src/web-hub/protocol/messages.js";

function stubModes(map: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}
const Q_DOCKED = "(min-width: 1280px)";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function m<T>(wrapper: T): T {
  mounted.push(wrapper as unknown as ReturnType<typeof mount>);
  return wrapper;
}

function fleetRow(runId: string): FleetRowWire {
  return {
    runId,
    label: runId,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
  } as FleetRowWire;
}

function baseAgent(over: Record<string, unknown> = {}) {
  return {
    key: "A",
    card: { control: true, state: "live", runTranscript: true },
    down: false,
    prompts: [],
    fleet: [fleetRow("r_1")],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    runSel: null,
    runTx: null,
    ...over,
  } as never;
}

function fakeHub(): HubHandle {
  const control: ControlHandle = {} as ControlHandle;
  return { state: { value: {} } as HubHandle["state"], control, dispatch: () => {} } as unknown as HubHandle;
}

function mountDrawer(agent: unknown) {
  stubModes({ [Q_DOCKED]: true }); // docked mode — simplest, no document-level listeners
  return m(
    mount(FleetDrawer, {
      props: { agent, now: 0, mode: "docked", open: true },
      global: { provide: { [HUB_CTX as symbol]: fakeHub() } },
    }),
  );
}

describe("FleetDrawer — crit/warn banner", () => {
  it("renders nothing when the agent has no loadGate at all (feature off / pre-sample / old peer)", () => {
    const wrapper = mountDrawer(baseAgent());
    expect(wrapper.find(".ld-banner").exists()).toBe(false);
  });

  it("renders nothing when gating is false (not currently blocking dispatch)", () => {
    const gate: LoadGateWire = { gating: false, level: "crit", at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    expect(wrapper.find(".ld-banner").exists()).toBe(false);
  });

  it('renders nothing when level is "unknown" even if gating were somehow true (defensive)', () => {
    const gate: LoadGateWire = { gating: true, level: "unknown", at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    expect(wrapper.find(".ld-banner").exists()).toBe(false);
  });

  it("gating + crit shows the danger banner with data-level=crit", () => {
    const gate: LoadGateWire = { gating: true, level: "crit", sinceAgoMs: 120_000, at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    const banner = wrapper.get(".ld-banner");
    expect(banner.attributes("data-level")).toBe("crit");
    expect(banner.text()).toContain("CRIT");
  });

  it("gating + warn shows the warn-styled banner", () => {
    const gate: LoadGateWire = { gating: true, level: "warn", sinceAgoMs: 30_000, at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    expect(wrapper.get(".ld-banner").attributes("data-level")).toBe("warn");
  });

  it("tweak ③: the duration annex stays on the SAME line as the headline (one .ld-banner-body node)", () => {
    const gate: LoadGateWire = { gating: true, level: "crit", sinceAgoMs: 120_000, at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    const bodies = wrapper.findAll(".ld-banner-body");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.text()).toContain("2m");
  });

  it("never claims a specific metric tripped it (StatusInfo.loadGate carries no per-metric breakdown)", () => {
    const gate: LoadGateWire = { gating: true, level: "crit", sinceAgoMs: 1_000, at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now() }));
    const text = wrapper.get(".ld-banner").text();
    expect(text).not.toMatch(/CPU \d/);
    expect(text).not.toMatch(/MEM \d/);
  });

  it("is hidden while a run is selected (banner belongs to the tree root only, per the mockup)", () => {
    const gate: LoadGateWire = { gating: true, level: "crit", at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: Date.now(), runSel: "r_1" }));
    expect(wrapper.find(".ld-banner").exists()).toBe(false);
  });

  it("without a resolvable duration the banner still renders (duration annex just omitted)", () => {
    const gate: LoadGateWire = { gating: true, level: "crit", at: 1 };
    const wrapper = mountDrawer(baseAgent({ loadGate: gate, loadGateReceivedAt: undefined }));
    expect(wrapper.find(".ld-banner").exists()).toBe(true);
  });
});
