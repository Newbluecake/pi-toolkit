import { describe, expect, it } from "vitest";
import type { CustomEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { createFabricEntryRenderer, renderFabricEntry } from "../../src/adapters/fabric-entry-renderer.js";
import { makeMessageKey, type FabricDeliveryState, type FabricRecord } from "../../src/core/message.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `<bold>${text}</bold>`,
  italic: (text: string) => `<italic>${text}</italic>`,
  underline: (text: string) => `<underline>${text}</underline>`,
  strikethrough: (text: string) => `<strike>${text}</strike>`,
} as unknown as Theme;

function record(patch: Partial<FabricRecord> = {}): FabricRecord {
  return {
    key: makeMessageKey("r_ABCDEFGH", "root", 1, 1),
    from: "r_ABCDEFGH",
    to: "root",
    kind: "finding",
    seq: 1,
    generation: 1,
    payload: { text: "hello fabric" },
    ttlMs: 100_000,
    createdAt: 1,
    updatedAt: 1,
    state: "pending",
    attempts: 0,
    ...patch,
  };
}

function entry(data: unknown): CustomEntry {
  return {
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: "2024-01-01T00:00:00Z",
    customType: "subagent:fabric",
    data,
  };
}

describe("renderFabricEntry", () => {
  it("renders a delivered record with a muted header and markdown body", () => {
    const component = renderFabricEntry(
      entry(record({ state: "delivered", deliveredAt: 2, payload: { text: "hello **fabric**" } })),
      { expanded: false },
      theme,
    );
    expect(component).toBeInstanceOf(Container);
    const lines = component!.render(200).map((line) => line.trimEnd());
    expect(lines[0]).toBe(" [@r_ABCDEFGH]");
    expect(lines[1]).toBe(" hello <bold>fabric</bold>");
  });

  it("prefers the record's persisted fromLabel over resolver and runId (2026-10-24 header rework)", () => {
    const render = createFabricEntryRenderer((runId) => (runId === "r_ABCDEFGH" ? "watcher" : undefined));
    const component = render(
      entry(record({ state: "delivered", deliveredAt: 2, fromLabel: "secreview:-secure-V6-wiring" })),
      { expanded: false },
      theme,
    );
    const lines = component!.render(200).map((line) => line.trimEnd());
    expect(lines[0]).toBe(" [@secreview:-secure-V6-wiring]");
    expect(lines[1]).toBe(" hello fabric");
  });

  it("falls back to the mention label over the runId when a resolver is provided", () => {
    const render = createFabricEntryRenderer((runId) => (runId === "r_ABCDEFGH" ? "watcher" : undefined));
    const component = render(entry(record({ state: "delivered", deliveredAt: 2 })), { expanded: false }, theme);
    const lines = component!.render(200).map((line) => line.trimEnd());
    expect(lines[0]).toBe(" [@watcher]");
    expect(lines[1]).toBe(" hello fabric");
  });

  it("renders @root for a root sender and @system for a system sender", () => {
    const root = renderFabricEntry(
      entry(record({ state: "delivered", deliveredAt: 2, from: "root", to: "r_ABCDEFGH" })),
      { expanded: false },
      theme,
    );
    expect(root!.render(200).map((l) => l.trimEnd())[0]).toBe(" [@root]");
    const system = renderFabricEntry(
      entry(record({ state: "delivered", deliveredAt: 2, from: "system", to: "r_ABCDEFGH" })),
      { expanded: false },
      theme,
    );
    expect(system!.render(200).map((l) => l.trimEnd())[0]).toBe(" [@system]");
  });

  it("renders nothing for every non-delivered state (append-per-transition would duplicate the message)", () => {
    const states: FabricDeliveryState[] = ["pending", "claimed", "consumed", "dropped", "abandoned"];
    for (const state of states) {
      expect(renderFabricEntry(entry(record({ state })), { expanded: false }, theme)).toBeUndefined();
    }
  });

  it("renders nothing when data is missing or has no state", () => {
    expect(renderFabricEntry(entry(undefined), { expanded: false }, theme)).toBeUndefined();
    expect(renderFabricEntry(entry({ payload: { text: "x" } }), { expanded: false }, theme)).toBeUndefined();
  });

  it("renders markdown lists and keeps every payload line at a small fixed indent", () => {
    const render = createFabricEntryRenderer((runId) => (runId === "r_ABCDEFGH" ? "watcher" : undefined));
    const component = render(
      entry(
        record({
          state: "delivered",
          deliveredAt: 2,
          payload: { text: "line1\n- **line2**\n  - line3" },
        }),
      ),
      { expanded: false },
      theme,
    );
    const lines = component!.render(200).map((line) => line.trimEnd());
    expect(lines[0]).toBe(" [@watcher]");
    expect(lines[1]).toBe(" line1");
    expect(lines[2]).toBe(" - <bold>line2</bold>");
    expect(lines[3]).toBe("     - line3");
  });

  it("indents a header-only entry (blank payload) to the body's left margin", () => {
    const component = renderFabricEntry(
      entry(record({ state: "delivered", deliveredAt: 2, payload: { text: "   " } })),
      { expanded: false },
      theme,
    );
    expect(component).not.toBeInstanceOf(Container);
    const lines = component!.render(200).map((line) => line.trimEnd());
    expect(lines[0]).toBe(" [@r_ABCDEFGH]");
    expect(lines[1]).toBeUndefined();
  });

  it("renders a sender-only header when kind is absent on a delivered record", () => {
    const component = renderFabricEntry(
      entry({ state: "delivered", payload: { text: "x" } }),
      { expanded: false },
      theme,
    );
    const lines = component!.render(200).map((line) => line.trimEnd());
    // no `from` on the record ⇒ unknown sender (never mis-attributed to root)
    expect(lines[0]).toBe(" [@unknown]");
    expect(lines[1]).toBe(" x");
  });

  it("lines up with pi's assistant text: default outputPad is 1, a host-supplied outputPad wins", () => {
    const delivered = entry(record({ state: "delivered", deliveredAt: 2 }));
    const def = renderFabricEntry(delivered, { expanded: false }, theme)!.render(200);
    expect(def[0]).toMatch(/^ \[@/);
    expect(def[1]!.trimEnd()).toBe(" hello fabric");
    const zero = renderFabricEntry(delivered, { expanded: false, outputPad: 0 } as never, theme)!.render(200);
    expect(zero[0]!.trimEnd()).toBe("[@r_ABCDEFGH]");
    expect(zero[1]!.trimEnd()).toBe("hello fabric");
  });
});
