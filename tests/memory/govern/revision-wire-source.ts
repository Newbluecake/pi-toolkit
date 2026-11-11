/** Test-only source seeding via REAL D/C/E and the SAME wire-owned SDK client.
 * Explicit one-shot fixture confirmation is not a production B3/native UI claim. */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { wireFixture } from "./revision-wire-helpers.js";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import {
  freezeRevisionInputsLocked,
  prepareRevisionProposal,
  revisionRelationContext,
} from "../../../src/memory/govern/revision.js";
import { REVISION_HOST_POLICY_VERSION } from "../../../src/memory/govern/revision-host.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import { revisionSuggestionSuppressed, upsertRevisionSuggestion } from "../../../src/memory/govern/review-lite.js";
import { commitAction } from "../../../src/memory/govern/revision-commit.js";

export async function seedWireSource(h: Awaited<ReturnType<typeof wireFixture>>) {
  const owner = h.memoryScopes!.current()!;
  const directory = { realpath: h.dir, ...inspectDirNoFollow(h.dir), sessionEpoch: owner.owner.sessionEpoch };
  const parsed = (id: string) => {
    const block = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
    if ("stray" in block) throw Error("source fixture block missing");
    return block;
  };
  const frozen = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory,
        selectionBatchId: "offline-source-seed",
        policyVersion: REVISION_HOST_POLICY_VERSION,
        action: "merge-survivor",
        target: parsed("rules.001"),
        context: parsed("rules.002"),
      },
      { isCurrent: () => owner.current() },
    ),
  );
  if ("kind" in frozen) throw Error(`source freeze ${frozen.reason}`);
  const budget = {
    registry: h.binding.registry,
    mode: "background" as const,
    budgetMs: 3000,
    maxOutputTokens: 2048,
    jobId: frozen.batchId,
    jobCostCapUsd: h.settings.incremental.jobCostCapUsd,
  };
  const relation = await h.client!.ask({
    duty: "review",
    registry: h.binding.registry,
    ...revisionRelationContext(frozen),
    mode: "background",
    budgetMs: 3000,
    jobId: frozen.batchId,
    jobCostCapUsd: budget.jobCostCapUsd,
  });
  expect(relation.ok).toBe(true);
  const result = await prepareRevisionProposal(frozen, {
    client: h.client!,
    requestBudget: budget,
    attempt: {
      signal: owner.signal,
      isCurrent: () => owner.current(),
      leaseValid: () => true,
      tryStartGenerate: () => true,
      capReached: () => {
        throw Error("source seed budget");
      },
    },
    isSuppressed: (f, reason) => revisionSuggestionSuppressed(h.dir, f, { isCurrent: () => owner.current() }, reason),
    relation: { kind: "conflict", p: 0.99, outcome: relation },
    reason: "conflict",
    autoEnabled: false,
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw Error("source prepare");
  const audit = createRevisionAuditPort(h.dir, { isCurrent: () => owner.current(), now: () => new Date() });
  const reviewDeps = { audit, isCurrent: () => owner.current(), leaseValid: () => true, now: () => new Date() };
  expect(
    await upsertRevisionSuggestion(h.dir, { frozen, proposal: result.proposal, origin: "p50-suggestion" }, reviewDeps),
  ).toBe("saved");
  const proposal = h.suggestions().find((s) => s.revision?.actionId === frozen.actionId)!.revision!;
  let confirmed = false;
  const committed = await commitAction(
    h.dir,
    {
      origin: "web-b3",
      actionId: proposal.actionId,
      expectedRev: proposal.expectedRev,
      proposalDigest: proposal.proposalDigest,
    },
    {
      actionLocked: (id) =>
        id === proposal.actionId
          ? { frozen, proposal, generationMaxOutputTokens: 2048, coverageMaxOutputTokens: 2048 }
          : undefined,
      runtime: () => ({
        plainMain: true,
        enabled: true,
        autoEnabled: false,
        sessionEpoch: directory.sessionEpoch,
        policyVersion: REVISION_HOST_POLICY_VERSION,
        dateRuleVersion: "",
      }),
      isCurrent: () => owner.current(),
      leaseValid: () => true,
      now: () => new Date(),
      consumeConfirmedLocked: (req, p) => {
        expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
        expect(req.actionId).toBe(proposal.actionId);
        expect(req.proposalDigest).toBe(p.proposalDigest);
        if (confirmed) return false;
        confirmed = true;
        return true;
      },
    },
  );
  expect(committed.kind).toBe("committed");
  expect(confirmed).toBe(true);
  return {
    frozen,
    proposal,
    oldBefore: fs.readFileSync(join(h.blocks, "rules.002.md")),
    successorAfter: fs.readFileSync(join(h.blocks, "rules.001.md")),
  };
}
