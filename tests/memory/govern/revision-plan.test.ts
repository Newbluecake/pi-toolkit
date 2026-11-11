import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockLocked } from "../../../src/memory/blocks/store.js";
import { computeRev, parseBlockFile, serializeBlock } from "../../../src/memory/blocks/format.js";
import { inspectDirNoFollow } from "../../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import {
  freezeRevisionInputsLocked,
  planRevisionActions,
  prepareRevisionProposal,
  revisionCanonicalJson,
  revisionFrozenRelationDigest,
  revisionInputIsLiveLocked,
  revisionProposalDigest,
  revisionRelationContext,
  validateRevisionProposal,
  type RevisionFreezeSpec,
  type RevisionPrepareDeps,
} from "../../../src/memory/govern/revision.js";
import {
  createJevClient,
  createRegistryRevisionTransport,
  independentCoverageSources,
} from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import type {
  ClassifierRegistryLike,
  ControlledClassifyTransport,
  FrozenRevisionInput,
  JevOutcome,
  RegistryRevisionBinding,
  RevisionProposal,
  RevisionRegistryLike,
  RevisionTransportResult,
} from "../../../src/memory/jev/contracts.js";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutablePrepareDeps = Omit<Mutable<RevisionPrepareDeps>, "attempt"> & {
  attempt: Mutable<RevisionPrepareDeps["attempt"]>;
};
const roots: string[] = [];
const now = new Date("2026-11-10T00:00:00Z");
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearHealthTable();
});
async function fixture(over: Partial<RevisionFreezeSpec> = {}, body = "Keep every valid rule.") {
  const dir = mkdtempSync(join(tmpdir(), "p50-d-plan-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  const a = createBlockLocked(join(dir, "blocks"), "rules", { authority: "agent" }, body, now);
  const b = createBlockLocked(join(dir, "blocks"), "rules", { authority: "agent" }, "Keep important context.", now);
  const { dev, ino } = inspectDirNoFollow(dir);
  const state = { current: true };
  const spec: Mutable<RevisionFreezeSpec> = {
    directory: { realpath: dir, dev, ino, sessionEpoch: 1 },
    selectionBatchId: "selection",
    policyVersion: "p50-test-v1",
    action: "rewrite-single",
    target: a,
    context: b,
    ...over,
  };
  const freeze = () =>
    withMemoryDirLock(dir, () => freezeRevisionInputsLocked(dir, spec, { isCurrent: () => state.current }));
  const value = await freeze();
  if ("kind" in value) throw new Error(`fixture freeze failed: ${value.reason}`);
  return { dir, a, b, spec, input: value, state, freeze };
}
/** Real A+B client and registry adapter; only a local byte-token serializer is
 * supplied. Synthetic identity/cost belong to this protocol, not SDK defaults. */
function harness(
  options: {
    sameModel?: boolean;
    sameAlias?: boolean;
    partial?: boolean;
    failover?: boolean;
    untrusted?: boolean;
    text?: string;
    respond?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const modelOf = (chain: string) =>
    chain.startsWith("judge/") ? (options.sameModel ? "generator" : "judge") : "generator";
  const route = (chain: string) => ({
    provider: "local",
    model: modelOf(chain),
    routeIdentity: hash(`local/${modelOf(chain)}`),
    routeAliases: [chain, `local/${modelOf(chain)}`, ...(options.sameAlias ? ["shared/alias"] : [])],
  });
  const registry: RevisionRegistryLike & ClassifierRegistryLike = {
    complete: async (model, context, opts): Promise<RevisionTransportResult> => {
      const chain = (model as { chain: string }).chain;
      const payload = opts.onPayload({ max_tokens: 999999, max_completion_tokens: 999999 }) as Record<string, unknown>;
      expect(payload).toEqual({ max_tokens: opts.maxTokens });
      expect(opts.maxRetries).toBe(0);
      calls.push(chain);
      await options.respond?.();
      if (chain === "gen/fail") throw new Error("local first route failed");
      const text = chain.startsWith("judge/")
        ? JSON.stringify({ verdict: options.partial ? "partial" : "complete" })
        : (options.text ?? "Keep every valid rule and important context.");
      expect(Buffer.byteLength(text)).toBeLessThan(opts.maxTokens);
      expect(context.messages).toHaveLength(1);
      return {
        provider: "local",
        model: modelOf(chain),
        stopReason: "stop",
        content: [{ type: "text", text }],
        usage: { cost: { total: 0.001 } },
      };
    },
    getAvailableOfType: async () => [{ provider: "rel", id: "main" }],
    getModelOfType: () => ({}),
    classify: async () => ({
      provider: "local",
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
    }),
  };
  const models = options.failover ? ["gen/fail", "gen/main"] : ["gen/main"];
  const bindings: RegistryRevisionBinding[] = [...models, "judge/main"].map((chain) => ({
    registry,
    requestChainId: chain,
    model: { chain },
    adapterId: "local-byte-token",
    chainVersion: "local-v1",
    maxTokensEnforced: true,
    outputLimitField: "max_tokens",
    maxOutputTokens: 2048,
    resultEvidence: (r) => ({
      ...(options.untrusted ? {} : { actual: { provider: r.provider, model: r.model } }),
      costUsd: 0.001,
    }),
    quoteInput: (c) => ({
      maxInputTokens: Buffer.byteLength(JSON.stringify(c)) + 32,
      priceUsdPerMillion: { input: 1, output: 1 },
    }),
    resolveRoute: () => route(chain),
  }));
  const transport: ControlledClassifyTransport = {
    prepare: (input) => ({
      adapterId: "local-relation",
      chainVersion: "local-v1",
      bounds: { maxInputTokens: 4096, maxOutputTokens: 128, priceUsdPerMillion: { input: 1, output: 1 } },
      dispatch: (opts) => registry.classify!(input.model, input.context, opts),
      resolveRoute: () => ({
        provider: "local",
        model: "relation",
        routeIdentity: hash("local/relation"),
        routeAliases: ["rel/main", "local/relation"],
      }),
    }),
  };
  const client = createJevClient({
    config: {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      proxy: "",
      classifiers: ["rel/main"],
      maxCostUsd: 20,
      maxCalls: 1000,
    },
    isChild: false,
    now: Date.now,
    p50: {
      enabled: true,
      transport,
      revision: { transport: createRegistryRevisionTransport(bindings), models, coverageModels: ["judge/main"] },
    },
  });
  async function deps(input: FrozenRevisionInput): Promise<MutablePrepareDeps> {
    const context = revisionRelationContext(input);
    const outcome = await client.ask({
      ...context,
      registry,
      jobId: input.batchId,
      mode: "sync",
      duty: "review",
      budgetMs: 3000,
      jobCostCapUsd: 10,
    });
    expect(outcome.ok).toBe(true);
    return {
      client,
      requestBudget: { registry, mode: "sync", budgetMs: 3000, maxOutputTokens: 2048, jobCostCapUsd: 10 },
      attempt: {
        signal: new AbortController().signal,
        isCurrent: () => true,
        leaseValid: () => true,
        tryStartGenerate: () => true,
        capReached() {},
      },
      isSuppressed: async () => false,
      relation: { kind: "conflict", p: 0.99, outcome },
      reason: "conflict",
      autoEnabled: true,
    };
  }
  return { client, calls, deps };
}
function proposal(f: FrozenRevisionInput, patch: Record<string, unknown> = {}) {
  const p = planRevisionActions({
    candidates: [
      {
        frozen: f,
        reason: "conflict",
        ...(f.action === "expires" ? { expiry: { op: "clear" as const, dateRuleVersion: "v1" } } : {}),
      },
    ],
    autoEnabled: false,
    leaseValid: true,
  })[0]!;
  const { proposalDigest: _old, ...payload } = { ...p, ...patch };
  return { ...payload, proposalDigest: revisionProposalDigest(payload as RevisionProposal) };
}

describe("D real locked raw freeze", () => {
  it("keeps private copies and deeply frozen allowlist, binds raw + epoch + sorted action set", async () => {
    const h = await fixture();
    const bytes = h.input.target.rawBefore,
      before = Buffer.from(bytes);
    bytes.fill(0);
    expect(h.input.target.rawBefore.equals(before)).toBe(true);
    expect(h.input.target.rawDigest).toBe(hash(before));
    expect(Object.isFrozen(h.input)).toBe(true);
    expect(Object.isFrozen(h.input.target.block.parseErrors)).toBe(true);
    expect(Object.keys(h.input.target.block).sort()).toEqual(
      ["id", "rev", "authority", "topic", "body", "private", "secret", "parseErrors", "status"].sort(),
    );
    const next = await h.freeze();
    expect(next).toEqual(h.input);
    const other = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        { ...h.spec, directory: { ...h.spec.directory, sessionEpoch: 2 } },
        { isCurrent: () => true },
      ),
    );
    expect("kind" in other).toBe(false);
    if ("kind" in other) throw new Error("refused");
    expect(other.batchId).not.toBe(h.input.batchId);
    expect(other.directoryIdentityDigest).toBe(h.input.directoryIdentityDigest);
    const set = [h.spec, { action: "delete" as const, target: h.b }];
    const batch = (actions: typeof set) =>
      withMemoryDirLock(h.dir, () =>
        freezeRevisionInputsLocked(h.dir, { ...h.spec, actions }, { isCurrent: () => true }),
      );
    const one = await batch(set),
      two = await batch([...set].reverse());
    expect(one).toEqual(two);
    expect(one).not.toEqual(h.input);
  });
  it("preserves BOM/CRLF/nonASCII bytes without serialize normalization", async () => {
    const h = await fixture();
    const raw = Buffer.from(
      "\uFEFF" +
        readFileSync(join(h.dir, "blocks", `${h.a.id}.md`), "utf8")
          .replace(/\n/g, "\r\n")
          .replace("Keep every valid rule.", "保留全部规则。"),
    );
    writeFileSync(join(h.dir, "blocks", `${h.a.id}.md`), raw);
    const rev = computeRev(h.a.meta.version, raw.toString());
    const value = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(h.dir, { ...h.spec, target: { id: h.a.id, rev } }, { isCurrent: () => true }),
    );
    expect("kind" in value).toBe(false);
    if ("kind" in value) throw new Error("refused");
    expect(value.target.rawBefore.equals(raw)).toBe(true);
    expect(value.target.block.body).toBe("保留全部规则。");
  });
  it.each([
    "rev",
    "raw",
    "authority",
    "status",
    "private",
    "hub",
    "residue",
    "origin",
    "secret",
    "malformed",
    "unknown",
    "utf8",
    "oversize",
    "missing-authority",
    "duplicate-field",
    "symlink",
  ])("refuses changed/unsafe %s before outbound", async (change) => {
    const h = await fixture();
    const path = join(h.dir, "blocks", `${h.a.id}.md`);
    let raw = readFileSync(path, "utf8");
    const patches: Record<string, string> = {
      authority: "authority: user",
      status: "status: archived",
      private: "private: true",
      hub: "storageScope: hub",
      residue: "residue: true",
      origin: "origin: core.md#L1-L2",
      unknown: "future: value",
    };
    if (change in patches) raw = raw.replace("kind: block", `kind: block\n${patches[change]}`);
    if (change === "raw") raw += "\n";
    if (change === "rev") h.spec.target = { id: h.a.id, rev: "99-abcdef" };
    if (change === "secret") raw = raw.replace("Keep every valid rule.", "secret: synthetic-fixture-value123456");
    if (change === "malformed") raw = "not a block";
    if (change === "missing-authority") raw = raw.replace("authority: agent\n", "");
    if (change === "duplicate-field") raw = raw.replace("kind: block", "kind: block\nprivate: false\nprivate: true");
    if (change === "oversize") raw += "a".repeat(4000);
    writeFileSync(path, change === "utf8" ? Buffer.concat([Buffer.from(raw), Buffer.from([0xff])]) : Buffer.from(raw));
    if (change === "symlink") {
      renameSync(path, `${path}.old`);
      symlinkSync(`${path}.old`, path);
    }
    // A selected fresh rev still cannot admit unsafe content.
    if (!["rev", "raw", "symlink"].includes(change)) {
      const p = parseBlockFile(`${h.a.id}.md`, readFileSync(path, "utf8"));
      if (!("stray" in p)) h.spec.target = { id: h.a.id, rev: p.rev };
    }
    expect(await h.freeze()).toMatchObject({ kind: "refused" });
  });
  it("rechecks context, directory inode, gate and epoch without changing old buffers", async () => {
    const h = await fixture();
    const old = h.input.context!.rawBefore;
    writeFileSync(join(h.dir, "blocks", `${h.b.id}.md`), "changed");
    expect(await withMemoryDirLock(h.dir, () => revisionInputIsLiveLocked(h.input))).toBe(false);
    expect(h.input.context!.rawBefore.equals(old)).toBe(true);
    const h2 = await fixture();
    renameSync(join(h2.dir, "blocks"), join(h2.dir, "old"));
    mkdirSync(join(h2.dir, "blocks"));
    for (const name of [".layout.json", `${h2.a.id}.md`, `${h2.b.id}.md`])
      writeFileSync(join(h2.dir, "blocks", name), readFileSync(join(h2.dir, "old", name)));
    expect(await withMemoryDirLock(h2.dir, () => revisionInputIsLiveLocked(h2.input))).toBe(false);
    const h3 = await fixture();
    h3.state.current = false;
    expect(await withMemoryDirLock(h3.dir, () => revisionInputIsLiveLocked(h3.input))).toBe(false);
    expect(await h3.freeze()).toMatchObject({ kind: "refused", reason: "stale" });
  });
});

