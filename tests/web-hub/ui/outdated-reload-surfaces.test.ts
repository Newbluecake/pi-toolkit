// @vitest-environment happy-dom
/**
 * #23 P-A surfaces（plan §3 P-A 第 6 条）：失败展示四个入口的 DOM 级断言（挂载组件，
 * 不看 entryOf()）——卡片 chip 失败态、汇总失败行、详情横幅、空态结果行组件。
 * DashboardView 空态（「已删除」「未连接」× 宽/窄屏）在 dashboard-view.test.ts。
 */
import { computed, ref } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import AgentCard from "../../../src/web-hub/ui/src/components/agents/AgentCard.vue";
import OutdatedSummaryBanner from "../../../src/web-hub/ui/src/components/agents/OutdatedSummaryBanner.vue";
import OutdatedReloadBanner from "../../../src/web-hub/ui/src/components/detail/OutdatedReloadBanner.vue";
import OutdatedReloadResult from "../../../src/web-hub/ui/src/components/detail/OutdatedReloadResult.vue";
import { toAgentCardView } from "../../../src/web-hub/ui/src/components/agents/agentCardModel.js";
import { HUB_CTX } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import {
  OUTDATED_RELOAD_CTX,
  type OutdatedReloadHandle,
} from "../../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { OrEntry } from "../../../src/web-hub/ui/src/logic/outdatedReload.js";
import type { AgentState, HubHandle, HubState } from "../../../src/web-hub/ui/src/types.js";

/** en 文案（happy-dom navigator 是 en-*；与 dashboard-view.test 同口径）。 */
const EN = {
  chipFailed: "Update failed",
  chipNeedsUpdate: "Update",
  errOffline: "the session is offline",
  errSendUnknown: "command outcome unknown",
  rowFailedPre: "failed: ",
};

function agentState(key: string, cardExtra: Record<string, unknown> = {}): AgentState {
  return {
    key,
    card: { cwd: "/home/u/proj", model: "k3", ...cardExtra },
    session: { name: "认知进化" },
    status: {},
    fleet: [],
    prompts: [],
    tools: [],
    streaming: null,
    down: false,
  } as unknown as AgentState;
}

/** 假 manager（agent-list-density.test 同款）：entryOf 固定返回，request/cancelQueue 是 spy。 */
function fakeManager(entries: Record<string, OrEntry>) {
  const request = vi.fn();
  const cancelQueue = vi.fn();
  const reloadAll = vi.fn();
  const tick = ref(0); // 渲染依赖：改 entries 后 bump 它即可重渲染
  const handle = {
    hubVersion: computed(() => "0.10.6"),
    entryOf: (key: string): OrEntry => {
      void tick.value;
      return entries[key] ?? { phase: "idle" };
    },
    outdatedOf: () => true,
    infoOf: () => ({ outdated: true, pluginVersion: "0.9.0" }),
    snoozedOf: () => false,
    outdatedList: computed(
      () =>
        [
          { key: "a", busy: false, pluginVersion: "0.9.0" },
          { key: "b", busy: false, pluginVersion: "0.9.0" },
        ] as const,
    ),
    request,
    cancelQueue,
    mainBusyOf: () => false,
    fleetActiveOf: () => 0,
    dismiss: () => {},
    reloadAll,
    dispose: () => {},
  } as unknown as OutdatedReloadHandle;
  return { handle, request, cancelQueue, reloadAll, tick, entries };
}

function hubOf(agents: AgentState[]): HubHandle {
  const map = new Map(agents.map((a) => [a.key, a]));
  return {
    state: ref({ agents: map, order: agents.map((a) => a.key) } as unknown as HubState),
    dispatch: () => {},
  };
}

// ---------------------------------------------------------------------------
// 卡片 chip 失败态（AgentCard）
// ---------------------------------------------------------------------------

describe("AgentCard outdated chip 失败态（#23 D9）", () => {
  function mountChip(or: OutdatedReloadHandle) {
    const a = agentState("a", { outdated: true });
    const card = toAgentCardView(a, (k) => k);
    return mount(AgentCard, {
      props: { card, selected: false },
      global: { provide: { [OUTDATED_RELOAD_CTX as symbol]: or, [HUB_CTX as symbol]: hubOf([a]) } },
    });
  }

  it("failed 相：danger chip（chip-outdated-failed）、alert 图标类、chipFailed 文案、title 含离线原因", () => {
    const { handle } = fakeManager({ a: { phase: "failed", error: "E_OFFLINE" } });
    const w = mountChip(handle);
    const chip = w.get('[data-compact="outdated"]');
    expect(chip.classes()).toContain("chip-outdated-failed");
    expect(chip.text()).toContain(EN.chipFailed);
    expect(chip.attributes("title")).toContain(EN.errOffline);
    expect(chip.attributes("title")).toContain("click to retry");
    expect(chip.attributes("aria-label")).toBe(chip.attributes("title"));
    w.unmount();
  });

  it("failed 相点击仍走 request（重试入口不变）", async () => {
    const { handle, request } = fakeManager({ a: { phase: "failed", error: "E_SEND_UNKNOWN" } });
    const w = mountChip(handle);
    await w.get('[data-compact="outdated"]').trigger("click");
    expect(request).toHaveBeenCalledWith("a");
    w.unmount();
  });

  it("wire message 优先：title 里是 raw 文案而非错误码 i18n", () => {
    const { handle } = fakeManager({
      a: { phase: "failed", error: "E_AGENT_GONE", message: "agent not connected" },
    });
    const w = mountChip(handle);
    expect(w.get('[data-compact="outdated"]').attributes("title")).toContain("agent not connected");
    w.unmount();
  });

  it("非 failed 相回归：默认需更新 / 排队中形态不变", () => {
    const idle = fakeManager({});
    const w1 = mountChip(idle.handle);
    expect(w1.get('[data-compact="outdated"]').text()).toContain(EN.chipNeedsUpdate);
    expect(w1.get('[data-compact="outdated"]').classes()).not.toContain("chip-outdated-failed");
    w1.unmount();
    const busy = fakeManager({ a: { phase: "awaiting" } });
    const w2 = mountChip(busy.handle);
    expect(w2.get('[data-compact="outdated"]').text()).toContain("Queued");
    w2.unmount();
  });
});

