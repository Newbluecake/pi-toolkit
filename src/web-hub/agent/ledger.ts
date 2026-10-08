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

export type PromptSubState =
  | "dispatched"
  | "observed"
  | "started"
  | "queued"
  | "consumed"
  | "dropped"
  | "unconfirmed"
  | "held"
  | "recalled"
  | "returned";
export type PromptBehavior = "idle" | "steer" | "followUp";
export type PromptReason =
  "unobserved" | "not-started" | "not-delivered" | "session" | "timeout" | "aborted" | "reload" | "stale";
/** promptState values that still need the matching `text` (v4.3 Y6.2 + verifier r_BHFA552J P1):
 * `dispatched`/`unconfirmed` are what `findDispatchedByText` matches against, and `unconfirmed`
 * must keep the FULL text until a late observation/consumption upgrades or drops it (R-A/M27).
 * `observed` also keeps it (pre-existing behavior, unrelated to steer-recall: the idle-watch path
 * matches on it). `queued` now ALSO keeps it so `findQueuedByText`'s hold-attributed consumption
 * lookup (Y7.3) has something to match against between "queued" and "consumed". Every other state
 * no longer needs it. */
const TEXT_RETAINING_STATES: ReadonlySet<PromptSubState> = new Set(["dispatched", "observed", "queued", "unconfirmed"]);
/** v4.3 §4.5 rule: a ledger entry pinned at `promptState:"held"` must not be evicted by TTL/
 * capacity churn while it is still plausibly held (hold.ts's own HOLD_MAX_MS is 30 min; this is a
 * generous 60 min defensive backstop in case the buffer and ledger ever disagree). */
const HELD_EVICTION_GRACE_MS = 60 * 60_000;

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
  /** v4.3 Y4/Y7.3: the MODULE_INSTANCE that created this entry (undefined for callers that don't
   * care, e.g. non-prompt ops) — `findDispatchedByText`'s scope check so a stale owner's (pre-
   * `/reload`) dispatched entry never matches a new owner's incoming `input` event. */
  owner?: string;
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
    extra?: { text?: string; runId?: string; sessionId?: string; owner?: string },
  ): BeginOutcome;
  get(id: string): LedgerEntry | undefined;
  /** Settle a running entry to a terminal state. A retryable, effect:"none" failure is deleted
   * instead of cached (D7 rule 2) so a retry re-executes from scratch. `opts.late` marks this as
   * a post-timeout settlement (driving `cmd_late`, D15). */
  settle(id: string, result: LedgerResult, now: number, opts?: { late?: true }): void;
  /** Advance the prompt sub-state track (§4.3) without touching the generic `state`/`result`. */
  updatePrompt(
    id: string,
    patch: Partial<Pick<LedgerEntry, "promptState" | "behavior" | "reason" | "text">>,
    now: number,
  ): void;
  /** v4.3 Y4/Y7.3 (verifier r_BHFA552J P2): scope is OPTIONAL and selects between two genuinely
   * different matching strategies, not just a stricter filter on the same one — passing `scope`
   * must be BYTE-IDENTICAL to the pre-steer-recall behavior for every caller that still omits it
   * (the native, non-hold prompt path keeps the original "earliest `at`" tie-break and never scans
   * for ambiguity across sessions/owners). Only the hold-aware caller (`onInputEvent`, when a hold
   * driver is actually attached) passes `scope`, switching to: entries matching `text` +
   * `promptState ∈ {dispatched, unconfirmed}`, filtered by `sessionId`/`owner`, where MORE THAN
   * ONE candidate after that filter is AMBIGUOUS and returns `undefined` — never "pick the
   * earliest" (no attribution happens; the caller leaves every candidate as-is and B1 stays
   * blocked until a later, unambiguous signal or `agent_end`'s unconditional return). */
  findDispatchedByText(text: string, scope?: { sessionId: string; owner?: string }): LedgerEntry | undefined;
  /** verifier r_BHFA552J P1 (Y7.3): the hold-attributed CONSUMPTION-time counterpart of
   * `findDispatchedByText` — same scope+ambiguity-safety contract, but matches `promptState ===
   * "queued"` (the state a web item sits in while mirrored in `queue-mirror.ts`, between
   * `onInputEvent`'s enqueue and `onMessageStart`'s consumption). Scope is NOT optional here: this
   * method only exists for the hold-aware caller (there is no legacy native-path equivalent to stay
   * byte-identical with). Ambiguous (≥2 candidates) or no match ⇒ `undefined` — the caller's
   * contract is to dequeue NOTHING and attribute NOTHING in that case, never guess. */
  findQueuedByText(text: string, scope: { sessionId: string; owner?: string }): LedgerEntry | undefined;
  query(id: string): LedgerQuerySnapshot | undefined;
  frame(sessionId: string, epoch: string, now: number, opts?: { filterHeld?: boolean }): CtlFrame;
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

