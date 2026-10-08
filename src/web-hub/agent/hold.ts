/**
 * Process-level hold buffer (web-hub-steer-recall plan §4.3 A1).
 *
 * Pure data + pure functions, pi-free (only imports protocol *types*). A held web steer/followUp
 * sits here, recallable, until `hold-driver.ts` hands it to pi via `commands.ts`'s
 * `dispatchHeld`. Storage mirrors `ledger.ts`'s pattern: a plain-data bag on
 * `globalThis[Symbol.for(...)]` survives a module re-evaluation (`/reload`) but never a process
 * restart (plan C10 — "台账是进程内存，不落盘").
 *
 * `HoldBuffer` never calls into pi, never schedules a timer, never knows about sessions beyond
 * the ids it is handed — every state transition is a plain, synchronous mutation. The two
 * linearization points (`takeForHandoff` and `recall`) are what make the F1 "recall vs. handoff
 * race" resolve to exactly one winner (plan §10 F1): both read-then-mutate the same `Map` entry
 * synchronously, so there is no window for both to see `state === "held"`.
 */
import type { CmdOrigin, HeldItemWire, HeldReturnReason } from "../protocol/messages.js";

export const HOLD_MAX_ITEMS = 16;
export const RETURNED_MAX_ITEMS = 16;
export const RETURNED_TTL_MS = 30 * 60_000;
export const HOLD_MAX_MS = 30 * 60_000;
/** plan §2.3 S2 / HELD_WIRE_MAX_ITEMS — the wire cap, mirrored here so `project()` never needs to
 * reach into protocol internals to clip its own output. */
const PROJECT_MAX_ITEMS = 32;
const CLIP_CHARS = 200;

export function holdWired(s: { control?: boolean; steerRecall?: boolean }): boolean {
  return s.control !== false && s.steerRecall !== false;
}

export type HoldState = "held" | "handing" | "returned";

export interface HoldItem {
  readonly cmdId: string;
  readonly sessionId: string;
  readonly owner: string; // MODULE_INSTANCE of the activate() that held it
  readonly text: string;
  readonly deliver: "steer" | "followUp";
  readonly origin: CmdOrigin;
  readonly at: number;
  state: HoldState;
  reason?: HeldReturnReason;
  updatedAt: number;
}

export type RecallOutcome =
  | { kind: "recalled"; item: HoldItem; from: "held" | "returned" }
  | { kind: "too_late" } // state === "handing"
  | { kind: "unknown" }; // not in the buffer

export interface HoldBuffer {
  /** `false` ⇔ `held(sessionId).length >= HOLD_MAX_ITEMS` (capacity refusal — caller falls back
   * to the native path). */
  hold(item: Omit<HoldItem, "state" | "updatedAt">, now: number): boolean;
  held(sessionId: string): readonly HoldItem[]; // FIFO by `at`
  countHeld(sessionId: string): number;
  /** linearization point: held → handing; undefined unless currently held. */
  takeForHandoff(cmdId: string, now: number): HoldItem | undefined;
  /** handing → removed (sent). */
  release(cmdId: string): void;
  /** held|handing → returned{reason}. Returns the items actually transitioned (already-returned
   * or unknown ids are silently skipped — idempotent). */
  markReturned(cmdIds: readonly string[], reason: HeldReturnReason, now: number): HoldItem[];
  /** every held item of `sessionId` → returned{reason}; idempotent. */
  returnSession(sessionId: string, reason: HeldReturnReason, now: number): HoldItem[];
  /** session_start of a (possibly new) module instance: foreign-owner held → returned{reload};
   *  foreign-session held → returned{session}; foreign handing → dropped (already on pi's side,
   *  i.e. removed from the buffer with no returned entry — it is pi's problem now). */
  adopt(owner: string, sessionId: string, now: number): { returned: HoldItem[]; droppedHanding: string[] };
  /** linearization point: held|returned → removed. */
  recall(cmdId: string, now: number): RecallOutcome;
  /** current session's held + every returned (any session), ascending `at`, clipped to
   * PROJECT_MAX_ITEMS/CLIP_CHARS for the wire. */
  project(sessionId: string, now: number): HeldItemWire[];
  rev(): number; // bumps on every mutation
  sweep(now: number): string[]; // evicted cmdIds (returned TTL / cap)
  dispose(): void; // process-level bag: no-op on the data itself
}

export interface HoldBag {
  v: 1;
  rev: number;
  items: Map<string, HoldItem>;
}

export interface HoldBufferOptions {
  bag?: HoldBag;
} // tests inject a fresh bag

const HOLD_BAG_KEY = Symbol.for("pi-subagent:web-hub:hold-buffer");

function isHoldBag(v: unknown): v is HoldBag {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { v?: unknown }).v === 1 &&
    typeof (v as { rev?: unknown }).rev === "number" &&
    (v as { items?: unknown }).items instanceof Map
  );
}

function processHoldBag(): HoldBag {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[HOLD_BAG_KEY];
  if (isHoldBag(existing)) return existing;
  const bag: HoldBag = { v: 1, rev: 0, items: new Map() };
  g[HOLD_BAG_KEY] = bag;
  return bag;
}

