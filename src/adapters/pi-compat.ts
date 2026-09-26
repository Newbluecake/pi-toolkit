/**
 * L4 compatibility gate (architecture §2.10): the only file allowed to read
 * pi's version string or branch on it (I14). Capability checks themselves
 * are structural (typeof / "in" probes on the live ExtensionAPI object)
 * rather than version comparisons — a version string is only ever used for
 * the WARN text, never for a gating decision.
 *
 * Honesty note: some documented behaviors (2.4's per-event AgentEvent
 * contract: tool_execution_start/end, auto_retry_start, compaction_start/end,
 * agent_settled) cannot be structurally verified before any session exists —
 * doing so would require actually running a session (the "contract
 * conformance" C-class tests in the architecture doc, not implemented here).
 * `eventsPresent` is therefore a documented, conservative assumption, not a
 * verified fact; it is kept as its own field precisely so a future C-class
 * test suite has a single place to plug real verification into.
 *
 * Boundary capability (docs/dev/child-context-switch/plan.md §3.1): child-session
 * switch_context gating is NOT a fifth I14 exception — `probeBoundaryStatic` / `checkTurnEndShape`
 * below are pure structural probes (L0/L1 of a runtime capability state machine that continues
 * with a zero-impact commit probe and a first-use self-check, all in src/context-switch/), never a
 * version comparison. Upgrading pi when its next minor changes boundary-draft semantics needs
 * `npm run test:conformance`, not a change to this file's version-branching.
 */
export interface PiCapabilities {
  version: string;
  canSendMessage: boolean;
  canAppendEntry: boolean;
  canRenderEntries: boolean;
  canReadBackEntries: boolean;
  canUseEvents: boolean;
  canRetargetTools: boolean;
  /** set_model host form: ExtensionAPI.setModel/getThinkingLevel/setThinkingLevel (types.d.ts:1003-1007). */
  canSetModel: boolean;
  eventsPresent: Record<
    | "tool_execution_start"
    | "tool_execution_end"
    | "auto_retry_start"
    | "compaction_start"
    | "compaction_end"
    | "agent_settled",
    boolean
  >;
}

export interface MinimalPiHost {
  sendMessage?: unknown;
  appendEntry?: unknown;
  registerEntryRenderer?: unknown;
  setActiveTools?: unknown;
  getActiveTools?: unknown;
  setModel?: unknown;
  getThinkingLevel?: unknown;
  setThinkingLevel?: unknown;
  events?: { on?: unknown; emit?: unknown };
  sessionManager?: { getEntries?: unknown };
}

/**
 * Session-time probe (NOT load-time): `sessionManager` only exists on the
 * ExtensionContext passed to session_start handlers — the module-load-time
 * ExtensionAPI has no such field (pi-coding-agent extensions/loader.js:
 * createExtensionAPI never defines it; types.d.ts:219 puts it on the event
 * ctx). Gating on it at load time would disable the extension on every real
 * pi. Probe it once per session_start instead.
 */
export function probeReadBackEntries(host: { sessionManager?: { getEntries?: unknown } } | undefined): boolean {
  return typeof host?.sessionManager?.getEntries === "function";
}

/**
 * /goal（goal-plan v4 M-f/M-g）依赖的未文档化 pi 行为假设，peer 升级时回归
 * （最近一次复核：0.87.1）：
 *  1. 用户 Ctrl+C abort 当前 run 时仍照常 emit agent_end 与 agent_settled
 *     （证据：chunk-OMWWHBTG.js abort 分支；若未来 abort 跳过这两个事件，
 *     goal 只是当轮不评估——行为可接受，但自动暂停会失效）。
 *  2. 扩展事件 AgentEndEvent 没有 willRetry 字段（0.87 只给会话级 _emit 的
 *     agent_end 加了 willRetry，扩展侧仍是 { type, messages }，
 *     agent-session.js:581 vs :716）；「是否有后续 retry/compaction」只能靠
 *     agent_settled 的语义保证（这也是 goal 钩在 agent_settled 的原因）。
 *  3. AgentSettledEvent 不携带消息载荷；abort 检测只能先在 agent_end 记录
 *     末条 assistant 的 stopReason（"aborted"），再在 settled 时消费。
 *  4. ExtensionAPI.sendUserMessage 返回 void（0.87 types.d.ts:1055；AgentSession
 *     自身的同名方法是 async，loader 不回传该 Promise）、异步失败经 emitError
 *     走掉，扩展侧 try/catch 抓不到投递失败——goal 因此用投递看门狗（观察新 run
 *     是否起来）而非错误回调。0.87 起 agent_settled 内请求的 run 被推迟到所有
 *     settled 处理器跑完，看门狗是定时器触发，不受影响。
 */
