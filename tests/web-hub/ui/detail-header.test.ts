// @vitest-environment happy-dom
/**
 * `DetailHeader.vue` (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3). Title fallback
 * chain (session name → sessionId prefix → "(no session name)"), the back button's `narrow`
 * gating, and the context/cost metrics.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

function agent(over: Partial<AgentState> = {}): AgentState {
  return {
    key: "agent-1",
    card: { agentKey: "agent-1", kind: "tui", pid: 123, cwd: "/home/bluecake/ai/pi-toolkit", state: "live" },
    down: false,
    session: {
      sessionId: "01a0d892-5c1e-7a40-9e2b-4f6d0c8a1b37",
      cwd: "/home/bluecake/ai/pi-toolkit",
      name: "web-hub Vue rewrite",
      model: { provider: "cr-anthropic", id: "claude-opus-5-5" },
      thinkingLevel: "high",
      mode: "tui",
    },
    status: {
      busy: true,
      pending: false,
      costUsd: 195.54,
      subagentCostUsd: 36.17,
      contextUsage: { tokens: 124_000, contextWindow: 200_000, percent: 62 },
    },
    prompts: [],
    fleet: [],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
    ...over,
  } as unknown as AgentState;
}

describe("DetailHeader.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("titles from the session name when present", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wrapper.find(".detail-title").text()).toBe("web-hub Vue rewrite");
  });

  it("falls back to the sessionId prefix, then '(no session name)'", () => {
    const noName = mount(DetailHeader, {
      props: {
        agent: agent({ session: { sessionId: "01a0d892abcd", cwd: "/x", mode: "tui" } as never }),
        narrow: false,
      },
    });
    expect(noName.find(".detail-title").text()).toBe("01a0d892");

    const noSession = mount(DetailHeader, { props: { agent: agent({ session: undefined }), narrow: false } });
    expect(noSession.find(".detail-title").text()).toBe("(no session name)");
  });

  it("shows a status pill reflecting the agent's visual state", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wrapper.find(".pill").attributes("data-st")).toBe("running");
    expect(wrapper.find(".pill").text()).toBe("Working");
  });

  it("renders the back button only when narrow", () => {
    const narrow = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    expect(narrow.find(".detail-back").exists()).toBe(true);
    const wide = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    expect(wide.find(".detail-back").exists()).toBe(false);
  });

  it("emits back when the back button is clicked", async () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: true } });
    await wrapper.find(".detail-back").trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
  });

  it("renders the context percent and cost with the sub-agent cost aside", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    const metrics = wrapper.find(".metrics").text();
    expect(metrics).toContain("62%");
    expect(metrics).toContain("$195.54");
    expect(metrics).toContain("$36.17");
  });

  it("session summary shows the short cwd and model/thinking level", () => {
    const wrapper = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    const summary = wrapper.find(".session-sum").text();
    expect(summary).toContain("ai/pi-toolkit");
    expect(summary).toContain("cr-anthropic/claude-opus-5-5 · high");
  });
});
