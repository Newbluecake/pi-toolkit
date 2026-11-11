import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { hostFixture } from "./revision-host-helpers.js";
import { setup, setupMany } from "./revision-retire-helpers.js";
import { createRevisionHost } from "../../../src/memory/govern/revision-host.js";
import { restoreRevisionRaw } from "../../../src/memory/govern/revision-audit.js";
import { readIncrementalCorpus } from "../../../src/memory/govern/incremental-corpus.js";
import * as revision from "../../../src/memory/govern/revision.js";
import * as review from "../../../src/memory/govern/review-lite.js";
import * as safeFs from "../../../src/memory/safe-fs.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { writeGovernIndexLocked } from "../../../src/memory/govern/supersede.js";
import { withMemoryDirLock } from "../../../src/memory/lock.js";
import type { IncrementalBatch, IncrementalAttemptContext } from "../../../src/memory/govern/incremental.js";

it("cold cross-topic real client/D/C/review positive, complete menu frozen before ALL models, same D job and merge never auto", async () => {
  const h = await hostFixture(0);
  h.write("a.001", "Keep the directory lock budget.");
  h.write("b.001", "Keep the directory lock before writes.");
  const freeze = vi.spyOn(revision, "freezeRevisionInputsLocked"),
    ask = vi.spyOn(h.client, "ask"),
    generate = vi.spyOn(h.client, "generateRevision"),
    coverage = vi.spyOn(h.client, "judgeRevisionCoverage");
  const original = h.registry.classify!;
  vi.spyOn(h.registry, "classify").mockImplementation((...args) => {
    expect(freeze).toHaveBeenCalledTimes(3);
    return original(...args);
  });
  const before = fs.readFileSync(join(h.blocks, "a.001.md"));
  h.state.auto = true;
  const r = await h.host.handle(h.batch(), h.attempt);
  expect(r).toMatchObject({ kind: "settled", reason: "done", menuSize: 3, saved: 1, effects: 0 });
  expect(ask).toHaveBeenCalledTimes(2);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(coverage).toHaveBeenCalledTimes(1);
  const frozen = freeze.mock.results.map((r) => r.value).filter((r) => !("kind" in r));
  expect(new Set(frozen.map((f) => f.batchId))).toEqual(new Set([r.batchId]));
  for (const spy of [ask, generate, coverage])
    for (const call of spy.mock.calls)
      expect(call[0]).toMatchObject({ jobId: r.batchId, jobCostCapUsd: 10, registry: h.registry, mode: "background" });
  const p = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(p).toMatchObject({ action: "merge-survivor", reason: "conflict", autoEligible: false });
  expect(p.generatedBody).toBeDefined();
  expect(fs.existsSync(join(h.blocks, ".jev/revisions", p.batchId, p.actionId, "before.md"))).toBe(true);
  expect(fs.readFileSync(join(h.blocks, "a.001.md"))).toEqual(before);
  expect(h.host.inspect().jobs).toEqual([{ id: r.batchId, state: "settled", generateClaims: 1 }]);
});
it("4 ordinary pairs menu12, only2 generate +2 bodyless, no third G/cap and next page only next external call", async () => {
  const h = await hostFixture(5),
    freeze = vi.spyOn(revision, "freezeRevisionInputsLocked"),
    g = vi.spyOn(h.client, "generateRevision");
  const r = await h.host.handle(h.batch(), h.attempt);
  expect(r).toMatchObject({ kind: "settled", menuSize: 12, saved: 4 });
  expect(freeze).toHaveBeenCalledTimes(12);
  expect(g).toHaveBeenCalledTimes(2);
  expect(h.state.cap).toBe(0);
  expect(h.calls.filter((c) => c.kind === "relation")).toHaveLength(8);
  const ps = readIndex(h.dir).index.review!.suggestions.map((s) => s.revision!);
  expect(ps.filter((p) => p.generatedBody)).toHaveLength(2);
  expect(h.host.inspect().directories[0]!.ordinary.filter(([, s]) => s === "pending")).toHaveLength(6);
  const r2 = await h.host.handle(h.batch(), h.attempt);
  expect(r2.saved).toBe(4);
  expect(r2.batchId).not.toBe(r.batchId);
  expect(h.host.inspect().directories[0]!.ordinary.filter(([, s]) => s === "pending")).toHaveLength(2);
});
it("ordinary fresh unique direction picks covered target independently of ID, no source never auto", async () => {
  const h = await hostFixture(2, {
    relation: (dto) => {
      const target = (dto.state.target as { id: string }).id;
      const kind = target === "rules.002" ? "supersedes" : "unrelated";
      return { type: "choice", choice: kind, probabilities: { [kind]: 0.99 }, confidence: 0.99 };
    },
  });
  h.state.auto = true;
  expect((await h.host.handle(h.batch(), h.attempt)).saved).toBe(1);
  const p = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(p).toMatchObject({
    action: "retire",
    targetId: "rules.002",
    contextId: "rules.001",
    autoEligible: false,
    reason: "supersedes",
    relation: { kind: "supersedes" },
  });
  expect(p.retireEvidence).toBeUndefined();
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation"]);
  expect(h.state.writes).toBe(0);
});
it("double covers stays ambiguous bodyless merge, lexical/ID do not authorize direction", async () => {
  const h = await hostFixture(2, {
    relation: () => ({ type: "choice", choice: "supersedes", probabilities: { supersedes: 0.99 }, confidence: 0.99 }),
  });
  expect((await h.host.handle(h.batch(), h.attempt)).saved).toBe(1);
  const p = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(p.action).toBe("merge-survivor");
  expect(p.generatedBody).toBeUndefined();
  expect(h.calls).toHaveLength(2);
});
it("lease pre-lost: relation discovery then bodyless with zero G; lease lost inside suppression->slot race stops whole job", async () => {
  const h = await hostFixture(2);
  h.state.lease = false;
  expect((await h.host.handle(h.batch(), h.attempt)).saved).toBe(1);
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation"]);
  expect(readIndex(h.dir).index.review!.suggestions[0]!.revision!.generatedBody).toBeUndefined();
  const x = await hostFixture(2),
    original = review.revisionSuggestionSuppressed;
  let n = 0;
  vi.spyOn(review, "revisionSuggestionSuppressed").mockImplementation(async (...args) => {
    const r = await original(...args);
    if (++n === 2) x.state.lease = false;
    return r;
  });
  expect(await x.host.handle(x.batch(), x.attempt)).toMatchObject({ reason: "blocked-job" });
  expect(x.state.cap).toBe(1);
  expect(x.calls.filter((c) => c.kind === "generation")).toHaveLength(0);
  expect(readIndex(x.dir).index.review?.suggestions ?? []).toEqual([]);
  expect(x.host.inspect().jobs[0]!.state).toBe("blocked-job");
});
it("all-suppressed page: zero freeze/claim/models, no same-opportunity refill", async () => {
  const h = await hostFixture(3);
  await withMemoryDirLock(h.dir, () =>
    writeGovernIndexLocked(h.dir, {
      ...readIndex(h.dir).index,
      review: {
        lastRunAt: "",
        corpusFp: "",
        suggestions: [],
        dismissed: [
          ...[
            ["rules.001", "rules.002"],
            ["rules.001", "rules.003"],
            ["rules.002", "rules.003"],
          ].flatMap((ids) =>
            ["merge-survivor", "retire"].map((action) => ({
              hashKey: "old+hash",
              anchorKey: ids.join("+"),
              suggestionKey: JSON.stringify(["revision", action, ...ids]),
            })),
          ),
        ],
      },
    }),
  );
  const freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  expect(await h.host.handle(h.batch(), h.attempt)).toMatchObject({ reason: "empty-page" });
  expect(freeze).not.toHaveBeenCalled();
  expect(h.host.inspect().jobs).toEqual([]);
  expect(h.calls).toEqual([]);
});
it("temporary admission and real lock-busy remain pending; stale raw separately invalidates instead of freeze-rejected", async () => {
  const h = await hostFixture(2);
  h.state.admit = false;
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("pending");
  expect(h.host.inspect().directories[0]!.ordinary[0]![1]).toBe("pending");
  h.state.admit = true;
  let result: Awaited<ReturnType<typeof h.host.handle>> | undefined;
  await withMemoryDirLock(h.dir, () => {
    void h.host.handle(h.batch(), h.attempt).then((r) => {
      result = r;
    });
  });
  await vi.waitFor(() => expect(result?.reason).toBe("lock-busy"));
  const old = h.batch();
  h.write("rules.001", "new raw", "agent", 2);
  expect((await h.host.handle(old, h.attempt)).reason).toBe("input-invalidated");
  expect(h.host.inspect().jobs).toEqual([]);
  expect(h.calls).toEqual([]);
});
it("deterministic freeze failure blocks whole page, never subset re-freeze or new job", async () => {
  const h = await hostFixture(3),
    real = revision.freezeRevisionInputsLocked;
  let n = 0;
  const freeze = vi
    .spyOn(revision, "freezeRevisionInputsLocked")
    .mockImplementation((...args) => (++n === 2 ? { kind: "refused", reason: "permission" } : real(...args)));
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("freeze-rejected");
  expect(freeze).toHaveBeenCalledTimes(2);
  expect(h.calls).toEqual([]);
  expect(h.host.inspect().jobs).toEqual([]);
  expect(h.host.inspect().directories[0]!.ordinary.every(([, s]) => s === "blocked-freeze")).toBe(true);
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("empty-page");
  expect(freeze).toHaveBeenCalledTimes(2);
});
it("claim then real reservation/noQuote zero-dispatch failure is terminal blocked-job, reset never revives same job", async () => {
  const h = await hostFixture(2, { noQuote: true });
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.calls).toEqual([]);
  expect(h.client.usage().calls).toBe(0);
  expect(h.host.inspect().directories[0]!.ordinary[0]![1]).toBe("blocked-job");
  h.host.reset("session");
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.host.inspect().jobs).toHaveLength(1);
  expect(h.calls).toEqual([]);
});
it("successful same raw/menu/job reset refuses R/G/C and keeps consumed slots", async () => {
  const h = await hostFixture(2);
  const first = await h.host.handle(h.batch(), h.attempt),
    count = h.calls.length;
  h.host.reset("tree");
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.calls).toHaveLength(count);
  expect(h.host.inspect().jobs[0]).toMatchObject({ id: first.batchId, generateClaims: 1, state: "settled" });
});
it("input epoch/binding loss during an actual relation wait revokes late suggestion and refuses concurrent handle", async () => {
  const h = await hostFixture(2);
  let release: (() => void) | undefined;
  const real = h.registry.classify!;
  vi.spyOn(h.registry, "classify").mockImplementation(async (...args) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return real(...args);
  });
  const p = h.host.handle(h.batch(), h.attempt);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("running");
  h.setBinding({ ...h.binding });
  release!();
  expect((await p).reason).toBe("blocked-job");
  expect(readIndex(h.dir).index.review?.suggestions ?? []).toEqual([]);
  expect(h.calls).toHaveLength(1);
});
it("direction expected independently precomputed: swapped/corrupt/untrusted outcomes never generate", async () => {
  for (const mutation of ["swap", "digest", "identity"] as const) {
    const h = await hostFixture(2);
    const real = h.client.ask.bind(h.client);
    let previous: Awaited<ReturnType<typeof real>> | undefined;
    vi.spyOn(h.client, "ask").mockImplementation(async (req) => {
      const r = await real(req);
      if (!r.ok) return r;
      if (mutation === "swap") {
        if (previous) return previous;
        previous = r;
        return r;
      }
      return {
        ...r,
        sources: r.sources!.map((s) => ({
          ...s,
          provenance: {
            ...s.provenance,
            ...(mutation === "digest"
              ? { requestDigest: "0".repeat(64) }
              : { trusted: false, provider: "", model: "" }),
          },
        })),
      };
    });
    const g = vi.spyOn(h.client, "generateRevision");
    expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
    expect(g).not.toHaveBeenCalled();
    expect(h.host.inspect().directories[0]!.ordinary[0]![1]).toBe("failed");
  }
});

