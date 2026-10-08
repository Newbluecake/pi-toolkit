/**
 * Transcript item → view model (ui-design.md §5.4, vue-plan.md v2.1 §3.1/§3.2/§5.2 — P4). A TS
 * port of `@logic/render/transcript.js`'s `renderTranscript()`/`renderItem()` *control flow*
 * (same ordering, same skip rules — orphan `toolResult`s already shown inside their tool card,
 * `display:false` custom messages, etc.) with the DOM-building swapped for plain data so
 * `Transcript.vue`'s template can `v-for` over it. Reuses the legacy file's exported pure
 * functions (`messageText`, `itemRenderKey`) and `render/tools.js`'s `toolView`/`safeJson`, plus
 * `state.js`'s `resultText` — never re-implements them. `indexTools` is duplicated from
 * `tool-index.ts` (see that file's header for why).
 * Scroll-memory anchors (`anchors`/`anchorIdsOf`, E1-1): docs/dev/web-hub-session-switch/plan.md §1.4.
 */
import { itemRenderKey, messageText } from "@logic/transcript.js";
import { safeJson, toolView } from "@logic/tools.js";
import { resultText, messageKey } from "@logic/state.js";
import type { Item, ToolView } from "../../types.js";
import type { TranscriptSource } from "../../contracts.js";
import { indexTools, type ToolIndex } from "./tool-index.js";

export type AssistantBlockView =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "toolCall"; readonly view: ToolView }
  | { readonly kind: "image" };

export interface AssistantView {
  readonly blocks: readonly AssistantBlockView[];
  readonly model: string;
  readonly costUsd: number | undefined;
  readonly streaming: boolean;
  readonly errorText: string;
  readonly timestamp: number | undefined;
}

export type TxEntry =
  | { readonly type: "compaction"; readonly key: string; readonly summary: string; readonly truncated: boolean }
  | { readonly type: "branchSummary"; readonly key: string; readonly summary: string; readonly truncated: boolean }
  | { readonly type: "modelChange"; readonly key: string; readonly model: string }
  | {
      readonly type: "custom";
      readonly key: string;
      readonly customType: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly type: "user";
      readonly key: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly timestamp: number | undefined;
    }
  | { readonly type: "assistant"; readonly key: string; readonly assistant: AssistantView; readonly truncated: boolean }
  | { readonly type: "toolOrphan"; readonly key: string; readonly view: ToolView }
  | {
      readonly type: "other";
      readonly key: string;
      readonly role: string;
      readonly text: string;
      readonly truncated: boolean;
    };

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x !== "";
}

