import { expect, it } from "vitest";
import {
  revisionSemanticSuppression,
  isDismissedRelation,
  suggestionKey,
  type RevisionSuppressionSubject,
} from "../../../src/memory/jev/index-store.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { blockAnchor } from "../../../src/memory/govern/supersede.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import type { DismissedPair, JevIndexV1, ReviewSuggestionKind } from "../../../src/memory/jev/contracts.js";

const subject: RevisionSuppressionSubject = {
  action: "merge-survivor",
  reason: "conflict",
  target: { id: "rules.001", hash: "new-a" },
  context: { id: "rules.002", hash: "new-b" },
};
function index(dismissed: readonly DismissedPair[] = [], resolved: readonly string[] = []): JevIndexV1 {
  return { v: 1, entries: {}, review: { lastRunAt: "", corpusFp: "", suggestions: [], dismissed, resolved } };
}
const tombstone = (extra: Partial<DismissedPair>): DismissedPair => ({
  hashKey: "old-a+old-b",
  anchorKey: "old",
  ...extra,
});
const anchors = ["rules.001.md|old section|old body", "rules.002.md||changed body"];
it.each(["rules.001", "rules.001.md", anchors[0]!])("normalizes %s for comparison only", (left) => {
  const d = tombstone({ suggestionKey: JSON.stringify(["semantic", "conflict", anchors[1], left]) });
  const input = index([d]);
  const before = JSON.stringify(input);
  expect(revisionSemanticSuppression(input, subject)).toBe("dismissed");
  expect(JSON.stringify(input)).toBe(before);
  expect(revisionSemanticSuppression(input, { ...subject, target: subject.context!, context: subject.target })).toBe(
    "dismissed",
  );
});
it.each(["semantic", "governance", "plain"])("legacy %s keyed and resolved keys retain fresh kind", (prefix) => {
  const key = JSON.stringify([...(prefix === "plain" ? [] : [prefix]), "conflict", ...anchors]);
  expect(revisionSemanticSuppression(index([tombstone({ suggestionKey: key })]), subject)).toBe("dismissed");
  expect(revisionSemanticSuppression(index([], [key]), subject)).toBe("resolved");
  expect(revisionSemanticSuppression(index([], [key]), { ...subject, action: "retire" })).toBe("resolved");
  expect(revisionSemanticSuppression(index([], [key]), { ...subject, action: "retire", reason: "supersedes" })).toBe(
    false,
  );
  const { reason: _reason, ...unclassified } = subject;
  expect(revisionSemanticSuppression(index([], [key]), unclassified)).toBe(false);
});
it("revision keys are stable across rev/hash and direction but not different actions", () => {
  const key = JSON.stringify(["revision", "merge-survivor", "rules.002", "rules.001"]);
  const input = index([tombstone({ suggestionKey: key })]);
  expect(revisionSemanticSuppression(input, { ...subject, reason: "supersedes" })).toBe("dismissed");
  expect(revisionSemanticSuppression(input, { ...subject, action: "retire", reason: "supersedes" })).toBe(false);
  const { reason: _reason, ...unclassified } = subject;
  expect(revisionSemanticSuppression(input, unclassified)).toBe("dismissed");
  // Existing persistent-key bytes are deliberately unchanged.
  expect(
    suggestionKey({
      id: "old",
      kind: "conflict",
      a: { hash: "a", anchor: anchors[0]! },
      b: { hash: "b", anchor: anchors[1]! },
      p: 1,
      at: "",
    }),
  ).toBe('["conflict","rules.001.md","rules.002.md"]');
});
it.each([undefined, "conflict", "duplicate"] as const)(
  "legacy kind=%s uses hashes/strict anchors without banning other semantics",
  (kind) => {
    const input = index([tombstone({ anchorKey: anchors.slice().reverse().join("+"), ...(kind ? { kind } : {}) })]);
    expect(revisionSemanticSuppression(input, subject)).toBe(kind === "duplicate" ? false : "dismissed");
    expect(revisionSemanticSuppression(input, { ...subject, action: "retire", reason: "supersedes" })).toBe(
      kind ? false : "dismissed",
    );
    const { reason: _reason, ...unclassified } = subject;
    expect(revisionSemanticSuppression(input, unclassified)).toBe(kind ? false : "dismissed");
    expect(
      revisionSemanticSuppression(index([tombstone({ hashKey: "new-a+new-b", ...(kind ? { kind } : {}) })]), subject),
    ).toBe(kind === "duplicate" ? false : "dismissed");
  },
);
it.each(["expired", "budget"] as const)("maps %s only to its existing legacy kind", (reason) => {
  const kind: ReviewSuggestionKind = reason === "expired" ? "expired-user" : "oversize";
  const one: RevisionSuppressionSubject = { action: "expires", reason, target: subject.target };
  expect(revisionSemanticSuppression(index([], [JSON.stringify([kind, anchors[0]])]), one)).toBe("resolved");
  expect(
    revisionSemanticSuppression(index([], [JSON.stringify([kind, anchors[0]])]), { ...one, reason: "conflict" }),
  ).toBe(false);
});
it.each([
  "/other/rules.001.md||head",
  "../rules.001.md||head",
  "rules.001.md|half",
  "rules.001.md.bak",
  "RULES.001",
  "rules.001\n",
  "rules.001.md\n",
])("does not guess invalid/cross-directory anchor %s", (anchor) => {
  expect(revisionSemanticSuppression(index([], [JSON.stringify(["conflict", anchor, anchors[1]])]), subject)).toBe(
    false,
  );
});
it("unknown keys/anchors retain exact fallback and keyed kinds do not fall through to hashes", () => {
  const malformed = index([tombstone({ suggestionKey: "opaque", hashKey: "new-a+new-b" })]);
  expect(revisionSemanticSuppression(malformed, subject)).toBe(false);
  const opaque = { ...subject, target: { id: "opaque-a", hash: "a" }, context: { id: "opaque-b", hash: "b" } };
  expect(revisionSemanticSuppression(index([tombstone({ anchorKey: "opaque-a+opaque-b" })]), opaque)).toBe("dismissed");
  expect(
    revisionSemanticSuppression(
      index([tombstone({ suggestionKey: '["duplicate","rules.001.md","rules.002.md"]', hashKey: "new-a+new-b" })]),
      subject,
    ),
  ).toBe(false);
});

