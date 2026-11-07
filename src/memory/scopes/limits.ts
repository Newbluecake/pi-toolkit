/**
 * #39 P1 session-scope limits: untrusted-shape validation and the three byte budgets
 * (raw body / serialized DTO / rendered section) — arch.md §6.6, plan r1 §1.2.
 *
 * Shape FIRST, serialization SECOND: nothing here executes a getter, a toJSON, a Proxy trap
 * or any other user code while validating; only own data descriptors of plain (null- or
 * Object.prototype) records and plain arrays are read, then a FIXED-schema pure DTO is
 * rebuilt from the raw values and only that copy is ever stringified. Raw budgets count
 * UTF-8 body text; DTO/render budgets count the FINAL serialized bytes (6×raw is only the
 * conservative escape bound — the actual JSON is always measured).
 *
 * Pi-free (I8 for scopes/*, per arch §3.2). No module-scope mutable state (I4).
 */
import { createHash } from "node:crypto";
import type {
  MemoryInheritance,
  SessionMemoryCause,
  SessionMemoryEntryV1,
  SessionItem,
  MemorySeedCapture,
} from "./types.js";
import {
  FOLD_HARD_BODY_BYTES,
  FOLD_HARD_DTO_BYTES,
  FOLD_HARD_ITEMS,
  FOLD_HARD_TEXT,
  MEMORY_ENVELOPE_MAX_BYTES,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_META_MAX_BYTES,
  MEMORY_OPERATION_DTO_MAX_BYTES,
  SESSION_MEMORY_DTO_MAX_BYTES,
  SESSION_MEMORY_MAX_BODY_BYTES,
  SESSION_MEMORY_MAX_ITEMS,
} from "./types.js";

export const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** Only call on values this module rebuilt (or on primitives): never on untrusted objects. */
export const jsonUtf8Bytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

/** Deterministic key order for digests/revisions (input must already be validated pure data). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export const sha1Hex = (value: string): string => createHash("sha1").update(value, "utf8").digest("hex");
export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** `rev` of a session item (arch §6.2): sha1(canonicalJson(item))[:8], computed at fold time. */
export const sessionItemRevision = (item: SessionItem): string => sha1Hex(canonicalJson(item)).slice(0, 8);

/** Full frozen-operation digest: covers EVERY field including authority, scope and expectRev. */
export const scopedOpDigest = (operation: Record<string, unknown>): string => sha256Hex(canonicalJson(operation));
export const bodyTextDigest = (text: string): string => sha256Hex(text);

// ───────────────────────── bounded field predicates (arch §6.6 metadata table) ─────────────────────────

const SESSION_ID_RE = /^n\d{1,6}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LEAF_RE = /^[A-Za-z0-9_-]{1,64}$/; // P0 C5: real SDK entry-id samples satisfy this; NOT a path.
const HUB_ID_RE = /^[a-z0-9-]{1,48}\.\d{3}$/;
const TOPIC_RE = /^[a-z0-9-]{1,48}$/;
const STAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FROM_RE = /^(session:n\d{1,6}|project:[A-Za-z0-9._/-]{1,100})$/;
const HEX8_RE = /^[a-f0-9]{8}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

const isString = (value: unknown): value is string => typeof value === "string";
export const isSessionMemoryId = (value: unknown): value is string => isString(value) && SESSION_ID_RE.test(value);
export const isMemorySid = (value: unknown): value is string => isString(value) && SID_RE.test(value);
export const isMemoryLeafId = (value: unknown): value is string => isString(value) && LEAF_RE.test(value);
export const isHubMemoryId = (value: unknown): value is string => isString(value) && HUB_ID_RE.test(value);
export const isHubTopic = (value: unknown): value is string => isString(value) && TOPIC_RE.test(value);
export const isMemoryTimestamp = (value: unknown): value is string => isString(value) && STAMP_RE.test(value);
export const isFromRef = (value: unknown): value is string =>
  isString(value) && utf8Bytes(value) <= 120 && FROM_RE.test(value);
const isHex8 = (value: unknown): boolean => isString(value) && HEX8_RE.test(value);
const isHex64 = (value: unknown): boolean => isString(value) && HEX64_RE.test(value);
/** Approval channel strings are validated structurally; the literal never confers authority. */
export const isNonceHex = (value: unknown): boolean => isHex64(value);

// ───────────────────────── untrusted-shape traversal (no user code execution) ─────────────────────────

