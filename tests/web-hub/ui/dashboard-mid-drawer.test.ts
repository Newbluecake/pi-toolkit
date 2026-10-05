// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";

/**
 * `DashboardView.vue` mid band (todo #7): at 481–1024px the sidebar is no longer a fixed split
 * column — the list route is a full-width page, the agent route a full-width detail, and the
 * sidebar opens as an overlay drawer over the detail (toggle in `DetailHeader.vue` via the
 * provided `SIDEBAR_DRAWER` context), closing on scrim click / Escape / picking an agent.
 * Escape with the drawer CLOSED keeps the single-view "back to list" navigation.
 */

const Q_NARROW = "(max-width: 767px)";
const Q_WIDE = "(min-width: 1025px)";
const Q_BAND = "(min-width: 481px) and (max-width: 1024px)";

function stubMatchMediaMap(map: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const MID = { [Q_NARROW]: false, [Q_WIDE]: false, [Q_BAND]: true };
const WIDE = { [Q_NARROW]: false, [Q_WIDE]: true, [Q_BAND]: false };

afterEach(() => {
  vi.unstubAllGlobals();
  for (const w of mounted.splice(0)) w.unmount();
  window.location.hash = "";
});

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

const mounted: Array<ReturnType<typeof mount>> = [];

function card(agentKey: string): Record<string, unknown> {
  return {
    agentKey,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    prompts: [],
  };
}

function hubWithAgents(...keys: string[]): HubHandle {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: keys.map(card) },
    ...keys.map((agentKey) => ({ event: "subscribing", data: { agentKey, clientId: "c1" } })),
    ...keys.map((agentKey) => ({
      event: "history",
      data: { agentKey, entries: [], tailMessages: [], fromSeq: 0, hasMore: false },
    })),
  ]);
  return { state: ref(s as unknown as HubState), dispatch: () => {} };
}

function mountDashboard(route: Route, hub: HubHandle) {
  const wrapper = mount(DashboardView, { props: { hub, route } });
  mounted.push(wrapper);
  return wrapper;
}

describe("DashboardView.vue — mid band (481–1024px) layout", () => {
  it("list route: full-width list page, no detail pane mounted", () => {
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "list" }, hubWithAgents("agent-a"));
    expect(wrapper.find(".sidebar").exists()).toBe(true);
    expect(wrapper.find(".detail").exists()).toBe(false);
  });

  it("agent route: detail mounted full-width, sidebar absent until the drawer opens", () => {
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));
    expect(wrapper.find(".detail").exists()).toBe(true);
    expect(wrapper.find(".sidebar").exists()).toBe(false);
    expect(wrapper.find(".drawer-scrim").exists()).toBe(false);
    // single-view navigation affordances: back button AND the drawer toggle
    expect(wrapper.find(".detail-back").exists()).toBe(true);
    expect(wrapper.find(".detail-drawer-toggle").exists()).toBe(true);
  });

  it("the drawer toggle opens the sidebar as an overlay (scrim + .sidebar-drawer), detail stays mounted", async () => {
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));
    await wrapper.find(".detail-drawer-toggle").trigger("click");
    const sidebar = wrapper.find(".sidebar");
    expect(sidebar.exists()).toBe(true);
    expect(sidebar.classes()).toContain("sidebar-drawer");
    expect(wrapper.find(".drawer-scrim").exists()).toBe(true);
    expect(wrapper.find(".detail").exists()).toBe(true);
  });

  it("clicking the scrim closes the drawer", async () => {
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));
    await wrapper.find(".detail-drawer-toggle").trigger("click");
    await wrapper.find(".drawer-scrim").trigger("click");
    expect(wrapper.find(".sidebar").exists()).toBe(false);
    expect(wrapper.find(".drawer-scrim").exists()).toBe(false);
    expect(wrapper.find(".detail").exists()).toBe(true);
  });

  it("Escape closes the drawer WITHOUT navigating back to the list", async () => {
    stubMatchMediaMap(MID);
    window.location.hash = "#/agent/agent-a";
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));
    await wrapper.find(".detail-drawer-toggle").trigger("click");
    expect(wrapper.find(".sidebar").exists()).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(wrapper.find(".sidebar").exists()).toBe(false);
    expect(window.location.hash).toBe("#/agent/agent-a");
  });

  it("Escape with the drawer closed keeps the single-view back-to-list navigation", async () => {
    stubMatchMediaMap(MID);
    window.location.hash = "#/agent/agent-a";
    mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/");
  });

  it("picking an agent card inside the drawer closes it", async () => {
    stubMatchMediaMap(MID);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a", "agent-b"));
    await wrapper.find(".detail-drawer-toggle").trigger("click");
    expect(wrapper.find(".sidebar").exists()).toBe(true);

    await wrapper.find('.sidebar a[href="#/agent/agent-b"]').trigger("click");
    expect(wrapper.find(".sidebar").exists()).toBe(false);
  });

  it("leaving the agent route settles the drawer closed (list route shows the plain full-width list)", async () => {
    stubMatchMediaMap(MID);
    const hub = hubWithAgents("agent-a");
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    await wrapper.find(".detail-drawer-toggle").trigger("click");
    expect(wrapper.find(".drawer-scrim").exists()).toBe(true);

    await wrapper.setProps({ route: { name: "list" } });
    expect(wrapper.find(".drawer-scrim").exists()).toBe(false);
    const sidebar = wrapper.find(".sidebar");
    expect(sidebar.exists()).toBe(true); // the list route's own full-width page
    expect(sidebar.classes()).not.toContain("sidebar-drawer");
  });
});

describe("DashboardView.vue — ≥1025px split is unchanged by the drawer", () => {
  it("mounts list and detail side by side, with no drawer toggle or scrim", () => {
    stubMatchMediaMap(WIDE);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));
    expect(wrapper.find(".sidebar").exists()).toBe(true);
    expect(wrapper.find(".detail").exists()).toBe(true);
    expect(wrapper.find(".detail-drawer-toggle").exists()).toBe(false);
    expect(wrapper.find(".detail-back").exists()).toBe(false);
    expect(wrapper.find(".drawer-scrim").exists()).toBe(false);
  });

  it("Escape on the agent route does not navigate (split has no back-to-list)", async () => {
    stubMatchMediaMap(WIDE);
    window.location.hash = "#/agent/agent-a";
    mountDashboard({ name: "agent", key: "agent-a" }, hubWithAgents("agent-a"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/agent/agent-a");
  });
});
