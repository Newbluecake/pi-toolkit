// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import type { HubHandle, HubState, Route } from "../../../src/web-hub/ui/src/types.js";

/**
 * DashboardView-level scroll-memory lifecycle (docs/dev/web-hub-session-switch/plan.md §1.4 —
 * E1-6 / v2 review Major-8): the REAL provide chain (DashboardView creates the store, AgentDetail
 * seeds `following` from it, DetailBody's Transcript saves/restores through `memory-key`) runs
 * against a fake hub state, covering the wide A→B→A hop, the single-view list round-trip,
 * agent_removed mid-view, a spawn-restore successor (no inheritance), and a same-key session
 * replacement (anchor gone ⇒ bottom).
 *
 * The store lives inside DashboardView's own setup, so "the record was written while the DOM was
 * still accessible" is asserted BEHAVIORALLY: the only way the A-remount lands on exactly the
 * pre-switch scrollTop with following=false is a save that read real (still-connected) row
 * geometry at `onBeforeUnmount`.
 *
 * Geometry: `Element.prototype.getBoundingClientRect` is stubbed to emulate a real browser — a
 * `.tx-item` row's viewport-relative top is `200·domIndex − box.scrollTop`, height 60 — so
 * content coordinates (what the memory stores) are stable across mounts.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubRectsByDomOrder(): void {
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.classList.contains("tx-item")
      ? ((this.parentElement?.parentElement as HTMLElement | undefined) ?? null)
      : null;
    const scrollTop = typeof box?.scrollTop === "number" ? box.scrollTop : 0;
    const parent = this.parentElement;
    const idx = parent ? Array.prototype.indexOf.call(parent.children, this) : -1;
    const base = this.classList.contains("tx-item") && idx >= 0 ? idx * 200 : 0;
    const height = this.classList.contains("tx-item") ? 60 : 0;
    const top = base - scrollTop;
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) };
  });
}

function stubMatchMedia(narrow: boolean): void {
  const map: Record<string, boolean> = {
    "(max-width: 767px)": narrow,
    "(max-width: 480px)": narrow,
    "(min-width: 1025px)": !narrow,
    "(min-width: 481px) and (max-width: 1024px)": false,
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  rectSpy?.mockRestore();
  rectSpy = null;
  for (const w of mounted.splice(0)) w.unmount();
  window.location.hash = "";
});

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

const MSGS = (n: number, prefix = "e", base = 1_700_000_000_000) =>
  Array.from({ length: n }, (_, i) => userMsgEntry(`${prefix}${i}`, base + i * 1000, `message ${i}`));

/** hello + one agent with an n-message history (+ an optional prior session id). */
function agentLoadedMsgs(key: string, n: number, prefix = "e", base = 1_700_000_000_000, sessionId?: string): Msg[] {
  return [
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card(key)] },
    ...(sessionId !== undefined ? [{ event: "session", data: { agentKey: key, session: { sessionId } } }] : []),
    { event: "subscribing", data: { agentKey: key, clientId: "c1" } },
    {
      event: "history",
      data: { agentKey: key, entries: MSGS(n, prefix, base), tailMessages: [], fromSeq: n, hasMore: false },
    },
  ];
}

/** A mutable fake hub: `setState` swaps the whole (reducer-built) state. */
function fakeHub(initial: ReturnType<typeof initialState>) {
  const stateRef = ref(initial as unknown as HubState);
  const hub = {
    state: stateRef,
    dispatch: () => {},
    loadOlder: () => {},
    selectRun: () => {},
  } as unknown as HubHandle & { loadOlder: () => void };
  return { hub, setState: (next: ReturnType<typeof initialState>) => (stateRef.value = next as unknown as HubState) };
}

function mountDashboard(route: Route, hub: HubHandle) {
  const wrapper = mount(DashboardView, { props: { hub, route } });
  mounted.push(wrapper);
  return wrapper;
}

/** The restore write chains on the mount flush's promise — settle a few ticks past it. */
async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

function setScrollGeometry(el: Element, { scrollTop, scrollHeight, clientHeight }: Record<string, number>): void {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true, writable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true, writable: true });
}

/** Scroll the currently mounted transcript away from the bottom (turns following off the real way). */
async function scrollAway(wrapper: ReturnType<typeof mount>): Promise<void> {
  const box = wrapper.get("#transcript").element;
  setScrollGeometry(box, { scrollTop: 250, scrollHeight: 3000, clientHeight: 600 });
  await wrapper.get("#transcript").trigger("scroll");
  await nextTick();
}