const MAX_DEPTH = 8;
const MAX_ARRAY = 128;
export type RawValue = string | number | boolean | null | RawRecord | RawValue[];
export interface RawRecord {
  readonly [key: string]: RawValue;
}

export type ShapeReason = "type" | "depth" | "cycle" | "prototype" | "symbol" | "accessor" | "sparse" | "array-length";

export type ShapeResult = { ok: true; value: RawValue } | { ok: false; reason: ShapeReason };

/**
 * Descriptor-read traversal of one untrusted value: plain records/arrays of own DATA
 * descriptors only. Getters/toJSON/proxies never run (their descriptors are rejected before
 * any value is touched); cycles, exotic prototypes, symbols, sparse arrays and over-deep
 * nesting are refused. Numbers must be finite integers (nextN). Depth and array length are
 * checked BEFORE recursing, so no unbounded walk is possible.
 */
export function readUntrustedShape(value: unknown, depth = 0, seen = new Set<object>()): ShapeResult {
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "string") return { ok: true, value };
  if (typeof value === "number")
    return Number.isInteger(value) && Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "type" };
  if (typeof value !== "object" || depth > MAX_DEPTH)
    return { ok: false, reason: typeof value === "object" ? "depth" : "type" };
  if (seen.has(value)) return { ok: false, reason: "cycle" };
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: "prototype" };
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false, reason: "symbol" };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out: Record<string, RawValue> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return { ok: false, reason: "accessor" };
      const inner = readUntrustedShapeWithArraySupport(descriptor.value, depth + 1, seen);
      if (!inner.ok) return inner;
      out[key] = inner.value;
    }
    return { ok: true, value: out };
  } finally {
    seen.delete(value);
  }
}

/** Array-shaped variant of {@link readUntrustedShape} (plain Array.prototype only, no holes). */
export type ArrayShapeResult = { ok: true; value: RawValue[] } | { ok: false; reason: ShapeReason };

export function readUntrustedArray(value: unknown, maxItems: number): ArrayShapeResult {
  if (typeof value !== "object" || value === null || !Array.isArray(value)) return { ok: false, reason: "type" };
  if (value.length > maxItems) return { ok: false, reason: "array-length" };
  const proto = Object.getPrototypeOf(value);
  if (proto !== Array.prototype) return { ok: false, reason: "prototype" };
  if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false, reason: "symbol" };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return { ok: false, reason: "sparse" };
  const seen = new Set<object>();
  const out: RawValue[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) return { ok: false, reason: "accessor" };
    const inner = readUntrustedShapeWithArraySupport(descriptor.value, 1, seen);
    if (!inner.ok) return inner;
    out.push(inner.value);
  }
  return { ok: true, value: out };
}

/** Records AND plain nested arrays (mirrors the DTO shapes actually used: entries carry item arrays). */
export function readUntrustedValue(value: unknown): ShapeResult {
  return readUntrustedShapeWithArraySupport(value, 0, new Set<object>());
}

function readUntrustedShapeWithArraySupport(value: unknown, depth: number, seen: Set<object>): ShapeResult {
  if (typeof value === "object" && value !== null && Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return { ok: false, reason: "array-length" };
    if (seen.has(value)) return { ok: false, reason: "cycle" };
    seen.add(value);
    try {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Array.prototype) return { ok: false, reason: "prototype" };
      if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false, reason: "symbol" };
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1) return { ok: false, reason: "sparse" };
      const out: RawValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return { ok: false, reason: "accessor" };
        const inner = readUntrustedShapeWithArraySupport(descriptor.value, depth + 1, seen);
        if (!inner.ok) return inner;
        out.push(inner.value);
      }
      return { ok: true, value: out };
    } finally {
      seen.delete(value);
    }
  }
  return readUntrustedShape(value, depth, seen);
}

// ───────────────────────── validated DTO rebuilders ─────────────────────────

export type ItemReason =
  "shape" | "field" | "id" | "authority" | "grant" | "timestamp" | "from" | "originSid" | "text-bytes" | "meta-bytes";

export interface ItemCaps {
  /** Raw body budget per item: product writes 1024, fold history 1024 (FOLD_HARD_TEXT). */
  readonly textMaxBytes: number;
}

export type ItemResult = { ok: true; item: SessionItem } | { ok: false; reason: ItemReason };

const ITEM_FIELDS = new Set(["id", "text", "authority", "grant", "created", "updated", "from", "originSid"]);

