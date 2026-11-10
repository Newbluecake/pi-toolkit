// @vitest-environment happy-dom
/**
 * Transcript.vue's entry-level `v-memo` (2026-11-03 全量重渲染修复 — the second half of the
 * sub-agent detail-page freeze: every runTx frame rebuilt `build` and re-rendered ALL mounted
 * entries, ToolCards included). The memo key is `build.renderKeys[i]` (entries.ts's prepared
 * per-entry content digest) + entry.type + locale; the streaming tail entry (constant renderKey
 * "streaming") always misses so it keeps updating per chunk.
 *
 * These tests pin BOTH directions of correctness:
 *  - a frame that leaves an entry's digest unchanged must SKIP its subtree (no re-render —
 *    observed through a global mixin's `updated` hook, which only fires on a real patch);
 *  - a digest change (tool result landing), the streaming tail, and a runtime locale switch
 *    must still re-render — the memo must never freeze live content.
 */
import { mount, type VueWrapper } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import { WEB_MESSAGE_SPEED_ENTRY_TYPE } from "../../../src/web-hub/protocol/message-generation.js";
import Transcript from "../../../src/web-hub/ui/src/components/transcript/Transcript.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

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

function userMsgEntry(id: string, ts: number, text: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  };
}

function assistantToolCallEntry(id: string, ts: number, toolCallId: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { cmd: "ls" } }],
      timestamp: ts,
      model: "claude-sonnet-5",
    },
  };
}

function toolResultEntry(id: string, ts: number, toolCallId: string, content: string): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: { role: "toolResult", toolCallId, toolName: "bash", content, timestamp: ts },
  };
}

function compactionEntry(id: string, ts: number): Record<string, unknown> {
  return {
    id,
    parentId: null,
    type: "compaction",
    timestamp: new Date(ts).toISOString(),
    summary: "compacted summary",
  };
}

/** Loads `entries` as the agent's full history (mirrors a real hub `history` frame). */
function agentWith(entries: Record<string, unknown>[]): AgentState {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("agent-a")] },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    {
      event: "history",
      data: { agentKey: "agent-a", entries, tailMessages: [], fromSeq: entries.length, hasMore: false },
    },
  ]);
  return s.agents.get("agent-a") as unknown as AgentState;
}

/** Per-component-name `updated` counts — a v-memo cache HIT means the subtree is never patched. */
const updateCounts = new Map<string, number>();
const updatedOf = (name: string): number => updateCounts.get(name) ?? 0;
const countingMixin = {
  updated(this: { $options: { __name?: string; name?: string } }): void {
    const name = this.$options.__name ?? this.$options.name ?? "?";
    updateCounts.set(name, (updateCounts.get(name) ?? 0) + 1);
  },
};

async function mountTx(agent: AgentState): Promise<VueWrapper> {
  const wrapper = mount(Transcript, {
    props: { agent, following: true, narrow: false },
    global: { mixins: [countingMixin] },
  });
  await wrapper.vm.$nextTick();
  updateCounts.clear(); // count only post-mount patches
  return wrapper;
}

beforeEach(() => {
  resetLangForTests();
});

describe("Transcript.vue — v-memo render keys (2026-11-03 全量重渲染修复)", () => {
  it("an append frame re-renders ONLY the new entry — finalized ToolCard/TxAssistant subtrees skip", async () => {
    const entries = [assistantToolCallEntry("a1", 1_000, "t1"), toolResultEntry("r1", 2_000, "t1", "paired result")];
    const wrapper = await mountTx(agentWith(entries));
    expect(wrapper.text()).toContain("paired result"); // baseline: card rendered

    // a runTx frame lands one new user message — the finalized entries' digests are unchanged
    const next = agentWith([...entries, userMsgEntry("u9", 3_000, "fresh tail message")]);
    await wrapper.setProps({ agent: next });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("fresh tail message"); // the new entry DID render
    expect(updatedOf("ToolCard")).toBe(0); // …without touching the finalized tool card
    expect(updatedOf("TxAssistant")).toBe(0);
  });

  it("a landing tool result busts the memo (renderKey digest) — the card updates in place", async () => {
    const entries = [assistantToolCallEntry("a1", 1_000, "t1")]; // pending: no result yet
    const wrapper = await mountTx(agentWith(entries));

    const next = agentWith([...entries, toolResultEntry("r1", 2_000, "t1", "paired result")]);
    await wrapper.setProps({ agent: next });
    await wrapper.vm.$nextTick();

    expect(updatedOf("TxAssistant")).toBeGreaterThan(0); // digest `t1=p` ⇒ `t1=r` — memo miss
    expect(wrapper.text()).toContain("paired result");
  });

  it("refreshes the same assistant DOM when only history generation metadata is added, changed or removed", async () => {
    const message = {
      id: "a1",
      parentId: null,
      type: "message",
      timestamp: new Date(1_000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "stable answer" }], timestamp: 1_000 },
    };
    const other = assistantToolCallEntry("a2", 2_000, "t2");
    const history = (tokens?: number): AgentState => {
      const metadata =
        tokens === undefined
          ? []
          : [
              {
                id: "meta1",
                parentId: "a1",
                type: "custom",
                timestamp: new Date(1_500).toISOString(),
                customType: WEB_MESSAGE_SPEED_ENTRY_TYPE,
                data: { piToolkitGeneration: { v: 1, mid: "a1", tokens, genMs: 500, deltaCount: 2 } },
              },
            ];
      return agentWith([message, ...metadata, other].map((entry) => projectSessionEntry(entry)!));
    };
    const wrapper = await mountTx(history());
    expect(wrapper.text()).toContain("stable answer");
    expect(wrapper.text()).not.toContain("tokens/s");
    await wrapper.setProps({ agent: history(10) });
    expect(wrapper.text()).toContain("20.0 tokens/s");
    expect(updatedOf("TxAssistant")).toBe(1);
    updateCounts.clear();
    await wrapper.setProps({ agent: history(15) });
    expect(wrapper.text()).toContain("30.0 tokens/s");
    expect(wrapper.text()).not.toContain("20.0 tokens/s");
    expect(updatedOf("TxAssistant")).toBe(1);
    updateCounts.clear();
    await wrapper.setProps({ agent: history() });
    expect(wrapper.text()).not.toContain("tokens/s");
    expect(updatedOf("TxAssistant")).toBe(1);
    wrapper.unmount();
  });

  it("the streaming tail entry always re-renders despite its constant renderKey", async () => {
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
        e: { type: "message_update", contentIndex: 0, kind: "text", delta: "chunk one" },
      },
    });
    const wrapper = await mountTx(s.agents.get("agent-a") as unknown as AgentState);
    expect(wrapper.text()).toContain("chunk one");

    s = reduce(s, {
      event: "ev",
      data: {
        agentKey: "agent-a",
        seq: 2,
        e: { type: "message_update", contentIndex: 0, kind: "text", delta: " and more" },
      },
    });
    await wrapper.setProps({ agent: s.agents.get("agent-a") as unknown as AgentState });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("chunk one and more"); // the streaming entry did NOT freeze
  });

  it("a runtime locale switch busts the memo — labels evaluated in Transcript's own template update", async () => {
    const wrapper = await mountTx(agentWith([compactionEntry("c1", 1_000)]));
    expect(wrapper.text()).toContain("Context compacted");
    setLangOverride("zh");
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("上下文已压缩");
    resetLangForTests();
  });
});
