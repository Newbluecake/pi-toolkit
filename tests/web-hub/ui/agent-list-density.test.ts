// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import { toAgentCardView } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  LIST_DENSITY_STORAGE_KEY,
  parseListDensity,
  resetListDensityForTests,
  useListDensity,
} from "../../../src/web-hub/ui/src/composables/useListDensity.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

const mem = () => {
  const m = new Map<string, string>();
  return {
    m,
    storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) },
  };
};
const agent = (status: Record<string, unknown>): AgentState =>
  ({
    key: "a",
    card: { cwd: "/home/u/proj", model: "k3", costUsd: 3.5 },
    session: { name: "认知进化" },
    status,
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  }) as unknown as AgentState;
function mountCard(
  status: Record<string, unknown>,
  cardExtra: Record<string, unknown> = {},
  dialogs?: unknown,
  prompts?: unknown[],
  fleet?: unknown[],
) {
  const a = agent(status);
  Object.assign(a.card as object, cardExtra);
  const m = a as unknown as Record<string, unknown>;
  if (dialogs !== undefined) m["dialogs"] = dialogs;
  if (prompts !== undefined) m["prompts"] = prompts;
  if (fleet !== undefined) m["fleet"] = fleet;
  const card = toAgentCardView(a, (k) => k);
  const hub = {
    state: ref({
      agents: new Map([["a", a]]),
      hub: { caps: ["xs.v1", "xs.alias.v1"] },
    } as unknown as HubState),
    dispatch() {},
  } as HubHandle;
  return mount(AgentCard, { props: { card, selected: false }, global: { provide: { [HUB_CTX as symbol]: hub } } });
}
const xs = { joined: true, receive: "wake", alias: "小z" };

beforeEach(resetListDensityForTests);

describe("list density preference", () => {
  it("defaults to compact; only the exact token detailed switches", () => {
    expect(parseListDensity(null)).toBe("compact");
    expect(parseListDensity("junk")).toBe("compact");
    expect(parseListDensity("detailed")).toBe("detailed");
    expect(useListDensity({ storage: mem().storage }).density.value).toBe("compact");
    resetListDensityForTests();
  });
  it("toggle persists and reload restores", () => {
    const { m, storage } = mem();
    const h = useListDensity({ storage });
    h.toggle();
    expect(m.get(LIST_DENSITY_STORAGE_KEY)).toBe("detailed");
    resetListDensityForTests();
    expect(useListDensity({ storage }).density.value).toBe("detailed");
    h.toggle();
    expect(m.get(LIST_DENSITY_STORAGE_KEY)).toBe("compact");
  });
  it("throwing storage fails open to compact", () => {
    const bad = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    resetListDensityForTests();
    const h = useListDensity({ storage: bad });
    expect(h.density.value).toBe("compact");
    h.toggle();
    expect(h.density.value).toBe("detailed");
  });
});

describe("AgentCard density rendering", () => {
  it("compact (default): directory + alias + title only", () => {
    const w = mountCard({ xs, xsInbox: { unread: 2 }, contextPercent: 22 });
    expect(w.find(".agent-card").attributes("data-density")).toBe("compact");
    expect(w.find(".agent-title").exists()).toBe(true);
    expect(w.find(".agent-session").text()).toBe("认知进化");
    expect(w.find(".chip-xs-alias").exists()).toBe(true);
    expect(w.find(".chip-xs-unread").exists()).toBe(true);
    for (const sel of [".agent-cost", ".agent-meta", ".meter", ".chip-xs", ".privacy-lock-btn", ".chip-xs-channels"]) {
      if (sel === ".chip-xs") expect(w.find(".chip-xs:not(.chip-xs-alias):not(.chip-xs-unread)").exists()).toBe(false);
      else expect(w.find(sel).exists()).toBe(false);
    }
    expect(w.text()).not.toContain("TUI");
    w.unmount();
  });
  it("compact without alias: row 1 has the directory only", () => {
    const w = mountCard({});
    expect(w.find(".chip-xs-alias").exists()).toBe(false);
    expect(w.find(".agent-chips").exists()).toBe(false);
    w.unmount();
  });
  it("detailed: full card with cost/kind chip, flips live", async () => {
    const w = mountCard({});
    useListDensity({ storage: mem().storage }).setDensity("detailed");
    await nextTick();
    expect(w.find(".agent-card").attributes("data-density")).toBe("detailed");
    expect(w.find(".agent-cost").exists()).toBe(true);
    expect(w.text()).toContain("TUI");
    w.unmount();
  });
  it("compact running: live state pill + data-st running (dot halo is keyed off it)", () => {
    const w = mountCard({ busy: true });
    expect(w.find(".agent-card").attributes("data-st")).toBe("running");
    expect(w.find('[data-compact="state"]').text()).toContain("common.status.running");
    expect(w.find(".agent-row1 > .dot").exists()).toBe(true);
    w.unmount();
  });
  it("compact idle: no state pill, hollow dot", () => {
    const w = mountCard({});
    expect(w.find(".agent-card").attributes("data-st")).toBe("idle");
    expect(w.find('[data-compact="state"]').exists()).toBe(false);
    expect(w.find(".agent-row1 > .dot").classes()).toContain("dot-hollow");
    w.unmount();
  });
  it("compact waiting (open prompt): waiting state pill", () => {
    const w = mountCard({}, {}, undefined, [{ id: "p" }]);
    expect(w.find(".agent-card").attributes("data-st")).toBe("waiting");
    expect(w.find('[data-compact="state"]').exists()).toBe(true);
    w.unmount();
  });
  it("compact ask_user dialog: needs-answer pill", () => {
    const w = mountCard({}, {}, { open: [{ id: "d" }] });
    expect(w.find('[data-compact="answer"]').exists()).toBe(true);
    w.unmount();
  });
  it("sub-agent count badge only when > 0", () => {
    const none = mountCard({}, {}, undefined, undefined, [{ status: "running", terminal: true }, { status: "done" }]);
    expect(none.find('[data-compact="sub"]').exists()).toBe(false);
    none.unmount();
    const w = mountCard({}, {}, undefined, undefined, [
      { status: "running" },
      { status: "running" },
      { status: "running" },
    ]);
    const b = w.find('[data-compact="sub"]');
    expect(b.text()).toBe("3");
    expect(b.attributes("title")).toBe("3 running");
    w.unmount();
  });
  it("idle main session with running background work counts as running (sub-agents / bash jobs)", () => {
    const sub = mountCard({}, {}, undefined, undefined, [{ status: "running" }]);
    expect(sub.find(".agent-card").attributes("data-st")).toBe("running");
    expect(sub.find('[data-compact="state"]').exists()).toBe(true);
    sub.unmount();
    const done = mountCard({}, {}, undefined, undefined, [{ status: "done", terminal: true }]);
    expect(done.find(".agent-card").attributes("data-st")).toBe("idle");
    done.unmount();
  });
});
