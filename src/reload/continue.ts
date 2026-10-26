/**
 * Same-process reload continuation handoff (I4): Symbol.for slot, capacity 1,
 * lazy TTL 120s. No timer, disk writes, or module-scope mutable state.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTINUE_KEY = Symbol.for("pi-subagent:reload-continue");
export const RELOAD_CONTINUE_TTL_MS = 120_000;

interface ContinueMarker {
  sessionId: string;
  sessionFile: string | undefined;
  createdAt: number;
}

type SessionIdentityContext = Pick<ExtensionContext, "sessionManager">;

function slot(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

function identity(ctx: SessionIdentityContext): Pick<ContinueMarker, "sessionId" | "sessionFile"> | undefined {
  const manager = ctx.sessionManager;
  const sessionId = manager?.getSessionId?.();
  if (!sessionId) return undefined;
  return { sessionId, sessionFile: manager.getSessionFile?.() };
}

/** Returns an identity-checked rollback for a failed reload; never clears a newer handoff. */
export function writeReloadContinue(ctx: SessionIdentityContext, now = Date.now()): () => void {
  const session = identity(ctx);
  // Capacity one: even a host without session identity must not preserve a stale handoff.
  delete slot()[CONTINUE_KEY];
  if (!session) return () => undefined;
  const marker: ContinueMarker = { ...session, createdAt: now };
  slot()[CONTINUE_KEY] = marker;
  return () => {
    if (slot()[CONTINUE_KEY] === marker) delete slot()[CONTINUE_KEY];
  };
}

/** Read-then-delete on EVERY session start; only a matching reload may resume work. */
export function consumeReloadContinue(ctx: SessionIdentityContext, reason: string, now = Date.now()): boolean {
  const marker = slot()[CONTINUE_KEY] as Partial<ContinueMarker> | undefined;
  delete slot()[CONTINUE_KEY];
  const session = identity(ctx);
  return (
    reason === "reload" &&
    session !== undefined &&
    marker !== null &&
    typeof marker === "object" &&
    typeof marker.createdAt === "number" &&
    now >= marker.createdAt &&
    now - marker.createdAt < RELOAD_CONTINUE_TTL_MS &&
    marker.sessionId === session.sessionId &&
    marker.sessionFile === session.sessionFile
  );
}

/** Optional probes support older/minimal hosts; pi 1.3 exposes both methods. */
export function isReloadStreaming(ctx: Pick<ExtensionContext, "isIdle">): boolean {
  return typeof ctx.isIdle === "function" && !ctx.isIdle();
}

export function needsReloadContinue(
  interruptedAtArm: boolean,
  ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages">,
): boolean {
  return (
    interruptedAtArm ||
    isReloadStreaming(ctx) ||
    (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages())
  );
}

/** Snapshot distinguishes a newly completed response from a stale previous `stop`. */
export interface ReloadTurnSnapshot {
  assistantEntryId: string | undefined;
}

export function snapshotReloadTurn(ctx: SessionIdentityContext): ReloadTurnSnapshot | undefined {
  if (typeof ctx.sessionManager?.getBranch !== "function") return undefined;
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "message" && entry.message.role === "assistant") {
      return { assistantEntryId: entry.id };
    }
  }
  return { assistantEntryId: undefined };
}

/**
 * Only suppress deferred continuation with proof of NEW normal completion.
 * Later user/tool-result messages mean unfinished work; metadata/custom notices
 * do not invalidate a final assistant stop. Missing history degrades conservatively.
 */
export function completedReloadTurn(ctx: SessionIdentityContext, before: ReloadTurnSnapshot | undefined): boolean {
  if (!before || typeof ctx.sessionManager?.getBranch !== "function") return false;
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      return entry.id !== before.assistantEntryId && entry.message.stopReason === "stop";
    }
    if (entry.message.role === "user" || entry.message.role === "toolResult") return false;
  }
  return false;
}
