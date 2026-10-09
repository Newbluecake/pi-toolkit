/**
 * topic-switch · pi-facing hold runtime shape + shared helpers (plan.md P3b §2/§4).
 *
 * This is the glue layer between the pi-free decision core (state.ts's reducer, gate.ts,
 * judge.ts, economics.ts, records.ts) and real pi objects (`ExtensionContext`,
 * `SessionEntry`, `AgentMessage`). `wire.ts` owns the event registration and orchestration;
 * this module owns the shapes both `wire.ts` and `recovery.ts`/`release.ts` share plus the
 * pure-ish (pi-typed, but deterministic) projection functions: `buildBranchView` (one
 * `getBranch()` scan → the `BranchView` gate.ts/judge.ts need) and `toContent`/`fullPayload`
 * (payload ⇄ pi message-content conversion).
 */
import type { SessionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { replayState } from "../todo/state.js";
import { digestOfPayload } from "./records.js";
import type { BranchView, HeldPayload, ImageLike } from "./types.js";
import type { ReleaseQueue } from "./release.js";
import type { WebPromptRelease } from "../web-hub/agent/prompt-gate.js";
import type { HoldPhase, HoldState } from "./state.js";
import type { Clock, TimerHandle } from "../core/clock.js";

/**
 * Live per-hold runtime state (plan §P3b.2 "身份与绑定"). One `activationId` is minted per
 * `wireTopicSwitch()` call; `id = activationId + ":" + seq` is this particular hold's identity.
 * NOTE (corrected from an earlier, wrong assumption): real pi DOES re-run `activate()` — a fresh
 * `wireTopicSwitch()` closure, fresh `activationId`, fresh `live`/`currentHold` — on every session
 * replacement (`newSession`/`fork`/`switchSession`), not just `/reload` (confirmed by
 * `tests/conformance/topic-switch-runtime-harness.ts`'s gen1/gen2 probe). A hold therefore never
 * survives our own `newSession` hop as a live object: `command.ts`'s PONR path hands off through
 * the process-global transfer store instead (see `wire.ts`'s header comment). Every async callback
 * must check `live && currentHold === this` (reference identity, strictly stronger than comparing
 * `id` strings) before feeding a result into the reducer — a stale callback from an invalidated
 * hold, OR one that fires after this very activation's own `session_shutdown`, is a no-op (#9).
 */
export interface HoldRuntime {
  readonly id: string;
  state: HoldState;
  /** FULL, uncapped payload (R14 / P1 note d): delivery always uses this, never the
   *  disk-capped `makePayload()` projection, which is computed on demand only when persisting. */
  payload: HeldPayload;
  estUsd: number;
  /** `estimateNextRequestUsd`'s `prefixTokens` at hold-creation time — used only to render
   *  the persisted outcome record's `prefixK` (thousands, rounded). */
  prefixTokens: number;
  confidence: number;
  judgeMs?: number;
  readonly abort: AbortController;
  readonly queue: ReleaseQueue;
  readonly fromOrigin: "input" | "web";
  readonly webRelease?: WebPromptRelease;
  /** The `ExtensionContext` captured at hold-creation time. Valid for the WHOLE pre-PONR
   *  lifetime (judging/confirming/hopping never span a session replacement — only our own
   *  controlled switch does, and that happens through `command.ts`'s own fresh `ctx`/`rctx`,
   *  never through this field). Used by `runConfirm` for `ctx.ui.select`/`ctx.mode`/`ctx.hasUI`. */
  readonly holdCtx: ExtensionContext;
  watchdog?: TimerHandle;
  nonce?: string;
  /** Guards the `release`/`hop` effects against double-enqueue/double-hop on a re-entrant fx batch. */
  heldEnqueued: boolean;
  /** M2: set true the moment the release queue has actually sent the ORIGINAL held payload (by
   *  reference, `item.payload === hold.payload`) at least once — `persist-pending` must never
   *  re-stage an already-sent held item for a reload/crash re-delivery. */
  sentHeld: boolean;
}

export function currentPhase(hold: HoldRuntime | undefined): HoldPhase | undefined {
  return hold?.state.phase;
}

/** sha256-stable, full-fidelity payload (never capped) — the in-memory counterpart of
 *  `records.makePayload`, which the disk-persistence call sites alone are responsible for. */
export function fullPayload(text: string, images: readonly ImageLike[] | undefined): HeldPayload {
  const digest = digestOfPayload(text, images);
  const payload: HeldPayload = { text, digest };
  if (images !== undefined && images.length > 0) payload.images = images.map((image) => ({ ...image }));
  return payload;
}

/** `HeldPayload` → pi message content blocks, for `pi.sendUserMessage`/`rctx.sendUserMessage`. */
export function toContent(payload: HeldPayload): (TextContent | ImageContent)[] {
  const blocks: (TextContent | ImageContent)[] = [{ type: "text", text: payload.text }];
  for (const image of payload.images ?? []) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return blocks;
}

function plainTextOf(content: string | (TextContent | { type: string })[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

/**
 * One `getBranch()` scan → the `BranchView` shared by gates 1e/2d/2e and the judge prompt
 * (arch §12: "GateFacts 采集只读一次 getBranch()"). Reverse-scans for the last assistant
 * message (skipping non-message entries, same "last one or nothing" rule `title/index.ts`'s
 * `extractAssistantExcerpt` uses) and the latest compaction summary, forward-scans for the last
 * few user message texts, and reuses `src/todo/state.ts`'s `replayState` (the SAME read-back the
 * todo module itself uses) for `todoInProgress` rather than re-implementing that scan.
 */
export function buildBranchView(branch: readonly SessionEntry[]): BranchView {
  let hasAssistant = false;
  let lastAssistantText: string | undefined;
  let lastTurnAskedUser = false;
  let lastCompactionSummary: string | undefined;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i]!;
    if (entry.type === "compaction" && lastCompactionSummary === undefined) {
      lastCompactionSummary = entry.summary;
    }
    if (hasAssistant) continue;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string } | undefined;
    if (!message || message.role !== "assistant") continue;
    hasAssistant = true;
    const assistantMsg = message as AssistantMessage;
    if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && !assistantMsg.errorMessage) {
      lastTurnAskedUser = assistantMsg.content.some((block) => block.type === "toolCall" && block.name === "ask_user");
      const text = assistantMsg.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      lastAssistantText = text || undefined;
    }
  }
  const recentUserTexts: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const text = plainTextOf(message.content as never).trim();
    if (text) recentUserTexts.push(text);
  }
  let todoInProgress = false;
  try {
    const state = replayState(branch);
    todoInProgress = state?.tasks.some((task) => task.status === "in_progress") ?? false;
  } catch {
    todoInProgress = false;
  }
  return {
    hasAssistant,
    lastAssistantText,
    lastTurnAskedUser,
    todoInProgress,
    recentUserTexts: recentUserTexts.slice(-3),
    lastCompactionSummary,
  };
}

/** Clears a hold's watchdog timer exactly once; safe to call repeatedly. */
export function clearWatchdog(hold: HoldRuntime, clock: Clock): void {
  if (hold.watchdog === undefined) return;
  const t = hold.watchdog;
  delete hold.watchdog;
  try {
    clock.clearTimer(t);
  } catch {
    /* best-effort */
  }
}