describe("closed proposal codec and deterministic planning", () => {
  it.each(["rewrite-single", "merge-survivor", "retire", "delete", "expires"] as const)(
    "round trips the complete %s union",
    async (action) => {
      const h = await fixture({ action });
      const p = planRevisionActions({
        candidates: [
          {
            frozen: h.input,
            reason: "expired",
            ...(action === "expires"
              ? { expiry: { op: "set" as const, nextExpires: "2027-01-02", dateRuleVersion: "date-v1" } }
              : {}),
          },
        ],
        autoEnabled: false,
        leaseValid: true,
      })[0]!;
      expect(p.action).toBe(action);
      expect(validateRevisionProposal(JSON.parse(JSON.stringify(p)))).toEqual(p);
      expect(p.proposalDigest).toBe(revisionProposalDigest(p));
    },
  );
  it("expires op/date/rule-version each affect digest; no date is invented", async () => {
    const h = await fixture({ action: "expires" });
    expect(
      planRevisionActions({
        candidates: [{ frozen: h.input, reason: "expired" }],
        autoEnabled: true,
        leaseValid: true,
      }),
    ).toEqual([]);
    const build = (expiry: unknown) => proposal(h.input, { expiry });
    const values = [
      { op: "set", nextExpires: "2026-12-31", dateRuleVersion: "v1" },
      { op: "set", nextExpires: "2027-01-01", dateRuleVersion: "v1" },
      { op: "clear", dateRuleVersion: "v1" },
      { op: "clear", dateRuleVersion: "v2" },
    ].map(build);
    expect(new Set(values.map((p) => p.proposalDigest)).size).toBe(4);
    for (const p of values) expect(validateRevisionProposal(p)).toEqual(p);
    expect(
      validateRevisionProposal(build({ op: "set", nextExpires: "2026-02-30", dateRuleVersion: "v1" })),
    ).toBeUndefined();
    expect(
      validateRevisionProposal(build({ op: "clear", nextExpires: "2026-01-01", dateRuleVersion: "v1" })),
    ).toBeUndefined();
  });
  it.each([
    "body-only",
    "missing-complete",
    "wrong-digest",
    "envelope",
    "too-large",
    "unknown",
    "wrong-action",
    "context-half",
    "auto-no-evidence",
  ])("drops the whole illegal %s proposal", async (which) => {
    const h = await fixture();
    const changes: Record<string, Record<string, unknown>> = {
      "body-only": { generatedBody: "safe" },
      "missing-complete": { generatedBody: "safe", outputDigest: hash("safe"), generationProvenance: {} },
      "wrong-digest": { proposalDigest: "a".repeat(64) },
      envelope: { generatedBody: "delete: rules.001" },
      "too-large": { generatedBody: "x".repeat(1025) },
      unknown: { extra: "execution" },
      "wrong-action": { action: "future" },
      "context-half": { contextExpectedRev: "" },
      "auto-no-evidence": { autoEligible: true },
    };
    const p =
      which === "wrong-digest" ? { ...proposal(h.input), ...changes[which] } : proposal(h.input, changes[which]);
    expect(validateRevisionProposal(p)).toBeUndefined();
  });
  it("rejects accessor/cycle/Buffer/symbol/nonfinite without executing a getter", async () => {
    const h = await fixture();
    const p = proposal(h.input);
    const getter = vi.fn(() => "surprise");
    const accessor = { ...p };
    Object.defineProperty(accessor, "generatedBody", { get: getter, enumerable: true });
    expect(validateRevisionProposal(accessor)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(validateRevisionProposal({ ...p, relation: Buffer.from("x") })).toBeUndefined();
    expect(validateRevisionProposal({ ...p, relation: { p: NaN } })).toBeUndefined();
    expect(validateRevisionProposal({ ...p, [Symbol("bad")]: 1 })).toBeUndefined();
    const cyclic: Record<string, unknown> = { ...p };
    cyclic.coverage = cyclic;
    expect(validateRevisionProposal(cyclic)).toBeUndefined();
  });
  it("caps only eligible actions at two, never auto-deletes user or auto-merges", async () => {
    const batch = await fixture({ action: "expires" });
    const third = createBlockLocked(join(batch.dir, "blocks"), "rules", { authority: "agent" }, "Third rule.", now);
    const actions = [
      ...[batch.a, batch.b, third].map((target) => ({ action: "expires" as const, target })),
      { action: "rewrite-single" as const, target: batch.a, context: batch.b },
      { action: "merge-survivor" as const, target: batch.a, context: batch.b },
    ];
    const { context: _context, ...batchSpec } = batch.spec;
    const frozen = await withMemoryDirLock(batch.dir, () =>
      actions.map((action) => {
        const f = freezeRevisionInputsLocked(
          batch.dir,
          { ...batchSpec, ...action, actions },
          { isCurrent: () => true },
        );
        if ("kind" in f) throw new Error("batch freeze refused");
        return f;
      }),
    );
    expect(new Set(frozen.map((f) => f.batchId)).size).toBe(1);
    const planned = planRevisionActions({
      candidates: frozen.map((f) => ({
        frozen: f,
        reason: "expired",
        ...(f.action === "expires" ? { expiry: { op: "clear" as const, dateRuleVersion: "v1" } } : {}),
      })),
      autoEnabled: true,
      leaseValid: true,
    });
    expect(planned).toHaveLength(5);
    expect(planned.filter((p) => p.autoEligible)).toHaveLength(2);
    expect(planned.filter((p) => p.action !== "expires").every((p) => !p.autoEligible)).toBe(true);
    const h = await fixture({ action: "delete" });
    const raw = serializeBlock({ ...h.a.meta, authority: "user" }, h.a.body);
    writeFileSync(join(h.dir, "blocks", `${h.a.id}.md`), raw);
    const f = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        { ...h.spec, target: { id: h.a.id, rev: computeRev(1, raw) } },
        { isCurrent: () => true },
      ),
    );
    if ("kind" in f) throw new Error("refused");
    expect(
      planRevisionActions({
        candidates: [
          {
            frozen: f,
            reason: "expired",
            expired: { targetRev: f.target.rev, rawDigest: f.target.rawDigest, policyVersion: f.policyVersion },
          },
        ],
        autoEnabled: true,
        leaseValid: true,
      })[0]?.autoEligible,
    ).toBe(false);
  });
});

