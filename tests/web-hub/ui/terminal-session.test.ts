// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { terminalSessionUiEnabled, terminalUiEnabled } from "../../../src/web-hub/ui/src/logic/terminalCapability.js";
import { createStreamLifecycle } from "../../../src/web-hub/ui/src/logic/transport-core.js";
import { createTerminalController } from "../../../src/web-hub/ui/src/components/terminal/controller.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const lazy = vi.hoisted(() => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((yes) => {
    resolve = yes;
  });
  return { promise, resolve, loaded: vi.fn(), mounted: vi.fn(), disposed: vi.fn() };
});
vi.mock("../../../src/web-hub/ui/src/components/terminal/terminal-feature.js", async () => {
  lazy.loaded();
  return await lazy.promise;
});
const caps = ["terminal.ui.v1", "terminal.session.v1"];
const hubInfo = { caps };
function declaration(sessionId = "session", epoch = "epoch") {
  return {
    v: 1,
    enabled: true,
    sessionId,
    epoch,
    limits: { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
  };
}
function agent(key = "agent", sessionId = "session", epoch = "epoch"): AgentState {
  return {
    key,
    card: { control: true, epoch, kind: "tui", state: "live" },
    session: { sessionId, name: "Test", mode: "tui" },
    status: { busy: false, terminalSession: declaration(sessionId, epoch) },
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
const wrappers: Array<{ unmount(): void }> = [];
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body.textContent = "";
});
function setup(a = agent(), hub = hubInfo) {
  const state = ref<any>({
    control: true,
    conn: "open",
    hub,
    privacy: { cap: false, ready: false, locked: new Set() },
  });
  const request = vi.fn(async () => ({ ok: true, revision: 1, rows: [] }));
  const w = mount(AgentDetail, {
    props: { agent: a, now: 10000, narrow: false },
    global: {
      stubs: { DetailDock: true, DetailBody: true },
      provide: { [HUB_CTX as symbol]: { state, control: {}, terminal: { request } } },
    },
  });
  wrappers.push(w);
  return { w, state, request };
}
const entry = (w: ReturnType<typeof mount>) => w.find('[data-fold="terminal"]');
async function visible(w: ReturnType<typeof mount>) {
  await vi.waitFor(() => expect(entry(w).exists()).toBe(true));
}

describe("per-session terminal declaration gate (r2 §6)", () => {
  it.each([undefined, null, {}, { caps: [] }, { caps: ["terminal.ui.v1"] }, { caps: ["terminal.session.v1"] }])(
    "strictly hides for a missing cap, irrespective of positive agent status: %j",
    async (hub) => {
      expect(await terminalSessionUiEnabled(hub, agent())).toBe(false);
    },
  );
  it("does not change the shared hub-only bash/sprite gate for old hubs or ineligible targets", async () => {
    expect(terminalUiEnabled({ caps: ["terminal.ui.v1"] })).toBe(true);
    expect(await terminalSessionUiEnabled(hubInfo, { ...agent(), status: { busy: true } })).toBe(false);
    expect(terminalUiEnabled(hubInfo)).toBe(true);
    expect(terminalUiEnabled({ caps: [] })).toBe(false);
  });
  const invalid = [
    undefined,
    null,
    {},
    { ...declaration(), enabled: false },
    { ...declaration(), v: 2 },
    declaration("other"),
    declaration("session", "old-epoch"),
    { ...declaration(), limits: { ...declaration().limits, maxTotal: 33 } },
    { ...declaration(), limits: { ...declaration().limits, cwd: "/private" } },
    { ...declaration(), cwd: "/private" },
    { ...declaration(), extra: "中".repeat(1024) },
  ];
  it.each(invalid)(
    "rejects malformed/stale public declarations without inferring eligibility: %#",
    async (terminalSession) => {
      expect(await terminalSessionUiEnabled(hubInfo, { ...agent(), status: { busy: true, terminalSession } })).toBe(
        false,
      );
    },
  );
  it("uses the closed parser for cyclic input and validates both actual identity fields", async () => {
    const cyclic: any = declaration();
    cyclic.self = cyclic;
    expect(await terminalSessionUiEnabled(hubInfo, { ...agent(), status: { terminalSession: cyclic } })).toBe(false);
    expect(await terminalSessionUiEnabled(hubInfo, agent())).toBe(true);
    expect(await terminalSessionUiEnabled(hubInfo, { ...agent(), session: undefined })).toBe(false);
    expect(await terminalSessionUiEnabled(hubInfo, { ...agent(), card: {} })).toBe(false);
  });
  it("off and old-hub markup is byte-identical with/without a declaration; zero requests or lazy panel loads", async () => {
    const a = agent();
    const { w, state, request } = setup(a, { caps: [] });
    await flushPromises();
    const off = w.html();
    await w.setProps({ agent: { ...a, status: { busy: false } } as any });
    await flushPromises();
    expect(w.html()).toBe(off);
    state.value = { ...state.value, hub: { caps: ["terminal.ui.v1"] } };
    await w.setProps({ agent: a });
    await flushPromises();
    expect(w.html()).toBe(off);
    expect(request).not.toHaveBeenCalled();
    expect(lazy.loaded).not.toHaveBeenCalled();
  });
  it("withdraws on identity/liveness/privacy/control boundaries, and only current target status can restore an entry", async () => {
    const a = agent();
    const { w, state, request } = setup(a);
    await visible(w);
    await w.setProps({ agent: { ...a, status: { busy: false } } as any });
    expect(entry(w).exists()).toBe(false);
    const b = agent("B", "session-B", "epoch-B");
    await w.setProps({ agent: { ...b, status: a.status } });
    await flushPromises();
    expect(entry(w).exists()).toBe(false);
    await w.setProps({ agent: b });
    await visible(w);
    for (const update of [
      { conn: "reconnecting" },
      { control: false },
      { privacy: { cap: true, ready: false, locked: new Set() }, hub: { caps: [...caps, "privacy.v1"] } },
      { privacy: { cap: true, ready: true, locked: new Set(["session-B"]) }, hub: { caps: [...caps, "privacy.v1"] } },
    ]) {
      const before = state.value;
      state.value = { ...before, ...update };
      await nextTick();
      expect(entry(w).exists()).toBe(false);
      state.value = before;
      await visible(w);
    }
    for (const update of [
      { down: true },
      { card: { ...b.card, state: "stale" } },
      { card: { ...b.card, control: false } },
      { card: { ...b.card, epoch: "new-epoch" } },
      { session: { ...b.session, sessionId: "new-session" } },
    ]) {
      await w.setProps({ agent: { ...b, ...update } as any });
      expect(entry(w).exists()).toBe(false);
      await w.setProps({ agent: b });
      await visible(w);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("does not coerce malformed current identities into valid matching strings", async () => {
    const a = agent("agent", "123", "456");
    const { w } = setup(a);
    await visible(w);
    await w.setProps({ agent: { ...a, session: { ...a.session, sessionId: 123 } } as any });
    await flushPromises();
    expect(entry(w).exists()).toBe(false);
    await w.setProps({ agent: a });
    await visible(w);
    await w.setProps({ agent: { ...a, card: { ...a.card, epoch: 456 } } as any });
    await flushPromises();
    expect(entry(w).exists()).toBe(false);
  });
  it("a pending validation cannot revive an ABA withdrawal or another route", async () => {
    const a = agent();
    const { w } = setup(a);
    // Start the asynchronous parser, then revoke before its continuation is committed.
    await w.setProps({ agent: { ...a, status: { busy: false } } as any });
    await flushPromises();
    expect(entry(w).exists()).toBe(false);
    await w.setProps({ agent: { ...agent("B", "B", "B"), status: a.status } });
    await flushPromises();
    expect(entry(w).exists()).toBe(false);
  });
  it("late lazy completion cannot mount after withdrawal; A→zero→B uses one existing private listener and never auto-opens", async () => {
    const a = agent();
    const { w, state, request } = setup(a);
    const listeners = new Map<string, (event: any) => void>();
    const registered = vi.fn((name: string, cb: (event: any) => void) => listeners.set(name, cb));
    class Source {
      readyState = 1;
      close() {}
      addEventListener = registered;
    }
    const frames = vi.fn((frame: any) => {
      if (frame.event === "status") void w.setProps({ agent: { ...w.props("agent"), status: frame.data } });
    });
    const stream = createStreamLifecycle(
      { EventSource: Source, setTimeout, clearTimeout, now: () => Date.now(), onMessage: frames, onConn: vi.fn() },
      { onClosedError() {} },
    );
    stream.openStream();
    const send = (name: string, data: any) => listeners.get(name)!({ data: JSON.stringify(data), lastEventId: "" });
    try {
      send("hello", {});
      send("hub", hubInfo);
      const privateListener = listeners.get("terminal");
      await visible(w);
      await entry(w).trigger("click");
      await vi.waitFor(() => expect(lazy.loaded).toHaveBeenCalledOnce());
      send("status", { busy: false });
      await nextTick();
      expect(entry(w).exists()).toBe(false);
      lazy.resolve({
        TerminalPanel: defineComponent({
          props: ["scope"],
          setup(props) {
            lazy.mounted(props.scope);
            onBeforeUnmount(() => lazy.disposed());
            return () => h("section", { "data-test-panel": true }, props.scope.agentKey);
          },
        }),
      });
      await flushPromises();
      expect(w.find("[data-test-panel]").exists()).toBe(false);
      expect(lazy.mounted).not.toHaveBeenCalled();
      const b = agent("B", "B", "B");
      await w.setProps({ agent: b });
      await visible(w);
      expect(w.find("[data-test-panel]").exists()).toBe(false);
      expect(entry(w).attributes("aria-expanded")).toBe("false");
      await entry(w).trigger("click");
      await flushPromises();
      expect(lazy.mounted).toHaveBeenCalledWith({ agentKey: "B", expect: { sessionId: "B", epoch: "B" } });
      expect(w.find("[data-test-panel]").exists()).toBe(true);
      // Ordinary ticks with an equivalent declaration do not dispose/recreate an open panel.
      send("status", { busy: true, terminalSession: declaration("B", "B") });
      await flushPromises();
      expect(lazy.mounted).toHaveBeenCalledOnce();
      expect(lazy.disposed).not.toHaveBeenCalled();
      send("status", { busy: false });
      await nextTick();
      expect(w.find("[data-test-panel]").exists()).toBe(false);
      expect(lazy.disposed).toHaveBeenCalledOnce();
      send("status", { busy: false, terminalSession: declaration("B", "B") });
      await visible(w);
      expect(entry(w).attributes("aria-expanded")).toBe("false");
      expect(listeners.get("terminal")).toBe(privateListener);
      expect(registered.mock.calls.filter(([name]) => name === "terminal")).toHaveLength(1);
      expect(registered.mock.calls.filter(([name]) => name === "terminal_connection")).toHaveLength(1);
      send("terminal_connection", {
        connectionInstance: "existing",
        connectionToken: "private",
        expiresAt: Date.now() + 10000,
      });
      expect(frames.mock.calls.at(-1)?.[0].event).toBe("terminal_connection");
      expect(state.value.conn).toBe("open");
      expect(request).not.toHaveBeenCalled();
    } finally {
      stream.closeStream();
    }
  });
  it("dispose on declaration withdrawal makes late HTTP success inert for the successor scope", async () => {
    let resolve!: (value: any) => void;
    const pending = new Promise<any>((yes) => {
      resolve = yes;
    });
    const request = vi.fn(async () => pending); // deliberately ignores AbortSignal
    const make = (a: string) =>
      createTerminalController({
        transport: { request } as any,
        scope: { agentKey: a, expect: { sessionId: a, epoch: a } },
        clientId: () => "client",
        renderer: { write: async () => {}, reset() {}, dimensions: () => ({ cols: 80, rows: 24 }) },
      });
    const a = make("A");
    a.event("terminal_connection", {
      connectionInstance: "same",
      connectionToken: "private",
      expiresAt: Date.now() + 10000,
    });
    const flight = a.list().catch(() => {});
    a.dispose();
    const b = make("B");
    try {
      b.event("terminal_connection", {
        connectionInstance: "same",
        connectionToken: "private",
        expiresAt: Date.now() + 10000,
      });
      const before = JSON.stringify(b.state);
      resolve({ ok: true, revision: 1, rows: [{ termId: "old-A", ownerLabel: "private-A" }] });
      await flight;
      await flushPromises();
      expect(a.state.rows).toEqual([]);
      expect(JSON.stringify(b.state)).toBe(before);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      b.dispose();
    }
  });
});
