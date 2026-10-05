/**
 * web-hub-spawn plan §SP8 / arch §4.6（#15，用户裁定：首条消息由 hub 转发，正文不落盘）：
 * 创建请求可选携带的首条消息只在 hub 内存持有，记录 `live` 且 `control===true` 后经
 * `commandRouter.request()` 送达；结果只通过 `spawns` 的 `firstPrompt.state` 告知。
 *
 * dup/重试语义决策（SP1 验收遗留 P3② 的核对结论，对齐真身 `hub/commands.ts` +
 * `agent/ledger.ts`；契约替身 `tests/web-hub/contract/fakes.ts` 只对 ok 结果做 dup 回放、
 * 失败结果会重复执行，与真身不同——「至多一次生效」类断言因此走本包测试内的 realistic
 * 双身，见 `tests/web-hub/hub/spawn/first-prompt.test.ts`）：
 *
 * 1. 真实 hub router（commands.ts 三态 LRU）：ok 或不可重试失败 ⇒ `done` 缓存，同 id 重放
 *    直接回同一结果、不重发帧；`retryable && effect:"none"` ⇒ 条目删除，重放重新执行；
 *    `effect:"unknown"`（含 E_DEADLINE，无论 body 还是 throw）⇒ 条目保持 unknown，同 id
 *    重发由 router 自动加 `retry:true` 转发。
 * 2. agent 台账（ledger.ts D7 rule 2）与之同构：`retryable && effect:"none"` 失败删除条目
 *    ⇒ 重试重新执行——安全，因为 effect:"none" 意为「从未生效」；其余终态缓存 ⇒ 同 id
 *    重放回放、不再执行。
 * 3. 本模块只重试计划允许的类：E_AGENT_GONE（回 pending 等 `onLink(true)`）、E_DEADLINE、
 *    `effect:"unknown"`、E_BUSY_COMPACTING、E_BUSY_STEER（退避重发）。因此对真身而言每次
 *    重发要么被 agent 台账同 id 去重（unknown 类），要么重执行的是从未生效过的一次
 *    （effect:"none" 类）——「hub 进程生命周期内、截止 firstPromptDeadlineAt 的尽力送达，
 *    至多一次生效」端到端成立。其余一切（E_UNSUPPORTED / E_COMMAND_DENIED / E_BAD_REQUEST /
 *    E_SESSION_CHANGED / 无码 throw ⇒ 合成 E_INTERNAL / E_HUB_RESTARTING 等）一律
 *    `failed{code}` 终态不再重试；hub 关停路径另有 `dispose("hub_restart")` 兜底。
 */
import { Buffer } from "node:buffer";
import type { CmdFrame, CmdOrigin, CmdResultFrame } from "../../protocol/messages.js";
import { FIRST_PROMPT_BACKOFF_MS, type FirstPromptState } from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";
import type { FirstPromptRouterPort } from "./ports.js";

/** 合成 cmd 帧的单次 `deadlineMs`（plan §3.1 ⑧：单次 8000）。router 自身在它之上再加等待
 *  宽限；整体回路由调用方传入的绝对 `deadlineAt` 约束，不用剩余预算推导。 */
export const FIRST_PROMPT_CMD_DEADLINE_MS = 8_000;

/** 退避表恰好覆盖 3 次重发 ⇒ 至多 4 次发送（plan ⑧「最多 4 次」；用完或绝对期限到 ⇒
 *  `expired{deadline}`）。派生而非复制，避免与 FIRST_PROMPT_BACKOFF_MS 漂移。 */
const MAX_SENDS = FIRST_PROMPT_BACKOFF_MS.length + 1;

/** 固定 cmd id（arch §4.6）：hub LRU 键 `principal|agentKey|id` 与 agent 自身台账都按它去重，
 *  因此同一 spawn 首条消息的所有重发映射到（至多）一次执行。 */
function cmdIdOf(spawnId: string): string {
  return `fp_${spawnId}`;
}

