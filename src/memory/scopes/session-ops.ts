/**
 * #39 P1 session-memory op planner: turn ONE requested put/del against a folded state into
 * EXACTLY ONE persisted entry (arch §6.2 write protocol step 3, K8).
 *
 * - `opsSinceSnap + 1 < SESSION_MEMORY_SNAPSHOT_INTERVAL (32)` ⇒ a single put/del entry;
 *   the 32nd operation since the last snap becomes a FULL snap containing this operation's
 *   effect and carrying `cause:{op,id}` — there is never a "put + extra snap" double append.
 * - The planner is authority-agnostic: capability/child rules belong to the store (P1) and
 *   the host wiring (P4). It enforces shape, per-item text, product N/B caps and rev/CAS.
 * - The FINAL entry is re-validated (actual serialized JSON bytes) before it is returned —
 *   raw UTF-8 length is never used as a JSON-size proxy.
 *
 * Pi-free, pure: `now` is injected so tests are deterministic.
 */
import type {
  FoldedSessionItem,
  FoldedSessionMemory,
  MemoryAuthority,
  ScopedMemoryErrorCode,
  SessionItem,
  SessionMemoryEntryV1,
  SessionMemoryGrant,
} from "./types.js";
import { SESSION_MEMORY_MAX_BODY_BYTES, SESSION_MEMORY_MAX_ITEMS, SESSION_MEMORY_SNAPSHOT_INTERVAL } from "./types.js";
import {
  isFromRef,
  isMemorySid,
  isSessionMemoryId,
  sessionItemRevision,
  utf8Bytes,
  validateSessionEntry,
} from "./limits.js";

export interface SessionOpPlanInput {
  readonly op: "put" | "del";
  /** put body (required for put). */
  readonly text?: string;
  /** update/del target id; absent for create. */
  readonly id?: string;
  /** required for update/delete of an existing item (CAS). */
  readonly expectRev?: string;
  readonly authority: MemoryAuthority;
  readonly grant?: SessionMemoryGrant;
  readonly from?: string;
  readonly originSid?: string;
}

export type SessionOpPlan =
  | {
      readonly ok: true;
      readonly entry: SessionMemoryEntryV1;
      readonly after: FoldedSessionMemory;
      readonly id: string;
      readonly rev?: string;
    }
  | { readonly ok: false; readonly code: ScopedMemoryErrorCode };

const findItem = (state: FoldedSessionMemory, id: string): FoldedSessionItem | undefined => {
  for (const folded of state.items) if (folded.item.id === id) return folded;
  return undefined;
};

