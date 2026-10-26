/**
 * #65 outdated-reload（预览 docs/dev/web-hub/outdated-reload-preview.html）— 纯逻辑层。
 * DOM-free、Vue-free、never throws；所有输入都像 `@logic/agents.js` 对待 hub 镜像帧那样做
 * 防御性收窄。四块职责：
 *
 * 1. `sessionOutdatedInfo` — 「本会话插件版本落后于 hub」的判定。证据等级与
 *    `version-match.js` 的 §4 表一致：hub 侧算好的 `card.outdated === true` 优先（老 hub
 *    也工作），否则 semver `card.pluginVersion < hub.version`；hub 版本缺失或版本号不可
 *    比较 ⇒ 不判定落后（「无法验证」从不亮提示条）。
 * 2. snooze（【暂不】/【关闭】）— localStorage 单键 `pwh_or_snooze_v1`，JSON 对象
 *    `agentKey → 暂不时的 hub 版本`；hub 版本再次变化（值不等）⇒ 提示自动恢复。卡片上的
 *    outdated 标记不受影响。容量封顶 FIFO（SNOOZE_CAP），损坏 JSON ⇒ 空表。
 * 3. `OrCoordinator` — 每会话一条的排队/送达/生效状态机（idle → queued/sending →
 *    awaiting → done / failed）。所有等待都有超时（QUEUE/EFFECT），定时器经注入的
 *    set/clear 走（可测）；busy 翻转与版本到位由外部（composable 的 watcher）调
 *    `notifyTick()` 驱动，协调器自己从不轮询。
 * 4. `outdatedSessions` — 仪表盘汇总（预览第 6 节）的落后会话列表（稳定顺序）。
 *
 * 送达命令的实证（写进 docs/dev/web-hub/outdated-reload-report.md）：web → 会话走既有
 * control-plane `command` op（`ControlHandle.runCommand`），该通道不经 TUI 编辑器，所以
 * `src/reload/editor.ts` 的「精确 /reload ⇒ /agent reload」改写不会触发；为使「等子
 * agent 结束再重载」的保护（src/reload/ 的 deferred reload）生效，这里固定送
 * `/agent reload`（name "agent", args "reload"），它在 command-policy 里是 confirm 级，
 * 故调用方必须带 `confirm: true`（横幅上的【重新加载】按钮本身就是用户确认）。
 */

import { compareVersions } from "./version-match.js";

/** 送达命令（见文件头实证段）。 */
export const RELOAD_COMMAND_NAME = "agent";
export const RELOAD_COMMAND_ARGS = "reload";
/** 【取消排队】在「已送达但被 deferred-reload park」时送达的取消命令。 */
export const RELOAD_CANCEL_ARGS = "reload cancel";

/** 所有等待的时限（不得无限等，预览规则 3）。 */
export const OR_QUEUE_TIMEOUT_MS = 30 * 60_000; // 排队/等 fleet 清空的总上限（从 request 起算）
export const OR_EFFECT_TIMEOUT_MS = 90_000; // 已送达且 fleet 空闲后，等重新上报版本
export const OR_TOAST_MS = 4_000; // 成功 toast 停留时长

// ---------------------------------------------------------------------------
// 1 · 落后判定
// ---------------------------------------------------------------------------