/** Clip on a UTF-16 code-point boundary (never split a surrogate pair). */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // if the char just before the cut is a high surrogate, back off one so we never split a pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function toWire(item: HoldItem): HeldItemWire {
  const w: HeldItemWire = {
    cmdId: item.cmdId,
    text: clip(item.text, CLIP_CHARS),
    deliver: item.deliver,
    state: item.state === "returned" ? "returned" : "held",
    sessionId: item.sessionId,
    at: item.at,
  };
  if (item.reason !== undefined) w.reason = item.reason;
  return w;
}

export function createHoldBuffer(opts?: HoldBufferOptions): HoldBuffer {
  const bag = opts?.bag ?? processHoldBag();

  function bump(): void {
    bag.rev += 1;
  }

  function sweepReturned(now: number): string[] {
    const evicted: string[] = [];
    const returnedIds: string[] = [];
    for (const [id, it] of bag.items) {
      if (it.state !== "returned") continue;
      returnedIds.push(id);
      if (now - it.updatedAt > RETURNED_TTL_MS) {
        bag.items.delete(id);
        evicted.push(id);
      }
    }
    if (returnedIds.length <= RETURNED_MAX_ITEMS) return evicted;
    // oldest-updated-first beyond the cap.
    const remaining = returnedIds
      .filter((id) => bag.items.has(id))
      .sort((a, b) => bag.items.get(a)!.updatedAt - bag.items.get(b)!.updatedAt);
    let over = remaining.length - RETURNED_MAX_ITEMS;
    for (const id of remaining) {
      if (over <= 0) break;
      bag.items.delete(id);
      evicted.push(id);
      over -= 1;
    }
    return evicted;
  }

  return {
    hold(item, now) {
      const count = [...bag.items.values()].filter(
        (it) => it.state === "held" && it.sessionId === item.sessionId,
      ).length;
      if (count >= HOLD_MAX_ITEMS) return false;
      const full: HoldItem = { ...item, state: "held", updatedAt: now };
      bag.items.set(item.cmdId, full);
      bump();
      return true;
    },
    held(sessionId) {
      return [...bag.items.values()]
        .filter((it) => it.state === "held" && it.sessionId === sessionId)
        .sort((a, b) => a.at - b.at);
    },
    countHeld(sessionId) {
      let n = 0;
      for (const it of bag.items.values()) if (it.state === "held" && it.sessionId === sessionId) n += 1;
      return n;
    },
    takeForHandoff(cmdId, now) {
      const it = bag.items.get(cmdId);
      if (it === undefined || it.state !== "held") return undefined;
      it.state = "handing";
      it.updatedAt = now;
      bump();
      return it;
    },
    release(cmdId) {
      if (bag.items.delete(cmdId)) bump();
    },
    markReturned(cmdIds, reason, now) {
      const out: HoldItem[] = [];
      for (const id of cmdIds) {
        const it = bag.items.get(id);
        if (it === undefined || it.state === "returned") continue;
        it.state = "returned";
        it.reason = reason;
        it.updatedAt = now;
        out.push(it);
      }
      if (out.length > 0) bump();
      return out;
    },
    returnSession(sessionId, reason, now) {
      const ids = [...bag.items.values()]
        .filter((it) => it.state === "held" && it.sessionId === sessionId)
        .map((it) => it.cmdId);
      return this.markReturned(ids, reason, now);
    },
    adopt(owner, sessionId, now) {
      const returned: HoldItem[] = [];
      const droppedHanding: string[] = [];
      for (const it of bag.items.values()) {
        if (it.state === "handing") {
          if (it.owner !== owner) {
            bag.items.delete(it.cmdId);
            droppedHanding.push(it.cmdId);
          }
          continue;
        }
        if (it.state !== "held") continue;
        if (it.owner !== owner) {
          it.state = "returned";
          it.reason = "reload";
          it.updatedAt = now;
          returned.push(it);
          continue;
        }
        if (it.sessionId !== sessionId) {
          it.state = "returned";
          it.reason = "session";
          it.updatedAt = now;
          returned.push(it);
        }
      }
      if (returned.length > 0 || droppedHanding.length > 0) bump();
      return { returned, droppedHanding };
    },
    recall(cmdId, now) {
      const it = bag.items.get(cmdId);
      if (it === undefined) return { kind: "unknown" };
      if (it.state === "handing") return { kind: "too_late" };
      const from: "held" | "returned" = it.state === "returned" ? "returned" : "held";
      bag.items.delete(cmdId);
      bump();
      return { kind: "recalled", item: it, from };
    },
    project(sessionId, now) {
      sweepReturned(now);
      const rows = [...bag.items.values()]
        .filter((it) => (it.state === "held" && it.sessionId === sessionId) || it.state === "returned")
        .sort((a, b) => a.at - b.at)
        .slice(-PROJECT_MAX_ITEMS)
        .map(toWire);
      return rows;
    },
    rev() {
      return bag.rev;
    },
    sweep(now) {
      return sweepReturned(now);
    },
    dispose() {
      /* process-level bag outlives any single instance — nothing to release */
    },
  };
}
