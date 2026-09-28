// @vitest-environment happy-dom
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import Transcript from "../../../src/web-hub/ui/src/components/transcript/Transcript.vue";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

/**
 * `Transcript.vue` (vue-plan.md v2.1 §3.6/§5.2/§5.3 — P4). Builds real `AgentState`s through
 * `@logic/state.js`'s actual `reduce()`/`initialState()` (same helper pattern as
 * `tests/web-hub/web/state.test.ts`) rather than hand-rolled fixtures, so the transcript-window/
 * follow-scroll/rendering wiring is exercised against the same shapes the real reducer produces.
 *
 * Known happy-dom limitation (not a product bug): `window.matchMedia` in happy-dom always
 * reports `matches: false` regardless of `innerWidth` (verified empirically), so
 * `useMedia(window, "(max-width: 480px)")` never resolves "mobile" in this test environment —
 * every test below therefore exercises the desktop 200-item default window, not the mobile
 * 80-item one (that default is already covered directly, without any DOM, by P1's
 * `transcript-window.test.ts::defaultWindowSize`).
 */

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

function card(agentKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentKey,
    kind: "tui",
    pid: 1,
    cwd: "/tmp/p",
    state: "live",
    pluginVersion: "1.0.0",
    outdated: false,
    prompts: [],
    ...extra,
  };
}

function userMsgEntry(id: string, ts: number, text: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function assistantTextEntry(id: string, ts: number, text: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts, model: "claude-sonnet-5" },
  };
}

/** Loads `entries` as the agent's full history (mirrors a real hub `history` frame). */
function agentWith(entries: Record<string, unknown>[], historyExtra: Record<string, unknown> = {}): AgentState {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    {
      event: "history",
      data: {
        agentKey: "agent-a",
        entries,
        tailMessages: [],
        fromSeq: entries.length,
        hasMore: false,
        ...historyExtra,
      },
    },
  ]);
  return s.agents.get("agent-a") as unknown as AgentState;
}

function manyUserMessages(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => userMsgEntry(`e${i}`, 1_700_000_000_000 + i * 1000, `message ${i}`));
}

