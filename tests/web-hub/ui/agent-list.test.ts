// @vitest-environment happy-dom
/**
 * `AgentList.vue` / `AgentCard.vue` (ui-design.md §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 —
 * P3). Filter substring matching, the live vs. "Stale & Offline" grouping, the empty state, and
 * `aria-current` on the selected card.
 */
import { flushPromises, mount } from "@vue/test-utils";
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

  it("offline agent gets the Stopped chip; live/stale cards do not", () => {
    const cards = [
      card({ key: "live", shortCwd: "live" }),
      card({ key: "dead", shortCwd: "dead", down: true, stale: true, visualState: "offline", statusLabel: "Offline" }),
    ];
    const wrapper = mount(AgentList, { props: { cards, selectedKey: null, filter: "" } });
    const dead = wrapper.find('a.agent-card[data-st="offline"]');
    expect(dead.exists()).toBe(true);
    expect(dead.find(".chip-stopped").text()).toBe("Stopped");
    const live = wrapper.find('a.agent-card[data-st="running"]');
    expect(live.find(".chip-stopped").exists()).toBe(false);
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

/**
 * web-hub-spawn SP12 (arch §9.1): the header button is now `NewSessionMenu` (split button over
 * SP11's `newSessionActions`), the EmptyState grows a pick-dir entry (0 agents), pending
 * `spawns` records render as `SpawnRow` placeholders, and a managed agent card shows the `web`
 * badge. Fakes below extend the same `hubWithAgent` pattern with a `spawn` handle.
 */
import type { SpawnPolicyWire, SpawnRecordPublic, SpawnsPayload } from "../../../src/web-hub/protocol/spawn.js";
import type { HubSpawnHandle, NewSessionFlow } from "../../../src/web-hub/ui/src/types.js";
import type { SpawnListOutcome } from "../../../src/web-hub/ui/src/transport/types.js";
import type { Ref } from "vue";

const spawnPolicy: SpawnPolicyWire = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 4,
  maxPerPrincipal: 2,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
};

function spawnRec(over: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp1",
    state: "starting",
    createdAt: 1000,
    updatedAt: 1000,
    cwdLabel: "proj",
    origin: { listener: "loopback", reqId: "req-aaaaaaaaaaaaaaaa" },
    ...over,
  };
}

function fakeNewSessionHandle(flow: Ref<NewSessionFlow>) {
  return {
    flow,
    submit: async () => true,
    confirm: async () => {},
    cancel: () => {},
    retry: async () => false,
    noteSpawns: () => {},
    dispose: () => {},
    stats: () => ({ retainedTexts: 0 }),
  };
}

function fakeSpawnHandle(over: Partial<HubSpawnHandle> = {}): HubSpawnHandle {
  return {
    list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
    dirs: async () => ({ ok: true, recent: [] }),
    start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
    stop: async () => ({ ok: true, state: "stopping" }),
    newSession: fakeNewSessionHandle(ref({ phase: "idle" })),
    ...over,
  };
}

function hubWithSpawn(
  opts: {
    caps?: readonly string[];
    list?: () => Promise<SpawnListOutcome>;
    spawns?: SpawnsPayload | null;
    agents?: Map<string, unknown>;
    control?: ControlHandle;
  } = {},
): HubHandle {
  return {
    state: ref({
      control: true,
      hub: { caps: opts.caps ?? [] },
      agents: opts.agents ?? new Map(),
      spawns: opts.spawns ?? null,
    } as unknown as HubState),
    dispatch: () => {},
    ...(opts.control ? { control: opts.control } : {}),
    spawn: fakeSpawnHandle({ ...(opts.list ? { list: opts.list } : {}) }),
  };
}