/** Plan the single entry for one operation. Failures never mutate `state`. */
export function planSessionOp(
  state: FoldedSessionMemory,
  writerSid: string,
  input: SessionOpPlanInput,
  now: () => string,
): SessionOpPlan {
  if (!isMemorySid(writerSid)) return { ok: false, code: "E_META_INVALID" };
  if (input.from !== undefined && !isFromRef(input.from)) return { ok: false, code: "E_FROM_INVALID" };
  if (input.originSid !== undefined && !isMemorySid(input.originSid)) return { ok: false, code: "E_META_INVALID" };

  const bodyBytesAfter = (items: readonly { item: SessionItem }[], delta: number): number => {
    let total = 0;
    for (const folded of items) total += utf8Bytes(folded.item.text);
    return total + delta;
  };

  let nextItems: SessionItem[];
  let affectedId: string;
  let affectedRev: string | undefined;
  if (input.op === "put") {
    if (typeof input.text !== "string") return { ok: false, code: "E_META_INVALID" };
    if (utf8Bytes(input.text) > 1024) return { ok: false, code: "E_TOO_LARGE" };
    if (input.authority !== "agent" && input.authority !== "user") return { ok: false, code: "E_META_INVALID" };
    let target: FoldedSessionItem | undefined;
    let id: string;
    if (input.id !== undefined) {
      if (!isSessionMemoryId(input.id)) return { ok: false, code: "E_META_INVALID" };
      id = input.id;
      target = findItem(state, id);
      if (target === undefined) return { ok: false, code: "E_NOT_FOUND" };
      if (input.expectRev === undefined) return { ok: false, code: "E_REV_REQUIRED" };
      if (input.expectRev !== target.rev) return { ok: false, code: "E_CONFLICT" };
    } else {
      // Id space exhausted (internal sentinel 1_000_000, Root minor-fix 2026-11-07): refuse
      // the write (K9), never clamp-overflow onto an existing id. update/del take an explicit
      // id + rev and stay unaffected by number exhaustion.
      if (state.nextN > 999999) return { ok: false, code: "E_FULL" };
      id = `n${Math.max(1, state.nextN)}`;
      if (!isSessionMemoryId(id)) return { ok: false, code: "E_META_INVALID" };
    }
    const stamp = now();
    const item: SessionItem = {
      id,
      text: input.text,
      authority: input.authority,
      ...(input.grant !== undefined ? { grant: input.grant } : {}),
      created: target?.item.created ?? stamp,
      updated: stamp,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.originSid !== undefined ? { originSid: input.originSid } : {}),
    };
    // Product capacity: count and total raw body of the ACTIVE set (E_FULL / E_TOO_LARGE).
    if (target === undefined) {
      if (state.items.length + 1 > SESSION_MEMORY_MAX_ITEMS) return { ok: false, code: "E_FULL" };
      const delta = bodyBytesAfter(state.items, 0) + utf8Bytes(item.text);
      if (delta > SESSION_MEMORY_MAX_BODY_BYTES) return { ok: false, code: "E_TOO_LARGE" };
    } else {
      const delta = bodyBytesAfter(state.items, 0) - utf8Bytes(target.item.text) + utf8Bytes(item.text);
      if (delta > SESSION_MEMORY_MAX_BODY_BYTES) return { ok: false, code: "E_TOO_LARGE" };
    }
    nextItems = state.items.map((folded) =>
      folded.item.id === id ? { ...itemToPlain(item) } : itemToPlain(folded.item),
    );
    if (target === undefined) nextItems.push(itemToPlain(item));
    affectedId = id;
    affectedRev = sessionItemRevision(item);
  } else {
    if (input.id === undefined || !isSessionMemoryId(input.id)) return { ok: false, code: "E_META_INVALID" };
    const target = findItem(state, input.id);
    if (target === undefined) return { ok: false, code: "E_NOT_FOUND" };
    if (input.expectRev === undefined) return { ok: false, code: "E_REV_REQUIRED" };
    if (input.expectRev !== target.rev) return { ok: false, code: "E_CONFLICT" };
    nextItems = state.items.filter((folded) => folded.item.id !== input.id).map((folded) => itemToPlain(folded.item));
    affectedId = input.id;
  }

  const nextN = Math.max(state.nextN, idNumberOf(affectedId) + 1);
  const putItem: SessionItem | undefined =
    input.op === "put" ? nextItems.find((item) => item.id === affectedId) : undefined;
  let entry: SessionMemoryEntryV1;
  let opsSinceSnap: number;
  if (state.opsSinceSnap + 1 >= SESSION_MEMORY_SNAPSHOT_INTERVAL) {
    entry = {
      v: 1,
      sid: writerSid,
      op: "snap",
      items: nextItems,
      // PUBLISHED nextN stays within the validated 1..999999 field range; the internal
      // 1_000_000 exhaustion sentinel lives only in `after.nextN` and is reconstructed by
      // the fold from the n999999 item id, so no illegal public id is ever generated.
      nextN: Math.min(999999, nextN),
      cause: { op: input.op, id: affectedId },
    };
    opsSinceSnap = 0;
  } else if (input.op === "put") {
    if (putItem === undefined) return { ok: false, code: "E_META_INVALID" };
    entry = { v: 1, sid: writerSid, op: "put", item: itemToPlain(putItem) };
    opsSinceSnap = state.opsSinceSnap + 1;
  } else {
    entry = { v: 1, sid: writerSid, op: "del", id: affectedId };
    opsSinceSnap = state.opsSinceSnap + 1;
  }

  // Final serialized-DTO gate: reject (never truncate) when the actual JSON bytes overflow.
  const validated = validateSessionEntry(entry, { mode: "write" });
  if (!validated.ok) return { ok: false, code: "E_TOO_LARGE" };

  const after: FoldedSessionMemory = Object.freeze({
    items: Object.freeze(nextItems.map((item) => frozenFolded(item))),
    nextN, // may be the internal 1_000_000 exhaustion sentinel — never clamped back down
    opsSinceSnap,
    dropped: state.dropped,
  });
  return { ok: true, entry, after, id: affectedId, ...(affectedRev !== undefined ? { rev: affectedRev } : {}) };
}

/** Rebuild a plain (caller-detached) copy of a validated item — never alias folded state. */
function itemToPlain(item: SessionItem): SessionItem {
  return {
    id: item.id,
    text: item.text,
    authority: item.authority,
    ...(item.grant !== undefined ? { grant: { ...item.grant } } : {}),
    created: item.created,
    updated: item.updated,
    ...(item.from !== undefined ? { from: item.from } : {}),
    ...(item.originSid !== undefined ? { originSid: item.originSid } : {}),
  };
}

const frozenFolded = (item: SessionItem): FoldedSessionItem => ({ item, rev: sessionItemRevision(item) });

function idNumberOf(id: string): number {
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
