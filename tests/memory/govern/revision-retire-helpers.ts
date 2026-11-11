/** Approved automatic-retire chain: REAL A/B client, D freeze/prepare, C disk
 * barriers, E confirmation/auto action and C raw restore over own /tmp data. */
import * as fs from "node:fs";
import { join } from "node:path";
import type { FrozenRevisionInput } from "../../../src/memory/jev/contracts.js";
import { expect, it, vi } from "vitest";
import { fixture, host } from "./revision-e-helpers.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import { freezeRevisionInputsLocked, prepareRevisionProposal } from "../../../src/memory/govern/revision.js";
import { revisionSuggestionSuppressed } from "../../../src/memory/govern/review-lite.js";
import * as safeFs from "../../../src/memory/safe-fs.js";

export async function setup(
  authority: "agent" | "user" = "agent",
  options: Parameters<typeof fixture>[2] = {},
  oldAuthority: "agent" | "user" = authority,
  unknown = false,
) {
  const h = await fixture(unknown, authority, options);
  if (oldAuthority !== authority)
    fs.writeFileSync(
      h.contextPath,
      h.contextBefore.toString().replace(`authority: ${authority}`, `authority: ${oldAuthority}`),
    );
  const sourceFrozen = await h.freeze(1, "merge-survivor");
  const gen = vi.spyOn(h.client, "generateRevision");
  const generated = await h.prepare(sourceFrozen);
  expect(generated.kind).toBe("ok");
  if (generated.kind !== "ok") throw Error("source preparation failed");
  const sourceProposal = generated.proposal;
  expect(sourceProposal.generationRequest).toEqual({ v: 1, promptVersion: "p50-revision-v1", maxOutputTokens: 2048 });
  expect(Object.isFrozen(sourceProposal.generationRequest)).toBe(true);
  expect(Object.isFrozen(gen.mock.calls[0]![0])).toBe(true);
  const sourceHost = await host(h, {
    frozen: sourceFrozen,
    proposal: sourceProposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  });
  const sourcePath = h.actionPath(sourceFrozen),
    sourceAuditPath = join(sourcePath, "audit.json");
  expect(JSON.parse(fs.readFileSync(sourceAuditPath, "utf8"))).toMatchObject({
    state: "prepared",
    generationRequest: sourceProposal.generationRequest,
  });
  const replace = safeFs.replaceRevisionObserved;
  const observe = vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[0] === h.blocks) {
      const disk = JSON.parse(fs.readFileSync(sourceAuditPath, "utf8"));
      expect(disk.state).toBe("proposed");
      expect(disk.generationRequest).toEqual(sourceProposal.generationRequest);
    }
    return replace(...args);
  });
  expect((await sourceHost.commit("web-b3")).kind).toBe("committed");
  observe.mockRestore();
  const successorAfter = fs.readFileSync(h.targetPath),
    oldBefore = fs.readFileSync(h.contextPath);
  const source = {
    batchId: sourceFrozen.batchId,
    actionId: sourceFrozen.actionId,
    proposalDigest: sourceProposal.proposalDigest,
  };
  const freshAudit = () => createRevisionAuditPort(h.dir, h.auditDeps);
  const parse = (id: string) => {
    const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
    if ("stray" in b) throw Error("fixture stray");
    return b;
  };
  const freezeRetire = async (
    withSource = true,
    actions?: Parameters<typeof freezeRevisionInputsLocked>[1]["actions"],
  ) => {
    const f = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: sourceFrozen.directory,
          selectionBatchId: "admitted-retire-pass",
          policyVersion: sourceFrozen.policyVersion,
          action: "retire",
          target: parse("rules.002"),
          context: parse("rules.001"),
          ...(withSource ? { retireSource: source } : {}),
          ...(actions ? { actions } : {}),
        },
        { isCurrent: () => h.state.current, audit: freshAudit() },
      ),
    );
    if ("kind" in f) throw Error(`retire freeze ${f.reason}`);
    return f;
  };
  const prepare = async (f: FrozenRevisionInput) => {
    const tryGenerate = vi.fn(() => {
      throw Error("retire must not generate");
    });
    const result = await prepareRevisionProposal(f, {
      client: h.client,
      requestBudget: { registry: h.registry, mode: "sync", budgetMs: 3000, maxOutputTokens: 128, jobCostCapUsd: 10 },
      attempt: {
        signal: new AbortController().signal,
        isCurrent: () => h.state.current,
        leaseValid: () => true,
        tryStartGenerate: tryGenerate,
        capReached() {
          throw Error("unexpected test cap");
        },
      },
      isSuppressed: (f) => revisionSuggestionSuppressed(h.dir, f, { isCurrent: () => h.state.current }),
      reason: "supersedes",
      autoEnabled: true,
    });
    expect(tryGenerate).not.toHaveBeenCalled();
    return result;
  };
  const retire = async () => {
    const frozen = await freezeRetire(),
      prepared = await prepare(frozen);
    expect(prepared.kind).toBe("ok");
    if (prepared.kind !== "ok") throw Error("retire preparation unavailable");
    return { frozen, proposal: prepared.proposal };
  };
  const gcSourceReview = () => {
    const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
    index.review.suggestions = index.review.suggestions.filter(
      (s: { id: string }) => s.id !== `revision:${source.actionId}`,
    );
    fs.writeFileSync(h.indexPath, JSON.stringify(index));
  };
  return {
    ...h,
    sourceFrozen,
    sourceProposal,
    source,
    sourceAuditPath,
    sourcePath,
    successorAfter,
    oldBefore,
    freshAudit,
    freezeRetire,
    prepareRetire: prepare,
    retire,
    gen,
    gcSourceReview,
    parse,
  };
}

