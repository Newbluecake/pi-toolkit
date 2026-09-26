/**
 * context-switch · 子会话 switch_context 的进程级能力状态机（plan §3.1）。
 *
 * 不看 pi 版本号：状态只由结构探测 / 零影响提交探针 / 首次使用自证的结果驱动。这是 v3 取代
 * v2「精确版本门」的核心机制——latest 上必须完整可用，更旧 / 语义变化的 pi 上不崩溃、不静默
 * 失败、不产生错误交接，能力不成立就安全降级（子会话没有切换，只有 pi 自动压缩）。
 *
 *   unknown ──L0──▶ static-ok ──L1──▶ observed ──L2──▶ ready ──首次切换──▶ verifying ──L3──▶ verified
 *      │                │                │              │                    │                  │
 *      └────────────────┴── 任一层失败 ──┴──────────────┴────────────────────┴──── 见下 ─────────▶ disabled(reason)（本进程粘滞）
 *
 * 停用规则（用户确认，v3 §9.2 第 2 问）：未验证进程（unknown/static-ok/observed/ready/verifying）
 * 任一层首次失败即停；已验证进程（verified）之后的每次切换轻量复核，单次失败只记不禁用，
 * **连续 2 次**未提交才禁用（`repeat-uncommitted`）。粘滞：disabled 在本进程内不恢复，重启 pi
 * （新进程）才从 unknown 重新走一遍。
 *
 * 进程级单例：挂在 `Symbol.for("pi-subagent:child-switch-capability")` 上，jiti 在 `/reload` 时
 * 重新 import 本模块（fresh module instance）也读写同一个 globalThis 槎位——这与
 * `src/core/worktree-origin.ts` / `src/service/child-registry.ts` 同一模式。生产代码没有
 * reset：能力状态要跨 `/reload` 存活（pi 本体没变，检测结论也不该变）。测试用
 * `resetChildSwitchCapabilityForTests()`（仅测试用，见其文档）取得进程重启的等价效果。
 */

export type CapabilityStateName = "unknown" | "static-ok" | "observed" | "ready" | "verifying" | "verified";

export type CapabilityStatus = { state: CapabilityStateName } | { state: "disabled"; reason: string };

export type ProbeResult = { ok: true } | { ok: false; reason: string };
/** L2 的三项核对可能"无结论"（会话提前结束 / 无会话文件）：既不算通过也不算失败，停留在 observed。 */
export type L2ProbeResult = ProbeResult | { ok: undefined };

interface CapabilityRecord {
  status: CapabilityStatus;
  /** verified 之后的连续未提交计数（repeat-uncommitted 规则，2 次才禁用）。 */
  consecutiveUncommitted: number;
  listeners: Set<(reason: string) => void>;
  /** "每进程一次"：真正调用监听器只发生在这一次由 false 翻到 true 的瞬间。 */
  notifiedDisabled: boolean;
}

const CAPABILITY_KEY = Symbol.for("pi-subagent:child-switch-capability");

function freshRecord(): CapabilityRecord {
  return {
    status: { state: "unknown" },
    consecutiveUncommitted: 0,
    listeners: new Set(),
    notifiedDisabled: false,
  };
}

function getRecord(): CapabilityRecord {
  const g = globalThis as Record<symbol, CapabilityRecord | undefined>;
  const existing = g[CAPABILITY_KEY];
  if (existing) return existing;
  const created = freshRecord();
  g[CAPABILITY_KEY] = created;
  return created;
}

function disable(record: CapabilityRecord, reason: string): CapabilityStatus {
  if (record.status.state === "disabled") return record.status;
  record.status = { state: "disabled", reason };
  if (!record.notifiedDisabled) {
    record.notifiedDisabled = true;
    for (const listener of record.listeners) {
      try {
        listener(reason);
      } catch {
        // best effort: one bad listener must not break the others or the caller.
      }
    }
  }
  return record.status;
}