function assistantBlocks(m: Record<string, unknown>, idx: ToolIndex): AssistantBlockView[] {
  const content: unknown[] =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const out: AssistantBlockView[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && isNonEmptyString(block.thinking)) {
      // Claude may emit several consecutive thinking blocks in one message (each with its own
      // signature); rendering each as its own pill shows two "Thinking" headers back to back.
      // Merge adjacent ones into a single block — they are one continuous chain of thought.
      const prev = out[out.length - 1];
      if (prev?.kind === "thinking") {
        out[out.length - 1] = { kind: "thinking", text: `${prev.text.trimEnd()}\n\n${block.thinking}` };
      } else {
        out.push({ kind: "thinking", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const id = typeof block.id === "string" ? block.id : "";
      out.push({
        kind: "toolCall",
        view: toolView(block, idx.results.get(id), idx.live.get(id), idx.durations) as ToolView,
      });
    } else if (block.type === "image") {
      out.push({ kind: "image" });
    }
  }
  return out;
}

function assistantView(m: Record<string, unknown>, idx: ToolIndex, streaming: boolean): AssistantView {
  const usage = m.usage as { cost?: { total?: unknown } } | undefined;
  const cost = usage?.cost?.total;
  const errorMessage = m.errorMessage;
  const timestamp = m.timestamp;
  return {
    blocks: assistantBlocks(m, idx),
    model: typeof m.model === "string" ? m.model : "",
    costUsd: typeof cost === "number" ? cost : undefined,
    streaming,
    errorText: m.stopReason === "error" && isNonEmptyString(errorMessage) ? errorMessage : "",
    timestamp: typeof timestamp === "number" ? timestamp : undefined,
  };
}

function itemEntry(it: Item, idx: ToolIndex): TxEntry | undefined {
  const truncated = it.truncated === true;
  switch (it.kind) {
    case "compaction": {
      const summary = it.entry?.summary;
      return { type: "compaction", key: it.id, summary: typeof summary === "string" ? summary : "", truncated };
    }
    case "branch_summary": {
      const summary = it.entry?.summary;
      return { type: "branchSummary", key: it.id, summary: typeof summary === "string" ? summary : "", truncated };
    }
    case "model_change": {
      const provider = it.entry?.provider;
      const modelId = it.entry?.modelId;
      const model = [provider, modelId].filter(isNonEmptyString).join("/");
      return { type: "modelChange", key: it.id, model };
    }
    case "custom": {
      const content = it.entry?.content;
      const text = typeof content === "string" ? content : resultText({ content }) || safeJson(content, true);
      const customType = it.entry?.customType;
      return {
        type: "custom",
        key: it.id,
        customType: typeof customType === "string" ? customType : "custom",
        text,
        truncated,
      };
    }
    default:
      break;
  }
  const m = it.message;
  if (!m) return undefined;
  switch (m.role) {
    case "assistant":
      return { type: "assistant", key: it.id, assistant: assistantView(m, idx, false), truncated };
    case "user": {
      const timestamp = m.timestamp;
      return {
        type: "user",
        key: it.id,
        text: messageText(m),
        truncated,
        timestamp: typeof timestamp === "number" ? timestamp : undefined,
      };
    }
    case "toolResult": {
      const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
      if (idx.called.has(toolCallId)) return undefined; // shown inside its own tool card
      return { type: "toolOrphan", key: it.id, view: toolView(undefined, m, undefined, idx.durations) as ToolView };
    }
    case "custom": {
      if (m.display === false) return undefined;
      const customType = m.customType;
      return {
        type: "custom",
        key: it.id,
        customType: typeof customType === "string" ? customType : "custom",
        text: messageText(m),
        truncated,
      };
    }
    default:
      return { type: "other", key: it.id, role: String(m.role), text: messageText(m), truncated };
  }
}

export interface TxBuild {
  readonly entries: readonly TxEntry[];
  /** `itemRenderKey()` per history entry, aligned 1:1 by index with the leading slice of
   * `entries` (streaming/orphan-live entries have no history counterpart) — the `v-memo` cache
   * key a finalized entry's subtree is keyed on. */
  readonly renderKeys: readonly string[];
  /** Anchor id SETS (`useScrollMemory.ts`'s E1-1 rule), aligned 1:1 by index with `entries`
   * (unlike `renderKeys`: these are IDENTITY ids for scroll-position anchoring, not v-memo
   * cache keys — no content digest, and streaming/live-tool entries contribute `[]` because
   * they have no stable identity). docs/dev/web-hub-session-switch/plan.md §1.4. */
  readonly anchors: readonly (readonly string[])[];
}

/**
 * Anchor ids for one item (session-switch plan §1.4 E1-1): `e:<entryId>` when the backing entry
 * has an id; `k:<messageKey>` only for NON-custom messages with a finite numeric timestamp
 * (a missing/garbage timestamp yields a meaningless `role:` key, and custom messages are
 * never keyed). Items with neither (live streamed messages without a final entry, orphan live
 * tools, custom live messages) return `[]` and can never serve as scroll anchors.
 */
export function anchorIdsOf(it: Item): string[] {
  const ids: string[] = [];
  if (typeof it.entryId === "string" && it.entryId !== "") ids.push(`e:${it.entryId}`);
  const m = it.message;
  if (m !== undefined && m.role !== "custom" && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
    const key = messageKey(m);
    if (key !== undefined) ids.push(`k:${key}`);
  }
  return ids;
}

export function buildTxEntries(a: TranscriptSource): TxBuild {
  const idx = indexTools(a);
  const entries: TxEntry[] = [];
  const renderKeys: string[] = [];
  const anchors: (readonly string[])[] = [];
  for (const it of a.items) {
    const entry = itemEntry(it, idx);
    if (!entry) continue;
    entries.push(entry);
    renderKeys.push(itemRenderKey(it, idx));
    anchors.push(anchorIdsOf(it));
  }
  if (a.streaming) {
    entries.push({
      type: "assistant",
      key: "streaming",
      assistant: assistantView(a.streaming, idx, true),
      truncated: false,
    });
    renderKeys.push("streaming");
    anchors.push([]);
  }
  for (const t of a.tools) {
    if (idx.called.has(t.toolCallId) || idx.results.has(t.toolCallId)) continue;
    entries.push({
      type: "toolOrphan",
      key: `live:${t.toolCallId}`,
      view: toolView(undefined, undefined, t, idx.durations) as ToolView,
    });
    renderKeys.push(`live:${t.toolCallId}:${t.done ? "d" : "l"}:${String(t.partial ?? "").length}`);
    anchors.push([]);
  }
  return { entries, renderKeys, anchors };
}
