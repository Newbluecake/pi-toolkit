// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../../../src/web-hub/ui/src/components/detail/AgentDetail.vue";
import FleetDrawer from "../../../src/web-hub/ui/src/components/drawer/FleetDrawer.vue";
import DashboardView from "../../../src/web-hub/ui/src/components/shell/DashboardView.vue";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";
import type { FleetRowWire } from "../../../src/web-hub/protocol/messages.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

/**
 * FleetDrawer 的 §6.2 三模式 / §6.4 键盘·指针·焦点契约(fleet-drawer plan v2 — F6,U1–U6)。
 * 事件一律用真实 DOM 派发(`dispatchEvent(new KeyboardEvent(…, {bubbles:true}))`),不断言
 * 内部监听器本身。模式用 `vi.stubGlobal("matchMedia", …)` 钉住(§6.2 的判定走 useMedia)。
 */

const Q_DOCKED = "(min-width: 1280px)";
const Q_PHONE = "(max-width: 767px)";
const Q_WIDE = "(min-width: 1025px)";
const Q_BAND = "(min-width: 481px) and (max-width: 1024px)";
const Q_NARROW_TX = "(max-width: 480px)";

function stubModes(map: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const MODE_DOCKED = { [Q_DOCKED]: true };
const MODE_OVERLAY = { [Q_DOCKED]: false, [Q_PHONE]: false, [Q_WIDE]: false, [Q_BAND]: true };
const MODE_FULL = { [Q_DOCKED]: false, [Q_PHONE]: true, [Q_WIDE]: false, [Q_BAND]: false, [Q_NARROW_TX]: true };

const OPEN_KEY = "webhub.fleetDrawer.open";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.location.hash = "";
  document.body.innerHTML = "";
});

function fleetRow(runId: string, extra: Record<string, unknown> = {}): FleetRowWire {
  return {
    runId,
    label: runId,
    type: "general",
    status: "running",
    phaseLabel: "working",
    elapsedMs: 1000,
    phaseMs: 0,
    highlight: "none",
    terminal: false,
    ...extra,
  } as FleetRowWire;
}

function baseAgent(over: Record<string, unknown> = {}) {
  return {
    key: "A",
    card: { control: true, state: "live", runTranscript: true },
    down: false,
    prompts: [],
    fleet: [fleetRow("r_1")],
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
    ...over,
  } as never;
}

function fakeControl(): ControlHandle {
  return {
    sendPrompt: async () => ({ ok: true }),
    abort: async () => ({ ok: true }),
    steerSub: async () => ({ ok: true }),
    stopSub: async () => ({ ok: true }),
    answerDialog: async () => ({ ok: true }),
    cancelDialog: async () => ({ ok: true }),
    runCommand: async () => ({ ok: true }),
    query: async () => ({ ok: true }),
    retry: async () => ({ ok: true }),
    discard: () => {},
    draft: () => "",
    setDraft: () => {},
  };
}

function fakeHub(over: Partial<HubHandle> = {}): HubHandle {
  return {
    state: ref({ control: true }) as HubHandle["state"],
    control: fakeControl(),
    selectRun: vi.fn(),
    pageRun: vi.fn(),
    dispatch: vi.fn(),
    ...over,
  } as HubHandle;
}

function mountDetail(agent: unknown, hub: HubHandle = fakeHub()) {
  const wrapper = mount(AgentDetail, {
    props: { agent, now: 1_000, narrow: false },
    attachTo: document.body,
    global: { provide: { [HUB_CTX as symbol]: hub } },
  });
  mounted.push(wrapper);
  return wrapper;
}

const drawerEl = () => document.querySelector<HTMLElement>("#fleet-drawer");
const summaryBtn = () => document.querySelector<HTMLElement>(".fleet-summary-bar");
const escOn = (target: EventTarget, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, ...init }));

