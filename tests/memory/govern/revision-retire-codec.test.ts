/** Closed proof codecs and independently re-derived bindings over real C
 * history. Tampered JSON rows are test-owned untrusted local input, not approval. */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { setup } from "./revision-retire-helpers.js";
import { fixture, host } from "./revision-e-helpers.js";
import { createRevisionCommitter, type OwnedRevisionAction } from "../../../src/memory/govern/revision-commit.js";
import { restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import {
  freezeRevisionInputsLocked,
  prepareRevisionProposal,
  revisionBlockFromRaw,
  revisionCanonicalJson,
  revisionInputIsLiveLocked,
  revisionProposalDigest,
  validateRevisionProposal,
  validateRevisionRequestSpec,
  validateRetireEvidence,
} from "../../../src/memory/govern/revision.js";
import { prepareRevisionOutbound, revisionRequestDigests } from "../../../src/memory/jev/client.js";
import { upsertRevisionSuggestion } from "../../../src/memory/govern/review-lite.js";
import type { RevisionProposal, RetireEvidence } from "../../../src/memory/jev/contracts.js";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function reseal(p: RevisionProposal): RevisionProposal {
  return { ...p, proposalDigest: revisionProposalDigest(p) } as RevisionProposal;
}
function row(
  h: Awaited<ReturnType<typeof setup>>,
  f: Awaited<ReturnType<typeof h.retire>>["frozen"],
  p: RevisionProposal,
) {
  const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  index.review.suggestions.push({
    id: `revision:${p.actionId}`,
    kind: "supersedes",
    a: { hash: entryHash(f.target.block.body), anchor: f.target.id },
    b: { hash: entryHash(f.context!.block.body), anchor: f.context!.id },
    p: p.relation?.p ?? 0,
    at: "2026-11-10T00:00:00.000Z",
    revision: p,
  });
  fs.writeFileSync(h.indexPath, JSON.stringify(index));
}

it("generationRequest is frozen BEFORE actual source generation; a changed budget cannot backfill it", async () => {
  const h = await fixture(),
    f = await h.freeze(1, "merge-survivor");
  const budget = {
    registry: h.registry,
    mode: "sync" as const,
    budgetMs: 3000,
    maxOutputTokens: 2048,
    jobCostCapUsd: 10,
  };
  const generate = h.client.generateRevision;
  let requestCap = 0;
  vi.spyOn(h.client, "generateRevision").mockImplementation((request) => {
    expect(Object.isFrozen(request)).toBe(true);
    requestCap = request.maxOutputTokens;
    budget.maxOutputTokens = 129;
    return generate(request);
  });
  const prepared = await prepareRevisionProposal(f, {
    client: h.client,
    requestBudget: budget,
    attempt: {
      signal: new AbortController().signal,
      isCurrent: () => true,
      leaseValid: () => true,
      tryStartGenerate: () => true,
      capReached() {
        throw Error("cap");
      },
    },
    isSuppressed: async () => false,
    reason: "budget",
    autoEnabled: false,
  });
  expect(prepared.kind).toBe("ok");
  if (prepared.kind !== "ok") throw Error("source unavailable");
  expect(requestCap).toBe(2048);
  expect(budget.maxOutputTokens).toBe(129);
  expect(prepared.proposal.generationRequest).toEqual({
    v: 1,
    promptVersion: "p50-revision-v1",
    maxOutputTokens: 2048,
  });
  const x = await host(h, { frozen: f, proposal: prepared.proposal, generationMaxOutputTokens: 2048 });
  const audit = JSON.parse(fs.readFileSync(`${h.actionPath(f)}/audit.json`, "utf8"));
  expect(audit.generationRequest).toEqual(prepared.proposal.generationRequest);
  expect((await x.commit("web-b3")).kind).toBe("committed");
});

it.each(["generatedBody", "outputDigest", "generationProvenance", "generationInputComplete"] as const)(
  "generationRequest without %s is not a legacy bundle",
  async (field) => {
    const h = await setup(),
      p = JSON.parse(JSON.stringify(h.sourceProposal));
    delete p[field];
    p.proposalDigest = revisionProposalDigest(p);
    expect(validateRevisionProposal(p)).toBeUndefined();
  },
);

it("historical raw DTO exactly shares live admission and never grants LIVE capability", async () => {
  const h = await setup();
  const before = fs.readFileSync(`${h.sourcePath}/before.md`),
    rev = h.sourceFrozen.target.rev;
  const historical = revisionBlockFromRaw("rules.001", before, rev);
  const captured = historical.rawBefore;
  captured.fill(0);
  before.fill(0);
  expect(historical.rawBefore).toEqual(h.sourceFrozen.target.rawBefore);
  expect(() => revisionBlockFromRaw("rules.001", Buffer.from([0xff]), rev)).toThrow();
  for (const raw of [
    h.sourceFrozen.target.rawBefore.toString().replace("authority: agent", "authority: guest"),
    h.sourceFrozen.target.rawBefore.toString().replace("status: active", "status: archived"),
    h.sourceFrozen.target.rawBefore.toString().replace("status: active", "status: active\r\nprivate: true"),
    h.sourceFrozen.target.rawBefore.toString().replace("version: 7", "version: 7\r\nversion: 7"),
  ])
    expect(() => revisionBlockFromRaw("rules.001", Buffer.from(raw), rev)).toThrow();
  expect(revisionInputIsLiveLocked({ ...h.sourceFrozen, target: historical })).toBe(false);
});

it("new proof codecs execute zero getters/toJSON/toString and reject unknown nested execution fields", async () => {
  const h = await setup(),
    owned = await h.retire();
  let getters = 0;
  const good = owned.proposal.retireEvidence!;
  const variants = [
    {
      ...good,
      get source() {
        getters++;
        return good.source;
      },
    },
    {
      ...good,
      toJSON() {
        getters++;
        return good;
      },
    },
    {
      ...good,
      generationRequest: {
        ...good.generationRequest,
        get maxOutputTokens() {
          getters++;
          return 128;
        },
      },
    },
    { ...good, source: { ...good.source, path: "/tmp/foreign" } },
    { ...good, generatedBody: "do not execute" },
    { ...good, source: { ...good.source, raw: "body" } },
    { ...good, generationInputComplete: 1 },
    { ...good, coverageRequest: { ...good.coverageRequest, v: "1" } },
    { ...good, generationRequest: { ...good.generationRequest, promptVersion: "unsupported" } },
    { ...good, generationRequest: { ...good.generationRequest, maxOutputTokens: 0 } },
    { ...good, generationRequest: { ...good.generationRequest, maxOutputTokens: Infinity } },
    { ...good, source: { ...good.source, proposalDigest: "../path" } },
  ];
  for (const value of variants) expect(validateRetireEvidence(value)).toBeUndefined();
  expect(
    validateRevisionRequestSpec({
      get v() {
        getters++;
        return 1;
      },
      promptVersion: "p50-revision-v1",
      maxOutputTokens: 128,
    }),
  ).toBeUndefined();
  expect(
    validateRevisionRequestSpec({
      v: 1,
      promptVersion: "p50-revision-v1",
      maxOutputTokens: {
        toString() {
          getters++;
          return "128";
        },
      },
    }),
  ).toBeUndefined();
  expect(getters).toBe(0);
  const bad = { ...owned.proposal, generatedBody: "hidden retire body" };
  expect(validateRevisionProposal(reseal(bad as RevisionProposal))).toBeUndefined();
  const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  index.review.suggestions.push({
    id: "bad-retire",
    kind: "expired-user",
    a: { hash: "h", anchor: "rules.002" },
    p: 1,
    at: "now",
    revision: bad,
  });
  fs.writeFileSync(h.indexPath, JSON.stringify(index));
  expect(readIndex(h.dir).index.review?.suggestions.some((s) => s.id === "bad-retire")).toBe(false);
});

it("source reference freeze does not invoke an accessor", async () => {
  const h = await setup();
  let getters = 0;
  const f = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory: h.sourceFrozen.directory,
        selectionBatchId: "admitted",
        policyVersion: h.sourceFrozen.policyVersion,
        action: "retire",
        target: h.parse("rules.002"),
        context: h.parse("rules.001"),
        get retireSource() {
          getters++;
          return h.source;
        },
      },
      { isCurrent: () => true, audit: h.freshAudit() },
    ),
  );
  expect(f).toMatchObject({ kind: "refused" });
  expect(getters).toBe(0);
});