/** arch §6.6 spawn 审计行的首条消息切片（SP9 会把它并入 `SpawnAuditRecord`）。`code` 承载
 *  错误码（failed）或过期原因（deadline | never_live | stopped | hub_restart）。永不含正文。 */
export interface FirstPromptAuditRecord {
  audit: "spawn";
  phase: "state";
  spawnId: string;
  firstPrompt: FirstPromptState;
  textLen: number;
  attempts: number;
  code?: string;
}

export interface FirstPromptDeps {
  router: FirstPromptRouterPort;
  now(): number;
  log: HubLog;
  audit(record: FirstPromptAuditRecord): void;
  /** plan §SP8「每次状态变化回调 supervisor 推送 spawns」的落点：SP10 把它接到 supervisor
   *  的同 tick 合并推送上。可选，使计划字面形状的 deps 仍可直接构造。 */
  onChange?(spawnId: string): void;
  /** 注入点仅供测试假时钟；缺省绑定全局（hub 进程内全部 unref，见 `arm`）。 */
  setTimeout?(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout?(timer: NodeJS.Timeout): void;
}

/** `state()` 的投影形状（owner 视图 `firstPrompt` 字段，arch §6.4）——永不含正文。 */
export interface FirstPromptStateView {
  state: FirstPromptState;
  code?: string;
  textLen: number;
  attempts: number;
}

/** 线上可见粗状态之下的内部相位：pending 分「等 live」/「等重连」，sending 分「在途」/「退避中」。 */
type Phase = "await-live" | "await-link" | "inflight" | "backoff" | "terminal";

interface Entry {
  state: FirstPromptState;
  phase: Phase;
  /** 终态即弃（arch §4.6「正文立即从内存丢弃」）；`textLen` 留给投影。 */
  text: string | undefined;
  readonly textLen: number;
  readonly deliver: "steer" | "followUp";
  readonly origin: CmdOrigin;
  readonly deadlineAt: number;
  agentKey: string | undefined;
  sessionId: string | undefined;
  attempts: number;
  code: string | undefined;
  deadlineTimer: NodeJS.Timeout | undefined;
  backoffTimer: NodeJS.Timeout | undefined;
}

export interface FirstPromptForwarder {
  /** 路由（SP9）在 POST 同步段登记；`deadlineAt = createdAt + registerTimeoutS*1000 +
   *  FIRST_PROMPT_GRACE_MS` 由调用方算好传入。同一 spawnId 只接受一次（重复 ⇒ warn 并忽略）。 */
  accept(
    spawnId: string,
    fp: { text: string; deliver: "steer" | "followUp" },
    origin: CmdOrigin,
    deadlineAt: number,
  ): void;
  /** supervisor ⑧ 的闸门：记录 live 时通知；`control=false` ⇒ `failed{E_UNSUPPORTED}`。 */
  onLive(spawnId: string, agentKey: string, sessionId: string, control: boolean): void;
  /** 绑定链路抖动；只在 await-link（上次 E_AGENT_GONE）相位响应 true ⇒ 立即重发。 */
  onLink(spawnId: string, linked: boolean): void;
  /** 记录进入终态仍未送达 ⇒ `expired{reason}`。 */
  onTerminal(spawnId: string, reason: "never_live" | "stopped"): void;
  state(spawnId: string): FirstPromptStateView | undefined;
  /** SP13（SP10 验收遗留评估）：处于 sending（在途或退避重发）的未终态首条消息计数——
   *  hub.ts 把它并入 supersede 的 `managedBusy`（一个替换中的 hub 会以 stdin EOF 结束会话，
   *  首条消息在途时绝不算 quiet）。 */
  sendingCount(): number;
  /** hub 关停：全部未送达 ⇒ `expired{hub_restart}`，随后整个 Map（含正文）清空。 */
  dispose(reason: "hub_restart"): void;
}

export function createFirstPromptForwarder(deps: FirstPromptDeps): FirstPromptForwarder {
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((timer: NodeJS.Timeout) => clearTimeout(timer));
  const entries = new Map<string, Entry>();

  function arm(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimer(fn, Math.max(0, ms));
    timer.unref?.(); // print-mode 安全：hub 内所有定时器不引用事件循环
    return timer;
  }

  function emit(spawnId: string, entry: Entry): void {
    deps.audit({
      audit: "spawn",
      phase: "state",
      spawnId,
      firstPrompt: entry.state,
      textLen: entry.textLen,
      attempts: entry.attempts,
      ...(entry.code !== undefined ? { code: entry.code } : {}),
    });
    deps.onChange?.(spawnId);
  }

  function clearTimers(entry: Entry): void {
    if (entry.deadlineTimer !== undefined) {
      clearTimer(entry.deadlineTimer);
      entry.deadlineTimer = undefined;
    }
    if (entry.backoffTimer !== undefined) {
      clearTimer(entry.backoffTimer);
      entry.backoffTimer = undefined;
    }
  }

  /** 终态迁移：置 state/code、立即丢弃正文、停定时器、写审计并回调。 */
  function finish(
    spawnId: string,
    entry: Entry,
    state: "delivered" | "failed" | "expired",
    code: string | undefined,
  ): void {
    if (entry.phase === "terminal") return;
    clearTimers(entry);
    entry.phase = "terminal";
    entry.state = state;
    entry.code = code;
    entry.text = undefined;
    emit(spawnId, entry);
  }

  function expireAtDeadline(spawnId: string, entry: Entry): void {
    if (entry.phase === "terminal") return;
    const remaining = entry.deadlineAt - deps.now();
    if (remaining > 0) {
      // arch §7.5：不信任定时器精度——到期时与 now() 比较，提前醒了就按余量重挂。
      entry.deadlineTimer = arm(remaining, () => expireAtDeadline(spawnId, entry));
      return;
    }
    finish(spawnId, entry, "expired", "deadline");
  }

  function send(spawnId: string, entry: Entry, retry: boolean): void {
    if (entry.phase === "terminal") return;
    if (deps.now() >= entry.deadlineAt) {
      finish(spawnId, entry, "expired", "deadline");
      return;
    }
    const agentKey = entry.agentKey;
    const sessionId = entry.sessionId;
    const text = entry.text;
    if (agentKey === undefined || sessionId === undefined || text === undefined) return; // 公共 API 下不可达，防御
    const was = entry.state;
    entry.state = "sending";
    entry.phase = "inflight";
    entry.attempts += 1;
    const frame: CmdFrame = {
      t: "cmd",
      // rid 仅作本侧关联回显（registry 发线时自行替换为单调 rid），沿用 cmd id 即可。
      rid: cmdIdOf(spawnId),
      id: cmdIdOf(spawnId),
      deadlineMs: FIRST_PROMPT_CMD_DEADLINE_MS,
      origin: entry.origin,
      ...(retry ? { retry: true as const } : {}),
      cmd: { op: "prompt", text, deliver: entry.deliver, expect: { sessionId } },
    };
    if (was !== "sending") emit(spawnId, entry); // pending → sending；退避重发不产生状态行
    deps.router.request(frame, agentKey).then(
      (result) => onSettled(spawnId, entry, result, undefined),
      (err: unknown) => onSettled(spawnId, entry, undefined, err),
    );
  }

  /** `registry.ts` 的 `HubError`（E_AGENT_GONE/E_DEADLINE 等）以 throw 送出；无码 throw 合成
   *  E_INTERNAL（仅浮出，不重试）。`in` 收窄取 code，全程零 `as`（source-scan 约束）。 */
  function codeOfError(err: unknown): string {
    if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" && err.code !== "") {
      return err.code;
    }
    return "E_INTERNAL";
  }

