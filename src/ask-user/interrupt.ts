/**
 * P1 (ask-user-async plan §5): the background-interrupt coordinator — pi-free mechanics.
 *
 * Contents:
 *  - `InteractionOutcome` (§5.1): the discriminated union both interaction runners return.
 *  - `BackgroundInterruptSettings` + `normalizeInterruptSettings` (§5.2.1): per-field
 *    validation with fallback-to-default (non-number / NaN / non-finite / non-integer /
 *    out-of-range all fall back per field, never throw). Kept dependency-free so P2's
 *    src/config/settings.ts can import it without pulling anything else in.
 *  - `Clock` (testing seam; the real clock unref()s every timer so `pi -p` never wedges).
 *  - `InterruptCoordinator` (§5.2.2–§5.2.4): fixed merge window, quiet period, re-ask dwell,
 *    per-question interrupt budget, in-dialog notices.
 *  - The result/notice/reminder text builders (§6.2, §5.2.5, §6.4) — model-facing prose is
 *    pinned verbatim by tests.
 */
import type { AskUserBackgroundPort, BackgroundCompletion, BackgroundCompletionKind } from "./background.js";
import type { DraftSnapshot, InterruptInfo, Result } from "./types.js";

// ---------------------------------------------------------------------------
// §5.1 interaction outcome protocol
// ---------------------------------------------------------------------------

export type InteractionOutcome =
  | { kind: "answered"; by: "tui" | "web"; result: Result }
  | { kind: "cancelled"; by: "tui" | "web" }
  | { kind: "aborted" }
  | { kind: "interrupted"; info: InterruptInfo; draft?: DraftSnapshot }
  | { kind: "deferred"; info: InterruptInfo };

// ---------------------------------------------------------------------------
// §5.2.1 settings
// ---------------------------------------------------------------------------

export interface BackgroundInterruptSettings {
  enabled: boolean;
  /** Merge window: first completion → earliest interrupt (ms). */
  delayMs: number;
  /** Quiet period after the last keystroke before an interrupt may land (ms). */
  quietMs: number;
  /** Activity-based postponement cap, counted from windowFire (ms). 0 = never postpone. */
  maxDeferMs: number;
  /** Dwell time after a re-asked dialog mounts before it may be interrupted (ms). */
  reaskDwellMs: number;
  /** Per-question interrupt budget; once reached the dialog blocks like today (§5.2.4). */
  maxPerQuestion: number;
  /** RPC mode opt-in (§7.1): false = RPC path byte-identical to today, no interrupt. */
  rpc: boolean;
}

export const DEFAULT_INTERRUPT_SETTINGS: BackgroundInterruptSettings = {
  enabled: true,
  delayMs: 1_000,
  quietMs: 4_000,
  maxDeferMs: 20_000,
  reaskDwellMs: 10_000,
  maxPerQuestion: 3,
  rpc: false,
};

/** §5.4: per-question cap on pre-open deferrals. */
export const DEFER_CAP = 3;

function parseMsField(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < min || raw > max)
    return fallback;
  return raw;
}

