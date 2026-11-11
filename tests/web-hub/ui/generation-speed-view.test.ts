import { describe, expect, it } from "vitest";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { TxEntry } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { Item } from "../../../src/web-hub/ui/src/types.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import {
  generationHistoryIndex,
  WEB_MESSAGE_SPEED_ENTRY_TYPE,
  type GenerationCore,
} from "../../../src/web-hub/protocol/message-generation.js";

/**
 * task58 (web-hub-tokens-speed §5.2/§5.3): the view-model resolution in `entries.ts` —
 * `generationOf` is the ONE place a display core may appear:
 * - history items (entryId present) read ONLY the trusted custom-entry map — a
 *   `piToolkitGeneration` container left on the message by a non-stripping peer is IGNORED
 *   (strip-then-re-stamp: history stamps come from the persisted custom entry or not at all);
 * - live/tail items (no entryId) read the agent-stamped container, re-validated through the
 *   protocol's single `sanitizeGenerationCore` (own-data, fixed bounds);
 * - the streaming bubble NEVER carries one;
 * - no neighbour/time/content inference anywhere.
 *
 * History-entry templates come from the REAL public projection (`projectSessionEntry` over
 * raw session entries) — no hand-built wire shapes bypassing the projection/sanitizer.
 */

const ts = (n: number) => new Date(n).toISOString();

function rawAssistant(id: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: ts(at),
    message: { role: "assistant", content: [{ type: "text", text: `hi ${id}` }], timestamp: at, ...extra },
  };
}

function rawSpeedCustom(
  id: string,
  at: number,
  mid: string,
  core: Record<string, unknown> = { tokens: 10, genMs: 500, deltaCount: 2 },
) {
  return {
    id,
    parentId: null,
    type: "custom",
    timestamp: ts(at),
    customType: WEB_MESSAGE_SPEED_ENTRY_TYPE,
    data: { piToolkitGeneration: { v: 1, mid, ...core } },
  };
}

function projected(raws: unknown[]): unknown[] {
  return raws.map((r) => projectSessionEntry(r)).filter((e) => e !== undefined);
}

const messageOf = (entry: unknown): Record<string, unknown> => (entry as { message: Record<string, unknown> }).message;

/** A reducer-shaped source with the given items + generation map. */
function source(
  items: Item[],
  generation?: Map<string, GenerationCore>,
  streaming: Record<string, unknown> | null = null,
): TranscriptSource {
  return {
    key: "A",
    items,
    streaming,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    ...(generation !== undefined ? { generation } : {}),
  } satisfies TranscriptSource;
}

const assistants = (build: ReturnType<typeof buildTxEntries>) =>
  build.entries.filter((e) => e.type === "assistant") as Extract<TxEntry, { type: "assistant" }>[];

