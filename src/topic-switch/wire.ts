/**
 * topic-switch · pi-facing assembly (plan.md "P3b — pi-facing 装配").
 *
 * The single `wireTopicSwitch()` entry point owns every piece of mutable state for this
 * feature (no module-scope state — rebuilt fresh on every `activate()`, and real pi genuinely
 * re-activates extensions on every session replacement too, not just `/reload` — confirmed by
 * `tests/conformance/topic-switch-runtime-harness.ts`'s gen1/gen2 probe): the hold runtime, the
 * nonce table, the skip counters, the echo/barrier trackers, and the last-known `ExtensionContext`.
 * The `TransferLike` map kept under the process-global `Symbol.for("pi-subagent:topic-switch-
 * transfer")` key (I5 — the same cap/TTL/FIFO precedent as `src/extensions/worktree-origin.ts`)
 * survives a `/reload` ONLY (in-process memory, wiped on a real crash/restart); crash recovery
 * instead relies on the persisted `pending` session-entry record (`planRecovery`'s rule 4) that
 * `persistPending` writes to disk alongside the transfer.
 *
 * S0 fallback ladder (plan.md §1, pinned here per its own instruction): S1/S2 ("`ctx.newSession`
 * from a command" / "`rctx.sendUserMessage` after a switch") were CONFIRMED on real pi by
 * `tests/conformance/topic-switch-hop.test.ts` — the hop-via-command path below (`command.ts`'s
 * `__go`) is the primary path, not a fallback. S3/S4 (slash-command trampolines never reach
 * `input` handlers; a `followUp` re-injection always gets exactly one `input` event) were also
 * CONFIRMED — the hop message is sent with `expandPromptTemplates:true` and release-queue content
 * is always sent with `deliverAs:"followUp"`, matching the confirmed shapes. No code-level
 * fallback was needed for any of S1–S9; see `tests/conformance/topic-switch-hop.test.ts` for the
 * probe assertions themselves.
 */
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AskUserRemotePort } from "../ask-user/remote.js";
import type { CacheWarmthPort } from "../cache-ttl/cache-ttl.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { PromptGatePort, WebPromptRelease } from "../web-hub/agent/prompt-gate.js";
import { buildConfirmText, confirmSwitch, type ConfirmCtx } from "./confirm.js";
import { evaluateSyncGates, type PricedEstimate } from "./gate.js";
import { buildBranchView, clearWatchdog, fullPayload, type HoldRuntime } from "./hold.js";
import {
  JUDGE_MAX_TOKENS,
  JUDGE_REASONING,
  judgeModelChain,
  judgeWithFailover,
  type JudgeAttempt,
  type JudgeFailoverResult,
  type JudgeInput,
} from "./judge.js";
import { createReleaseQueue } from "./release.js";
import { runRecovery } from "./recovery.js";
import { createTopicSwitchCommand, type TopicSwitchCommandDeps } from "./command.js";
import { ENTRY_TYPE, makePayload, parseRecord } from "./records.js";
import type { TopicSwitchSettings } from "./settings.js";
import { cooldownActive, initialHoldState, stepHold, type HoldEffect, type HoldEvent } from "./state.js";
import type {
  EntryLike,
  GateFacts,
  ImageLike,
  Outcome,
  ShutdownReason,
  SkipReason,
  StartReason,
  TransferLike,
  TransferState,
} from "./types.js";

export interface TopicSwitchDeps {
  settings(): TopicSwitchSettings;
  titleModel: string;
  warmth: CacheWarmthPort;
  stack(): { activeRuns(): number; backgroundBash(): number; goalBusy(): boolean } | undefined;
  remote(): AskUserRemotePort | undefined;
  clock?: Clock;
}

export interface TopicSwitchWiring {
  readonly webGate: PromptGatePort;
}

const TRANSFER_KEY = Symbol.for("pi-subagent:topic-switch-transfer");
const TRANSFER_CAP = 4;
const TRANSFER_TTL_MS = 10 * 60_000;
const BARRIER_MS = 2_000;
const COMPACT_WAIT_MS = 120_000;
const HOP_TIMEOUT_MS = 5_000;
const PONR_WATCHDOG_MS = 30_000;

