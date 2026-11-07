import { describe, expect, it } from "vitest";
import { createHubMemorySection } from "../../../src/memory/scopes/hub-section.js";
import { planThreeLayerDuplicates } from "../../../src/memory/scopes/render.js";
import type { HubItem, HubMemoryView } from "../../../src/memory/scopes/types.js";
import { SKIP } from "../../../src/prompt-sections/stable-section.js";

const item: HubItem = {
  id: "general.001",
  topic: "general",
  text: "x",
  authority: "user",
  created: "2026-11-07T00:00:00.000Z",
  updated: "2026-11-07T00:00:00.000Z",
  grant: { via: "command", by: "user" },
  src: { project: "abcdef1234", label: "project", sid8: "abcdefgh" },
};
const current: HubMemoryView = { state: "ok", items: [item] };

describe("hub section factory (no assembly)", () => {
  it("locked checks before view/projection/source; unsafe states SKIP, normal empty/absent return empty", () => {
    let reads = 0;
    const section = createHubMemorySection({
      isLocked: () => true,
      view: () => {
        reads++;
        return current;
      },
      projection: () => {
        throw new Error("forbidden");
      },
    });
    expect(section()).toBe(SKIP);
    expect(reads).toBe(0);
    for (const state of ["disabled", "inert"] as const) {
      expect(createHubMemorySection({ isLocked: () => false, view: () => ({ state, items: [] }) })()).toBe(SKIP);
    }
    for (const state of ["ok", "absent"] as const) {
      expect(createHubMemorySection({ isLocked: () => false, view: () => ({ state, items: [] }) })()).toBe("");
    }
  });

  it("no projection preserves old nonempty source bytes and does not mutate the store view", () => {
    const before = JSON.stringify(current);
    expect(createHubMemorySection({ isLocked: () => false, view: () => current })()).toBe(
      "Hub memory (shared by all projects of this hub)\n- general.001 user src=other#abcdef: x",
    );
    expect(
      createHubMemorySection({ isLocked: () => false, view: () => current, currentProjectSlug: () => "abcdef1234" })(),
    ).toContain("src=this-project: x");
    expect(JSON.stringify(current)).toBe(before);
  });

  it("optional same-view projection overrides old session lookup; full final bytes decide ±1 admission", () => {
    let reads = 0;
    const deps = {
      isLocked: () => false,
      view: () => {
        reads++;
        return current;
      },
      sessionItems: () => {
        throw new Error("must not double read another layer");
      },
      projection: (view: HubMemoryView) => {
        expect(view).toBe(current);
        return planThreeLayerDuplicates([
          { ...item, layer: "hub", visibility: "full" },
          { layer: "project", id: "p1", authority: "user", text: "x", visibility: "full" },
        ]);
      },
    } as const;
    const expected =
      "Hub memory (shared by all projects of this hub)\n- general.001 user src=other#abcdef (dup of project p1): x";
    const bytes = Buffer.byteLength(expected);
    expect(createHubMemorySection({ ...deps, renderBudgetBytes: bytes })()).toBe(expected);
    expect(reads).toBe(1);
    expect(createHubMemorySection({ ...deps, renderBudgetBytes: bytes - 1 })()).toContain("1B over budget");
    expect(createHubMemorySection({ ...deps, renderBudgetBytes: bytes + 1 })()).toBe(expected);
    expect(current.items[0]?.text).toBe("x");
  });

  it("read exceptions remain failures, not successful empty", () => {
    expect(
      createHubMemorySection({
        isLocked: () => false,
        view: () => {
          throw new Error("io fault");
        },
      }),
    ).toThrow("io fault");
  });
});