describe("U1: 三种模式(§6.2)— data-drawer 与 localStorage 持久化", () => {
  it('docked(≥1280px):默认打开(默认 "1"),开合写入 localStorage', async () => {
    stubModes(MODE_DOCKED);
    mountDetail(baseAgent());
    expect(document.querySelector(".detail")!.getAttribute("data-drawer")).toBe("docked");
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
    expect(drawerEl()!.dataset["mode"]).toBe("docked");

    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
    expect(window.localStorage.getItem(OPEN_KEY)).toBe("0");

    summaryBtn()!.click();
    await nextTick();
    expect(window.localStorage.getItem(OPEN_KEY)).toBe("1");
  });

  it('docked:持久化的 "0" 让下次挂载保持关闭', () => {
    window.localStorage.setItem(OPEN_KEY, "0");
    stubModes(MODE_DOCKED);
    mountDetail(baseAgent());
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
  });

  it("overlay(768–1279px):每次挂载关闭,开合不写 localStorage", async () => {
    stubModes(MODE_OVERLAY);
    mountDetail(baseAgent());
    expect(document.querySelector(".detail")!.getAttribute("data-drawer")).toBe("overlay");
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);

    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
    expect(drawerEl()!.getAttribute("role")).toBe("dialog");
    expect(window.localStorage.getItem(OPEN_KEY)).toBeNull(); // 不持久化

    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
    expect(window.localStorage.getItem(OPEN_KEY)).toBeNull();
  });

  it("fullscreen(≤767px):fixed 全屏模式,挂载关闭、不持久化", () => {
    stubModes(MODE_FULL);
    mountDetail(baseAgent());
    expect(document.querySelector(".detail")!.getAttribute("data-drawer")).toBe("fullscreen");
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
    expect(window.localStorage.getItem(OPEN_KEY)).toBeNull();
  });

  it("没有 fleet 行且没有选中 run ⇒ 抽屉不挂载(§6.1 的 v-if)", () => {
    stubModes(MODE_OVERLAY);
    mountDetail(baseAgent({ fleet: [] }));
    expect(drawerEl()).toBeNull();
    expect(summaryBtn()).toBeNull();
  });
});

describe("U2/U3: Esc 规则链(§6.4 #2/#3,overlay 模式)", () => {
  async function openOverlayDrawer(agent: unknown = baseAgent(), hub: HubHandle = fakeHub()) {
    stubModes(MODE_OVERLAY);
    const wrapper = mountDetail(agent, hub);
    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
    return wrapper;
  }

  it("已武装的 Stop 上按 Esc ⇒ 解除武装、抽屉不关闭;再按一次 ⇒ 关闭", async () => {
    await openOverlayDrawer();
    // 展开 r_1 的行内动作并武装 Stop(FleetActions 的元素级 Esc 处理器 stopPropagation,
    // 抽屉的 document 监听收不到 —— §6.4 #2 的期望行为)
    document.querySelector<HTMLElement>(".run-actions-toggle")!.click();
    await nextTick();
    const stopBtn = document.querySelector<HTMLElement>(".stop-btn")!;
    stopBtn.click();
    await nextTick();
    expect(stopBtn.dataset["armed"]).toBe("true");

    escOn(stopBtn);
    await nextTick();
    expect(stopBtn.dataset["armed"]).toBeUndefined(); // 解除武装
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true); // 抽屉不动

    escOn(document);
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
  });

  it("DashboardView 的 window 级 Esc 被 defaultPrevented 挡住,不会执行 back", async () => {
    stubModes(MODE_OVERLAY);
    const s = run2([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
      { event: "fleet", data: { agentKey: "A", runs: [fleetRow("r_1")] } },
    ]);
    const hub = fakeHub({ state: ref(s as never) as HubHandle["state"] });
    const wrapper = mount(DashboardView, {
      props: { hub, route: { name: "agent", key: "A" } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);

    escOn(document);
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false); // 抽屉关了
    expect(backSpy).not.toHaveBeenCalled(); // 但没有触发返回导航
    expect(window.location.hash).toBe("");
  });

  it("isComposing 的 Esc 不关闭抽屉", async () => {
    await openOverlayDrawer();
    escOn(document, { isComposing: true });
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
  });

  it("焦点在 input 里按 Esc 不关闭抽屉(文本输入豁免)", async () => {
    await openOverlayDrawer();
    document.querySelector<HTMLElement>(".run-actions-toggle")!.click();
    await nextTick();
    const input = document.querySelector<HTMLElement>(".fleet-steer-input")!;
    escOn(input);
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
  });

  it("docked 模式不注册任何监听:Esc 不关抽屉(开合只有摘要行按钮)", async () => {
    stubModes(MODE_DOCKED);
    mountDetail(baseAgent());
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
    escOn(document);
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true);
  });
});

describe("U4: pointerdown 外点关闭(§6.4 #5,仅 overlay)", () => {
  it("外部 ⇒ 关闭;抽屉内部 ⇒ 不关;摘要行按钮 ⇒ 不关(避免关了又开)", async () => {
    stubModes(MODE_OVERLAY);
    mountDetail(baseAgent());
    summaryBtn()!.click();
    await nextTick();
    const open = () => document.querySelector(".detail")!.hasAttribute("data-drawer-open");
    expect(open()).toBe(true);

    drawerEl()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(open()).toBe(true); // 内部

    summaryBtn()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(open()).toBe(true); // toggle 按钮本身

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(open()).toBe(false); // 外部 ⇒ 关闭
  });
});

