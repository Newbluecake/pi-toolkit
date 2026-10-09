/**
 * Inflight streaming accumulator (web-hub agent side).
 *
 * pi-agent-core emits assistant `message_start` as a SHALLOW copy of the live
 * partial message (`agent-loop.js` `streamAssistantResponse`, `case "start"`:
 * `emit({ type: "message_start", message: { ...partialMessage } })`) whose
 * `content` array is the same array pi-ai keeps mutating while pi's awaited
 * extension dispatch still runs behind the push stream; the `message` carried
 * on every `message_update` is another live reference. Projecting either of
 * them therefore leaks chunks whose deltas have not been emitted yet, and the
 * browser — which seeds its streaming clone from the wire `message_start` and
 * then applies every delta again — renders those chunks twice (the observed
 * first-word doubling while streaming).
 *
 * This module reconstructs the streaming assistant message ONLY from what the
 * event tap has actually emitted (or holds ready at flush): the tap feeds it
 * the exact payloads it puts on the wire. The merge semantics mirror
 * ui/src/logic/state.js `applyDelta` so a snapshot `inflight.message` plus the
 * deltas that follow it reconstruct each block exactly once:
 *  - text_delta / thinking_delta → append to `text` / `thinking`
 *  - toolcall_delta → append to `partialJson`
 *  - text_end / thinking_end → replace the block's text field
 *  - toolcall_end → replace the block
 * Every accumulated block string is capped at LIMITS.textTruncateBytes and the
 * block is marked `truncated: true` when the cap dropped bytes (the per-delta
 * wire cap keeps single events small; this per-block cap bounds the held
 * memory — the jsonl history stays authoritative). The tap resets on
 * message_end / agent_end / session reset.
 */
import { LIMITS, type WireMessage } from "../protocol/messages.js";
import { truncateText } from "../protocol/keys.js";

type Block = Record<string, unknown>;

/** The assistantMessageEvent payloads the tap emits on the wire (already capped). */
export interface AppliedAssistantMessageEvent {
  type: string;
  contentIndex?: number | undefined;
  delta?: string | undefined;
  /** text_end / thinking_end replacement text (as emitted). */
  content?: unknown;
  /** toolcall_end replacement tool call (as emitted). */
  toolCall?: unknown;
}

export interface InflightAccumulator {
  /** Assistant `message_start` projection (content already stripped): restart from it. */
  start(base: WireMessage): void;
  /** Apply the exact payload emitted on the wire; no-op without a prior `start`. */
  apply(ame: AppliedAssistantMessageEvent): void;
  /** message_end / agent_end / session reset. */
  reset(): void;
  /** Fresh copy of the accumulated message; undefined while not streaming. */
  message(): WireMessage | undefined;
}

export function createInflightAccumulator(): InflightAccumulator {
  let base: WireMessage | undefined;
  let blocks: Array<Block | null> = [];

  /** Pad up to `index` (same 10k guard as the UI reducer) and return the block there. */
  const slot = (index: number): Block | null => {
    while (blocks.length <= index) blocks.push(null);
    return blocks[index] ?? null;
  };

  const put = (index: number, b: Block): void => {
    blocks[index] = b;
  };

  /** Cap an accumulated string; returns the text and whether bytes were dropped. */
  const cap = (s: string): { text: string; truncated: boolean } => truncateText(s, LIMITS.textTruncateBytes);

  const appendField = (index: number, kind: "text" | "thinking", delta: string): void => {
    const prev = slot(index);
    const b = prev !== null && prev.type === kind ? { ...prev } : { type: kind, [kind]: "" };
    const cur = typeof b[kind] === "string" ? (b[kind] as string) : "";
    const t = cap(cur + delta);
    b[kind] = t.text;
    if (t.truncated) b.truncated = true;
    put(index, b);
  };

  const appendPartialJson = (index: number, delta: string): void => {
    const prev = slot(index);
    // Same synthetic base the UI reducer starts from when only deltas were seen.
    const b: Block =
      prev !== null && prev.type === "toolCall" ? { ...prev } : { type: "toolCall", id: "", name: "", arguments: {} };
    const cur = typeof b.partialJson === "string" ? (b.partialJson as string) : "";
    const t = cap(cur + delta);
    b.partialJson = t.text;
    if (t.truncated) b.truncated = true;
    put(index, b);
  };

  return {
    start(next) {
      base = next;
      blocks = [];
    },
    apply(ame) {
      if (base === undefined) return; // no assistant message_start seen — never fabricate one
      const index = typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
      if (index < 0 || index > 10_000) return; // same guard as the UI reducer
      switch (ame.type) {
        case "text_delta":
          if (typeof ame.delta === "string") appendField(index, "text", ame.delta);
          return;
        case "thinking_delta":
          if (typeof ame.delta === "string") appendField(index, "thinking", ame.delta);
          return;
        case "toolcall_delta":
          if (typeof ame.delta === "string") appendPartialJson(index, ame.delta);
          return;
        case "text_end":
        case "thinking_end": {
          if (typeof ame.content !== "string") return; // the emitted content is already capped
          const kind: "text" | "thinking" = ame.type === "text_end" ? "text" : "thinking";
          const prev = slot(index);
          const b = prev !== null && prev.type === kind ? { ...prev } : { type: kind, [kind]: "" };
          b[kind] = ame.content;
          put(index, b);
          return;
        }
        case "toolcall_end": {
          if (ame.toolCall === null || typeof ame.toolCall !== "object") return;
          slot(index); // pad first so the write lands at the right position
          put(index, { ...(ame.toolCall as Block), type: "toolCall" });
          return;
        }
        default:
          return; // text_start/thinking_start/toolcall_start/done/error carry nothing the UI merges
      }
    },
    reset() {
      base = undefined;
      blocks = [];
    },
    message() {
      if (base === undefined) return undefined;
      // Holes mirror the UI reducer's null → empty-text-block normalization.
      return { ...base, content: blocks.map((b) => (b !== null ? { ...b } : { type: "text", text: "" })) };
    },
  };
}
