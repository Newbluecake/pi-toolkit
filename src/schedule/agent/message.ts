/**
 * Scheduled tasks — `message` form glue (plan r3 §6.2/§6.3, §12 A2): content builders, the
 * settled-result sink, the capability refusal helper and `installMessageScheduler`, the pi-facing
 * assembly around the pi-free state machine in `dispatch.ts`.
 *
 * Integration contract (A3 / index.ts / stack.ts own the call sites; this file never edits them):
 *   - `installMessageScheduler(pi, holder, deps)` — ONCE per `activate()`, post-guard (main session
 *     only), only when `schedule.enabled`. Registers every pi event this module needs; handlers
 *     resolve the live agent through `holder.current?.schedule` (late-bound, no module state), so
 *     the registration survives `/reload` and session replacement. Orphan abort works even while no
 *     scheduler is attached (a wake trigger nobody can prove is aborted before its first provider
 *     request).
 *   - `install.attach(agent, ctx)` — after `buildSessionStack` produced `stack.schedule` and BEFORE
 *     `schedule.start()` (the clock's preflight needs the `message` executor registered, otherwise
 *     claims are refused as E_UNSUPPORTED). Idempotent per agent; attaching another agent shuts the
 *     previous scheduler down. Handlers also attach lazily from an event's ctx as a safety net.
 *   - `install.enqueueHandoff(input)` — A1's note path for `bg.handoff` results (`false` ⇒ fall back
 *     to a quiet result note). `install.statusSuffix()` feeds the status line (`· msg off|?`).
 */
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock } from "../../core/clock.js";
import type { WakeInputEvent } from "../../fabric/wake-input.js";
import type { FencePorts } from "../../fabric/xs/fence.js";
import { getXsHostCapability, type XsHostCapability } from "../../fabric/xs/host-cap.js";
import { getXsWakeLedger } from "../../fabric/xs/wake-ledger.js";
import {
  addPendingReport,
  findRun,
  finishRun,
  pendingReportFor,
  writeReportLocked,
  type GcCaps,
  type SessionStore,
} from "../core/writer.js";
import { isTerminalRunState, reportFileOf, SCHED_CUSTOM_TYPE, SCHED_REPORT_MAX_BYTES } from "../core/spec.js";
import type { RunRecord, ScheduleTask } from "../core/spec.js";
import {
  createMessageScheduler,
  createProcessOccupancy,
  createProcessRunRegistry,
  judgeScheduledContext,
  markOrphanRun,
  readScheduleTrigger,
  type SchedDiagnostics,
  type ScheduledRunRegistry,
  type HandoffInput,
  type MessageScheduler,
  type OccupancySlot,
  type SchedNoticeInfo,
  type SchedResultSink,
} from "./dispatch.js";
import { isEpochDisposed, type ScheduleAgent } from "./wire.js";
import type { ScheduleRefusal } from "./mode.js";

// ----------------------------------------------------------------- content

