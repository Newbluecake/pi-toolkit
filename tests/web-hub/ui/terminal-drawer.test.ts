// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { TERMINAL_RENDERER_FACTORY } from "../../../src/web-hub/ui/src/components/terminal/renderer-port.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { attachedFrameV2, createTerminalMockV2 } from "./terminal-v2-fixtures.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  localStorage.clear();
  sessionStorage.clear();
  document.body.textContent = "";
  vi.unstubAllGlobals();
  resetLangForTests();
});
const caps = ["terminal.tabs.v2"];
function agent(activity = false): AgentState {
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
      ...(activity
        ? {
            bashJobs: {
              v: 1,
              sampledAt: 1,
              total: 1,
              running: 1,
              failed: 0,
              omitted: 0,
              rows: [{ id: "job", command: "build", status: "running", elapsedMs: 1, createdAt: 1 }],
            },
          }
        : {}),
    },
    down: false,
    prompts: [],
    fleet: activity
      ? [
          {
            runId: "r1",
            label: "worker",
            status: "running",
            terminal: false,
            phaseLabel: "working",
            elapsedMs: 1,
            phaseMs: 0,
            highlight: "none",
          },
        ]
      : [],
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
function setup(mode: "docked" | "overlay" | "fullscreen", activity = false, enabled = true) {
  setLangOverride("en");
  const media: Array<{ query: string; callback?: (event: { matches: boolean }) => void }> = [];
  const matches = (query: string, current: typeof mode) =>
    (query === "(min-width: 1280px)" && current === "docked") ||
    (query === "(max-width: 767px)" && current === "fullscreen");
  vi.stubGlobal("matchMedia", (query: string) => {
    const entry = { query } as (typeof media)[number];
    media.push(entry);
    return {
      matches: matches(query, mode),
      addEventListener(_type: string, callback: (event: { matches: boolean }) => void) {
        entry.callback = callback;
      },
      removeEventListener() {
        delete entry.callback;
      },
    };
  });
  async function resize(current: typeof mode) {
    for (const entry of media) entry.callback?.({ matches: matches(entry.query, current) });
    await nextTick();
    await flushPromises();
  }
  const state = ref<any>({ control: true, conn: "open", clientId: "client", hub: { caps: enabled ? caps : [] } });
  const mock = createTerminalMockV2((op, body) => {
    if (op === "ack" && "offset" in body && body.replayComplete)
      queueMicrotask(() => mock.views.at(-1)?.emit({ t: "ready", offset: body.offset }));
    return undefined;
  });
  const request = mock.request;
  const renderer = {
    terminal: {
      cols: 80,
      rows: 24,
      reset: vi.fn(),
      onData: () => ({ dispose() {} }),
      onBinary: () => ({ dispose() {} }),
    },
    fit: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(async () => {}),
    setFontSize: vi.fn(),
  };
  const factory = vi.fn(async () => renderer);
  // This happy-dom fixture supplies explicit stylesheet success, just as the
  // injected renderer supplies geometry. Actual network/CSP cases are browser probes.
  const css = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof HTMLLinkElement && node.rel === "stylesheet") node.dispatchEvent(new Event("load"));
  });
  css.observe(document.head, { childList: true });
  cleanups.push(() => css.disconnect());
  const selectRun = vi.fn();
  const w = mount(AgentDetail, {
    props: { agent: agent(activity), now: 10000, narrow: mode === "fullscreen" },
    attachTo: document.body,
    global: {
      stubs: { DetailDock: true, DetailBody: true },
      provide: {
        [TERMINAL_RENDERER_FACTORY as symbol]: factory,
        [HUB_CTX as symbol]: {
          state,
          control: {},
          terminalV2: mock.transport,
          selectRun,
        },
      },
    },
  });
  cleanups.push(() => w.unmount());
  const terminalButton = () => w.get('.fleet-summary-bar[data-panel="terminal"]');
  const panel = () => document.querySelector<HTMLElement>("#fleet-drawer .terminal-v2-panel");
  async function ready() {
    await vi.waitFor(() => expect(w.find('.fleet-summary-bar[data-panel="terminal"]').exists()).toBe(true));
    expect(request).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  }
  async function open() {
    const count = mock.views.length;
    await terminalButton().trigger("click", { detail: 1 });
    await vi.waitFor(() => expect(mock.views.length).toBe(count + 1));
    const view = mock.views.at(-1)!;
    view.emit(attachedFrameV2(view.body.termId));
    view.emit({ t: "replay-end", offset: 0 });
    await flushPromises();
    await vi.waitFor(() => expect(panel()?.dataset.writable).toBe("true"));
  }
  async function attach() {
    expect(mock.views.at(-1)?.signal.aborted).toBe(false);
    expect(panel()?.textContent).toContain("/work");
  }
  return {
    w,
    state,
    request,
    renderer,
    factory,
    selectRun,
    mock,
    terminalButton,
    panel,
    ready,
    open,
    attach,
    resize,
  };
}

