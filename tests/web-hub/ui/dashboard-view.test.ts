// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";

/**
 * `DashboardView.vue` (ui-design.md §4.4.2/§6.2, vue-plan.md v2.1 §3.2/§3.3/§3.7/§5.2 — P3):
 * regression coverage for #26 P6 findings 1 and 2.
 *
 * 1. A deep link to an agent key the reducer has never seen (`selectedAgent === undefined`) must
 *    render the "This session is not connected" empty state — not the generic "Select a session"
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

function hubWithTwoAgents(): HubHandle {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a"), card("agent-b")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    { event: "history", data: { agentKey: "agent-a", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
    { event: "subscribing", data: { agentKey: "agent-b", clientId: "c1" } },
    { event: "history", data: { agentKey: "agent-b", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
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
    expect(wrapper.find(".empty h2").text()).toBe("Select a session");
  });

  it("renders the not-connected empty state (with a back link) for a deep link to an unknown agent key", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "agent", key: "does-not-exist" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("This session is not connected");
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

describe("DashboardView.vue — settings is not a route (floating panel lives in TopBar now)", () => {
  it("route.name === 'settings' never replaces the session layout — .layout stays mounted, no .settings-page here", () => {
    stubMatchMedia(false);
    const hub = hubWithOneAgent();
    const wrapper = mountDashboard({ name: "settings" }, hub);
    expect(wrapper.find(".layout").exists()).toBe(true);
    expect(wrapper.find(".settings-page").exists()).toBe(false);
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
    expect(wrapper.find(".empty h2").text()).not.toBe("This session is not connected");
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
    expect(wrapper.find(".empty h2").text()).toBe("This session is not connected");
  });

  it("a removed key never auto-navigates back to the list (stays on the agent route)", () => {
    stubMatchMedia(false);
    window.location.hash = "#/agent/gone-3";
    const hub = hubWithRemoved("gone-3");
    mountDashboard({ name: "agent", key: "gone-3" }, hub);
    expect(window.location.hash).toBe("#/agent/gone-3");
  });
});

/**
 * Deep-link refresh flicker fix: before the hub's first `agents` snapshot lands
 * (`state.synced === false`), an agent-route deep link renders a loading state instead of
 * flashing 「This session is not connected」. `synced` survives reconnects, so a reconnect never
 * falls back into the loading state; everything past the first snapshot is unchanged.
 */
describe("DashboardView.vue — pre-first-snapshot loading state (deep-link refresh flicker fix)", () => {
  function hubPreSnapshot(): HubHandle {
    const s = run([{ event: "hello", data: { clientId: "c1" } }]);
    return { state: ref(s as unknown as HubState), dispatch: () => {} };
  }

  it("split view: a deep link before the first agents snapshot renders loading, not not-connected", () => {
    stubMatchMedia(false);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubPreSnapshot());
    // scope to the detail pane — the sidebar's own empty state also uses `.empty` (no HUB_CTX
    // provide in this mount defaults the list to its synced behavior, same as production).
    expect(wrapper.find(".detail .empty h2").text()).toBe("Connecting…");
    expect(wrapper.find(".detail .empty h2").text()).not.toBe("This session is not connected");
  });

  it("narrow view: same loading state before the first snapshot", () => {
    stubMatchMedia(true);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubPreSnapshot());
    expect(wrapper.find(".empty h2").text()).toBe("Connecting…");
  });

  it("a synced snapshot without the key ⇒ not-connected (unchanged)", () => {
    stubMatchMedia(false);
    const wrapper = mountDashboard({ name: "agent", key: "does-not-exist" }, hubWithOneAgent());
    expect(wrapper.find(".empty h2").text()).toBe("This session is not connected");
  });

  it("a synced snapshot WITH the key ⇒ the real detail view (unchanged)", () => {
    stubMatchMedia(false);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hubWithOneAgent());
    expect(wrapper.find(".empty").exists()).toBe(false);
    expect(wrapper.find(".detail-head").exists()).toBe(true);
  });

  it("a reconnect (conn close + hello) after the snapshot never falls back to loading", () => {
    stubMatchMedia(false);
    const s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("agent-a")] },
      { event: "conn", data: { state: "closed" } },
      { event: "hello", data: { clientId: "c2" } },
    ]);
    const hub: HubHandle = { state: ref(s as unknown as HubState), dispatch: () => {} };
    const wrapper = mountDashboard({ name: "agent", key: "does-not-exist" }, hub);
    expect(wrapper.find(".empty h2").text()).toBe("This session is not connected");
  });

  it("never synced + transport reconnecting (hub unreachable) ⇒ not-connected, not an endless loading state", () => {
    stubMatchMedia(false);
    const s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "conn", data: { state: "reconnecting" } },
    ]);
    const hub: HubHandle = { state: ref(s as unknown as HubState), dispatch: () => {} };
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    expect(wrapper.find(".detail .empty h2").text()).toBe("This session is not connected");
  });

  it("never synced + a removed key ⇒ the removed state still wins over loading", () => {
    stubMatchMedia(false);
    const s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agent_removed", data: { agentKey: "agent-a" } },
    ]);
    const hub: HubHandle = { state: ref(s as unknown as HubState), dispatch: () => {} };
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    expect(wrapper.find(".detail .empty h2").text()).not.toBe("Connecting…");
    expect(wrapper.find(".detail .empty h2").text()).not.toBe("This session is not connected");
  });
});