/** Field-wise parse (§5.2.1): invalid fields fall back to their default independently. */
export function normalizeInterruptSettings(raw: unknown): BackgroundInterruptSettings {
  const record = (raw ?? {}) as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : DEFAULT_INTERRUPT_SETTINGS.enabled;
  const rpc = typeof record.rpc === "boolean" ? record.rpc : DEFAULT_INTERRUPT_SETTINGS.rpc;
  const delayMs = parseMsField(record.delayMs, DEFAULT_INTERRUPT_SETTINGS.delayMs, 0, 10_000);
  const quietMs = parseMsField(record.quietMs, DEFAULT_INTERRUPT_SETTINGS.quietMs, 0, 30_000);
  let maxDeferMs = parseMsField(record.maxDeferMs, DEFAULT_INTERRUPT_SETTINGS.maxDeferMs, 0, 120_000);
  const reaskDwellMs = parseMsField(record.reaskDwellMs, DEFAULT_INTERRUPT_SETTINGS.reaskDwellMs, 0, 60_000);
  const maxPerQuestion = parseMsField(record.maxPerQuestion, DEFAULT_INTERRUPT_SETTINGS.maxPerQuestion, 1, 10);
  // §5.2.1: maxDefer >= quiet, otherwise clamp UP to quiet. 0 is exempt — it means
  // "never postpone for activity" and clamping would silently turn protection back on.
  if (maxDeferMs !== 0 && maxDeferMs < quietMs) maxDeferMs = quietMs;
  return { enabled, delayMs, quietMs, maxDeferMs, reaskDwellMs, maxPerQuestion, rpc };
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  schedule(fn: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** Real timers, always unref'd (a ref'd timer wedges `pi -p`; ask_user only runs in tui/rpc
 *  but the extension module is shared). */
export const realClock: Clock = {
  now: () => Date.now(),
  schedule(fn, delayMs) {
    const handle = setTimeout(fn, delayMs) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as never);
  },
};

// ---------------------------------------------------------------------------
// §5.2.2 due computation
// ---------------------------------------------------------------------------

/**
 * The interrupt deadline for one pending ask (plan §5.2.2):
 *   dwellDue = isReask ? mountedAt + reaskDwellMs : 0
 *   quietDue = lastActivityAt === undefined ? 0 : min(lastActivityAt + quietMs, windowFire + maxDeferMs)
 *   due      = max(windowFire, dwellDue, quietDue)
 * Priority: dwell > quiet (capped by maxDefer) > merge window. A queued (never shown) ask has
 * neither activity nor mount time, so its due is exactly windowFire.
 */
export function computeDue(args: {
  windowFire: number;
  mountedAt: number | undefined;
  isReask: boolean;
  lastActivityAt: number | undefined;
  reaskDwellMs: number;
  quietMs: number;
  maxDeferMs: number;
}): number {
  const dwellDue = args.isReask && args.mountedAt !== undefined ? args.mountedAt + args.reaskDwellMs : 0;
  const quietDue =
    args.lastActivityAt === undefined
      ? 0
      : Math.min(args.lastActivityAt + args.quietMs, args.windowFire + args.maxDeferMs);
  return Math.max(args.windowFire, dwellDue, quietDue);
}

// ---------------------------------------------------------------------------
// coordinator
// ---------------------------------------------------------------------------

export interface CompletionSummary {
  kind: BackgroundCompletionKind;
  count: number;
}

const KIND_ORDER: BackgroundCompletionKind[] = ["subagent", "workflow", "bash"];

/** Aggregate the merge window's completions into a stable-ordered summary. */
export function aggregateCompletions(byKind: ReadonlyMap<BackgroundCompletionKind, number>): CompletionSummary[] {
  const out: CompletionSummary[] = [];
  for (const kind of KIND_ORDER) {
    const count = byKind.get(kind) ?? 0;
    if (count > 0) out.push({ kind, count });
  }
  return out;
}

/** One pending ask_user as seen by the coordinator. Implemented per interaction in index.ts. */
export interface CoordinatorAsk {
  /** false once the race has any winner (settled or settling). */
  active(): boolean;
  /** Max per-question interrupt count over this call's fingerprints (budget check). */
  budgetUsed(): number;
  lastActivityAt(): number | undefined;
  mountedAt(): number | undefined;
  isReask(): boolean;
  /** In-dialog notice; no-op for asks without a live component (queued / RPC). */
  setNotice(text: string | undefined): void;
  /** Claim the race as "background" and cancel the local interaction. */
  interrupt(summary: CompletionSummary[]): void;
}

/**
 * §5.2.2–§5.2.4. One coordinator per activate; asks register on enqueue and unregister on
 * settle. One window at a time; one timer per ask at most. The port is subscribed only while
 * at least one ask is registered (R2: no leftover subscriptions/timers after settle).
 */