const ASSUMED_EVENTS_PRESENT = {
  tool_execution_start: true,
  tool_execution_end: true,
  auto_retry_start: true,
  compaction_start: true,
  compaction_end: true,
  agent_settled: true,
} as const;

export function detectPiCapabilities(pi: MinimalPiHost, version = "unknown"): PiCapabilities {
  return {
    version,
    canSendMessage: typeof pi.sendMessage === "function",
    canAppendEntry: typeof pi.appendEntry === "function",
    canRenderEntries: typeof pi.registerEntryRenderer === "function",
    canReadBackEntries: typeof pi.sessionManager?.getEntries === "function",
    canUseEvents: typeof pi.events?.on === "function" && typeof pi.events?.emit === "function",
    canRetargetTools: typeof pi.setActiveTools === "function" && typeof pi.getActiveTools === "function",
    canSetModel:
      typeof pi.setModel === "function" &&
      typeof pi.getThinkingLevel === "function" &&
      typeof pi.setThinkingLevel === "function",
    eventsPresent: { ...ASSUMED_EVENTS_PRESENT },
  };
}

export const TESTED_PI_RANGE = "0.87.0 - 0.87.1";

/**
 * Child-context-switch boundary capability (docs/dev/child-context-switch/plan.md §3.1):
 * structural detection + first-use self-proof + safe degrade, NOT a version gate — the user
 * explicitly rejected a precise-version I14 exception for this feature (v2→v3 processing, plan
 * "v3" note). `probeBoundaryStatic` / `checkTurnEndShape` below are the L0/L1 layers of that state
 * machine; they read only `typeof`/`in`-shaped structure off the live module namespace or event,
 * never `caps.version`. Callers pass in the namespace import
 * (`import * as pi from "@earendil-works/pi-coding-agent"`) so this file never performs the import
 * itself, keeping it testable with a fake module object.
 */
export interface BoundaryStaticProbeInput {
  ExtensionRunner?: { prototype?: { emitBoundary?: unknown } };
  SessionManager?: { inMemory?: unknown };
  convertToLlm?: unknown;
  findCutPoint?: unknown;
  estimateTokens?: unknown;
  parseSessionEntries?: unknown;
  sessionEntryToContextMessages?: unknown;
}

export type BoundaryProbeResult = { ok: true } | { ok: false; reason: string; missing: readonly string[] };

/** L0 (§3.1): every export the boundary path needs must be a function. No version read. */
export function probeBoundaryStatic(mod: BoundaryStaticProbeInput | undefined): BoundaryProbeResult {
  const missing: string[] = [];
  if (typeof mod?.ExtensionRunner?.prototype?.emitBoundary !== "function") missing.push("ExtensionRunner.emitBoundary");
  if (typeof mod?.SessionManager?.inMemory !== "function") missing.push("SessionManager.inMemory");
  if (typeof mod?.convertToLlm !== "function") missing.push("convertToLlm");
  if (typeof mod?.findCutPoint !== "function") missing.push("findCutPoint");
  if (typeof mod?.estimateTokens !== "function") missing.push("estimateTokens");
  if (typeof mod?.parseSessionEntries !== "function") missing.push("parseSessionEntries");
  if (typeof mod?.sessionEntryToContextMessages !== "function") missing.push("sessionEntryToContextMessages");
  return missing.length > 0 ? { ok: false, reason: `l0-${missing.join(",")}`, missing } : { ok: true };
}

