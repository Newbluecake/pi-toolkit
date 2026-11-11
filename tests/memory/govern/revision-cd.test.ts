/** Serial C/D integration: real temp files, B client + bounded offline transport,
 * C audit/file+directory barriers and review index. No E data commit or F wiring.
 * Transport results have synthetic local protocol identities/costs, not LIVE evidence. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import {
  freezeRevisionInputsLocked,
  prepareRevisionProposal,
  planRevisionActions,
  revisionFrozenRelationDigest,
  revisionRelationContext,
} from "../../../src/memory/govern/revision.js";
import { upsertRevisionSuggestion, revisionSuggestionSuppressed } from "../../../src/memory/govern/review-lite.js";
import {
  createJevClient,
  createRegistryRevisionTransport,
  independentCoverageSources,
  type JevClientHandle,
} from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { createJevCommandPort } from "../../../src/memory/jev/command-port.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import type {
  ClassifierRegistryLike,
  ControlledClassifyTransport,
  FrozenRevisionInput,
  RegistryRevisionBinding,
  RevisionRegistryLike,
  RevisionTransportResult,
} from "../../../src/memory/jev/contracts.js";

const now = new Date("2026-11-10T00:00:00.000Z");
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const roots: string[] = [];
const clients: JevClientHandle[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
  clearHealthTable();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(unknown = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), "p50-cd-"));
  roots.push(dir);
  const blocks = join(dir, "blocks");
  fs.mkdirSync(blocks, { mode: 0o700 });
  fs.writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}', { mode: 0o600 });
  const raw = (body: string, version = 7) =>
    Buffer.from(
      `\uFEFF---\r\nkind: block\r\nauthority: agent\r\nstatus: active\r\ncreated: 2026-01-01\r\nupdated: 2026-01-01\r\nversion: ${version}\r\n---\r\n\r\n${body}\r\n`,
    );
  const targetPath = join(blocks, "rules.001.md"),
    contextPath = join(blocks, "rules.002.md");
  const before = raw("Keep the budget; preserve café 规则."),
    contextBefore = raw("Keep the directory lock.");
  fs.writeFileSync(targetPath, before, { mode: 0o600 });
  fs.writeFileSync(contextPath, contextBefore, { mode: 0o600 });
  const { dev, ino } = safeFs.inspectDirNoFollow(dir);
  const state = { epoch: 1, current: true };
  const freeze = async (epoch = state.epoch): Promise<FrozenRevisionInput> => {
    const parsed = (path: string, id: string) => {
      const b = parseBlockFile(`${id}.md`, fs.readFileSync(path, "utf8"));
      if ("stray" in b) throw new Error("invalid test block");
      return b;
    };
    const value = await withMemoryDirLock(dir, () =>
      freezeRevisionInputsLocked(
        dir,
        {
          directory: { realpath: dir, dev, ino, sessionEpoch: epoch },
          selectionBatchId: `selection-${epoch}`,
          policyVersion: "cd-policy-v1",
          action: "rewrite-single",
          target: parsed(targetPath, "rules.001"),
          context: parsed(contextPath, "rules.002"),
        },
        { isCurrent: () => state.current && state.epoch === epoch },
      ),
    );
    if ("kind" in value) throw new Error(`freeze refused: ${value.reason}`);
    return value;
  };
  const frozen = await freeze();
  const isCurrent = () => state.current && state.epoch === frozen.directory.sessionEpoch;
  const auditDeps = { isCurrent, now: () => now };
  const audit = createRevisionAuditPort(dir, auditDeps);
  const reviewDeps = { audit, isCurrent, leaseValid: () => true, now: () => now };
  const indexPath = join(blocks, ".jev/index.json");
  const actionPath = (f = frozen) => join(blocks, ".jev/revisions", f.batchId, f.actionId);
  const calls: string[] = [];
  const registry: RevisionRegistryLike & ClassifierRegistryLike = {
    complete: async (model, context, opts): Promise<RevisionTransportResult> => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(false);
      const chain = (model as { chain: string }).chain;
      const payload = opts.onPayload({ max_tokens: 999999, max_completion_tokens: 999999 });
      expect(payload).toEqual({ max_tokens: opts.maxTokens });
      expect(opts.maxRetries).toBe(0);
      expect(context.messages).toHaveLength(1);
      calls.push(chain);
      const text =
        chain === "judge/main" ? '{"verdict":"complete"}' : "Keep the budget and café 规则; keep the directory lock.";
      expect(Buffer.byteLength(text)).toBeLessThan(opts.maxTokens);
      return {
        provider: "offline",
        model: chain === "judge/main" ? "coverage" : "generation",
        stopReason: "stop",
        content: [{ type: "text", text }],
        usage: { cost: { total: 0.001 } },
      };
    },
    getAvailableOfType: async () => [{ provider: "rel", id: "main" }],
    getModelOfType: () => ({}),
    classify: async () => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(false);
      calls.push("rel/main");
      return {
        provider: "offline",
        model: "relation",
        stopReason: "stop",
        answers: {
          revisionRelation: {
            type: "choice",
            choice: "conflict",
            probabilities: { conflict: 0.99, supersedes: 0.01 },
            confidence: 0.99,
          },
        },
        usage: { input: 100, cost: { total: 0.001 } },
      };
    },
  };
  const bindings: RegistryRevisionBinding[] = ["gen/main", "judge/main"].map((chain) => {
    const actual = chain === "judge/main" ? "coverage" : "generation";
    return {
      registry,
      requestChainId: chain,
      model: { chain },
      adapterId: "cd-byte-token",
      chainVersion: "offline-v1",
      maxTokensEnforced: true,
      outputLimitField: "max_tokens",
      maxOutputTokens: 2048,
      // Unknown deliberately has NO actual identity evidence. B must not fill
      // it from the requested result.model or the otherwise valid local route.
      resultEvidence: (r) => ({
        ...(unknown ? {} : { actual: { provider: r.provider, model: r.model } }),
        costUsd: 0.001,
      }),
      quoteInput: (c) => ({
        maxInputTokens: Buffer.byteLength(JSON.stringify(c)) + 32,
        priceUsdPerMillion: { input: 1, output: 1 },
      }),
      resolveRoute: () => ({
        provider: "offline",
        model: actual,
        routeIdentity: hash(`offline/${actual}`),
        routeAliases: [chain, `offline/${actual}`],
      }),
    };
  });
  const transport: ControlledClassifyTransport = {
    prepare: (input) => ({
      adapterId: "cd-relation",
      chainVersion: "offline-v1",
      bounds: { maxInputTokens: 4096, maxOutputTokens: 128, priceUsdPerMillion: { input: 1, output: 1 } },
      dispatch: (opts) => registry.classify!(input.model, input.context, opts),
      resolveRoute: () => ({
        provider: "offline",
        model: "relation",
        routeIdentity: hash("offline/relation"),
        routeAliases: ["rel/main", "offline/relation"],
      }),
    }),
  };
  const client = createJevClient({
    config: {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      proxy: "",
      classifiers: ["rel/main"],
      maxCostUsd: 20,
      maxCalls: 100,
    },
    isChild: false,
    now: Date.now,
    p50: {
      enabled: true,
      transport,
      revision: {
        transport: createRegistryRevisionTransport(bindings),
        models: ["gen/main"],
        coverageModels: ["judge/main"],
      },
    },
  });
  clients.push(client);
  const prepare = async (input = frozen) => {
    let generations = 0;
    const outcome = await client.ask({
      ...revisionRelationContext(input),
      registry,
      jobId: input.batchId,
      mode: "sync",
      duty: "review",
      budgetMs: 3000,
      jobCostCapUsd: 10,
    });
    expect(outcome.ok).toBe(true);
    const result = await prepareRevisionProposal(input, {
      client,
      requestBudget: { registry, mode: "sync", budgetMs: 3000, maxOutputTokens: 2048, jobCostCapUsd: 10 },
      attempt: {
        signal: new AbortController().signal,
        isCurrent: () => state.current && state.epoch === input.directory.sessionEpoch,
        leaseValid: () => true,
        tryStartGenerate: () => ++generations <= 2,
        capReached() {
          throw new Error("unexpected cap");
        },
      },
      isSuppressed: (f) => revisionSuggestionSuppressed(dir, f, { isCurrent: () => state.current }),
      relation: { kind: "conflict", p: 0.99, outcome },
      reason: "conflict",
      autoEnabled: true,
    });
    return result;
  };
  const prepared = await prepare();
  expect(prepared.kind).toBe("ok");
  if (prepared.kind !== "ok") throw new Error("B/D preparation failed");
  const proposal = prepared.proposal;
  const input = { frozen, proposal, origin: "p50-suggestion" as const };
  const readAudit = (port = createRevisionAuditPort(dir, auditDeps)) =>
    withMemoryDirLock(dir, () => port.readActionLocked(frozen.batchId, frozen.actionId));
  const commandPort = () =>
    createJevCommandPort({
      client,
      entryIndex: new EntryIndex(),
      dirFor: () => dir,
      now: () => now.getTime(),
      isChildSession: false,
      triggerBulk() {},
    });
  return {
    dir,
    blocks,
    before,
    contextBefore,
    raw,
    targetPath,
    contextPath,
    frozen,
    proposal,
    input,
    state,
    audit,
    auditDeps,
    reviewDeps,
    indexPath,
    actionPath,
    client,
    calls,
    freeze,
    prepare,
    readAudit,
    commandPort,
  };
}

it.each([false, true])("real B→D→C→index/restart/dismiss preserves evidence (unknown=%s)", async (unknown) => {
  const h = await fixture(unknown);
  expect(h.calls).toEqual(["rel/main", "gen/main", "judge/main"]);
  expect(h.proposal.autoEligible).toBe(!unknown);
  expect(h.proposal.generationInputComplete).toBe(true);
  expect(h.proposal.outputDigest).toBe(hash(h.proposal.generatedBody!));
  if (unknown) {
    expect(h.proposal.generationProvenance).toEqual(
      expect.objectContaining({
        trusted: false,
        provider: "",
        model: "",
        routeIdentity: "unknown",
        routeAliases: [],
        requestedProvider: "offline",
        requestedModel: "generation",
      }),
    );
    expect(h.proposal.generationProvenance).not.toHaveProperty("canonicalProvider");
    expect(h.proposal.generationProvenance).not.toHaveProperty("canonicalModel");
    expect(h.proposal.coverage).toBeUndefined();
  } else {
    const p = h.proposal;
    expect(p.relation!.provenance.trusted).toBe(true);
    expect(p.generationProvenance!.trusted).toBe(true);
    expect(p.coverage!.provenance.trusted).toBe(true);
    expect(
      independentCoverageSources(p.relation!.provenance, p.generationProvenance!, p.coverage!.provenance, {
        relation: p.evidenceBindings.relation!,
        generation: p.evidenceBindings.generation!,
        coverage: p.evidenceBindings.coverage!,
      }),
    ).toBe(true);
  }
  expect(fs.existsSync(h.indexPath)).toBe(false);
  expect(fs.existsSync(h.actionPath())).toBe(false);
  const trace: string[] = [];
  const sync = safeFs.fsyncDir,
    replace = safeFs.replaceAtomic;
  vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
    sync(dir);
    trace.push(`sync:${dir}`);
  });
  vi.spyOn(safeFs, "replaceAtomic").mockImplementation((dir, tmp, name) => {
    if (name === "index.json") {
      expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
      expect(trace).toContain(`sync:${h.actionPath()}`);
      expect(trace).toContain(`sync:${h.dir}`);
      const disk = JSON.parse(fs.readFileSync(join(h.actionPath(), "audit.json"), "utf8"));
      expect(disk.state).toBe("prepared");
      expect(disk.proposalDigest).toBe(h.proposal.proposalDigest);
      trace.push("index-rename");
    }
    replace(dir, tmp, name);
  });
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("saved");
  expect(trace.at(-1)).toBe("index-rename");
  const r = await h.readAudit(); // NEW C factory, real disk read, same actual lock
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") throw new Error("restart audit unavailable");
  expect(r.before).toEqual(h.before);
  expect(fs.readFileSync(join(h.actionPath(), "before.md"))).toEqual(h.before);
  expect(r.audit).toMatchObject({
    state: "prepared",
    beforeDigest: hash(h.before),
    expectedRev: h.frozen.target.rev,
    inputDigest: revisionFrozenRelationDigest(h.frozen),
    contextRawDigest: hash(h.contextBefore),
    generationProvenance: h.proposal.generationProvenance,
    generationInputComplete: true,
    outputDigest: h.proposal.outputDigest,
    evidenceBindings: h.proposal.evidenceBindings,
    relation: h.proposal.relation,
    proposalDigest: h.proposal.proposalDigest,
  });
  if (!unknown) expect(r.audit.coverage).toEqual(h.proposal.coverage);
  expect(r.expectedAfter).toBeUndefined();
  expect(fs.existsSync(join(h.actionPath(), "after.md"))).toBe(false);
  expect(readIndex(h.dir).index.review!.suggestions[0]!.revision).toEqual(h.proposal);
  expect(JSON.parse(fs.readFileSync(h.indexPath, "utf8")).review.suggestions[0].revision).toEqual(h.proposal);
  expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0, reservedCostUsd: 0 });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
  const auditBytes = fs.readFileSync(join(h.actionPath(), "audit.json"));
  const id = readIndex(h.dir).index.review!.suggestions[0]!.id;
  await h.commandPort().review.dismiss("cwd", id);
  expect(readIndex(h.dir).index.review!.suggestions).toEqual([]);
  expect(readIndex(h.dir).index.review!.dismissed[0]!.suggestionKey).toBe(
    JSON.stringify(["revision", "rewrite-single", "rules.001", "rules.002"]),
  );
  // A new factory + new rev/body/batch/epoch cannot resurrect a dismissed action.
  h.state.epoch = 2;
  fs.writeFileSync(h.targetPath, h.raw("New rule; preserve café 规则.", 8));
  const next = await h.freeze();
  expect(next.batchId).not.toBe(h.frozen.batchId);
  expect(next.target.rev).not.toBe(h.frozen.target.rev);
  const freshDeps = {
    ...h.reviewDeps,
    audit: createRevisionAuditPort(h.dir, { isCurrent: () => true, now: () => now }),
    isCurrent: () => true,
  };
  expect(await revisionSuggestionSuppressed(h.dir, next, freshDeps)).toBe("dismissed");
  const calls = h.calls.length;
  expect(await h.prepare(next)).toEqual({ kind: "dismissed" });
  expect(h.calls.length).toBe(calls + 1); // only explicit relation ask, no generate/coverage
  const lateProposal = planRevisionActions({
    candidates: [{ frozen: next, reason: "conflict" }],
    autoEnabled: false,
    leaseValid: true,
  })[0]!;
  expect(
    await upsertRevisionSuggestion(
      h.dir,
      { frozen: next, proposal: lateProposal, origin: "p50-suggestion" },
      freshDeps,
    ),
  ).toBe("dismissed");
  expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("stale");
  expect(fs.readFileSync(h.targetPath)).toEqual(h.raw("New rule; preserve café 规则.", 8));
  expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
  expect(readIndex(h.dir).index.review!.suggestions).toEqual([]);
  expect(fs.existsSync(h.actionPath(next))).toBe(false);
  expect(fs.readFileSync(join(h.actionPath(), "audit.json"))).toEqual(auditBytes);
});

it.each(["epoch-before-prepare", "epoch-before-review", "rev-before-review", "epoch-during-barrier"])(
  "%s rejects publication without body mutation",
  async (fault) => {
    const h = await fixture();
    const indexReplace = vi.spyOn(safeFs, "replaceAtomic");
    if (fault === "epoch-before-prepare") {
      h.state.epoch++;
      expect(await h.prepare()).toEqual({ kind: "stale" });
    } else {
      if (fault === "epoch-before-review") h.state.epoch++;
      if (fault === "rev-before-review") fs.writeFileSync(h.targetPath, h.raw("Keep a user edit.", 8));
      if (fault === "epoch-during-barrier") {
        const actual = safeFs.fsyncDir;
        vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
          actual(dir);
          if (dir === h.dir && fs.existsSync(join(h.actionPath(), "audit.json"))) h.state.epoch++;
        });
      }
      expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe(
        fault === "epoch-during-barrier" ? "unavailable" : "stale",
      );
    }
    expect(fs.existsSync(h.indexPath)).toBe(false);
    expect(indexReplace.mock.calls.filter(([, , name]) => name === "index.json")).toEqual([]);
    expect(fs.readFileSync(h.targetPath)).toEqual(
      fault === "rev-before-review" ? h.raw("Keep a user edit.", 8) : h.before,
    );
    expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
    if (fault !== "epoch-during-barrier") expect(fs.existsSync(h.actionPath())).toBe(false);
  },
);

it.each(["before-file", "audit-rename", "directory-fsync", "replay-fsync"])(
  "real prepared %s failure publishes zero index; preserves exact raw evidence",
  async (fault) => {
    const h = await fixture(true);
    if (fault === "replay-fsync") {
      expect((await withMemoryDirLock(h.dir, () => h.audit.persistPreparedBarrierLocked(h.input))).kind).toBe("ok");
    }
    const write = safeFs.writeTempRegular,
      replace = safeFs.replaceRevisionObserved,
      sync = safeFs.fsyncDir;
    vi.spyOn(safeFs, "writeTempRegular").mockImplementation((...args) => {
      if (fault === "before-file" && args[1] === "before.md") throw new Error("injected file barrier failure");
      return write(...args);
    });
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      if (fault === "audit-rename" && args[2] === "audit.json") throw new Error("injected audit rename failure");
      return replace(...args);
    });
    vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
      if (fault === "directory-fsync" && dir === h.actionPath()) throw new Error("injected directory barrier failure");
      sync(dir);
    });
    if (fault === "replay-fsync")
      vi.spyOn(safeFs, "fsyncRevisionFile").mockImplementation(() => {
        throw new Error("injected replay fsync failure");
      });
    const indexReplace = vi.spyOn(safeFs, "replaceAtomic");
    const restart = createRevisionAuditPort(h.dir, h.auditDeps);
    expect(await upsertRevisionSuggestion(h.dir, h.input, { ...h.reviewDeps, audit: restart })).toBe("unavailable");
    expect(fs.existsSync(h.indexPath)).toBe(false);
    expect(indexReplace.mock.calls.filter(([, , name]) => name === "index.json")).toEqual([]);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
    expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
    if (fault !== "before-file") expect(fs.readFileSync(join(h.actionPath(), "before.md"))).toEqual(h.before);
    expect(fs.existsSync(join(h.actionPath(), "after.md"))).toBe(false);
  },
);

it.each(["empty-provider", "empty-model", "unknown-route", "malformed-route", "extra-field"])(
  "C restart rejects malformed trusted provenance: %s",
  async (fault) => {
    const h = await fixture();
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("saved");
    const path = join(h.actionPath(), "audit.json");
    const disk = JSON.parse(fs.readFileSync(path, "utf8"));
    const p = disk.generationProvenance;
    if (fault === "empty-provider") p.provider = "";
    if (fault === "empty-model") p.model = "";
    if (fault === "unknown-route") p.routeIdentity = "unknown";
    if (fault === "malformed-route") p.routeIdentity = "not-a-digest";
    if (fault === "extra-field") p.inventedIdentity = "fake";
    expect(p.trusted).toBe(true);
    fs.writeFileSync(path, JSON.stringify(disk));
    expect((await h.readAudit()).kind).toBe("corrupted");
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);

it.each(["trusted-flip", "missing-provenance", "missing-request-digest", "unknown-field"])(
  "C preserves but never promotes or strips unknown evidence: %s",
  async (fault) => {
    const h = await fixture(true);
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("saved");
    const path = join(h.actionPath(), "audit.json");
    const disk = JSON.parse(fs.readFileSync(path, "utf8"));
    if (fault === "trusted-flip") disk.generationProvenance.trusted = true;
    if (fault === "missing-provenance") delete disk.generationProvenance;
    if (fault === "missing-request-digest") delete disk.generationProvenance.requestDigest;
    if (fault === "unknown-field") disk.generationProvenance.assumedModel = "generation";
    fs.writeFileSync(path, JSON.stringify(disk));
    expect((await h.readAudit()).kind).toBe("corrupted");
    expect(readIndex(h.dir).index.review!.suggestions[0]!.revision).toEqual(h.proposal);
    expect(h.proposal.autoEligible).toBe(false);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);