export class InterruptCoordinator {
  private readonly asks = new Set<CoordinatorAsk>();
  private unsubscribe: (() => void) | undefined;
  private windowArmed = false;
  private windowFire = 0;
  private readonly completions = new Map<BackgroundCompletionKind, number>();
  private readonly timers = new Map<CoordinatorAsk, unknown>();
  private disposed = false;

  constructor(
    private readonly deps: {
      port(): AskUserBackgroundPort | undefined;
      settings(): BackgroundInterruptSettings;
      clock: Clock;
    },
  ) {}

  register(ask: CoordinatorAsk): void {
    if (this.disposed) return;
    this.asks.add(ask);
    if (!this.deps.settings().enabled) return;
    this.ensureSubscription();
    // Completions may have accumulated while no interruptible ask existed (e.g. all previous
    // asks were budget-exhausted): the window arms at the first moment a completion AND an
    // interruptible pending ask coexist (§5.2.1 delayMs 起算点).
    this.armWindowIfPossible();
    if (this.windowArmed || this.totalCount() > 0) this.evaluate(ask);
  }

  unregister(ask: CoordinatorAsk): void {
    if (!this.asks.delete(ask)) return;
    this.clearTimer(ask);
    if (this.asks.size === 0) {
      // §5.2.3: window state clears once every pending ask has settled.
      this.windowArmed = false;
      this.completions.clear();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const ask of [...this.timers.keys()]) this.clearTimer(ask);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.asks.clear();
    this.completions.clear();
    this.windowArmed = false;
  }

  private totalCount(): number {
    let total = 0;
    for (const count of this.completions.values()) total += count;
    return total;
  }

  private ensureSubscription(): void {
    if (this.unsubscribe !== undefined || this.disposed) return;
    const port = this.deps.port();
    if (port === undefined || port.disabled) return;
    this.unsubscribe = port.subscribe((event) => this.onCompletion(event));
  }

  private onCompletion(event: BackgroundCompletion): void {
    if (this.disposed) return;
    const settings = this.deps.settings();
    const port = this.deps.port();
    if (!settings.enabled || port === undefined || port.disabled) return;
    this.completions.set(event.kind, (this.completions.get(event.kind) ?? 0) + event.count);
    this.armWindowIfPossible();
    for (const ask of this.asks) this.evaluate(ask);
  }

  private armWindowIfPossible(): void {
    if (this.windowArmed || this.completions.size === 0) return;
    const settings = this.deps.settings();
    const interruptible = [...this.asks].some((ask) => ask.active() && ask.budgetUsed() < settings.maxPerQuestion);
    if (!interruptible) return;
    this.windowFire = this.deps.clock.now() + settings.delayMs;
    this.windowArmed = true;
  }

  private evaluate(ask: CoordinatorAsk): void {
    this.clearTimer(ask);
    if (!ask.active()) return;
    const count = this.totalCount();
    if (count === 0) return;
    const settings = this.deps.settings();
    if (ask.budgetUsed() >= settings.maxPerQuestion) {
      // §5.2.4 accepted degradation: block like today, but say so inside the dialog.
      ask.setNotice(exhaustedNoticeText(count));
      return;
    }
    if (!this.windowArmed) return;
    const now = this.deps.clock.now();
    const due = computeDue({
      windowFire: this.windowFire,
      mountedAt: ask.mountedAt(),
      isReask: ask.isReask(),
      lastActivityAt: ask.lastActivityAt(),
      reaskDwellMs: settings.reaskDwellMs,
      quietMs: settings.quietMs,
      maxDeferMs: settings.maxDeferMs,
    });
    if (now >= due) {
      // Never interrupt synchronously inside the completion callback: even a due of "right
      // now" lands on the next macrotask (§5.2.1 delayMs=0 semantics) so the interrupt can
      // never reenter the port listener or a register() call mid-flight.
      const summary = aggregateCompletions(this.completions);
      this.timers.set(
        ask,
        this.deps.clock.schedule(() => {
          this.timers.delete(ask);
          if (this.disposed || !ask.active()) return;
          ask.interrupt(summary);
        }, 0),
      );
      return;
    }
    ask.setNotice(pauseNoticeText(count));
    this.timers.set(
      ask,
      this.deps.clock.schedule(() => this.evaluate(ask), due - now),
    );
  }