// ---------------------------------------------------------------------------
// 汇总失败行（OutdatedSummaryBanner）
// ---------------------------------------------------------------------------

describe("OutdatedSummaryBanner 失败行（#23 D9）", () => {
  it("失败行显示人读原因，错误码进 title；在飞行仍是进度文案", async () => {
    const { handle, reloadAll } = fakeManager({
      a: { phase: "failed", error: "E_SEND_UNKNOWN" },
      b: { phase: "awaiting" },
    });
    const w = mount(OutdatedSummaryBanner, {
      global: {
        provide: {
          [OUTDATED_RELOAD_CTX as symbol]: handle,
          [HUB_CTX as symbol]: hubOf([agentState("a"), agentState("b")]),
        },
      },
    });
    await w.get(".or-banner-actions .btn-primary").trigger("click"); // 全部重新加载
    expect(reloadAll).toHaveBeenCalled();
    const rows = w.findAll(".or-progress li");
    expect(rows).toHaveLength(2);
    const failedRow = rows[0]!;
    expect(failedRow.text()).toContain(EN.rowFailedPre);
    expect(failedRow.text()).toContain(EN.errSendUnknown); // 人读原因（不再只有错误码）
    expect(failedRow.get("span.or-bad").attributes("title")).toBe("E_SEND_UNKNOWN"); // 错误码进 title
    expect(rows[1]!.text()).toContain("taking effect");
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// 详情横幅（OutdatedReloadBanner）
// ---------------------------------------------------------------------------

describe("OutdatedReloadBanner 失败横幅（#23 D9 orFailReason）", () => {
  function mountBanner(or: OutdatedReloadHandle) {
    return mount(OutdatedReloadBanner, {
      props: { agentKey: "a" },
      global: { provide: { [OUTDATED_RELOAD_CTX as symbol]: or } },
    });
  }

  it("E_SEND_UNKNOWN ⇒ danger 横幅显示 errSendUnknown 文案 + mono 错误码 + 重试/关闭", () => {
    const { handle } = fakeManager({ a: { phase: "failed", error: "E_SEND_UNKNOWN" } });
    const w = mountBanner(handle);
    const banner = w.get(".or-banner");
    expect(banner.attributes("data-tone")).toBe("danger");
    expect(banner.attributes("role")).toBe("alert");
    expect(banner.text()).toContain(EN.errSendUnknown);
    expect(banner.text()).toContain("E_SEND_UNKNOWN");
    expect(banner.text()).toContain("Retry");
    w.unmount();
  });

  it("E_OFFLINE ⇒ 新 errOffline 文案（含「check or retry on the new card」指引）", () => {
    const { handle } = fakeManager({ a: { phase: "failed", error: "E_OFFLINE" } });
    const w = mountBanner(handle);
    expect(w.get(".or-banner").text()).toContain(EN.errOffline);
    w.unmount();
  });

  it("wire message ⇒ raw 文案直出", () => {
    const { handle } = fakeManager({
      a: { phase: "failed", error: "E_CMD", message: "command denied by policy" },
    });
    const w = mountBanner(handle);
    expect(w.get(".or-banner").text()).toContain("command denied by policy");
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// 空态结果行组件（OutdatedReloadResult）
// ---------------------------------------------------------------------------

describe("OutdatedReloadResult（#23 D9 目标消失后的结果行）", () => {
  function mountResult(or: OutdatedReloadHandle | undefined, agentKey = "a") {
    const provide: Record<string | symbol, unknown> = {};
    if (or !== undefined) provide[OUTDATED_RELOAD_CTX as symbol] = or;
    return mount(OutdatedReloadResult, { props: { agentKey }, global: { provide } });
  }

  it("failed ⇒ 渲染 resultPre + 人读原因（role=alert）", () => {
    const { handle } = fakeManager({ a: { phase: "failed", error: "E_OFFLINE" } });
    const w = mountResult(handle);
    const el = w.get(".or-result");
    expect(el.attributes("role")).toBe("alert");
    expect(el.attributes("data-or")).toBe("failed");
    expect(el.text()).toContain(EN.errOffline);
    w.unmount();
  });

  it("done ⇒ resultPre 之外显示已加载到的 hub 版本（role=status）", () => {
    const { handle } = fakeManager({ a: { phase: "done" } });
    const w = mountResult(handle);
    const el = w.get(".or-result");
    expect(el.attributes("role")).toBe("status");
    expect(el.text()).toContain("0.10.6");
    w.unmount();
  });

  it("idle / 空 agentKey / 无 provider ⇒ 不渲染", () => {
    const { handle } = fakeManager({});
    expect(mountResult(handle).find(".or-result").exists()).toBe(false);
    const failed = fakeManager({ a: { phase: "failed", error: "E_OFFLINE" } });
    expect(mountResult(failed.handle, "").find(".or-result").exists()).toBe(false);
    expect(mountResult(undefined).find(".or-result").exists()).toBe(false);
  });
});