  function onSettled(spawnId: string, entry: Entry, result: CmdResultFrame | undefined, err: unknown): void {
    if (entry.phase !== "inflight") return; // 已终态，或 deadline/dispose 抢先（迟到回复一律忽略）
    if (result !== undefined && result.ok) {
      finish(spawnId, entry, "delivered", undefined); // ok 含 dup（plan ⑧）
      return;
    }
    const code = result !== undefined ? result.code : codeOfError(err);
    if (code === "E_AGENT_GONE") {
      // 链路抖动：回 pending，等 onLink(true) 后重发（加 retry:true）。
      entry.phase = "await-link";
      entry.state = "pending";
      emit(spawnId, entry);
      return;
    }
    const retryable =
      result !== undefined
        ? result.effect === "unknown" ||
          code === "E_DEADLINE" ||
          code === "E_BUSY_COMPACTING" ||
          code === "E_BUSY_STEER"
        : code === "E_DEADLINE"; // throw 的 E_DEADLINE = registry 等待超时 ⇒ effect unknown
    if (!retryable) {
      finish(spawnId, entry, "failed", code);
      return;
    }
    if (entry.attempts >= MAX_SENDS) {
      finish(spawnId, entry, "expired", "deadline"); // 4 次用完
      return;
    }
    const delay = FIRST_PROMPT_BACKOFF_MS[entry.attempts - 1];
    if (delay === undefined) {
      finish(spawnId, entry, "expired", "deadline"); // MAX_SENDS = len+1 下不可达；保总性
      return;
    }
    entry.phase = "backoff"; // 粗状态保持 sending；只有 E_AGENT_GONE 回 pending
    entry.backoffTimer = arm(delay, () => {
      entry.backoffTimer = undefined;
      if (entry.phase === "backoff") send(spawnId, entry, true);
    });
  }