/** Sources are committed first; ONE predeclared full retirement action set
 * owns the subsequent batch. Never make a new batch per action/retry. */
export async function setupMany(count: number, options: NonNullable<Parameters<typeof fixture>[2]> = {}) {
  const h = await setup("agent", options);
  const pairs = [{ successor: "rules.001", target: "rules.002", source: h.source }];
  for (let i = 1; i < count; i++) {
    const successor = `rules.${String(i * 2 + 1).padStart(3, "0")}`,
      target = `rules.${String(i * 2 + 2).padStart(3, "0")}`;
    fs.writeFileSync(join(h.blocks, `${successor}.md`), h.sourceFrozen.target.rawBefore, { mode: 0o600 });
    fs.writeFileSync(join(h.blocks, `${target}.md`), h.sourceFrozen.context!.rawBefore, { mode: 0o600 });
    const f = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.sourceFrozen.directory,
          selectionBatchId: `source-pass-${i}`,
          policyVersion: h.sourceFrozen.policyVersion,
          action: "merge-survivor",
          target: h.parse(successor),
          context: h.parse(target),
        },
        { isCurrent: () => true },
      ),
    );
    if ("kind" in f) throw Error("source freeze");
    const prepared = await h.prepare(f);
    if (prepared.kind !== "ok") throw Error("source prepare");
    const x = await host(h, {
      frozen: f,
      proposal: prepared.proposal,
      generationMaxOutputTokens: 2048,
      coverageMaxOutputTokens: 2048,
    });
    expect((await x.commit("web-b3")).kind).toBe("committed");
    pairs.push({
      successor,
      target,
      source: { batchId: f.batchId, actionId: f.actionId, proposalDigest: prepared.proposal.proposalDigest },
    });
  }
  const actions = pairs.map((pair) => ({
    action: "retire" as const,
    target: h.parse(pair.target),
    context: h.parse(pair.successor),
  }));
  const frozen = [];
  for (const [i, pair] of pairs.entries()) {
    const f = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.sourceFrozen.directory,
          selectionBatchId: "admitted-complete-retire-pass",
          policyVersion: h.sourceFrozen.policyVersion,
          ...actions[i]!,
          actions,
          retireSource: pair.source,
        },
        { isCurrent: () => true, audit: h.freshAudit() },
      ),
    );
    if ("kind" in f) throw Error("retire freeze");
    frozen.push(f);
  }
  expect(new Set(frozen.map((f) => f.batchId)).size).toBe(1);
  return { h, pairs, frozen };
}
