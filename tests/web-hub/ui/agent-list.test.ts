// @vitest-environment happy-dom
/**
 * `AgentList.vue` / `AgentCard.vue` (ui-design.md §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 —
 * P3). Filter substring matching, the live vs. "Stale & Offline" grouping, the empty state, and
 * `aria-current` on the selected card.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AgentList from "../../../src/web-hub/ui/src/components/agents/AgentList.vue";
import type { AgentCardView } from "../../../src/web-hub/ui/src/types.js";

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