/** `2026-01-01 08:00` in the task's own tz (Intl; ISO fallback for an unusable tz). */
function localTime(ms: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

const whenLabel = (run: RunRecord, task: ScheduleTask): string =>
  run.kind === "manual" ? "立即运行" : localTime(run.scheduledAt, task.when.tz);

/** The wake message the main session receives (§6.2). The header is fixed so the model can recognise it. */
export function wakeContent(run: RunRecord, task: ScheduleTask): string {
  return [
    `[定时消息 ${task.name} · ${whenLabel(run, task)}]`,
    "这是一条按计划自动触发的消息，不是用户当面输入；请按下面的要求处理，最后一条回复会作为本次定时运行的结果。",
    "",
    task.prompt,
  ].join("\n");
}

/** UTF-8 safe prefix: never cuts a code point in half. */
function utf8Prefix(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

/** The report file body (≤ SCHED_REPORT_MAX_BYTES; truncation is marked). */
export function renderReport(task: ScheduleTask, run: RunRecord, text: string): Buffer {
  const body = text === "" ? "（本次运行没有文本输出）" : text;
  const full = Buffer.from(`# ${task.name} · ${whenLabel(run, task)}\n\n${body}\n`, "utf8");
  if (full.length <= SCHED_REPORT_MAX_BYTES) return full;
  const tail = Buffer.from("\n\n…（已截断）\n", "utf8");
  return Buffer.concat([utf8Prefix(full, SCHED_REPORT_MAX_BYTES - tail.length), tail]);
}

const NOTICE_TEXT: Record<SchedNoticeInfo["reason"], string> = {
  capability: "当前 pi 不提供定时消息所需的触发能力",
  "capability-unknown": "排队超过 30 分钟，仍未确认 pi 的触发能力（会话打开后还没有任何输入）",
};

/** `E_UNSUPPORTED` while the host trigger shape is KNOWN absent (unknown ⇒ allowed; it queues). */
export function messageFormRefusal(capability: XsHostCapability = getXsHostCapability()): ScheduleRefusal | undefined {
  return capability.state === "absent"
    ? { code: "E_UNSUPPORTED", detail: "当前 pi 不提供定时消息所需的触发能力，无法创建或修改定时消息任务 / 开启接手" }
    : undefined;
}

// ----------------------------------------------------------------- settled sink

export interface LedgerResultSinkDeps {
  store(): SessionStore | undefined;
  sessionId: string;
  now(): number;
  /** Test seam: report capacity (default S1's session caps). */
  caps?: GcCaps;
}

/**
 * `settled` terminal write. Feishu on ⇒ report file + `finishRun` + `pendingReports` in ONE
 * `writeReportLocked` commit (§4.2.1: no window where a report exists without its index entry or the
 * other way round); off ⇒ a plain terminal write. First terminal write wins: a run that already
 * ended is left untouched (and no report is written for it).
 */
export function createLedgerResultSink(deps: LedgerResultSinkDeps): SchedResultSink {
  return {
    async settled({ run, task, text, reason }) {
      const store = deps.store();
      if (store === undefined) return false;
      const snap = store.read();
      if (snap.kind === "ok") {
        const cur = findRun(snap.state, run.runKey);
        if (cur !== undefined && isTerminalRunState(cur.state)) return true; // already ended: nothing to record
      }
      const status = reason === undefined ? "settled" : `settled(${reason})`;
      if (!task.feishu) {
        const r = await store.transact((draft, ctx) => {
          const out = finishRun(draft, run.runKey, { state: "settled", ...(reason ? { reason } : {}) }, ctx.now);
          return { value: out, write: out === "ok" };
        });
        return r.ok;
      }
      const reportFile = reportFileOf(deps.sessionId, run.runKey);
      const r = await writeReportLocked(store, {
        reportFile,
        data: renderReport(task, run, text),
        now: deps.now(),
        ...(deps.caps !== undefined ? { caps: deps.caps } : {}),
        commit: (draft, ctx, written) => {
          const out = written
            ? finishRun(draft, run.runKey, { state: "settled", reportFile, ...(reason ? { reason } : {}) }, ctx.now)
            : finishRun(draft, run.runKey, { state: "settled", reason: "report-skipped(cap)" }, ctx.now);
          if (out === "ok" && written) {
            const rec = findRun(draft, run.runKey);
            if (rec !== undefined) addPendingReport(draft, pendingReportFor(deps.sessionId, rec, status), ctx.now);
          }
          return { value: out, write: out === "ok" };
        },
      });
      return r.ok;
    },
  };
}

// ----------------------------------------------------------------- install

interface UiPromptInfo {
  kind?: unknown;
  title?: unknown;
}
const uiInfo = (e: UiPromptInfo | undefined): { kind?: string; title?: string } => ({
  ...(typeof e?.kind === "string" ? { kind: e.kind } : {}),
  ...(typeof e?.title === "string" ? { title: e.title } : {}),
});

export interface ScheduleHolder {
  current?: { schedule?: ScheduleAgent | undefined } | undefined;
}

export interface MessageSchedulerInstallDeps {
  /** fence ports of the xs wiring: web resume exec / topic-switch / goal (late-bound getters). */
  fencePorts?: FencePorts;
  /** `holder.current.xs.controller.busy` — root wake in flight. */
  rootWakeBusy?: () => boolean;
  /** Default: xs wake ledger has an owner for this session. */
  xsWakeOwned?: (sessionId: string) => boolean;
  attributeInput?: () => ((text: string) => "web_prompt" | undefined) | undefined;
  /** Default: `ctx.ui.notify(message, "warning")`. */
  notify?: (message: string) => void;
  clock?: Clock;
  capability?: XsHostCapability;
  occupancy?: OccupancySlot;
  /** Process-level scheduled-run record (default: `Symbol.for` registry — shared with the guard). */
  registry?: ScheduledRunRegistry;
  /** `() => currentConnection()?.status().agentKey` — the hub's key for this session (sched_bound, §7.5). */
  agentKey?: () => string | undefined;
  newId?: () => string;
  warn?: (message: string) => void;
}

export interface MessageSchedulerInstall {
  attach(agent: ScheduleAgent, ctx: ExtensionContext): MessageScheduler | undefined;
  scheduler(agent?: ScheduleAgent): MessageScheduler | undefined;
  enqueueHandoff(input: HandoffInput): boolean;
  /** Revoke the queued message/handoff entries of a paused / deleted task (see `MessageScheduler.revokeTask`). */
  revokeTask(taskId: string): number;
  statusSuffix(): string;
  /** Why dispatch is idle right now (fence windows, ui prompts, stuck run); undefined without a scheduler. */
  diagnostics(): SchedDiagnostics | undefined;
  /**
   * LOCAL human reset of the scheduler's fence + ui-prompt balance. The integration must call this from
   * `/fabric fence reset` (the fence's own stuck warning points there) — web invocations stay refused upstream.
   */
  resetBlockers(): void;
}

interface Attached {
  agent: ScheduleAgent;
  sched: MessageScheduler;
  ctx: ExtensionContext;
}

export function installMessageScheduler(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  holder: ScheduleHolder,
  deps: MessageSchedulerInstallDeps = {},
): MessageSchedulerInstall {
  const clock = deps.clock ?? systemClock;
  const capability = deps.capability ?? getXsHostCapability();
  const occupancy = deps.occupancy ?? createProcessOccupancy(isEpochDisposed);
  const registry = deps.registry ?? createProcessRunRegistry();
  const newId = deps.newId ?? ((): string => randomBytes(8).toString("hex"));
  const warn = deps.warn ?? ((m: string): void => console.warn(`[pi-subagent] schedule: ${m}`));
  const attached = new WeakMap<ScheduleAgent, Attached>();
  let current: Attached | undefined;

  const attach = (agent: ScheduleAgent, ctx: ExtensionContext): MessageScheduler | undefined => {
    const known = attached.get(agent);
    if (known !== undefined) {
      known.ctx = ctx;
      return known.sched;
    }
    // Only an interactive stack with a process identity can ever execute (§3.3): no executor otherwise.
    if (!agent.mode.arm || agent.holder === undefined || agent.sessionId === undefined) return undefined;
    const sessionId = agent.sessionId;
    const slot: Attached = { agent, ctx, sched: undefined as never };
    const sched = createMessageScheduler({
      sessionId,
      holder: agent.holder,
      store: () => agent.store(),
      gate: (task) => agent.gate(task),
      isDisposed: () => agent.isDisposed(),
      changed: () => agent.changed(),
      host: {
        isIdle: () => slot.ctx.isIdle(),
        hasPendingMessages: () => slot.ctx.hasPendingMessages(),
        sendMessage: (message, options) => pi.sendMessage(message, options),
        abort: () => slot.ctx.abort(),
      },
      results: createLedgerResultSink({ store: () => agent.store(), sessionId, now: () => clock.now() }),
      contentFor: wakeContent,
      notice: (info) => {
        // Quiet (never a trigger): only for capability drops, which happen in the owning session.
        try {
          pi.sendMessage(
            {
              customType: SCHED_CUSTOM_TYPE,
              content: `[定时消息 ${info.task.name}] 未执行：${NOTICE_TEXT[info.reason]}。`,
              display: true,
              details: { kind: "result", runKey: info.run.runKey, noteId: newId() },
            },
            { triggerTurn: false },
          );
        } catch (err) {
          warn(`notice failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      notify: (message) => {
        if (deps.notify !== undefined) deps.notify(message);
        else slot.ctx.ui.notify(message, "warning");
      },
      clock,
      capability,
      occupancy,
      registry,
      epochDisposed: isEpochDisposed,
      onBound: (runKey) => {
        // §7.5: sent synchronously on the ordered hub socket; Null / no-cap coordinators no-op.
        const key = deps.agentKey?.();
        if (key !== undefined) agent.coordinator.bound(key, runKey);
      },
      newId,
      warn,
      rootWakeBusy: () => deps.rootWakeBusy?.() === true,
      xsWakeOwned: () =>
        deps.xsWakeOwned !== undefined ? deps.xsWakeOwned(sessionId) : getXsWakeLedger().hasOwner(sessionId),
      ...(deps.fencePorts !== undefined ? { fencePorts: deps.fencePorts } : {}),
      ...(deps.attributeInput !== undefined ? { attributeInput: deps.attributeInput } : {}),
    });
    slot.sched = sched;
    attached.set(agent, slot);
    if (current !== undefined && current.agent !== agent) current.sched.shutdown();
    current = slot;
    agent.setExecutor("message", { dispatch: (run, task) => sched.enqueue(run, task) });
    return sched;
  };

  /** The live scheduler for the current stack (attaching lazily from the event's ctx). */
  const live = (ctx: ExtensionContext | undefined): Attached | undefined => {
    const agent = holder.current?.schedule;
    if (agent === undefined) return undefined;
    let slot = attached.get(agent);
    if (slot === undefined && ctx !== undefined && !agent.isDisposed()) {
      attach(agent, ctx);
      slot = attached.get(agent);
    }
    if (slot !== undefined && ctx !== undefined) slot.ctx = ctx;
    return slot;
  };

  /** No scheduler for this stack (pre-stack window, print/child agent, post-/reload gap, feature off): nobody
   *  can prove a wake token ⇒ abort it before its first main request and record the run as void. */
  const guardBeforeAgentStart = (event: unknown, ctx: ExtensionContext): void => {
    capability.observe(event);
    const trigger = readScheduleTrigger(event);
    if (trigger.kind !== "wake") {
      registry.clear();
      return;
    }
    markOrphanRun(registry, trigger.token);
    ctx.abort();
  };
  /** Per model call without a scheduler: a void / expired / epoch-disposed scheduled run is refused. */
  const guardContext = (ctx: ExtensionContext): void => {
    if (judgeScheduledContext(registry, clock.now(), isEpochDisposed) === "abort") ctx.abort();
  };

  const guarded =
    <E>(fn: (event: E, ctx: ExtensionContext) => void) =>
    (event: E, ctx: ExtensionContext): undefined => {
      try {
        fn(event, ctx);
      } catch (err) {
        warn(`event handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    };

  const on = pi.on.bind(pi) as unknown as (name: string, handler: (event: never, ctx: never) => unknown) => void;
  const reg = <E>(name: string, fn: (event: E, ctx: ExtensionContext) => void): void =>
    on(name, guarded(fn) as unknown as (event: never, ctx: never) => unknown);

  reg<unknown>("before_agent_start", (event, ctx) => {
    const slot = live(ctx);
    if (slot !== undefined) {
      slot.sched.onBeforeAgentStart(event);
      return;
    }
    // No scheduler for this stack (pre-stack window, print/child agent, post-/reload gap): nobody can
    // prove a wake token ⇒ abort it before its first provider request. Shape evidence still counts.
    guardBeforeAgentStart(event, ctx);
  });
  reg<unknown>("context", (_event, ctx) => {
    const slot = live(ctx);
    if (slot !== undefined) slot.sched.onContext();
    else guardContext(ctx);
  });
  reg<{ message?: unknown }>("message_start", (event, ctx) => live(ctx)?.sched.onMessageStart(event.message));
  reg<{ message?: unknown }>("message_end", (event, ctx) => live(ctx)?.sched.onMessageEnd(event.message));
  reg<unknown>("agent_start", (_event, ctx) => live(ctx)?.sched.onAgentStart());
  reg<{ aborted?: boolean }>("agent_settled", (event, ctx) => {
    const slot = live(ctx);
    if (slot !== undefined) slot.sched.onAgentSettled({ aborted: event.aborted === true });
    else registry.clear();
  });
  reg<WakeInputEvent>("input", (event, ctx) => live(ctx)?.sched.onInput({ text: event.text, source: event.source }));
  reg<UiPromptInfo>("ui_prompt_start", (event, ctx) => live(ctx)?.sched.onUiPrompt(true, uiInfo(event)));
  reg<UiPromptInfo>("ui_prompt_end", (event, ctx) => live(ctx)?.sched.onUiPrompt(false, uiInfo(event)));
  for (const type of [
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
    "session_before_tree",
    "session_tree",
    "session_before_switch",
    "session_before_fork",
    "session_start",
  ] as const)
    reg<unknown>(type, (_event, ctx) => live(ctx)?.sched.onFenceEvent({ type }));
  reg<unknown>("session_shutdown", () => {
    // The session is going away: whatever scheduler is attached ends with it.
    current?.sched.onFenceEvent({ type: "session_shutdown" });
    current?.sched.shutdown();
    current = undefined;
  });

  return {
    attach,
    scheduler: (agent) => (agent !== undefined ? attached.get(agent) : live(undefined))?.sched,
    enqueueHandoff: (input) => live(undefined)?.sched.enqueueHandoff(input) ?? false,
    revokeTask: (taskId) => live(undefined)?.sched.revokeTask(taskId) ?? 0,
    statusSuffix: () => live(undefined)?.sched.statusSuffix() ?? "",
    diagnostics: () => live(undefined)?.sched.diagnostics(),
    resetBlockers: () => live(undefined)?.sched.resetBlockers(),
  };
}

/**
 * The minimal guard for when `schedule.enabled` is OFF (or any activation that does not run the full
 * installer): after a `/reload` that switched the feature off, a trigger that was already pending still
 * arrives — it is aborted before its first main request, and a run still carrying a void / expired /
 * epoch-disposed scheduled-run record is refused at every model call. Never install it together with
 * `installMessageScheduler` (that one already contains these handlers).
 */
export function installScheduleOrphanGuard(
  pi: Pick<ExtensionAPI, "on">,
  deps: Pick<MessageSchedulerInstallDeps, "capability" | "clock" | "registry" | "warn"> = {},
): void {
  const clock = deps.clock ?? systemClock;
  const capability = deps.capability ?? getXsHostCapability();
  const registry = deps.registry ?? createProcessRunRegistry();
  const warn = deps.warn ?? ((m: string): void => console.warn(`[pi-subagent] schedule: ${m}`));
  const on = pi.on.bind(pi) as unknown as (name: string, handler: (event: never, ctx: never) => unknown) => void;
  const safe =
    (fn: (event: unknown, ctx: ExtensionContext) => void) =>
    (event: unknown, ctx: ExtensionContext): undefined => {
      try {
        fn(event, ctx);
      } catch (err) {
        warn(`guard failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return undefined;
    };
  on(
    "before_agent_start",
    safe((event, ctx) => {
      capability.observe(event);
      const trigger = readScheduleTrigger(event);
      if (trigger.kind !== "wake") {
        registry.clear();
        return;
      }
      markOrphanRun(registry, trigger.token);
      ctx.abort();
    }) as never,
  );
  on(
    "context",
    safe((_event, ctx) => {
      if (judgeScheduledContext(registry, clock.now(), isEpochDisposed) === "abort") ctx.abort();
    }) as never,
  );
  on("agent_settled", safe(() => registry.clear()) as never);
}
