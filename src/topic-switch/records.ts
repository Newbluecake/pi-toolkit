/**
 * topic-switch · persistent records + recovery decisions (plan.md §P1 "records.ts", 纯函数).
 *
 * Records live as `custom` entries (`ENTRY_TYPE`) on the session file, read
 * back through `getBranch()`. The recovery state machine mirrors the r2 R-C /
 * r3 N3 CAS: `pending → delivering → resolved` with bypass
 * `pending → cancelled | manual`; `delivering` NEVER auto-redelivers (I5) —
 * after a reload the new activation either observes the delivery (first user
 * message digest after the `delivering` record matches) or merely notifies.
 * `handoff` records are normal residue of a successful switch and never act.
 */

import { createHash } from "node:crypto";
import type { EntryLike, HeldPayload, ImageLike, Outcome, ShutdownReason, StartReason, TransferLike } from "./types.js";

export const ENTRY_TYPE = "subagent:topic-switch";

/** 单图超过此字节数（base64 长度）⇒ 不持久化，`imagesOmitted` 如实计数（R14；进程内 transfer 仍持全量）。 */
export const PAYLOAD_IMAGE_BYTES_CAP = 8 * 1024 * 1024;

/** reload 窗口内（≤60s、同 sessionId）transfer 仍可自动投递一次（I5：至多一次自动投递）。 */
export const TRANSFER_RELOAD_WINDOW_MS = 60_000;

/** notice 预览长度（码点）。 */
const PREVIEW_CHARS = 120;

const OUTCOME_VALUES: readonly string[] = Object.freeze([
  "switched",
  "stayed",
  "declined",
  "confirm-timeout",
  "confirm-cancel",
  "related",
  "judge-timeout",
  "judge-error",
  "judge-parse",
  "no-model",
  "ui-unavailable",
  "hop-timeout",
  "switch-cancelled",
  "switch-failed",
  "newcomer",
  "watchdog",
  "shutdown",
  "preflight",
]);

const SHUTDOWN_REASONS: readonly string[] = Object.freeze(["quit", "reload", "new", "resume", "fork"]);
const RESOLVE_HOWS: readonly string[] = Object.freeze(["observed", "noticed", "manual"]);

export type TopicRecord =
  | { v: 1; kind: "cooldown"; at: number; tokens: number }
  | {
      v: 1;
      kind: "outcome";
      at: number;
      holdId: string;
      outcome: Outcome;
      estUsd: number;
      prefixK: number;
      judgeMs?: number;
      confidence?: number;
    }
  | { v: 1; kind: "pending" | "handoff"; at: number; holdId: string; payload: HeldPayload; reason?: ShutdownReason }
  | { v: 1; kind: "delivering"; at: number; holdId: string }
  | { v: 1; kind: "resolved"; at: number; holdId: string; how: "observed" | "noticed" | "manual" };

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

function isNonEmptyString(raw: unknown): raw is string {
  return typeof raw === "string" && raw !== "";
}

/** sha256(text ‖ 每图 mimeType+data)，对**全量**图片计算（含被 cap 省略的），与投递内容一致。 */
export function digestOfPayload(text: string, images: readonly ImageLike[] | undefined): string {
  const hash = createHash("sha256");
  hash.update(text);
  for (const image of images ?? []) {
    hash.update(image.mimeType);
    hash.update(image.data);
  }
  return hash.digest("hex");
}

/** 组装持久化 payload：超 cap 的图片省略并计数；digest 始终覆盖全量（观测比对用）。 */
export function makePayload(text: string, images: readonly ImageLike[] | undefined): HeldPayload {
  const kept = (images ?? []).filter((image) => image.data.length <= PAYLOAD_IMAGE_BYTES_CAP);
  const omitted = (images?.length ?? 0) - kept.length;
  const digest = digestOfPayload(text, images);
  const payload: HeldPayload = { text, digest };
  if (kept.length > 0) payload.images = kept.map((image) => ({ ...image }));
  if (omitted > 0) payload.imagesOmitted = omitted;
  return payload;
}

function parseImages(raw: unknown): ImageLike[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const images: ImageLike[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return undefined;
    const rec = entry as Record<string, unknown>;
    if (rec.type !== "image" || !isNonEmptyString(rec.data) || !isNonEmptyString(rec.mimeType)) return undefined;
    images.push({ type: "image", data: rec.data, mimeType: rec.mimeType });
  }
  return images;
}

