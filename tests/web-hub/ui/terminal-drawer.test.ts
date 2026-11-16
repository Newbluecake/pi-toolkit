// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { TERMINAL_RENDERER_FACTORY } from "../../../src/web-hub/ui/src/components/terminal/renderer-port.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  localStorage.clear();
  document.body.textContent = "";
  vi.unstubAllGlobals();
  resetLangForTests();
});
const caps = ["terminal.ui.v1", "terminal.session.v1"];
const row = {
  termId: "term",
  reservationId: "reservation",
  revision: 1,
  state: "live",
  nextInputSeq: 0,
  baseOffset: 0,
  nextOffset: 0,
  deadlines: { inputIdleAt: Date.now() + 60000, lifetimeAt: Date.now() + 120000, parentExpiresAt: Date.now() + 180000 },
};
function agent(activity = false): AgentState {
  return {
    key: "agent",
    card: { control: true, epoch: "epoch", kind: "tui", state: "live" },
    session: { sessionId: "session", name: "Test", mode: "tui" },
    status: {
      busy: false,
      terminalSession: {
        v: 1,
        enabled: true,
        sessionId: "session",
        epoch: "epoch",
        limits: { maxPerSession: 2, maxPerPrincipal: 2, maxTotal: 8, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
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
  const request = vi.fn(async (op: string) =>
    op === "list"
      ? { ok: true, revision: 1, rows: [row] }
      : op === "attach"
        ? { ok: true, ...row, attachmentId: "attachment", writerLease: "lease", replayMode: "cold", cwd: "/private" }
        : { ok: true, revision: 2 },
  );
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
  };
  const factory = vi.fn(async () => renderer);
  const selectRun = vi.fn();
  const unsubscribe = vi.fn();
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
          terminal: { request },
          selectRun,
          terminalEvents(fn: any) {
            fn("terminal_connection", {
              connectionInstance: "instance",
              connectionToken: "token",
              expiresAt: Date.now() + 60000,
            });
            return unsubscribe;
          },
        },
      },
    },
  });
  cleanups.push(() => w.unmount());
  const terminalButton = () => w.get('.fleet-summary-bar[data-panel="terminal"]');
  const panel = () => document.querySelector<HTMLElement>("#fleet-drawer .terminal-panel");
  async function ready() {
    await vi.waitFor(() => expect(w.find('.fleet-summary-bar[data-panel="terminal"]').exists()).toBe(true));
    expect(request).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  }
  async function open() {
    await terminalButton().trigger("click", { detail: 1 });
    await vi.waitFor(() => expect(panel()?.querySelector(".terminal-list")).toBeTruthy());
    await flushPromises();
  }
  async function attach() {
    panel()!.querySelector<HTMLButtonElement>(".terminal-list li button")!.click();
    await vi.waitFor(() => expect(request.mock.calls.some(([op]) => op === "attach")).toBe(true));
    await flushPromises();
    expect(panel()?.textContent).toContain("/private");
  }
  return {
    w,
    state,
    request,
    renderer,
    factory,
    selectRun,
    unsubscribe,
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
      const { w, request, renderer, unsubscribe, terminalButton, panel, ready, open, attach } = setup(mode);
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
      panel()!.querySelector<HTMLButtonElement>(".terminal-chrome button[aria-pressed]")!.click();
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
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([op]) => op === "detach")).toHaveLength(1);
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
      expect(request.mock.calls.some(([op]) => ["close", "open", "prepare"].includes(op))).toBe(false);
    },
  );

  it.each(["docked", "overlay", "fullscreen"] as const)(
    "%s: switching among three panels detaches without killing; return lists original termId",
    async (mode) => {
      const { w, request, renderer, panel, ready, open, attach } = setup(mode, true);
      await ready();
      expect(w.findAll(".fleet-summary-bar")).toHaveLength(3);
      await open();
      await attach();
      await w.get('.fleet-summary-bar[data-panel="bash"]').trigger("click", { detail: 1 });
      await flushPromises();
      expect(panel()).toBeNull();
      expect(w.find(".fleet-bash").exists()).toBe(true);
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([op]) => op === "detach")).toHaveLength(1);
      await w.get('.fleet-summary-bar[data-panel="agent"]').trigger("click", { detail: 1 });
      expect(w.find(".tree-scroll").exists()).toBe(true);
      await open();
      await attach();
      expect(request.mock.calls.filter(([op]) => op === "attach")).toHaveLength(2);
      expect(request.mock.calls.some(([op]) => ["close", "open", "prepare"].includes(op))).toBe(false);
      expect(localStorage.getItem("webhub.fleetDrawer.panel")).toBe("agent");
    },
  );

  it("breakpoint resets preserve docked open memory and detach terminal writers on overlay/fullscreen entry", async () => {
    localStorage.setItem("webhub.fleetDrawer.open", "1");
    const { w, request, panel, ready, open, attach, resize } = setup("docked");
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
    expect(request.mock.calls.filter(([op]) => op === "detach")).toHaveLength(2);
    expect(request.mock.calls.some(([op]) => op === "close")).toBe(false);
    await resize("docked");
    expect(w.attributes("data-drawer-open")).toBeDefined();
    await vi.waitFor(() => expect(panel()?.querySelector(".terminal-list")).toBeTruthy());
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
    expect(w.text()).not.toContain("/private");
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
