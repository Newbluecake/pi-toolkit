/**
 * Event tap (plan §包 D — event-tap.ts; arch §4.1.1).
 *
 * Projects pi extension events onto the whitelisted wire shape, synchronously.
 * Hot-path rules:
 *  - `message_update` never touches the accumulated `event.message` nor the
 *    `partial`/`message`/`error` snapshots inside `assistantMessageEvent`: only
 *    the delta itself is forwarded (delta-only), and consecutive deltas of the
 *    same kind/contentIndex are coalesced for `LIMITS.deltaCoalesceMs` (50ms);
 *  - `tool_execution_update` is latest-wins per toolCallId, flushed every
 *    `LIMITS.toolUpdateMs` (250ms) — the (growing) partial result is projected
 *    once per flush, not once per update;
 *  - every forwarded string is capped at `LIMITS.textTruncateBytes` (64 KiB)
 *    and marked `truncated:true` (the jsonl history stays authoritative).
 * Any pending delta is flushed before a non-delta event so the wire order
 * matches pi's order.
 */
import { LIMITS, type FORWARDED_EVENTS, type InflightState, type SnapshotReplyBody } from "../protocol/messages.js";
import type { WireEvent, WireMessage } from "../protocol/messages.js";
import { truncateText } from "../protocol/keys.js";
import { ASK_USER_MARKER } from "../../ask-user/channel-handler.js";

export interface EventTap {
  handle(event: { type: string } & Record<string, unknown>): void;
  recent(): SnapshotReplyBody["recent"];
  inflight(): InflightState | undefined;
  prompts(): SnapshotReplyBody["prompts"];
  /** Session cost so far; NaN while the base (branch sum) is not known yet. */
  costUsd(): number;
  resetForSession(initialCostUsd: number): void;
  /** Set the branch-sum base cost later (attach computes it in setImmediate). */
  setBaseCost(usd: number): void;
  /** Emit every coalesced delta / pending tool update now (before a snapshot takes its seq). */
  flush(): void;
  /** Tool-duration plan: per-toolCallId durations (agent clock) completed since the last drain —
   *  the caller (web-hub wiring) persists them as `subagent:web-tool-timing` entries at
   *  `turn_end`. Returns and CLEARS the accumulated map (empty when nothing completed). */
  drainToolTimings(): Map<string, number>;
  dispose(): void;
}

type ForwardedType = (typeof FORWARDED_EVENTS)[number];

const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface PendingDelta {
  type: string;
  contentIndex: number;
  delta: string;
}

interface InflightTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  latestPartial?: unknown;
  hasPartial: boolean;
  /** Agent-clock epoch ms of `tool_execution_start`; absent when only an update was seen. */
  startedAt?: number;
}

