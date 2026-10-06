// @vitest-environment happy-dom
/**
 * `AgentList.vue` / `AgentCard.vue` (ui-design.md §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 —
 * P3). Filter substring matching, the live vs. "Stale & Offline" grouping, the empty state, and
 * `aria-current` on the selected card.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    let captured: [string, string, string, unknown] | undefined;
    const control = fakeControlHandle({
      runCommand: async (agentKey, name, args, opts) => {
        captured = [agentKey, name, args, opts];
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
    expect(captured).toEqual(["a1", "new", "", { confirm: true }]);
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
    let captured: [string, string, string, unknown] | undefined;
    const control = fakeControlHandle({
      runCommand: async (agentKey, name, args, opts) => {
        captured = [agentKey, name, args, opts];
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
    expect(captured).toEqual(["a1", "new", "", { confirm: true }]);
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

/**
 * web-hub-delete-session plan v2 §5.4/§7.2: the two-step delete button rendered as a sibling
 * of `AgentCard` (never nested in its `<a>`), driven by `removalTargetForAgent` reading the
 * full `AgentState` off the injected hub (the frozen `AgentCardView` prop has no down/card.state
 * fields rich enough for the target function).
 */
import type { RemoveAgentOutcome, RemoveTarget } from "../../../src/web-hub/ui/src/types.js";

function fullAgentState(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, down: false, card: { state: "live" }, ...over };
}

function hubForRemove(opts: {
  agents?: Map<string, unknown>;
  spawns?: SpawnsPayload | null;
  removeAgent?: (target: RemoveTarget) => Promise<RemoveAgentOutcome>;
}): HubHandle {
  return {
    state: ref({
      control: false,
      hub: { caps: [] },
      agents: opts.agents ?? new Map(),
      spawns: opts.spawns ?? null,
    } as unknown as HubState),
    dispatch: () => {},
    spawn: {
      list: async () => ({ ok: false, error: "E_NOT_FOUND", status: 404 }),
      dirs: async () => ({ ok: true, recent: [] }),
      start: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false }),
      stop: async () => ({ ok: true, state: "stopping" }),
      newSession: fakeNewSessionHandle(ref({ phase: "idle" })),
    },
    ...(opts.removeAgent ? { removeAgent: opts.removeAgent } : {}),
  };
}

