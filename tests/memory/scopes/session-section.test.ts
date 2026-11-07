/** #39 P1 session section: locked-first SKIP, empty removal, markers, dropped suffix, budget pointer. */
import { describe, expect, it } from "vitest";
import { createSessionMemorySection } from "../../../src/memory/scopes/session-section.js";
import { planThreeLayerDuplicates } from "../../../src/memory/scopes/render.js";
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

  it("empty (no items, no dropped) ⇒ successful empty; content only when something exists", () => {
    const section = createSessionMemorySection({ isLocked: () => false, view: () => view([]) });
    expect(section()).toBe("");
    const withDropped = createSessionMemorySection({
      isLocked: () => false,
      view: () => view([], [{ entryId: "e9", reason: "invalid-entry:id" }]),
    });
    const text = withDropped();
    expect(text).toContain("dropped 1");
  });

  it("renders ids, authority, inheritance markers and bodies; markers stay English", () => {
    const items: FoldedSessionItem[] = [
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

describe("session optional same-turn projection", () => {
  it("reuses the exact view, preserves raw body/view and counts marker at budget ±1", () => {
    const current = view([item(1, "x")]);
    const before = JSON.stringify(current);
    let reads = 0;
    const plain = createSessionMemorySection({ isLocked: () => false, view: () => current })();
    expect(plain).toBe("Session memory\n- n1 agent: x");
    const projection = (v: SessionMemoryView) => {
      expect(v).toBe(current);
      return planThreeLayerDuplicates([
        { layer: "session", ...v.items[0]!.item, visibility: "full" },
        { layer: "project", id: "p1", authority: "user", text: "x", visibility: "full" },
      ]);
    };
    const deps = {
      isLocked: () => false,
      view: () => {
        reads++;
        return current;
      },
      projection,
    };
    const expected =
      "Session memory\npriority: user entries outrank agent entries; at equal authority session > project > hub\n- n1 agent (dup of project p1): x";
    const bytes = Buffer.byteLength(expected);
    expect(createSessionMemorySection({ ...deps, renderBudgetBytes: bytes })()).toBe(expected);
    expect(reads).toBe(1);
    expect(createSessionMemorySection({ ...deps, renderBudgetBytes: bytes - 1 })()).toContain("1B over budget");
    expect(createSessionMemorySection({ ...deps, renderBudgetBytes: bytes + 1 })()).toBe(expected);
    expect(JSON.stringify(current)).toBe(before);
  });

  it("unrelated project full adds neither priority note nor marker; no-projection bytes stay identical", () => {
    const current = view([item(1, "session-only")]);
    const deps = { isLocked: () => false, view: () => current };
    const plain = createSessionMemorySection(deps)();
    expect(plain).toBe("Session memory\n- n1 agent: session-only");
    const projected = createSessionMemorySection({
      ...deps,
      projection: () =>
        planThreeLayerDuplicates([
          { layer: "session", ...current.items[0]!.item, visibility: "full" },
          { layer: "project", id: "p1", authority: "user", text: "unrelated", visibility: "full" },
        ]),
    })();
    expect(projected).toBe(plain);
    expect(projected).not.toContain("priority:");
  });

  it("actual cross-layer collision adds note even when session is winner, without losing raw body", () => {
    const current = view([item(1, "same")]);
    const text = createSessionMemorySection({
      isLocked: () => false,
      view: () => current,
      projection: () =>
        planThreeLayerDuplicates([
          { layer: "session", ...current.items[0]!.item, visibility: "full" },
          { layer: "project", id: "p1", authority: "agent", text: "same", visibility: "full" },
        ]),
    })();
    expect(text).toContain("priority: user entries outrank agent entries");
    expect(text).toContain("- n1 agent: same");
    expect(text).not.toContain("dup of");
  });

  it("stale session winner DTO cannot fabricate a current cross-layer conflict note", () => {
    const current = view([item(1, "new body")]);
    const text = createSessionMemorySection({
      isLocked: () => false,
      view: () => current,
      projection: () =>
        planThreeLayerDuplicates([
          { layer: "session", ...current.items[0]!.item, text: "old body", visibility: "full" },
          { layer: "project", id: "p1", authority: "agent", text: "old body", visibility: "full" },
        ]),
    })();
    expect(text).toBe("Session memory\n- n1 agent: new body");
  });

  it("does not treat read failure as successful empty", () => {
    const section = createSessionMemorySection({
      isLocked: () => false,
      view: () => {
        throw new Error("read failed");
      },
    });
    expect(section).toThrow("read failed");
  });
});
