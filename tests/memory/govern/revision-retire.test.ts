/** Approved automatic-retire chain: REAL A/B client, D freeze/prepare, C disk
 * barriers, E confirmation/auto action and C raw restore over own /tmp data. */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture, host } from "./revision-e-helpers.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { prepareRevisionProposal } from "../../../src/memory/govern/revision.js";
import { revisionSuggestionSuppressed, upsertRevisionSuggestion } from "../../../src/memory/govern/review-lite.js";
import * as safeFs from "../../../src/memory/safe-fs.js";

import { setup } from "./revision-retire-helpers.js";

it.each([
  ["agent", {}],
  ["user", {}],
  ["agent", { relationGenerationSame: true }],
  ["agent", { failover: true }],
] as const)(
  "real generated source→confirmed survivor→fresh factories/GC→auto retire→raw restore (%s %j)",
  async (authority, options) => {
    const h = await setup(authority, options);
    h.gcSourceReview();
    const genCalls = h.gen.mock.calls.length,
      callsBefore = h.calls.length;
    const owned = await h.retire();
    expect(owned.proposal.autoEligible).toBe(true);
    expect(owned.proposal.action).toBe("retire");
    expect(owned.proposal.retireEvidence).toMatchObject({
      source: h.source,
      generationInputComplete: true,
      generationRequest: h.sourceProposal.generationRequest,
      coverageRequest: { maxOutputTokens: 128 },
    });
    expect(Object.hasOwn(owned.proposal, "generatedBody")).toBe(false);
    expect(h.gen).toHaveBeenCalledTimes(genCalls);
    expect(h.calls.slice(callsBefore)).toEqual(
      (options as NonNullable<Parameters<typeof fixture>[2]>).failover
        ? ["rel/main", "judge/fail", "judge/main"]
        : ["rel/main", "judge/main"],
    );
    if ((options as NonNullable<Parameters<typeof fixture>[2]>).relationGenerationSame)
      expect(owned.proposal.relation?.provenance.model).toBe(owned.proposal.retireEvidence?.generationProvenance.model);
    const x = await host(h, owned);
    const beforeSourceAudit = fs.readFileSync(h.sourceAuditPath);
    const result = await x.commit();
    expect(result.kind).toBe("committed");
    expect(x.confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(h.contextPath, "utf8")).toContain("supersededBy: rules.001");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
    expect(fs.readFileSync(h.sourceAuditPath)).toEqual(beforeSourceAudit);
    const audit = await withMemoryDirLock(h.dir, () =>
      h.freshAudit().readActionLocked(owned.frozen.batchId, owned.frozen.actionId),
    );
    expect(audit).toMatchObject({
      kind: "ok",
      audit: { state: "committed", retireEvidence: owned.proposal.retireEvidence },
    });
    expect((await restoreRevisionRaw(h.dir, { actionId: owned.frozen.actionId }, h.auditDeps)).kind).toBe("restored");
    expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
    expect(h.gen).toHaveBeenCalledTimes(genCalls);
  },
);

const badSources = [
  "prepared",
  "proposed",
  "skipped",
  "failed",
  "commit-unknown",
  "restored",
  "restore-intent",
  "restore-unknown",
  "missing-observation",
  "wrong-observation",
  "missing-spec",
  "wrong-action",
] as const;
async function damageSource(h: Awaited<ReturnType<typeof setup>>, kind: (typeof badSources)[number]) {
  if (kind === "restored") {
    expect((await restoreRevisionRaw(h.dir, { actionId: h.source.actionId }, h.auditDeps)).kind).toBe("restored");
    // Matching the old after bytes again must NEVER resurrect a restored audit.
    fs.writeFileSync(h.targetPath, h.successorAfter);
    return;
  }
  const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
  if (["prepared", "proposed", "skipped", "failed", "commit-unknown"].includes(kind)) a.state = kind;
  if (kind === "prepared") {
    delete a.expectedAfter;
    delete a.commitOrigin;
    delete a.commitObservation;
    fs.unlinkSync(join(h.sourcePath, "after.md"));
  }
  if (kind === "proposed" || kind === "failed") delete a.commitObservation;
  if (kind === "skipped") a.commitObservation = { kind: "not-applied" };
  if (kind === "commit-unknown") a.commitObservation = { kind: "unknown", reason: "historical uncertain syscall" };
  if (kind === "restore-intent" || kind === "restore-unknown")
    a.restoreAttempt = {
      state: kind === "restore-intent" ? "intent" : "effect-unknown",
      startedAt: "2026-11-10T00:00:00.000Z",
    };
  if (kind === "missing-observation") delete a.commitObservation;
  if (kind === "wrong-observation") a.commitObservation.expectedAfter.digest = "0".repeat(64);
  if (kind === "missing-spec") delete a.generationRequest;
  if (kind === "wrong-action") a.action = "rewrite-single";
  fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
}
for (const when of ["before-freeze", "before-commit"] as const) {
  it.each(badSources)(
    `source %s ${when} never automatically retires, even when successor equals after`,
    async (kind) => {
      const h = await setup();
      let owned: Awaited<ReturnType<typeof h.retire>> | undefined;
      let x: Awaited<ReturnType<typeof host>> | undefined;
      if (when === "before-commit") {
        owned = await h.retire();
        x = await host(h, owned);
      }
      await damageSource(h, kind);
      if (when === "before-freeze" && kind !== "missing-spec") {
        const calls = h.calls.length;
        await expect(h.freezeRetire()).rejects.toThrow("retire freeze unavailable");
        expect(h.calls).toHaveLength(calls);
        expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
        expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
        return;
      }
      if (!owned) {
        owned = await h.retire();
        expect(owned.proposal.autoEligible).toBe(false);
        x = await host(h, owned);
      }
      const auditBefore = fs.readFileSync(h.sourceAuditPath),
        calls = h.gen.mock.calls.length;
      const data = vi.spyOn(safeFs, "replaceRevisionObserved");
      expect((await x!.commit()).kind).toBe("skipped");
      expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
      expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
      expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
      expect(fs.readFileSync(h.sourceAuditPath)).toEqual(auditBefore);
      expect(h.gen).toHaveBeenCalledTimes(calls);
    },
  );
}