/** Validate one SessionItem from unknown data and rebuild a pure fixed-schema copy. */
export function validateSessionItem(unknown: unknown, caps: ItemCaps): ItemResult {
  const shape = readUntrustedShape(unknown);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return { ok: false, reason: "shape" };
  const record = shape.value as Record<string, RawValue>;
  for (const key of Object.keys(record)) if (!ITEM_FIELDS.has(key)) return { ok: false, reason: "field" };
  if (!isSessionMemoryId(record.id)) return { ok: false, reason: "id" };
  if (typeof record.text !== "string") return { ok: false, reason: "text-bytes" };
  if (record.authority !== "agent" && record.authority !== "user") return { ok: false, reason: "authority" };
  if (!isMemoryTimestamp(record.created) || !isMemoryTimestamp(record.updated))
    return { ok: false, reason: "timestamp" };
  if (record.from !== undefined && !isFromRef(record.from)) return { ok: false, reason: "from" };
  if (record.originSid !== undefined && !isMemorySid(record.originSid)) return { ok: false, reason: "originSid" };
  let grant: SessionItem["grant"];
  if (record.grant !== undefined) {
    const parsed = parseGrant(record.grant);
    if (parsed === undefined) return { ok: false, reason: "grant" };
    grant = parsed;
  }
  const text = record.text;
  if (utf8Bytes(text) > caps.textMaxBytes) return { ok: false, reason: "text-bytes" };
  const rebuilt: SessionItem = {
    id: record.id,
    text,
    authority: record.authority,
    ...(grant !== undefined ? { grant } : {}),
    created: record.created,
    updated: record.updated,
    ...(record.from !== undefined ? { from: record.from } : {}),
    ...(record.originSid !== undefined ? { originSid: record.originSid } : {}),
  };
  // Metadata budget: everything EXCEPT the body text, measured on the final serialization.
  const { text: _text, ...metadata } = rebuilt;
  if (jsonUtf8Bytes(metadata) > MEMORY_META_MAX_BYTES) return { ok: false, reason: "meta-bytes" };
  return { ok: true, item: rebuilt };
}

function parseGrant(unknown: RawValue): SessionItem["grant"] {
  if (typeof unknown !== "object" || unknown === null || Array.isArray(unknown)) return undefined;
  const record = unknown as Record<string, RawValue>;
  const keys = Object.keys(record);
  if (record.via === "command") {
    if (keys.length !== 1) return undefined;
    return { via: "command" };
  }
  if (record.via === "dialog") {
    if (typeof record.turn !== "string" || !isHex8(record.turn)) return undefined;
    if (typeof record.cap !== "string" || !isHex8(record.cap)) return undefined;
    if (record.channel !== undefined && record.channel !== "tui" && record.channel !== "web") return undefined;
    const expected = record.channel === undefined ? 3 : 4;
    if (keys.length !== expected) return undefined;
    return {
      via: "dialog",
      turn: record.turn,
      cap: record.cap,
      ...(record.channel !== undefined ? { channel: record.channel } : {}),
    };
  }
  return undefined;
}

export type EntryReason =
  | ItemReason
  | "v"
  | "sid"
  | "op"
  | "snap-items"
  | "snap-count"
  | "snap-dup"
  | "snap-body"
  | "snap-dto"
  | "dto-bytes"
  | "cause"
  | "inherit"
  | "nextN";
export type EntryResult = { ok: true; entry: SessionMemoryEntryV1 } | { ok: false; reason: EntryReason };

export interface EntryCaps {
  /** "write": product budgets (1024/48/8192, snap DTO 75776). "fold": FOLD_HARD history budgets. */
  readonly mode: "write" | "fold";
}

/**
 * Validate one `subagent:memory-session` entry from unknown data. A snap that fails ANY
 * check (one bad item, duplicate ids, count/body/dto overflow) is rejected WHOLE — callers
 * must never partially adopt it (arch §6.6: snap 任一 item/包装/总字节不合法 ⇒ 整条拒收).
 */