function parsePayload(raw: unknown): HeldPayload | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.text !== "string") return undefined;
  if (typeof rec.digest !== "string" || !/^[0-9a-f]{64}$/.test(rec.digest)) return undefined;
  const payload: HeldPayload = { text: rec.text, digest: rec.digest };
  if (rec.images !== undefined) {
    const images = parseImages(rec.images);
    if (images === undefined) return undefined;
    if (images.length > 0) payload.images = images;
  }
  if (rec.imagesOmitted !== undefined) {
    if (!isFiniteNumber(rec.imagesOmitted) || rec.imagesOmitted < 0 || !Number.isInteger(rec.imagesOmitted)) {
      return undefined;
    }
    payload.imagesOmitted = rec.imagesOmitted;
  }
  return payload;
}

/** 严格解析：未知 v/kind、任何字段类型/域不符 ⇒ undefined（调用方当作无记录处理）。 */
export function parseRecord(data: unknown): TopicRecord | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const r = data as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  switch (r.kind) {
    case "cooldown": {
      if (!isFiniteNumber(r.at) || !isFiniteNumber(r.tokens)) return undefined;
      return { v: 1, kind: "cooldown", at: r.at, tokens: r.tokens };
    }
    case "outcome": {
      if (!isFiniteNumber(r.at) || !isNonEmptyString(r.holdId)) return undefined;
      if (typeof r.outcome !== "string" || !OUTCOME_VALUES.includes(r.outcome)) return undefined;
      if (!isFiniteNumber(r.estUsd) || !isFiniteNumber(r.prefixK)) return undefined;
      const record: TopicRecord = {
        v: 1,
        kind: "outcome",
        at: r.at,
        holdId: r.holdId,
        outcome: r.outcome as Outcome,
        estUsd: r.estUsd,
        prefixK: r.prefixK,
      };
      if (r.judgeMs !== undefined) {
        if (!isFiniteNumber(r.judgeMs)) return undefined;
        record.judgeMs = r.judgeMs;
      }
      if (r.confidence !== undefined) {
        if (!isFiniteNumber(r.confidence)) return undefined;
        record.confidence = r.confidence;
      }
      return record;
    }
    case "pending":
    case "handoff": {
      if (!isFiniteNumber(r.at) || !isNonEmptyString(r.holdId)) return undefined;
      const payload = parsePayload(r.payload);
      if (payload === undefined) return undefined;
      const record: TopicRecord = { v: 1, kind: r.kind, at: r.at, holdId: r.holdId, payload };
      if (r.reason !== undefined) {
        if (typeof r.reason !== "string" || !SHUTDOWN_REASONS.includes(r.reason)) return undefined;
        record.reason = r.reason as ShutdownReason;
      }
      return record;
    }
    case "delivering": {
      if (!isFiniteNumber(r.at) || !isNonEmptyString(r.holdId)) return undefined;
      return { v: 1, kind: "delivering", at: r.at, holdId: r.holdId };
    }
    case "resolved": {
      if (!isFiniteNumber(r.at) || !isNonEmptyString(r.holdId)) return undefined;
      if (typeof r.how !== "string" || !RESOLVE_HOWS.includes(r.how)) return undefined;
      return { v: 1, kind: "resolved", at: r.at, holdId: r.holdId, how: r.how as "observed" | "noticed" | "manual" };
    }
    default:
      return undefined;
  }
}

export type RecoveryAction =
  | { a: "none" }
  | { a: "deliver"; holdId: string; payload: HeldPayload }
  | { a: "editor"; holdId: string; text: string }
  | { a: "resolve"; holdId: string }
  | { a: "notice"; holdId: string; preview: string };

/** 码点截断。 */
function clip(text: string, maxChars: number): string {
  let out = "";
  let count = 0;
  for (const ch of text) {
    if (count >= maxChars) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** user 消息 entry 的 payload digest（文本块拼接 + 图片块按序）；非 user 消息 ⇒ undefined。 */
export function userMessageDigest(entry: EntryLike): string | undefined {
  if (entry.type !== "message") return undefined;
  if (entry.message === null || typeof entry.message !== "object") return undefined;
  const message = entry.message as { role?: unknown; content?: unknown };
  if (message.role !== "user") return undefined;
  let text = "";
  const images: ImageLike[] = [];
  const content = message.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      else if (b.type === "image" && isNonEmptyString(b.data) && isNonEmptyString(b.mimeType)) {
        images.push({ type: "image", data: b.data, mimeType: b.mimeType });
      }
    }
  }
  return digestOfPayload(text, images);
}