async function mountTx(agent: AgentState, extraProps: Record<string, unknown> = {}): Promise<VueWrapper> {
  const wrapper = mount(Transcript, { props: { agent, following: true, narrow: false, ...extraProps } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe("Transcript.vue — windowing (ui-design.md §6.6, plan §3.6)", () => {
  it("caps mounted .tx-item at 300 for a 1000-message agent and shows the earlier-hidden affordance", async () => {
    const agent = agentWith(manyUserMessages(1000));
    const wrapper = await mountTx(agent);
    const mounted = wrapper.findAll(".tx-item").length;
    expect(mounted).toBeLessThanOrEqual(300);
    expect(mounted).toBeGreaterThan(0);
    expect(wrapper.find(".tx-window-gap").exists()).toBe(true);
    expect(wrapper.text()).toMatch(/earlier messages hidden/);
    // the tail (most recent) messages are the ones mounted by default
    expect(wrapper.text()).toContain("message 999");
    expect(wrapper.text()).not.toContain("message 0<"); // sentinel: never renders as HTML anyway
  });

  it("'Show earlier' reveals more and keeps the mounted count within the 300 cap", async () => {
    const agent = agentWith(manyUserMessages(1000));
    const wrapper = await mountTx(agent);
    const before = wrapper.findAll(".tx-item").length;
    await wrapper.get(".tx-window-gap").trigger("click");
    const after = wrapper.findAll(".tx-item").length;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(300);
  });

  it("small agents (fewer than the default window) mount every item, no gap affordance", async () => {
    const agent = agentWith(manyUserMessages(5));
    const wrapper = await mountTx(agent);
    expect(wrapper.findAll(".tx-item").length).toBe(5);
    expect(wrapper.find(".tx-window-gap").exists()).toBe(false);
  });
});

describe("Transcript.vue — item rendering", () => {
  it("renders user, assistant, custom, compaction, model_change and orphan-tool entries", async () => {
    const entries: Record<string, unknown>[] = [
      userMsgEntry("u1", 1000, "hello there"),
      assistantTextEntry("a1", 2000, "hi, **friend**"),
      {
        id: "c1",
        parentId: null,
        type: "compaction",
        timestamp: new Date(3000).toISOString(),
        summary: "compacted summary",
      },
      {
        id: "m1",
        parentId: null,
        type: "model_change",
        timestamp: new Date(4000).toISOString(),
        provider: "cr-anthropic",
        modelId: "claude-sonnet-5",
      },
      {
        id: "cu1",
        parentId: null,
        type: "custom_message",
        timestamp: new Date(5000).toISOString(),
        customType: "subagent:notice",
        content: "run finished",
      },
      {
        id: "tr1",
        parentId: null,
        type: "message",
        timestamp: new Date(6000).toISOString(),
        message: { role: "toolResult", toolCallId: "orphan-1", toolName: "bash", content: "done", timestamp: 6000 },
      },
    ];
    const agent = agentWith(entries);
    const wrapper = await mountTx(agent);
    expect(wrapper.get(".bubble").text()).toBe("hello there");
    expect(wrapper.get(".msg-assistant strong").text()).toBe("friend");
    expect(wrapper.text()).toContain("compacted summary");
    expect(wrapper.text()).toContain("cr-anthropic/claude-sonnet-5");
    expect(wrapper.get(".msg-custom .kind").text()).toContain("subagent:notice");
    expect(wrapper.get(".msg-tool .tool-name").text()).toBe("bash");
  });

  it("a streaming assistant message renders with a Streaming pill and caret", async () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("agent-a")] },
      { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
      { event: "history", data: { agentKey: "agent-a", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
    ]);
    s = reduce(s, {
      event: "ev",
      data: { agentKey: "agent-a", seq: 0, e: { type: "message_start", message: { role: "assistant", content: [] } } },
    });
    s = reduce(s, {
      event: "ev",
      data: {
        agentKey: "agent-a",
        seq: 1,
        e: { type: "message_update", contentIndex: 0, kind: "text", delta: "Working on it" },
      },
    });
    const agent = s.agents.get("agent-a") as unknown as AgentState;
    const wrapper = await mountTx(agent);
    expect(wrapper.find(".pill[data-st='running']").text()).toContain("Streaming");
    expect(wrapper.find(".caret").exists()).toBe(true);
    expect(wrapper.get(".msg-assistant").attributes("aria-busy")).toBe("true");
  });

  it("assistant stopReason=error renders the error line via TxError", async () => {
    const entries = [
      {
        id: "a-err",
        parentId: null,
        type: "message",
        timestamp: new Date(1000).toISOString(),
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "model overloaded",
          timestamp: 1000,
        },
      },
    ];
    const agent = agentWith(entries);
    const wrapper = await mountTx(agent);
    const err = wrapper.get(".msg-error");
    expect(err.attributes("role")).toBe("alert");
    expect(err.text()).toContain("model overloaded");
  });
});

describe("Transcript.vue — follow / new-count / load-older (ui-design.md §5.4)", () => {
  it("emits load-older when hasMore and the window is already at the earliest local item", async () => {
    const agent = agentWith(manyUserMessages(3), { hasMore: true, oldestEntryId: "e0" });
    const wrapper = await mountTx(agent);
    expect(wrapper.find(".tx-window-gap").exists()).toBe(false); // no *local* hidden items
    await wrapper.get("button.tx-older").trigger("click");
    expect(wrapper.emitted("load-older")).toBeTruthy();
  });

  it("shows a loading-older divider while agent.paging is true, instead of the button", async () => {
    const agent = agentWith(manyUserMessages(3), { hasMore: true, oldestEntryId: "e0" });
    const paging = { ...agent, paging: true };
    const wrapper = await mountTx(paging);
    expect(wrapper.find("button.tx-older").exists()).toBe(false);
    expect(wrapper.text()).toMatch(/[Ll]oading older/);
  });

  it("turning `following` on jumps back to the latest window (resets start to the tail)", async () => {
    const agent = agentWith(manyUserMessages(1000));
    const wrapper = await mountTx(agent, { following: false });
    await wrapper.get(".tx-window-gap").trigger("click"); // reveal some earlier items while not following — no-op safety check
    await wrapper.setProps({ following: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("message 999");
  });

  it("emits update:following(true) from the Jump-to-latest gap after revealing enough earlier items", async () => {
    const agent = agentWith(manyUserMessages(1000));
    const wrapper = await mountTx(agent, { following: false });
    await wrapper.get(".tx-window-gap").trigger("click"); // "Show earlier" — may also create a "hidden after" gap
    const gaps = wrapper.findAll(".tx-window-gap");
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    await gaps[gaps.length - 1]!.trigger("click"); // the trailing gap (if any) is always "jump to latest"
    const emitted = wrapper.emitted("update:following");
    expect(emitted).toBeTruthy();
    expect(emitted![emitted!.length - 1]).toEqual([true]);
  });
});