/** Existing source harness supplies the same REAL client and persisted C/D/E source. */
function sourceHost(h: Awaited<ReturnType<typeof setup>>, auto = true) {
  const binding = { registry: h.registry, budgetMs: 3000, maxOutputTokens: 2048 };
  const state = { lease: true, effects: 0 };
  const attempt: IncrementalAttemptContext = {
    signal: new AbortController().signal,
    isCurrent: () => h.state.current,
    leaseValid: () => state.lease,
    tryStartGenerate: () => state.lease,
    capReached: () => {
      throw Error("unexpected source cap");
    },
  };
  const host = createRevisionHost({
    client: h.client,
    binding: () => binding,
    isCurrent: () => h.state.current,
    canAttempt: () => true,
    autoEnabled: () => auto,
    policyVersion: h.sourceFrozen.policyVersion,
    now: h.auditDeps.now,
    onAfterWrite: () => {
      state.effects++;
      state.lease = false;
    },
  });
  const batch = (): IncrementalBatch => ({
    v: 1,
    batchId: "selection",
    policyVersion: "p50-selection-v1",
    directory: h.sourceFrozen.directory,
    corpus: readIncrementalCorpus(h.sourceFrozen.directory)!,
    changeCount: 5,
    taskDoneEligible: false,
    lastExternalWriteAt: 0,
    activityLease: { generation: 0, lastActivityAt: 0 },
    limits: { autoActions: 2, generateRequests: 2, jobCostCapUsd: 10 },
  });
  return { host, batch, attempt, state };
}
it("source discovery→D fresh R/C only→save→E actual retire→raw restore, no model after first effect", async () => {
  const h = await setup(),
    x = sourceHost(h);
  h.gcSourceReview();
  const start = h.calls.length,
    gen = h.gen.mock.calls.length;
  const r = await x.host.handle(x.batch(), x.attempt);
  expect(r).toMatchObject({ kind: "settled", saved: 1, effects: 1 });
  expect(h.calls.slice(start)).toEqual(["rel/main", "judge/main"]);
  expect(h.gen).toHaveBeenCalledTimes(gen);
  expect(x.state.effects).toBe(1);
  const p = readIndex(h.dir).index.review!.suggestions.find((s) => s.revision?.action === "retire")!.revision!;
  expect(p.retireEvidence?.source).toEqual(h.source);
  expect(p.autoEligible).toBe(true);
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
  expect(fs.readFileSync(h.contextPath, "utf8")).toContain("status: superseded");
  expect((await restoreRevisionRaw(h.dir, { actionId: p.actionId }, h.auditDeps)).kind).toBe("restored");
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
});
it("two source candidates fully prepared/saved before E, first actual effect stops second write and all further models", async () => {
  const { h } = await setupMany(2),
    x = sourceHost(h),
    events: string[] = [],
    realSave = review.upsertRevisionSuggestion,
    realData = safeFs.replaceRevisionObserved;
  const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  index.review.suggestions = [];
  fs.writeFileSync(h.indexPath, JSON.stringify(index));
  const start = h.calls.length;
  let callsAtEffect = 0;
  vi.spyOn(review, "upsertRevisionSuggestion").mockImplementation(async (...args) => {
    const r = await realSave(...args);
    events.push(`save:${r}`);
    return r;
  });
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    if (args[0] === h.blocks) {
      events.push("data");
      expect(events.filter((x) => x === "save:saved").length).toBeGreaterThanOrEqual(2);
      callsAtEffect = h.calls.length;
      const count = h.calls.length;
      expect(count - start).toBeGreaterThanOrEqual(4);
    }
    return realData(...args);
  });
  // Ordinary pairs among four blocks also exist; all ordinary R occur before source R/C.
  const r = await x.host.handle(x.batch(), x.attempt);
  expect(r).toMatchObject({ kind: "settled", effects: 1 });
  expect(h.calls.length).toBe(callsAtEffect);
  expect(events.filter((e) => e === "data")).toHaveLength(1);
  expect(events.indexOf("data")).toBeGreaterThan(events.lastIndexOf("save:saved"));
  expect(x.state.effects).toBe(1);
});
it("legacy missing spec gives honest historical plain hint, zero fresh calls and zero auto effect", async () => {
  const h = await setup(),
    a = JSON.parse(fs.readFileSync(h.sourceAuditPath, "utf8"));
  delete a.generationRequest;
  fs.writeFileSync(h.sourceAuditPath, JSON.stringify(a));
  const x = sourceHost(h),
    start = h.calls.length;
  expect(await x.host.handle(x.batch(), x.attempt)).toMatchObject({ kind: "settled", saved: 1, effects: 0 });
  expect(h.calls).toHaveLength(start);
  const p = readIndex(h.dir).index.review!.suggestions.find((s) => s.revision?.action === "retire")!.revision!;
  expect(p.relation).toBeUndefined();
  expect(p.coverage).toBeUndefined();
  expect(p.retireEvidence).toBeUndefined();
  expect(p.autoEligible).toBe(false);
});
it("source user old + agent survivor excluded before quota/freezing and never dispatched for retire", async () => {
  const h = await setup("agent", {}, "user"),
    x = sourceHost(h),
    freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  const n = h.calls.length;
  await x.host.handle(x.batch(), x.attempt);
  expect(freeze.mock.calls.every(([, s]) => !(s.action === "retire" && s.target.id === "rules.002"))).toBe(true);
  expect(x.host.inspect().directories[0]!.sources).toEqual([]);
  expect(x.state.effects).toBe(0);
  // The ordinary mixed pair is still eligible for discovery, not source R/C.
  expect(h.calls.slice(n).filter((c) => c === "rel/main")).toHaveLength(2);
});
it("specified incompatible source policy rejects whole page, no dropped source downgrade/no models", async () => {
  const h = await setup(),
    x = sourceHost(h);
  // Stable binding identity is required, not a fresh object per access.
  const binding = { registry: h.registry, budgetMs: 3000, maxOutputTokens: 2048 };
  const host = createRevisionHost({
    client: h.client,
    binding: () => binding,
    isCurrent: () => true,
    canAttempt: () => true,
    autoEnabled: () => true,
    policyVersion: "incompatible",
    now: h.auditDeps.now,
    onAfterWrite: () => {},
  });
  const n = h.calls.length;
  expect((await host.handle(x.batch(), x.attempt)).reason).toBe("freeze-rejected");
  expect(h.calls).toHaveLength(n);
  expect(host.inspect().jobs).toEqual([]);
  expect(host.inspect().directories[0]!.sources[0]![1]).toBe("blocked-freeze");
});
it("2 sources +4 ordinary share <=14 full frozen actions and <=16 high-level calls; fixed source cursor progresses without review reorder", async () => {
  const { h } = await setupMany(3),
    x = sourceHost(h, false);
  const index = JSON.parse(fs.readFileSync(h.indexPath, "utf8"));
  index.review.suggestions = [];
  fs.writeFileSync(h.indexPath, JSON.stringify(index));
  const ask = vi.spyOn(h.client, "ask"),
    g = vi.spyOn(h.client, "generateRevision"),
    c = vi.spyOn(h.client, "judgeRevisionCoverage"),
    freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  const r = await x.host.handle(x.batch(), x.attempt);
  expect(r).toMatchObject({ kind: "settled", effects: 0 });
  expect(r.menuSize).toBe(14);
  expect(freeze.mock.calls).toHaveLength(r.menuSize!);
  expect(g).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls.length).toBe(10);
  expect(c.mock.calls.length).toBe(4);
  expect(ask.mock.calls.length + g.mock.calls.length + c.mock.calls.length).toBe(16);
  expect(x.host.inspect().directories[0]!.sources.map(([, s]) => s)).toEqual(["suggested", "suggested", "pending"]);
  const key = x.host.inspect().directories[0]!.key;
  const r2 = await x.host.handle(x.batch(), x.attempt);
  expect(r2.kind).toBe("settled");
  expect(x.host.inspect().directories[0]!.key).toBe(key);
  expect(x.host.inspect().directories[0]!.sources.map(([, s]) => s)).toEqual(["suggested", "suggested", "suggested"]);
});
it("stable 16-block pool visits every 120 pair once in <=30 external opportunities, no in-call continuation", async () => {
  const h = await hostFixture(16, {
    relation: () => ({ type: "choice", choice: "unrelated", probabilities: { unrelated: 0.99 }, confidence: 0.99 }),
  });
  for (let i = 0; i < 30; i++) {
    const before = h.calls.length,
      r = await h.host.handle(h.batch(), h.attempt);
    expect(r).toMatchObject({ kind: "settled", saved: 0 });
    expect(h.calls.length - before).toBe(8);
    expect(h.host.inspect().jobs).toHaveLength(i + 1);
  }
  expect(h.host.inspect().directories[0]!.ordinary).toHaveLength(120);
  expect(h.host.inspect().directories[0]!.ordinary.every(([, s]) => s === "attempted-none")).toBe(true);
  const n = h.calls.length;
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("empty-page");
  expect(h.calls).toHaveLength(n);
});
it("128 job guard capacity fails closed without eviction, reset retains live-client fences; disposal closes client first", async () => {
  const h = await hostFixture(2, {
    relation: () => ({ type: "choice", choice: "unrelated", probabilities: { unrelated: 0.99 }, confidence: 0.99 }),
  });
  for (let epoch = 1; epoch <= 128; epoch++)
    expect((await h.host.handle(h.batch(10, epoch), h.attempt)).kind).toBe("settled");
  const ids = h.host.inspect().jobs.map((j) => j.id),
    n = h.calls.length,
    freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  h.host.reset("session");
  expect((await h.host.handle(h.batch(10, 129), h.attempt)).reason).toBe("capacity");
  expect(freeze).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(n);
  expect(h.host.inspect().jobs.map((j) => j.id)).toEqual(ids);
  const dispose = vi.spyOn(h.client, "dispose");
  h.host.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(h.client.usage().budget?.disposed).toBe(true);
  expect(h.host.inspect().jobs).toEqual([]);
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("pending");
});
it("0 cap and global temporary budget denial remain dormant without claim or request", async () => {
  const h = await hostFixture(2),
    f = vi.spyOn(revision, "freezeRevisionInputsLocked");
  expect((await h.host.handle(h.batch(0), h.attempt)).reason).toBe("pending");
  h.state.admit = false;
  expect((await h.host.handle(h.batch(10), h.attempt)).reason).toBe("pending");
  expect(f).not.toHaveBeenCalled();
  expect(h.host.inspect().jobs).toEqual([]);
  expect(h.calls).toEqual([]);
  h.state.admit = true;
  expect((await h.host.handle(h.batch(), h.attempt)).saved).toBe(1);
});
it("8 directory snapshots are not evicted when a ninth directory arrives", async () => {
  const h = await hostFixture(1),
    dirs: string[] = [];
  try {
    for (let i = 0; i < 9; i++) {
      const dir = `${h.dir}-dir${i}`;
      dirs.push(dir);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.mkdirSync(join(dir, "blocks"), { mode: 0o700 });
      fs.copyFileSync(join(h.blocks, ".layout.json"), join(dir, "blocks/.layout.json"));
      fs.copyFileSync(join(h.blocks, "rules.001.md"), join(dir, "blocks/rules.001.md"));
      const { dev, ino } = safeFs.inspectDirNoFollow(dir),
        base = h.batch(),
        directory = { ...base.directory, realpath: dir, dev, ino },
        batch = { ...base, directory, corpus: readIncrementalCorpus(directory)! };
      expect((await h.host.handle(batch, h.attempt)).reason).toBe(i < 8 ? "empty-page" : "capacity");
    }
    expect(h.host.inspect().directories).toHaveLength(8);
    expect(h.host.inspect().directories[0]!.directory).toBe(dirs[0]);
    expect(h.calls).toEqual([]);
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("fresh reason suppression inserted during relation await stops generate/C barrier with shared owner predicate", async () => {
  const h = await hostFixture(2),
    real = h.registry.classify!;
  let count = 0;
  vi.spyOn(h.registry, "classify").mockImplementation(async (...args) => {
    const r = await real(...args);
    if (++count === 1)
      await withMemoryDirLock(h.dir, () =>
        writeGovernIndexLocked(h.dir, {
          ...readIndex(h.dir).index,
          review: {
            lastRunAt: "",
            corpusFp: "",
            suggestions: [],
            dismissed: [{ kind: "conflict", hashKey: "a+b", anchorKey: "rules.001+rules.002" }],
          },
        }),
      );
    return r;
  });
  expect((await h.host.handle(h.batch(), h.attempt)).saved).toBe(0);
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation"]);
  expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
  expect(h.host.inspect().directories[0]!.ordinary[0]![1]).toBe("dismissed");
});
it("same job generation slots stay at2 after repeated scheduler-like restarts/reset", async () => {
  const h = await hostFixture(5),
    g = vi.spyOn(h.client, "generateRevision");
  const first = await h.host.handle(h.batch(), h.attempt);
  expect(g).toHaveBeenCalledTimes(2);
  // Pin the SAME full menu across reset. New review hints may legitimately
  // create a different fixed pool/job; that is not same-D-job reentry.
  await withMemoryDirLock(h.dir, () => {
    const index = readIndex(h.dir).index;
    writeGovernIndexLocked(h.dir, { ...index, review: { ...index.review!, suggestions: [] } });
  });
  for (const reason of ["session", "tree", "abort"] as const) {
    h.host.reset(reason);
    expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  }
  expect(g).toHaveBeenCalledTimes(2);
  expect(h.host.inspect().jobs[0]).toMatchObject({ id: first.batchId, generateClaims: 2, state: "settled" });
});
it("invalid generated output consumes its irreversible slot then blocks job with no C publication or replay", async () => {
  const h = await hostFixture(2),
    real = h.registry.complete!;
  vi.spyOn(h.registry, "complete").mockImplementation(async (...args) => {
    const r = await real(...args);
    return { ...r, content: [{ type: "text", text: '{"delete":"rules.001"}' }] };
  });
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation", "generation"]);
  expect(h.host.inspect().jobs[0]).toMatchObject({ state: "blocked-job", generateClaims: 1 });
  expect(readIndex(h.dir).index.review?.suggestions ?? []).toEqual([]);
  h.host.reset("session");
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.calls).toHaveLength(3);
});
it("source restore during model await wins CAS; no saved retire/no data effect and no ordinary fallback", async () => {
  const h = await setup(),
    x = sourceHost(h),
    real = h.registry.classify!;
  const n = h.calls.length;
  vi.spyOn(h.registry as Required<Pick<typeof h.registry, "classify">>, "classify").mockImplementation(
    async (...args) => {
      const r = await real(...args);
      expect((await restoreRevisionRaw(h.dir, { actionId: h.source.actionId }, h.auditDeps)).kind).toBe("restored");
      return r;
    },
  );
  expect((await x.host.handle(x.batch(), x.attempt)).reason).toBe("blocked-job");
  expect(x.state.effects).toBe(0);
  expect(readIndex(h.dir).index.review!.suggestions.some((s) => s.revision?.action === "retire")).toBe(false);
  expect(fs.readFileSync(h.contextPath)).toEqual(h.oldBefore);
  expect(h.calls.slice(n).filter((c) => c.startsWith("gen"))).toEqual([]);
});
it("host never supplements selected first16 with block17 raw or model data", async () => {
  const h = await hostFixture(17, {
    relation: () => ({ type: "choice", choice: "unrelated", probabilities: { unrelated: 0.99 }, confidence: 0.99 }),
  });
  const batch = h.batch();
  expect(batch.corpus.candidates).toHaveLength(16);
  expect(batch.corpus.omittedCount).toBe(1);
  const read = vi.spyOn(safeFs, "readRegularBytes");
  expect((await h.host.handle(batch, h.attempt)).kind).toBe("settled");
  expect(read.mock.calls.some(([, name]) => name === "rules.017.md")).toBe(false);
  expect(JSON.stringify(h.calls)).not.toContain("rules.017");
});
it("E effect-unknown also invalidates through original callback and never resumes any model/write", async () => {
  const h = await setup(),
    x = sourceHost(h),
    realData = safeFs.replaceRevisionObserved,
    realSync = safeFs.fsyncDir;
  let applied = false,
    callsAtData = 0;
  vi.spyOn(safeFs, "replaceRevisionObserved").mockImplementation((...args) => {
    const r = realData(...args);
    if (args[0] === h.blocks && r.observation.kind === "applied") {
      applied = true;
      callsAtData = h.calls.length;
    }
    return r;
  });
  vi.spyOn(safeFs, "fsyncDir").mockImplementation((dir) => {
    if (applied && dir === h.blocks) throw Error("offline post-effect fsync fault");
    return realSync(dir);
  });
  const r = await x.host.handle(x.batch(), x.attempt);
  expect(r).toMatchObject({ kind: "settled", effects: 1 });
  expect(x.state.effects).toBe(1);
  expect(h.calls).toHaveLength(callsAtData);
  expect(fs.readFileSync(h.contextPath, "utf8")).toContain("status: superseded");
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
  const p = readIndex(h.dir).index.review!.suggestions.find((s) => s.revision?.action === "retire")!.revision!;
  const a = await withMemoryDirLock(h.dir, () => h.freshAudit().readActionLocked(p.batchId, p.actionId));
  expect(a).toMatchObject({ kind: "ok", audit: { state: "commit-unknown" } });
});
it("same binding object with in-place registry remap is revoked before second direction/save", async () => {
  const h = await hostFixture(2),
    real = h.registry.classify!;
  const old = h.binding.registry;
  vi.spyOn(h.registry, "classify").mockImplementation(async (...args) => {
    const r = await real(...args);
    h.binding.registry = { ...old };
    return r;
  });
  expect((await h.host.handle(h.batch(), h.attempt)).reason).toBe("blocked-job");
  expect(h.calls.map((c) => c.kind)).toEqual(["relation"]);
  expect(readIndex(h.dir).index.review?.suggestions ?? []).toEqual([]);
});
it("first C source scan unavailable stays pending; same raw/epoch after chmod recovery discovers and retires real source", async () => {
  const h = await setup(),
    x = sourceHost(h);
  h.gcSourceReview();
  const batch = x.batch(),
    oldBefore = fs.readFileSync(h.contextPath),
    successorBefore = fs.readFileSync(h.targetPath),
    calls = h.calls.length;
  fs.chmodSync(h.sourceAuditPath, 0o644);
  expect(await withMemoryDirLock(h.dir, () => h.freshAudit().listRetireSourceHintsLocked!())).toMatchObject({
    kind: "unavailable",
  });
  const freeze = vi.spyOn(revision, "freezeRevisionInputsLocked");
  const first = await x.host.handle(batch, x.attempt);
  expect(x.host.inspect()).toMatchObject({ jobs: [], directories: [], pendingSources: [h.dir] });
  expect(freeze).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(calls);
  fs.chmodSync(h.sourceAuditPath, 0o600);
  expect(await withMemoryDirLock(h.dir, () => h.freshAudit().listRetireSourceHintsLocked!())).toMatchObject({
    kind: "ok",
    refs: [{ source: h.source }],
  });
  expect(fs.readFileSync(h.contextPath)).toEqual(oldBefore);
  expect(fs.readFileSync(h.targetPath)).toEqual(successorBefore);
  // No raw/epoch/new policy is required to recover the unavailable lane.
  const second = await x.host.handle(batch, x.attempt);
  expect(first).toMatchObject({ kind: "cap-reached", reason: "pending" });
  expect(second).toMatchObject({ kind: "settled", saved: 1, effects: 1 });
  expect(x.host.inspect().pendingSources).toEqual([]);
  expect(x.host.inspect().jobs).toHaveLength(1);
  expect(h.calls.slice(calls)).toEqual(["rel/main", "judge/main"]);
  expect(x.state.effects).toBe(1);
  expect(fs.readFileSync(h.contextPath, "utf8")).toContain("status: superseded");
  expect(fs.readFileSync(h.targetPath)).toEqual(successorBefore);
});
it("pending source scans share the eight-directory bound with complete snapshots and are never evicted to admit a ninth", async () => {
  const h = await hostFixture(1),
    dirs: string[] = [];
  try {
    for (let i = 0; i < 9; i++) {
      const dir = `${h.dir}-scan${i}`;
      dirs.push(dir);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.mkdirSync(join(dir, "blocks"), { mode: 0o700 });
      fs.copyFileSync(join(h.blocks, ".layout.json"), join(dir, "blocks/.layout.json"));
      fs.copyFileSync(join(h.blocks, "rules.001.md"), join(dir, "blocks/rules.001.md"));
      if (i >= 4 && i < 8) {
        fs.mkdirSync(join(dir, "blocks/.jev"), { mode: 0o700 });
        fs.mkdirSync(join(dir, "blocks/.jev/revisions"), { mode: 0o755 });
      }
      const { dev, ino } = safeFs.inspectDirNoFollow(dir),
        base = h.batch(),
        directory = { ...base.directory, realpath: dir, dev, ino },
        batch = { ...base, directory, corpus: readIncrementalCorpus(directory)! };
      expect((await h.host.handle(batch, h.attempt)).reason).toBe(
        i < 4 ? "empty-page" : i < 8 ? "pending" : "capacity",
      );
    }
    expect(h.host.inspect().directories).toHaveLength(4);
    expect(h.host.inspect().pendingSources).toEqual(dirs.slice(4, 8));
    expect(h.host.inspect().jobs).toEqual([]);
    expect(h.calls).toEqual([]);
    // An eventual complete *empty* scan is legitimate, unlike unavailable.
    const dir = dirs[4]!;
    fs.chmodSync(join(dir, "blocks/.jev/revisions"), 0o700);
    const { dev, ino } = safeFs.inspectDirNoFollow(dir),
      base = h.batch(),
      directory = { ...base.directory, realpath: dir, dev, ino };
    expect(
      (await h.host.handle({ ...base, directory, corpus: readIncrementalCorpus(directory)! }, h.attempt)).reason,
    ).toBe("empty-page");
    expect(h.host.inspect().directories).toHaveLength(5);
    expect(h.host.inspect().pendingSources).toEqual(dirs.slice(5, 8));
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});
