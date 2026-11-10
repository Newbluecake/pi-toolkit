// S0 factory contract tests: real D -> C -> review/E over own temporary data.
// No selector/host/production wiring or network is exercised here.
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fixture, host } from "./revision-e-helpers.js";
import { setup } from "./revision-retire-helpers.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import { parseBlockFile } from "../../../src/memory/blocks/format.js";
import { createRevisionAuditPort, restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import {
  freezeRevisionInputsLocked,
  planRevisionActions,
  prepareRevisionProposal,
  revisionCanonicalJson,
  revisionProposalDigest,
  validateRevisionProposal,
  REVISION_ACTION_ID_VERSION,
  type RevisionFreezeAction,
} from "../../../src/memory/govern/revision.js";
import { revisionSuggestionSuppressed, upsertRevisionSuggestion } from "../../../src/memory/govern/review-lite.js";
import { blockAnchor, writeGovernIndexLocked } from "../../../src/memory/govern/supersede.js";
import { entryHash } from "../../../src/memory/jev/entries.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import type {
  DismissedPair,
  FrozenRevisionInput,
  RetireEvidence,
  RevisionRegistryLike,
  ClassifierRegistryLike,
} from "../../../src/memory/jev/contracts.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
type Harness = Awaited<ReturnType<typeof fixture>>;
function parse(h: Harness, id: string) {
  const b = parseBlockFile(`${id}.md`, fs.readFileSync(join(h.blocks, `${id}.md`), "utf8"));
  if ("stray" in b) throw Error("bad fixture");
  return b;
}
async function freeze(
  h: Harness,
  action: RevisionFreezeAction,
  actions: readonly RevisionFreezeAction[],
  source?: RetireEvidence["source"],
  policyVersion = h.frozen.policyVersion,
) {
  const f = await withMemoryDirLock(h.dir, () =>
    freezeRevisionInputsLocked(
      h.dir,
      {
        directory: h.frozen.directory,
        selectionBatchId: "fixed-menu",
        policyVersion,
        ...action,
        actions,
        ...(source ? { retireSource: source } : {}),
      },
      { isCurrent: () => true, audit: createRevisionAuditPort(h.dir, h.auditDeps) },
    ),
  );
  if ("kind" in f) throw Error(`freeze refused: ${f.reason}`);
  return f;
}
function plan(frozen: FrozenRevisionInput) {
  const p = planRevisionActions({
    candidates: [{ frozen, reason: "supersedes" }],
    autoEnabled: false,
    leaseValid: true,
  })[0];
  if (!p) throw Error("no proposal");
  return p;
}
it("complete directed action-v2 rows: intersecting AB/AC merge and retire independently reach real C/review", async () => {
  const h = await fixture();
  fs.writeFileSync(join(h.blocks, "rules.003.md"), h.raw("Third context."), { mode: 0o600 });
  const a = parse(h, "rules.001"),
    b = parse(h, "rules.002"),
    c = parse(h, "rules.003");
  const actions: RevisionFreezeAction[] = [
    { action: "merge-survivor", target: a, context: b },
    { action: "merge-survivor", target: a, context: c },
    { action: "retire", target: a, context: b },
    { action: "retire", target: a, context: c },
    { action: "retire", target: b, context: a },
    { action: "rewrite-single", target: a },
    { action: "rewrite-single", target: a, context: b },
  ];
  const frozen = await Promise.all(actions.map((a) => freeze(h, a, actions)));
  expect(new Set(frozen.map((f) => f.batchId)).size).toBe(1);
  expect(new Set(frozen.map((f) => f.actionId)).size).toBe(7);
  for (const [i, f] of frozen.entries()) {
    expect(f.actionId).toBe(
      hash(
        revisionCanonicalJson([
          REVISION_ACTION_ID_VERSION,
          f.batchId,
          [
            f.action,
            [f.target.id, f.target.rev, f.target.rawDigest],
            f.context ? [f.context.id, f.context.rev, f.context.rawDigest] : null,
          ],
        ]),
      ),
    );
    const permuted = await freeze(h, actions[i]!, [...actions].reverse());
    expect(permuted.batchId).toBe(f.batchId);
    expect(permuted.actionId).toBe(f.actionId);
    // Reverse direction is a distinct action, but intentionally shares the
    // stable semantic review key: do not publish a second reverse suggestion.
    if (i >= 4) continue;
    const proposal = plan(f);
    expect(await upsertRevisionSuggestion(h.dir, { frozen: f, proposal, origin: "p50-suggestion" }, h.reviewDeps)).toBe(
      "saved",
    );
    const r = await withMemoryDirLock(h.dir, () =>
      createRevisionAuditPort(h.dir, h.auditDeps).readActionLocked(f.batchId, f.actionId),
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw Error("missing audit");
    expect(r.audit.proposalDigest).toBe(proposal.proposalDigest);
    expect(r.before).toEqual(f.target.rawBefore);
  }
  expect(readIndex(h.dir).index.review?.suggestions).toHaveLength(4);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
});
it("source-retire and ordinary same-target/different-context share one batch without ID collision", async () => {
  const h = await setup();
  fs.writeFileSync(join(h.blocks, "rules.003.md"), h.raw("Other ordinary context."), { mode: 0o600 });
  const actions: RevisionFreezeAction[] = [
    { action: "retire", target: parse(h, "rules.002"), context: parse(h, "rules.001") },
    { action: "retire", target: parse(h, "rules.002"), context: parse(h, "rules.003") },
  ];
  const source = await freeze(h, actions[0]!, actions, h.source);
  const ordinary = await freeze(h, actions[1]!, actions);
  expect(source.batchId).toBe(ordinary.batchId);
  expect(source.actionId).not.toBe(ordinary.actionId);
  const prepared = await h.prepareRetire(source);
  if (prepared.kind !== "ok") throw Error("source prepare");
  for (const [frozen, proposal] of [
    [source, prepared.proposal],
    [ordinary, plan(ordinary)],
  ] as const) {
    expect(await upsertRevisionSuggestion(h.dir, { frozen, proposal, origin: "p50-suggestion" }, h.reviewDeps)).toBe(
      "saved",
    );
    const r = await withMemoryDirLock(h.dir, () => h.freshAudit().readActionLocked(frozen.batchId, frozen.actionId));
    expect(r).toMatchObject({
      kind: "ok",
      audit: { actionId: frozen.actionId, proposalDigest: proposal.proposalDigest },
    });
    if (r.kind === "ok") expect(r.before).toEqual(h.oldBefore);
  }
  expect(readIndex(h.dir).index.review?.suggestions.filter((s) => s.revision?.batchId === source.batchId)).toHaveLength(
    2,
  );
});
it("historical old-formula source references remain opaque/readable/restorable, never re-signed", async () => {
  const h = await setup();
  // Build a historical fixture ONCE with the prior writer formula. This is
  // not a migration: no persisted record is rewritten to manufacture support.
  const f = {
    ...h.sourceFrozen,
    actionId: hash(
      revisionCanonicalJson([
        h.sourceFrozen.batchId,
        h.sourceFrozen.action,
        h.sourceFrozen.target.id,
        h.sourceFrozen.target.rev,
      ]),
    ),
  };
  expect(f.actionId).not.toBe(h.sourceFrozen.actionId);
  const { proposalDigest: _digest, ...payload } = { ...h.sourceProposal, actionId: f.actionId };
  const p = { ...payload, proposalDigest: revisionProposalDigest(payload) };
  const expected = {
    kind: "file" as const,
    raw: h.successorAfter,
    digest: createHash("sha256").update(h.successorAfter).digest("hex"),
    rev: parse(h, "rules.001").rev,
  };
  await withMemoryDirLock(h.dir, () => {
    // Replay the prior writer's real before -> after sequence in this fixture.
    fs.writeFileSync(h.targetPath, f.target.rawBefore);
    const audit = h.freshAudit();
    expect(audit.persistPreparedBarrierLocked({ frozen: f, proposal: p, origin: "p50-suggestion" }).kind).toBe("ok");
    expect(
      audit.persistExpectedAfterBarrierLocked({
        batchId: f.batchId,
        actionId: f.actionId,
        proposalDigest: p.proposalDigest,
        expected,
      }).kind,
    ).toBe("ok");
    expect(
      audit.finalizeCommitLocked({
        batchId: f.batchId,
        actionId: f.actionId,
        proposalDigest: p.proposalDigest,
        observation: safeFs.replaceRevisionObserved(
          h.blocks,
          safeFs.writeTempRegular(h.blocks, "rules.001.md", expected.raw, 0o600),
          "rules.001.md",
          expected,
        ).observation,
        dataDirectories: [h.blocks],
      }).kind,
    ).toBe("committed");
  });
  expect(validateRevisionProposal(p)).toEqual(p);
  // A historical review row also round-trips under its original reference.
  const oldIndex = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  const oldRow = oldIndex.review.suggestions.find(
    (s: { id: string }) => s.id === `revision:${h.sourceFrozen.actionId}`,
  );
  oldRow.id = `revision:${f.actionId}`;
  oldRow.revision = p;
  fs.writeFileSync(h.indexPath, JSON.stringify(oldIndex));
  const oldIndexBytes = fs.readFileSync(h.indexPath);
  expect(readIndex(h.dir).index.review?.suggestions.find((s) => s.id === `revision:${f.actionId}`)?.revision).toEqual(
    p,
  );
  expect(fs.readFileSync(h.indexPath)).toEqual(oldIndexBytes);
  const path = join(h.actionPath(f), "audit.json"),
    beforeAudit = fs.readFileSync(path);
  const source = { batchId: f.batchId, actionId: f.actionId, proposalDigest: p.proposalDigest };
  const action: RevisionFreezeAction = {
    action: "retire",
    target: parse(h, "rules.002"),
    context: parse(h, "rules.001"),
  };
  const frozen = await freeze(h, action, [action], source);
  const prepared = await h.prepareRetire(frozen);
  if (prepared.kind !== "ok") throw Error("historical source refused");
  expect(prepared.proposal.retireEvidence?.source).toEqual(source);
  expect(
    await upsertRevisionSuggestion(
      h.dir,
      { frozen, proposal: prepared.proposal, origin: "p50-suggestion" },
      h.reviewDeps,
    ),
  ).toBe("saved");
  expect(fs.readFileSync(path)).toEqual(beforeAudit);
  expect((await restoreRevisionRaw(h.dir, { actionId: f.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.targetPath)).toEqual(f.target.rawBefore);
  const restored = await withMemoryDirLock(h.dir, () => h.freshAudit().readActionLocked(f.batchId, f.actionId));
  expect(restored).toMatchObject({
    kind: "ok",
    audit: { actionId: f.actionId, proposalDigest: p.proposalDigest, state: "restored" },
  });
});
it.each([true, false])(
  "cross-policy source is rejected, including legacy missing-spec=%s (no plain downgrade)",
  async (legacy) => {
    const h = await setup();
    if (legacy) {
      const a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
      delete a.generationRequest;
      fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
    }
    const before = fs.readFileSync(h.sourceAuditPath),
      calls = h.calls.length;
    const action: RevisionFreezeAction = {
      action: "retire",
      target: parse(h, "rules.002"),
      context: parse(h, "rules.001"),
    };
    const result = await withMemoryDirLock(h.dir, () =>
      freezeRevisionInputsLocked(
        h.dir,
        {
          directory: h.frozen.directory,
          selectionBatchId: "other-policy",
          policyVersion: "other-policy/action-v2",
          ...action,
          actions: [action],
          retireSource: h.source,
        },
        { isCurrent: () => true, audit: h.freshAudit() },
      ),
    );
    expect(result).toEqual({ kind: "refused", reason: "unavailable" });
    expect(h.calls).toHaveLength(calls);
    expect(fs.readFileSync(h.sourceAuditPath)).toEqual(before);
  },
);
function addTombstone(h: Harness, mode: "dismissed" | "resolved", keyed = true, prefixed = true) {
  const input = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  const key = JSON.stringify([
    ...(prefixed ? ["governance"] : []),
    "conflict",
    "rules.002.md|old|old body",
    "rules.001.md||old body",
  ]);
  if (mode === "resolved") input.review.resolved = [...(input.review.resolved ?? []), key];
  else
    input.review.dismissed.push({
      hashKey: "old-a+old-b",
      anchorKey: "rules.001.md||old+rules.002.md|old|old",
      ...(keyed ? { suggestionKey: key, kind: "conflict" } : {}),
    });
  fs.writeFileSync(h.indexPath, JSON.stringify(input));
}
/** Exact old pair producer grammar, using actual parsed historical blocks.
 * Bodies/revisions are genuinely different from the live D-frozen inputs. */
function producedTombstone(h: Harness, body: string): DismissedPair {
  const old = (id: string, text: string) => {
    const b = parseBlockFile(`${id}.md`, h.raw(text, 6).toString("utf8"));
    if ("stray" in b || b.errors.length) throw Error("invalid producer fixture");
    const current = parse(h, id);
    expect(current.rev).not.toBe(b.rev);
    expect(entryHash(current.body)).not.toBe(entryHash(b.body));
    return b;
  };
  const a = old("rules.001", body),
    b = old("rules.002", "Keep locks.");
  return {
    hashKey: [entryHash(a.body), entryHash(b.body)].sort().join("+"),
    anchorKey: [blockAnchor(a), blockAnchor(b)].sort().join("+"),
  };
}
/** Caller owns h.dir's existing lock, including E's syscall callback. */
function installProducedTombstoneLocked(h: Harness, d: DismissedPair) {
  expect(fs.existsSync(join(h.dir, ".lock"))).toBe(true);
  const index = readIndex(h.dir).index;
  const review = index.review ?? { lastRunAt: "", corpusFp: "", suggestions: [], dismissed: [] };
  writeGovernIndexLocked(h.dir, { ...index, review: { ...review, dismissed: [...review.dismissed, d] } });
  expect(revisionCanonicalJson(JSON.parse(fs.readFileSync(h.indexPath, "utf8")).review)).toBe(
    revisionCanonicalJson(readIndex(h.dir).index.review),
  );
}
it.each(["dismissed", "resolved"] as const)(
  "legacy %s arriving during actual generation wait blocks C prepared/save",
  async (mode) => {
    const h = await fixture();
    // Ensure a live review file exists before the second frozen batch starts.
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("saved");
    h.state.epoch = 2;
    const f = await h.freeze(2);
    const deps = {
      ...h.reviewDeps,
      isCurrent: () => true,
      audit: createRevisionAuditPort(h.dir, { ...h.auditDeps, isCurrent: () => true }),
    };
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = h.registry.complete!;
    vi.spyOn(h.registry as Required<Pick<RevisionRegistryLike, "complete">>, "complete").mockImplementation(
      async (...args) => {
        entered();
        await gate;
        return complete(...args);
      },
    );
    const preparing = h.prepare(f);
    await waiting;
    if (mode === "dismissed") {
      const d = producedTombstone(h, "Rule one.\nUse C++.");
      await withMemoryDirLock(h.dir, () => installProducedTombstoneLocked(h, d));
    } else addTombstone(h, mode);
    const indexBytes = fs.readFileSync(h.indexPath);
    release();
    const result = await preparing;
    if (result.kind !== "ok") throw Error("prepare should leave authoritative suppression to save");
    expect(await revisionSuggestionSuppressed(h.dir, f, { isCurrent: () => true }, "conflict")).toBe(mode);
    const barrier = vi.spyOn(deps.audit, "persistPreparedBarrierLocked");
    expect(
      await upsertRevisionSuggestion(h.dir, { frozen: f, proposal: result.proposal, origin: "p50-suggestion" }, deps),
    ).toBe(mode);
    expect(barrier).not.toHaveBeenCalled();
    expect(fs.existsSync(h.actionPath(f))).toBe(false);
    expect(fs.readFileSync(h.indexPath)).toEqual(indexBytes);
  },
);
it.each([
  ["entry", "dismissed"],
  ["entry", "resolved"],
  ["last-syscall", "dismissed"],
  ["last-syscall", "resolved"],
] as const)("E %s rechecks live legacy %s with strict sanitize equality intact", async (phase, mode) => {
  const h = await fixture(),
    x = await host(h);
  let installed = false;
  const install = () => {
    addTombstone(h, mode, phase !== "entry" || mode !== "dismissed", false);
    // Prove this test exercises semantic suppression, not the unrelated
    // fail-closed raw-vs-sanitized consistency gate.
    expect(revisionCanonicalJson(JSON.parse(fs.readFileSync(h.indexPath, "utf8")).review)).toBe(
      revisionCanonicalJson(readIndex(h.dir).index.review),
    );
  };
  if (phase === "entry") install();
  else {
    const original = safeFs.replaceRevisionObserved;
    vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
      // Insert only after applyLocked's checks and before the safe-fs helper's
      // actual beforeSyscall guard. Earlier coordinator checks cannot catch it.
      if (!installed && args[0] === h.blocks && args[2] === "rules.001.md") {
        installed = true;
        install();
      }
      const result = original(...args);
      if (args[0] === h.blocks) {
        expect(result.observation.kind).toBe("not-applied");
        expect(result.error).toContain("stale");
      }
      return result;
    });
  }
  const data = vi.spyOn(safeFs, "writeTempRegular");
  const result = await x.commit();
  expect(result.kind).toBe("skipped");
  if (phase === "last-syscall") expect(installed).toBe(true);
  else expect(result).toMatchObject({ reason: "stale" });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  expect(data.mock.calls.filter((args) => args[0] === h.blocks)).toHaveLength(phase === "entry" ? 0 : 1);
});

it("D pre-generation callback receives the truthful reason and can share the complete predicate", async () => {
  const h = await fixture();
  await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps);
  addTombstone(h, "dismissed");
  const calls = h.calls.length;
  const isSuppressed = vi.fn(
    (f: FrozenRevisionInput, reason: "conflict" | "supersedes" | "expired" | "duplicate" | "budget") =>
      revisionSuggestionSuppressed(h.dir, f, { isCurrent: () => true }, reason),
  );
  const generate = vi.fn(() => true);
  const result = await prepareRevisionProposal(h.frozen, {
    client: h.client,
    requestBudget: { registry: h.registry, mode: "sync", budgetMs: 3000, maxOutputTokens: 2048, jobCostCapUsd: 10 },
    attempt: {
      signal: new AbortController().signal,
      isCurrent: () => true,
      leaseValid: () => true,
      tryStartGenerate: generate,
      capReached() {
        throw Error("unexpected cap");
      },
    },
    isSuppressed,
    reason: "conflict",
    autoEnabled: false,
  });
  expect(result).toEqual({ kind: "dismissed" });
  expect(isSuppressed).toHaveBeenCalledWith(h.frozen, "conflict");
  expect(generate).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(calls);
});
it("legacy duplicate does not blanket-ban a different actual supersedes/retire through review and E", async () => {
  const h = await setup();
  const classify = h.registry.classify!;
  vi.spyOn(h.registry as Required<Pick<ClassifierRegistryLike, "classify">>, "classify").mockImplementation(
    async (...args) => {
      const r = await classify(...args);
      return {
        ...r,
        answers: {
          revisionRelation: {
            type: "choice",
            choice: "supersedes",
            probabilities: { conflict: 0.01, supersedes: 0.99 },
            confidence: 0.99,
          },
        },
      };
    },
  );
  const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  const d = {
    hashKey: "old-a+old-b",
    anchorKey: "old",
    kind: "duplicate",
    suggestionKey: '["duplicate","rules.001.md","rules.002.md"]',
  };
  index.review.dismissed.push(d);
  // A revision merge dismissal likewise must not become a blanket pair ban.
  index.review.resolved = ['["revision","merge-survivor","rules.001","rules.002"]'];
  fs.writeFileSync(h.indexPath, JSON.stringify(index));
  const owned = await h.retire();
  expect(owned.proposal.reason).toBe("supersedes");
  expect(owned.proposal.relation?.kind).toBe("supersedes");
  const x = await host(h, owned);
  expect(readIndex(h.dir).index.review?.dismissed).toContainEqual(d);
  expect((await x.commit()).kind).toBe("committed");
  expect(parseBlockFile("rules.002.md", fs.readFileSync(h.contextPath, "utf8"))).toMatchObject({
    meta: { status: "superseded", supersededBy: "rules.001" },
  });
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});

