/**
 * Reconciliation keys shared by agent and hub (plan §包 A — frozen interface).
 *
 * spike K7 定稿：user/assistant/system/toolResult 在事件与 jsonl 两侧都有
 * `message.timestamp`，用 `role:timestamp(+toolCallId)` 对齐；custom 两型条目
 * （`custom_message` 的 content / `custom` 的 data）都无 message.timestamp，只能用
 * 内容键 `custom:<customType>:<fnv1a32(canonicalJson(payload))>`。内容键**不唯一**
 * （同 type 同内容的连续 custom 会撞键），只能配合 `reconcileRecent` /
 * `diffAppended` 的多重集对账使用 —— 持久化严格按事件顺序，尾部计数对账正确。
 */
import { Buffer } from "node:buffer";
import { LIMITS, type WireEntry, type WireMessage } from "./messages.js";

/** user/assistant/system: `role:timestamp`；toolResult 追加 `:toolCallId`；custom → customKey。 */
export function messageKey(m: WireMessage): string {
  if (m.role === "custom") {
    const customType = typeof m.customType === "string" ? m.customType : "";
    return customKey(customType, m.content);
  }
  if (m.role === "toolResult") {
    const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
    return `${m.role}:${m.timestamp ?? ""}:${toolCallId}`;
  }
  return `${m.role}:${m.timestamp ?? ""}`;
}

/** `custom:<customType>:<fnv1a32(canonicalJson(payload))>`；spike K7④ 转正：唯一可行规则，内容键可重复。 */
export function customKey(customType: string, payload: unknown): string {
  return `custom:${customType}:${fnv1a32(canonicalJson(payload))}`;
}

/** message → messageKey；custom_message → customKey(type, content)；custom → e.dataKey 已预算；其他类型 undefined。 */
export function entryKey(e: WireEntry): string | undefined {
  switch (e.type) {
    case "message":
      return e.message === undefined ? undefined : messageKey(e.message);
    case "custom_message":
      return customKey(e.customType ?? "", e.content);
    case "custom":
      return e.dataKey;
    default:
      return undefined;
  }
}

/**
 * 返回「尚未落盘」需补尾的 recent 项：对 branchTail 建 key→计数多重集，逐条 recent
 * 命中则计数-1，未命中才补尾（按 seq 升序保持出现序）。无 key 的条目不参与对账。
 */
export function reconcileRecent(
  branchTail: readonly WireEntry[], // 分支尾部最后 |recent| 条消息类条目（按序）
  recent: ReadonlyArray<{ seq: number; message: WireMessage }>, // 按 seq 升序
): Array<{ seq: number; message: WireMessage }> {
  const counts = keyCounts(branchTail);
  const out: Array<{ seq: number; message: WireMessage }> = [];
  for (const item of recent) {
    const key = messageKey(item.message);
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else out.push({ seq: item.seq, message: item.message });
  }
  return out;
}

/**
 * 多重集：tail 中 entryKey 计数超出 delivered 计数的条目（按序）⇒ 需 append 推送。
 * 用于 idle custom 等事件盲区（leaf 变化 → 读文件尾部补齐）。无 key 的条目（compaction
 * 等）不参与：它们经事件流（session_compact 等）而非 append 通道到达浏览器。
 */
export function diffAppended(delivered: readonly string[], tail: readonly WireEntry[]): WireEntry[] {
  const counts = new Map<string, number>();
  for (const key of delivered) counts.set(key, (counts.get(key) ?? 0) + 1);
  const out: WireEntry[] = [];
  for (const entry of tail) {
    const key = entryKey(entry);
    if (key === undefined) continue;
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else out.push(entry);
  }
  return out;
}

/**
 * jsonl 行 / getBranch() 条目 → WireEntry。hub（读文件）与 agent（getBranch 回落）两侧
 * 产出逐字节一致。custom(data) 投影为 `{type:"custom", customType, dataKey, display:false}`
 * （丢 data 本体）；session 头 / label / usage / session_info / context_edit 及未知类型
 * 返回 undefined；超大文本按 LIMITS.textTruncateBytes 截断并标 `truncated:true`。
 */