export function validateSessionEntry(unknown: unknown, caps: EntryCaps): EntryResult {
  const shape = readUntrustedValue(unknown);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return { ok: false, reason: "shape" };
  const record = shape.value as Record<string, RawValue>;
  const textMax = caps.mode === "write" ? MEMORY_ITEM_MAX_BYTES : FOLD_HARD_TEXT;
  if (record.v !== 1) return { ok: false, reason: "v" };
  if (!isMemorySid(record.sid)) return { ok: false, reason: "sid" };
  const itemCaps: ItemCaps = { textMaxBytes: textMax };
  if (record.op === "put") {
    if (Object.keys(record).some((key) => !["v", "sid", "op", "item"].includes(key)))
      return { ok: false, reason: "field" };
    const item = validateSessionItem(record.item, itemCaps);
    if (!item.ok) return { ok: false, reason: item.reason };
    const entry: SessionMemoryEntryV1 = { v: 1, sid: record.sid, op: "put", item: item.item };
    return jsonUtf8Bytes(entry) <= MEMORY_OPERATION_DTO_MAX_BYTES
      ? { ok: true, entry }
      : { ok: false, reason: "dto-bytes" };
  }
  if (record.op === "del") {
    if (Object.keys(record).some((key) => !["v", "sid", "op", "id"].includes(key)))
      return { ok: false, reason: "field" };
    if (!isSessionMemoryId(record.id)) return { ok: false, reason: "id" };
    const entry: SessionMemoryEntryV1 = { v: 1, sid: record.sid, op: "del", id: record.id };
    return jsonUtf8Bytes(entry) <= MEMORY_OPERATION_DTO_MAX_BYTES
      ? { ok: true, entry }
      : { ok: false, reason: "dto-bytes" };
  }
  if (record.op === "snap") {
    const allowed = ["v", "sid", "op", "items", "nextN", "cause", "inherit"];
    if (Object.keys(record).some((key) => !allowed.includes(key))) return { ok: false, reason: "field" };
    if (
      typeof record.nextN !== "number" ||
      !Number.isInteger(record.nextN) ||
      record.nextN < 1 ||
      record.nextN > 999999
    )
      return { ok: false, reason: "nextN" };
    let cause: SessionMemoryCause | undefined;
    if (record.cause !== undefined) {
      if (typeof record.cause !== "object" || record.cause === null || Array.isArray(record.cause))
        return { ok: false, reason: "cause" };
      const c = record.cause as Record<string, RawValue>;
      if (Object.keys(c).length !== 2 || (c.op !== "put" && c.op !== "del") || !isSessionMemoryId(c.id))
        return { ok: false, reason: "cause" };
      cause = { op: c.op, id: c.id };
    }
    let inherit: MemoryInheritance | undefined;
    if (record.inherit !== undefined) {
      if (typeof record.inherit !== "object" || record.inherit === null || Array.isArray(record.inherit))
        return { ok: false, reason: "inherit" };
      const i = record.inherit as Record<string, RawValue>;
      if (i.kind !== "spawn" || !isMemorySid(i.fromSid) || !isMemoryTimestamp(i.frozenAt))
        return { ok: false, reason: "inherit" };
      if (i.fromLeaf !== undefined && !isMemoryLeafId(i.fromLeaf)) return { ok: false, reason: "inherit" };
      const expectedKeys = i.fromLeaf === undefined ? 3 : 4;
      if (Object.keys(i).length !== expectedKeys) return { ok: false, reason: "inherit" };
      inherit = {
        kind: "spawn",
        fromSid: i.fromSid,
        ...(i.fromLeaf !== undefined ? { fromLeaf: i.fromLeaf } : {}),
        frozenAt: i.frozenAt,
      };
    }
    const maxItems = caps.mode === "write" ? SESSION_MEMORY_MAX_ITEMS : FOLD_HARD_ITEMS;
    const maxBody = caps.mode === "write" ? SESSION_MEMORY_MAX_BODY_BYTES : FOLD_HARD_BODY_BYTES;
    const maxDto = caps.mode === "write" ? SESSION_MEMORY_DTO_MAX_BYTES : FOLD_HARD_DTO_BYTES;
    const itemsShape = readUntrustedArray(record.items, maxItems);
    if (!itemsShape.ok) return { ok: false, reason: "snap-items" };
    const seen = new Set<string>();
    let bodyBytes = 0;
    const items: SessionItem[] = [];
    for (const raw of itemsShape.value) {
      const item = validateSessionItem(raw, itemCaps);
      if (!item.ok) return { ok: false, reason: item.reason };
      if (seen.has(item.item.id)) return { ok: false, reason: "snap-dup" };
      seen.add(item.item.id);
      bodyBytes += utf8Bytes(item.item.text);
      items.push(item.item);
    }
    if (bodyBytes > maxBody) return { ok: false, reason: "snap-body" };
    const entry: SessionMemoryEntryV1 = {
      v: 1,
      sid: record.sid,
      op: "snap",
      items,
      nextN: record.nextN,
      ...(cause !== undefined ? { cause } : {}),
      ...(inherit !== undefined ? { inherit } : {}),
    };
    return jsonUtf8Bytes(entry) <= maxDto ? { ok: true, entry } : { ok: false, reason: "snap-dto" };
  }
  return { ok: false, reason: "op" };
}

