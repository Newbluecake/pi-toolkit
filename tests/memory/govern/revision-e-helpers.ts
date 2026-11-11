/** E test harness: real temp files, B client + bounded offline transport,
 * C audit/file+directory barriers and D review custody. No F wiring.
 * Transport results have synthetic local protocol identities/costs, not LIVE evidence. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, vi } from "vitest";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { createRevisionAuditPort } from "../../../src/memory/govern/revision-audit.js";
import {
  freezeRevisionInputsLocked,
  prepareRevisionProposal,
  planRevisionActions,
  revisionRelationContext,
  revisionProposalDigest,
} from "../../../src/memory/govern/revision.js";
import { upsertRevisionSuggestion, revisionSuggestionSuppressed } from "../../../src/memory/govern/review-lite.js";
import {
  createJevClient,
  createRegistryRevisionTransport,
  type JevClientHandle,
} from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import {
  createRevisionCommitter,
  type OwnedRevisionAction,
  type RevisionCommitDeps,
} from "../../../src/memory/govern/revision-commit.js";
import type {
  ClassifierRegistryLike,
  ControlledClassifyTransport,
  FrozenRevisionInput,
  RegistryRevisionBinding,
  RevisionRegistryLike,
  RevisionTransportResult,
  RevisionProposal,
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

export async function fixture(
  unknown = false,
  authority: "agent" | "user" = "agent",
  options: {
    relationGenerationSame?: boolean;
    coverageSame?: boolean;
    coverageRelationSame?: boolean;
    coverageAliasOverlap?: boolean;
    failover?: boolean;
    coverageVerdict?: "complete" | "partial" | "unknown";
    relationP?: number;
  } = {},
) {
  const dir = fs.mkdtempSync(join(tmpdir(), "p50-cd-"));
  roots.push(dir);
  const blocks = join(dir, "blocks");
  fs.mkdirSync(blocks, { mode: 0o700 });
  fs.writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}', { mode: 0o600 });
  const raw = (body: string, version = 7) =>
    Buffer.from(
      `\uFEFF---\r\nkind: block\r\nauthority: ${authority}\r\nstatus: active\r\ncreated: 2026-01-01\r\nupdated: 2026-01-01\r\nversion: ${version}\r\n---\r\n\r\n${body}\r\n`,
    );
  const targetPath = join(blocks, "rules.001.md"),
    contextPath = join(blocks, "rules.002.md");
  const before = raw("Keep the budget; preserve café 规则."),
    contextBefore = raw("Keep the directory lock.");
  fs.writeFileSync(targetPath, before, { mode: 0o600 });
  fs.writeFileSync(contextPath, contextBefore, { mode: 0o600 });
  const { dev, ino } = safeFs.inspectDirNoFollow(dir);
  const state = { epoch: 1, current: true };
  const freeze = async (
    epoch = state.epoch,
    action: "rewrite-single" | "merge-survivor" = "rewrite-single",
  ): Promise<FrozenRevisionInput> => {
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
          action,
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
  const relationActual = options.relationGenerationSame ? "generation" : "relation";
  const coverageActual = options.coverageSame
    ? "generation"
    : options.coverageRelationSame
      ? relationActual
      : "coverage";
  const registry: RevisionRegistryLike & ClassifierRegistryLike = {
    complete: async (model, context, opts): Promise<RevisionTransportResult> => {
      expect(fs.existsSync(join(dir, ".lock"))).toBe(false);
      const chain = (model as { chain: string }).chain;
      const payload = opts.onPayload({ max_tokens: 999999, max_completion_tokens: 999999 });
      expect(payload).toEqual({ max_tokens: opts.maxTokens });
      expect(opts.maxRetries).toBe(0);
      expect(context.messages).toHaveLength(1);
      calls.push(chain);
      if (chain.endsWith("/fail")) throw Error("controlled real failover");
      const text =
        chain === "judge/main"
          ? JSON.stringify({ verdict: options.coverageVerdict ?? "complete" })
          : "Keep the budget and café 规则; keep the directory lock.";
      expect(Buffer.byteLength(text)).toBeLessThan(opts.maxTokens);
      return {
        provider: "offline",
        model: chain === "judge/main" ? coverageActual : "generation",
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
        model: relationActual,
        stopReason: "stop",
        answers: {
          revisionRelation: {
            type: "choice",
            choice: "conflict",
            probabilities: { conflict: options.relationP ?? 0.99, supersedes: 1 - (options.relationP ?? 0.99) },
            confidence: options.relationP ?? 0.99,
          },
        },
        usage: { input: 100, cost: { total: 0.001 } },
      };
    },
  };
  const bindings: RegistryRevisionBinding[] = (
    options.failover ? ["gen/fail", "gen/main", "judge/fail", "judge/main"] : ["gen/main", "judge/main"]
  ).map((chain) => {
    const actual = chain === "judge/main" ? coverageActual : "generation";
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
        routeAliases: [
          chain,
          `offline/${actual}`,
          ...(options.coverageAliasOverlap && chain === "judge/main" ? ["rel/main"] : []),
        ],
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
        model: relationActual,
        routeIdentity: hash(`offline/${relationActual}`),
        routeAliases: ["rel/main", `offline/${relationActual}`],
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
        models: options.failover ? ["gen/fail", "gen/main"] : ["gen/main"],
        coverageModels: options.failover ? ["judge/fail", "judge/main"] : ["judge/main"],
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
    registry,
    calls,
    freeze,
    prepare,
    readAudit,
    authority,
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;
export async function action(
  h: Harness,
  kind: RevisionProposal["action"],
  opts: {
    clear?: boolean;
    targetId?: string;
    actions?: { action: RevisionProposal["action"]; target: { id: string; rev: string } }[];
  } = {},
) {
  const id = opts.targetId ?? "rules.001";
  const parsed = (id: string) => {
    const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
    if ("stray" in b) throw new Error("fixture stray");
    return b;
  };
  const f = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory: h.frozen.directory,
        selectionBatchId: "e-selection",
        policyVersion: h.frozen.policyVersion,
        action: kind,
        target: parsed(id),
        ...(kind === "retire" ? { context: parsed("rules.002") } : {}),
        ...(opts.actions ? { actions: opts.actions } : {}),
      },
      { isCurrent: () => h.state.current },
    ),
  );
  if ("kind" in f) throw new Error(`freeze ${f.reason}`);
  const p = planRevisionActions({
    candidates: [
      {
        frozen: f,
        reason: "expired",
        ...(kind === "expires"
          ? {
              expiry: opts.clear
                ? { op: "clear" as const, dateRuleVersion: "date-v1" }
                : { op: "set" as const, nextExpires: "2027-01-01", dateRuleVersion: "date-v1" },
            }
          : {}),
      },
    ],
    autoEnabled: false,
    leaseValid: true,
  })[0];
  if (!p) throw new Error("no proposal");
  return { frozen: f, proposal: p };
}
export async function host(
  h: Harness,
  owned: OwnedRevisionAction = {
    frozen: h.frozen,
    proposal: h.proposal,
    generationMaxOutputTokens: 2048,
    coverageMaxOutputTokens: 2048,
  },
) {
  expect(await upsertRevisionSuggestion(h.dir, { ...owned, origin: "p50-suggestion" }, h.reviewDeps)).toBe("saved");
  const state = {
    lease: true,
    enabled: true,
    autoEnabled: true,
    dateRuleVersion: "date-v1",
    policyVersion: owned.proposal.policyVersion,
    epoch: owned.frozen.directory.sessionEpoch,
    confirmed: true,
    plainMain: true,
  };
  let consumed = false;
  const confirm = vi.fn(
    (request: { actionId: string; expectedRev: string; proposalDigest: string }, proposal: RevisionProposal) => {
      expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
      expect(request.actionId).toBe(owned.proposal.actionId);
      expect(request.expectedRev).toBe(owned.proposal.expectedRev);
      expect(request.proposalDigest).toBe(proposal.proposalDigest);
      if (!state.confirmed || consumed) return false;
      consumed = true;
      return true;
    },
  );
  const deps: RevisionCommitDeps = {
    actionLocked: (id) => {
      expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
      return id === owned.proposal.actionId ? owned : undefined;
    },
    runtime: () => ({
      plainMain: state.plainMain,
      enabled: state.enabled,
      autoEnabled: state.autoEnabled,
      sessionEpoch: state.epoch,
      policyVersion: state.policyVersion,
      dateRuleVersion: state.dateRuleVersion,
    }),
    isCurrent: () => h.state.current,
    leaseValid: () => state.lease,
    now: () => now,
    consumeConfirmedLocked: confirm,
  };
  const request = (origin: "p50-auto" | "web-b3" = "p50-auto") => ({
    origin,
    actionId: owned.proposal.actionId,
    expectedRev: owned.proposal.expectedRev,
    proposalDigest: owned.proposal.proposalDigest,
  });
  const commit = (origin: "p50-auto" | "web-b3" = "p50-auto") =>
    createRevisionCommitter(h.dir, deps).commitAction(request(origin));
  return { state, deps, request, commit, confirm, owned };
}