describe("real A/B preparation, independent bindings and lifecycle", () => {
  it("executes positive relation -> generate -> independent coverage with actual digest checks", async () => {
    const h = await fixture(),
      c = harness();
    const deps = await c.deps(h.input);
    const before = readFileSync(join(h.dir, "blocks", `${h.a.id}.md`));
    const result = await prepareRevisionProposal(h.input, deps);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("not ok");
    const p = result.proposal;
    expect(p.autoEligible).toBe(true);
    expect(p.generatedBody).toBe("Keep every valid rule and important context.");
    expect(p.relation?.inputDigest).toBe(revisionFrozenRelationDigest(h.input));
    expect(p.coverage?.beforeDigest).toBe(hash(h.input.target.block.body));
    expect(p.coverage?.beforeDigest).not.toBe(h.input.target.rawDigest);
    expect(p.coverage?.candidateDigest).toBe(p.outputDigest);
    expect(p.generationInputComplete).toBe(true);
    expect(
      independentCoverageSources(
        p.relation!.provenance,
        p.generationProvenance!,
        p.coverage!.provenance,
        p.evidenceBindings as Required<typeof p.evidenceBindings>,
      ),
    ).toBe(true);
    expect(
      independentCoverageSources(p.relation!.provenance, p.generationProvenance!, p.coverage!.provenance, {
        ...(p.evidenceBindings as Required<typeof p.evidenceBindings>),
        generation: { requestDigest: hash("wrong"), inputDigest: hash("wrong") },
      }),
    ).toBe(false);
    expect(c.calls).toEqual(["gen/main", "judge/main"]);
    expect(c.client.usage().calls).toBe(3);
    expect(readFileSync(join(h.dir, "blocks", `${h.a.id}.md`))).toEqual(before);
  });
  it.each([
    "sameModel",
    "sameAlias",
    "partial",
    "untrusted",
    "wrongExpected",
    "missingSource",
    "multiSource",
    "lease",
    "lowP",
    "truncated",
  ])("keeps %s evidence suggestion-only", async (which) => {
    const h = await fixture({}, which === "truncated" ? "a".repeat(500) : undefined),
      c = harness({ [which]: true });
    const deps = await c.deps(h.input);
    const outcome = deps.relation!.outcome;
    if (!outcome.ok) throw new Error("relation failed");
    if (which === "wrongExpected")
      deps.relation = {
        ...deps.relation!,
        outcome: {
          ...outcome,
          sources: outcome.sources!.map((s) => ({
            ...s,
            provenance: { ...s.provenance, inputDigest: hash("bad DTO") },
          })),
        },
      };
    if (which === "missingSource") deps.relation = { ...deps.relation!, outcome: { ...outcome, sources: [] } };
    if (which === "multiSource")
      deps.relation = {
        ...deps.relation!,
        outcome: { ...outcome, sources: [...outcome.sources!, ...outcome.sources!] },
      };
    if (which === "lease") deps.attempt.leaseValid = () => false;
    if (which === "lowP") deps.relation = { ...deps.relation!, p: 0.89 };
    const result = await prepareRevisionProposal(h.input, deps);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("not ok");
    expect(result.proposal.autoEligible).toBe(false);
    expect(result.proposal.generatedBody).toBeDefined();
    if (which === "truncated") {
      expect(result.proposal.generationInputComplete).toBe(false);
      expect(c.calls).toEqual(["gen/main"]);
    }
    if (
      ["sameModel", "sameAlias", "partial", "wrongExpected", "missingSource", "multiSource", "untrusted"].includes(
        which,
      )
    )
      expect(result.proposal.coverage).toBeUndefined();
  });
  it("records actual successful failover model rather than configured first chain", async () => {
    const h = await fixture(),
      c = harness({ failover: true });
    const result = await prepareRevisionProposal(h.input, await c.deps(h.input));
    expect(result).toMatchObject({
      kind: "ok",
      proposal: {
        autoEligible: true,
        generationProvenance: { requestChainId: "gen/main", provider: "local", model: "generator" },
      },
    });
    expect(c.calls).toEqual(["gen/fail", "gen/main", "judge/main"]);
  });
  it.each([
    "client",
    "budget",
    "zero-cap",
    "missing-token-cap",
    "generate-cap",
    "dismissed",
    "resolved",
    "epoch-before",
    "abort-before",
    "unknown-budget",
    "wrong-job",
    "owner-unknown",
  ])("refuses %s before model calls", async (which) => {
    const h = await fixture(),
      c = harness();
    const original = await c.deps(h.input);
    const controller = new AbortController();
    const deps = { ...original, attempt: { ...original.attempt, signal: controller.signal } };
    if (which === "client") delete deps.client;
    if (which === "budget") delete deps.requestBudget;
    if (which === "zero-cap") deps.requestBudget = { ...deps.requestBudget!, jobCostCapUsd: 0 };
    if (which === "missing-token-cap") deps.requestBudget = { ...deps.requestBudget!, maxOutputTokens: 0 };
    if (which === "generate-cap") deps.attempt.tryStartGenerate = () => false;
    if (which === "dismissed" || which === "resolved") deps.isSuppressed = async () => which;
    if (which === "epoch-before") deps.attempt.isCurrent = () => false;
    if (which === "owner-unknown")
      deps.attempt.isCurrent = () => {
        throw new Error("no live owner");
      };
    if (which === "wrong-job") deps.requestBudget = { ...deps.requestBudget!, jobId: "unrelated-job" };
    if (which === "abort-before") controller.abort();
    if (which === "unknown-budget") deps.client = { ...c.client, usage: () => ({ costUsd: 0, calls: 0 }) };
    const result = await prepareRevisionProposal(h.input, deps);
    expect(result.kind).toBe(
      which === "dismissed" || which === "resolved"
        ? which
        : ["epoch-before", "abort-before", "owner-unknown"].includes(which)
          ? "stale"
          : "unavailable",
    );
    expect(c.calls).toEqual([]);
  });
  it.each(["epoch", "abort", "lease"])("rechecks %s immediately after awaited generation", async (which) => {
    const h = await fixture();
    let resolve!: () => void;
    const barrier = new Promise<void>((r) => {
      resolve = r;
    });
    const c = harness({ respond: () => barrier });
    const deps = await c.deps(h.input);
    let current = true,
      lease = true;
    const controller = new AbortController();
    deps.attempt.isCurrent = () => current;
    deps.attempt.leaseValid = () => lease;
    deps.attempt.signal = controller.signal;
    const pending = prepareRevisionProposal(h.input, deps);
    for (let i = 0; i < 50 && c.calls.length === 0; i++) await Promise.resolve();
    expect(c.calls).toEqual(["gen/main"]);
    if (which === "epoch") current = false;
    else if (which === "abort") controller.abort();
    else lease = false;
    resolve();
    const result = await pending;
    expect(result.kind).toBe(which === "lease" ? "ok" : "stale");
    if (result.kind === "ok") expect(result.proposal.autoEligible).toBe(false);
    if (which !== "lease") expect(c.calls).toEqual(["gen/main"]);
  });
  it.each(["delete: rules.001", "x".repeat(1025)])("reuses B's unique validator for invalid output", async (text) => {
    const h = await fixture(),
      c = harness({ text });
    const result = await prepareRevisionProposal(h.input, await c.deps(h.input));
    expect(result.kind).toBe("unavailable");
    expect(c.calls).toEqual(["gen/main"]);
  });
});