  return {
    accept(spawnId, fp, origin, deadlineAt) {
      if (entries.has(spawnId)) {
        deps.log.warn("first-prompt accept for known spawn ignored", { spawnId });
        return;
      }
      const entry: Entry = {
        state: "pending",
        phase: "await-live",
        text: fp.text,
        textLen: Buffer.byteLength(fp.text, "utf8"),
        deliver: fp.deliver,
        origin,
        deadlineAt,
        agentKey: undefined,
        sessionId: undefined,
        attempts: 0,
        code: undefined,
        deadlineTimer: undefined,
        backoffTimer: undefined,
      };
      entries.set(spawnId, entry);
      entry.deadlineTimer = arm(deadlineAt - deps.now(), () => expireAtDeadline(spawnId, entry));
      emit(spawnId, entry);
    },

    onLive(spawnId, agentKey, sessionId, control) {
      const entry = entries.get(spawnId);
      if (entry === undefined || entry.phase !== "await-live") return; // live 只来一次；迟到即弃
      if (control !== true) {
        finish(spawnId, entry, "failed", "E_UNSUPPORTED");
        return;
      }
      entry.agentKey = agentKey;
      entry.sessionId = sessionId;
      send(spawnId, entry, false);
    },

    onLink(spawnId, linked) {
      const entry = entries.get(spawnId);
      if (entry === undefined || entry.phase === "terminal") return;
      if (linked && entry.phase === "await-link") send(spawnId, entry, true);
    },

    onTerminal(spawnId, reason) {
      const entry = entries.get(spawnId);
      if (entry === undefined || entry.phase === "terminal") return;
      finish(spawnId, entry, "expired", reason);
    },

    state(spawnId) {
      const entry = entries.get(spawnId);
      if (entry === undefined) return undefined;
      return {
        state: entry.state,
        ...(entry.code !== undefined ? { code: entry.code } : {}),
        textLen: entry.textLen,
        attempts: entry.attempts,
      };
    },

    sendingCount() {
      let n = 0;
      for (const entry of entries.values()) {
        if (entry.phase === "inflight" || entry.phase === "backoff") n += 1;
      }
      return n;
    },

    dispose(reason) {
      for (const [spawnId, entry] of entries) {
        if (entry.phase !== "terminal") finish(spawnId, entry, "expired", reason);
      }
      entries.clear(); // 正文（连同全部记录，含 delivered 墓碑）即刻出内存
    },
  };
}
