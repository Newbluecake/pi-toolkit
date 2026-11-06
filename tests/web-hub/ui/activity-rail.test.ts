// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActivityRail } from "../../../src/web-hub/ui/src/composables/useActivityRail.js";
import FleetSummaryBar from "../../../src/web-hub/ui/src/components/fleet/FleetSummaryBar.vue";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { FleetDrawerMode } from "../../../src/web-hub/ui/src/contracts.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.textContent = "";
});
function setup() {
  vi.useFakeTimers();
  const scope = effectScope();
  cleanups.push(() => scope.stop());
  const deps = {
    mode: ref<FleetDrawerMode>("docked"),
    pinnedOpen: ref(false),
    hoverFine: ref(true),
    hasAgent: ref(true),
    hasBash: ref(true),
    deselectRun: vi.fn(),
  };
  const rail = scope.run(() => useActivityRail(deps))!;
  const button = document.createElement("button");
  document.body.append(button);
  const pointer = { pointerType: "mouse", currentTarget: button } as unknown as PointerEvent;
  return { rail, deps, pointer, button };
}
describe("activity rail intent state machine", () => {
  it("pointerdown pins logically but defers dock until click; cancel/blur/up/close/switch clean guards", async () => {
    const { rail, pointer } = setup();
    const remove = vi.spyOn(document, "removeEventListener");
    for (const finish of ["click", "pointercancel", "blur", "pointerup", "close", "switch"] as const) {
      rail.close();
      rail.enter("agent", pointer);
      vi.advanceTimersByTime(120);
      rail.promote(true);
      expect(rail.peeking.value).toBe(false);
      expect(rail.effectiveMode.value).toBe("overlay");
      if (finish === "click") rail.releaseInteraction();
      if (finish === "pointercancel") document.dispatchEvent(new Event("pointercancel"));
      if (finish === "blur") window.dispatchEvent(new Event("blur"));
      if (finish === "pointerup") {
        document.dispatchEvent(new Event("pointerup"));
        await nextTick();
        expect(rail.effectiveMode.value).toBe("overlay"); // never pointerup microtask
        vi.advanceTimersByTime(0);
      }
      if (finish === "close") rail.close();
      if (finish === "switch") rail.toggle("bash", "pointer");
      expect(rail.effectiveMode.value).toBe("docked");
    }
    expect(remove.mock.calls.some((c) => c[0] === "pointerup")).toBe(true);
    remove.mockRestore();
  });

  it("120ms enter, 280ms leave, re-entry cancels exit; never touches pinned state", async () => {
    const { rail, deps, pointer } = setup();
    rail.enter("agent", pointer);
    vi.advanceTimersByTime(119);
    expect(rail.open.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(rail.peeking.value).toBe(true);
    expect(rail.effectiveMode.value).toBe("overlay");
    rail.leave();
    vi.advanceTimersByTime(279);
    expect(rail.open.value).toBe(true);
    rail.keep();
    vi.advanceTimersByTime(1);
    expect(rail.open.value).toBe(true);
    rail.enter("bash", pointer);
    expect(rail.panel.value).toBe("bash");
    rail.leave();
    vi.advanceTimersByTime(280);
    expect(rail.open.value).toBe(false);
    expect(deps.pinnedOpen.value).toBe(false);
    expect(deps.deselectRun).not.toHaveBeenCalled();
  });
  it("promotes interaction before leaving, ignores other hover, click switches and closes", () => {
    const { rail, deps, pointer, button } = setup();
    rail.enter("agent", pointer);
    vi.advanceTimersByTime(120);
    rail.leave();
    rail.promote();
    vi.advanceTimersByTime(1000);
    expect(rail.open.value).toBe(true);
    expect(rail.effectiveMode.value).toBe("docked");
    rail.enter("bash", pointer);
    expect(rail.panel.value).toBe("agent");
    rail.toggle("bash", "keyboard", button);
    expect(rail.panel.value).toBe("bash");
    expect(rail.origin.value).toBe("keyboard");
    expect(deps.deselectRun).toHaveBeenCalledOnce();
    rail.toggle("bash", "pointer", button);
    expect(rail.open.value).toBe(false);
  });
  it("phone, coarse and touch events cannot peek; boundary change clears pending hover", async () => {
    const { rail, deps, pointer } = setup();
    rail.enter("agent", { ...pointer, pointerType: "touch" });
    vi.advanceTimersByTime(120);
    expect(rail.open.value).toBe(false);
    deps.hoverFine.value = false;
    await nextTick();
    rail.enter("agent", pointer);
    vi.advanceTimersByTime(120);
    expect(rail.open.value).toBe(false);
    deps.hoverFine.value = true;
    deps.mode.value = "fullscreen";
    await nextTick();
    rail.enter("agent", pointer);
    vi.advanceTimersByTime(120);
    expect(rail.open.value).toBe(false);
    deps.mode.value = "overlay";
    await nextTick();
    rail.enter("agent", pointer);
    deps.mode.value = "fullscreen";
    await nextTick();
    vi.advanceTimersByTime(120);
    expect(rail.open.value).toBe(false);
  });
  it("data disappearance falls back to available type and disposal cancels timers", async () => {
    const { rail, deps, pointer } = setup();
    rail.enter("agent", pointer);
    vi.advanceTimersByTime(120);
    deps.hasAgent.value = false;
    await nextTick();
    expect(rail.open.value).toBe(false);
    expect(rail.panel.value).toBe("bash");
    rail.toggle("bash", "pointer");
    expect(rail.open.value).toBe(true);
    deps.hasBash.value = false;
    await nextTick();
    expect(rail.open.value).toBe(false);
  });
});
const row = {
  runId: "r1",
  label: "worker",
  status: "running",
  terminal: false,
  phaseLabel: "working",
  elapsedMs: 1,
  phaseMs: 0,
  highlight: "none",
};
const jobs = {
  v: 1,
  sampledAt: 1000,
  total: 1,
  running: 1,
  failed: 0,
  omitted: 0,
  rows: [{ id: "job1", command: "npm run build", status: "running", elapsedMs: 1, createdAt: 1 }],
};
function agent(): AgentState {
  return {
    key: "A",
    card: { control: true, runTranscript: true, state: "live" },
    down: false,
    prompts: [],
    fleet: [row],
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
    dialogs: { epoch: "e1", open: [], closed: [] },
    pendingCtl: [],
    runSel: null,
    runTx: null,
    status: { busy: false, pending: false, bashJobs: jobs },
  } as unknown as AgentState;
}
function detail(mode: "docked" | "overlay" | "fullscreen" = "overlay") {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches:
      q === "(hover: hover) and (pointer: fine)" ||
      (q === "(min-width: 1280px)" && mode === "docked") ||
      (q === "(max-width: 767px)" && mode === "fullscreen"),
    addEventListener() {},
    removeEventListener() {},
  }));
  const selectRun = vi.fn();
  const w = mount(AgentDetail, {
    props: { agent: agent(), now: 1000, narrow: false },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: { state: ref({ control: true }), selectRun, control: undefined } } },
  });
  cleanups.push(() => w.unmount());
  return { w, selectRun };
}
describe("real components (not mock HTML)", () => {
  it("separate badges, 99+ full accessible count, empty classes hidden", () => {
    const w = mount(FleetSummaryBar, {
      props: { rows: Array.from({ length: 101 }, () => row) as never[], bashJobs: jobs as never, open: false },
    });
    cleanups.push(() => w.unmount());
    expect(w.get('[data-panel="agent"] .num').text()).toBe("99+");
    expect(w.get('[data-panel="agent"]').attributes("aria-label")).toContain("101 running");
    expect(w.get('[data-panel="bash"] .num').text()).toBe("1");
  });
  it("production passes explicit panel, rail and drawer share split, pointer opens do not focus close", async () => {
    const { w } = detail();
    expect(w.findAll(".detail-split > .activity-rail")).toHaveLength(1);
    const drawer = w.getComponent(FleetDrawer);
    expect(drawer.props("panel")).toBe("agent");
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await w.get('[data-panel="bash"].fleet-summary-bar').trigger("click", { detail: 1 });
    await nextTick();
    expect(drawer.props("panel")).toBe("bash");
    expect(drawer.find(".tree").exists()).toBe(false);
    expect(drawer.find(".fleet-bash").exists()).toBe(true);
    expect(document.activeElement).toBe(outside);
    await drawer.get(".drawer-close").trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(w.get('[data-panel="bash"].fleet-summary-bar').element);
  });
  it("peek preserves focus; capture interaction pins before run selection, close unsubscribes", async () => {
    vi.useFakeTimers();
    const { w, selectRun } = detail();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await w.get('[data-panel="agent"].fleet-summary-bar').trigger("pointerenter", { pointerType: "mouse" });
    vi.advanceTimersByTime(120);
    await nextTick();
    expect(w.attributes("data-peek-open")).toBeDefined();
    expect(w.attributes("data-docked-open")).toBeUndefined();
    expect(document.activeElement).toBe(input);
    const run = w.get(".run-open");
    await run.trigger("pointerdown");
    await run.trigger("click");
    await nextTick();
    expect(w.attributes("data-peek-open")).toBeUndefined();
    expect(selectRun).toHaveBeenCalledWith("A", "r1");
    await w.get("#fleet-drawer").trigger("pointerleave");
    vi.advanceTimersByTime(280);
    await nextTick();
    expect(w.attributes("data-drawer-open")).toBeDefined();
    await w.setProps({ agent: { ...agent(), runSel: "r1" } as AgentState });
    await w.get(".drawer-close").trigger("click");
    expect(selectRun).toHaveBeenCalledWith("A", null);
  });
  it("keyboard open focuses close; fullscreen makes background inert and restores it", async () => {
    const { w } = detail("fullscreen");
    await w.get(".fleet-summary-bar").trigger("focus");
    expect(w.attributes("data-drawer-open")).toBeUndefined();
    await w.get(".fleet-summary-bar").trigger("click", { detail: 0 });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(w.get(".drawer-close").element);
    expect((w.get(".detail-main").element as HTMLElement).inert).toBe(true);
    await w.get(".drawer-close").trigger("click");
    await nextTick();
    expect((w.get(".detail-main").element as HTMLElement).inert).toBeFalsy();
  });
});

