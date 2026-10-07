import { describe, expect, it } from "vitest";
import { anchorIdsOf, buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";

/**
 * `entries.ts`'s scroll-memory anchors (docs/dev/web-hub-session-switch/plan.md §1.4 — E1-1 /
 * v2 review Major-5): every entry carries an identity id SET — `e:<entryId>` and/or
 * `k:<messageKey>` — aligned 1:1 with `entries`. These tests pin the exact admission rule and
 * the live→history id migration that makes a record saved during live streaming restorable
 * after the history snapshot replaces the tail.
 */

function source(over: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    key: "agent-a",
    items: [],
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    ...over,
  };
}

function historyMessageItem(entryId: string, message: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `e:${entryId}:1`,
    kind: "message",
    entryId,
    message,
    truncated: false,
  };
}

function liveMessageItem(message: Record<string, unknown>): Record<string, unknown> {
  // what eventCore's `messageItem(m, keys, `s:${seq}`)` produces for a message_end
  return { id: "s:1", kind: "message", message, truncated: false };
}

describe("anchorIdsOf — E1-1 admission rule", () => {
  it("history message: [e:<entryId>, k:<messageKey>] (both)", () => {
    const ids = anchorIdsOf(historyMessageItem("m1", { role: "assistant", content: [], timestamp: 123 }) as never);
    expect(ids).toEqual(["e:m1", "k:assistant:123"]);
  });

  it("live message (no entryId, finite timestamp): [k:<messageKey>] only", () => {
    const ids = anchorIdsOf(liveMessageItem({ role: "assistant", content: [], timestamp: 123 }) as never);
    expect(ids).toEqual(["k:assistant:123"]);
  });

  it("live and history forms of the SAME message share an id (migration works)", () => {
    const live = anchorIdsOf(liveMessageItem({ role: "user", content: "hi", timestamp: 77 }) as never);
    const hist = anchorIdsOf(historyMessageItem("u1", { role: "user", content: "hi", timestamp: 77 }) as never);
    expect(live).toEqual(["k:user:77"]);
    expect(hist).toEqual(["e:u1", "k:user:77"]);
    expect(hist.filter((id) => live.includes(id))).toEqual(["k:user:77"]); // non-empty intersection
  });

  it("a message WITHOUT a timestamp produces no k: id (role:-style keys are meaningless)", () => {
    const ids = anchorIdsOf(historyMessageItem("x1", { role: "user", content: "hi" }) as never);
    expect(ids).toEqual(["e:x1"]);
    const liveNoTs = anchorIdsOf(liveMessageItem({ role: "user", content: "hi" }) as never);
    expect(liveNoTs).toEqual([]);
  });

  it("non-finite timestamps (NaN/Infinity) produce no k: id either", () => {
    expect(anchorIdsOf(historyMessageItem("n1", { role: "user", content: "x", timestamp: NaN }) as never)).toEqual([
      "e:n1",
    ]);
    expect(anchorIdsOf(historyMessageItem("n2", { role: "user", content: "x", timestamp: Infinity }) as never)).toEqual(
      ["e:n2"],
    );
  });

  it("custom messages never produce k: — live custom is [], history custom is [e:…]", () => {
    expect(
      anchorIdsOf(liveMessageItem({ role: "custom", customType: "n", content: "x", timestamp: 5 }) as never),
    ).toEqual([]);
    const histCustom = anchorIdsOf({
      id: "e:cu1:1",
      kind: "custom",
      entryId: "cu1",
      entry: { customType: "n", content: "x" },
    } as never);
    expect(histCustom).toEqual(["e:cu1"]);
  });

  it("an entry with neither id nor message (streaming item shape) is []", () => {
    expect(anchorIdsOf({ id: "t:1", kind: "message", message: undefined } as never)).toEqual([]);
  });
});

describe("buildTxEntries — anchors align 1:1 with entries (F12 mapping)", () => {
  const mixed: TranscriptSource = source({
    items: [
      // 1. user message (entryId + timestamp) — anchorable
      historyMessageItem("u1", { role: "user", content: "hello", timestamp: 1000 }),
      // 2. assistant with a toolCall t1
      historyMessageItem("a1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
        timestamp: 2000,
      }),
      // 3. toolResult for t1 — PAIRED: folds into a2's tool card, produces NO entry
      historyMessageItem("r1", { role: "toolResult", toolCallId: "t1", content: "done", timestamp: 3000 }),
      // 4. orphan toolResult (no toolCall anywhere) — its own entry, anchorable
      historyMessageItem("r9", { role: "toolResult", toolCallId: "t9", content: "orphan", timestamp: 4000 }),
    ] as never,
    streaming: { role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 5000 },
    tools: [
      // attached live tool: t1 is called by item 2 ⇒ renders inside its ToolCard, NO entry
      { toolCallId: "t1", toolName: "bash", args: {}, done: false },
      // orphan live tool: nothing calls t2 ⇒ its own entry, NOT anchorable
      { toolCallId: "t2", toolName: "read", args: {}, done: false },
    ] as never,
  });

  it("anchors.length === entries.length for a mixed build", () => {
    const build = buildTxEntries(mixed);
    expect(build.anchors.length).toBe(build.entries.length);
    // entries: user, assistant(t1), orphan toolResult r9, streaming, orphan live tool t2
    expect(build.entries.map((e) => e.key)).toEqual([
      expect.stringContaining("e:u1") as never,
      expect.stringContaining("e:a1") as never,
      expect.stringContaining("e:r9") as never,
      "streaming",
      "live:t2",
    ]);
  });

  it("message entries get their ids; paired toolResult contributes NO entry and NO anchor", () => {
    const build = buildTxEntries(mixed);
    expect(build.anchors[0]).toEqual(["e:u1", "k:user:1000"]);
    expect(build.anchors[1]).toEqual(["e:a1", "k:assistant:2000"]);
    expect(build.anchors[2]).toEqual(["e:r9", "k:toolResult:4000:t9"]);
  });

  it("streaming and orphan live tools push [] (never anchorable)", () => {
    const build = buildTxEntries(mixed);
    expect(build.anchors[3]).toEqual([]); // streaming
    expect(build.anchors[4]).toEqual([]); // live:t2
  });

  it("an attached live tool's arrival/departure changes neither entries nor anchors", () => {
    const withoutAttached = buildTxEntries(
      source({ ...mixed, tools: [{ toolCallId: "t2", toolName: "read", args: {}, done: false }] as never }),
    );
    const withAttached = buildTxEntries(mixed);
    expect(withAttached.entries.length).toBe(withoutAttached.entries.length);
    expect(withAttached.anchors).toEqual(withoutAttached.anchors);
  });

  it("a duplicate entryId (ambiguity) still produces both rows — exclusion happens at index time", () => {
    const dup = buildTxEntries(
      source({
        items: [
          historyMessageItem("d1", { role: "user", content: "a", timestamp: 1 }),
          { ...historyMessageItem("d1", { role: "user", content: "b", timestamp: 2 }), id: "e:d1:2" },
        ] as never,
      }),
    );
    expect(dup.anchors).toEqual([
      ["e:d1", "k:user:1"],
      ["e:d1", "k:user:2"],
    ]);
  });
});