describe("generation view resolution (entries.ts)", () => {
  it("history item: custom-entry map match stamps the core (real projection pipeline)", () => {
    const entries = projected([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]);
    const items: Item[] = [{ id: "e:m1:1", kind: "message", entryId: "m1", message: messageOf(entries[0]) }];
    const generation = generationHistoryIndex(entries);
    expect(generation.size).toBe(1);
    const view = assistants(buildTxEntries(source(items, generation)))[0]!.assistant;
    expect(view.generation).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
  });

  it("history item WITHOUT matching metadata stays un-stamped (old history never backfills)", () => {
    const entries = projected([rawAssistant("m1", 1000)]);
    const items: Item[] = [{ id: "e:m1:1", kind: "message", entryId: "m1", message: messageOf(entries[0]) }];
    const view = assistants(buildTxEntries(source(items, generationHistoryIndex(entries))))[0]!.assistant;
    expect(view.generation).toBeUndefined();
  });

  it("history item: a forged container on the message is IGNORED — map only (§5.2 strip-then-re-stamp)", () => {
    const projected0 = projected([rawAssistant("m1", 1000)]);
    // Even though the real projection strips it, simulate a non-stripping peer leaving a
    // perfectly-shaped container on the history message: entryId present ⇒ map-only.
    const message = {
      ...messageOf(projected0[0]),
      piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
    };
    const items: Item[] = [{ id: "e:m1:1", kind: "message", entryId: "m1", message }];
    const unrelated = generationHistoryIndex(projected([rawAssistant("other", 1000)]));
    const view = assistants(buildTxEntries(source(items, unrelated)))[0]!.assistant;
    expect(view.generation).toBeUndefined();
  });

  it("history item: forged container ignored even when the map DOES match — the map value wins", () => {
    const entries = projected([
      rawAssistant("m1", 1000),
      rawSpeedCustom("c1", 1100, "m1", { tokens: 40, genMs: 1000, deltaCount: 4 }),
    ]);
    const message = {
      ...messageOf(entries[0]),
      piToolkitGeneration: { v: 1, tokens: 999, genMs: 999, deltaCount: 9 }, // forged
    };
    const items: Item[] = [{ id: "e:m1:1", kind: "message", entryId: "m1", message }];
    const view = assistants(buildTxEntries(source(items, generationHistoryIndex(entries))))[0]!.assistant;
    expect(view.generation).toEqual({ v: 1, tokens: 40, genMs: 1000, deltaCount: 4 });
  });

  it("history item with NO map available (absent generation source) never falls back to the container", () => {
    const projected0 = projected([rawAssistant("m1", 1000)]);
    const message = {
      ...messageOf(projected0[0]),
      piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
    };
    const items: Item[] = [{ id: "e:m1:1", kind: "message", entryId: "m1", message }];
    const view = assistants(buildTxEntries(source(items, undefined)))[0]!.assistant;
    expect(view.generation).toBeUndefined();
  });

  it("live item (no entryId): the agent-stamped container is re-validated through the single sanitizer", () => {
    const live = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      timestamp: 2000,
      piToolkitGeneration: { v: 1, tokens: 25, genMs: 2000, deltaCount: 5 },
    };
    const items: Item[] = [{ id: "s:7", kind: "message", message: live }];
    const view = assistants(buildTxEntries(source(items)))[0]!.assistant;
    expect(view.generation).toEqual({ v: 1, tokens: 25, genMs: 2000, deltaCount: 5 });
  });

  it("live item: invalid containers (bounds/version/NaN/Infinity/non-integer/missing) hide", () => {
    for (const bad of [
      { v: 2, tokens: 10, genMs: 500, deltaCount: 2 }, // wrong version
      { v: 1, tokens: 10, genMs: 499, deltaCount: 2 }, // genMs below the 500 floor
      { v: 1, tokens: 0, genMs: 500, deltaCount: 2 }, // tokens below 1
      { v: 1, tokens: 10, genMs: 500, deltaCount: 1 }, // deltaCount below 2
      { v: 1, tokens: Number.NaN, genMs: 500, deltaCount: 2 },
      { v: 1, tokens: 10, genMs: Number.POSITIVE_INFINITY, deltaCount: 2 },
      { v: 1, tokens: 1.5, genMs: 500, deltaCount: 2 }, // non-integer tokens
      { v: 1, tokens: 10, genMs: 500 }, // missing deltaCount
      "not-an-object",
      null,
    ]) {
      const live = { role: "assistant", content: [], timestamp: 2000, piToolkitGeneration: bad };
      const items: Item[] = [{ id: "s:7", kind: "message", message: live }];
      const view = assistants(buildTxEntries(source(items)))[0]!.assistant;
      expect(view.generation, `container ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("streaming bubble never carries a generation core (even if the partial message has one)", () => {
    const streaming = {
      role: "assistant",
      content: [{ type: "text", text: "so far" }],
      piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
    };
    const view = assistants(buildTxEntries(source([], undefined, streaming)))[0]!.assistant;
    expect(view.streaming).toBe(true);
    expect(view.generation).toBeUndefined();
  });

  it("an explicitly stamped live item keeps its core when a structural caller provides no map", () => {
    // Both production projections pass `generation`; this tests the optional-map fallback only.
    const live = {
      role: "assistant",
      content: [],
      timestamp: 1,
      piToolkitGeneration: { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
    };
    const items: Item[] = [{ id: "s:3", kind: "message", message: live }];
    const view = assistants(buildTxEntries(source(items)))[0]!.assistant;
    expect(view.generation).toBeDefined();
  });

  it("the custom tombstone still renders nothing; other items are untouched", () => {
    const entries = projected([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]);
    const items: Item[] = [
      { id: "e:m1:1", kind: "message", entryId: "m1", message: messageOf(entries[0]) },
      { id: "e:u1:2", kind: "message", entryId: "u1", message: { role: "user", content: "q", timestamp: 900 } },
    ];
    const build = buildTxEntries(source(items, generationHistoryIndex(entries)));
    expect(build.entries).toHaveLength(2); // the web-msg-speed custom renders no row
    expect(build.entries.filter((e) => e.type === "custom")).toHaveLength(0);
    expect(build.entries.filter((e) => e.type === "user")).toHaveLength(1);
  });
});
