import { describe, expect, it } from "vitest";
import {
  buildRevisionDiscoveryPool,
  revisionPairKey,
  revisionSourceKey,
  selectPairOutcome,
  selectRevisionWork,
  revisionRelationHints,
  type SelectorBlock,
  type SourceHint,
} from "../../../src/memory/govern/revision-selector.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import type { JevIndexV1 } from "../../../src/memory/jev/contracts.js";

export const block = (
  id: string,
  body = "shared rule",
  authority: "user" | "agent" = "agent",
  tags: string[] = [],
): SelectorBlock => ({
  side: { id, rev: "1-abcdef", topic: id.split(".")[0]!, authority },
  body,
  rawDigest: "a".repeat(64),
  effectiveTags: tags,
});
const input = (blocks: SelectorBlock[], sources: SourceHint[] = []) => ({
  policyVersion: "test",
  blocks,
  hints: [],
  sources,
});
const source = (old: SelectorBlock, survivor: SelectorBlock, n = 1): SourceHint => ({
  old: old.side,
  survivor: survivor.side,
  source: { batchId: String(n).padStart(64, "0"), actionId: "a".repeat(64), proposalDigest: "b".repeat(64) },
});
const page = (p: ReturnType<typeof buildRevisionDiscoveryPool>) => ({
  ordinaryPairKeys: p.ordinary.slice(0, 4).map((p) => p.pairKey),
  sourceKeys: p.sources.slice(0, 2).map(revisionSourceKey),
});
it("0/1/16 and permutation stable, 120 local pairs, 4+2 menu <=14 <=16", () => {
  expect(buildRevisionDiscoveryPool(input([])).ordinary).toEqual([]);
  expect(buildRevisionDiscoveryPool(input([block("a.001")])).localPairs).toBe(0);
  const blocks = Array.from({ length: 16 }, (_, i) => block(`a.${String(i + 1).padStart(3, "0")}`));
  const s = [source(blocks[14]!, blocks[15]!), source(blocks[12]!, blocks[13]!)];
  const i = input(blocks, s),
    p = buildRevisionDiscoveryPool(i);
  expect(p.localPairs).toBe(120);
  expect(p.ordinary).toHaveLength(120);
  expect(buildRevisionDiscoveryPool(input([...blocks].reverse(), [...s].reverse()))).toEqual(p);
  const selected = selectRevisionWork(i, p, page(p), {});
  expect(selected.pairs).toHaveLength(4);
  expect(selected.sourceRetires).toHaveLength(2);
  expect(selected.actions).toHaveLength(14);
  expect(() => buildRevisionDiscoveryPool(input([...blocks, block("a.017")]))).toThrow("bounds");
  expect(() =>
    selectRevisionWork(i, p, { ...page(p), ordinaryPairKeys: p.ordinary.slice(0, 5).map((p) => p.pairKey) }, {}),
  ).toThrow("bounds");
});
it("cold same-topic, shared-tag and cross-topic ASCII/CJK lexical top2; zero tokens never forced", () => {
  const blocks = [
    block("a.001", "unique"),
    block("a.002", "else"),
    block("b.001", "budget 目录锁", "agent", ["safety"]),
    block("c.001", "budget 目录锁"),
    block("d.001", "other", "agent", ["safety"]),
    block("e.001", "!!!"),
    block("f.001", "???"),
  ];
  const p = buildRevisionDiscoveryPool(input(blocks));
  expect(p.ordinary.find((p) => p.pairKey === revisionPairKey("a.001", "a.002"))!.signals).toContain("topic");
  expect(p.ordinary.find((p) => p.pairKey === revisionPairKey("b.001", "c.001"))!.signals).toContain("lexical");
  expect(p.ordinary.find((p) => p.pairKey === revisionPairKey("b.001", "d.001"))!.signals).toContain("tag");
  expect(p.ordinary.some((p) => p.sides.some((s) => s.id.startsWith("e.") || s.id.startsWith("f.")))).toBe(false);
});
it("all fixed pages contain unique pairs and cold slots despite many hints", () => {
  const blocks = Array.from({ length: 8 }, (_, i) => block(`a.${String(i + 1).padStart(3, "0")}`));
  const i = input(blocks),
    p = buildRevisionDiscoveryPool({
      ...i,
      hints: blocks.slice(1).map((b) => ({ kind: "conflict" as const, pair: [blocks[0]!.side, b.side] as const })),
    });
  expect(p.ordinary).toHaveLength(28);
  expect(new Set(p.ordinary.map((p) => p.pairKey)).size).toBe(28);
  expect(p.ordinary.slice(0, 4).some((p) => !p.hintKind)).toBe(true);
});
it("source authority filtered before quota; conflicting survivor refuses old; stable duplicate refs", () => {
  const blocks = [block("a.001", "x", "user"), block("a.002"), block("a.003"), block("a.004"), block("a.005")];
  const invalid = source(blocks[0]!, blocks[1]!);
  const i = input(blocks, [invalid, source(blocks[2]!, blocks[1]!, 3), source(blocks[3]!, blocks[1]!, 2)]);
  expect(buildRevisionDiscoveryPool(i).sources).toHaveLength(2);
  const ambiguous = buildRevisionDiscoveryPool(
    input(blocks, [source(blocks[2]!, blocks[1]!), source(blocks[2]!, blocks[4]!)]),
  );
  expect(ambiguous.sources).toEqual([]);
  expect(ambiguous.rejectedSourceOldIds).toEqual(["a.003"]);
  const dedup = buildRevisionDiscoveryPool(
    input(blocks, [source(blocks[2]!, blocks[1]!, 3), source(blocks[2]!, blocks[1]!, 1)]),
  );
  expect(dedup.sources).toEqual([source(blocks[2]!, blocks[1]!, 1)]);
});
it("carrier ID only chooses suggestion location; mixed menu never agent-over-user retire", () => {
  const blocks = [block("a.001", "x", "user"), block("b.001", "x", "agent")];
  const pair = buildRevisionDiscoveryPool(input(blocks)).ordinary[0]!;
  expect(pair.carrierId).toBe("b.001");
  expect(pair.actions).toHaveLength(2);
  expect(pair.actions.some((a) => a.action === "retire" && a.target.id === "a.001")).toBe(false);
  expect(
    selectPairOutcome(pair, blocks, [
      { kind: "supersedes", p: 0.99 },
      { kind: "unrelated", p: 0.99 },
    ]),
  ).toEqual({ kind: "none" });
});
describe("fresh reducer: not authorization", () => {
  const blocks = [block("a.001", "rule x"), block("a.002", "rule y")],
    pair = buildRevisionDiscoveryPool(input(blocks)).ordinary[0]!;
  it.each([
    [
      [
        { kind: "supersedes", p: 0.99 },
        { kind: "unrelated", p: 0.99 },
      ],
      "retire-suggestion",
      "a.001",
      "supersedes",
    ],
    [
      [
        { kind: "unrelated", p: 0.99 },
        { kind: "supersedes", p: 0.99 },
      ],
      "retire-suggestion",
      "a.002",
      "supersedes",
    ],
    [
      [
        { kind: "supersedes", p: 0.99 },
        { kind: "supersedes", p: 0.99 },
      ],
      "ambiguous-suggestion",
      "a.001",
      "supersedes",
    ],
    [
      [
        { kind: "supersedes", p: 0.99 },
        { kind: "conflict", p: 0.99 },
      ],
      "merge-suggestion",
      "a.001",
      "conflict",
    ],
  ] as const)("%j -> %s", (fresh, kind, target, reason) => {
    expect(selectPairOutcome(pair, blocks, fresh)).toMatchObject({ kind, reason, action: { target: { id: target } } });
  });
  it("missing/reverse low confidence/unrelated cannot generate from an old hint", () => {
    for (const fresh of [
      [undefined, { kind: "supersedes", p: 0.99 }],
      [
        { kind: "supersedes", p: 0.99 },
        { kind: "conflict", p: 0.5 },
      ],
      [
        { kind: "unrelated", p: 0.99 },
        { kind: "unrelated", p: 0.99 },
      ],
    ] as const)
      expect(selectPairOutcome({ ...pair, hintKind: "conflict" }, blocks, fresh)).toEqual({ kind: "none" });
  });
  it("undirected exact duplicate stays bodyless merge, never retire", () => {
    const same = [block("a.001", "same\r\n"), block("a.002", "same")],
      p = buildRevisionDiscoveryPool(input(same)).ordinary[0]!;
    expect(
      selectPairOutcome(p, same, [
        { kind: "unrelated", p: 0.99 },
        { kind: "unrelated", p: 0.99 },
      ]),
    ).toMatchObject({
      kind: "ambiguous-suggestion",
      bodyless: true,
      reason: "duplicate",
      action: { action: "merge-survivor" },
    });
  });
});
it("current hash/rev/strict anchors bind old vs revision supersedes direction, no basename/17th fallback", () => {
  const blocks = [block("a.001"), block("a.002")];
  const index: JevIndexV1 = {
    v: 1,
    entries: {},
    review: {
      lastRunAt: "",
      corpusFp: "",
      dismissed: [],
      suggestions: [
        {
          id: "old",
          kind: "supersedes",
          a: { hash: entryHash(blocks[0]!.body), anchor: "a.001.md|section|head\nC++" },
          b: { hash: entryHash(blocks[1]!.body), anchor: "a.002" },
          p: 0.99,
          at: "",
        },
      ],
    },
  };
  expect(revisionRelationHints(index, blocks)[0]!.survivorId).toBe("a.001");
  for (const anchor of ["../a.001.md|s|h", "a.001.md|one", "a.017"]) {
    const bad = {
      ...index,
      review: {
        ...index.review!,
        suggestions: [{ ...index.review!.suggestions[0]!, a: { hash: entryHash(blocks[0]!.body), anchor } }],
      },
    };
    expect(revisionRelationHints(bad, blocks)).toEqual([]);
  }
  expect(revisionRelationHints(index, [{ ...blocks[0]!, body: "changed" }, blocks[1]!])).toEqual([]);
});
it("latest action tombstones suppress menu but do not refill selected fixed page", () => {
  const blocks = [block("a.001"), block("a.002")],
    i = input(blocks),
    p = buildRevisionDiscoveryPool(i);
  const dismissed = ["merge-survivor", "retire"].map((action) => ({
    hashKey: "old+hash",
    anchorKey: "a.001+a.002",
    suggestionKey: JSON.stringify(["revision", action, "a.001", "a.002"]),
  }));
  const review = { lastRunAt: "", corpusFp: "", suggestions: [], dismissed };
  expect(selectRevisionWork(i, p, page(p), { review }).actions).toEqual([]);
});