describe("AgentList.vue — delete entry (web-hub-delete-session v2 §5.4)", () => {
  it("an online, unmanaged card gets no delete button at all", () => {
    const hub = hubForRemove({ agents: new Map([["agent-1", fullAgentState("agent-1")]]) });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    expect(wrapper.find(".remove-btn").exists()).toBe(false);
  });

  it("an offline card gets a delete button; two-step confirm calls removeAgent({agentKey})", async () => {
    const calls: RemoveTarget[] = [];
    const hub = hubForRemove({
      agents: new Map([["agent-1", fullAgentState("agent-1", { down: true, card: { state: "stale" } })]]),
      removeAgent: async (target) => {
        calls.push(target);
        return { ok: true, removed: true };
      },
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    await btn.trigger("click"); // arm
    expect(calls).toHaveLength(0);
    await btn.trigger("click"); // confirm
    await flushPromises();
    expect(calls).toEqual([{ agentKey: "agent-1" }]);
  });

  it("a managed card (live/stopping/starting record) deletes by spawnId instead, with aria-kind managed", async () => {
    const spawns: SpawnsPayload = {
      items: [spawnRec({ state: "live", agentKey: "agent-1", spawnId: "sp9" })],
      active: 1,
      max: 4,
    };
    const calls: RemoveTarget[] = [];
    const hub = hubForRemove({
      agents: new Map([["agent-1", fullAgentState("agent-1")]]),
      spawns,
      removeAgent: async (target) => {
        calls.push(target);
        return { ok: true, removed: true };
      },
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    expect(btn.attributes("aria-label")).toBe("Stop and delete this web-started session (session file is kept)");
    await btn.trigger("click");
    await btn.trigger("click");
    await flushPromises();
    expect(calls).toEqual([{ spawnId: "sp9" }]);
  });

  it("Esc disarms before the second click; no call is made", async () => {
    const calls: RemoveTarget[] = [];
    const hub = hubForRemove({
      agents: new Map([["agent-1", fullAgentState("agent-1", { down: true })]]),
      removeAgent: async (target) => {
        calls.push(target);
        return { ok: true, removed: true };
      },
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    await btn.trigger("click"); // arm
    expect(btn.attributes("aria-label")).toContain("Click again");
    await btn.trigger("keydown", { key: "Escape" });
    expect(btn.attributes("aria-label")).not.toContain("Click again");
    await btn.trigger("click"); // this is now a FIRST click again (re-arm), not a confirm
    await flushPromises();
    expect(calls).toHaveLength(0);
  });

  it("a removing:true managed record disables the button and shows the removing note", () => {
    const spawns: SpawnsPayload = {
      items: [spawnRec({ state: "stopping", agentKey: "agent-1", spawnId: "sp9", removing: true })],
      active: 1,
      max: 4,
    };
    const hub = hubForRemove({ agents: new Map([["agent-1", fullAgentState("agent-1")]]), spawns });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(wrapper.find(".remove-note").text()).toBe("removing…");
    // AgentCard's own row1 chip also shows removing
    expect(wrapper.find(".chip-removing").exists()).toBe(true);
  });

  it("a failed delete shows an inline error bucket derived from classifyRemoveError", async () => {
    const hub = hubForRemove({
      agents: new Map([["agent-1", fullAgentState("agent-1", { down: true })]]),
      removeAgent: async () => ({ ok: false, error: "E_AGENT_ONLINE", reason: "online" }),
    });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    await btn.trigger("click");
    await btn.trigger("click");
    await flushPromises();
    expect(wrapper.get(".remove-note").text()).toBe("Delete failed: the session is still online");
  });

  it("no removeAgent on the hub (older hub / test fake) ⇒ unsupported note, no throw", async () => {
    const hub = hubForRemove({ agents: new Map([["agent-1", fullAgentState("agent-1", { down: true })]]) });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    const btn = wrapper.get(".remove-btn");
    await btn.trigger("click");
    await btn.trigger("click");
    await flushPromises();
    expect(wrapper.get(".remove-note").text()).toBe("Delete failed: hub does not support this, reload the page");
  });

  it("the button is never nested inside the card's <a> (buttons can't nest in anchors)", () => {
    const hub = hubForRemove({ agents: new Map([["agent-1", fullAgentState("agent-1", { down: true })]]) });
    const wrapper = mount(AgentList, {
      props: { cards: [card()], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    expect(wrapper.find("a.agent-card .remove-btn").exists()).toBe(false);
    expect(wrapper.find("li.agent-item > .remove-wrap > .remove-btn").exists()).toBe(true);
  });
});

describe("SpawnRow.vue — delete entry (web-hub-delete-session v2 §0.3/§5.4)", () => {
  it.each(["starting", "failed"] as const)(
    "%s row gets a delete button; confirm calls removeAgent({spawnId})",
    async (state) => {
      const calls: RemoveTarget[] = [];
      const spawns: SpawnsPayload = {
        items: [spawnRec({ state, spawnId: "sp-x", createdAt: 1000 })],
        active: 0,
        max: 4,
      };
      const hub = hubForRemove({
        removeAgent: async (target) => {
          calls.push(target);
          return { ok: true, removed: true };
        },
        spawns,
      });
      const wrapper = mount(AgentList, {
        props: { cards: [], selectedKey: null, filter: "" },
        global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
      });
      const row = wrapper.get(".spawn-row");
      const btn = row.get(".remove-btn");
      await btn.trigger("click");
      await btn.trigger("click");
      await flushPromises();
      expect(calls).toEqual([{ spawnId: "sp-x" }]);
    },
  );

  it("live/stopping/exited records never get the SpawnRow delete button (they aren't rendered as rows at all)", () => {
    const spawns: SpawnsPayload = { items: [spawnRec({ state: "live", spawnId: "sp-live" })], active: 1, max: 4 };
    const hub = hubForRemove({ spawns });
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    expect(wrapper.find(".spawn-pending").exists()).toBe(false);
  });

  it("the existing 「关闭」 dismiss still works independently of the delete button", async () => {
    const spawns: SpawnsPayload = {
      items: [spawnRec({ state: "failed", spawnId: "sp-f", hint: "register-timeout-hello" })],
      active: 0,
      max: 4,
    };
    const hub = hubForRemove({ spawns });
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX_KEY as symbol]: hub } },
    });
    const dismiss = wrapper.findAll("button").find((b) => b.text() === "Dismiss");
    await dismiss!.trigger("click");
    expect(wrapper.findAll(".spawn-pending .spawn-row")).toHaveLength(0);
  });
});

/**
 * Deep-link refresh flicker fix: with an empty card list but no first `agents` snapshot yet
 * (`HUB_CTX` state's `synced === false`), the list renders a connecting state instead of
 * flashing 「No pi sessions connected」. A missing hub/field defaults to synced (old behavior).
 */
describe("AgentList.vue — pre-first-snapshot connecting state (deep-link refresh flicker fix)", () => {
  function hubWithSynced(synced: boolean): HubHandle {
    return { state: ref({ agents: new Map(), synced } as unknown as HubState), dispatch: () => {} };
  }

  it("empty cards + not yet synced ⇒ connecting state, not the no-sessions empty state", () => {
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hubWithSynced(false) } },
    });
    expect(wrapper.find(".empty h2").text()).toBe("Connecting…");
    expect(wrapper.find("ul.agent-list").exists()).toBe(false);
  });

  it("empty cards + synced ⇒ the no-sessions empty state (unchanged)", () => {
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hubWithSynced(true) } },
    });
    expect(wrapper.find(".empty h2").text()).toBe("No pi sessions connected");
  });

  it("empty cards + never synced + reconnecting (hub unreachable) ⇒ the no-sessions empty state", () => {
    const hub: HubHandle = {
      state: ref({ agents: new Map(), synced: false, conn: "reconnecting" } as unknown as HubState),
      dispatch: () => {},
    };
    const wrapper = mount(AgentList, {
      props: { cards: [], selectedKey: null, filter: "" },
      global: { provide: { [HUB_CTX as symbol]: hub } },
    });
    expect(wrapper.find(".empty h2").text()).toBe("No pi sessions connected");
  });
});

