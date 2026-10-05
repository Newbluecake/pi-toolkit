import { describe, expect, it } from "vitest";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";

/** Claude can emit several consecutive thinking blocks in one message; the UI shows one. */
describe("buildTxEntries — consecutive thinking blocks", () => {
  function source(content: unknown[]): TranscriptSource {
    return { items: [], streaming: { role: "assistant", content }, tools: [] } as unknown as TranscriptSource;
  }

  it("merges adjacent thinking blocks into a single block", () => {
    const { entries } = buildTxEntries(
      source([
        { type: "thinking", thinking: "first chain\n\n" },
        { type: "thinking", thinking: "second chain" },
        { type: "text", text: "answer" },
      ]),
    );
    const a = entries[0];
    expect(a?.type).toBe("assistant");
    const blocks = a?.type === "assistant" ? a.assistant.blocks : [];
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text"]);
    expect(blocks[0]).toEqual({ kind: "thinking", text: "first chain\n\nsecond chain" });
  });

  it("keeps thinking blocks separated by other content apart", () => {
    const { entries } = buildTxEntries(
      source([
        { type: "thinking", thinking: "a" },
        { type: "text", text: "mid" },
        { type: "thinking", thinking: "b" },
      ]),
    );
    const a = entries[0];
    const blocks = a?.type === "assistant" ? a.assistant.blocks : [];
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text", "thinking"]);
  });
});
