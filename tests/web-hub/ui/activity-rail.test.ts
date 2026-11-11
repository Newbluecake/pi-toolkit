// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActivityRail } from "../../../src/web-hub/ui/src/composables/useActivityRail.js";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
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
  resetLangForTests();
  localStorage.clear();
  document.body.textContent = "";
});
function setup() {
  vi.useFakeTimers();
  const scope = effectScope();
  cleanups.push(() => scope.stop());
  const deps = {
    mode: ref<FleetDrawerMode>("docked"),
    drawerOpen: ref(false),
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
  it("click opens, switches panels, and clicking the active panel closes", () => {
    const { rail, deps, button } = setup();
    rail.toggle("agent", "pointer", button);
    expect(rail.open.value).toBe(true);
    expect(rail.panel.value).toBe("agent");
    rail.toggle("bash", "keyboard", button);
    expect(rail.panel.value).toBe("bash");
    expect(rail.origin.value).toBe("keyboard");
    expect(deps.deselectRun).toHaveBeenCalledOnce();
    rail.toggle("bash", "pointer", button);
    expect(rail.open.value).toBe(false);
  });
  it("data disappearance falls back to available type", async () => {
    const { rail, deps } = setup();
    rail.toggle("agent", "pointer");
    deps.hasAgent.value = false;
    await nextTick();
    expect(rail.panel.value).toBe("bash");
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
function detail(mode: "docked" | "overlay" | "fullscreen" = "overlay", initialAgent = agent()) {
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
    props: { agent: initialAgent, now: 1000, narrow: false },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: { state: ref({ control: true }), selectRun, control: undefined } } },
  });
  cleanups.push(() => w.unmount());
  return { w, selectRun };
}
describe("real components (not mock HTML)", () => {
  it("persists a switched panel and restores it after remount without changing drawer-open memory", async () => {
    localStorage.setItem("webhub.fleetDrawer.open", "1");
    const first = detail("docked").w;
    expect(first.getComponent(FleetDrawer).props("panel")).toBe("agent");
    await first.get('[data-panel="bash"].fleet-summary-bar').trigger("click", { detail: 1 });
    expect(localStorage.getItem("webhub.fleetDrawer.panel")).toBe("bash");
    expect(localStorage.getItem("webhub.fleetDrawer.open")).toBe("1");
    first.unmount();
    const second = detail("docked").w;
    expect(second.getComponent(FleetDrawer).props("panel")).toBe("bash");
    expect(second.attributes("data-drawer-open")).toBeDefined();
    await second.get('[data-panel="agent"].fleet-summary-bar').trigger("click", { detail: 1 });
    expect(localStorage.getItem("webhub.fleetDrawer.panel")).toBe("agent");
    second.unmount();
    const third = detail("docked").w;
    expect(third.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("rejects unknown stored panels and preserves the initial agent default", () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "__proto__");
    expect(detail("docked").w.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("falls back when the saved panel has no content, then restores if its data arrives late", async () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "agent");
    const { w } = detail("docked");
    await w.setProps({ agent: { ...agent(), fleet: [] } as AgentState });
    w.unmount();
    const emptyAgent = { ...agent(), fleet: [] } as AgentState;
    const restored = mount(AgentDetail, {
      props: { agent: emptyAgent, now: 1000, narrow: false },
      attachTo: document.body,
    });
    cleanups.push(() => restored.unmount());
    expect(restored.getComponent(FleetDrawer).props("panel")).toBe("bash");
    await restored.setProps({ agent: agent() });
    expect(restored.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("falls back to agent when a saved bash panel has no jobs", () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "bash");
    const noJobs = { ...agent(), status: { busy: false, pending: false } } as AgentState;
    const w = mount(AgentDetail, { props: { agent: noJobs, now: 1000, narrow: false } });
    cleanups.push(() => w.unmount());
    expect(w.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("keeps an explicitly opened run on agent when saved bash jobs arrive late", async () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "bash");
    const noJobs = { ...agent(), status: { busy: false, pending: false } } as AgentState;
    const { w, selectRun } = detail("docked", noJobs);
    expect(w.getComponent(FleetDrawer).props("panel")).toBe("agent");
    await w.get(".run-open").trigger("click");
    expect(selectRun).toHaveBeenCalledWith("A", "r1");
    await w.setProps({ agent: { ...noJobs, runSel: "r1" } as AgentState });
    await w.setProps({ agent: { ...agent(), runSel: "r1" } as AgentState });
    expect(w.getComponent(FleetDrawer).props("panel")).toBe("agent");
    expect(selectRun).not.toHaveBeenCalledWith("A", null);
    expect(w.find(".run-head").exists()).toBe(true);
  });
  it("restores late bash without interaction, but not after an explicit panel toggle", async () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "bash");
    const noJobs = { ...agent(), status: { busy: false, pending: false } } as AgentState;
    const first = detail("docked", noJobs).w;
    expect(first.getComponent(FleetDrawer).props("panel")).toBe("agent");
    await first.setProps({ agent: agent() });
    expect(first.getComponent(FleetDrawer).props("panel")).toBe("bash");
    first.unmount();
    const second = detail("docked", noJobs).w;
    await second.get('[data-panel="agent"].fleet-summary-bar').trigger("click");
    await second.setProps({ agent: agent() });
    expect(second.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("cancels late restore when the user expands an agent tree node", async () => {
    localStorage.setItem("webhub.fleetDrawer.panel", "bash");
    const noJobs = {
      ...agent(),
      fleet: [row, { ...row, runId: "r2", parentRunId: "r1" }],
      status: { busy: false, pending: false },
    } as AgentState;
    const { w } = detail("docked", noJobs);
    await w.get(".tree summary").trigger("click");
    await w.setProps({ agent: { ...noJobs, status: agent().status } as AgentState });
    expect(w.getComponent(FleetDrawer).props("panel")).toBe("agent");
  });
  it("separate badges, 99+ full accessible count, empty classes hidden", () => {
    const w = mount(FleetSummaryBar, {
      props: { rows: Array.from({ length: 101 }, () => row) as never[], bashJobs: jobs as never, open: false },
    });
    cleanups.push(() => w.unmount());
    expect(w.get('[data-panel="agent"] .num').text()).toBe("99+");
    expect(w.get('[data-panel="agent"]').attributes("aria-label")).toContain("101 running");
    expect(w.get('[data-panel="bash"] .num').text()).toBe("1");
  });
  it("keeps the legacy no-omission label and DOM semantics", async () => {
    const w = mount(FleetSummaryBar, { props: { rows: [row] as never[], open: false } });
    cleanups.push(() => w.unmount());
    const button = w.get('[data-panel="agent"]');
    expect(button.attributes("aria-label")).toBe("Agents · 1 running · 1 total · $0");
    expect(button.get(".num").text()).toBe("1");
    const legacyHtml = w.html();
    await w.setProps({ omitted: { active: 0, terminal: 0 } });
    expect(w.html()).toBe(legacyHtml);
    await w.setProps({ rows: [], omitted: undefined });
    expect(w.find(".activity-rail").exists()).toBe(false);
  });
  it("keeps an omitted-only agent entry usable and labels active/terminal omissions honestly", async () => {
    const w = mount(FleetSummaryBar, {
      props: { rows: [] as never[], omitted: { active: 2, terminal: 3 }, open: false },
    });
    cleanups.push(() => w.unmount());
    const button = w.get('[data-panel="agent"]');
    const label = button.attributes("aria-label") ?? "";
    expect(label).toContain("0 listed · listed cost $0");
    expect(label).toContain("2 more active not listed");
    expect(label).toContain("3 more terminal not listed");
    expect(label).not.toContain("2 running");
    expect(button.find(".fab-count").exists()).toBe(false);
    await button.trigger("click", { detail: 0 });
    expect(w.emitted("toggle-panel")?.[0]?.[0]).toBe("agent");
  });
  it("uses the symmetric Chinese listed/omitted summary copy", () => {
    setLangOverride("zh");
    const w = mount(FleetSummaryBar, {
      props: { rows: [] as never[], omitted: { active: 2, terminal: 3 }, open: false },
    });
    cleanups.push(() => w.unmount());
    const label = w.get('[data-panel="agent"]').attributes("aria-label") ?? "";
    expect(label).toContain("已列出 0 个 · 已列出成本 $0");
    expect(label).toContain("另有 2 个活跃项未列出");
    expect(label).toContain("另有 3 个终态项未列出");
  });
  it("with omissions, summary totals and cost describe only received rows", () => {
    const received = [
      { ...row, runId: "done-1", status: "completed", terminal: true, costUsd: 0.25 },
      { ...row, runId: "done-2", status: "failed", terminal: true, costUsd: 1 },
    ];
    const w = mount(FleetSummaryBar, {
      props: { rows: received as never[], omitted: { active: 7, terminal: 12 }, open: false },
    });
    cleanups.push(() => w.unmount());
    const label = w.get('[data-panel="agent"]').attributes("aria-label") ?? "";
    expect(label).toContain("2 listed · listed cost $1.25");
    expect(label).toContain("7 more active not listed");
    expect(label).toContain("12 more terminal not listed");
    expect(label).not.toContain("21 total");
    expect(label).not.toContain("14 total");
  });
  it("production passes explicit panel, rail and drawer share split, pointer opens do not focus close", async () => {
    const { w } = detail();
    // Task60: rail 不再是 split 的直属子节点，而是常驻浮动宿主的 Teleport 内容（仍是唯一一份）
    expect(w.findAll(".detail-split [data-rail-host='floating'] .activity-rail")).toHaveLength(1);
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
  it("hover does not open; click opens and pointer leave does not close or deselect", async () => {
    vi.useFakeTimers();
    const { w, selectRun } = detail();
    const button = w.get('[data-panel="agent"].fleet-summary-bar');
    await button.trigger("pointerenter", { pointerType: "mouse" });
    vi.advanceTimersByTime(500);
    await nextTick();
    expect(w.attributes("data-drawer-open")).toBeUndefined();
    await button.trigger("click", { detail: 1 });
    await w.get(".run-open").trigger("click");
    expect(selectRun).toHaveBeenCalledWith("A", "r1");
    await w.get("#fleet-drawer").trigger("pointerleave");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(w.attributes("data-drawer-open")).toBeDefined();
    await w.setProps({ agent: { ...agent(), runSel: "r1" } as AgentState });
    await w.get(".drawer-close").trigger("click");
    expect(selectRun).toHaveBeenCalledWith("A", null);
    expect(w.attributes("data-drawer-open")).toBeUndefined();
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

describe("Task60 compact panel: 零预留列 + 单实例双宿主（compact-panel-plan §2）", () => {
  const agentBtn = () => document.querySelector<HTMLElement>('[data-panel="agent"][aria-controls="fleet-drawer"]');
  const drawerRoot = () => document.querySelector<HTMLElement>("#fleet-drawer");

  it("manual open: 同一按钮 DOM 节点从浮动宿主迁入公共头部（无第二份、click 恰一次）", async () => {
    const { w } = detail();
    const btn = w.get('[data-panel="agent"].fleet-summary-bar').element;
    expect(btn.closest('[data-rail-host="floating"]')).not.toBeNull();
    let toggles = 0;
    w.get('[data-panel="agent"].fleet-summary-bar').element.addEventListener("click", () => toggles++);
    await w.get('[data-panel="agent"].fleet-summary-bar').trigger("click", { detail: 1 });
    await nextTick();
    await nextTick();
    expect(toggles).toBe(1); // click 恰一次，迁移不重派
    expect(w.get('[data-panel="agent"].fleet-summary-bar').element).toBe(btn); // 同一 DOM 节点
    expect(btn.closest('[data-rail-host="header"]')).not.toBeNull(); // 迁入头部宿主
    expect(btn.closest(".drawer-head")).not.toBeNull(); // 公共头部正常流 flex item
    expect(document.querySelectorAll('[aria-controls="fleet-drawer"]')).toHaveLength(2); // 仍各类型最多一个
    // manual overlay：无 data-floating、无桥
    expect(drawerRoot()!.hasAttribute("data-floating")).toBe(false);
    expect(drawerRoot()!.querySelector(".activity-bridge")).toBeNull();
  });

  it("关闭回到浮动宿主；子详情公共头部不重复 close，back 退选但入口宿主不销毁", async () => {
    const { w, selectRun } = detail();
    const btn = w.get('[data-panel="agent"].fleet-summary-bar').element;
    await w.get('[data-panel="agent"].fleet-summary-bar').trigger("click", { detail: 1 });
    await nextTick();
    expect(btn.closest('[data-rail-host="header"]')).not.toBeNull();
    // 选入子详情：公共头部保留入口，无重复 close；RunHeader 保留 back/name/status/close
    await w.setProps({ agent: { ...agent(), runSel: "r1" } as AgentState });
    await nextTick();
    const head = drawerRoot()!.querySelector(".drawer-head")!;
    expect(head.querySelector('[data-rail-host="header"]')).not.toBeNull();
    expect(head.querySelector(".activity-pin")).toBeNull();
    expect(head.querySelector(".drawer-close")).toBeNull(); // 公共头部不重复 close
    const runHead = drawerRoot()!.querySelector(".run-head")!;
    expect(runHead.querySelector(".drawer-back")).not.toBeNull();
    expect(runHead.querySelector(".run-head-name")).not.toBeNull();
    expect(runHead.querySelector(".run-head .drawer-close")).not.toBeNull();
    expect(btn.closest('[data-rail-host="header"]')).not.toBeNull(); // 分支切换不销毁宿主
    // back：退选 run，抽屉保持打开，入口仍在头部
    await w.get(".drawer-back").trigger("click");
    await nextTick();
    expect(selectRun).toHaveBeenCalledWith("A", null);
    expect(btn.closest('[data-rail-host="header"]')).not.toBeNull();
    // 关闭：迁回浮动宿主（同一节点）
    await w.get(".drawer-close").trigger("click");
    await nextTick();
    await nextTick();
    expect(w.get('[data-panel="agent"].fleet-summary-bar').element).toBe(btn);
    expect(btn.closest('[data-rail-host="floating"]')).not.toBeNull();
  });

  it("Teleport 迁移不丢 rail 内焦点：仅还给同一节点，不抢其它焦点", async () => {
    const { w } = detail();
    const btn = w.get('[data-panel="agent"].fleet-summary-bar').element as HTMLElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await w.get('[data-panel="agent"].fleet-summary-bar').trigger("click", { detail: 1 });
    await nextTick();
    await nextTick();
    // 迁移后焦点仍在同一按钮（浏览器丢焦 ⇒ 同节点恢复；happy-dom 未丢焦则本就保持）
    expect(document.activeElement).toBe(btn);
    // 键盘打开优先聚焦 close，不被迁移恢复覆盖
    await w.get(".drawer-close").trigger("click");
    await nextTick();
    const btn2 = w.get('[data-panel="agent"].fleet-summary-bar').element as HTMLElement;
    btn2.focus();
    await w.get('[data-panel="agent"].fleet-summary-bar').trigger("click", { detail: 0 });
    await nextTick();
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(w.get(".drawer-close").element);
  });
});

describe("Task60 CSS 门禁：零预留列 + 头部宿主静态横排（compact-panel-plan §2.2）", () => {
  const read = (rel: string) =>
    readFileSync(resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/", rel), "utf8");
  it("drawer.css: overlay keeps its compact geometry without a reserved column", () => {
    const css = read("drawer.css");
    expect(css).not.toMatch(/padding-right:\s*84/);
    expect(css).toMatch(/right:\s*12px/);
    expect(css).toMatch(/width:\s*min\(440px,\s*calc\(100%\s*-\s*24px\)\)/);
  });
  it("fleet.css: 浮动宿主零布局占位；头部宿主静态横排并清容器装饰，不动按钮/badge/pulse", () => {
    const css = read("fleet.css");
    const floatingHost = css.match(/\[data-rail-host="floating"\]\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(floatingHost).toMatch(/position:\s*absolute/);
    expect(floatingHost).toMatch(/inset:\s*0/);
    expect(floatingHost).toMatch(/pointer-events:\s*none/);
    const headerRail = css.match(/\[data-rail-host="header"\]\s*\.activity-rail\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(headerRail).toMatch(/position:\s*static/);
    expect(headerRail).toMatch(/inset:\s*auto/);
    expect(headerRail).toMatch(/transform:\s*none/);
    expect(headerRail).toMatch(/z-index:\s*auto/);
    expect(headerRail).toMatch(/flex-direction:\s*row/);
    expect(headerRail).toMatch(/gap:\s*8px/);
    expect(headerRail).toMatch(/flex-shrink:\s*0/);
    expect(headerRail).toMatch(/padding:\s*0/);
    expect(headerRail).toMatch(/background:\s*transparent/);
    expect(headerRail).toMatch(/border:\s*0/);
    expect(headerRail).toMatch(/box-shadow:\s*none/);
    // 只清容器 chrome：按钮 44×44、badge、pulse（data-active ::after）规则不被头部规则改写
    expect(css).toMatch(/\.fleet-summary-bar\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
    const headerBtn = css.match(/\[data-rail-host="header"\][^{]*\.fleet-summary-bar\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(headerBtn.replace(/\s/g, "")).toBe("flex-shrink:0;"); // 唯一按钮规则仅加 flex-shrink，不改尺寸/badge/pulse
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