/** Structural shape the L1 check needs off a real `TurnEndEvent` + its session ctx. */
export interface TurnEndShapeInput {
  entries?: unknown;
  messageEntryId?: unknown;
  toolResultEntryIds?: unknown;
  context?: { canContinue?: unknown };
  outcome?: unknown;
}

export interface TurnEndShapeSessionManager {
  getBranch?: (fromId?: string) => readonly { id?: unknown }[];
  getHeader?: () => unknown;
}

const VALID_OUTCOMES = new Set(["completed", "aborted", "error"]);

/**
 * L1 (§3.1): does THIS turn_end event have the 0.87-shaped boundary fields (0.86's TurnEndEvent
 * only has type/turnIndex/message/toolResults, plan §1.6)? Runs once per turn_end — a runtime that
 * degrades mid-process (should never happen, pi doesn't hot-swap) would be caught here too.
 */
export function checkTurnEndShape(
  event: TurnEndShapeInput | undefined,
  sessionManager: TurnEndShapeSessionManager | undefined,
): { ok: true } | { ok: false; reason: "l1-event-shape" } {
  const fail = { ok: false as const, reason: "l1-event-shape" as const };
  if (!event) return fail;
  if (!Array.isArray(event.entries)) return fail;
  if (typeof event.messageEntryId !== "string" || event.messageEntryId.length === 0) return fail;
  if (!Array.isArray(event.toolResultEntryIds)) return fail;
  if (typeof event.context?.canContinue !== "boolean") return fail;
  if (typeof event.outcome !== "string" || !VALID_OUTCOMES.has(event.outcome)) return fail;
  if (typeof sessionManager?.getHeader !== "function") return fail;
  if (typeof sessionManager?.getBranch !== "function") return fail;
  let branch: readonly { id?: unknown }[];
  try {
    branch = sessionManager.getBranch();
  } catch {
    return fail;
  }
  if (!Array.isArray(branch) || !branch.some((entry) => entry?.id === event.messageEntryId)) return fail;
  return { ok: true };
}

export type CompatResult = { ok: true; warning?: string } | { ok: false; reason: string };

/**
 * Three-tier gate (architecture §2.10):
 *  - all critical capabilities present -> ok (with a WARN string, not a hard
 *    failure, when the runtime version string falls outside the tested range)
 *  - any critical capability missing -> reject (caller must register a
 *    stub-only tool set instead of the real ones, see index.ts)
 *
 * Critical = required for G5b (notification delivery) plus the pi.events
 * lifecycle contract (§6.2). G5a's read-back (`sessionManager.getEntries`)
 * is NOT load-time critical: it is only available on the session_start ctx
 * (see probeReadBackEntries), and its absence degrades G5a to in-memory +
 * best-effort appendEntry with a WARN instead of disabling the extension.
 */
export function assertCompatible(caps: PiCapabilities): CompatResult {
  const missing: string[] = [];
  if (!caps.canSendMessage) missing.push("sendMessage");
  if (!caps.canAppendEntry) missing.push("appendEntry");
  if (!caps.canUseEvents) missing.push("events.on/emit");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `pi ${caps.version} is missing required capabilities: ${missing.join(", ")}. Upgrade pi (tested range ${TESTED_PI_RANGE}).`,
    };
  }
  // Only warn when we actually know the version; "unknown" means the host
  // did not expose one, and warning every session_start would be pure noise.
  const outsideTestedRange = caps.version !== "unknown" && !isWithinTestedRange(caps.version);
  return outsideTestedRange
    ? {
        ok: true,
        warning: `pi-subagent has not been validated against pi ${caps.version} (tested range ${TESTED_PI_RANGE}); all required capabilities were detected, proceeding.`,
      }
    : { ok: true };
}

function isWithinTestedRange(version: string): boolean {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return false;
  const [major, minor] = parts as [number, number];
  return major === 0 && minor === 87;
}
