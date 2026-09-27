// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/web/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";

/**
 * `DashboardView.vue` (ui-design.md §4.4.2/§6.2, vue-plan.md v2.1 §3.2/§3.3/§3.7/§5.2 — P3):
 * regression coverage for #26 P6 findings 1 and 2.
 *
 * 1. A deep link to an agent key the reducer has never seen (`selectedAgent === undefined`) must
 *    render the "This agent is not connected" empty state — not the generic "Select an agent"
 *    one — in BOTH layout branches (the narrow single-view `v-else-if="route.name === 'agent'"`
 *    branch already had this; the split `!narrow` branch fell through to the generic copy).
 * 2. Below the 768px split breakpoint, pressing Escape while a detail view is showing calls the
 *    same `onBack()` a real back-button click uses.
 */

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

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

function hubWithOneAgent(): HubHandle {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    { event: "history", data: { agentKey: "agent-a", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
  ]);
  return { state: ref(s as unknown as HubState), dispatch: () => {} };
}

function mountDashboard(route: Route, hub: HubHandle) {
  const wrapper = mount(DashboardView, { props: { hub, route } });
  mounted.push(wrapper);
  return wrapper;
}

describe("DashboardView.vue — split view (!narrow) deep link to a missing agent", () => {
  it("renders the generic select-agent empty state on the list route", () => {
    stubMatchMedia(false); // (min-width: 768px) split view
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "list" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("Select an agent");
  });

  it("renders the not-connected empty state (with a back link) for a deep link to an unknown agent key", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "agent", key: "does-not-exist" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("This agent is not connected");
    expect(wrapper.find('a[href="#/"]').exists()).toBe(true);
  });

  it("still renders the real detail view (not an empty state) when the agent key is known", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    expect(wrapper.find(".empty").exists()).toBe(false);
    expect(wrapper.find(".detail-head").exists()).toBe(true);
  });
});

describe("DashboardView.vue — narrow (<768px) Escape returns to the list", () => {
  it("Escape while a detail view is showing replaces the hash back to #/", async () => {
    stubMatchMedia(true); // (max-width: 767px) narrow
    const hub = hubWithOneAgent();
    window.location.hash = "#/agent/agent-a";
    mountDashboard({ name: "agent", key: "agent-a" }, hub);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/");
  });

  it("does nothing when the route is already the list (no detail view showing)", async () => {
    stubMatchMedia(true);
    const hub = hubWithOneAgent();
    window.location.hash = "#/";
    mountDashboard({ name: "list" }, hub);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/");
  });

  it("ignores Escape while composing (IME) instead of navigating away mid-composition", async () => {
    stubMatchMedia(true);
    const hub = hubWithOneAgent();
    window.location.hash = "#/agent/agent-a";
    mountDashboard({ name: "agent", key: "agent-a" }, hub);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/agent/agent-a");
  });

  it("removes the keydown listener on unmount", async () => {
    stubMatchMedia(true);
    const hub = hubWithOneAgent();
    window.location.hash = "#/agent/agent-a";
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    mounted.pop();
    wrapper.unmount();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/agent/agent-a");
  });

  it("does not fire in split view (!narrow) even on the agent route", async () => {
    stubMatchMedia(false); // split view
    const hub = hubWithOneAgent();
    window.location.hash = "#/agent/agent-a";
    mountDashboard({ name: "agent", key: "agent-a" }, hub);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/agent/agent-a");
  });
});