it("actual model work holds no memory lock and a context edit during generation is not adopted", async () => {
  const h = await fixture();
  let lockChecks = 0;
  const c = harness({
    respond: async () => {
      await withMemoryDirLock(h.dir, () => {
        lockChecks++;
      });
      if (lockChecks === 1) writeFileSync(join(h.dir, "blocks", `${h.b.id}.md`), "external context edit");
    },
  });
  const oldContext = h.input.context!.rawBefore;
  const result = await prepareRevisionProposal(h.input, await c.deps(h.input));
  expect(result.kind).toBe("ok"); // Frozen proposal is allowed; review's lock must refuse it.
  expect(lockChecks).toBe(2);
  expect(h.input.context!.rawBefore.equals(oldContext)).toBe(true);
  expect(await withMemoryDirLock(h.dir, () => revisionInputIsLiveLocked(h.input))).toBe(false);
});
it.each(["user-user", "agent-user"])("permission planning with real evidence: %s", async (pair) => {
  const h = await fixture();
  const path = join(h.dir, "blocks", `${h.a.id}.md`);
  const raw = readFileSync(path, "utf8").replace("authority: agent", "authority: user");
  writeFileSync(path, raw);
  h.spec.target = { id: h.a.id, rev: computeRev(1, raw) };
  if (pair === "user-user") {
    const pathB = join(h.dir, "blocks", `${h.b.id}.md`);
    const rawB = readFileSync(pathB, "utf8").replace("authority: agent", "authority: user");
    writeFileSync(pathB, rawB);
    h.spec.context = { id: h.b.id, rev: computeRev(1, rawB) };
  }
  const f = await h.freeze();
  if ("kind" in f) throw new Error("freeze refused");
  const c = harness(),
    result = await prepareRevisionProposal(f, await c.deps(f));
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("not ok");
  expect(result.proposal.autoEligible).toBe(pair === "user-user");
});
it("agent delete needs exact trusted expiry evidence; user expires stays a suggestion", async () => {
  const h = await fixture({ action: "delete" });
  const expired = {
    targetRev: h.input.target.rev,
    rawDigest: h.input.target.rawDigest,
    policyVersion: h.input.policyVersion,
  };
  const candidate = { frozen: h.input, reason: "expired" as const, expired };
  expect(planRevisionActions({ candidates: [candidate], autoEnabled: true, leaseValid: true })[0]?.autoEligible).toBe(
    true,
  );
  expect(
    planRevisionActions({
      candidates: [{ ...candidate, expired: { ...expired, rawDigest: hash("other raw") } }],
      autoEnabled: true,
      leaseValid: true,
    })[0]?.autoEligible,
  ).toBe(false);
  const e = await fixture({ action: "expires" });
  const raw = readFileSync(join(e.dir, "blocks", `${e.a.id}.md`), "utf8").replace(
    "authority: agent",
    "authority: user",
  );
  writeFileSync(join(e.dir, "blocks", `${e.a.id}.md`), raw);
  e.spec.target = { id: e.a.id, rev: computeRev(1, raw) };
  const f = await e.freeze();
  if ("kind" in f) throw new Error("refused");
  expect(
    planRevisionActions({
      candidates: [{ frozen: f, reason: "expired", expiry: { op: "clear", dateRuleVersion: "v1" } }],
      autoEnabled: true,
      leaseValid: true,
    })[0]?.autoEligible,
  ).toBe(false);
});
it("shared attempt owner limits three prepare calls to two high-level generations", async () => {
  const h = await fixture(),
    c = harness();
  const deps = await c.deps(h.input);
  let admitted = 0;
  deps.attempt.tryStartGenerate = () => (admitted < 2 ? (++admitted, true) : false);
  const first = await prepareRevisionProposal(h.input, deps),
    second = await prepareRevisionProposal(h.input, deps),
    third = await prepareRevisionProposal(h.input, deps);
  expect([first.kind, second.kind, third.kind]).toEqual(["ok", "ok", "unavailable"]);
  expect(admitted).toBe(2);
  expect(c.calls).toEqual(["gen/main", "judge/main", "gen/main", "judge/main"]);
});
it("no adapter binding refuses in the same real client, no provider is invented", async () => {
  const h = await fixture(),
    c = harness();
  const deps = await c.deps(h.input);
  const client = createJevClient({
    config: { ...jevConfigOf(DEFAULT_MEMORY_SETTINGS), classifiers: ["rel/main"] },
    now: Date.now,
    isChild: false,
    p50: { enabled: true },
  });
  deps.client = client;
  expect(await prepareRevisionProposal(h.input, deps)).toEqual({ kind: "unavailable" });
  expect(client.usage().calls).toBe(0);
  expect(c.calls).toEqual([]);
});