describe("DashboardView.vue — scroll memory lifecycle (session-switch plan §1.4, Major-8)", () => {
  it("① wide split A→B→A: position + following restored on the A remount", async () => {
    stubMatchMedia(false); // ≥1025px split, desktop 200-entry window
    stubRectsByDomOrder();
    const s = run([...agentLoadedMsgs("agent-a", 260), { event: "agents", data: [card("agent-a"), card("agent-b")] }]);
    const { hub } = fakeHub(s);
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    await nextTick();
    await scrollAway(wrapper);
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(false);

    await wrapper.setProps({ route: { name: "agent", key: "agent-b" } });
    await settle();
    // B mounts fresh (no record): following stays true, nothing restored
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(true);

    await wrapper.setProps({ route: { name: "agent", key: "agent-a" } });
    await settle();
    const box = wrapper.get("#transcript").element;
    // window start 60 ⇒ first mounted row is entry 60 at domIndex 1; save picked it at
    // scrollTop 250 with offsetPx −50; restore: contentTop 200 ⇒ scrollTop 200 − (−50) = 250.
    expect(box.scrollTop).toBe(250);
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(false);
    expect(wrapper.text()).toContain("message 60"); // the anchor row is mounted
  });

  it("② single view A→list→A: same round-trip through the list branch (mobile window)", async () => {
    stubMatchMedia(true); // ≤767px single view — Transcript's own 480px query also matches
    stubRectsByDomOrder();
    const { hub } = fakeHub(run(agentLoadedMsgs("agent-a", 260)));
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    await nextTick();
    await scrollAway(wrapper);
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(false);

    await wrapper.setProps({ route: { name: "list" } });
    await settle();
    expect(wrapper.find("#transcript").exists()).toBe(false); // detail unmounted

    await wrapper.setProps({ route: { name: "agent", key: "agent-a" } });
    await settle();
    // mobile window 80 ⇒ start 180, anchor row entry 180 at domIndex 1 ⇒ restored scrollTop 250
    expect(wrapper.get("#transcript").element.scrollTop).toBe(250);
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(false);
  });

  it("③ agent_removed while viewing A: unmount-save does not throw, 「已删除」 empty state shows", async () => {
    stubMatchMedia(false);
    stubRectsByDomOrder();
    const { hub, setState } = fakeHub(
      run([...agentLoadedMsgs("agent-a", 260), { event: "agents", data: [card("agent-a"), card("other-agent")] }]),
    );
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    await nextTick();
    await scrollAway(wrapper);

    setState(
      run([
        { event: "hello", data: { clientId: "c1" } },
        { event: "agents", data: [card("agent-a"), card("other-agent")] },
        { event: "agent_removed", data: { agentKey: "agent-a" } },
      ]),
    );
    await settle();
    expect(() => wrapper.get(".detail .empty")).not.toThrow();
    expect(wrapper.get(".detail .empty h2").text()).toBe("Session removed from the list");
  });

  it("④ spawn-restore successor key does NOT inherit the old key's record (bottom + following)", async () => {
    stubMatchMedia(false);
    stubRectsByDomOrder();
    const { hub, setState } = fakeHub(run(agentLoadedMsgs("old-a", 260)));
    const wrapper = mountDashboard({ name: "agent", key: "old-a" }, hub);
    await nextTick();
    await scrollAway(wrapper);
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(false);

    // the old key is reaped (its record — following:false, anchor — is saved on unmount) and the
    // restored session comes back under a NEW key; useHub's successor follow does the route jump
    // in production — here the post-jump route is simulated directly.
    setState(run(agentLoadedMsgs("new-a", 10)));
    await settle();
    await wrapper.setProps({ route: { name: "agent", key: "new-a" } });
    await settle();
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(true); // not inherited
    const box = wrapper.get("#transcript").element;
    expect(box.scrollTop).toBe(box.scrollHeight); // W1's jump to bottom ran
    expect(box.scrollTop).not.toBe(250); // the old key's remembered position is gone
  });

  it("⑤ same-key session replacement: anchor gone from the new snapshot ⇒ bottom + following", async () => {
    stubMatchMedia(false);
    stubRectsByDomOrder();
    const { hub, setState } = fakeHub(run(agentLoadedMsgs("agent-a", 260, "e", 1_700_000_000_000, "s1")));
    const wrapper = mountDashboard({ name: "agent", key: "agent-a" }, hub);
    await nextTick();
    await scrollAway(wrapper);

    // /new or /fork under the SAME agentKey: `session` event clears the transcript → skeleton
    // (DetailBody unmounts ⇒ the old record is saved), then the new session's history lands.
    setState(
      run([
        ...agentLoadedMsgs("agent-a", 260, "e", 1_700_000_000_000, "s1"),
        { event: "session", data: { agentKey: "agent-a", session: { sessionId: "s2" } } },
      ]),
    );
    await settle();
    expect(wrapper.find(".skel-stack").exists()).toBe(true); // waiting skeleton, no Transcript

    setState(
      run([
        ...agentLoadedMsgs("agent-a", 260, "e", 1_700_000_000_000, "s1"),
        { event: "session", data: { agentKey: "agent-a", session: { sessionId: "s2" } } },
        { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
        {
          event: "history",
          data: {
            agentKey: "agent-a",
            entries: MSGS(10, "n", 1_800_000_000_000),
            tailMessages: [],
            fromSeq: 10,
            hasMore: false,
          },
        },
      ]),
    );
    await settle();
    // the saved anchor (old entry id e60) is not in the new snapshot ⇒ restoreFailed ⇒ W1
    expect(wrapper.findComponent(DetailDock).props("following")).toBe(true);
    const box = wrapper.get("#transcript").element;
    expect(box.scrollTop).toBe(box.scrollHeight);
  });
});