describe("U5: 焦点迁移(§6.4 #6,仅非 docked)", () => {
  it("打开 ⇒ 焦点到抽屉关闭按钮;关闭 ⇒ 还给摘要行按钮", async () => {
    stubModes(MODE_OVERLAY);
    mountDetail(baseAgent());
    summaryBtn()!.click();
    await nextTick();
    await nextTick(); // 焦点迁移在 watch + nextTick 里
    expect(document.activeElement).toBe(document.querySelector(".drawer-close"));

    escOn(document);
    await nextTick();
    expect(document.activeElement).toBe(summaryBtn());
  });

  it("摘要行按钮不在 DOM 时,焦点回退到主区 #transcript", async () => {
    stubModes(MODE_OVERLAY);
    const txFallback = document.createElement("section");
    txFallback.id = "transcript";
    txFallback.tabIndex = -1;
    document.body.appendChild(txFallback);

    const wrapper = mount(FleetDrawer, {
      props: { agent: baseAgent(), now: 0, mode: "overlay", open: false },
      attachTo: document.body,
      global: { provide: { [HUB_CTX as symbol]: fakeHub() } },
    });
    mounted.push(wrapper);
    await wrapper.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).toBe(drawerEl()!.querySelector(".drawer-close"));

    await wrapper.setProps({ open: false });
    await nextTick();
    expect(document.activeElement).toBe(txFallback);
  });
});

describe("U6: 卸载清理(§6.4 #7)", () => {
  it("卸载后 document 上没有残留监听(removeEventListener 被调,且 Esc 不再触发 close)", async () => {
    stubModes(MODE_OVERLAY);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const closeSpy = vi.fn();
    const wrapper = mount(FleetDrawer, {
      props: { agent: baseAgent(), now: 0, mode: "overlay", open: true, onClose: closeSpy },
      attachTo: document.body,
      global: { provide: { [HUB_CTX as symbol]: fakeHub() } },
    });
    mounted.push(wrapper);
    escOn(document);
    await nextTick();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    removeSpy.mockClear();

    wrapper.unmount();
    expect(removeSpy.mock.calls.some((c) => c[0] === "keydown")).toBe(true);
    expect(removeSpy.mock.calls.some((c) => c[0] === "pointerdown")).toBe(true);
    escOn(document);
    await nextTick();
    expect(closeSpy).toHaveBeenCalledTimes(1); // 卸载后不再触发
  });

  it("关闭抽屉时退选正在看的 run(close ⇒ selectRun(agentKey, null)经 AgentDetail)", async () => {
    stubModes(MODE_OVERLAY);
    const hub = fakeHub();
    mountDetail(baseAgent({ runSel: "r_1" }), hub);
    summaryBtn()!.click();
    await nextTick();
    escOn(document);
    await nextTick();
    expect(hub.selectRun).toHaveBeenCalledWith("A", null);
  });
});

describe("P1-1: 关闭入口退订语义一致(§2「没人看就不推」)", () => {
  it("摘要行按钮的关方向同样退订(toggle 关闭 ⇒ selectRun(null));开方向不自动重选", async () => {
    stubModes(MODE_OVERLAY);
    const hub = fakeHub();
    mountDetail(baseAgent({ runSel: "r_1" }), hub);
    const open = () => document.querySelector(".detail")!.hasAttribute("data-drawer-open");

    summaryBtn()!.click(); // 开方向:只开展示树,不重选 run
    await nextTick();
    expect(open()).toBe(true);
    expect(hub.selectRun).not.toHaveBeenCalled();

    summaryBtn()!.click(); // 关方向:与 Esc/外点/关闭按钮一致 —— 退订
    await nextTick();
    expect(open()).toBe(false);
    expect(hub.selectRun).toHaveBeenCalledWith("A", null);
  });

  it("docked 的 toggle 关闭也退订(不搞「只是视觉收起」双标)", async () => {
    stubModes(MODE_DOCKED);
    const hub = fakeHub();
    mountDetail(baseAgent({ runSel: "r_1" }), hub);
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(true); // 默认开

    summaryBtn()!.click();
    await nextTick();
    expect(document.querySelector(".detail")!.hasAttribute("data-drawer-open")).toBe(false);
    expect(hub.selectRun).toHaveBeenCalledWith("A", null);
  });
});

// --- DashboardView 挂载用的 state fixtures(reducer 驱动) -----------------------------

type Msg = { event: string; data: unknown; id?: number };
const run2 = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
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