  private clearTimer(ask: CoordinatorAsk): void {
    const handle = this.timers.get(ask);
    if (handle !== undefined) {
      this.deps.clock.cancel(handle);
      this.timers.delete(ask);
    }
  }
}

// ---------------------------------------------------------------------------
// text builders (§6.2, §5.2.5, §6.4) — pinned verbatim by tests
// ---------------------------------------------------------------------------

function summaryText(completions: CompletionSummary[]): string {
  const total = completions.reduce((sum, completion) => sum + completion.count, 0);
  const parts = completions.map((completion) => `${completion.count} ${completion.kind}`).join(", ");
  return `${total} background task${total === 1 ? "" : "s"} (${parts})`;
}

/** §6.2 background-interrupted tool result text (model-facing). */
export function interruptedResultText(completions: CompletionSummary[], attempt: number, limit: number): string {
  return (
    `ask_user was interrupted before the user answered: ${summaryText(completions)} finished in the background ` +
    `and the completion notice(s) arrive right after this result. The question(s) are NOT answered — do not ` +
    `assume an answer and do not answer on the user's behalf. First handle the notice(s); if the decision is ` +
    `still needed, call ask_user again with the same questions (the user's partial input is restored). If the ` +
    `background result already settles the question, proceed and say so explicitly. [interrupt ${attempt}/${limit}]`
  );
}

/** §6.2 deferred tool result text (model-facing). */
export function deferredResultText(pendingNotices: number): string {
  return (
    `ask_user was not shown yet: ${pendingNotices} background completion notice(s) are queued and will arrive ` +
    `next. Do not assume an answer. Read them, then call ask_user again with the same questions if the ` +
    `decision is still needed.`
  );
}

/** §5.2.5 in-dialog notice while the interrupt is waiting to land (English inline token). */
export function pauseNoticeText(count: number): string {
  return `⏸ ${count} bg done · pausing when idle`;
}

/** §5.2.5 in-dialog notice once the per-question budget is exhausted. */
export function exhaustedNoticeText(count: number): string {
  return `⏸ ${count} bg done · answer to continue`;
}

/** §5.2.5 first dialog line when a re-ask restored a draft. */
export const RESUMED_MARKER = "resumed · draft restored";

/** §6.2 renderResult line for an interrupted/deferred result. */
export const INTERRUPTED_RENDER_TEXT = "⏸ paused · bg done · will re-ask";

/** §4.4 status-bar text (English inline token). */
export function parkedStatusText(count: number): string {
  return `ask⏸${count}`;
}

/** §4.4 agent_settled notify (Chinese prose; lists the parked question headers). */
export function parkedNotifyText(items: readonly { header?: string | undefined; question: string }[]): string {
  const list = items.map((item) => item.header ?? item.question.slice(0, 24)).join("、");
  return (
    `有 ${items.length} 个提问因后台任务完成被暂挂，本轮结束前未重新询问：${list}。` +
    `如仍需用户决策，请重新调用 ask_user（用户此前的部分输入已恢复）。`
  );
}

/** §6.4 post-compact reminder message content (model-facing; triggerTurn:false). */
export function parkedReminderText(items: readonly { header?: string | undefined; question: string }[]): string {
  const lines = items.map(
    (item, index) => `${index + 1}. ${item.header !== undefined ? `${item.header}: ` : ""}${item.question}`,
  );
  return (
    `[ask_user] ${items.length} question(s) were paused by background completion(s) and are still unanswered:\n` +
    `${lines.join("\n")}\n` +
    `If the decision is still needed, call ask_user again with the same questions (the user's partial input ` +
    `is restored); if a background result already settled a question, proceed without asking and say so.`
  );
}