describe("terminal is the third FleetDrawer panel, not transcript content", () => {
  it.each(["docked", "overlay", "fullscreen"] as const)(
    "%s: terminal-only eligibility mounts a closed drawer; rail/header open it and close only detaches",
    async (mode) => {
      const { w, request, renderer, mock, terminalButton, panel, ready, open, attach } = setup(mode);
      await ready();
      expect(w.get("#fleet-drawer").attributes("data-mode")).toBe(mode);
      expect(w.attributes("data-drawer-open")).toBeUndefined();
      expect(w.find(".detail-main .terminal-panel-host").exists()).toBe(false);
      await open();
      expect(panel()).not.toBeNull();
      expect(w.get("#fleet-drawer").attributes("data-panel")).toBe("terminal");
      expect(terminalButton().attributes("aria-expanded")).toBe("true");
      expect(w.get('[data-fold="terminal"]').attributes("aria-controls")).toBe("fleet-drawer");
      expect(w.get('[data-fold="terminal"]').attributes("aria-expanded")).toBe("true");
      if (mode === "fullscreen") expect((w.get(".detail-main").element as HTMLElement).inert).toBe(true);
      await attach();
      // Escape on chrome as well as TTY must preserve the terminal drawer and maximization.
      panel()!.querySelector<HTMLButtonElement>(".terminal-v2-chrome button[aria-pressed]")!.click();
      await nextTick();
      expect(panel()?.classList.contains("is-maximized")).toBe(true);
      w.get(".drawer-close").element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await nextTick();
      expect(w.attributes("data-drawer-open")).toBeDefined();
      expect(panel()?.classList.contains("is-maximized")).toBe(true);
      expect(request.mock.calls.some(([op]) => op === "close")).toBe(false);
      await w.get(".drawer-close").trigger("click");
      await flushPromises();
      expect(panel()).toBeNull();
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(mock.views.filter((v) => v.signal.aborted)).toHaveLength(1);
      expect(request.mock.calls.some(([op]) => op === "close")).toBe(false);
      expect(w.attributes("data-drawer-open")).toBeUndefined();
      expect((w.get(".detail-main").element as HTMLElement).inert).not.toBe(true);
      const header = w.get('[data-fold="terminal"]');
      await header.trigger("click", { detail: 0 });
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      await flushPromises();
      expect(w.get("#fleet-drawer").attributes("data-panel")).toBe("terminal");
      expect(document.activeElement).toBe(w.get(".drawer-close").element);
      // show, unlike rail.toggle, is idempotent when already open.
      await header.trigger("click", { detail: 0 });
      expect(w.attributes("data-drawer-open")).toBeDefined();
      await terminalButton().trigger("click", { detail: 1 });
      await flushPromises();
      expect(panel()).toBeNull();
      expect(request.mock.calls.some(([op]) => ["close", "create"].includes(op))).toBe(false);
    },
  );

  it.each(["docked", "overlay", "fullscreen"] as const)(
    "%s: switching among three panels detaches without killing; return lists original termId",
    async (mode) => {
      const { w, request, renderer, mock, panel, ready, open, attach } = setup(mode, true);
      await ready();
      expect(w.findAll(".fleet-summary-bar")).toHaveLength(3);
      await open();
      await attach();
      await w.get('.fleet-summary-bar[data-panel="bash"]').trigger("click", { detail: 1 });
      await flushPromises();
      expect(panel()).toBeNull();
      expect(w.find(".fleet-bash").exists()).toBe(true);
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(mock.views.filter((v) => v.signal.aborted)).toHaveLength(1);
      await w.get('.fleet-summary-bar[data-panel="agent"]').trigger("click", { detail: 1 });
      expect(w.find(".tree-scroll").exists()).toBe(true);
      await open();
      await attach();
      expect(mock.views).toHaveLength(2);
      expect(request.mock.calls.some(([op]) => ["close", "create"].includes(op))).toBe(false);
      expect(localStorage.getItem("webhub.fleetDrawer.panel")).toBe("agent");
    },
  );

  it("breakpoint resets preserve docked open memory and detach terminal writers on overlay/fullscreen entry", async () => {
    localStorage.setItem("webhub.fleetDrawer.open", "1");
    const { w, request, mock, panel, ready, open, attach, resize } = setup("docked");
    await ready();
    await open();
    await attach();
    expect(localStorage.getItem("webhub.fleetDrawer.open")).toBe("1");
    await resize("overlay");
    expect(w.attributes("data-drawer")).toBe("overlay");
    expect(panel()).toBeNull();
    expect(w.attributes("data-drawer-open")).toBeUndefined();
    await open();
    await attach();
    await resize("fullscreen");
    expect(panel()).toBeNull();
    expect(w.attributes("data-drawer-open")).toBeUndefined();
    expect(localStorage.getItem("webhub.fleetDrawer.open")).toBe("1");
    expect(mock.views.filter((v) => v.signal.aborted)).toHaveLength(2);
    expect(request.mock.calls.some(([op]) => op === "close")).toBe(false);
    await resize("docked");
    expect(w.attributes("data-drawer-open")).toBeDefined();
    await vi.waitFor(() => expect(panel()?.querySelector(".terminal-v2-tabs")).toBeTruthy());
  });

  it("overlay outside close releases the renderer without a close API; revoked material cannot revive on re-eligibility", async () => {
    const { w, state, request, renderer, panel, ready, open, attach } = setup("overlay");
    await ready();
    await open();
    await attach();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(panel()).toBeNull();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    await open();
    await attach();
    state.value = { ...state.value, hub: { caps: [] } };
    // The eligibility watch clears the manually rendered view synchronously, before Vue's patch.
    expect(panel()).toBeNull();
    await nextTick();
    expect(w.find("#fleet-drawer").exists()).toBe(false);
    expect(w.text()).not.toContain("/work");
    state.value = { ...state.value, hub: { caps } };
    await vi.waitFor(() => expect(w.find('.fleet-summary-bar[data-panel="terminal"]').exists()).toBe(true));
    expect(panel()).toBeNull();
    expect(w.attributes("data-drawer-open")).toBeUndefined();
    expect(request.mock.calls.some(([op]) => op === "close")).toBe(false);
  });

  it("no cap leaves the original no-content drawer unmounted, and legacy activity has exactly two buttons", async () => {
    const { w, request, factory } = setup("docked", false, false);
    await flushPromises();
    expect(w.find("#fleet-drawer").exists()).toBe(false);
    expect(w.find(".activity-rail").exists()).toBe(false);
    expect(w.find('[data-fold="terminal"]').exists()).toBe(false);
    const off = w.html();
    await w.setProps({ agent: { ...agent(), status: { busy: false } } as AgentState });
    await flushPromises();
    expect(w.html()).toBe(off);
    await w.setProps({ agent: agent(true) });
    await flushPromises();
    expect(w.findAll(".fleet-summary-bar")).toHaveLength(2);
    expect(w.get("#fleet-drawer").attributes("data-panel")).toBe("bash"); // original empty→data fallback
    expect(request).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(document.head.querySelector('link[href*="terminal"]')).toBeNull();
  });
});
