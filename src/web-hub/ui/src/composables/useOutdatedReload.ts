/**
 * #65 outdated-reload（预览 docs/dev/web-hub/outdated-reload-preview.html）— Vue 装配层。
 *
 * `DashboardView.vue` 创建唯一实例并经 `OUTDATED_RELOAD_CTX` provide；详情页
 * `OutdatedReloadBanner.vue`（第 1–4 节）与会话列表 `OutdatedSummaryBanner.vue`
 *（第 6 节）注入消费；AgentCard 的「需更新」chip（第 5 节）不需要它（纯展示
 * `card.outdated`）。无 provider（单测/独立挂载）⇒ 两个横幅都不渲染。
 *
 * 状态真源是 `@logic/outdatedReload.ts` 的 `OrCoordinator`（框架无关、注入定时器、可单
 * 测）；这里只做三件事：
 *  1. 把 hub 的响应式帧（busy / card.pluginVersion / card.outdated）折叠成一个 watch
 *     getter，每次渲染提交后 `notifyTick()` 驱动协调器（queued 放行、到位判成功）；
 *  2. `send()` 经 `ControlHandle.runCommand(key, "agent", "reload", { confirm: true })`
 *     走既有 control-plane `command` op（实证见逻辑层文件头与交付报告）；协调器约定该
 *     promise 必 settle（hub/agent 侧各有 deadline），UI 不再叠加自己的送达超时；
 *  3. snooze（【暂不】/【关闭】）经 `browserLocalStorage()` 落盘（source-scan 白名单
 *     路径），内存表与磁盘表同步维护，hub 版本一变自动失效。
 *
 * 协调器状态是页面级的（agentKey → entry）：切会话/切路由不丢，刷新即丢（排队状态前端
 * 持有即可——交付报告残留风险 §R1）。
 */
import { computed, inject, ref, watch, type ComputedRef, type InjectionKey } from "vue";
import {
  createOrCoordinator,
  fleetActiveCount,
  isSnoozed,
  outdatedSessions,
  readSnoozeMap,
  sessionOutdatedInfo,
  sessionReloadedToHub,
  withSnooze,
  writeSnoozeMap,
  type OrCoordinator,
  type OrEntry,
  type OrPrecheck,
  type OutdatedInfo,
  type OutdatedSessionRow,
  type SnoozeStorage,
} from "@logic/outdatedReload.js";
import type { AgentState, HubHandle } from "../types.js";