describe("#48 phone-only shared rail background", () => {
  it("uses the fullscreen width breakpoint, themed surface and no overflow clipping; desktop stays transparent", () => {
    const css = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/fleet.css"),
      "utf8",
    );
    const base = css.match(/\.activity-rail\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(base).toMatch(/background:\s*transparent/);
    expect(base).toMatch(/border:\s*0/);
    expect(base).toMatch(/box-shadow:\s*none/);
    const phone = css.match(/@media\s*\(max-width:\s*767px\)\s*\{\s*\.activity-rail\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(phone).toContain("background: var(--c-surface)");
    expect(phone).toContain("border: 1px solid var(--c-border)");
    expect(phone).toContain("box-shadow: var(--shadow-2)");
    expect(phone).toContain("padding: var(--sp-1)");
    expect(phone).not.toMatch(/overflow|width:|height:|pointer/);
  });
  it("one category produces one content-sized shared container; no records produce none", async () => {
    const w = mount(FleetSummaryBar, { props: { rows: [row] as never[], open: false } });
    cleanups.push(() => w.unmount());
    expect(w.findAll(".activity-rail")).toHaveLength(1);
    expect(w.findAll(".fleet-summary-bar")).toHaveLength(1);
    await w.setProps({ bashJobs: jobs as never });
    expect(w.findAll(".activity-rail")).toHaveLength(1);
    expect(w.findAll(".fleet-summary-bar")).toHaveLength(2);
    await w.setProps({ rows: [], bashJobs: undefined });
    expect(w.find(".activity-rail").exists()).toBe(false);
  });
});
