// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import { toAgentCardView } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  LIST_DENSITY_STORAGE_KEY,
  parseListDensity,
  resetListDensityForTests,
  useListDensity,
} from "../../../src/web-hub/ui/src/composables/useListDensity.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

const mem = () => {
  const m = new Map<string, string>();
  return {
    m,
    storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) },
  };
};
const agent = (status: Record<string, unknown>): AgentState =>
  ({
    key: "a",
    card: { cwd: "/home/u/proj", model: "k3", costUsd: 3.5 },
    session: { name: "认知进化" },
    status,
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  }) as unknown as AgentState;
function mountCard(
  status: Record<string, unknown>,
  cardExtra: Record<string, unknown> = {},
  dialogs?: unknown,
  prompts?: unknown[],
  fleet?: unknown[],
) {
  const a = agent(status);
  Object.assign(a.card as object, cardExtra);
  const m = a as unknown as Record<string, unknown>;
  if (dialogs !== undefined) m["dialogs"] = dialogs;
  if (prompts !== undefined) m["prompts"] = prompts;
  if (fleet !== undefined) m["fleet"] = fleet;
  const card = toAgentCardView(a, (k) => k);
  const hub = {
    state: ref({
      agents: new Map([["a", a]]),
      hub: { caps: ["xs.v1", "xs.alias.v1"] },
    } as unknown as HubState),
    dispatch() {},
  } as HubHandle;
  return mount(AgentCard, { props: { card, selected: false }, global: { provide: { [HUB_CTX as symbol]: hub } } });
}
const xs = { joined: true, receive: "wake", alias: "小z" };

beforeEach(resetListDensityForTests);

describe("list density preference", () => {
  it("defaults to compact; only the exact token detailed switches", () => {
    expect(parseListDensity(null)).toBe("compact");
    expect(parseListDensity("junk")).toBe("compact");
    expect(parseListDensity("detailed")).toBe("detailed");
    expect(useListDensity({ storage: mem().storage }).density.value).toBe("compact");
    resetListDensityForTests();
  });
  it("toggle persists and reload restores", () => {
    const { m, storage } = mem();
    const h = useListDensity({ storage });
    h.toggle();
    expect(m.get(LIST_DENSITY_STORAGE_KEY)).toBe("detailed");
    resetListDensityForTests();
    expect(useListDensity({ storage }).density.value).toBe("detailed");
    h.toggle();
    expect(m.get(LIST_DENSITY_STORAGE_KEY)).toBe("compact");
  });
  it("throwing storage fails open to compact", () => {
    const bad = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    resetListDensityForTests();
    const h = useListDensity({ storage: bad });
    expect(h.density.value).toBe("compact");
    h.toggle();
    expect(h.density.value).toBe("detailed");
  });
});