function producerBlock(id: string, body: string, version: number) {
  const parsed = parseBlockFile(
    `${id}.md`,
    `---\nkind: block\nauthority: agent\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nversion: ${version}\n---\n\n${body}\n`,
  );
  if ("stray" in parsed || parsed.errors.length) throw Error("invalid real producer fixture");
  return parsed;
}
it.each(["Rule one.\nRule two.", "Use C++.\nKeep rules.", "Use A+B and C++."])(
  "real blockAnchor kindless tombstone survives changed rev/hash: %j",
  (body) => {
    const oldA = producerBlock("rules.001", body, 1),
      oldB = producerBlock("rules.002", "Keep locks.", 1);
    const a = producerBlock("rules.001", "New rule body.", 2),
      b = producerBlock("rules.002", "New locking body.", 2);
    const side = (block: typeof a) => ({ hash: entryHash(block.body), anchor: blockAnchor(block) });
    const d: DismissedPair = {
      hashKey: [entryHash(oldA.body), entryHash(oldB.body)].sort().join("+"),
      anchorKey: [blockAnchor(oldA), blockAnchor(oldB)].sort().join("+"),
    };
    expect(a.rev).not.toBe(oldA.rev);
    expect(b.rev).not.toBe(oldB.rev);
    expect(entryHash(a.body)).not.toBe(entryHash(oldA.body));
    expect(entryHash(b.body)).not.toBe(entryHash(oldB.body));
    if (!body.includes("+")) expect(isDismissedRelation([d], side(a), side(b), "conflict")).toBe(true);
    // The old owner also splits C++ incorrectly; do not call that an old-behavior regression.
    else expect(isDismissedRelation([d], side(a), side(b), "conflict")).toBe(false);
    const input = index([d]),
      before = JSON.stringify(input);
    const s = {
      ...subject,
      target: { id: a.id, hash: entryHash(a.body) },
      context: { id: b.id, hash: entryHash(b.body) },
    };
    expect(revisionSemanticSuppression(input, s)).toBe("dismissed");
    expect(revisionSemanticSuppression(input, { ...s, target: s.context, context: s.target })).toBe("dismissed");
    expect(revisionSemanticSuppression(input, { action: "expires", reason: "budget", target: s.target })).toBe(false);
    expect(
      revisionSemanticSuppression(index([{ ...d, kind: "duplicate" }]), {
        ...s,
        action: "retire",
        reason: "supersedes",
      }),
    ).toBe(false);
    const key = suggestionKey({ id: "producer", kind: "conflict", a: side(oldA), b: side(oldB), p: 1, at: "" });
    expect(revisionSemanticSuppression(index([], [key]), s)).toBe("resolved");
    expect(JSON.stringify(input)).toBe(before);
  },
);
it("unescaped anchor ambiguity is conservative only for complete candidate pairs and the declared kind", () => {
  const a = producerBlock("rules.001", "x+rules.003.md||", 1),
    b = producerBlock("rules.002", "Keep locks.", 1);
  const d: DismissedPair = {
    hashKey: [entryHash(a.body), entryHash(b.body)].sort().join("+"),
    anchorKey: [blockAnchor(a), blockAnchor(b)].sort().join("+"),
    kind: "conflict",
  };
  expect(blockAnchor(a)).toContain("+rules.003.md||");
  const input = index([d]);
  expect(revisionSemanticSuppression(input, subject)).toBe("dismissed");
  // Both full parses are plausible; no unescaped byte can identify one as truth.
  expect(revisionSemanticSuppression(input, { ...subject, context: { id: "rules.003", hash: "new-c" } })).toBe(
    "dismissed",
  );
  expect(revisionSemanticSuppression(input, { ...subject, context: { id: "rules.004", hash: "new-d" } })).toBe(false);
  expect(
    revisionSemanticSuppression(input, {
      ...subject,
      target: { id: "rules.002", hash: "new-b" },
      context: { id: "rules.003", hash: "new-c" },
    }),
  ).toBe(false);
  expect(revisionSemanticSuppression(input, { ...subject, action: "retire", reason: "supersedes" })).toBe(false);
});
it.each(["Use C++.\nKeep rules.", "x+rules.002.md||"])(
  "real singleton %j and pair tombstones retain producer hash arity",
  (body) => {
    const old = producerBlock("rules.001", body, 1),
      next = producerBlock("rules.001", "Changed body.", 2);
    const d: DismissedPair = { hashKey: entryHash(old.body), anchorKey: blockAnchor(old) };
    expect(
      revisionSemanticSuppression(index([d]), {
        action: "expires",
        reason: "budget",
        target: { id: next.id, hash: entryHash(next.body) },
      }),
    ).toBe("dismissed");
    // A singleton head resembling an unescaped pair must not invent a pair ban.
    expect(revisionSemanticSuppression(index([d]), subject)).toBe(false);
  },
);

it.each(["../rules.002.md", "/other/rules.002.md", "rules.002.md.bak"])(
  "composite real-producer comparison refuses foreign/malformed identity %s",
  (foreign) => {
    const a = producerBlock("rules.001", "Rule one.\nUse C++.", 1),
      b = producerBlock("rules.002", "Keep locks.", 1);
    const d: DismissedPair = {
      hashKey: [entryHash(a.body), entryHash(b.body)].sort().join("+"),
      anchorKey: [blockAnchor(a), blockAnchor(b).replace("rules.002.md", foreign)].sort().join("+"),
    };
    expect(revisionSemanticSuppression(index([d]), subject)).toBe(false);
  },
);