export interface ChildSwitchCapability {
  /** 当前状态的只读快照。 */
  get(): CapabilityStatus;
  /** L0 静态结构探测（activate 时，注册前）。 */
  noteL0(result: ProbeResult): CapabilityStatus;
  /** L1 turn_end 事件形状（每个 turn_end 一次，直到越过 observed）。 */
  noteL1(result: ProbeResult): CapabilityStatus;
  /** L2 零影响提交探针（观察到 `observed` 期间，每个 pi 进程成功一次即止）。 */
  noteL2(result: L2ProbeResult): CapabilityStatus;
  /**
   * 从 `ready` 进入首次真实切换的自证窗口。同一时刻进程内只允许一个：已在 `verifying` 时
   * 返回 false（调用方据此回 "retry shortly"），成功占位返回 true。
   */
  tryBeginVerification(): boolean;
  /** 首次使用自证（L3）的结果：`verifying` → `verified` 或立即禁用。 */
  noteL3(result: ProbeResult): CapabilityStatus;
  /** `verified` 之后每次切换的轻量复核：单次失败只计数，连续 2 次才禁用。 */
  noteRecheck(result: ProbeResult): CapabilityStatus;
  /** 首次进入 disabled 时触发一次；此后任何调用（包括后来才注册的监听器）都不会补发。 */
  onDisabled(listener: (reason: string) => void): () => void;
}

function build(record: CapabilityRecord): ChildSwitchCapability {
  return {
    get: () => record.status,
    noteL0(result) {
      if (record.status.state === "disabled") return record.status;
      if (!result.ok) return disable(record, `l0-${result.reason}`);
      if (record.status.state === "unknown") record.status = { state: "static-ok" };
      return record.status;
    },
    noteL1(result) {
      if (record.status.state === "disabled") return record.status;
      if (!result.ok) return disable(record, result.reason);
      if (record.status.state === "static-ok") record.status = { state: "observed" };
      return record.status;
    },
    noteL2(result) {
      if (record.status.state === "disabled") return record.status;
      if (record.status.state !== "observed") return record.status;
      if (result.ok === undefined) return record.status; // 无结论：停留 observed
      if (!result.ok) return disable(record, result.reason);
      record.status = { state: "ready" };
      return record.status;
    },
    tryBeginVerification() {
      if (record.status.state !== "ready") return false;
      record.status = { state: "verifying" };
      return true;
    },
    noteL3(result) {
      if (record.status.state === "disabled") return record.status;
      if (record.status.state !== "verifying") return record.status;
      if (!result.ok) return disable(record, result.reason);
      record.status = { state: "verified" };
      record.consecutiveUncommitted = 0;
      return record.status;
    },
    noteRecheck(result) {
      if (record.status.state === "disabled") return record.status;
      if (record.status.state !== "verified") return record.status;
      if (result.ok) {
        record.consecutiveUncommitted = 0;
        return record.status;
      }
      record.consecutiveUncommitted += 1;
      if (record.consecutiveUncommitted >= 2) return disable(record, "repeat-uncommitted");
      return record.status;
    },
    onDisabled(listener) {
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
  };
}

/** 进程级单例句柄（模拟 /reload：不同模块实例读写同一个 Symbol 槎位）。 */
export function getChildSwitchCapability(): ChildSwitchCapability {
  return build(getRecord());
}

/**
 * 测试专用：把进程级单例清空回 `unknown`，等价于「pi 进程重启」。生产代码永远不调用——见本
 * 文件头注释：能力状态要跨 `/reload` 存活。仅用于让 `tests/context-switch/capability.test.ts`
 * 在同一个 vitest worker 里的多个 `it()` 之间互不串扰。
 */
export function resetChildSwitchCapabilityForTests(): void {
  const g = globalThis as Record<symbol, CapabilityRecord | undefined>;
  g[CAPABILITY_KEY] = freshRecord();
}