interface TransferGlobal {
  entries: Map<string, TransferLike>;
  order: string[];
  /** B1: holdIds currently mid-switch (between `onPonr` and the switch's resolution). Recovery
   *  (`pickTransferForRecovery`) ignores any transfer whose holdId is in this set — real pi's
   *  event order (`session_shutdown(new) → session_start(new) → withSession`, confirmed by S1)
   *  means a brand-new activation's `session_start` ALWAYS runs while the transfer is still
   *  `"pending"`, strictly before `withSession`'s own CAS moves it to `"delivering"` — without this
   *  exclusion recovery would deterministically (not just racily) stage the held text back into
   *  the NEW session's editor with a false "未能送达" warning on every successful switch. */
  inFlight: Set<string>;
}

function transferGlobal(): TransferGlobal {
  const g = globalThis as Record<symbol, unknown>;
  let store = g[TRANSFER_KEY] as TransferGlobal | undefined;
  if (store === undefined) {
    store = { entries: new Map(), order: [], inFlight: new Set() };
    g[TRANSFER_KEY] = store;
  } else if (store.inFlight === undefined) {
    // Defensive: a store built by an older process/activation before this field existed.
    store.inFlight = new Set();
  }
  return store;
}

function pruneTransfers(now: number): void {
  const store = transferGlobal();
  for (const id of [...store.order]) {
    const entry = store.entries.get(id);
    if (entry === undefined || now - entry.at > TRANSFER_TTL_MS) {
      store.entries.delete(id);
      store.order = store.order.filter((x) => x !== id);
      store.inFlight.delete(id);
    }
  }
}

function setTransfer(entry: TransferLike): void {
  const store = transferGlobal();
  pruneTransfers(Date.now());
  if (!store.entries.has(entry.holdId)) {
    store.order.push(entry.holdId);
    while (store.order.length > TRANSFER_CAP) {
      const evicted = store.order.shift();
      if (evicted !== undefined) {
        store.entries.delete(evicted);
        store.inFlight.delete(evicted);
      }
    }
  }
  store.entries.set(entry.holdId, entry);
}

function casTransfer(holdId: string, from: readonly TransferState[], to: TransferState): boolean {
  const store = transferGlobal();
  const entry = store.entries.get(holdId);
  if (entry === undefined || !from.includes(entry.state)) return false;
  store.entries.set(holdId, { ...entry, state: to });
  return true;
}

/** B1: marks `holdId` mid-switch — called once, right before `ctx.newSession(...)` (inside
 *  `onPonr`). Must be cleared (`clearInFlight`) in every exit path of the PONR command, which
 *  `command.ts` does via `onSwitchEntered`/`onSwitchCancelled`/its own direct dep call. */
function markInFlight(holdId: string): void {
  transferGlobal().inFlight.add(holdId);
}

function clearInFlight(holdId: string): void {
  transferGlobal().inFlight.delete(holdId);
}

function pickTransferForRecovery(sessionId: string, reason: StartReason): TransferLike | undefined {
  pruneTransfers(Date.now());
  const store = transferGlobal();
  if (reason === "reload") {
    for (let i = store.order.length - 1; i >= 0; i -= 1) {
      const id = store.order[i]!;
      if (store.inFlight.has(id)) continue;
      const entry = store.entries.get(id);
      if (entry !== undefined && entry.state === "pending" && entry.fromSessionId === sessionId) return entry;
    }
  }
  for (let i = store.order.length - 1; i >= 0; i -= 1) {
    const id = store.order[i]!;
    if (store.inFlight.has(id)) continue;
    const entry = store.entries.get(id);
    if (entry !== undefined && entry.state === "pending") return entry;
  }
  return undefined;
}

