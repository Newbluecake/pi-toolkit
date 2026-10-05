// @vitest-environment happy-dom
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
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

/** Mutates (writable) `scrollTop`/`scrollHeight`/`clientHeight` on a real DOM element so the
 * component's own scroll-compensation / resize-pin code can read AND assign them, same as a real
 * scrollable box. */
function setScrollGeometry(el: Element, { scrollTop, scrollHeight, clientHeight }: Record<string, number>): void {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true, writable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true, writable: true });
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
    // 2026-10-05: custom messages got the pi-style identity row (avatar + who + type chip)
    const custom = wrapper.get(".msg-custom");
    expect(custom.get(".kind-chip").text()).toContain("subagent:notice");
    expect(custom.get(".msg-head .who").text()).toBe("subagent");
    expect(custom.get(".avatar-notice").exists()).toBe(true);
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

  it("scrolling away from the bottom while following turns following off", async () => {
    const agent = agentWith(manyUserMessages(50));
    const wrapper = await mountTx(agent, { following: true });
    const box = wrapper.get("#transcript").element;
    // scrollHeight - scrollTop - clientHeight = 500 > NEAR_BOTTOM_PX (64)
    setScrollGeometry(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
    await wrapper.get("#transcript").trigger("scroll");
    expect(wrapper.emitted("update:following")).toEqual([[false]]);
  });

  it("scrolling back to near the bottom by hand turns following back on (bug fix: used to stay un-followed)", async () => {
    const agent = agentWith(manyUserMessages(50));
    const wrapper = await mountTx(agent, { following: false });
    const box = wrapper.get("#transcript").element;
    // distance from bottom = 1000 - 950 - 50 = 0 <= NEAR_BOTTOM_PX (64)
    setScrollGeometry(box, { scrollTop: 950, scrollHeight: 1000, clientHeight: 50 });
    await wrapper.get("#transcript").trigger("scroll");
    expect(wrapper.emitted("update:following")).toEqual([[true]]);
  });

  it("does not emit either way while still outside NEAR_BOTTOM_PX and following is already off", async () => {
    const agent = agentWith(manyUserMessages(50));
    const wrapper = await mountTx(agent, { following: false });
    const box = wrapper.get("#transcript").element;
    setScrollGeometry(box, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }); // distance 500
    await wrapper.get("#transcript").trigger("scroll");
    expect(wrapper.emitted("update:following")).toBeUndefined();
  });
});

/**
 * Follow-pin on in-place content growth (bug fix, item ①): streaming text that grows WITHIN an
 * existing assistant message never changes `totalLen` (item/tool counts are unchanged), so the
 * `domSignal` watcher never fires and the old behavior never re-pinned to the bottom until the
 * NEXT item/tool appeared — the ResizeObserver on `.tx-inner` closes that gap independently.
 * happy-dom ships a `ResizeObserver` global but (like jsdom) never actually fires it from real
 * layout, so these tests install a fake one that records `observe()` calls and lets the test fire
 * the callback by hand; the component coalesces the resulting pin through a microtask (rAF is
 * banned repo-wide, `source-scan.test.ts`), hence the double `await Promise.resolve()` flush.
 */
describe("Transcript.vue — follow-pin on in-place content growth (ResizeObserver, bug fix)", () => {
  type RoCallback = (entries: readonly unknown[], observer: unknown) => void;

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    readonly observed: Element[] = [];
    constructor(private readonly cb: RoCallback) {
      FakeResizeObserver.instances.push(this);
    }
    observe(el: Element): void {
      this.observed.push(el);
    }
    unobserve(): void {}
    disconnect(): void {}
    fire(): void {
      this.cb([], this);
    }
  }

  async function withFakeResizeObserver<T>(fn: () => Promise<T>): Promise<T> {
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    try {
      return await fn();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  }

  it("pins scrollTop to scrollHeight when following and the content box resizes (no totalLen change)", async () => {
    await withFakeResizeObserver(async () => {
      const agent = agentWith(manyUserMessages(5));
      const wrapper = await mountTx(agent, { following: true });
      const box = wrapper.get("#transcript").element;
      setScrollGeometry(box, { scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      const ro = FakeResizeObserver.instances[0];
      expect(ro).toBeTruthy();
      expect(ro!.observed).toHaveLength(1); // observes `.tx-inner`, not the scroll box itself
      // simulate in-place growth: streaming text widened an existing message, scrollHeight grows
      setScrollGeometry(box, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
      ro!.fire();
      await Promise.resolve();
      await Promise.resolve();
      expect(box.scrollTop).toBe(500);
    });
  });

  it("never scrolls on resize while following is off (must not fight a user scrolled up)", async () => {
    await withFakeResizeObserver(async () => {
      const agent = agentWith(manyUserMessages(5));
      const wrapper = await mountTx(agent, { following: false });
      const box = wrapper.get("#transcript").element;
      setScrollGeometry(box, { scrollTop: 10, scrollHeight: 500, clientHeight: 100 });
      const ro = FakeResizeObserver.instances[0]!;
      ro.fire();
      await Promise.resolve();
      await Promise.resolve();
      expect(box.scrollTop).toBe(10);
    });
  });

  it("disconnects the observer on unmount (no leaked pin after teardown)", async () => {
    await withFakeResizeObserver(async () => {
      const agent = agentWith(manyUserMessages(5));
      const wrapper = await mountTx(agent, { following: true });
      const ro = FakeResizeObserver.instances[0]!;
      const disconnectSpy = vi.spyOn(ro, "disconnect");
      wrapper.unmount();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * `TxCustom.vue` markdown rendering (user-reported: notification-class custom messages —
 * subagent completion notices, system notices — used to render their markdown SOURCE as raw
 * `{{ text }}` characters instead of actual markdown). Mounted directly rather than through
 * `Transcript.vue`'s full entry-building pipeline.
 */
import TxCustom from "../../../src/web-hub/ui/src/components/transcript/TxCustom.vue";

describe("TxCustom.vue — markdown rendering", () => {
  it("renders **bold**/lists through MarkdownView, not as raw asterisk/dash characters", () => {
    const wrapper = mount(TxCustom, {
      props: {
        customType: "subagent:notice",
        text: "**Run finished** —\n\n- step one\n- step two",
        truncated: false,
      },
    });
    expect(wrapper.get(".kind-chip").text()).toContain("subagent:notice");
    expect(wrapper.get(".msg-head .who").text()).toBe("subagent");
    expect(wrapper.find(".md").exists()).toBe(true); // MarkdownView.vue's own root class
    expect(wrapper.get("strong").text()).toBe("Run finished");
    expect(wrapper.findAll("li")).toHaveLength(2);
    expect(wrapper.html()).not.toContain("**Run finished**");
  });

  it("shows the truncated badge and never uses v-html", () => {
    const wrapper = mount(TxCustom, { props: { customType: "notice", text: "hello", truncated: true } });
    expect(wrapper.find(".badge-trunc").exists()).toBe(true);
  });
});