it.each(["Rule one.\nRule two.", "Use C++.\nKeep rules."])(
  "real producer kindless %j blocks locked precheck/upsert before C prepared after hash/rev changes",
  async (body) => {
    const h = await fixture(),
      d = producedTombstone(h, body);
    await withMemoryDirLock(h.dir, () => installProducedTombstoneLocked(h, d));
    const indexBytes = fs.readFileSync(h.indexPath);
    expect(await revisionSuggestionSuppressed(h.dir, h.frozen, { isCurrent: () => true }, "conflict")).toBe(
      "dismissed",
    );
    const prepared = vi.spyOn(h.audit, "persistPreparedBarrierLocked");
    expect(await upsertRevisionSuggestion(h.dir, h.input, h.reviewDeps)).toBe("dismissed");
    expect(prepared).not.toHaveBeenCalled();
    expect(fs.existsSync(h.actionPath())).toBe(false);
    expect(fs.readFileSync(h.indexPath)).toEqual(indexBytes);
    expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  },
);
it.each([
  ["entry", "Rule one.\nRule two."],
  ["entry", "Use C++.\nKeep rules."],
  ["last-syscall", "Rule one.\nRule two."],
  ["last-syscall", "Use C++.\nKeep rules."],
] as const)("E %s uses real producer kindless %j after rev/hash changes", async (phase, body) => {
  const h = await fixture(),
    x = await host(h),
    d = producedTombstone(h, body);
  let installed = false;
  if (phase === "entry") await withMemoryDirLock(h.dir, () => installProducedTombstoneLocked(h, d));
  const replace = safeFs.replaceRevisionObserved;
  const targetResults: string[] = [];
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[0] === h.blocks && args[2] === "rules.001.md") {
      expect(phase).toBe("last-syscall");
      // Real applier's prior checks already passed. Only safe-fs's final
      // beforeSyscall guard can catch this newly persisted producer tombstone.
      installProducedTombstoneLocked(h, d);
      installed = true;
    }
    const r = replace(...args);
    if (args[0] === h.blocks) {
      targetResults.push(r.observation.kind);
      expect(r.error).toContain("stale");
    }
    return r;
  });
  expect((await x.commit()).kind).toBe("skipped");
  expect(installed).toBe(phase === "last-syscall");
  expect(targetResults).toEqual(phase === "entry" ? [] : ["not-applied"]);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.before);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.contextBefore);
  expect(readIndex(h.dir).index.review?.dismissed).toContainEqual(d);
});