export function createEventTap(
  sink: (e: WireEvent, droppable: boolean) => void,
  opts: {
    now: () => number;
    setTimer: (ms: number, fn: () => void) => { cancel(): void };
    /** seq of the ev frame the sink just emitted (recent[] carries it for snapshot reconciliation). */
    currentSeq?: () => number;
    attributePrompt?: (event: WireEvent) => WireEvent;
  },
): EventTap {
  const currentSeq = opts.currentSeq ?? (() => 0);
  const attributePrompt = opts.attributePrompt ?? ((event) => event);
  let recentRing: Array<{ seq: number; message: WireMessage }> = [];
  let inflightMessage: unknown;
  const tools = new Map<string, InflightTool>();
  let promptStack: Array<{ kind: string; title?: string; since: number; dialogId?: string }> = [];
  let baseCost = 0;
  let addedCost = 0;
  // Tool-duration plan: toolCallId → durationMs for tools whose `tool_execution_end` fired
  // since the last drain (persisted by the wiring at `turn_end`; cleared on session reset).
  let completedTimings = new Map<string, number>();

  let pendingDeltas: PendingDelta[] = [];
  let deltaTimer: { cancel(): void } | undefined;
  const pendingToolUpdates = new Map<string, InflightTool>();
  let toolTimer: { cancel(): void } | undefined;

  const emit = (e: WireEvent, droppable: boolean): void => {
    try {
      sink(e, droppable);
    } catch {
      /* sink errors never reach pi */
    }
  };

  const flushDeltas = (): void => {
    deltaTimer?.cancel();
    deltaTimer = undefined;
    if (pendingDeltas.length === 0) return;
    const batch = pendingDeltas;
    pendingDeltas = [];
    for (const d of batch) {
      const t = truncateText(d.delta, LIMITS.textTruncateBytes);
      const ame: Record<string, unknown> = { type: d.type, contentIndex: d.contentIndex, delta: t.text };
      if (t.truncated) ame.truncated = true;
      emit({ type: "message_update", assistantMessageEvent: ame }, true);
    }
  };

  const flushToolUpdates = (): void => {
    toolTimer?.cancel();
    toolTimer = undefined;
    if (pendingToolUpdates.size === 0) return;
    const batch = [...pendingToolUpdates.values()];
    pendingToolUpdates.clear();
    for (const t of batch) {
      const flag = { truncated: false };
      const e: WireEvent = {
        type: "tool_execution_update",
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        partialResult: truncateDeep(t.latestPartial, flag),
      };
      if (flag.truncated) e.truncated = true;
      emit(e, true);
    }
  };

  const flushAll = (): void => {
    flushDeltas();
    flushToolUpdates();
  };

  const onMessageUpdate = (event: Record<string, unknown>): void => {
    // Deliberately read ONLY `assistantMessageEvent` — never `event.message`.
    const ame = event.assistantMessageEvent;
    if (ame === null || typeof ame !== "object") return;
    const a = ame as Record<string, unknown>;
    const type = typeof a.type === "string" ? a.type : "";
    const contentIndex = typeof a.contentIndex === "number" ? a.contentIndex : -1;
    if (DELTA_TYPES.has(type)) {
      const delta = typeof a.delta === "string" ? a.delta : "";
      const last = pendingDeltas[pendingDeltas.length - 1];
      if (last !== undefined && last.type === type && last.contentIndex === contentIndex) last.delta += delta;
      else pendingDeltas.push({ type, contentIndex, delta });
      if (deltaTimer === undefined) deltaTimer = opts.setTimer(LIMITS.deltaCoalesceMs, flushDeltas);
      return;
    }
    flushDeltas();
    const out: Record<string, unknown> = { type };
    if (contentIndex >= 0) out.contentIndex = contentIndex;
    const flag = { truncated: false };
    if (type === "text_end" || type === "thinking_end") {
      out.content = truncateDeep(typeof a.content === "string" ? a.content : "", flag);
    } else if (type === "toolcall_end") {
      out.toolCall = truncateDeep(a.toolCall, flag);
    } else if (type === "done" || type === "error") {
      if (typeof a.reason === "string") out.reason = a.reason;
    }
    if (flag.truncated) out.truncated = true;
    emit({ type: "message_update", assistantMessageEvent: out }, false);
  };

  const handle = (event: { type: string } & Record<string, unknown>): void => {
    try {
      const type = event.type;
      if (type === "message_update") {
        // Keep a reference only (no property reads): the snapshot projects it lazily.
        inflightMessage = event.message;
        onMessageUpdate(event);
        return;
      }
      if (type === "tool_execution_update") {
        const id = str(event.toolCallId);
        const tool = tools.get(id) ?? {
          toolCallId: id,
          toolName: str(event.toolName),
          args: undefined,
          hasPartial: false,
        };
        tool.latestPartial = event.partialResult;
        tool.hasPartial = true;
        tools.set(id, tool);
        pendingToolUpdates.set(id, tool);
        if (toolTimer === undefined) toolTimer = opts.setTimer(LIMITS.toolUpdateMs, flushToolUpdates);
        return;
      }
      flushDeltas();
      const wire = project(type, event);
      if (wire === undefined) return;
      emit(wire, false);
    } catch {
      /* projection must never throw into pi */
    }
  };

  const project = (type: string, event: Record<string, unknown>): WireEvent | undefined => {
    const flag = { truncated: false };
    let e: WireEvent | undefined;
    switch (type as ForwardedType) {
      case "agent_start":
      case "agent_end":
      case "agent_settled":
        e = { type: type as ForwardedType };
        break;
      case "turn_start":
        e = pick(type, event, ["turnIndex", "timestamp"]);
        break;
      case "turn_end":
        e = pick(type, event, ["turnIndex", "messageEntryId", "toolResultEntryIds"]);
        break;
      case "message_start": {
        const message = projectMessage(event.message, flag);
        if (message?.role === "assistant") inflightMessage = event.message;
        e = { type: "message_start", message };
        break;
      }
      case "message_end": {
        const message = projectMessage(event.message, flag);
        e = { type: "message_end", message };
        if (flag.truncated) e.truncated = true;
        emit(e, false);
        if (message !== undefined) {
          recentRing.push({ seq: currentSeq(), message });
          if (recentRing.length > LIMITS.recentMessages) recentRing = recentRing.slice(-LIMITS.recentMessages);
          if (message.role === "assistant") {
            inflightMessage = undefined;
            addedCost += assistantCost(message);
          }
        }
        return undefined;
      }
      case "tool_execution_start": {
        const id = str(event.toolCallId);
        const startedAt = opts.now();
        tools.set(id, {
          toolCallId: id,
          toolName: str(event.toolName),
          args: event.args,
          hasPartial: false,
          startedAt,
        });
        e = {
          type: "tool_execution_start",
          toolCallId: id,
          toolName: str(event.toolName),
          args: truncateDeep(event.args, flag),
          ...(Number.isFinite(startedAt) ? { startedAt } : {}),
        };
        break;
      }
      case "tool_execution_end": {
        const id = str(event.toolCallId);
        const prev = tools.get(id);
        const endedAt = opts.now();
        // durationMs only when the start was seen on this clock (≥0, finite — a backwards
        // clock clamps to 0, never negative); an end without a start stays duration-less.
        const raw = prev !== undefined && prev.startedAt !== undefined ? endedAt - prev.startedAt : undefined;
        const durationMs = raw !== undefined && Number.isFinite(raw) ? Math.max(0, raw) : undefined;
        tools.delete(id);
        pendingToolUpdates.delete(id); // end supersedes any pending partial
        if (durationMs !== undefined) completedTimings.set(id, durationMs);
        e = {
          type: "tool_execution_end",
          toolCallId: id,
          toolName: str(event.toolName),
          isError: event.isError === true,
          result: truncateDeep(event.result, flag),
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        break;
      }
      case "session_compact": {
        const ce = event.compactionEntry;
        const entry: Record<string, unknown> = {};
        if (ce !== null && typeof ce === "object") {
          const c = ce as Record<string, unknown>;
          if (typeof c.id === "string") entry.id = c.id;
          if (typeof c.summary === "string") entry.summary = truncateDeep(c.summary, flag);
          if (typeof c.firstKeptEntryId === "string" || c.firstKeptEntryId === null) {
            entry.firstKeptEntryId = c.firstKeptEntryId;
          }
          if (typeof c.timestamp === "string") entry.timestamp = c.timestamp;
        }
        e = { ...pick(type, event, ["reason", "fromExtension", "willRetry"]), compactionEntry: entry };
        break;
      }
      case "session_compact_failed":
        e = pick(type, event, ["reason", "errorMessage", "aborted", "willRetry"]);
        break;
      case "model_select": {
        e = pick(type, event, ["source"]);
        const m = modelRef(event.model);
        if (m !== undefined) e.model = m;
        const p = modelRef(event.previousModel);
        if (p !== undefined) e.previousModel = p;
        break;
      }
      case "thinking_level_select":
        e = pick(type, event, ["level", "previousLevel"]);
        break;
      case "session_info_changed":
        e = pick(type, event, ["name"]);
        break;
      case "input": {
        e = pick(type, event, ["source", "streamingBehavior"]);
        e.text = truncateDeep(typeof event.text === "string" ? event.text : "", flag);
        if (Array.isArray(event.images)) e.imageCount = event.images.length;
        break;
      }
      case "ui_prompt_start": {
        const kind = str(event.kind);
        const raw = pick(type, event, ["kind", "title"]);
        const attributed = attributePrompt(raw);
        // The RPC marker is an implementation detail.  It is useful to the
        // bridge while matching, but must never be sent to the browser (even
        // when a stale event arrives after its dialog was closed).
        if (kind === "select" && attributed.title === ASK_USER_MARKER) attributed.title = "ask_user";
        const p: { kind: string; title?: string; since: number; dialogId?: string } = {
          kind,
          since: opts.now(),
        };
        if (typeof attributed.title === "string") p.title = attributed.title;
        if (typeof attributed.dialogId === "string") p.dialogId = attributed.dialogId;
        promptStack.push(p);
        e = attributed;
        break;
      }
      case "ui_prompt_end": {
        const kind = str(event.kind);
        const title = typeof event.title === "string" ? event.title : undefined;
        let dialogId: string | undefined;
        for (let i = promptStack.length - 1; i >= 0; i -= 1) {
          const p = promptStack[i]!;
          if (
            p.kind === kind &&
            (title === undefined || p.title === title || (title === ASK_USER_MARKER && p.title === "ask_user"))
          ) {
            dialogId = p.dialogId;
            promptStack.splice(i, 1);
            break;
          }
        }
        e = pick(type, event, ["kind", "title"]);
        if (e.title === ASK_USER_MARKER) e.title = "ask_user";
        if (dialogId !== undefined) e.dialogId = dialogId;
        break;
      }
      default:
        return undefined; // not whitelisted
    }
    if (flag.truncated) e.truncated = true;
    return e;
  };

  const resetState = (): void => {
    deltaTimer?.cancel();
    deltaTimer = undefined;
    toolTimer?.cancel();
    toolTimer = undefined;
    pendingDeltas = [];
    pendingToolUpdates.clear();
    recentRing = [];
    inflightMessage = undefined;
    tools.clear();
    promptStack = [];
    completedTimings.clear();
  };

  return {
    handle,
    recent: () => recentRing.slice(),
    inflight: () => {
      const message = inflightMessage === undefined ? undefined : projectMessage(inflightMessage, { truncated: false });
      if (message === undefined && tools.size === 0) return undefined;
      const state: InflightState = {
        tools: [...tools.values()].map((t) => {
          const row: InflightState["tools"][number] = {
            toolCallId: t.toolCallId,
            toolName: t.toolName,
            args: truncateDeep(t.args, { truncated: false }),
          };
          if (t.hasPartial) row.partial = partialText(t.latestPartial);
          return row;
        }),
      };
      if (message !== undefined) state.message = message;
      return state;
    },
    prompts: () => promptStack.map((p) => ({ ...p })) as SnapshotReplyBody["prompts"],
    costUsd: () => baseCost + addedCost,
    resetForSession: (initialCostUsd: number) => {
      resetState();
      baseCost = initialCostUsd;
      addedCost = 0;
    },
    setBaseCost: (usd: number) => {
      baseCost = usd;
    },
    flush: flushAll,
    drainToolTimings: () => {
      const out = completedTimings;
      completedTimings = new Map<string, number>(); // swap: every call returns an owned map
      return out;
    },
    dispose: resetState,
  };
}

// ------------------------------------------------------------------ helpers

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function pick(type: string, event: Record<string, unknown>, keys: readonly string[]): WireEvent {
  const out: WireEvent = { type: type as ForwardedType };
  for (const k of keys) {
    const v = event[k];
    if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
      out[k] = Array.isArray(v) ? v.filter((x) => typeof x !== "object") : v;
    }
  }
  return out;
}