describe("AgentCard density rendering", () => {
  it("compact (default): directory + alias + title only", () => {
    const w = mountCard({ xs, xsInbox: { unread: 2 }, contextPercent: 22 });
    expect(w.find(".agent-card").attributes("data-density")).toBe("compact");
    expect(w.find(".agent-title").exists()).toBe(true);
    expect(w.find(".agent-session").text()).toBe("认知进化");
    expect(w.find(".chip-xs-alias").exists()).toBe(true);
    expect(w.find(".chip-xs-unread").exists()).toBe(true);
    for (const sel of [".agent-cost", ".agent-meta", ".meter", ".chip-xs", ".privacy-lock-btn", ".chip-xs-channels"]) {
      if (sel === ".chip-xs") expect(w.find(".chip-xs:not(.chip-xs-alias):not(.chip-xs-unread)").exists()).toBe(false);
      else expect(w.find(sel).exists()).toBe(false);
    }
    expect(w.text()).not.toContain("TUI");
    w.unmount();
  });
  it("compact without alias: row 1 has the directory only", () => {
    const w = mountCard({});
    expect(w.find(".chip-xs-alias").exists()).toBe(false);
    expect(w.find(".agent-chips").exists()).toBe(false);
    w.unmount();
  });
  it("detailed: full card with cost/kind chip, flips live", async () => {
    const w = mountCard({});
    useListDensity({ storage: mem().storage }).setDensity("detailed");
    await nextTick();
    expect(w.find(".agent-card").attributes("data-density")).toBe("detailed");
    expect(w.find(".agent-cost").exists()).toBe(true);
    expect(w.text()).toContain("TUI");
    w.unmount();
  });
  it("compact running: live state pill + data-st running (dot halo is keyed off it)", () => {
    const w = mountCard({ busy: true });
    expect(w.find(".agent-card").attributes("data-st")).toBe("running");
    expect(w.find('[data-compact="state"]').text()).toContain("common.status.running");
    expect(w.find(".agent-row1 > .dot").exists()).toBe(true);
    w.unmount();
  });
  it("compact idle: no state pill, hollow dot", () => {
    const w = mountCard({});
    expect(w.find(".agent-card").attributes("data-st")).toBe("idle");
    expect(w.find('[data-compact="state"]').exists()).toBe(false);
    expect(w.find(".agent-row1 > .dot").classes()).toContain("dot-hollow");
    w.unmount();
  });
  it("compact waiting (open prompt): waiting state pill", () => {
    const w = mountCard({}, {}, undefined, [{ id: "p" }]);
    expect(w.find(".agent-card").attributes("data-st")).toBe("waiting");
    expect(w.find('[data-compact="state"]').exists()).toBe(true);
    w.unmount();
  });
  it("compact ask_user dialog: needs-answer pill", () => {
    const w = mountCard({}, {}, { open: [{ id: "d" }] });
    expect(w.find('[data-compact="answer"]').exists()).toBe(true);
    w.unmount();
  });
  it("sub-agent count badge only when > 0", () => {
    const none = mountCard({}, {}, undefined, undefined, [{ status: "running", terminal: true }, { status: "done" }]);
    expect(none.find('[data-compact="sub"]').exists()).toBe(false);
    none.unmount();
    const w = mountCard({}, {}, undefined, undefined, [
      { status: "running" },
      { status: "running" },
      { status: "running" },
    ]);
    const b = w.find('[data-compact="sub"]');
    expect(b.text()).toBe("3");
    expect(b.attributes("title")).toBe("3 running");
    w.unmount();
  });
  it("idle main session with running background work counts as running (sub-agents / bash jobs)", () => {
    const sub = mountCard({}, {}, undefined, undefined, [{ status: "running" }]);
    expect(sub.find(".agent-card").attributes("data-st")).toBe("running");
    expect(sub.find('[data-compact="state"]').exists()).toBe(true);
    sub.unmount();
    const done = mountCard({}, {}, undefined, undefined, [{ status: "done", terminal: true }]);
    expect(done.find(".agent-card").attributes("data-st")).toBe("idle");
    done.unmount();
  });
});

/**
 * 2026-10-27 outdated chip 收敛（docs/dev/web-hub/outdated-chip-polish.md）：状态 pill 只表达
 * 真实运行状态（agentCardModel.statusLabelOf 不再有 outdated 分支）；卡片上唯一的 outdated
 * 表达是一枚紧凑、可点击的「需更新」chip（点击经 OUTDATED_RELOAD_CTX 触发该会话的
 * /agent reload，queued/parked 再点取消）；非 outdated 卡片 DOM/属性不变。
 */
import { OUTDATED_RELOAD_CTX } from "../../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { OutdatedReloadHandle } from "../../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { OrEntry } from "../../../src/web-hub/ui/src/logic/outdatedReload.js";
import { vi } from "vitest";

function fakeOutdatedReload(entry: OrEntry) {
  const request = vi.fn();
  const cancelQueue = vi.fn();
  const handle = {
    entryOf: () => entry,
    request,
    cancelQueue,
  } as unknown as OutdatedReloadHandle;
  return { handle, request, cancelQueue };
}

function mountOutdatedCard(
  status: Record<string, unknown>,
  cardExtra: Record<string, unknown>,
  or?: OutdatedReloadHandle,
) {
  const a = agent(status);
  Object.assign(a.card as object, cardExtra);
  const card = toAgentCardView(a, (k) => k);
  const provide: Record<symbol, unknown> = {};
  if (or !== undefined) provide[OUTDATED_RELOAD_CTX as symbol] = or;
  return mount(AgentCard, { props: { card, selected: false }, global: { provide } });
}