const tamper = [
  "generation-cap",
  "coverage-cap",
  "source-batch",
  "source-action",
  "source-proposal",
  "successor-raw",
  "generation-model",
  "generation-request",
  "generation-input",
  "coverage-binding",
  "candidate",
  "relation-raw",
] as const;
it.each(tamper)("even a rehashed %s proposal cannot replace independent frozen source/requests", async (kind) => {
  const h = await setup(),
    owned = await h.retire();
  const p = JSON.parse(JSON.stringify(owned.proposal));
  p.autoEligible = false; // a hint is not authorization; keep structure independently testable
  const re = p.retireEvidence;
  if (kind === "generation-cap") re.generationRequest.maxOutputTokens = 129;
  if (kind === "coverage-cap") re.coverageRequest.maxOutputTokens = 129;
  if (kind === "source-batch") re.source.batchId = "a".repeat(64);
  if (kind === "source-action") re.source.actionId = "a".repeat(64);
  if (kind === "source-proposal") re.source.proposalDigest = "a".repeat(64);
  if (kind === "successor-raw") re.successorRawDigest = "a".repeat(64);
  if (kind === "generation-model") re.generationProvenance.model = "invented";
  if (kind === "generation-request") re.generationProvenance.requestDigest = "a".repeat(64);
  if (kind === "generation-input") re.generationProvenance.inputDigest = "a".repeat(64);
  if (kind === "coverage-binding") p.evidenceBindings.coverage.requestDigest = "a".repeat(64);
  if (kind === "candidate") {
    re.outputDigest = "a".repeat(64);
    p.coverage.candidateDigest = re.outputDigest;
    const { evidenceDigest: _, ...payload } = p.coverage;
    p.coverage.evidenceDigest = sha(revisionCanonicalJson(payload));
  }
  if (kind === "relation-raw") p.relation.inputDigest = "a".repeat(64);
  const forged = reseal(p);
  expect(forged.proposalDigest).not.toBe(owned.proposal.proposalDigest);
  expect(validateRevisionProposal(forged)).toBeDefined();
  expect(
    await upsertRevisionSuggestion(
      h.dir,
      { frozen: owned.frozen, proposal: forged, origin: "p50-suggestion" },
      h.reviewDeps,
    ),
  ).not.toBe("saved");
  // A malicious local row cannot substitute for the actual frozen/audit proof.
  row(h, owned.frozen, forged);
  const apply = vi.spyOn(safeFs, "replaceRevisionObserved");
  const result = await createRevisionCommitter(h.dir, {
    actionLocked: () => ({ frozen: owned.frozen, proposal: forged }),
    runtime: () => ({
      plainMain: true,
      enabled: true,
      autoEnabled: true,
      sessionEpoch: 1,
      policyVersion: owned.frozen.policyVersion,
      dateRuleVersion: "date-v1",
    }),
    isCurrent: () => true,
    leaseValid: () => true,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
  }).commitAction({
    origin: "p50-auto",
    actionId: forged.actionId,
    expectedRev: forged.expectedRev,
    proposalDigest: forged.proposalDigest,
  });
  expect(result.kind).toBe("skipped");
  expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it("freeze custody detects coordinated post-freeze source+proposal cap/provenance mutation", async () => {
  const h = await setup(),
    owned = await h.retire();
  const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
  const oldSource = revisionBlockFromRaw("rules.001", fs.readFileSync(`${h.sourcePath}/before.md`), a.expectedRev);
  const dto = prepareRevisionOutbound(
    {
      registry: {},
      mode: "sync",
      budgetMs: 1,
      maxOutputTokens: 129,
      instruction: "merge-survivor",
      target: oldSource.block,
      context: owned.frozen.target.block,
    },
    "generate",
  )!;
  const binding = revisionRequestDigests(dto.outbound, 129);
  a.generationRequest.maxOutputTokens = 129;
  a.evidenceBindings.generation = binding;
  a.generationProvenance.requestDigest = binding.requestDigest;
  a.generationProvenance.inputDigest = binding.inputDigest;
  fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
  const p = JSON.parse(JSON.stringify(owned.proposal));
  p.autoEligible = false;
  p.retireEvidence.generationRequest = a.generationRequest;
  p.retireEvidence.generationProvenance = a.generationProvenance;
  p.evidenceBindings.generation = binding;
  const forged = reseal(p);
  expect(validateRevisionProposal(forged)).toBeDefined();
  expect(
    await upsertRevisionSuggestion(
      h.dir,
      { frozen: owned.frozen, proposal: forged, origin: "p50-suggestion" },
      h.reviewDeps,
    ),
  ).toBe("stale");
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
});

// Compiled by the independent strict gate; never executed as a runtime stub.
function compileClosedRetire(proposal: Extract<RevisionProposal, { action: "retire" }>, proof: RetireEvidence) {
  // @ts-expect-error a retire proof cannot carry executable generated body
  const body: RetireEvidence = { ...proof, generatedBody: "forbidden" };
  // @ts-expect-error historical generation completeness must be literal true
  const partial: RetireEvidence = { ...proof, generationInputComplete: false };
  // @ts-expect-error source request spec is nested, never a retire executable field
  const executable: RevisionProposal = { ...proposal, generationRequest: proof.generationRequest };
  return [body, partial, executable];
}

it("legacy source body without request spec still confirms/restores, but cannot be back-signed for auto retire", async () => {
  const h = await fixture(),
    f = await h.freeze(1, "merge-survivor"),
    generated = await h.prepare(f);
  if (generated.kind !== "ok") throw Error("source unavailable");
  const { generationRequest: _, ...oldPayload } = generated.proposal;
  const oldProposal = reseal(oldPayload as RevisionProposal);
  expect(validateRevisionProposal(oldProposal)).toBeDefined();
  const x = await host(h, { frozen: f, proposal: oldProposal });
  const path = `${h.actionPath(f)}/audit.json`;
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(path, "utf8")), "generationRequest")).toBe(false);
  expect((await x.commit("web-b3")).kind).toBe("committed");
  const parse = (id: string) => {
    const b = revisionBlockFromRaw(
      id,
      fs.readFileSync(`${h.blocks}/${id}.md`),
      id === f.context!.id ? f.context!.rev : JSON.parse(fs.readFileSync(path, "utf8")).expectedAfter.rev,
    );
    return { id: b.id, rev: b.rev };
  };
  const retire = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory: f.directory,
        selectionBatchId: "admitted-old-source-pass",
        policyVersion: f.policyVersion,
        action: "retire",
        target: parse("rules.002"),
        context: parse("rules.001"),
        retireSource: { batchId: f.batchId, actionId: f.actionId, proposalDigest: oldProposal.proposalDigest },
      },
      { isCurrent: () => true, audit: h.audit },
    ),
  );
  if ("kind" in retire) throw Error("legacy retire freeze");
  const calls = h.calls.length;
  const prepared = await prepareRevisionProposal(retire, {
    client: h.client,
    requestBudget: { registry: h.registry, mode: "sync", budgetMs: 3000, maxOutputTokens: 128, jobCostCapUsd: 10 },
    attempt: {
      signal: new AbortController().signal,
      isCurrent: () => true,
      leaseValid: () => true,
      tryStartGenerate() {
        throw Error("cannot back-sign historical request");
      },
      capReached() {},
    },
    isSuppressed: async () => false,
    reason: "supersedes",
    autoEnabled: true,
  });
  expect(prepared).toMatchObject({ kind: "ok", proposal: { autoEligible: false } });
  expect(h.calls).toHaveLength(calls);
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(path, "utf8")), "generationRequest")).toBe(false);
  expect((await restoreRevisionRaw(h.dir, { actionId: f.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(f.target.rawBefore);
  expect(Object.hasOwn(JSON.parse(fs.readFileSync(path, "utf8")), "generationRequest")).toBe(false);
});

it.each([
  "reference-digest",
  "audit-cap",
  "missing-batch",
  "missing-action",
  "context-raw",
  "raw-input",
  "output",
  "generation-request",
  "generation-input",
  "generation-binding",
  "legacy-bad-output",
  "legacy-bad-binding",
  "legacy-both-inputs",
] as const)("pre-freeze semantic source failure %s is never stripped into a confirmed retire", async (kind) => {
  const h = await setup(),
    source = { ...h.source };
  const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
  if (kind === "reference-digest") source.proposalDigest = "a".repeat(64);
  if (kind === "audit-cap") a.generationRequest.maxOutputTokens = 129; // old bindings/provenance deliberately retained
  if (kind === "missing-batch") source.batchId = "a".repeat(64);
  if (kind === "missing-action") source.actionId = "a".repeat(64);
  if (kind === "context-raw") a.contextRawDigest = "a".repeat(64);
  if (kind === "raw-input") a.inputDigest = "a".repeat(64);
  if (kind === "output" || kind === "legacy-bad-output") a.outputDigest = "a".repeat(64);
  if (kind === "generation-request") a.generationProvenance.requestDigest = "a".repeat(64);
  if (kind === "generation-input" || kind === "legacy-bad-binding") a.generationProvenance.inputDigest = "a".repeat(64);
  if (kind === "generation-binding") a.evidenceBindings.generation.requestDigest = "a".repeat(64);
  if (kind === "legacy-both-inputs") {
    a.generationProvenance.inputDigest = "a".repeat(64);
    a.evidenceBindings.generation.inputDigest = "a".repeat(64);
  }
  if (kind.startsWith("legacy-")) delete a.generationRequest;
  fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
  const before = fs.readFileSync(h.contextPath),
    successor = fs.readFileSync(h.targetPath);
  const indexBefore = fs.readFileSync(h.indexPath),
    sourceBefore = fs.readFileSync(h.sourceAuditPath);
  const auditsRoot = `${h.blocks}/.jev/revisions`;
  const auditNames = fs.readdirSync(auditsRoot, { recursive: true }).sort();
  const dispatches = h.calls.length;
  const data = vi.spyOn(safeFs, "replaceRevisionObserved");
  const frozen = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory: h.sourceFrozen.directory,
        selectionBatchId: "admitted-semantic-source-pass",
        policyVersion: h.sourceFrozen.policyVersion,
        action: "retire",
        target: h.parse("rules.002"),
        context: h.parse("rules.001"),
        retireSource: source,
      },
      { isCurrent: () => true, audit: h.freshAudit() },
    ),
  );
  // This real driver intentionally proceeds if freeze is erroneously accepted:
  // the pre-fix undefined->plain path would publish and physically retire on
  // this exact one-shot host confirmation, exposing more than a flag mismatch.
  let owned: OwnedRevisionAction | undefined;
  if (!("kind" in frozen)) {
    const prepared = await h.prepareRetire(frozen);
    if (prepared.kind === "ok") {
      const saved = await upsertRevisionSuggestion(
        h.dir,
        { frozen, proposal: prepared.proposal, origin: "p50-suggestion" },
        h.reviewDeps,
      );
      if (saved === "saved") owned = { frozen, proposal: prepared.proposal };
    }
  }
  let consumed = false;
  const confirmation = vi.fn((request, proposal) => {
    expect(fs.existsSync(`${h.dir}/.lock`)).toBe(true);
    expect(request.actionId).toBe(proposal.actionId);
    expect(request.expectedRev).toBe(proposal.expectedRev);
    expect(request.proposalDigest).toBe(proposal.proposalDigest);
    if (consumed) return false;
    consumed = true;
    return true;
  });
  const result = await createRevisionCommitter(h.dir, {
    actionLocked: (id) => (id === owned?.proposal.actionId ? owned : undefined),
    runtime: () => ({
      plainMain: true,
      enabled: true,
      autoEnabled: true,
      sessionEpoch: 1,
      policyVersion: h.sourceFrozen.policyVersion,
      dateRuleVersion: "date-v1",
    }),
    isCurrent: () => true,
    leaseValid: () => true,
    now: () => new Date("2026-11-10T00:00:00.000Z"),
    consumeConfirmedLocked: confirmation,
  }).commitAction({
    origin: "web-b3",
    actionId: owned?.proposal.actionId ?? "1".repeat(64),
    expectedRev: owned?.proposal.expectedRev ?? h.parse("rules.002").rev,
    proposalDigest: owned?.proposal.proposalDigest ?? "2".repeat(64),
  });
  expect(frozen).toMatchObject({ kind: "refused", reason: "unavailable" });
  expect(result.kind).toBe("skipped");
  expect(confirmation).not.toHaveBeenCalled();
  expect(consumed).toBe(false);
  expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.readFileSync(h.contextPath)).toEqual(before);
  expect(fs.readFileSync(h.targetPath)).toEqual(successor);
  expect(fs.readFileSync(h.indexPath)).toEqual(indexBefore);
  expect(fs.readFileSync(h.sourceAuditPath)).toEqual(sourceBefore);
  expect(readIndex(h.dir).index.review?.suggestions.some((s) => s.revision?.action === "retire")).toBe(false);
  expect(fs.readdirSync(auditsRoot, { recursive: true }).sort()).toEqual(auditNames);
  expect(h.calls).toHaveLength(dispatches);
});

it("no requested source remains an explicit confirmed-only operation, not an invalid-source failure", async () => {
  const h = await setup(),
    frozen = await h.freezeRetire(false),
    prepared = await h.prepareRetire(frozen);
  expect(prepared.kind).toBe("ok");
  if (prepared.kind !== "ok") throw Error("manual retire unavailable");
  expect(prepared.proposal.autoEligible).toBe(false);
  expect(Object.hasOwn(prepared.proposal, "retireEvidence")).toBe(false);
  const x = await host(h, { frozen, proposal: prepared.proposal });
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(x.confirm).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});