function modelRef(m: unknown): { provider: string; id: string } | undefined {
  if (m === null || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  return typeof o.provider === "string" && typeof o.id === "string" ? { provider: o.provider, id: o.id } : undefined;
}

/** Deep-copy a pi message into a WireMessage with every string capped at 64 KiB. */
export function projectMessage(m: unknown, flag: { truncated: boolean }): WireMessage | undefined {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return undefined;
  if (typeof (m as Record<string, unknown>).role !== "string") return undefined;
  return truncateDeep(m, flag) as WireMessage;
}

function assistantCost(m: WireMessage): number {
  const usage = m.usage;
  if (usage === null || typeof usage !== "object") return 0;
  const cost = (usage as Record<string, unknown>).cost;
  if (cost === null || typeof cost !== "object") return 0;
  const total = (cost as Record<string, unknown>).total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/** Text of a tool partial result (`{content:[{type:"text",text}]}` or a string), capped. */
function partialText(v: unknown): string {
  let text = "";
  if (typeof v === "string") text = v;
  else if (v !== null && typeof v === "object") {
    const content = (v as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      text = content
        .map((c) =>
          c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
            ? ((c as Record<string, unknown>).text as string)
            : "",
        )
        .join("");
    }
  }
  return truncateText(text, LIMITS.textTruncateBytes).text;
}

const MAX_DEPTH = 32;

/** Deep JSON-domain copy with every string capped at LIMITS.textTruncateBytes. */
export function truncateDeep(value: unknown, flag: { truncated: boolean }, depth = 0): unknown {
  if (typeof value === "string") {
    const t = truncateText(value, LIMITS.textTruncateBytes);
    if (t.truncated) flag.truncated = true;
    return t.text;
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ? undefined : value;
  }
  if (depth >= MAX_DEPTH) {
    flag.truncated = true;
    return null;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, flag, depth + 1));
  const rec = value as Record<string, unknown>;
  if (rec.type === "image" && typeof rec.data === "string" && rec.data.length > 0) {
    // base64 image payloads are never forwarded (the browser shows a placeholder).
    flag.truncated = true;
    return typeof rec.mimeType === "string"
      ? { type: "image", mimeType: rec.mimeType, data: "" }
      : { type: "image", data: "" };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    const c = truncateDeep(v, flag, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
