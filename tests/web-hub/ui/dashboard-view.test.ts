// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
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

/**
 * Query-aware `matchMedia` stub (todo #7: DashboardView now reads THREE queries —
 * `(max-width: 767px)` narrow, `(min-width: 1025px)` wide split, and the 481–1024 drawer
 * band — so a single boolean no longer describes every query). The boolean API is kept for
 * the pre-existing cases: `true` = phone (narrow only), `false` = ≥1025 split (wide only).
 */
function stubMatchMedia(narrow: boolean): void {
  const map: Record<string, boolean> = {
    "(max-width: 767px)": narrow,
    "(max-width: 480px)": narrow,
    "(min-width: 1025px)": !narrow,
    "(min-width: 481px) and (max-width: 1024px)": false,
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
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

describe("DashboardView.vue — settings route back navigation (field report: must restore the source route)", () => {
  it("renders the standalone settings page on the settings route", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "settings" }, hub);
    expect(wrapper.find(".settings-page").exists()).toBe(true);
    expect(wrapper.find(".layout").exists()).toBe(false); // list/detail split fully replaced
  });

  it("agent detail ⇒ gear ⇒ settings ⇒ back ⇒ returns to #/agent/<key> (history.back)", async () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    window.location.hash = "#/";
    const wrapper = mountDashboard({ name: "settings" }, hub);
    // simulate the real path: list ⇒ agent detail ⇒ settings (two in-app pushes AFTER mount,
    // so history.length outgrew DashboardView's historyFloor)
    window.history.pushState({}, "", "#/agent/agent-a");
    window.history.pushState({}, "", "#/settings");

    await wrapper.find("button.settings-back").trigger("click");
    await new Promise((r) => setTimeout(r, 0)); // happy-dom applies history.back() async

    expect(window.location.hash).toBe("#/agent/agent-a");
  });

  it("direct #/settings deep link ⇒ back ⇒ dashboard #/ (no in-app history to return to)", async () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    window.location.hash = "#/settings";
    const wrapper = mountDashboard({ name: "settings" }, hub); // floor == length ⇒ replace fallback

    await wrapper.find("button.settings-back").trigger("click");
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.hash).toBe("#/");
  });
});

/**
 * web-hub-delete-session plan v2 §2.3/§5.4/§8-A10 (user 拍板 #2): a selected key the reducer
 * has recorded in `removed` (an `agent_removed` broadcast already dropped its card) renders the
 * 「已删除」 empty state instead of the generic 「未连接」 one — in BOTH layout branches — and
 * never auto-navigates back to the list.
 */
function hubWithRemoved(key: string): HubHandle {
  // keep a second, un-removed agent present so AgentList's own 0-agents EmptyState (same
  // `.empty` class) never shadows the detail pane's — mirrors `hubWithOneAgent`'s shape.
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card(key), card("other-agent")] },
    { event: "agent_removed", data: { agentKey: key } },
  ]);
  return { state: ref(s as unknown as HubState), dispatch: () => {} };
}

describe("DashboardView.vue — removed empty state (web-hub-delete-session v2 §5.4, A10)", () => {
  it("split view (!narrow): a removed key shows 「已删除」, not 「未连接」, with a back link", () => {
    stubMatchMedia(false);
    const hub = hubWithRemoved("gone-1");
    const wrapper = mountDashboard({ name: "agent", key: "gone-1" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("Session removed from the list");
    expect(wrapper.text()).toContain("resume it from a terminal with pi");
    expect(wrapper.find('a[href="#/"]').exists()).toBe(true);
    expect(wrapper.find(".empty h2").text()).not.toBe("This agent is not connected");
  });

  it("narrow (<768px) single view: same removed empty state", () => {
    stubMatchMedia(true);
    const hub = hubWithRemoved("gone-2");
    const wrapper = mountDashboard({ name: "agent", key: "gone-2" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("Session removed from the list");
  });

  it("a key that was never removed still gets the generic not-connected empty state", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "agent", key: "does-not-exist" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("This agent is not connected");
  });

  it("a removed key never auto-navigates back to the list (stays on the agent route)", () => {
    stubMatchMedia(false);
    window.location.hash = "#/agent/gone-3";
    const hub = hubWithRemoved("gone-3");
    mountDashboard({ name: "agent", key: "gone-3" }, hub);
    expect(window.location.hash).toBe("#/agent/gone-3");
  });
});