describe("agents.css 搜索框放大镜与文字防重叠(2026-10 手机现场:--fs-scale 放大字号时图标压字)", () => {
  const css = readFileSync(
    resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/agents.css"),
    "utf8",
  );
  const rule = (selector: string): string => {
    const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`).exec(css);
    return m?.[0] ?? "";
  };

  it("图标 left 与输入框 padding-left 都随 --fs-scale 等比缩放(base.css 的 .icon 宽 = 16px·scale)", () => {
    // 写死 px 时:图标宽 = 16·scale 而文字起点恒为 32px,scale ≥1.4 必相交(实测 1.5 叠 1px、2.0 叠 9px)
    expect(rule(".search .icon")).toMatch(/left:\s*calc\(10px \* var\(--fs-scale, 1\)\)/);
    expect(rule(".search .input")).toMatch(/padding-left:\s*calc\(32px \* var\(--fs-scale, 1\)\)/);
    // 不得回退为无缩放的写死值
    expect(rule(".search .icon")).not.toMatch(/left:\s*10px/);
    expect(rule(".search .input")).not.toMatch(/padding-left:\s*32px/);
  });

  it("图标绝对定位但不可点(pointer-events:none),容器保持 flex 居中(图标垂直居中来自 flex 静态位)", () => {
    expect(rule(".search")).toMatch(/display:\s*flex/);
    expect(rule(".search")).toMatch(/align-items:\s*center/);
    expect(rule(".search .icon")).toMatch(/position:\s*absolute/);
    expect(rule(".search .icon")).toMatch(/pointer-events:\s*none/);
  });
});
