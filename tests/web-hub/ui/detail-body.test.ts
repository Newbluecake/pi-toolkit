// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DetailBody from "../../../src/web-hub/ui/src/components/body/DetailBody.vue";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

/**
 * `DetailBody.vue` (vue-plan.md v2.1 §1.1/§3.2/§5.2 — P4's takeover of the P0→P4 seam;
 * fleet-drawer plan v2 §6.3 — F6 换成 FleetSummaryBar): proves the seam itself works —
 * `contracts.ts`'s `DetailBodyProps`/`DetailBodyEmits` really do drive `FleetSummaryBar.vue` +
 * `Transcript.vue`, and every emit from either child bubbles through unchanged. Deliberately
 * does *not* re-test `FleetSummaryBar.vue`/`Transcript.vue`'s own behavior (that's
 * `fleet-tree.test.ts`/`transcript.test.ts`'s job) — only the wiring between them.
 */

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

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

function agentWith(
  entries: Record<string, unknown>[],
  fleet: Record<string, unknown>[] = [],
  omitted?: { active: number; terminal: number },
): AgentState {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    {
      event: "history",
      data: { agentKey: "agent-a", entries, tailMessages: [], fromSeq: entries.length, hasMore: false },
    },
    {
      event: "fleet",
      data: { agentKey: "agent-a", runs: fleet, ...(omitted === undefined ? {} : { omitted }) },
    },
  ]);
  return s.agents.get("agent-a") as unknown as AgentState;
}

describe("DetailBody.vue (P0→P4 seam)", () => {
  it("renders a .detail-body wrapper containing the Conversation landmark", async () => {
    const agent = agentWith([]);
    const wrapper = mount(DetailBody, { props: { agent, now: 0, following: true, narrow: false } });
    expect(wrapper.find("div.detail-body").exists()).toBe(true);
    expect(wrapper.find("[aria-label='Conversation']").exists()).toBe(true);
    expect(wrapper.findComponent({ name: "Transcript" }).exists()).toBe(true);
  });

  it("does not duplicate the activity rail inside the transcript subtree", () => {
    const wrapper = mount(DetailBody, {
      props: { agent: agentWith([], [{ runId: "r1" }]), now: 0, following: true, narrow: false },
    });
    expect(wrapper.find(".activity-rail").exists()).toBe(false);
    expect(wrapper.findComponent({ name: "Transcript" }).exists()).toBe(true);
  });

  it("renders no fleet toggle when there are no subagent rows", async () => {
    const agent = agentWith([]);
    const wrapper = mount(DetailBody, { props: { agent, now: 0, following: true, narrow: false } });
    expect(wrapper.find(".fleet-summary-bar").exists()).toBe(false);
  });

  it("forwards load-older / update:following / new-count from Transcript to its own emit", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      parentId: null,
      type: "message",
      timestamp: new Date(1000 + i).toISOString(),
      message: { role: "user", content: `m${i}`, timestamp: 1000 + i },
    }));
    const agent = agentWith(entries as Record<string, unknown>[]);
    const wrapper = mount(DetailBody, { props: { agent, now: 0, following: true, narrow: false } });

    await wrapper.findComponent({ name: "Transcript" }).vm.$emit("load-older");
    expect(wrapper.emitted("load-older")).toBeTruthy();

    await wrapper.findComponent({ name: "Transcript" }).vm.$emit("update:following", false);
    expect(wrapper.emitted("update:following")).toEqual([[false]]);

    await wrapper.findComponent({ name: "Transcript" }).vm.$emit("new-count", 5);
    expect(wrapper.emitted("new-count")).toEqual([[5]]);
  });

  it("keys both children by agent.key so switching agents remounts them fresh", async () => {
    const agentA = agentWith([]);
    const wrapper = mount(DetailBody, { props: { agent: agentA, now: 0, following: true, narrow: false } });
    const txBefore = wrapper.findComponent({ name: "Transcript" });
    const s2 = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("agent-b")] },
      { event: "subscribing", data: { agentKey: "agent-b", clientId: "c1" } },
      { event: "history", data: { agentKey: "agent-b", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
    ]);
    const agentB = s2.agents.get("agent-b") as unknown as AgentState;
    await wrapper.setProps({ agent: agentB });
    const txAfter = wrapper.findComponent({ name: "Transcript" });
    expect(txBefore.vm).not.toBe(txAfter.vm);
  });

  // session-switch plan §1.4 (E1-6): the seam opts the MAIN-session Transcript into scroll memory.
  it("passes memoryKey === agent.key to the main-session Transcript (scroll-memory opt-in)", async () => {
    const agent = agentWith([]);
    const wrapper = mount(DetailBody, { props: { agent, now: 0, following: true, narrow: false } });
    expect(wrapper.findComponent({ name: "Transcript" }).props("memoryKey")).toBe("agent-a");
  });

  it("reducer → AgentDetail: omitted-only rows keep the rail and drawer reachable, then empty clears both", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const wrapper = mount(AgentDetail, {
      props: { agent: agentWith([], [], { active: 2, terminal: 3 }), now: 1000, narrow: false },
      attachTo: document.body,
      global: {
        provide: {
          [HUB_CTX as symbol]: { state: ref({ control: false }), selectRun: vi.fn(), control: undefined },
        },
      },
    });
    try {
      const button = wrapper.get('[data-panel="agent"].fleet-summary-bar');
      expect(button.attributes("aria-expanded")).toBe("false");
      expect(wrapper.get("#fleet-drawer").attributes("data-open")).toBeUndefined();
      await button.trigger("click", { detail: 1 });
      expect(wrapper.attributes("data-drawer-open")).toBeDefined();
      const hints = wrapper.findAll("#fleet-drawer .fleet-omitted");
      expect(hints).toHaveLength(2);
      expect(hints[0]!.text()).toContain("2");
      expect(hints[1]!.text()).toContain("3");

      await wrapper.setProps({ agent: agentWith([]) });
      expect(wrapper.find(".activity-rail").exists()).toBe(false);
      expect(wrapper.find("#fleet-drawer").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
      document.body.textContent = "";
    }
  });
});