/**
 * spawn-restore plan §9.1: a selected key that is the OLD agent of a restore in flight — even
 * after `agent_removed` already dropped it — shows 「正在恢复」 instead of 「已删除」 (both layout
 * branches); useHub's successor follow then moves the route (tested in use-hub.test.ts).
 */
function hubRestoring(key: string, removed: boolean): HubHandle {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card(key), card("other-agent")] },
    ...(removed ? [{ event: "agent_removed", data: { agentKey: key } }] : []),
    {
      event: "spawns",
      data: {
        items: [
          {
            spawnId: "sp-r",
            state: "starting",
            createdAt: 1,
            updatedAt: 2,
            cwdLabel: "p",
            restore: { phase: "forking", attempt: 1, prevAgentKey: key },
          },
        ],
        active: 1,
        max: 4,
      },
    },
  ] as Msg[]);
  return { state: ref(s as unknown as HubState), dispatch: () => {} };
}

describe("DashboardView.vue — restoring empty state (spawn-restore plan §9.1)", () => {
  it("split view: a reaped OLD key mid-restore shows 「restoring」, not 「已删除」", () => {
    stubMatchMedia(false);
    const wrapper = mountDashboard({ name: "agent", key: "old-1" }, hubRestoring("old-1", true));
    expect(wrapper.find("[data-restoring]").exists()).toBe(true);
    expect(wrapper.find("[data-restoring] .empty h2").text()).toBe("Restoring session");
    expect(wrapper.text()).not.toContain("Session removed from the list");
  });

  it("narrow single view: same restoring state", () => {
    stubMatchMedia(true);
    const wrapper = mountDashboard({ name: "agent", key: "old-2" }, hubRestoring("old-2", true));
    expect(wrapper.find("[data-restoring] .empty h2").text()).toBe("Restoring session");
  });

  it("an un-reaped old card still renders its real detail (badge + read-only dock live there)", () => {
    stubMatchMedia(false);
    const wrapper = mountDashboard({ name: "agent", key: "old-3" }, hubRestoring("old-3", false));
    expect(wrapper.find("[data-restoring]").exists()).toBe(false);
  });
});

describe("DashboardView.vue — agent switch remounts AgentDetail (2026-10-07 regression)", () => {
  // Root cause pinned here: without `:key="selectedAgent.key"` the same AgentDetail instance was
  // reused across session switches while its setup-captured `CONTROL_VIEW/CONTROL_CTX.agentKey`
  // stayed frozen on the FIRST session — send/model-switch/drafts all routed there.
  it.each([
    ["wide (≥1025px)", false],
    ["narrow (≤767px)", true],
  ] as const)("%s branch: switching the route to another agent remounts AgentDetail", async (_label, narrow) => {
    stubMatchMedia(narrow);
    const hub = hubWithTwoAgents();
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    // NOTE: compare instance uids, NOT `.vm` — VTU hands out a fresh proxy per findComponent
    // call, so `.vm` identity is always unequal and would make this assertion vacuous.
    const beforeUid = wrapper.findComponent(AgentDetail).vm.$.uid;
    await wrapper.setProps({ route: { name: "agent", key: "agent-b" } });
    const afterUid = wrapper.findComponent(AgentDetail).vm.$.uid;
    expect(afterUid).not.toBe(beforeUid);
  });
});
