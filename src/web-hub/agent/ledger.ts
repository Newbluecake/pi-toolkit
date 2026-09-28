/**
 * Process-level command ledger (plan §4.5, D7/D15).
 *
 * Backing store is a plain-data object on `Symbol.for(...)`, the same pattern
 * `connection.ts` uses for the process-level agent identity: a new module
 * instance (`/reload`) reuses the same table instead of losing in-flight/
 * terminal entries (v1's R3 window). Never store closures/ctx/promises here —
 * only plain data survives a module re-evaluation meaningfully.
 *
 * Two independent tracks per entry:
 *  - the generic idempotency state (`running` → `ok`/`failed`, D7): drives
 *    dup/queryOnly/eviction and is what makes retries safe;
 *  - for `prompt`-shaped entries, an orthogonal `promptState` sub-track
 *    (§4.3: dispatched → observed → started|queued → consumed|dropped, or
 *    unconfirmed at any point) that keeps evolving long after the generic
 *    state already went "ok" (prompt's HTTP reply is unconditionally ok per
 *    D5) — this is what the `ctl` slot actually reports for prompts.
 */
import { createHash } from "node:crypto";
import type { CmdErrorCode, CmdOp, CtlFrame, CtlItemWire } from "../protocol/messages.js";

/** Structurally identical to `CmdResultBody` (§3.2); kept as a local alias so this module has no
 * dependency on the exact export name pi-hub decides to freeze it under. */
export type LedgerResult =
  | { ok: true; dup?: true; data: import("../protocol/messages.js").CmdData }
  | { ok: false; code: CmdErrorCode; message?: string; retryable: boolean; effect: "none" | "unknown" };

export type PromptSubState = "dispatched" | "observed" | "started" | "queued" | "consumed" | "dropped" | "unconfirmed";
export type PromptBehavior = "idle" | "steer" | "followUp";
export type PromptReason = "unobserved" | "not-started" | "not-delivered" | "session" | "timeout";

export interface LedgerEntry {
  readonly id: string;
  readonly op: CmdOp;
  readonly payloadDigest: string;
  state: "running" | "ok" | "failed";
  late?: true;
  result?: LedgerResult;
  /** prompt-matching text only; cleared once the entry reaches a terminal `promptState`. */
  text?: string;
  runId?: string;
  /** todo #32 finding 4: the session that created this entry (§4.5 "ctl 槽 = 台账中「本 session、
   * 最近更新」的投影"). Absent for entries created before this field existed / by callers that
   * never pass one — `frame()` always includes those (back-compat), it only ever excludes an
   * entry that carries a *different* session's id. */
  sessionId?: string;
  promptState?: PromptSubState;
  behavior?: PromptBehavior;
  reason?: PromptReason;
  readonly at: number;
  updatedAt: number;
}

export type BeginOutcome =
  | { kind: "new"; entry: LedgerEntry }
  | { kind: "dup"; result: LedgerResult }
  | { kind: "running" }
  | { kind: "digest_mismatch" }
  | { kind: "capacity" };

export interface LedgerQuerySnapshot {
  state: "running" | "ok" | "failed";
  late?: true;
  result?: LedgerResult;
}

export interface CommandLedger {
  /** §4.5 rule 1: get-or-create the `running` entry for `id`. `payload` is hashed (never stored
   * verbatim) to detect the same id reused for a different request. */
  begin(
    id: string,
    op: CmdOp,
    payload: unknown,
    now: number,
    extra?: { text?: string; runId?: string; sessionId?: string },
  ): BeginOutcome;
  get(id: string): LedgerEntry | undefined;
  /** Settle a running entry to a terminal state. A retryable, effect:"none" failure is deleted
   * instead of cached (D7 rule 2) so a retry re-executes from scratch. `opts.late` marks this as
   * a post-timeout settlement (driving `cmd_late`, D15). */
  settle(id: string, result: LedgerResult, now: number, opts?: { late?: true }): void;
  /** Advance the prompt sub-state track (§4.3) without touching the generic `state`/`result`. */
  updatePrompt(id: string, patch: Partial<Pick<LedgerEntry, "promptState" | "behavior" | "reason">>, now: number): void;
  /** Earliest still-unobserved (`promptState === "dispatched"`) entry whose stored text matches
   * exactly (§4.3 step 2 FIFO). */
  findDispatchedByText(text: string): LedgerEntry | undefined;
  query(id: string): LedgerQuerySnapshot | undefined;
  frame(sessionId: string, epoch: string, now: number): CtlFrame;
  countRunning(op?: CmdOp): number;
  dispose(): void;
}

const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
export const LEDGER_CAPACITY = 512;
export const LEDGER_TTL_MS = 30 * 60_000;
/** todo #32 finding 4 / plan §4.5 rule 3: "running 项受 op 级并发上限约束（每 agent 在途 ≤ 16，超出 E_RATE）". */
export const LEDGER_MAX_RUNNING = 16;
const CTL_MAX_ITEMS = 32;

interface LedgerBag {
  v: 1;
  entries: Map<string, LedgerEntry>;
}