export function projectSessionEntry(raw: unknown): WireEntry | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.timestamp !== "string") return undefined;
  if (r.parentId !== null && typeof r.parentId !== "string") return undefined; // session 头无 parentId
  const parentId = r.parentId as string | null;
  const flag = { truncated: false };

  switch (r.type) {
    case "message": {
      const m = r.message;
      if (m === null || typeof m !== "object" || Array.isArray(m)) return undefined;
      if (typeof (m as Record<string, unknown>).role !== "string") return undefined;
      return finish(
        { id: r.id, parentId, type: "message", timestamp: r.timestamp, message: truncateDeep(m, flag) as WireMessage },
        flag,
      );
    }
    case "custom_message": {
      if (typeof r.customType !== "string") return undefined;
      const entry: WireEntry = {
        id: r.id,
        parentId,
        type: "custom_message",
        timestamp: r.timestamp,
        customType: r.customType,
        content: truncateDeep(r.content, flag),
      };
      if (typeof r.display === "boolean") entry.display = r.display;
      return finish(entry, flag);
    }
    case "custom": {
      if (typeof r.customType !== "string") return undefined;
      return {
        id: r.id,
        parentId,
        type: "custom",
        timestamp: r.timestamp,
        customType: r.customType,
        dataKey: customKey(r.customType, r.data),
        display: false,
      };
    }
    case "compaction": {
      const entry: WireEntry = { id: r.id, parentId, type: "compaction", timestamp: r.timestamp };
      if (typeof r.summary === "string") {
        const t = truncateText(r.summary, LIMITS.textTruncateBytes);
        entry.summary = t.text;
        if (t.truncated) flag.truncated = true;
      }
      if (typeof r.firstKeptEntryId === "string") entry.firstKeptEntryId = r.firstKeptEntryId;
      return finish(entry, flag);
    }
    case "branch_summary": {
      const entry: WireEntry = { id: r.id, parentId, type: "branch_summary", timestamp: r.timestamp };
      if (typeof r.summary === "string") {
        const t = truncateText(r.summary, LIMITS.textTruncateBytes);
        entry.summary = t.text;
        if (t.truncated) flag.truncated = true;
      }
      return finish(entry, flag);
    }
    case "model_change":
    case "thinking_level_change":
      return { id: r.id, parentId, type: r.type, timestamp: r.timestamp };
    default:
      return undefined; // session 头 / label / session_info / usage / context_edit / 未知
  }
}

/** Byte-limited truncation that never splits a UTF-8 code point. */
export function truncateText(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: s.length > 0 };
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  // If the byte right after the cut is a UTF-8 continuation byte, the cut split
  // a code point: back up to its lead byte.
  while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) end--;
  return { text: buf.toString("utf8", 0, end), truncated: true };
}

// --- private helpers ---

function keyCounts(entries: readonly WireEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function finish(entry: WireEntry, flag: { truncated: boolean }): WireEntry {
  if (flag.truncated) entry.truncated = true;
  return entry;
}

/** Deep-copy `value`, truncating every string to LIMITS.textTruncateBytes. */
function truncateDeep(value: unknown, flag: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    const t = truncateText(value, LIMITS.textTruncateBytes);
    if (t.truncated) flag.truncated = true;
    return t.text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, flag));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v, flag);
  return out;
}

/** Canonical JSON: recursively key-sorted, no insignificant whitespace, JSON value domain. */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "number") return JSON.stringify(value) ?? "null"; // NaN/Infinity → "null"
  if (t === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const parts: string[] = [];
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** FNV-1a 32-bit over UTF-8 bytes, lowercase hex. */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  const buf = Buffer.from(input, "utf8");
  for (let i = 0; i < buf.length; i++) {
    h ^= buf.readUInt8(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