export interface OutdatedInfo {
  readonly outdated: boolean;
  /** 会话上报的插件版本（展示用；缺失 ⇒ undefined，判定不变）。 */
  readonly pluginVersion: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * 本会话是否落后于 hub。`card` 是 hub 广播的 `AgentState.card` 镜像（Record）。
 * hubVersion 缺失 ⇒ 不判定（无法验证）；`card.outdated === true`（hub 用同一套
 * semver 规则算的，registry.ts）直接成立；否则本地 semver 比较。
 */
export function sessionOutdatedInfo(card: Record<string, unknown> | undefined, hubVersion: unknown): OutdatedInfo {
  const c = card ?? {};
  const pluginVersion = str(c["pluginVersion"]);
  const hv = str(hubVersion);
  if (c["outdated"] === true) return { outdated: true, pluginVersion };
  if (hv === undefined || pluginVersion === undefined) return { outdated: false, pluginVersion };
  const cmp = compareVersions(pluginVersion, hv);
  return { outdated: cmp !== null && cmp < 0, pluginVersion };
}

/** 成功判据（预览规则 1）：该会话重新上报的插件版本 == hub 版本，且 hub 不再标 outdated。 */
export function sessionReloadedToHub(card: Record<string, unknown> | undefined, hubVersion: unknown): boolean {
  const c = card ?? {};
  if (c["outdated"] === true) return false;
  const pv = str(c["pluginVersion"]);
  const hv = str(hubVersion);
  if (pv === undefined || hv === undefined) return false;
  return compareVersions(pv, hv) === 0;
}

// ---------------------------------------------------------------------------
// 2 · snooze（【暂不】/【关闭】记忆）
// ---------------------------------------------------------------------------

export const SNOOZE_STORAGE_KEY = "pwh_or_snooze_v1";
/** 上限防御（异常 agentKey 增长也不会无限写盘）；FIFO 淘汰最旧条目。 */
export const SNOOZE_CAP = 64;

export type SnoozeMap = Readonly<Record<string, string>>;

export interface SnoozeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读 snooze 表；缺失/损坏/非对象 ⇒ 空表（永远不 throw）。 */
export function readSnoozeMap(storage: SnoozeStorage | null): Record<string, string> {
  if (storage === null) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(SNOOZE_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 【暂不】/【关闭】是否仍然有效：存下的 hub 版本与当前 hub 版本相等 ⇒ 不再提示。 */
export function isSnoozed(map: SnoozeMap, agentKey: string, hubVersion: unknown): boolean {
  const hv = str(hubVersion);
  if (hv === undefined) return false;
  return map[agentKey] === hv;
}

/** 记入一条 snooze（纯函数，返回新表；同 key 刷新插入序，超帽 FIFO 淘汰最旧）。 */
export function withSnooze(map: SnoozeMap, agentKey: string, hubVersion: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) if (k !== agentKey) out[k] = v;
  out[agentKey] = hubVersion;
  const keys = Object.keys(out);
  while (keys.length > SNOOZE_CAP) {
    const oldest = keys.shift();
    if (oldest === undefined) break;
    delete out[oldest];
  }
  return out;
}

/** 写盘（best-effort；storage 拒绝时静默降级为「仅本次会话内生效」——调用方持有内存表）。 */
export function writeSnoozeMap(storage: SnoozeStorage | null, map: SnoozeMap): void {
  if (storage === null) return;
  try {
    storage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage disabled/quota — snooze stays memory-only */
  }
}

// ---------------------------------------------------------------------------
// 3 · OrCoordinator — 排队/送达/生效状态机（每会话一条）
// ---------------------------------------------------------------------------

export type OrPhase = "idle" | "queued" | "sending" | "awaiting" | "parked" | "failed" | "done";

/**
 * 相语义（major 修复 2026-10-26：「忙」= 主会话流式 ∨ 有活跃子 agent/workflow）：
 * - queued：尚未送帧，等主会话闲且 fleet 空；
 * - sending/awaiting：已送帧且 fleet 空闲，90s 生效计时只在 awaiting 走；
 * - parked：已送达但被 deferred-reload park（送达时或之后 fleet 忙）——显示 info 排队态，
 *   【取消排队】送 `/agent reload cancel`；fleet 清空 ⇒ 回 awaiting 重开 90s；
 * - 30min 总上限（OR_QUEUE_TIMEOUT_MS）从 request 起算，覆盖 queued+parked；
 *   只有 awaiting 的 90s 超时才是 E_TIMEOUT。
 */

export interface OrEntry {
  readonly phase: OrPhase;
  /** failed：错误码（E_OFFLINE / E_UNSUPPORTED / E_TIMEOUT / E_QUEUE_TIMEOUT / wire code）。 */
  readonly error?: string;
  /** failed：人读原因（wire message 或本地 i18n 文案由展示层补）。 */
  readonly message?: string;
}

export const OR_IDLE: OrEntry = { phase: "idle" };

/** 本地（不发帧）即可判定的失败。 */
export type OrPrecheck = "ok" | "offline" | "unsupported";

export interface OrSendResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

export interface OrCoordinatorDeps {
  /** 主会话是否流式中（`status.busy`）。 */
  mainBusy(agentKey: string): boolean;
  /** 活跃子 agent/workflow 数（fleet 行 running + omitted.active）——deferred reload 的 park 条件。 */
  fleetActive(agentKey: string): number;
  /** 发送前本地判定（离线/无控制面 ⇒ 不发帧，直接 failed）。 */
  precheck(agentKey: string): OrPrecheck;
  /** 版本到位（成功判据）。 */
  isSettled(agentKey: string): boolean;
  /** 实际送帧；promise 必会 settle（hub/agent 各有 deadline），拒绝按失败处理。 */
  send(agentKey: string): Promise<OrSendResult>;
  /** 取消已送达但被 park 的 reload（`/agent reload cancel`）；fire-and-forget，结果忽略。 */
  sendCancel(agentKey: string): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 任一 entry 变化时回调（composable 用来触发响应式）。 */
  onChange?: (agentKey: string) => void;
}

export interface OrCoordinator {
  entryOf(agentKey: string): OrEntry;
  /** 【重新加载】/【重试】。主会话忙或 fleet 忙 ⇒ 排队；离线/无控制 ⇒ 立即 failed；否则送帧。 */
  request(agentKey: string): void;
  /** 【取消排队】：queued 直接撤销；parked（已送达）同时送 `/agent reload cancel`。 */
  cancelQueue(agentKey: string): void;
  /** 【暂不】/【关闭】：回到 idle（snooze 记忆由调用方负责）。 */
  reset(agentKey: string): void;
  /** 外部状态（busy / fleet / 版本）可能变了：queued 放行、awaiting⇄parked 迁移、到位判成功。 */
  notifyTick(): void;
  /** 卸载时清掉所有定时器。 */
  dispose(): void;
}

export function createOrCoordinator(deps: OrCoordinatorDeps): OrCoordinator {
  const entries = new Map<string, OrEntry>();
  const timers = new Map<string, { queue?: unknown; effect?: unknown; toast?: unknown }>();

  function changed(key: string): void {
    deps.onChange?.(key);
  }

  function set(key: string, entry: OrEntry): void {
    entries.set(key, entry);
    changed(key);
  }

  function clearTimerKind(key: string, kind: "queue" | "effect" | "toast"): void {
    const slot = timers.get(key);
    const h = slot?.[kind];
    if (h !== undefined) {
      deps.clearTimeout(h);
      if (slot !== undefined) delete slot[kind];
    }
  }

  function clearAllTimers(key: string): void {
    clearTimerKind(key, "queue");
    clearTimerKind(key, "effect");
    clearTimerKind(key, "toast");
  }

  function armTimer(key: string, kind: "queue" | "effect" | "toast", ms: number, fn: () => void): void {
    clearTimerKind(key, kind);
    const h = deps.setTimeout(fn, ms);
    let slot = timers.get(key);
    if (slot === undefined) {
      slot = {};
      timers.set(key, slot);
    }
    slot[kind] = h;
  }

  function fail(key: string, error: string, message?: string): void {
    clearAllTimers(key);
    set(key, message === undefined ? { phase: "failed", error } : { phase: "failed", error, message });
  }

  function succeed(key: string): void {
    clearAllTimers(key);
    set(key, { phase: "done" });
    // toast 停 OR_TOAST_MS 后回 idle（此时会话已不再落后，提示条自然消失）。
    armTimer(key, "toast", OR_TOAST_MS, () => {
      if (entries.get(key)?.phase !== "done") return;
      clearAllTimers(key);
      entries.delete(key);
      changed(key);
    });
  }

  /** 是否不可送/不可生效：主会话流式 ∨ fleet 有活跃 run（deferred reload 的 park 条件）。 */
  function blocked(key: string): boolean {
    return deps.mainBusy(key) || deps.fleetActive(key) > 0;
  }

  /** 进入 awaiting（fleet 空闲，90s 生效计时从此刻起算——parked 恢复时重开）。 */
  function enterAwaiting(key: string): void {
    set(key, { phase: "awaiting" });
    armTimer(key, "effect", OR_EFFECT_TIMEOUT_MS, () => {
      if (entries.get(key)?.phase !== "awaiting") return;
      fail(key, "E_TIMEOUT");
    });
  }

  /** 进入 parked（已送达，deferred reload 在等 fleet）；queue 总上限计时保持。 */
  function enterParked(key: string): void {
    clearTimerKind(key, "effect");
    set(key, { phase: "parked" });
  }

  function send(key: string): void {
    clearTimerKind(key, "effect");
    set(key, { phase: "sending" });
    deps
      .send(key)
      .then((r) => {
        const cur = entries.get(key);
        if (cur === undefined || cur.phase !== "sending") return; // 已被取消/重置/超时
        if (r.ok) {
          // 送达时 fleet 已忙 ⇒ deferred reload 会 park：不计 90s，转 parked 等 fleet 清空。
          if (deps.fleetActive(key) > 0) enterParked(key);
          else enterAwaiting(key);
        } else {
          fail(key, r.error ?? "E_UNKNOWN", r.message);
        }
      })
      .then(undefined, () => {
        // send 实现约定不拒绝，但防御性地兜底成失败态（绝不无限悬挂）。
        const cur = entries.get(key);
        if (cur === undefined || cur.phase !== "sending") return;
        fail(key, "E_UNKNOWN");
      });
  }

  function armQueueCap(key: string): void {
    armTimer(key, "queue", OR_QUEUE_TIMEOUT_MS, () => {
      const cur = entries.get(key);
      if (cur?.phase === "queued") {
        fail(key, "E_QUEUE_TIMEOUT");
      } else if (cur?.phase === "parked") {
        // 已送达的 park 超总上限：先取消后端 arm 着的 reload，再如实报超时。
        void deps.sendCancel(key).then(undefined, () => {});
        fail(key, "E_QUEUE_TIMEOUT");
      }
      // awaiting/sending：effect 90s ≪ 30min，一定先结算；这里兜底忽略。
    });
  }

  function request(key: string): void {
    const cur = entries.get(key);
    if (
      cur !== undefined &&
      (cur.phase === "queued" || cur.phase === "sending" || cur.phase === "awaiting" || cur.phase === "parked")
    ) {
      return; // 已在飞，幂等
    }
    const pre = deps.precheck(key);
    if (pre === "offline") {
      fail(key, "E_OFFLINE");
      return;
    }
    if (pre === "unsupported") {
      fail(key, "E_UNSUPPORTED");
      return;
    }
    clearAllTimers(key);
    armQueueCap(key); // 30min 总上限从 request 起算，覆盖 queued+parked（firing 忽略其它相）
    if (blocked(key)) {
      set(key, { phase: "queued" });
      return;
    }
    send(key);
  }

  return {
    entryOf: (key) => entries.get(key) ?? OR_IDLE,
    request,
    cancelQueue(key) {
      const cur = entries.get(key);
      if (cur === undefined || (cur.phase !== "queued" && cur.phase !== "parked")) return;
      if (cur.phase === "parked") void deps.sendCancel(key).then(undefined, () => {});
      clearAllTimers(key);
      entries.delete(key);
      changed(key);
    },
    reset(key) {
      clearAllTimers(key);
      entries.delete(key);
      changed(key);
    },
    notifyTick() {
      // 版本到位是全局真值：任何活动相（含 failed——effect:"unknown" 的命令可能其实送达了）
      // 都收敛到 done。先收集再改，避免遍历中原地改写顺序依赖。
      const toSettle: string[] = [];
      const toSend: string[] = [];
      const toPark: string[] = [];
      const toAwait: string[] = [];
      for (const [key, entry] of entries) {
        if (entry.phase === "idle" || entry.phase === "done") continue;
        if (deps.isSettled(key)) {
          toSettle.push(key);
          continue;
        }
        if (entry.phase === "queued" && !blocked(key) && deps.precheck(key) === "ok") toSend.push(key);
        else if (entry.phase === "awaiting" && deps.fleetActive(key) > 0) toPark.push(key);
        else if (entry.phase === "parked" && deps.fleetActive(key) === 0) toAwait.push(key);
      }
      for (const key of toSettle) succeed(key);
      for (const key of toSend) send(key);
      for (const key of toPark) enterParked(key);
      for (const key of toAwait) enterAwaiting(key);
    },
    dispose() {
      for (const key of [...timers.keys()]) clearAllTimers(key);
      timers.clear();
    },
  };
}

/** 横幅「状态 → 展示」映射（组件与单测共用的唯一真源；icon 名对齐 icons/names.ts）。 */
export function orBannerView(entry: OrEntry): {
  tone: "warn" | "info" | "danger";
  role: "status" | "alert";
  icon: "info" | "alert" | "loader";
  spinning: boolean;
} {
  switch (entry.phase) {
    case "failed":
      return { tone: "danger", role: "alert", icon: "alert", spinning: false };
    case "queued":
    case "parked":
      return { tone: "info", role: "status", icon: "loader", spinning: true };
    case "sending":
    case "awaiting":
      return { tone: "warn", role: "status", icon: "loader", spinning: true };
    default:
      return { tone: "warn", role: "status", icon: "info", spinning: false };
  }
}

// ---------------------------------------------------------------------------
// 4 · 仪表盘汇总（预览第 6 节）
// ---------------------------------------------------------------------------

export interface OutdatedSessionRow {
  readonly key: string;
  readonly busy: boolean;
  readonly pluginVersion: string | undefined;
}

export interface OutdatedAgentLike {
  readonly key: string;
  readonly card: unknown;
  readonly status?: unknown;
  readonly down?: boolean;
}

function busyOfRaw(status: unknown): boolean {
  if (status === null || typeof status !== "object") return false;
  return (status as { busy?: unknown }).busy === true;
}

/**
 * 活跃子 agent/workflow 数（major 修复 2026-10-26）：fleet 行里 `status === "running" ∧
 * terminal !== true` 的行数（与 agentCardModel.runningSubCountOf 同口径）+ 投影截断掉的
 * `fleetOmitted.active`。deferred reload 的 park 条件就是「还有未 settle 的 run」。
 */
export function fleetActiveCount(fleet: unknown, fleetOmitted: unknown): number {
  let n = 0;
  if (Array.isArray(fleet)) {
    for (const row of fleet) {
      if (row === null || typeof row !== "object") continue;
      const r = row as { status?: unknown; terminal?: unknown };
      if (r.terminal !== true && r.status === "running") n++;
    }
  }
  if (fleetOmitted !== null && typeof fleetOmitted === "object") {
    const a = (fleetOmitted as { active?: unknown }).active;
    if (typeof a === "number" && Number.isInteger(a) && a > 0) n += a;
  }
  return n;
}

/**
 * 落后会话列表（按传入顺序 = 侧边栏顺序，稳定）。离线（down/stale）的也计入——预览第 6
 * 节不区分；【全部重新加载】时它们会立即落到 failed(E_OFFLINE)，行内如实展示。
 */
export function outdatedSessions(agents: Iterable<OutdatedAgentLike>, hubVersion: unknown): OutdatedSessionRow[] {
  const out: OutdatedSessionRow[] = [];
  for (const a of agents) {
    const card =
      a.card !== null && typeof a.card === "object" && !Array.isArray(a.card)
        ? (a.card as Record<string, unknown>)
        : {};
    const info = sessionOutdatedInfo(card, hubVersion);
    if (!info.outdated) continue;
    out.push({ key: a.key, busy: busyOfRaw(a.status), pluginVersion: info.pluginVersion });
  }
  return out;
}