it.each(["audit", "before", "after", "symlink", "wide", "overflow"] as const)(
  "source %s evidence fault refuses without repair or generation",
  async (kind) => {
    const h = await setup();
    const owned = await h.retire(),
      x = await host(h, owned);
    if (kind === "audit") fs.unlinkSync(h.sourceAuditPath);
    if (kind === "before") fs.unlinkSync(join(h.sourcePath, "before.md"));
    if (kind === "after") fs.unlinkSync(join(h.sourcePath, "after.md"));
    if (kind === "symlink") {
      fs.renameSync(join(h.sourcePath, "after.md"), join(h.sourcePath, "held.md"));
      fs.symlinkSync(join(h.sourcePath, "held.md"), join(h.sourcePath, "after.md"));
    }
    if (kind === "wide") fs.chmodSync(h.sourcePath, 0o755);
    if (kind === "overflow") fs.writeFileSync(join(h.sourcePath, "before.md"), Buffer.alloc(10000, 65));
    const calls = h.gen.mock.calls.length,
      entries = fs.readdirSync(h.sourcePath).sort();
    const apply = vi.spyOn(safeFs, "replaceRevisionObserved");
    expect((await x.commit()).kind).toBe("skipped");
    expect(apply.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
    expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
    expect(fs.readdirSync(h.sourcePath).sort()).toEqual(entries);
    expect(h.gen).toHaveBeenCalledTimes(calls);
  },
);

it.each([
  { coverageSame: true },
  { coverageRelationSame: true },
  { coverageAliasOverlap: true },
  { coverageVerdict: "partial" as const },
  { coverageVerdict: "unknown" as const },
])("incomplete/overlapping coverage %j stays confirmed-only", async (options) => {
  const h = await setup("agent", options),
    owned = await h.retire();
  expect(owned.proposal.autoEligible).toBe(false);
  const x = await host(h, owned);
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it("review publication repeats source guard after model work; restored source cannot publish a late auto proposal", async () => {
  const h = await setup(),
    owned = await h.retire();
  await damageSource(h, "restore-intent");
  const before = fs.readFileSync(h.indexPath);
  expect(await upsertRevisionSuggestion(h.dir, { ...owned, origin: "p50-suggestion" }, h.reviewDeps)).toBe("stale");
  expect(fs.readFileSync(h.indexPath)).toEqual(before);
  expect(fs.existsSync(h.actionPath(owned.frozen))).toBe(false);
});

it("source is rechecked at the LAST data-syscall guard after expected-after barrier", async () => {
  const h = await setup(),
    owned = await h.retire(),
    x = await host(h, owned);
  const temp = safeFs.writeTempRegular;
  let reached = false;
  vi.spyOn(safeFs, "writeTempRegular").mockImplementation((...args) => {
    const result = temp(...args);
    if (args[0] === h.blocks && args[1] === "rules.002.md") {
      reached = true;
      const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
      a.restoreAttempt = { state: "intent", startedAt: "2026-11-10T00:00:00.000Z" };
      fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
    }
    return result;
  });
  const data = vi.spyOn(safeFs, "replaceRevisionObserved");
  expect((await x.commit()).kind).toBe("skipped");
  expect(reached).toBe(true);
  expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it("a real C restore intent failure blocks retire while successor still equals committed after", async () => {
  const h = await setup(),
    owned = await h.retire(),
    x = await host(h, owned);
  const temp = safeFs.writeTempRegular;
  const fault = vi.spyOn(safeFs, "writeTempRegular").mockImplementation((...args) => {
    if (args[0] === h.blocks && args[1] === "rules.001.md") throw Error("restore temp after durable intent");
    return temp(...args);
  });
  expect((await restoreRevisionRaw(h.dir, { actionId: h.source.actionId }, h.auditDeps)).kind).toBe("effect-unknown");
  fault.mockRestore();
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
  const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
  expect(a.state).toBe("committed");
  expect(a.restoreAttempt).toBeDefined();
  const data = vi.spyOn(safeFs, "replaceRevisionObserved");
  expect((await x.commit()).kind).toBe("skipped");
  expect(data.mock.calls.filter((c) => c[0] === h.blocks)).toHaveLength(0);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
});

it.each([
  "zero-cost",
  "invalid-output-cap",
  "missing-client",
  "missing-registry",
  "already-aborted",
  "after-relation",
  "after-coverage",
] as const)("retire %s admits no late action or generation outside the existing client budget", async (kind) => {
  const h = await setup(),
    frozen = await h.freezeRetire(),
    controller = new AbortController();
  const before = h.calls.length,
    generationCalls = h.gen.mock.calls.length;
  if (kind === "already-aborted") controller.abort();
  if (kind === "after-relation") {
    const ask = h.client.ask;
    vi.spyOn(h.client, "ask").mockImplementation(async (request) => {
      const r = await ask(request);
      controller.abort();
      return r;
    });
  }
  if (kind === "after-coverage") {
    const judge = h.client.judgeRevisionCoverage;
    vi.spyOn(h.client, "judgeRevisionCoverage").mockImplementation(async (request) => {
      const r = await judge(request);
      controller.abort();
      return r;
    });
  }
  const result = await prepareRevisionProposal(frozen, {
    ...(kind === "missing-client" ? {} : { client: h.client }),
    requestBudget: {
      registry: kind === "missing-registry" ? (undefined as never) : h.registry,
      mode: "sync",
      budgetMs: 3000,
      maxOutputTokens: kind === "invalid-output-cap" ? 0 : 128,
      jobCostCapUsd: kind === "zero-cost" ? 0 : 10,
    },
    attempt: {
      signal: controller.signal,
      isCurrent: () => true,
      leaseValid: () => true,
      tryStartGenerate() {
        throw Error("historical generation may not be retried");
      },
      capReached() {},
    },
    isSuppressed: (f) => revisionSuggestionSuppressed(h.dir, f, { isCurrent: () => true }),
    reason: "supersedes",
    autoEnabled: true,
  });
  expect(result.kind).toBe(kind.includes("aborted") || kind.startsWith("after-") ? "stale" : "unavailable");
  const calls = h.calls.slice(before);
  expect(calls).toEqual(
    kind === "after-relation" ? ["rel/main"] : kind === "after-coverage" ? ["rel/main", "judge/main"] : [],
  );
  expect(h.gen).toHaveBeenCalledTimes(generationCalls);
  expect(fs.existsSync(h.actionPath(frozen))).toBe(false);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it("complete real source/evidence never permits agent successor to retire a user target", async () => {
  const h = await setup("agent", {}, "user"),
    owned = await h.retire();
  expect(owned.frozen.target.block.authority).toBe("user");
  expect(owned.frozen.context!.block.authority).toBe("agent");
  expect(owned.proposal.retireEvidence).toBeDefined();
  expect(owned.proposal.coverage).toBeDefined();
  expect(owned.proposal.autoEligible).toBe(false);
  const x = await host(h, owned);
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(await x.commit("web-b3")).toMatchObject({ kind: "skipped", reason: "permission" });
  expect(x.confirm).not.toHaveBeenCalled();
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it("real unverified source identity remains truthful and confirmed-only, never backfilled from requested alias", async () => {
  const h = await setup("agent", {}, "agent", true),
    owned = await h.retire();
  expect(owned.proposal.retireEvidence?.generationProvenance).toMatchObject({
    trusted: false,
    provider: "",
    model: "",
    routeIdentity: "unknown",
  });
  expect(owned.proposal.autoEligible).toBe(false);
  const x = await host(h, owned);
  expect(await x.commit()).toMatchObject({ kind: "skipped", reason: "permission" });
  expect((await x.commit("web-b3")).kind).toBe("committed");
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it.each([0.8999, 0.9])(
  "fresh relation threshold %s is applied independently of a complete old generation",
  async (probability) => {
    const h = await setup("agent", { relationP: probability }),
      owned = await h.retire();
    expect(owned.proposal.relation?.p).toBe(probability);
    expect(owned.proposal.autoEligible).toBe(probability >= 0.9);
    const x = await host(h, owned),
      result = await x.commit();
    expect(result.kind).toBe(probability >= 0.9 ? "committed" : "skipped");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
  },
);