function cardRecord(agent: AgentState | undefined): Record<string, unknown> {
  const c = agent?.card;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

function busyOf(agent: AgentState | undefined): boolean {
  const s = agent?.status;
  return s !== null && typeof s === "object" && (s as { busy?: unknown }).busy === true;
}

/** 活跃子 agent/workflow 数（fleet 行 + omitted.active；major 修复 2026-10-26）。 */
function fleetOf(agent: AgentState | undefined): number {
  return fleetActiveCount(agent?.fleet, agent?.fleetOmitted);
}

export interface OutdatedReloadDeps {
  readonly hub: HubHandle;
  readonly storage: SnoozeStorage | null;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface OutdatedReloadHandle {
  /** 当前 hub 版本（帧未到 ⇒ undefined，一切判定降级为「不提示」）。 */
  readonly hubVersion: ComputedRef<string | undefined>;
  /** 每会话状态（详情页横幅读）。 */
  entryOf(agentKey: string): OrEntry;
  /** 会话是否落后（详情页横幅的显隐门）。 */
  outdatedOf(agentKey: string): boolean;
  /** 落后判定全量（含展示用 pluginVersion）。 */
  infoOf(agentKey: string): OutdatedInfo;
  /** 【暂不】记忆是否命中（hub 版本未再变 ⇒ 不再提示）。 */
  snoozedOf(agentKey: string): boolean;
  /** 落后会话汇总（仪表盘第 6 节；按侧边栏顺序）。 */
  readonly outdatedList: ComputedRef<readonly OutdatedSessionRow[]>;
  /** 【重新加载】/【重试】。 */
  request(agentKey: string): void;
  /** 【取消排队】（queued 直接撤销；parked 同时送 `/agent reload cancel`）。 */
  cancelQueue(agentKey: string): void;
  /** 主会话是否流式中（横幅 queued 文案分流）。 */
  mainBusyOf(agentKey: string): boolean;
  /** 活跃子 agent/workflow 数（queued/parked 文案的 N）。 */
  fleetActiveOf(agentKey: string): number;
  /** 【暂不】/【关闭】：收起并记忆到 hub 版本再变。 */
  dismiss(agentKey: string): void;
  /** 【全部重新加载】：对每个落后会话 request（忙的自动排队）。 */
  reloadAll(): void;
  dispose(): void;
}

export const OUTDATED_RELOAD_CTX: InjectionKey<OutdatedReloadHandle> = Symbol("web-hub-outdated-reload");

export function useOutdatedReload(deps: OutdatedReloadDeps): OutdatedReloadHandle {
  const { hub } = deps;

  const hubVersion = computed<string | undefined>(() => {
    const v = hub.state.value.hub?.["version"];
    return typeof v === "string" && v !== "" ? v : undefined;
  });

  // ---- snooze（内存表 + localStorage 双写；snoozeTick 触发重算） ------------------------
  const snoozeTick = ref(0);
  let snoozeMem: Record<string, string> = readSnoozeMap(deps.storage);
  const snoozeMap = computed(() => {
    void snoozeTick.value;
    return snoozeMem;
  });

  // ---- 协调器 ---------------------------------------------------------------------------
  // 响应式桥：协调器是普通 class，entryOf 的可见性靠这个 tick（onChange 回调 bump）。
  const entryTick = ref(0);

  /** control-plane 送命令的本地前置（与 AgentDetail/NewSessionMenu 的 gate 同式）：
   *  hub cmd.v1 ∧ card.control ∧ 会话存活 ∧ commands 槽在（command.v1）。 */
  function precheck(key: string): OrPrecheck {
    const st = hub.state.value;
    const agent = st.agents.get(key);
    if (agent === undefined) return "offline";
    const card = cardRecord(agent);
    const live = !agent.down && card["state"] !== "stale";
    if (!live) return "offline";
    if (hub.control === undefined || st.control !== true || card["control"] !== true) return "unsupported";
    if (!Array.isArray(agent.commands)) return "unsupported";
    return "ok";
  }

  const coordinator: OrCoordinator = createOrCoordinator({
    mainBusy: (key) => busyOf(hub.state.value.agents.get(key)),
    fleetActive: (key) => fleetOf(hub.state.value.agents.get(key)),
    precheck,
    isSettled: (key) => sessionReloadedToHub(cardRecord(hub.state.value.agents.get(key)), hubVersion.value),
    send: (key) => {
      const control = hub.control;
      if (control === undefined) return Promise.resolve({ ok: false, error: "E_UNSUPPORTED" });
      // 送 `/agent reload` 而非 `/reload`（web 通道不经 TUI 编辑器，editor.ts 的改写不会
      // 触发；/agent reload 自带 deferred-reload 的「等子 agent 结束」保护）。confirm:true
      // —— 按钮本身就是用户确认；/agent reload 在 command-policy 是 confirm 级。
      return control.runCommand(key, "agent", "reload", { confirm: true }).then(
        (outcome): { ok: boolean; error?: string; message?: string } =>
          outcome.ok
            ? { ok: true }
            : {
                ok: false,
                error: outcome.error ?? "E_UNKNOWN",
                ...(outcome.message !== undefined ? { message: outcome.message } : {}),
              },
        (): { ok: boolean; error?: string } => ({ ok: false, error: "E_UNKNOWN" }),
      );
    },
    // parked 的【取消排队】/park 超总上限 ⇒ 取消后端 arm 着的 deferred reload（fire-and-
    // forget；结果不影响 UI——取消失败时后端仍会在 fleet 清空后 reload，版本到位即 done）。
    sendCancel: (key) => {
      const control = hub.control;
      if (control === undefined) return Promise.resolve(false);
      return control.runCommand(key, "agent", "reload cancel", { confirm: true }).then(
        (outcome) => outcome.ok,
        () => false,
      );
    },
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    onChange: () => {
      entryTick.value += 1;
    },
  });

  // busy / fleet / 版本帧 → 协调器。getter 折成字符串签名，任意会话的 busy/fleetActive/
  // pluginVersion/outdated 变化都触发一次 notifyTick（协调器内部自己挑要动的 key）。
  const stop = watch(
    () => {
      const parts: string[] = [hubVersion.value ?? ""];
      for (const agent of hub.state.value.agents.values()) {
        const card = cardRecord(agent);
        parts.push(
          `${agent.key}=${busyOf(agent) ? 1 : 0}:${fleetOf(agent)}:${sessionReloadedToHub(card, hubVersion.value) ? 1 : 0}`,
        );
      }
      return parts.join("|");
    },
    () => coordinator.notifyTick(),
  );

  function entryOf(key: string): OrEntry {
    void entryTick.value;
    return coordinator.entryOf(key);
  }

  function outdatedOf(key: string): boolean {
    return sessionOutdatedInfo(cardRecord(hub.state.value.agents.get(key)), hubVersion.value).outdated;
  }

  function infoOf(key: string): OutdatedInfo {
    return sessionOutdatedInfo(cardRecord(hub.state.value.agents.get(key)), hubVersion.value);
  }

  function snoozedOf(key: string): boolean {
    return isSnoozed(snoozeMap.value, key, hubVersion.value);
  }

  const outdatedList = computed<readonly OutdatedSessionRow[]>(() => {
    const st = hub.state.value;
    const ordered: AgentState[] = [];
    for (const key of st.order) {
      const a = st.agents.get(key);
      if (a !== undefined) ordered.push(a);
    }
    return outdatedSessions(ordered, hubVersion.value);
  });

  function dismiss(key: string): void {
    const hv = hubVersion.value;
    if (hv !== undefined) {
      snoozeMem = withSnooze(snoozeMem, key, hv);
      writeSnoozeMap(deps.storage, snoozeMem);
      snoozeTick.value += 1;
    }
    // parked 的【关闭】也要取消后端 arm 着的 reload（与 cancelQueue 同义）。
    coordinator.cancelQueue(key);
    coordinator.reset(key);
  }

  function reloadAll(): void {
    for (const row of outdatedList.value) coordinator.request(row.key);
  }

  return {
    hubVersion,
    entryOf,
    outdatedOf,
    infoOf,
    snoozedOf,
    outdatedList,
    request: (key) => coordinator.request(key),
    cancelQueue: (key) => coordinator.cancelQueue(key),
    mainBusyOf: (key) => busyOf(hub.state.value.agents.get(key)),
    fleetActiveOf: (key) => fleetOf(hub.state.value.agents.get(key)),
    dismiss,
    reloadAll,
    dispose: () => {
      stop();
      coordinator.dispose();
    },
  };
}

/** 消费侧（无 provider ⇒ undefined，横幅不渲染）。 */
export function injectOutdatedReload(): OutdatedReloadHandle | undefined {
  return inject(OUTDATED_RELOAD_CTX, undefined);
}
