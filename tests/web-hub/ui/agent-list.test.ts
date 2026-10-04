// @vitest-environment happy-dom
/**
 * `AgentList.vue` / `AgentCard.vue` (ui-design.md §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 —
 * P3). Filter substring matching, the live vs. "Stale & Offline" grouping, the empty state, and
 * `aria-current` on the selected card.
 */
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import AgentList from "../../../src/web-hub/ui/src/components/agents/AgentList.vue";
import type { AgentCardView } from "../../../src/web-hub/ui/src/types.js";

beforeEach(() => {
  localStorage.clear();
});

function card(over: Partial<AgentCardView> = {}): AgentCardView {
  return {
    key: "agent-1",
    kind: "tui",
    shortCwd: "ai/pi-toolkit",
    sessionLabel: "web-hub Vue rewrite",
    modelShort: "claude-opus-5-5",
    contextPercent: 62,
    runningSubCount: 4,
    costLabel: "$195.54",
    visualState: "running",
    statusLabel: "Working",
    stale: false,
    down: false,
    outdated: false,
    ...over,
  };
}

describe("AgentList.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("renders one card per agent, with the running one before Stale & Offline group", () => {
    const cards = [
      card({ key: "a", shortCwd: "a" }),
      card({ key: "b", shortCwd: "b", stale: true, statusLabel: "Stale · no recent heartbeat", visualState: "stale" }),
    ];
    const wrapper = mount(AgentList, { props: { cards, selectedKey: null, filter: "" } });
    expect(wrapper.findAll("a.agent-card")).toHaveLength(2);
    expect(wrapper.find("li.agent-group").text()).toBe("Stale & Offline");
  });

  it("marks the selected card's aria-current", () => {
    const cards = [card({ key: "a" }), card({ key: "b" })];
    const wrapper = mount(AgentList, { props: { cards, selectedKey: "b", filter: "" } });
    const links = wrapper.findAll("a.agent-card");
    expect(links[0]!.attributes("aria-current")).toBeUndefined();
    expect(links[1]!.attributes("aria-current")).toBe("page");
  });

  it("filters by cwd/session substring (case-insensitive)", () => {
    const cards = [
      card({ key: "a", shortCwd: "ai/pi-toolkit", sessionLabel: "vue rewrite" }),
      card({ key: "b", shortCwd: "work/infra-bot", sessionLabel: "nightly audit" }),
    ];
    const wrapper = mount(AgentList, { props: { cards, selectedKey: null, filter: "INFRA" } });
    const links = wrapper.findAll("a.agent-card");
    expect(links).toHaveLength(1);
    expect(links[0]!.text()).toContain("infra-bot");
  });

  it("emits update:filter as the user types", async () => {
    const wrapper = mount(AgentList, { props: { cards: [card()], selectedKey: null, filter: "" } });
    await wrapper.find("input.input").setValue("pi-tool");
    expect(wrapper.emitted("update:filter")?.[0]).toEqual(["pi-tool"]);
  });

  it("shows the empty state (no agents at all) with a code hint, not the list", () => {
    const wrapper = mount(AgentList, { props: { cards: [], selectedKey: null, filter: "" } });
    expect(wrapper.find("ul.agent-list").exists()).toBe(false);
    expect(wrapper.find(".empty h2").text()).toBe("No pi sessions connected");
    expect(wrapper.text()).toContain("webHub.enabled");
  });

  it("agent card shows a status pill only when a statusLabel is present", () => {
    const withLabel = mount(AgentList, {
      props: { cards: [card({ statusLabel: "Working" })], selectedKey: null, filter: "" },
    });
    expect(withLabel.find(".agent-flags .pill").text()).toBe("Working");

    const withoutLabel = mount(AgentList, {
      props: { cards: [card({ statusLabel: null })], selectedKey: null, filter: "" },
    });
    expect(withoutLabel.find(".agent-flags").exists()).toBe(false);
  });
});

/**
 * `AgentCard.vue` needs-answer badge (control-plan.md v2.1 §7.4 — C5 追加): an agent with an
 * open ask_user dialog gets the "Needs answer" badge (visualState stays `waiting`); the frozen
 * `AgentCardView` has no dialogs field, so the card reads the App.vue-provided `HUB_CTX` state.
 */
import { ref } from "vue";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

function hubWithDialogs(open: readonly unknown[]): HubHandle {
  const agents = new Map([["agent-1", { dialogs: { epoch: "e1", open, closed: [] } }]]);
  return { state: ref({ agents } as unknown as HubState), dispatch: () => {} };
}

describe("AgentCard.vue needs-answer badge (C5, §7.4)", () => {
  it("open dialogs ⇒ 'Needs answer' badge; none ⇒ no badge; no HUB_CTX ⇒ no badge", () => {
    const withOpen = mount(AgentCard, {
      props: { card: card({ visualState: "waiting", statusLabel: "Waiting on dialog" }), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithDialogs([{ dialogId: "ask:1" }]) } },
    });
    expect(withOpen.find(".badge-answer").exists()).toBe(true);
    expect(withOpen.text()).toContain("Needs answer");
    expect(withOpen.text()).toContain("Waiting on dialog"); // visualState pill unchanged

    const withNone = mount(AgentCard, {
      props: { card: card(), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithDialogs([]) } },
    });
    expect(withNone.find(".badge-answer").exists()).toBe(false);

    const noHub = mount(AgentCard, { props: { card: card(), selected: false } });
    expect(noHub.find(".badge-answer").exists()).toBe(false);
  });
});