describe("AgentCard outdated chip（收敛）", () => {
  it("模型层：outdated 不再顶替真实状态（idle ⇒ 无 pill 文案；busy ⇒ running）", () => {
    const idle = agent({});
    Object.assign(idle.card as object, { outdated: true });
    expect(toAgentCardView(idle, (k) => k).statusLabel).toBeNull();
    const busy = agent({ busy: true });
    Object.assign(busy.card as object, { outdated: true });
    const view = toAgentCardView(busy, (k) => k);
    expect(view.statusLabel).toBe("common.status.running");
    expect(view.outdated).toBe(true);
  });

  it("compact idle+outdated：无状态 pill，唯一 chip 是可点击 button，卡片带 data-outdated", () => {
    const w = mountOutdatedCard({}, { outdated: true });
    const root = w.find(".agent-card");
    expect(root.attributes("data-outdated")).toBe("true");
    expect(w.find('[data-compact="state"]').exists()).toBe(false); // idle 本就无 pill
    const chip = w.find('[data-compact="outdated"]');
    expect(chip.element.tagName).toBe("BUTTON");
    expect(chip.classes()).toContain("chip-outdated");
    expect(chip.text()).toContain("Update");
    expect(chip.attributes("title")).toBe("Plugin older than hub — click to reload (/agent reload)");
    w.unmount();
  });

  it("compact running+outdated：pill 恢复真实状态，与 chip 并存", () => {
    const w = mountOutdatedCard({ busy: true }, { outdated: true });
    const pill = w.find('[data-compact="state"]');
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toBe("common.status.running");
    expect(w.find('[data-compact="outdated"]').exists()).toBe(true);
    w.unmount();
  });

  it("detailed outdated：chip 同样是 button；meta 行 pill 显示真实状态", async () => {
    const w = mountOutdatedCard({ busy: true }, { outdated: true });
    useListDensity({ storage: mem().storage }).setDensity("detailed");
    await nextTick();
    const chips = w.find(".agent-row1 .agent-chips");
    const chip = chips.find(".chip-outdated");
    expect(chip.element.tagName).toBe("BUTTON");
    const metaPill = w.find(".agent-meta .pill-inline");
    expect(metaPill.text()).toBe("common.status.running");
    w.unmount();
  });

  it("非 outdated 卡片：无 chip、无 data-outdated（逐字节不变）", () => {
    const w = mountOutdatedCard({ busy: true }, {});
    expect(w.find(".chip-outdated").exists()).toBe(false);
    expect(w.find(".agent-card").attributes("data-outdated")).toBeUndefined();
    w.unmount();
  });

  it("点击 chip ⇒ request(key)；queued 态显示排队文案，再点 ⇒ cancelQueue(key)", async () => {
    const idle = fakeOutdatedReload({ phase: "idle" });
    const w = mountOutdatedCard({}, { outdated: true }, idle.handle);
    await w.find('[data-compact="outdated"]').trigger("click");
    expect(idle.request).toHaveBeenCalledWith("a");
    expect(idle.cancelQueue).not.toHaveBeenCalled();
    w.unmount();

    const queued = fakeOutdatedReload({ phase: "queued" });
    const w2 = mountOutdatedCard({}, { outdated: true }, queued.handle);
    const chip = w2.find('[data-compact="outdated"]');
    expect(chip.text()).toContain("Queued");
    expect(chip.attributes("title")).toBe("Reload queued — fires once the session goes idle; click to cancel");
    await chip.trigger("click");
    expect(queued.cancelQueue).toHaveBeenCalledWith("a");
    expect(queued.request).not.toHaveBeenCalled();
    w2.unmount();
  });

  it("点击不导航外层 <a>（prevent）；无 provider 时点击安全无操作", async () => {
    const or = fakeOutdatedReload({ phase: "idle" });
    const w = mountOutdatedCard({}, { outdated: true }, or.handle);
    const evt = new MouseEvent("click", { cancelable: true });
    w.find('[data-compact="outdated"]').element.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    w.unmount();

    const bare = mountOutdatedCard({}, { outdated: true });
    await bare.find('[data-compact="outdated"]').trigger("click"); // 不抛错即通过
    bare.unmount();
  });
});