function isLedgerBag(v: unknown): v is LedgerBag {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { v?: unknown }).v === 1 &&
    (v as { entries?: unknown }).entries instanceof Map
  );
}

function processLedgerBag(): LedgerBag {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[LEDGER_KEY];
  if (isLedgerBag(existing)) return existing;
  const bag: LedgerBag = { v: 1, entries: new Map() };
  g[LEDGER_KEY] = bag;
  return bag;
}

function digestOf(payload: unknown): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(payload) ?? "")
      .digest("hex");
  } catch {
    return "";
  }
}

/** Evict TTL-expired terminal entries, then oldest-terminal-first down to capacity. Running
 * entries are never evicted (D7: "只淘汰终态项"). */
function sweep(bag: LedgerBag, now: number): void {
  for (const [id, e] of bag.entries) {
    if (e.state !== "running" && now - e.updatedAt > LEDGER_TTL_MS) bag.entries.delete(id);
  }
  const over = bag.entries.size - LEDGER_CAPACITY;
  if (over <= 0) return;
  const terminal = [...bag.entries.values()]
    .filter((e) => e.state !== "running")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  let remaining = over;
  for (const e of terminal) {
    if (remaining <= 0) break;
    bag.entries.delete(e.id);
    remaining -= 1;
  }
}

function toWireItem(e: LedgerEntry): CtlItemWire {
  const item: CtlItemWire = { cmdId: e.id, op: e.op, state: wireState(e), at: e.at, updatedAt: e.updatedAt };
  if (e.behavior !== undefined) item.behavior = e.behavior;
  if (e.reason !== undefined) item.reason = e.reason;
  if (e.result?.ok === false) item.code = e.result.code;
  return item;
}

function wireState(e: LedgerEntry): CtlItemWire["state"] {
  if (e.promptState !== undefined) return e.promptState;
  if (e.state === "running") return "running";
  if (e.late === true) return e.result?.ok === false ? "late_failed" : "late_ok";
  return e.result?.ok === false ? "failed" : "ok";
}

function countRunningIn(bag: LedgerBag, op?: CmdOp): number {
  let n = 0;
  for (const e of bag.entries.values()) if (e.state === "running" && (op === undefined || e.op === op)) n += 1;
  return n;
}

export function createCommandLedger(): CommandLedger {
  const bag = processLedgerBag();
  return {
    begin(id, op, payload, now, extra) {
      sweep(bag, now);
      const digest = digestOf(payload);
      const existing = bag.entries.get(id);
      if (existing === undefined) {
        if (countRunningIn(bag) >= LEDGER_MAX_RUNNING) return { kind: "capacity" };
        const entry: LedgerEntry = { id, op, payloadDigest: digest, state: "running", at: now, updatedAt: now };
        if (extra?.text !== undefined) entry.text = extra.text;
        if (extra?.runId !== undefined) entry.runId = extra.runId;
        if (extra?.sessionId !== undefined) entry.sessionId = extra.sessionId;
        bag.entries.set(id, entry);
        return { kind: "new", entry };
      }
      if (existing.payloadDigest !== digest) return { kind: "digest_mismatch" };
      if (existing.state === "running") return { kind: "running" };
      return { kind: "dup", result: existing.result! };
    },
    get(id) {
      return bag.entries.get(id);
    },
    settle(id, result, now, opts) {
      const e = bag.entries.get(id);
      if (e === undefined) return;
      if (!result.ok && result.retryable && result.effect === "none") {
        bag.entries.delete(id);
        return;
      }
      e.state = result.ok ? "ok" : "failed";
      e.result = result;
      e.updatedAt = now;
      if (opts?.late === true) e.late = true;
    },
    updatePrompt(id, patch, now) {
      const e = bag.entries.get(id);
      if (e === undefined) return;
      Object.assign(e, patch);
      e.updatedAt = now;
      if (patch.promptState !== undefined && patch.promptState !== "dispatched" && patch.promptState !== "observed") {
        delete e.text; // §4.3: matching text is no longer needed past this point.
      }
    },
    findDispatchedByText(text) {
      let best: LedgerEntry | undefined;
      for (const e of bag.entries.values()) {
        if (e.text !== text || e.promptState !== "dispatched") continue;
        if (best === undefined || e.at < best.at) best = e;
      }
      return best;
    },
    query(id) {
      const e = bag.entries.get(id);
      if (e === undefined) return undefined;
      const out: LedgerQuerySnapshot = { state: e.state };
      if (e.late === true) out.late = true;
      if (e.result !== undefined) out.result = e.result;
      return out;
    },
    frame(sessionId, epoch, now) {
      sweep(bag, now);
      const items = [...bag.entries.values()]
        .filter((e) => e.sessionId === undefined || e.sessionId === sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, CTL_MAX_ITEMS)
        .map(toWireItem);
      return { t: "ctl", epoch, sessionId, items };
    },
    countRunning(op) {
      return countRunningIn(bag, op);
    },
    dispose() {
      /* the process-level table outlives any single instance/session — nothing to release here */
    },
  };
}
