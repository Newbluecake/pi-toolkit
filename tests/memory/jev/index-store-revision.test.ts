import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createBlockLocked, replaceBlockLocked } from "../../../src/memory/blocks/store.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import {
  freezeRevisionInputsLocked,
  planRevisionActions,
  revisionCanonicalJson,
  revisionProposalDigest,
  validateRevisionProposal,
} from "../../../src/memory/govern/revision.js";
import {
  gcBlockIndex,
  mergeReview,
  readIndex,
  suggestionKey,
  writeIndexPatch,
} from "../../../src/memory/jev/index-store.js";
import type {
  ClientProvenance,
  RevisionProposal,
  RevisionProposalDigestInput,
  ReviewSuggestion,
  ReviewState,
} from "../../../src/memory/jev/contracts.js";
const roots: string[] = [];
const now = new Date("2026-11-10T00:00:00Z");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(action: RevisionProposal["action"] = "expires", context = false) {
  const dir = mkdtempSync(join(tmpdir(), "p50-d-index-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const a = createBlockLocked(join(dir, "blocks"), "rules", { authority: "agent" }, "Keep the original rule.", now);
  const b = createBlockLocked(join(dir, "blocks"), "rules", { authority: "agent" }, "Keep second rule.", now);
  const { dev, ino } = inspectDirNoFollow(dir);
  const f = await withMemoryDirLock(dir, () =>
    freezeRevisionInputsLocked(
      dir,
      {
        directory: { realpath: dir, dev, ino, sessionEpoch: 1 },
        selectionBatchId: "selection",
        policyVersion: "policy-v1",
        action,
        target: a,
        ...(context ? { context: b } : {}),
      },
      { isCurrent: () => true },
    ),
  );
  if ("kind" in f) throw new Error("fixture freeze failed");
  const p = planRevisionActions({
    candidates: [
      {
        frozen: f,
        reason: "expired",
        ...(action === "expires"
          ? { expiry: { op: "set" as const, nextExpires: "2027-02-01", dateRuleVersion: "date-v1" } }
          : {}),
      },
    ],
    autoEnabled: false,
    leaseValid: true,
  })[0]!;
  const row: ReviewSuggestion = {
    id: `revision:${p.actionId}`,
    kind: "expired-user",
    a: { hash: entryHash(a.body), anchor: a.id },
    ...(context ? { b: { hash: entryHash(b.body), anchor: b.id } } : {}),
    p: 0.99,
    at: now.toISOString(),
    revision: p,
  };
  const review = (suggestions: readonly ReviewSuggestion[], extra: Partial<ReviewState> = {}): ReviewState => ({
    lastRunAt: now.toISOString(),
    corpusFp: "fp",
    suggestions,
    dismissed: [],
    ...extra,
  });
  const indexPath = join(dir, "blocks/.jev/index.json");
  const rawIndex = (suggestions: unknown[]) => {
    mkdirSync(join(dir, "blocks/.jev"), { recursive: true, mode: 0o700 });
    writeFileSync(indexPath, JSON.stringify({ v: 1, entries: {}, review: review(suggestions as ReviewSuggestion[]) }));
  };
  return { dir, a, b, f, p, row, review, rawIndex, indexPath };
}
function redigest(p: RevisionProposal, change: Record<string, unknown>) {
  const { proposalDigest: _old, ...payload } = { ...p, ...change };
  return { ...payload, proposalDigest: revisionProposalDigest(payload as RevisionProposalDigestInput) };
}
it.each(["rewrite-single", "merge-survivor", "retire", "delete", "expires"] as const)(
  "roundtrips the full %s union through real sidecar writer/sanitizer",
  async (action) => {
    const h = await fixture(action, action === "merge-survivor" || action === "retire");
    expect(await writeIndexPatch(h.dir, { review: h.review([h.row]) })).toBe("ok");
    expect(readIndex(h.dir).index.review?.suggestions).toEqual([h.row]);
    expect(JSON.parse(readFileSync(h.indexPath, "utf8")).review.suggestions[0].revision).toEqual(h.p);
  },
);
it("preserves the entire generated bundle and unknown actual provenance as suggestion, never promotes it", async () => {
  const h = await fixture("rewrite-single");
  const provenance: ClientProvenance = {
    provider: "",
    model: "",
    adapterId: "local-v1",
    chainVersion: "v1",
    routeIdentity: "unknown",
    routeAliases: [],
    requestChainId: "local/generator",
    requestDigest: hash("request"),
    inputDigest: hash("input"),
    trusted: false,
  };
  const p = redigest(h.p, {
    generatedBody: "Keep all still-valid rules.",
    outputDigest: hash("Keep all still-valid rules."),
    generationInputComplete: false,
    generationProvenance: provenance,
    evidenceBindings: { generation: { requestDigest: hash("request"), inputDigest: hash("input") } },
  });
  expect(validateRevisionProposal(p)).toEqual(p);
  const row = { ...h.row, revision: p as RevisionProposal };
  await writeIndexPatch(h.dir, { review: h.review([row]) });
  const saved = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(saved).toEqual(p);
  expect(saved.autoEligible).toBe(false);
});
it.each([
  "null",
  "bad-digest",
  "unknown-field",
  "half-body",
  "unexpected-expiry",
  "bad-date",
  "bad-id",
  "wrong-anchor",
  "wrong-kind",
  "bad-context",
  "forged-auto",
])("drops whole invalid %s row, never downgrades it to legacy", async (which) => {
  const h = await fixture("rewrite-single");
  const changes: Record<string, unknown> = {
    null: null,
    "bad-digest": { ...h.p, proposalDigest: hash("bad") },
    "unknown-field": redigest(h.p, { futureExecution: "delete" }),
    "half-body": redigest(h.p, { generatedBody: "safe" }),
    "unexpected-expiry": redigest(h.p, { expiry: { op: "clear", dateRuleVersion: "v1" } }),
    "bad-date": redigest(h.p, {
      action: "expires",
      expiry: { op: "set", nextExpires: "2027-02-30", dateRuleVersion: "v1" },
    }),
    "bad-id": redigest(h.p, { targetId: "../../escape" }),
    "bad-context": redigest(h.p, { contextId: h.b.id }),
    "forged-auto": redigest(h.p, { autoEligible: true }),
  };
  const bad =
    which === "wrong-anchor"
      ? { ...h.row, a: { hash: h.row.a.hash, anchor: "other.001" } }
      : which === "wrong-kind"
        ? { ...h.row, kind: "pointer" }
        : { ...h.row, revision: changes[which] };
  const legacy = { id: "legacy", kind: "oversize", a: h.row.a, p: 1, at: now.toISOString() };
  h.rawIndex([bad, legacy]);
  expect(readIndex(h.dir).index.review!.suggestions).toEqual([legacy]);
});
it("legacy suggestion keys and serialized fields stay unchanged", async () => {
  const h = await fixture();
  const legacy: ReviewSuggestion = {
    id: "old-id",
    kind: "oversize",
    a: { hash: h.row.a.hash, anchor: `${h.a.id}.md|section|old prefix` },
    p: 0.9,
    at: "2026-11-01",
  };
  expect(suggestionKey(legacy)).toBe(JSON.stringify(["oversize", `${h.a.id}.md`]));
  h.rawIndex([legacy]);
  expect(JSON.stringify(readIndex(h.dir).index.review!.suggestions[0])).toBe(JSON.stringify(legacy));
  await writeIndexPatch(h.dir, { review: h.review([legacy]) });
  expect(JSON.stringify(JSON.parse(readFileSync(h.indexPath, "utf8")).review.suggestions[0])).toBe(
    JSON.stringify(legacy),
  );
  expect(readFileSync(h.indexPath, "utf8")).not.toContain("revision");
});
it("revision semantic identity is action plus sorted immutable IDs, never hash/rev/batch", async () => {
  const h = await fixture("retire", true),
    key = suggestionKey(h.row);
  expect(key).toBe(JSON.stringify(["revision", "retire", h.a.id, h.b.id]));
  const next = {
    ...h.row,
    a: { hash: "new", anchor: "unrelated" },
    revision: { ...h.p, batchId: hash("new"), expectedRev: "2-abcdef", actionId: hash("next") } as RevisionProposal,
  };
  expect(suggestionKey(next)).toBe(key);
  const reverse = { ...h.row, revision: { ...h.p, targetId: h.b.id, contextId: h.a.id } as RevisionProposal };
  expect(suggestionKey(reverse)).toBe(key);
  expect(suggestionKey({ ...h.row, revision: { ...h.p, action: "merge-survivor" } as RevisionProposal })).not.toBe(key);
});
it.each(["dismissed", "resolved"])(
  "merge permanently suppresses %s revision across new rev/body/batch",
  async (which) => {
    const h = await fixture();
    const key = suggestionKey(h.row);
    const tombstone = h.review(
      [],
      which === "resolved"
        ? { resolved: [key] }
        : { dismissed: [{ suggestionKey: key, kind: h.row.kind, hashKey: h.row.a.hash, anchorKey: h.row.a.anchor }] },
    );
    const next = {
      ...h.row,
      id: "new-action",
      at: "2027-01-01",
      a: { ...h.row.a, hash: "new-body" },
      revision: { ...h.p, batchId: hash("new"), expectedRev: "2-abcdef" } as RevisionProposal,
    };
    const merged = mergeReview(tombstone, h.review([next]));
    expect(merged.suggestions).toEqual([]);
    expect(mergeReview(merged, h.review([h.row])).suggestions).toEqual([]);
  },
);
it("merge with snapshot cannot overwrite a new proposal arriving in flight", async () => {
  const h = await fixture();
  const base = h.review([h.row]);
  const current = h.review([
    { ...h.row, at: "2026-11-12", revision: { ...h.p, expectedRev: "2-abcdef" } as RevisionProposal },
  ]);
  const incoming = h.review([{ ...h.row, at: "2026-11-13" }]);
  expect(mergeReview(current, incoming, base).suggestions).toEqual(current.suggestions);
});
it("GC checks both revision IDs/revs and hashes even if another block shares the body", async () => {
  const h = await fixture("retire", true);
  const index = { v: 1 as const, entries: {}, review: h.review([h.row], { resolved: ["permanent"] }) };
  const hashes = new Set([h.row.a.hash, h.row.b!.hash]);
  const live = new Map([
    [h.a.id, { rev: h.a.rev, hash: h.row.a.hash }],
    [h.b.id, { rev: h.b.rev, hash: h.row.b!.hash }],
  ]);
  expect(gcBlockIndex(index, hashes, "2099-01-01", live).review!.suggestions).toEqual([h.row]);
  for (const map of [
    new Map([[h.a.id, live.get(h.a.id)!]]),
    new Map([...live, [h.b.id, { rev: "2-abcdef", hash: h.row.b!.hash }]]),
    new Map([...live, [h.a.id, { rev: h.a.rev, hash: "wrong" }]]),
  ]) {
    const out = gcBlockIndex(index, hashes, "2099-01-01", map);
    expect(out.review!.suggestions).toEqual([]);
    expect(out.review!.resolved).toEqual(["permanent"]);
  }
  // The real writer supplies these exact revision maps, not just live hashes.
  await writeIndexPatch(h.dir, { review: h.review([h.row]) });
  replaceBlockLocked(join(h.dir, "blocks"), h.b.id, h.b.rev, { meta: h.b.meta, body: h.b.body }, now);
  await writeIndexPatch(h.dir, {});
  expect(readIndex(h.dir).index.review!.suggestions).toEqual([]);
});
it("canonical JSON ignores key insertion order but payload mutation never reuses digest", async () => {
  const h = await fixture();
  const { proposalDigest: _self, ...payload } = h.p;
  const reordered = Object.fromEntries(Object.entries(payload).reverse()) as RevisionProposalDigestInput;
  expect(revisionProposalDigest(reordered)).toBe(h.p.proposalDigest);
  expect(hash(revisionCanonicalJson(payload))).toBe(h.p.proposalDigest);
  expect(revisionProposalDigest({ ...payload, policyVersion: "policy-v2" })).not.toBe(h.p.proposalDigest);
  expect(revisionProposalDigest({ ...payload, directoryIdentityDigest: hash("other-directory") })).not.toBe(
    h.p.proposalDigest,
  );
});