function pickTransferForLast(sessionId: string): TransferLike | undefined {
  pruneTransfers(Date.now());
  const store = transferGlobal();
  for (let i = store.order.length - 1; i >= 0; i -= 1) {
    const entry = store.entries.get(store.order[i]!);
    if (entry !== undefined && entry.fromSessionId === sessionId) return entry;
  }
  for (let i = store.order.length - 1; i >= 0; i -= 1) {
    const entry = store.entries.get(store.order[i]!);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

function toImageLikes(images: ImageContent[] | undefined): ImageLike[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

function assistantMessageText(message: AssistantMessage): string {
  if (message.errorMessage) throw new Error(message.errorMessage);
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  if (!text.trim()) throw new Error("topic-switch judge: empty reply");
  return text;
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Followup fix (timeout-policy-persistence.test.ts R1 regression report): `buildInputGateFacts`/
 * `buildWebGateFacts` used to read several EAGER (non-thunk) `ExtensionContext` fields
 * (`ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.getContextUsage()`) directly, outside
 * `gate.ts`'s own try/catch (which only wraps `evaluateSyncGates`'s body, i.e. the lazy thunks).
 * A minimal/partial ctx missing one of those methods (several existing integration-test harnesses
 * across the repo construct exactly such a ctx for events this feature was never meant to react
 * to) made the WHOLE facts object construction throw, forcing the input handler all the way out
 * to its outermost try/catch — "continue" either way, but via an exception unwind instead of a
 * clean gate rejection. `safeOr` makes every eager read tolerant with a fail-open-biased fallback
 * (never a value that could let an uncertain ctx pass a gate it shouldn't), so a message that
 * fails/can't-be-evaluated by the sync gates returns `continue` with zero exceptions, zero side
 * effects and zero delay — not just zero OBSERVABLE side effects once caught.
 */
function safeOr<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function wireTopicSwitch(pi: ExtensionAPI, deps: TopicSwitchDeps): TopicSwitchWiring {
  const activationId = randomUUID();
  const clock: Clock = deps.clock ?? systemClock;
  let seq = 0;
  let live = true;
  let shutdownSeq = 0;
  let currentHold: HoldRuntime | undefined;
  let compacting = false;
  let draining = false;
  let sawExtensionEcho = false;
  let sawAgentStart = false;
  let barrierWaiters: Array<() => void> = [];
  let compactWaiters: Array<() => void> = [];
  const nonces = new Map<string, { hold: HoldRuntime; timer: TimerHandle }>();
  const skipCounts: Partial<Record<SkipReason, number>> = {};
  // Judge diagnostics for `/topic-switch status`: which model answered the last judgment +
  // bounded per-model failure counts (model strings only — no paths, no secrets).
  const judgeDiag: { answered: string | undefined; failures: Map<string, number> } = {
    answered: undefined,
    failures: new Map(),
  };
  const ctxRef: { current?: ExtensionContext } = {};

  function noteSkip(reason: SkipReason): void {
    skipCounts[reason] = (skipCounts[reason] ?? 0) + 1;
  }

  function setStatus(text: string | undefined): void {
    try {
      ctxRef.current?.ui.setStatus("topic-switch", text);
    } catch {
      /* best-effort */
    }
  }

  function resolveCompactWaiters(): void {
    const waiters = compactWaiters;
    compactWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitCompactSettled(timeoutMs: number): Promise<void> {
    if (!compacting) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let timer: TimerHandle | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) {
          try {
            clock.clearTimer(timer);
          } catch {
            /* best-effort */
          }
        }
        const idx = compactWaiters.indexOf(finish);
        if (idx >= 0) compactWaiters.splice(idx, 1);
        resolve();
      };
      compactWaiters.push(finish);
      timer = clock.setTimer(timeoutMs, finish);
    });
  }

  function barrierCheck(): void {
    const ctx = ctxRef.current;
    const streamingPending = ctx !== undefined && safe(() => !ctx.isIdle() && ctx.hasPendingMessages()) === true;
    const pendingSignal = sawAgentStart || streamingPending;
    if (sawExtensionEcho && pendingSignal) {
      const waiters = barrierWaiters;
      barrierWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function waitBarrier(timeoutMs: number): Promise<void> {
    sawExtensionEcho = false;
    sawAgentStart = false;
    return new Promise((resolve) => {
      let done = false;
      let timer: TimerHandle | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) {
          try {
            clock.clearTimer(timer);
          } catch {
            /* best-effort */
          }
        }
        const idx = barrierWaiters.indexOf(finish);
        if (idx >= 0) barrierWaiters.splice(idx, 1);
        resolve();
      };
      barrierWaiters.push(finish);
      timer = clock.setTimer(timeoutMs, finish);
    });
  }

  function feed(hold: HoldRuntime, event: HoldEvent): void {
    if (!live || currentHold !== hold) return;
    const { s, fx } = stepHold(hold.state, event, deps.settings().minConfidence);
    hold.state = s;
    for (const effect of fx) applyEffect(hold, effect);
    if (s.phase === "done" && currentHold === hold) currentHold = undefined;
  }

  function applyEffect(hold: HoldRuntime, effect: HoldEffect): void {
    switch (effect.e) {
      case "confirm":
        setStatus("topic confirm…");
        runConfirm(hold);
        return;
      case "hop":
        runHop(hold);
        return;
      case "cancel-async": {
        try {
          hold.abort.abort();
        } catch {
          /* best-effort */
        }
        clearWatchdog(hold, clock);
        if (hold.nonce !== undefined) {
          const entry = nonces.get(hold.nonce);
          if (entry !== undefined) {
            try {
              clock.clearTimer(entry.timer);
            } catch {
              /* best-effort */
            }
            nonces.delete(hold.nonce);
          }
        }
        return;
      }
      case "release":
        enqueueHeld(hold);
        return;
      case "persist-pending":
        persistPending(hold, effect.reason);
        return;
      case "cooldown":
        persistCooldown(hold);
        return;
      case "record":
        persistOutcome(hold, effect.outcome);
        if (effect.outcome !== "switched") setStatus(undefined);
        return;
    }
  }

  function enqueueHeld(hold: HoldRuntime): void {
    if (hold.heldEnqueued) return;
    hold.heldEnqueued = true;
    clearWatchdog(hold, clock);
    if (hold.webRelease !== undefined) {
      hold.queue.enqueue({ kind: "web", payload: hold.payload, release: hold.webRelease });
    } else {
      hold.queue.enqueue({ kind: "content", payload: hold.payload, deliverAs: "followUp" });
    }
  }

  function persistPending(hold: HoldRuntime, reason: ShutdownReason): void {
    // M2: the held item may already have been sent by the release queue (e.g. delivered, then a
    // shutdown/reload races the 2s ordering barrier before the queue's own `released` feed runs)
    // — persisting it again here would hand reload/crash recovery a transfer it will faithfully
    // re-deliver, duplicating an already-successful send.
    if (hold.sentHeld) return;
    const at = Date.now();
    const persisted = makePayload(hold.payload.text, hold.payload.images);
    try {
      pi.appendEntry(ENTRY_TYPE, { v: 1, kind: "pending", at, holdId: hold.id, payload: persisted, reason });
    } catch {
      /* best-effort: the in-process transfer below still carries the full payload */
    }
    const fromSessionId = safe(() => ctxRef.current?.sessionManager.getSessionId()) ?? "";
    setTransfer({ holdId: hold.id, payload: hold.payload, fromSessionId, reason, state: "pending", at });
  }

  function persistCooldown(hold: HoldRuntime): void {
    void hold;
    const tokensRaw = safe(() => ctxRef.current?.getContextUsage()?.tokens);
    const tokens = typeof tokensRaw === "number" && Number.isFinite(tokensRaw) ? tokensRaw : 0;
    try {
      pi.appendEntry(ENTRY_TYPE, { v: 1, kind: "cooldown", at: Date.now(), tokens });
    } catch {
      /* best-effort */
    }
  }

  function persistOutcome(hold: HoldRuntime, outcome: Outcome): void {
    const data: Record<string, unknown> = {
      v: 1,
      kind: "outcome",
      at: Date.now(),
      holdId: hold.id,
      outcome,
      estUsd: Math.round(hold.estUsd * 100) / 100,
      prefixK: Math.round(hold.prefixTokens / 1000),
    };
    if (hold.judgeMs !== undefined) data.judgeMs = hold.judgeMs;
    if (hold.confidence > 0) data.confidence = hold.confidence;
    try {
      pi.appendEntry(ENTRY_TYPE, data);
    } catch {
      /* best-effort */
    }
  }

  function runJudge(hold: HoldRuntime): void {
    const ctx = hold.holdCtx;
    const settingsNow = deps.settings();
    const sessionModel = ctx.model !== undefined ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const chain = judgeModelChain({ configured: settingsNow.models, title: deps.titleModel, session: sessionModel });
    const branchView = buildBranchView(ctx.sessionManager.getBranch());
    const sessionName = safe(() => pi.getSessionName());
    const input: JudgeInput = {
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(branchView.lastCompactionSummary !== undefined
        ? { compactionSummary: branchView.lastCompactionSummary }
        : {}),
      recentUserMessages: branchView.recentUserTexts,
      ...(branchView.lastAssistantText !== undefined ? { lastAssistantExcerpt: branchView.lastAssistantText } : {}),
      request: hold.payload.text,
      imageCount: hold.payload.images?.length ?? 0,
    };
    // Failover chain (plan D3 + runtime failover): one port per chain entry that the registry
    // actually has; unregistered entries are skipped exactly as the single-model path did.
    const attempts: JudgeAttempt[] = [];
    for (const ref of chain) {
      const found = safe(() => ctx.modelRegistry.find(ref.provider, ref.id));
      if (found === undefined) continue;
      const boundModel = found;
      attempts.push({
        ref,
        port: {
          complete: async (systemPrompt, userPrompt, signal) => {
            const context = {
              systemPrompt,
              messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }],
            };
            // 2026-10-16 (user: speed over accuracy): provider-neutral `reasoning: JUDGE_REASONING`
            // through streamSimple — `complete` takes provider-specific options only. Registries
            // without streamSimple (older hosts / test doubles) keep the plain complete path.
            const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
              streamSimple?: (typeof ctx.modelRegistry)["streamSimple"];
            };
            const message =
              typeof registry.streamSimple === "function"
                ? await registry
                    .streamSimple(boundModel, context, {
                      signal,
                      maxTokens: JUDGE_MAX_TOKENS,
                      reasoning: JUDGE_REASONING,
                    })
                    .result()
                : await ctx.modelRegistry.complete(boundModel, context, { signal, maxTokens: JUDGE_MAX_TOKENS });
            return assistantMessageText(message);
          },
        },
      });
    }
    if (attempts.length === 0) {
      feed(hold, { t: "judged", v: { kind: "no-model" } });
      return;
    }
    void judgeWithFailover(attempts, input, settingsNow.judgeTimeoutMs, clock, hold.abort.signal).then((result) => {
      if (currentHold !== hold) return;
      noteJudgeDiag(result);
      const verdict = result.verdict;
      if (verdict.kind === "ok") hold.confidence = verdict.confidence;
      hold.judgeMs = verdict.ms;
      feed(hold, { t: "judged", v: verdict });
    });
  }

  /** Last-judgment diagnostics: answered-by on success, per-model failure counts (FIFO cap 8). */
  function noteJudgeDiag(result: JudgeFailoverResult): void {
    for (const attempt of result.attempts) {
      if (attempt.kind === "ok") continue;
      const key = `${attempt.provider}/${attempt.id}`;
      const next = (judgeDiag.failures.get(key) ?? 0) + 1;
      judgeDiag.failures.delete(key); // re-insert at the end so the cap evicts the oldest entry
      judgeDiag.failures.set(key, next);
      while (judgeDiag.failures.size > 8) {
        const oldest = judgeDiag.failures.keys().next().value;
        if (oldest === undefined) break;
        judgeDiag.failures.delete(oldest);
      }
    }
    const answered = result.attempts.find((a) => a.kind === "ok");
    judgeDiag.answered = answered === undefined ? undefined : `${answered.provider}/${answered.id}`;
  }

  function runConfirm(hold: HoldRuntime): void {
    const ctx = hold.holdCtx;
    const text = buildConfirmText({
      confidence: hold.confidence,
      estUsd: hold.estUsd,
      request: hold.payload.text,
      imageCount: hold.payload.images?.length ?? 0,
    });
    const confirmCtx: ConfirmCtx = {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      ...(typeof ctx.ui?.select === "function" ? { ui: { select: ctx.ui.select.bind(ctx.ui) } } : {}),
    };
    void confirmSwitch(confirmCtx, deps.remote(), text, {
      timeoutMs: deps.settings().confirmTimeoutMs,
      clock,
      id: hold.id,
      signal: hold.abort.signal,
    }).then((outcome) => {
      if (currentHold !== hold) return;
      feed(hold, { t: "confirmed", o: outcome });
    });
  }

  function runHop(hold: HoldRuntime): void {
    const nonce = randomUUID();
    hold.nonce = nonce;
    const timer = clock.setTimer(HOP_TIMEOUT_MS, () => {
      const entry = nonces.get(nonce);
      if (entry === undefined || entry.hold !== hold) return;
      nonces.delete(nonce);
      feed(hold, { t: "hop-timeout" });
    });
    nonces.set(nonce, { hold, timer });
    try {
      pi.sendUserMessage("/topic-switch __go " + nonce, { expandPromptTemplates: true });
    } catch {
      nonces.delete(nonce);
      try {
        clock.clearTimer(timer);
      } catch {
        /* best-effort */
      }
      feed(hold, { t: "hop-timeout" });
    }
  }

  function commonGateFacts(
    ctx: ExtensionContext,
    branch: readonly SessionEntry[],
    settingsNow: TopicSwitchSettings,
  ): Pick<
    GateFacts,
    | "compacting"
    | "draining"
    | "cooldownActive"
    | "activeRuns"
    | "backgroundBash"
    | "goalBusy"
    | "branch"
    | "warmth"
    | "prefixTokens"
    | "modelCost"
  > {
    const stackView = deps.stack();
    return {
      compacting,
      draining,
      cooldownActive: cooldownActive(
        branch as unknown as EntryLike[],
        safeOr(() => ctx.getContextUsage()?.tokens, undefined),
        settingsNow.regrowTokens,
      ),
      activeRuns: safeOr(() => stackView?.activeRuns() ?? 0, 0),
      backgroundBash: safeOr(() => stackView?.backgroundBash() ?? 0, 0),
      goalBusy: safeOr(() => stackView?.goalBusy() ?? false, false),
      branch: () => buildBranchView(branch),
      warmth: () =>
        deps.warmth.assess(ctx, Date.now(), {
          slackMs: settingsNow.expirySlackMs,
          ...(settingsNow.debugAssumedTtlMs > 0 ? { ttlOverrideMs: settingsNow.debugAssumedTtlMs } : {}),
        }),
      prefixTokens: () => ctx.getContextUsage()?.tokens ?? null,
      modelCost: () => ctx.model?.cost,
    };
  }

  function buildInputGateFacts(event: InputEvent, ctx: ExtensionContext, settingsNow: TopicSwitchSettings): GateFacts {
    const branch = safeOr(() => ctx.sessionManager.getBranch(), [] as readonly SessionEntry[]);
    return {
      hasUI: safeOr(() => ctx.hasUI, false),
      mode: safeOr(() => ctx.mode, "print"),
      streamingBehavior: event.streamingBehavior,
      // Fail-open bias (I6): an unreadable idle/pending state is treated as "busy", never as
      // "safe to hold" — the gate's own busy-turn check (1b) then rejects cleanly instead of this
      // function throwing.
      idle: safeOr(() => ctx.isIdle(), false),
      pendingMessages: safeOr(() => ctx.hasPendingMessages(), true),
      origin: "input",
      source: event.source,
      text: event.text,
      imageCount: event.images?.length ?? 0,
      ...commonGateFacts(ctx, branch, settingsNow),
    };
  }

  function buildWebGateFacts(
    req: { text: string },
    ctx: ExtensionContext,
    settingsNow: TopicSwitchSettings,
  ): GateFacts {
    const branch = safeOr(() => ctx.sessionManager.getBranch(), [] as readonly SessionEntry[]);
    return {
      hasUI: safeOr(() => ctx.hasUI, false),
      mode: safeOr(() => ctx.mode, "print"),
      streamingBehavior: undefined,
      idle: true,
      pendingMessages: safeOr(() => ctx.hasPendingMessages(), true),
      origin: "web",
      source: "extension",
      text: req.text,
      imageCount: 0,
      ...commonGateFacts(ctx, branch, settingsNow),
    };
  }

  function startHold(
    ctx: ExtensionContext,
    text: string,
    images: ImageLike[] | undefined,
    estimate: PricedEstimate,
    origin: "input" | "web",
    webRelease?: WebPromptRelease,
  ): HoldRuntime {
    seq += 1;
    const id = `${activationId}:${seq}`;
    const payload = fullPayload(text, images);
    let hold: HoldRuntime | undefined;
    const queue = createReleaseQueue({
      sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
      isCompacting: () => compacting,
      waitCompactSettled: (ms) => waitCompactSettled(ms),
      waitBarrier: (ms) => waitBarrier(ms),
      clock,
      onDrainChange: (v) => {
        draining = v;
        if (!v && hold !== undefined) feed(hold, { t: "released" });
      },
      onSent: (item) => {
        if (hold !== undefined && item.payload === hold.payload) hold.sentHeld = true;
      },
    });
    const created: HoldRuntime = {
      id,
      state: initialHoldState(),
      payload,
      estUsd: estimate.usd,
      prefixTokens: estimate.prefixTokens,
      confidence: 0,
      abort: new AbortController(),
      queue,
      fromOrigin: origin,
      ...(webRelease !== undefined ? { webRelease } : {}),
      holdCtx: ctx,
      heldEnqueued: false,
      sentHeld: false,
    };
    hold = created;
    currentHold = created;
    setStatus("topic check…");
    const watchdogMs = deps.settings().judgeTimeoutMs + deps.settings().confirmTimeoutMs + 15_000;
    created.watchdog = clock.setTimer(watchdogMs, () => feed(created, { t: "abort", why: "watchdog" }));
    queueMicrotask(() => runJudge(created));
    return created;
  }

  function enqueueNewcomerContent(hold: HoldRuntime, event: InputEvent): void {
    const payload = fullPayload(event.text, toImageLikes(event.images));
    const deliverAs = event.streamingBehavior ?? "followUp";
    hold.queue.enqueue({ kind: "content", payload, deliverAs });
  }

  pi.on("input", (event, ctx): InputEventResult => {
    ctxRef.current = ctx;
    try {
      const hold = currentHold;
      if (hold !== undefined) {
        const phase = hold.state.phase;
        if (phase === "releasing") {
          if (event.source === "interactive" || event.source === "rpc") {
            enqueueNewcomerContent(hold, event);
            return { action: "handled" };
          }
          sawExtensionEcho = true;
          barrierCheck();
          return { action: "continue" };
        }
        if (phase === "switching") return { action: "continue" }; // I4
        // judging | confirming | hopping: any input defensively ends the hold (plan §P3b.3 step 2).
        feed(hold, { t: "newcomer" });
        enqueueNewcomerContent(hold, event);
        return { action: "handled" };
      }
      const settingsNow = deps.settings();
      const facts = buildInputGateFacts(event, ctx, settingsNow);
      const verdict = evaluateSyncGates(facts, settingsNow);
      if (!verdict.pass) {
        noteSkip(verdict.reason);
        return { action: "continue" };
      }
      startHold(ctx, event.text, toImageLikes(event.images), verdict.estimate, "input");
      return { action: "handled" };
    } catch {
      return { action: "continue" };
    }
  });

  pi.on("agent_start", () => {
    sawAgentStart = true;
    barrierCheck();
  });

  pi.on("session_before_compact", (_event, ctx) => {
    ctxRef.current = ctx;
    compacting = true;
  });
  pi.on("session_compact", (_event, ctx) => {
    ctxRef.current = ctx;
    compacting = false;
    resolveCompactWaiters();
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    ctxRef.current = ctx;
    compacting = false;
    resolveCompactWaiters();
  });

  pi.on("session_start", (event, ctx) => {
    ctxRef.current = ctx;
    live = true;
    compacting = false;
    runRecoveryOnStart(ctx, event.reason);
  });

  pi.on("session_shutdown", (event, ctx) => {
    ctxRef.current = ctx;
    shutdownSeq += 1;
    if (currentHold !== undefined) feed(currentHold, { t: "abort", why: "shutdown", reason: event.reason });
    live = false;
    // m4: this activation is going away — leaving a stale "topic check…"/"topic confirm…" entry
    // in the status bar would misrepresent a session that, from here on, this activation no
    // longer tracks at all.
    try {
      ctx.ui.setStatus("topic-switch", undefined);
    } catch {
      /* best-effort */
    }
  });

  function runRecoveryOnStart(ctx: ExtensionContext, reason: StartReason): void {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const transfer = pickTransferForRecovery(sessionId, reason);
      const branch = ctx.sessionManager.getBranch();
      runRecovery({
        branch: branch as unknown as EntryLike[],
        transfer,
        sessionId,
        reason,
        now: () => Date.now(),
        appendRecord: (data) => {
          try {
            pi.appendEntry(ENTRY_TYPE, data);
          } catch {
            /* best-effort */
          }
        },
        notify: (message, level) => {
          try {
            ctx.ui.notify(message, level ?? "info");
          } catch {
            /* best-effort */
          }
        },
        setEditorText: (text) => {
          try {
            ctx.ui.setEditorText(text);
          } catch {
            /* best-effort */
          }
        },
        markDelivering: (holdId) => {
          if (!casTransfer(holdId, ["pending"], "delivering")) return false;
          try {
            pi.appendEntry(ENTRY_TYPE, { v: 1, kind: "delivering", at: Date.now(), holdId });
          } catch {
            /* best-effort */
          }
          return true;
        },
        deliver: (payload) => {
          const queue = createReleaseQueue({
            sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
            isCompacting: () => compacting,
            waitCompactSettled: (ms) => waitCompactSettled(ms),
            waitBarrier: () => Promise.resolve(),
            clock,
          });
          queue.enqueue({ kind: "content", payload, deliverAs: "followUp" });
        },
      });
    } catch {
      /* recovery must never crash session_start */
    }
  }

  function statusText(ctx: ExtensionCommandContext): string {
    const s = deps.settings();
    const sessionModel = ctx.model !== undefined ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const chain = judgeModelChain({ configured: s.models, title: deps.titleModel, session: sessionModel });
    const chainText =
      chain.length > 0 ? chain.map((ref) => `${ref.provider}/${ref.id}(${ref.origin})`).join(" → ") : "(none)";
    const fails = [...judgeDiag.failures.entries()].map(([model, n]) => `${model}×${n}`).join(" ");
    const judgeLine =
      `judge: answered ${judgeDiag.answered ?? "(none yet)"}` + (fails.length > 0 ? ` · fails ${fails}` : "");
    const branch = safe(() => ctx.sessionManager.getBranch()) ?? [];
    const inCooldown = cooldownActive(
      branch as unknown as EntryLike[],
      safe(() => ctx.getContextUsage()?.tokens),
      s.regrowTokens,
    );
    const skipLine = (Object.entries(skipCounts) as [SkipReason, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(" ");
    const phase = currentHold?.state.phase ?? "idle";
    return [
      `topic-switch: ${s.enabled ? "on" : "off"} · threshold $${s.costThresholdUsd} · cooldown ${inCooldown ? "active" : "off"} · hold ${phase}`,
      `judge chain: ${chainText}`,
      judgeLine,
      skipLine.length > 0 ? `skips: ${skipLine}` : "skips: (none yet)",
      `recent outcomes: ${recentOutcomesText(branch as unknown as EntryLike[])}`,
    ].join("\n");
  }

  /** m3: the last (most recent first) 5 `outcome` records visible on this session's branch. */
  function recentOutcomesText(branch: readonly EntryLike[]): string {
    const outcomes: string[] = [];
    for (let i = branch.length - 1; i >= 0 && outcomes.length < 5; i -= 1) {
      const entry = branch[i];
      if (entry === undefined || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const record = safe(() => parseRecord(entry.data));
      if (record !== undefined && record.kind === "outcome") outcomes.push(record.outcome);
    }
    return outcomes.length > 0 ? outcomes.join(", ") : "(none yet)";
  }

  const commandDeps: TopicSwitchCommandDeps = {
    now: () => Date.now(),
    appendEntryRaw: (customType, data) => pi.appendEntry(customType, data),
    sendUserMessage: (content, deliverAs) => pi.sendUserMessage(content, { deliverAs }),
    consumeHopNonce: (nonce) => {
      const entry = nonces.get(nonce);
      if (entry === undefined) return undefined;
      nonces.delete(nonce);
      try {
        clock.clearTimer(entry.timer);
      } catch {
        /* best-effort */
      }
      if (entry.hold !== currentHold || entry.hold.state.phase !== "hopping") return undefined;
      return entry.hold;
    },
    onPreflightFailed: (_ctx, hold) => feed(hold, { t: "preflight-failed" }),
    onPonr: (_ctx, hold) => {
      markInFlight(hold.id); // B1: mid-switch from here until the switch resolves one way or another
      feed(hold, { t: "ponr" });
      clock.setTimer(PONR_WATCHDOG_MS, () => {
        if (!casTransfer(hold.id, ["pending"], "manual")) return;
        clearInFlight(hold.id); // gave up waiting — recovery may act on this holdId normally again
        try {
          ctxRef.current?.ui.notify("切换未完成，原请求已保存，可用 /topic-switch last 取回。", "warning");
        } catch {
          /* best-effort */
        }
      });
    },
    onSwitchEntered: (hold) => {
      feed(hold, { t: "switch-entered" });
      if (hold.webRelease !== undefined) {
        try {
          hold.webRelease.elsewhere();
        } catch {
          /* best-effort */
        }
      }
    },
    onSwitchCancelled: (_ctx, hold) => feed(hold, { t: "switch-cancelled" }),
    clearInFlight,
    recordSwitched: (hold) => persistOutcome(hold, "switched"),
    setTransfer,
    casTransfer,
    pickTransfer: (sessionId) => pickTransferForLast(sessionId),
    markShutdownSeq: () => shutdownSeq,
    shutdownHappenedSince: (markSeq) => shutdownSeq > markSeq,
    statusText,
  };

  pi.registerCommand("topic-switch", createTopicSwitchCommand(commandDeps));

  const webGate: PromptGatePort = {
    tryClaim(req, ctxUnknown, release) {
      try {
        const ctx = ctxUnknown as ExtensionContext;
        if (ctx === undefined || typeof ctx.hasUI !== "boolean") return false;
        const hold = currentHold;
        if (hold === undefined) {
          const settingsNow = deps.settings();
          const facts = buildWebGateFacts(req, ctx, settingsNow);
          const verdict = evaluateSyncGates(facts, settingsNow);
          if (!verdict.pass) {
            noteSkip(verdict.reason);
            return false;
          }
          startHold(ctx, req.text, undefined, verdict.estimate, "web", release);
          return true;
        }
        const phase = hold.state.phase;
        if (phase === "judging" || phase === "confirming" || phase === "hopping") {
          feed(hold, { t: "newcomer" });
          hold.queue.enqueue({ kind: "web", payload: fullPayload(req.text, undefined), release });
          return true;
        }
        if (phase === "releasing") {
          hold.queue.enqueue({ kind: "web", payload: fullPayload(req.text, undefined), release });
          return true;
        }
        return false; // switching: I4, pi's own `/new` semantics — never claimed here.
      } catch {
        return false;
      }
    },
  };

  return { webGate };
}