describe("AgentList.vue — NewSessionMenu (SP12, arch §9.1)", () => {
  it("no spawn.v1 cap ⇒ the caret toggle is hidden (main /new button unchanged)", () => {
    const hub = hubWithSpawn({ caps: ["cmd.v1"] });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    expect(wrapper.find(".new-session-btn").exists()).toBe(true);
    expect(wrapper.find(".nsmenu-toggle").exists()).toBe(false);
  });

  it("GET /api/headless 404 ⇒ pick-dir hidden (arch §8.3), toggle hidden", async () => {
    const hub = hubWithSpawn({ caps: ["spawn.v1"] }); // default fake list() is 404
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await flushPromises();
    expect(wrapper.find(".nsmenu-toggle").exists()).toBe(false);
  });

  it("policy.allowed ⇒ pick-dir item enabled in the dropdown; picking it opens the DirPicker", async () => {
    const hub = hubWithSpawn({
      caps: ["spawn.v1"],
      list: async () => ({ ok: true, policy: spawnPolicy, items: [] }),
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await flushPromises();
    const toggle = wrapper.get(".nsmenu-toggle");
    expect(toggle.attributes("aria-haspopup")).toBe("menu");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    await toggle.trigger("click");
    const items = wrapper.findAll(".nsmenu-item");
    const pickDir = items.find((i) => i.text().includes("Choose a directory"));
    expect(pickDir).toBeDefined();
    expect(pickDir!.attributes("disabled")).toBeUndefined();

    await pickDir!.trigger("click");
    expect(wrapper.find(".spawn-picker").exists()).toBe(true);
    expect(wrapper.find(".nsmenu-menu").exists()).toBe(false); // menu closed after pick
  });

  it("policy denied ⇒ pick-dir item disabled with the reason; Escape closes the menu", async () => {
    const hub = hubWithSpawn({
      caps: ["spawn.v1"],
      list: async () => ({ ok: true, policy: { ...spawnPolicy, allowed: false, reason: "cooldown" }, items: [] }),
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await flushPromises();
    await wrapper.get(".nsmenu-toggle").trigger("click");
    const items = wrapper.findAll(".nsmenu-item");
    const pickDir = items.find((i) => i.text().includes("Choose a directory"));
    expect(pickDir!.attributes("disabled")).toBeDefined();
    expect(pickDir!.text()).toContain("Cooling down");

    await wrapper.get(".nsmenu").trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".nsmenu-menu").exists()).toBe(false);
  });

  it("menu lists the same-cwd item with the selected agent's short cwd", async () => {
    const agents = new Map([["a1", agentState()]]);
    const hub = hubWithSpawn({
      caps: ["spawn.v1"],
      agents,
      control: fakeControlHandle(),
      list: async () => ({ ok: true, policy: spawnPolicy, items: [] }),
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1", shortCwd: "ai/pi-toolkit" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await flushPromises();
    await wrapper.get(".nsmenu-toggle").trigger("click");
    const sameCwd = wrapper.findAll(".nsmenu-item").find((i) => i.text().includes("(/new)"));
    expect(sameCwd).toBeDefined();
    expect(sameCwd!.text()).toContain("ai/pi-toolkit");
    expect(sameCwd!.attributes("disabled")).toBeUndefined();
  });

  it("main button click still runs /new via the same-cwd action (menu regression)", async () => {
    let captured: [string, string, string] | undefined;
    const control = fakeControlHandle({
      runCommand: async (agentKey, name, args) => {
        captured = [agentKey, name, args];
        return { ok: true };
      },
    });
    const agents = new Map([["a1", agentState()]]);
    const hub = hubWithSpawn({ caps: [], agents, control });
    const wrapper = mount(AgentList, {
      props: { cards: [card({ key: "a1" })], selectedKey: "a1", filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await wrapper.get(".new-session-btn").trigger("click");
    await wrapper.vm.$nextTick();
    expect(captured).toEqual(["a1", "new", ""]);
  });
});

describe("AgentList.vue — EmptyState pick-dir entry (SP12; 0 agents)", () => {
  it("0 agents + policy.allowed ⇒ the EmptyState offers the pick-dir entry; click opens DirPicker", async () => {
    const hub = hubWithSpawn({
      caps: ["spawn.v1"],
      list: async () => ({ ok: true, policy: spawnPolicy, items: [] }),
    });
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    await flushPromises();
    const entry = wrapper.get(".empty .spawn-empty-pick");
    expect(entry.text()).toContain("Choose a directory");
    await entry.trigger("click");
    expect(wrapper.find(".spawn-picker").exists()).toBe(true);
  });

  it("0 agents without the cap ⇒ no pick-dir entry", () => {
    const hub = hubWithSpawn({ caps: [] });
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    expect(wrapper.find(".spawn-empty-pick").exists()).toBe(false);
  });
});

describe("AgentList.vue — pending SpawnRow placeholders (SP12)", () => {
  it("starting/failed records render above the list; dismiss removes a failed row locally", async () => {
    const spawns: SpawnsPayload = {
      items: [
        spawnRec({ spawnId: "sp-new", state: "starting", createdAt: 2000 }),
        spawnRec({ spawnId: "sp-old", state: "failed", createdAt: 1000, hint: "register-timeout-hello" }),
        spawnRec({ spawnId: "sp-live", state: "live", createdAt: 3000 }), // not a pending row
      ],
      active: 1,
      max: 4,
    };
    const hub = hubWithSpawn({ caps: ["spawn.v1"], spawns });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    const rows = wrapper.findAll(".spawn-pending .spawn-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes("data-state")).toBe("starting"); // newest first
    expect(rows[1]!.attributes("data-state")).toBe("failed");
    expect(rows[1]!.text()).toContain("never registered"); // hint mapping

    const dismiss = rows[1]!.findAll("button").find((b) => b.text() === "Dismiss");
    await dismiss!.trigger("click");
    expect(wrapper.findAll(".spawn-pending .spawn-row")).toHaveLength(1);
  });
});

describe("AgentCard.vue — managed `web` badge (SP12, arch §9.1)", () => {
  function hubWithSpawns(spawns: SpawnsPayload | null): HubHandle {
    return {
      state: ref({ agents: new Map(), spawns } as unknown as HubState),
      dispatch: () => {},
    };
  }

  it("a live record managing the card's key ⇒ web badge; terminal/unrelated ⇒ none", () => {
    const live: SpawnsPayload = {
      items: [spawnRec({ state: "live", agentKey: "agent-1" })],
      active: 1,
      max: 4,
    };
    const withBadge = mount(AgentCard, {
      props: { card: card(), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithSpawns(live) } },
    });
    expect(withBadge.find(".chip-web").exists()).toBe(true);
    expect(withBadge.find(".chip-web").text()).toBe("web");

    const terminal: SpawnsPayload = {
      items: [spawnRec({ state: "exited", agentKey: "agent-1" })],
      active: 0,
      max: 4,
    };
    const noBadge = mount(AgentCard, {
      props: { card: card(), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithSpawns(terminal) } },
    });
    expect(noBadge.find(".chip-web").exists()).toBe(false);

    const otherAgent: SpawnsPayload = {
      items: [spawnRec({ state: "live", agentKey: "agent-2" })],
      active: 1,
      max: 4,
    };
    const unrelated = mount(AgentCard, {
      props: { card: card(), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithSpawns(otherAgent) } },
    });
    expect(unrelated.find(".chip-web").exists()).toBe(false);
  });

  it("a starting record never badges (no agentKey until the bind completes)", () => {
    const starting: SpawnsPayload = { items: [spawnRec({ state: "starting" })], active: 1, max: 4 };
    const wrapper = mount(AgentCard, {
      props: { card: card(), selected: false },
      global: { provide: { [HUB_CTX as symbol]: hubWithSpawns(starting) } },
    });
    expect(wrapper.find(".chip-web").exists()).toBe(false);
  });
});
