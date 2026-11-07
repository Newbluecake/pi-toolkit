/** #39 P1 session section: locked-first SKIP, empty SKIP, markers, dropped suffix, budget pointer. */
import { describe, expect, it } from "vitest";
import { createSessionMemorySection } from "../../../src/memory/scopes/session-section.js";
import { SKIP } from "../../../src/prompt-sections/stable-section.js";
import type { FoldedSessionItem, SessionMemoryView } from "../../../src/memory/scopes/types.js";

const view = (items: FoldedSessionItem[], dropped: SessionMemoryView["dropped"] = []): SessionMemoryView => ({
  items,
  nextN: items.length + 1,
  opsSinceSnap: 0,
  dropped,
  persistence: "appended",
  poisoned: false,
});

const item = (n: number, text: string, extra: Partial<FoldedSessionItem> = {}): FoldedSessionItem => ({
  item: {
    id: `n${n}`,
    text,
    authority: "agent",
    created: "2026-11-07T00:00:00.000Z",
    updated: "2026-11-07T00:00:00.000Z",
  },
  rev: "abcd1234",
  ...extra,
});

describe("createSessionMemorySection", () => {
  it("locked ⇒ SKIP without ever calling view (zero branch reads)", () => {
    let viewCalls = 0;
    const section = createSessionMemorySection({
      isLocked: () => true,
      view: () => {
        viewCalls++;
        throw new Error("locked provider must not read the branch");
      },
    });
    expect(section()).toBe(SKIP);
    expect(viewCalls).toBe(0);
  });

  it("empty (no items, no dropped) ⇒ SKIP; content only when something exists", () => {
    const section = createSessionMemorySection({ isLocked: () => false, view: () => view([]) });
    expect(section()).toBe(SKIP);
    const withDropped = createSessionMemorySection({
      isLocked: () => false,
      view: () => view([], [{ entryId: "e9", reason: "invalid-entry:id" }]),
    });
    const text = withDropped();
    expect(text).toContain("dropped 1");
  });

  it("renders ids, authority, inheritance markers and bodies; markers stay English", () => {
    const items = [
      item(1, "plain note"),
      item(2, "forked", { inherited: { kind: "fork", fromSid: "abcdefgh" } }),
      item(3, "spawned", { inherited: { kind: "spawn", fromSid: "parent12", frozenAt: "2026-11-07T09:30:00.000Z" } }),
      { ...item(4, "user rule"), item: { ...item(4, "user rule").item, authority: "user" } },
    ];
    const section = createSessionMemorySection({ isLocked: () => false, view: () => view(items) });
    const text = section() as string;
    expect(text).toContain("- n1 agent: plain note");
    expect(text).toContain("(inherited · fork abcdefgh)");
    expect(text).toContain("(inherited · parent parent12 @ 09:30)");
    expect(text).toContain("- n4 user: user rule");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/); // English inline markers only
  });

  it("over-budget render degrades to a pointer stub naming the view hint; never truncates", () => {
    const big = Array.from({ length: 40 }, (_, i) => item(i + 1, "x".repeat(400)));
    const section = createSessionMemorySection({
      isLocked: () => false,
      view: () => view(big),
      renderBudgetBytes: 1024,
    });
    const text = section() as string;
    expect(text).toContain("over budget");
    expect(text).toContain("scoped_memory view");
    expect(text).not.toContain("x".repeat(400)); // body not partially rendered
    const fits = createSessionMemorySection({
      isLocked: () => false,
      view: () => view(big),
      renderBudgetBytes: 63_488,
    });
    expect(fits()).toContain("x".repeat(400));
  });
});