interface ScannedRecord {
  index: number;
  record: TopicRecord;
}

/** planRecovery（I5）五条规则，纯函数；调用方负责执行动作并回写 resolved/notice 落盘。 */
export function planRecovery(i: {
  branch: readonly EntryLike[];
  transfer: TransferLike | undefined;
  sessionId: string;
  reason: StartReason;
  now: number;
}): RecoveryAction[] {
  const actions: RecoveryAction[] = [];

  // 规则 1/2：transfer 仍是 pending。
  const transfer = i.transfer;
  if (transfer !== undefined && transfer.state === "pending") {
    if (
      i.reason === "reload" &&
      transfer.fromSessionId === i.sessionId &&
      isFiniteNumber(transfer.at) &&
      i.now - transfer.at <= TRANSFER_RELOAD_WINDOW_MS
    ) {
      actions.push({ a: "deliver", holdId: transfer.holdId, payload: transfer.payload });
    } else if (i.reason === "new" || i.reason === "resume" || i.reason === "fork") {
      // 来自别的会话（或非 reload 起步）、从未投递过 ⇒ 只放编辑器文本；有图 ⇒ 通知里说明可 /topic-switch last --send。
      actions.push({ a: "editor", holdId: transfer.holdId, text: transfer.payload.text });
    }
  }

  // 分支扫描：按序收集本类型记录与 user 消息 entry。
  const scanned: ScannedRecord[] = [];
  for (let index = 0; index < i.branch.length; index += 1) {
    const entry = i.branch[index];
    if (entry === undefined) continue;
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const record = parseRecord(entry.data);
      if (record !== undefined) scanned.push({ index, record });
    }
  }

  const resolvedIds = new Set<string>();
  const deliveringIds = new Set<string>();
  const payloadById = new Map<string, HeldPayload>();
  for (const { record } of scanned) {
    if (record.kind === "resolved") resolvedIds.add(record.holdId);
    else if (record.kind === "delivering") deliveringIds.add(record.holdId);
    else if (record.kind === "pending" || record.kind === "handoff") {
      if (!payloadById.has(record.holdId)) payloadById.set(record.holdId, record.payload);
    }
  }

  const actedIds = new Set<string>();
  const previewOf = (holdId: string): string => {
    const payload = payloadById.get(holdId);
    return payload === undefined ? "" : clip(payload.text, PREVIEW_CHARS);
  };

  // 规则 3：每个未 resolved 的 delivering —— 其后第一条 user 消息 digest 相等 ⇒ resolve(observed)，否则 notice。
  for (const { index, record } of scanned) {
    if (record.kind !== "delivering") continue;
    if (resolvedIds.has(record.holdId) || actedIds.has(record.holdId)) continue;
    actedIds.add(record.holdId);
    const expected = payloadById.get(record.holdId)?.digest;
    let observed = false;
    for (let idx = index + 1; idx < i.branch.length; idx += 1) {
      const entry = i.branch[idx];
      if (entry === undefined) continue;
      const digest = userMessageDigest(entry);
      if (digest === undefined) continue; // 非 user 消息 entry，继续找「其后第一条」
      observed = expected !== undefined && digest === expected;
      break;
    }
    actions.push(
      observed
        ? { a: "resolve", holdId: record.holdId }
        : { a: "notice", holdId: record.holdId, preview: previewOf(record.holdId) },
    );
  }

  // 规则 4：未 resolved、无 delivering 的 pending（崩溃留下、无 transfer）⇒ notice；handoff 不触发任何动作。
  for (const { record } of scanned) {
    if (record.kind !== "pending") continue;
    if (resolvedIds.has(record.holdId) || deliveringIds.has(record.holdId) || actedIds.has(record.holdId)) continue;
    actedIds.add(record.holdId);
    actions.push({ a: "notice", holdId: record.holdId, preview: previewOf(record.holdId) });
  }

  return actions;
}