it("a client budget exhausted after generation stops coverage and proposal publication", async () => {
  const h = await fixture(),
    c = harness();
  const deps = await c.deps(h.input);
  let exhausted = false;
  const cap = vi.fn();
  deps.attempt.capReached = cap;
  deps.client = {
    ...c.client,
    generateRevision: async (request) => {
      const result = await c.client.generateRevision(request);
      exhausted = true;
      return result;
    },
    usage: () => {
      const usage = c.client.usage();
      return { ...usage, budget: { ...usage.budget!, exhausted } };
    },
  };
  expect(await prepareRevisionProposal(h.input, deps)).toEqual({ kind: "unavailable" });
  expect(c.calls).toEqual(["gen/main"]);
  expect(cap).toHaveBeenCalledTimes(1);
});

it("foreign canonical directories or mixed selection batches cannot form an automatic batch", async () => {
  const a = await fixture({ action: "expires" }),
    b = await fixture({ action: "expires" });
  const mixed = planRevisionActions({
    candidates: [a, b].map((h) => ({
      frozen: h.input,
      reason: "expired",
      expiry: { op: "clear", dateRuleVersion: "v1" },
    })),
    autoEnabled: true,
    leaseValid: true,
  });
  expect(mixed).toHaveLength(2);
  expect(mixed.every((p) => !p.autoEligible)).toBe(true);
});

it("same-directory cross-topic merge generates only the survivor suggestion, never retires context", async () => {
  const h = await fixture({ action: "merge-survivor" });
  const other = createBlockLocked(
    join(h.dir, "blocks"),
    "context",
    { authority: "agent" },
    "Keep important context.",
    now,
  );
  h.spec.context = other;
  const f = await h.freeze();
  if ("kind" in f) throw new Error("refused");
  const contextBefore = readFileSync(join(h.dir, "blocks", `${other.id}.md`));
  const c = harness(),
    result = await prepareRevisionProposal(f, await c.deps(f));
  expect(result).toMatchObject({
    kind: "ok",
    proposal: {
      action: "merge-survivor",
      contextId: other.id,
      autoEligible: false,
      generatedBody: "Keep every valid rule and important context.",
    },
  });
  expect(c.calls).toEqual(["gen/main", "judge/main"]);
  expect(readFileSync(join(h.dir, "blocks", `${other.id}.md`))).toEqual(contextBefore);
});