/**
 * Desktop collapse toggle (user-reported: the sidebar had no way to reclaim its width on a
 * fixed desktop split). CSS-gated to >=768px (see `agents.css`), so this just checks the
 * toggle/class/persistence contract — not real geometry (no layout engine in happy-dom).
 */
describe("AgentList.vue — desktop collapse toggle", () => {
  it("starts expanded by default; toggle flips aria-pressed, the is-collapsed class, and persists", async () => {
    const wrapper = mount(AgentList, { props: { cards: [card()], selectedKey: null, filter: "" } });
    const toggle = wrapper.get(".sidebar-collapse-toggle");
    expect(toggle.attributes("aria-pressed")).toBe("false");
    expect(wrapper.find(".sidebar").classes()).not.toContain("is-collapsed");

    await toggle.trigger("click");
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find(".sidebar").classes()).toContain("is-collapsed");
    expect(localStorage.getItem("webhub.agentList.collapsed")).toBe("1");

    await toggle.trigger("click");
    expect(wrapper.find(".sidebar").classes()).not.toContain("is-collapsed");
    expect(localStorage.getItem("webhub.agentList.collapsed")).toBe("0");
  });

  it("starts collapsed on mount when localStorage already says so", () => {
    localStorage.setItem("webhub.agentList.collapsed", "1");
    const wrapper = mount(AgentList, { props: { cards: [card()], selectedKey: null, filter: "" } });
    expect(wrapper.find(".sidebar").classes()).toContain("is-collapsed");
    expect(wrapper.get(".sidebar-collapse-toggle").attributes("aria-pressed")).toBe("true");
  });

  it("collapsing never removes the search input / agent list from the DOM (CSS-only, mobile-safe)", async () => {
    const wrapper = mount(AgentList, { props: { cards: [card()], selectedKey: null, filter: "" } });
    await wrapper.get(".sidebar-collapse-toggle").trigger("click");
    expect(wrapper.find("input.input").exists()).toBe(true);
    expect(wrapper.find("ul.agent-list").exists()).toBe(true);
  });
});

/**
 * "New session" header button (web control-plane parity for `/new`): reuses the existing
 * `ControlHandle.runCommand` channel against the SELECTED agent only; enabled mirrors
 * `AgentDetail.vue`'s `controlEnabled` formula.
 */
import { HUB_CTX as HUB_CTX_KEY } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { ControlHandle } from "../../../src/web-hub/ui/src/types.js";

function agentState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: "a1", card: { control: true, state: "live" }, down: false, ...over };
}

function fakeControlHandle(over: Partial<ControlHandle> = {}): ControlHandle {
  return {
    sendPrompt: async () => ({ ok: true }),
    abort: async () => ({ ok: true }),
    steerSub: async () => ({ ok: true }),
    stopSub: async () => ({ ok: true }),
    answerDialog: async () => ({ ok: true }),
    cancelDialog: async () => ({ ok: true }),
    runCommand: async () => ({ ok: true }),
    query: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
    ...over,
  };
}

function hubWithAgent(
  agentKey: string,
  agentOver: Record<string, unknown> = {},
  opts: { hubControl?: boolean; control?: ControlHandle } = {},
): HubHandle {
  const agents = new Map([[agentKey, agentState(agentOver)]]);
  return {
    state: ref({ control: opts.hubControl ?? true, agents } as unknown as HubState),
    dispatch: () => {},
    ...(opts.control ? { control: opts.control } : {}),
  };
}

describe("AgentList.vue — 'New session' header button", () => {
  it("disabled with no selected agent, even with control fully negotiated", () => {
    const hub = hubWithAgent("a1", {}, { control: fakeControlHandle() });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    expect(wrapper.get(".new-session-btn").attributes("disabled")).toBeDefined();
  });

  it("disabled when the hub never negotiated cmd.v1", () => {
    const hub = hubWithAgent("a1", {}, { hubControl: false, control: fakeControlHandle() });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    expect(wrapper.get(".new-session-btn").attributes("disabled")).toBeDefined();
  });

  it("disabled when the selected agent card lacks control, or is down", () => {
    const hub1 = hubWithAgent("a1", { card: { control: false, state: "live" } }, { control: fakeControlHandle() });
    const w1 = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub1 } },
    });
    expect(w1.get(".new-session-btn").attributes("disabled")).toBeDefined();

    const hub2 = hubWithAgent("a1", { down: true }, { control: fakeControlHandle() });
    const w2 = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub2 } },
    });
    expect(w2.get(".new-session-btn").attributes("disabled")).toBeDefined();
  });

  it("enabled for a live, controllable, selected agent — click runs runCommand(key, 'new', '')", async () => {
    let captured: [string, string, string] | undefined;
    const control = fakeControlHandle({
      runCommand: async (agentKey, name, args) => {
        captured = [agentKey, name, args];
        return { ok: true };
      },
    });
    const hub = hubWithAgent("a1", {}, { control });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    const btn = wrapper.get(".new-session-btn");
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");
    await wrapper.vm.$nextTick();
    expect(captured).toEqual(["a1", "new", ""]);
    expect(wrapper.get(".new-session-note").attributes("data-kind")).toBe("ok");
  });

  it("a failed call shows an inline err note (no toast)", async () => {
    const control = fakeControlHandle({
      runCommand: async () => ({ ok: false, error: "E_FAILED", message: "boom" }),
    });
    const hub = hubWithAgent("a1", {}, { control });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await wrapper.get(".new-session-btn").trigger("click");
    await wrapper.vm.$nextTick();
    const note = wrapper.get(".new-session-note");
    expect(note.attributes("data-kind")).toBe("err");
    expect(note.text()).toBe("boom");
  });
});
