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
/**
 * Fake `ResizeObserver` shared by the follow-pin describes below: happy-dom ships a
 * `ResizeObserver` global but (like jsdom) never actually fires it from real layout, so tests
 * install this fake — it records `observe()` calls and lets the test fire the callback by hand.
 */
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

/** The component coalesces pins through a microtask (rAF is banned repo-wide,
 * `source-scan.test.ts`), hence the double flush. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Transcript.vue — follow-pin on in-place content growth (ResizeObserver, bug fix)", () => {
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
 * Touch-scroll pin suppression (mobile field report: a slow finger drag while pinned at the
 * bottom flickered because every streaming re-render re-forced `scrollTop = scrollHeight`
 * mid-drag). While a touch scroll is active (plus a ~200ms settle after release), all
 * programmatic pins are skipped; mouse/wheel input never arms the suppression. happy-dom has
 * no `TouchEvent`/`PointerEvent` constructors, so the tests dispatch plain `Event`s (with an
 * own `pointerType` property for the pointer path) directly on the scroll box — the handlers
 * only read `pointerType`, so this is exactly what the component sees in a real browser.
 */
describe("Transcript.vue — touch-scroll pin suppression (mobile slow-drag flicker fix)", () => {
  function fireTouch(el: Element, type: string): void {
    el.dispatchEvent(new Event(type));
  }

  function firePointer(el: Element, type: string, pointerType: string): void {
    const ev = new Event(type);
    Object.defineProperty(ev, "pointerType", { value: pointerType });
    el.dispatchEvent(ev);
  }

  it("skips the in-place growth pin while a touch drag is active, and resumes after the release settle", async () => {
    vi.useFakeTimers();
    try {
      await withFakeResizeObserver(async () => {
        const agent = agentWith(manyUserMessages(5));
        const wrapper = await mountTx(agent, { following: true });
        const box = wrapper.get("#transcript").element;
        const ro = FakeResizeObserver.instances[0]!;
        // finger lands — a slow drag starts
        fireTouch(box, "touchstart");
        // streaming text grows the content while the finger is down: the pin must NOT fight it
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(0);
        // finger lifts, but the settle window (momentum) is still running
        fireTouch(box, "touchend");
        vi.advanceTimersByTime(100);
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 800, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(0);
        // settle window over — the next content change pins again (still following)
        vi.advanceTimersByTime(150); // 250ms total > 200ms settle
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 900, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(900);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-grip inside the settle window keeps suppression alive (settle timer resets)", async () => {
    vi.useFakeTimers();
    try {
      await withFakeResizeObserver(async () => {
        const agent = agentWith(manyUserMessages(5));
        const wrapper = await mountTx(agent, { following: true });
        const box = wrapper.get("#transcript").element;
        const ro = FakeResizeObserver.instances[0]!;
        fireTouch(box, "touchstart");
        fireTouch(box, "touchend");
        vi.advanceTimersByTime(150); // inside the 200ms settle
        fireTouch(box, "touchstart"); // re-grip before the settle elapses
        fireTouch(box, "touchend");
        vi.advanceTimersByTime(150); // 300ms since the first release, but only 150 since the second
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(0);
        vi.advanceTimersByTime(100); // now 250ms past the second release
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 600, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(600);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the follow-on jump-to-bottom while touching; pins again on the next toggle after settle", async () => {
    vi.useFakeTimers();
    try {
      const agent = agentWith(manyUserMessages(50));
      const wrapper = await mountTx(agent, { following: false });
      const box = wrapper.get("#transcript").element;
      setScrollGeometry(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
      fireTouch(box, "touchstart");
      await wrapper.setProps({ following: true });
      await flushMicrotasks();
      expect(box.scrollTop).toBe(0); // follow-on pin skipped, not queued
      fireTouch(box, "touchcancel");
      vi.advanceTimersByTime(250);
      await wrapper.setProps({ following: false });
      await wrapper.setProps({ following: true });
      await flushMicrotasks();
      expect(box.scrollTop).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the scroll-anchor follow-branch on content append while touching, and resumes after settle", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = await mountTx(agentWith(manyUserMessages(5)), { following: true });
      const box = wrapper.get("#transcript").element;
      // parked near the bottom: captureScroll computes nearBottom = (1000-90-1000) < 64 → true
      setScrollGeometry(box, { scrollTop: 90, scrollHeight: 1000, clientHeight: 1000 });
      fireTouch(box, "touchstart");
      await wrapper.setProps({ agent: agentWith(manyUserMessages(6)) });
      await flushMicrotasks();
      expect(box.scrollTop).toBe(90); // follow-branch compensation skipped
      fireTouch(box, "touchend");
      vi.advanceTimersByTime(250);
      await wrapper.setProps({ agent: agentWith(manyUserMessages(7)) });
      await flushMicrotasks();
      expect(box.scrollTop).toBe(1000); // compensation pins again once the settle elapsed
    } finally {
      vi.useRealTimers();
    }
  });

  it("a mouse pointerdown never suppresses pinning; a touch pointerdown/pointerup pair does", async () => {
    vi.useFakeTimers();
    try {
      await withFakeResizeObserver(async () => {
        const agent = agentWith(manyUserMessages(5));
        const wrapper = await mountTx(agent, { following: true });
        const box = wrapper.get("#transcript").element;
        const ro = FakeResizeObserver.instances[0]!;
        // mouse (scrollbar drag / selection): pinning must keep working — desktop unaffected
        firePointer(box, "pointerdown", "mouse");
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(500);
        // touch pointer events arm/release the same suppression as touchstart/touchend
        firePointer(box, "pointerdown", "touch");
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 800, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(0);
        firePointer(box, "pointerup", "touch");
        vi.advanceTimersByTime(250);
        setScrollGeometry(box, { scrollTop: 0, scrollHeight: 900, clientHeight: 100 });
        ro.fire();
        await flushMicrotasks();
        expect(box.scrollTop).toBe(900);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending settle timer on unmount (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = await mountTx(agentWith(manyUserMessages(5)), { following: true });
      const box = wrapper.get("#transcript").element;
      fireTouch(box, "touchstart");
      fireTouch(box, "touchend");
      expect(vi.getTimerCount()).toBe(1);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// scroll memory v1 (docs/dev/web-hub-session-switch/plan.md §1.4 — E1). The coordinate system
// change (entries vs items+streaming+tools) is invisible to the tests above (pure user-message
// agents: entries === items), which is exactly why they must stay green — the cases below pin
// the opt-in read/write lifecycle, the writer mutex (W1–W4) and the gesture cancel rules.
// ---------------------------------------------------------------------------
import {
  createScrollMemory,
  type ScrollMemory,
  SCROLL_MEMORY,
} from "../../../src/web-hub/ui/src/composables/useScrollMemory.js";

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Mount a Transcript with a fresh (or given) scroll-memory store provided. NOT awaited —
 * callers must patch element geometry while the restore nextTick is still pending. */
function mountTxMem(agent: AgentState, mem: ScrollMemory, extraProps: Record<string, unknown> = {}) {
  return mount(Transcript, {
    props: { agent, following: false, narrow: false, memoryKey: "agent-a", ...extraProps },
    global: { provide: { [SCROLL_MEMORY as symbol]: mem } },
  });
}

/** The W4 restore runs as a nextTick callback chained on the mount flush — flush a few
 * microtask generations so it has certainly executed (and any W2b/W3 microtask has settled). */
async function flushRestore(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function patchRect(el: Element, top: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () => makeRect(top, height);
}

/** The .tx-item row whose data-anchor-ids contains `id`. */
function anchorRowOf(wrapper: VueWrapper, id: string): Element {
  for (const row of wrapper.findAll(".tx-item")) {
    const raw = row.attributes("data-anchor-ids");
    if (raw !== undefined && raw.split("\u001f").includes(id)) return row.element;
  }
  throw new Error(`no row carries anchor id ${id}`);
}

describe("Transcript.vue — scroll memory v1 (session-switch plan §1.4)", () => {
  it("① unmount while not following saves the first visible anchorable row's ids + offset", async () => {
    const mem = createScrollMemory();
    const wrapper = mountTxMem(agentWith(manyUserMessages(50)), mem);
    const box = wrapper.get("#transcript").element;
    setScrollGeometry(box, { scrollTop: 250, scrollHeight: 3000, clientHeight: 600 });
    patchRect(box, 0, 600);
    // rects are VIEWPORT-relative (⇒ subtract scrollTop to place row i at content top 100·i)
    wrapper.findAll(".tx-item").forEach((row, i) => patchRect(row.element, 100 * i - 250, 60));
    wrapper.unmount();
    const rec = mem.get("agent-a");
    expect(rec?.following).toBe(false);
    // content tops 0/100 end at 60/160 ≤ 250; row 2 (entry e2, content top 200) straddles the fold
    expect(rec?.anchorIds).toEqual(["e:e2", `k:user:${1_700_000_000_000 + 2 * 1000}`]);
    expect(rec?.anchorOffsetPx).toBe(200 - 250);
  });

  it("② unmount while following saves just {following:true}", async () => {
    const mem = createScrollMemory();
    const wrapper = mountTxMem(agentWith(manyUserMessages(50)), mem, { following: true });
    wrapper.unmount();
    expect(mem.get("agent-a")).toEqual({ following: true });
  });

  it("③ a saved record restores the window start AND the pixel position at mount", async () => {
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e150"], anchorOffsetPx: 40 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(400)), mem);
    // restoreStart(150, 400, 200): 150 < defaultStart 200 ⇒ start = 150 - 100 = 50
    expect(wrapper.text()).toContain("message 50");
    expect(wrapper.text()).not.toContain("message 49");
    const box = wrapper.get("#transcript").element;
    setScrollGeometry(box, { scrollTop: 0, scrollHeight: 5000, clientHeight: 600 });
    patchRect(box, 100, 600);
    patchRect(anchorRowOf(wrapper, "e:e150"), 600, 50);
    await wrapper.vm.$nextTick();
    await flushRestore();
    // contentTop = 600 − 100 + 0 = 500; scrollTop = 500 − 40
    expect(box.scrollTop).toBe(460);
    expect(wrapper.emitted("update:following")).toBeUndefined(); // restore is not a flip
  });

  it("④ an anchor outside the snapshot (tail truncated) degrades: emit following=true", async () => {
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:gone"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(50)), mem);
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(wrapper.emitted("update:following")).toEqual([[true]]);
  });

  it("⑤ an ambiguous anchor (same id in two entries) degrades: emit following=true", async () => {
    const base = agentWith(manyUserMessages(50));
    const dup = { ...base, items: [...base.items, base.items[10]] } as unknown as AgentState;
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(dup, mem);
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(wrapper.emitted("update:following")).toEqual([[true]]);
  });

  it("⑥ no memoryKey ⇒ neither reads nor writes even when a store is provided (drawer isolation)", async () => {
    const mem: ScrollMemory = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), size: 0 };
    const wrapper = mount(Transcript, {
      props: { agent: agentWith(manyUserMessages(5)), following: true, narrow: false },
      global: { provide: { [SCROLL_MEMORY as symbol]: mem } },
    });
    await wrapper.vm.$nextTick();
    wrapper.unmount();
    expect(mem.get).not.toHaveBeenCalled();
    expect(mem.set).not.toHaveBeenCalled();
  });

  it("⑦ writer mutex: a content change and a resize before the restore nextTick — only W4 writes", async () => {
    await withFakeResizeObserver(async () => {
      const mem = createScrollMemory();
      mem.set("agent-a", { following: false, anchorIds: ["e:e30"], anchorOffsetPx: 0 });
      const wrapper = mountTxMem(agentWith(manyUserMessages(60)), mem);
      const box = wrapper.get("#transcript").element;
      setScrollGeometry(box, { scrollTop: 0, scrollHeight: 900, clientHeight: 300 });
      patchRect(box, 100, 300);
      patchRect(anchorRowOf(wrapper, "e:e30"), 600, 50);
      // before the restore lands: the content grows (domSignal fires → W2b) AND the resize
      // observer fires (W3) — both must let go; the restore (W4) is the surviving writer.
      void wrapper.setProps({ agent: agentWith(manyUserMessages(61)) });
      FakeResizeObserver.instances[0]!.fire();
      await wrapper.vm.$nextTick();
      await flushRestore();
      expect(box.scrollTop).toBe(500); // W4's anchor value — not scrollHeight(900), not 0
    });
  });

  it("⑧ the restore write's scroll event is consumed by the token; the next one behaves normally", async () => {
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(60), { hasMore: true, oldestEntryId: "e0" }), mem);
    const box = wrapper.get("#transcript").element;
    patchRect(box, 50, 600);
    patchRect(anchorRowOf(wrapper, "e:e10"), 100, 50); // restored scrollTop = 100 − 50 = 50 < 96
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(box.scrollTop).toBe(50);
    setScrollGeometry(box, { scrollTop: 50, scrollHeight: 3000, clientHeight: 600 }); // distance ≫ 64
    await wrapper.get("#transcript").trigger("scroll"); // the restore's own event: token eaten
    expect(wrapper.emitted("update:following")).toBeUndefined();
    expect(wrapper.emitted("load-older")).toBeUndefined();
    await wrapper.get("#transcript").trigger("scroll"); // second event: normal handling —
    expect(wrapper.emitted("load-older")).toEqual([[]]); // auto load-older near the top fires
  });

  it("⑨ gestures: pointerdown(mouse)/wheel/PageUp cancel a pending restore; a letter key does not", async () => {
    const fireWheel = (el: Element): void => {
      el.dispatchEvent(new Event("wheel"));
    };
    const fireKey = (el: Element, key: string): void => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key }));
    };
    for (const gesture of ["pointer", "wheel", "key"] as const) {
      const mem = createScrollMemory();
      mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
      const wrapper = mountTxMem(agentWith(manyUserMessages(60)), mem);
      const box = wrapper.get("#transcript").element;
      patchRect(box, 0, 600);
      patchRect(anchorRowOf(wrapper, "e:e10"), 300, 50);
      if (gesture === "pointer") {
        const ev = new Event("pointerdown");
        Object.defineProperty(ev, "pointerType", { value: "mouse" });
        box.dispatchEvent(ev);
      } else if (gesture === "wheel") {
        fireWheel(box);
      } else {
        fireKey(box, "PageUp");
      }
      await wrapper.vm.$nextTick();
      await flushRestore();
      expect(wrapper.emitted("update:following")).toEqual([[true]]);
      expect(box.scrollTop).toBe(0); // restore cancelled — nothing wrote
      wrapper.unmount();
    }
    // a non-scrolling key press is NOT a gesture: the restore completes untouched
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(60)), mem);
    const box = wrapper.get("#transcript").element;
    patchRect(box, 0, 600);
    patchRect(anchorRowOf(wrapper, "e:e10"), 300, 50);
    fireKey(box, "a");
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(wrapper.emitted("update:following")).toBeUndefined();
    expect(box.scrollTop).toBe(300);
  });

  it("⑨b a wheel AFTER the restore write clears the token — the scroll event counts as user scrolling", async () => {
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(60)), mem);
    const box = wrapper.get("#transcript").element;
    patchRect(box, 50, 600);
    patchRect(anchorRowOf(wrapper, "e:e10"), 100, 50); // restored scrollTop = 50
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(box.scrollTop).toBe(50);
    // near the bottom: distance ≤ 64 would flip following back ON — if the token were still
    // armed it would swallow this; the wheel cleared it, so this counts as user scrolling.
    setScrollGeometry(box, { scrollTop: 2900, scrollHeight: 3000, clientHeight: 600 });
    box.dispatchEvent(new Event("wheel")); // user intent arrives before the scroll event
    await wrapper.get("#transcript").trigger("scroll");
    expect(wrapper.emitted("update:following")).toEqual([[true]]); // NOT swallowed by the token
  });

  it("⑩ following flipped true by the parent during the restore window cancels it (W1 wins)", async () => {
    const mem = createScrollMemory();
    mem.set("agent-a", { following: false, anchorIds: ["e:e10"], anchorOffsetPx: 0 });
    const wrapper = mountTxMem(agentWith(manyUserMessages(60)), mem);
    const box = wrapper.get("#transcript").element;
    setScrollGeometry(box, { scrollTop: 0, scrollHeight: 3000, clientHeight: 600 });
    patchRect(box, 0, 600);
    patchRect(anchorRowOf(wrapper, "e:e10"), 300, 50);
    void wrapper.setProps({ following: true }); // external intent, before the restore lands
    await wrapper.vm.$nextTick();
    await flushRestore();
    expect(box.scrollTop).toBe(3000); // W1's jump to bottom — not the anchor's 300
    expect(wrapper.emitted("update:following")).toBeUndefined();
  });
});
