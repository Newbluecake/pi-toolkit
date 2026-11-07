import { describe, expect, it } from "vitest";
import { parseBlockFile, serializeBlock } from "../../../src/memory/blocks/format.js";
import type { BlockCorpus } from "../../../src/memory/blocks/store.js";
import type { JevIndexV1 } from "../../../src/memory/jev/contracts.js";
import { planSweep } from "../../../src/memory/govern/sweep-plan.js";
const today = "2026-11-06";
function fixture(authority: "user" | "agent", extra: Record<string, unknown> = {}) {
  const b = parseBlockFile(
    "topic.001.md",
    serializeBlock(
      {
        kind: "block",
        authority,
        status: "active",
        version: 1,
        created: "2026-01-01",
        updated: "2026-01-01",
        ...extra,
      },
      "当前状态: 任务尚未完成",
    ),
  );
  if ("stray" in b) throw new Error("fixture");
  const corpus: BlockCorpus = {
    blocks: [b],
    strays: [],
    archivedByTopic: new Map(),
    marker: undefined,
    legacy: { files: [] },
    fingerprint: "fp",
  };
  const index: JevIndexV1 = { v: 1, entries: {} };
  return { corpus, index };
}
describe("planSweep", () => {
  it.each(["global", "topic"])("never archives expired %s user", (scope) => {
    const f = fixture("user", { expires: "2026-11-05", scope });
    const p = planSweep(f.corpus, f.index, { files: [] }, today, "startup");
    expect(p.archive).toEqual([]);
    expect(p.suggestions.map((s) => s.kind)).toContain("expired-user");
  });
  it("expired agent archives; today is not expired; until is advisory", () => {
    const f = fixture("agent", { expires: "2026-11-05", until: "task done" });
    expect(planSweep(f.corpus, f.index, { files: [] }, today, "write").archive).toHaveLength(1);
    f.corpus = { ...f.corpus, blocks: f.corpus.blocks.map((b) => ({ ...b, meta: { ...b.meta, expires: today } })) };
    const p = planSweep(f.corpus, f.index, { files: [] }, today, "write");
    expect(p.archive).toEqual([]);
    expect(p.suggestions.map((s) => s.kind)).toContain("until-check");
  });
  it("deduplicates, honors timed dismissals and reopens after expiry", () => {
    const f = fixture("agent", { until: "done" });
    const p = planSweep(f.corpus, f.index, { files: [] }, today, "startup");
    const s = p.suggestions.find((s) => s.kind === "until-check")!;
    const review = {
      lastRunAt: "",
      corpusFp: "fp",
      suggestions: [],
      dismissed: [{ kind: s.kind, hashKey: s.a.hash, anchorKey: s.a.anchor, until: "2026-11-07" }],
    };
    expect(planSweep(f.corpus, { ...f.index, review }, { files: [] }, today, "write").suggestions).toEqual([]);
    expect(
      planSweep(f.corpus, { ...f.index, review }, { files: [] }, "2026-11-08", "write").suggestions.map((s) => s.kind),
    ).toContain("until-check");
    expect(
      planSweep(
        f.corpus,
        { ...f.index, review: { ...review, dismissed: [], suggestions: p.suggestions } },
        { files: [] },
        today,
        "write",
      ).suggestions,
    ).toEqual([]);
  });
  it("until throttle is 14 days; budget and drift create suggestions, not archive", () => {
    const f = fixture("user", { scope: "global", until: "done" });
    f.corpus = { ...f.corpus, legacy: { files: [{ name: "core.md", sha256: "new" }] } };
    const p = planSweep(
      f.corpus,
      { ...f.index, review: { lastRunAt: "2026-11-01", corpusFp: "fp", suggestions: [], dismissed: [] } },
      { files: [{ name: "core.md", sha256: "old" }] },
      today,
      "budget",
      { residentBytes: 4096, residentBudget: 2048, indexOverflow: false },
    );
    expect(p.archive).toEqual([]);
    expect(p.drift).toEqual(["core.md"]);
    expect(p.suggestions.map((s) => s.kind)).toEqual(["resident-budget", "legacy-drift"]);
  });
});
