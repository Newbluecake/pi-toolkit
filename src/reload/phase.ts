/**
 * #30 reload-result plan §1 D1/D3 — reload lifecycle phase events (pure data, pi-free).
 *
 * The deferred-reload command port (`command-port.ts`) emits these facts as it executes; the
 * web-hub agent side (`web-hub/agent/reload-track.ts`) attributes them to a tracked record and
 * projects the result onto the open `StatusInfo.reload` slot. Attribution unit is the reload
 * lifecycle `life` (one UUID from the first fact until cancel/unavailable/`ctx.reload`
 * returning); underneath it, every real reload attempt rotates an execution token `execId` —
 * asynchronously-captured callbacks (the 5s settle wait, `ctx.reload()`'s settlement) carry the
 * token captured at entry and are dropped once a newer execution superseded them.
 *
 * This module is deliberately dependency-free (no pi, no protocol): the command port must stay
 * usable on hosts where the web hub is off — then no sink is wired and these events simply
 * never leave the port.
 */
import { randomUUID } from "node:crypto";

/** One fact about a tracked reload lifecycle, as emitted by the command port. */
export interface ReloadPhaseEventBase {
  /** The reload lifecycle this fact belongs to (see `command-port.ts`). */
  life: string;
  /** The execution token current when the fact happened (rotated on every reload() entry). */
  execId: string;
  /** The web command frame id, iff the fact's ctx was a capture proxy (`webCmdIdOf`). TUI
   * invocations carry no `by` — the tracker then only records into an already-tracked life (Q1). */
  by?: string;
}

/** arm/refresh or an idle-wait registration — `waitingFor:"runs"` carries `activeRuns`. */
export interface ReloadDeferredFact {
  kind: "deferred";
  waitingFor: "runs" | "idle";
  activeRuns?: number;
}
/** The natural-idle wait failed/timed out — the request stays parked (`open:true`). */
export interface ReloadIdleWaitFact {
  kind: "idleWait";
}
/** Any-source user cancel — closes the lifecycle (`cancelled user`). */
export interface ReloadCancelFact {
  kind: "cancel";
}
/** The host cannot reload at all (`failed E_RELOAD_UNAVAILABLE`, closes the lifecycle). */
export interface ReloadUnavailableFact {
  kind: "unavailable";
}
/** A new reload attempt began (execution token rotated; merges a web request into the life). */
export interface ReloadExecFact {
  kind: "exec";
}
/** `now`'s bounded 5s settle wait failed (`failed E_RELOAD_SETTLE`, `open` = still parked). */
export interface ReloadSettleFact {
  kind: "settle";
  open: boolean;
}
/** `ctx.reload()` is about to be called — the only fact that may write the handover marker. */
export interface ReloadStartedFact {
  kind: "started";
}
/** `ctx.reload()` returned without a reload-shutdown observed in this activation (tracker judges). */
export interface ReloadReturnedFact {
  kind: "returned";
}
/** `ctx.reload()` threw (tracker judges: only when no reload-shutdown was observed). */
export interface ReloadThrewFact {
  kind: "threw";
  message?: string;
}

export type ReloadPhaseFact =
  | ReloadDeferredFact
  | ReloadIdleWaitFact
  | ReloadCancelFact
  | ReloadUnavailableFact
  | ReloadExecFact
  | ReloadSettleFact
  | ReloadStartedFact
  | ReloadReturnedFact
  | ReloadThrewFact;

export type ReloadPhaseEvent = ReloadPhaseEventBase & ReloadPhaseFact;

/** Fresh lifecycle id (D1: `randomUUID()`, one per request lifecycle). */
export function newReloadLife(): string {
  return randomUUID();
}

/** Fresh execution token (D1: one per real reload attempt). */
export function newReloadExec(): string {
  return randomUUID();
}

/** `E_RELOAD_THREW` message bound: ≤256 bytes INCLUDING the ellipsis, cut at a UTF-8
 * boundary (plan D2). */
export const RELOAD_MESSAGE_MAX_BYTES = 256;
const ELLIPSIS = "…";

export function clipReloadMessage(raw: string): string {
  const buf = Buffer.from(raw, "utf8");
  if (buf.length <= RELOAD_MESSAGE_MAX_BYTES) return raw;
  const cut = buf.subarray(0, RELOAD_MESSAGE_MAX_BYTES - Buffer.byteLength(ELLIPSIS, "utf8"));
  let end = cut.length;
  // drop a trailing incomplete multi-byte sequence: continuation bytes first, then an orphaned
  // lead byte whose sequence the cut truncated (a lone lead would decode to U+FFFD and can push
  // the RESULT past the budget — exactly what the bound exists to prevent)
  while (end > 0 && (cut[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (cut[end - 1]! & 0x80) !== 0) {
    const lead = cut[end - 1]!;
    const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (cut.length - (end - 1) < len) end -= 1;
  }
  return `${cut.subarray(0, end).toString("utf8")}${ELLIPSIS}`;
}