/** A `held` entry is never swept purely by "it's terminal and old" logic within its grace window
 * (§4.5 rule — v4.3): the generic `state` goes `ok` immediately (D5: prompt's HTTP reply is
 * unconditionally ok), so without this guard a busy ledger could otherwise evict a row that's
 * still conceptually held well before hold.ts's own 30 min cap gets a chance to resolve it. */
function heldWithinGrace(e: LedgerEntry, now: number): boolean {
  return e.promptState === "held" && now - e.updatedAt <= HELD_EVICTION_GRACE_MS;
}

/** Evict TTL-expired terminal entries, then oldest-terminal-first down to capacity. Running
 * entries are never evicted (D7: "只淘汰终态项"). */
function sweep(bag: LedgerBag, now: number): void {
  for (const [id, e] of bag.entries) {
    if (e.state === "running" || heldWithinGrace(e, now)) continue;
    if (now - e.updatedAt > LEDGER_TTL_MS) bag.entries.delete(id);
  }
  const over = bag.entries.size - LEDGER_CAPACITY;
  if (over <= 0) return;
  const terminal = [...bag.entries.values()]
    .filter((e) => e.state !== "running" && !heldWithinGrace(e, now))
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
        if (extra?.owner !== undefined) entry.owner = extra.owner;
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
      if (patch.promptState !== undefined && !TEXT_RETAINING_STATES.has(patch.promptState)) {
        delete e.text; // v4.3 Y6.2: only dispatched/observed/unconfirmed still need it.
      }
    },
    findDispatchedByText(text, scope) {
      if (scope === undefined) {
        // pre-steer-recall, byte-identical native-path behavior (verifier r_BHFA552J P2): earliest
        // still-dispatched entry, no session/owner scoping, no ambiguity rejection.
        let best: LedgerEntry | undefined;
        for (const e of bag.entries.values()) {
          if (e.text !== text || e.promptState !== "dispatched") continue;
          if (best === undefined || e.at < best.at) best = e;
        }
        return best;
      }
      let match: LedgerEntry | undefined;
      let ambiguous = false;
      for (const e of bag.entries.values()) {
        if (e.text !== text) continue;
        if (e.promptState !== "dispatched" && e.promptState !== "unconfirmed") continue;
        if (e.sessionId !== undefined && e.sessionId !== scope.sessionId) continue;
        if (e.owner !== undefined && scope.owner !== undefined && e.owner !== scope.owner) continue;
        if (match !== undefined) {
          ambiguous = true;
          break;
        }
        match = e;
      }
      return ambiguous ? undefined : match;
    },
    findQueuedByText(text, scope) {
      let match: LedgerEntry | undefined;
      let ambiguous = false;
      for (const e of bag.entries.values()) {
        if (e.text !== text) continue;
        if (e.promptState !== "queued") continue;
        if (e.sessionId !== undefined && e.sessionId !== scope.sessionId) continue;
        if (e.owner !== undefined && scope.owner !== undefined && e.owner !== scope.owner) continue;
        if (match !== undefined) {
          ambiguous = true;
          break;
        }
        match = e;
      }
      return ambiguous ? undefined : match;
    },
    query(id) {
      const e = bag.entries.get(id);
      if (e === undefined) return undefined;
      const out: LedgerQuerySnapshot = { state: e.state };
      if (e.late === true) out.late = true;
      if (e.result !== undefined) out.result = e.result;
      return out;
    },
    frame(sessionId, epoch, now, opts) {
      sweep(bag, now);
      const filterHeld = opts?.filterHeld === true;
      let candidates = [...bag.entries.values()].filter((e) => e.sessionId === undefined || e.sessionId === sessionId);
      if (filterHeld) candidates = candidates.filter((e) => e.op !== "recall");
      candidates = candidates.sort((a, b) => b.updatedAt - a.updatedAt);
      const items: CtlItemWire[] = [];
      for (const e of candidates) {
        if (items.length >= CTL_MAX_ITEMS) break;
        const wire = toWireItem(e);
        if (filterHeld) {
          // v4.3 §4.5: downgrade every new-only (hold.v1) vocabulary member to the nearest
          // pre-existing equivalent so a hub/UI with no hold.v1 cap (closed CtlItemSchema) never
          // sees a state/reason it can't parse.
          if (wire.state === "held") continue;
          if (wire.state === "recalled" || wire.state === "returned") {
            wire.state = "dropped";
            wire.reason = "not-delivered";
          } else if (wire.reason === "aborted" || wire.reason === "reload" || wire.reason === "stale") {
            wire.reason = "not-delivered";
          }
        }
        items.push(wire);
      }
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
