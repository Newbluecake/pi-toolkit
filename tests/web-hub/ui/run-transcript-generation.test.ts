// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import RunTranscript from "../../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import { WEB_MESSAGE_SPEED_ENTRY_TYPE } from "../../../src/web-hub/protocol/message-generation.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

type Msg = { event: string; data: any };
const run = (msgs: Msg[], state = initialState(null)) => msgs.reduce((s, msg) => reduce(s, msg), state);
const message = (cost = false) => ({
  id: "m1",
  parentId: null,
  type: "message",
  timestamp: new Date(1000).toISOString(),
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1000,
    ...(cost ? { usage: { cost: { total: 0.5 } } } : {}),
  },
});
const speed = (mid = "m1") => ({
  id: "c1",
  parentId: null,
  type: "custom",
  timestamp: new Date(1100).toISOString(),
  customType: WEB_MESSAGE_SPEED_ENTRY_TYPE,
  data: { piToolkitGeneration: { v: 1, mid, tokens: 10, genMs: 500, deltaCount: 2 } },
});
const wire = (entries: unknown[]) => entries.map(projectSessionEntry).filter((entry) => entry !== undefined);
const initial = () =>
  run([
    {
      event: "agents",
      data: [
        {
          agentKey: "A",
          kind: "tui",
          pid: 1,
          cwd: "/tmp/p",
          state: "live",
          pluginVersion: "1",
          outdated: false,
          prompts: [],
        },
      ],
    },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
  ]);
function select(state: ReturnType<typeof initial>, runId: string, entries: unknown[]) {
  return run(
    [
      { event: "run_select", data: { agentKey: "A", runId } },
      { event: "run_subscribing", data: { agentKey: "A", runId, at: 100, retries: 0 } },
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId,
          entries: wire(entries),
          tailMessages: [],
          tapId: "t1",
          fromSeq: 2,
          hasMore: false,
          terminal: false,
          live: true,
          status: "running",
        },
      },
    ],
    state,
  );
}
const agent = (state: ReturnType<typeof initial>) => state.agents.get("A") as unknown as AgentState;
const mounted: Array<ReturnType<typeof mount>> = [];
function show(state: ReturnType<typeof initial>) {
  const wrapper = mount(RunTranscript, { props: { agent: agent(state), now: 5000 }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe("run transcript generation map integration", () => {
  it("renders reducer-projected history speed and removes it when metadata is deleted", async () => {
    const state = select(initial(), "r1", [message(), speed()]);
    expect(agent(state).runTx?.generation?.get("m1")).toBeDefined();
    const wrapper = show(state);
    expect(wrapper.text()).toContain("20.0 tokens/s");
    const replaced = run(
      [
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: "r1",
            entries: wire([message()]),
            tailMessages: [],
            tapId: "t1",
            fromSeq: 2,
            hasMore: false,
            terminal: false,
            live: true,
            status: "running",
          },
        },
      ],
      state,
    );
    await wrapper.setProps({ agent: agent(replaced) });
    expect(wrapper.text()).not.toContain("tokens/s");
  });
  it("does not render an unmatched mid", () => {
    const wrapper = show(select(initial(), "r1", [message(), speed("other")]));
    expect(wrapper.text()).toContain("hello");
    expect(wrapper.text()).not.toContain("tokens/s");
  });
  it("switches runs without leaking old speed even with the same message id", async () => {
    const first = select(initial(), "r1", [message(), speed()]);
    const wrapper = show(first);
    expect(wrapper.text()).toContain("20.0 tokens/s");
    await wrapper.setProps({ agent: agent(select(first, "r2", [message()])) });
    expect(wrapper.text()).toContain("hello");
    expect(wrapper.text()).not.toContain("tokens/s");
  });
  it("does not show speed on a streaming message, even if it carries speed metadata", () => {
    const state = select(initial(), "r1", []);
    const streaming = run(
      [
        {
          event: "run_ev",
          data: {
            agentKey: "A",
            runId: "r1",
            tapId: "t1",
            seq: 2,
            e: {
              type: "message_start",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "streaming" }],
                timestamp: 2000,
                piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
              },
            },
          },
        },
      ],
      state,
    );
    const wrapper = show(streaming);
    expect(wrapper.text()).toContain("streaming");
    expect(wrapper.text()).not.toContain("tokens/s");
  });
  it("renders cost and speed independently", () => {
    const costOnly = show(select(initial(), "r1", [message(true)]));
    expect(costOnly.text()).toContain("$0.5000");
    expect(costOnly.text()).not.toContain("tokens/s");
    const speedOnly = show(select(initial(), "r1", [message(), speed()]));
    expect(speedOnly.text()).toContain("20.0 tokens/s");
    expect(speedOnly.text()).not.toContain("$");
  });
});