/**
 * Validate a MemorySeedCapture (P0 DTO) with PRODUCT budgets: every item, the array, the
 * seed wrapper AND the capture wrapper are byte-checked against the session snap DTO cap.
 */
export function validateSeedCapture(
  unknown: unknown,
): { ok: true; capture: MemorySeedCapture } | { ok: false; reason: string } {
  const shape = readUntrustedValue(unknown);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return { ok: false, reason: "shape" };
  const record = shape.value as Record<string, RawValue>;
  if (record.v !== 1) return { ok: false, reason: "v" };
  if (record.state === "empty") {
    if (Object.keys(record).length !== 2) return { ok: false, reason: "field" };
    return { ok: true, capture: { v: 1, state: "empty" } };
  }
  if (record.state !== "captured") return { ok: false, reason: "state" };
  const seedRaw = record.seed;
  if (typeof seedRaw !== "object" || seedRaw === null || Array.isArray(seedRaw)) return { ok: false, reason: "seed" };
  const seedRecord = seedRaw as Record<string, RawValue>;
  const allowed = ["v", "fromSid", "fromLeaf", "frozenAt", "items", "nextN"];
  if (Object.keys(seedRecord).some((key) => !allowed.includes(key))) return { ok: false, reason: "field" };
  if (seedRecord.v !== 1) return { ok: false, reason: "v" };
  if (!isMemorySid(seedRecord.fromSid)) return { ok: false, reason: "fromSid" };
  if (!isMemoryTimestamp(seedRecord.frozenAt)) return { ok: false, reason: "frozenAt" };
  if (seedRecord.fromLeaf !== undefined && !isMemoryLeafId(seedRecord.fromLeaf))
    return { ok: false, reason: "fromLeaf" };
  if (
    typeof seedRecord.nextN !== "number" ||
    !Number.isInteger(seedRecord.nextN) ||
    seedRecord.nextN < 1 ||
    seedRecord.nextN > 999999
  )
    return { ok: false, reason: "nextN" };
  const itemsShape = readUntrustedArray(seedRecord.items, SESSION_MEMORY_MAX_ITEMS);
  if (!itemsShape.ok) return { ok: false, reason: "items" };
  const seen = new Set<string>();
  let bodyBytes = 0;
  const items: SessionItem[] = [];
  for (const raw of itemsShape.value) {
    const item = validateSessionItem(raw, { textMaxBytes: MEMORY_ITEM_MAX_BYTES });
    if (!item.ok) return { ok: false, reason: `item:${item.reason}` };
    if (seen.has(item.item.id)) return { ok: false, reason: "dup" };
    seen.add(item.item.id);
    bodyBytes += utf8Bytes(item.item.text);
    items.push(item.item);
  }
  if (bodyBytes > SESSION_MEMORY_MAX_BODY_BYTES) return { ok: false, reason: "body-bytes" };
  const seed = {
    v: 1 as const,
    fromSid: seedRecord.fromSid,
    ...(seedRecord.fromLeaf !== undefined ? { fromLeaf: seedRecord.fromLeaf } : {}),
    frozenAt: seedRecord.frozenAt,
    items,
    nextN: seedRecord.nextN,
  };
  if (jsonUtf8Bytes(seed) > SESSION_MEMORY_DTO_MAX_BYTES) return { ok: false, reason: "seed-dto" };
  const capture: MemorySeedCapture = { v: 1, state: "captured", seed };
  if (jsonUtf8Bytes(capture) > SESSION_MEMORY_DTO_MAX_BYTES) return { ok: false, reason: "capture-dto" };
  return { ok: true, capture };
}

// ───────────────────────── envelope-budget helpers (arch §6.6 formula table) ─────────────────────────

export const RENDER_PREFIX_BUDGET_BYTES = 2048;
export const RENDER_PER_ITEM_BUDGET_BYTES = 256;

/** Render budget formula: 2048 + 6*bodyBytes + items*256 (measured values are authoritative). */
export function renderBudgetFor(items: number, bodyBytes: number): number {
  return RENDER_PREFIX_BUDGET_BYTES + 6 * bodyBytes + items * RENDER_PER_ITEM_BUDGET_BYTES;
}

export const operationDtoBudget = (): number => MEMORY_OPERATION_DTO_MAX_BYTES;
export const envelopeBudget = (): number => MEMORY_ENVELOPE_MAX_BYTES;
