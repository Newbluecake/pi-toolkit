// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { ref, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailHeader from "../../../src/web-hub/ui/src/components/detail/DetailHeader.vue";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import FleetSummaryBar from "../../../src/web-hub/ui/src/components/fleet/FleetSummaryBar.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { TERMINAL_ENTRY } from "../../../src/web-hub/ui/src/logic/terminalContext.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";
import { createStreamLifecycle } from "../../../src/web-hub/ui/src/logic/transport-core.js";
const wrappers: Array<{ unmount(): void }> = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});
function agent(): AgentState {
  return {
    key: "agent",
    card: { control: true, epoch: "epoch", kind: "tui", state: "live" },
    session: { sessionId: "session", name: "Test", mode: "tui" },
    status: {
      busy: false,
      terminalSessionV2: {
        v: 2,
        enabled: true,
        contextGeneration: 1,
        sessionId: "session",
        epoch: "epoch",
        limits: { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
      },
    },
    down: false,
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
  } as unknown as AgentState;
}
describe("terminal capability gates and off parity (§7.1/§7.2)", () => {
  it("leaves header bytes identical when an inert/off entry context is provided; cap-on has a single 44px accessible button", async () => {
    const a = mount(DetailHeader, { props: { agent: agent(), narrow: false } });
    wrappers.push(a);
    const available = ref(false),
      open = ref(false),
      show = vi.fn();
    const b = mount(DetailHeader, {
      props: { agent: agent(), narrow: false },
      global: { provide: { [TERMINAL_ENTRY as symbol]: { available, open, show } } },
    });
    wrappers.push(b);
    expect(b.html()).toBe(a.html());
    available.value = true;
    await nextTick();
    const button = b.get('[data-fold="terminal"]');
    expect(button.attributes("aria-controls")).toBe("fleet-drawer");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect((button.element as HTMLElement).style.minHeight).toBe("44px");
    await button.trigger("click");
    expect(show).toHaveBeenCalledOnce();
    open.value = true;
    await nextTick();
    expect(button.attributes("aria-expanded")).toBe("true");
    available.value = false;
    await nextTick();
    expect(b.html()).toBe(a.html());
  });
  it("shows no entry for an old hub/off, or absent session/epoch; never probes support eagerly", async () => {
    const state = ref<any>({
      control: true,
      conn: "open",
      hub: { caps: [] },
      privacy: { cap: false, ready: false, locked: new Set() },
    });
    const request = vi.fn();
    const a = agent();
    const w = mount(AgentDetail, {
      props: { agent: a, now: 10000, narrow: false },
      global: {
        stubs: { DetailDock: true, DetailBody: true },
        provide: { [HUB_CTX as symbol]: { state, control: {}, terminalV2: { request } } },
      },
    });
    wrappers.push(w);
    await flushPromises();
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
    const off = w.html();
    state.value = { ...state.value, hub: { caps: ["unrelated.v1"] } };
    await nextTick();
    expect(w.html()).toBe(off);
    expect(request).not.toHaveBeenCalled();
    state.value = { ...state.value, hub: { caps: ["terminal.ui.v1"] } };
    await nextTick();
    await nextTick();
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
    state.value = { ...state.value, hub: { caps: ["terminal.tabs.v2"] } };
    await flushPromises();
    await vi.waitFor(() => expect(w.find('[data-fold="terminal"]').exists()).toBe(true));
    expect(request).not.toHaveBeenCalled();
    await w.setProps({ agent: { ...a, session: undefined } as any });
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
  });
  it("privacy marks remain terminal-denying on phone/local-unlocked state and while the server set is unknown", async () => {
    const state = ref<any>({
      control: true,
      conn: "open",
      hub: { caps: ["terminal.tabs.v2", "privacy.v1"] },
      privacy: { cap: true, ready: false, locked: new Set() },
    });
    const w = mount(AgentDetail, {
      props: { agent: agent(), now: 10000, narrow: true },
      global: {
        stubs: { DetailDock: true, DetailBody: true },
        provide: { [HUB_CTX as symbol]: { state, control: {} } },
      },
    });
    wrappers.push(w);
    await nextTick();
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
    state.value = { ...state.value, privacy: { cap: true, ready: true, locked: new Set(["session"]) } };
    await nextTick();
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
    state.value = { ...state.value, privacy: { cap: true, ready: true, locked: new Set() } };
    await flushPromises();
    await vi.waitFor(() => expect(w.find('[data-fold="terminal"]').exists()).toBe(true));
  });
  it("switches bash semantics by hub cap only, not the agent backend outcome, and returns to exactly old markup off", async () => {
    const state = ref<any>({ hub: { caps: [] } });
    const w = mount(FleetSummaryBar, {
      props: {
        rows: [],
        bashJobs: {
          v: 1,
          sampledAt: 1,
          total: 1,
          running: 1,
          failed: 0,
          omitted: 0,
          rows: [{ id: "job", command: "build", status: "running", elapsedMs: 1, createdAt: 1 }],
        } as any,
        open: false,
      },
      global: { provide: { [HUB_CTX as symbol]: { state } } },
    });
    wrappers.push(w);
    const off = w.html();
    expect(w.find('use[href="#i-terminal"]').exists()).toBe(true);
    state.value = { hub: { caps: ["terminal.tabs.v2"] } };
    await nextTick();
    expect(w.find('use[href="#i-jobs-list"]').exists()).toBe(true);
    state.value = { hub: { caps: [] } };
    await nextTick();
    expect(w.html()).toBe(off);
  });
  it("registers no private SSE listeners off, v1 or v2; ordinary events remain unchanged", () => {
    class Source {
      static last: Source;
      listeners = new Map<string, (e: any) => void>();
      readyState = 1;
      constructor() {
        Source.last = this;
      }
      close() {}
      addEventListener(name: string, cb: any) {
        this.listeners.set(name, cb);
      }
    }
    const timers: any[] = [];
    const onMessage = vi.fn();
    const stream = createStreamLifecycle(
      {
        EventSource: Source,
        setTimeout: (fn: any) => {
          timers.push(fn);
          return timers.length;
        },
        clearTimeout() {},
        now: () => 1,
        onMessage,
        onConn: vi.fn(),
      },
      { onClosedError() {} },
    );
    stream.openStream();
    const source = Source.last;
    expect(source.listeners.has("terminal")).toBe(false);
    source.listeners.get("hub")!({ data: JSON.stringify({ caps: [] }), lastEventId: "" });
    expect(source.listeners.has("terminal")).toBe(false);
    source.listeners.get("hub")!({ data: JSON.stringify({ caps: ["terminal.ui.v1"] }), lastEventId: "" });
    expect(source.listeners.has("terminal")).toBe(false);
    source.listeners.get("hub")!({ data: JSON.stringify({ caps: ["terminal.tabs.v2"] }), lastEventId: "" });
    expect(source.listeners.has("terminal")).toBe(false);
    expect(source.listeners.has("terminal_connection")).toBe(false);
    expect(source.listeners.has("status")).toBe(true);
    expect(onMessage.mock.calls.at(-1)?.[0]).toEqual({ event: "hub", data: { caps: ["terminal.tabs.v2"] } });
    stream.closeStream();
  });
});
