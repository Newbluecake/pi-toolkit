/**
 * Port of `@logic/render/transcript.js`'s private (unexported) `indexTools(a)` helper (vue-plan.md
 * v2.1 §3.1/§3.2/§5.2 — P4). The legacy file only exports `messageText`/`itemRenderKey`
 * (`itemRenderKey(it, idx)` accepts exactly this `{results, live}` shape structurally, so it is
 * reused directly — see `entries.ts`); `indexTools` itself stays private there until P5b's
 * cleanup pass, and this package must not touch `src/web-hub/web/**` (plan §5.2's frozen-face
 * rule) — so it is duplicated here, unchanged in behavior, rather than exported upstream.
 * 相同)。fleet-drawer §6.6 (F6):签名从 `AgentState` 收窄为 `TranscriptSource`(两者在这
 * 三个字段上同构),让抽屉里的 RunTranscript 也能喂同一个内核。
 */
import type { LiveTool } from "../../types.js";
import type { TranscriptSource } from "../../contracts.js";

export interface ToolIndex {
  readonly results: Map<string, Record<string, unknown>>;
  readonly called: ReadonlySet<string>;
  readonly live: Map<string, LiveTool>;
  /** Tool-duration plan: toolCallId → durationMs (agent clock) from the reducer's merged map —
   *  absent (undefined entries allowed, `get` returns undefined) on sources without one. */
  readonly durations: ReadonlyMap<string, number> | undefined;
}

function scanToolCalls(m: Record<string, unknown> | null | undefined, called: Set<string>): void {
  if (!m || !Array.isArray(m.content)) return;
  for (const b of m.content as unknown[]) {
    if (b && typeof b === "object") {
      const block = b as { type?: unknown; id?: unknown };
      if (block.type === "toolCall" && typeof block.id === "string" && block.id !== "") called.add(block.id);
    }
  }
}

export function indexTools(a: TranscriptSource): ToolIndex {
  const results = new Map<string, Record<string, unknown>>();
  const called = new Set<string>();
  for (const it of a.items) {
    const m = it.message;
    if (!m) continue;
    if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
    else if (m.role === "assistant") scanToolCalls(m, called);
  }
  if (a.streaming) scanToolCalls(a.streaming, called);
  const live = new Map<string, LiveTool>();
  for (const t of a.tools) live.set(t.toolCallId, t);
  return { results, called, live, durations: a.toolDurations };
}
