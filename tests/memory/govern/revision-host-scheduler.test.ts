/** Real scheduler/FakeClock -> host -> original single A/B client -> D/C/review/E.
 * No hand-authored IncrementalAttemptContext and no production settings/wire. */
import * as fs from "node:fs";
import { expect, it, vi, afterEach } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import {
  createIncrementalScheduler,
  type IncrementalBatch,
  type IncrementalAttemptContext,
} from "../../../src/memory/govern/incremental.js";
import { createRevisionHost, type RevisionHostResult } from "../../../src/memory/govern/revision-host.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { readIncrementalCorpus } from "../../../src/memory/govern/incremental-corpus.js";
import { hostFixture } from "./revision-host-helpers.js";
import { setup } from "./revision-retire-helpers.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function connect(
  host: ReturnType<typeof createRevisionHost>,
  batch: () => IncrementalBatch,
  options: { current?: () => boolean; beforeAdmission?: (index: number) => void; cap?: number } = {},
) {
  const clock = new FakeClock();
  const activity = {
    generation: 0,
    lastActivityAt: 0,
    running: false,
    toolsInFlight: 0,
    liveIdle: true,
    hasPendingMessages: false,
  };
  const admissions: boolean[] = [],
    results: RevisionHostResult[] = [],
    handled: { batch: IncrementalBatch; attempt: IncrementalAttemptContext }[] = [];
  const port = { snapshot: () => ({ ...activity }) };
  const scheduler = createIncrementalScheduler({
    settings: {
      ...DEFAULT_MEMORY_SETTINGS.incremental,
      enabled: true,
      changeThreshold: 1,
      quietMs: 10,
      idleMs: 2,
      cooldownMs: 100,
    },
    jobCostCapUsd: options.cap ?? 10,
    clock,
    activity: () => port,
    isCurrent: () => options.current?.() ?? true,
    readCorpus: () => batch().corpus,
    canAttempt: (b) => {
      options.beforeAdmission?.(admissions.length);
      const ok = host.canAttempt(b);
      admissions.push(ok);
      return ok;
    },
    handler: async (b, attempt) => {
      handled.push({ batch: b, attempt });
      const r = await host.handle(b, attempt);
      results.push(r);
      return r;
    },
  });
  stops.push(() => scheduler.stop());
  const natural = () => {
    const b = batch();
    scheduler.externalWrite(b.directory, b.corpus, "external");
    clock.advance(10);
  };
  const settled = async () => {
    await vi.waitFor(() => expect(results).toHaveLength(1));
    await vi.waitFor(() => expect(scheduler.inspect(batch().directory)?.state).not.toBe("running"));
  };
  return { clock, activity, admissions, results, handled, scheduler, natural, settled };
}
it("real scheduler rechecks the owned batch [true,true], generates and saves through A/B D/C instead of running-state self-denial", async () => {
  const h = await hostFixture(2),
    x = connect(h.host, h.batch),
    g = vi.spyOn(h.client, "generateRevision"),
    c = vi.spyOn(h.client, "judgeRevisionCoverage");
  x.natural();
  await x.settled();
  expect(x.admissions).toEqual([true, true]);
  expect(x.results[0]).toMatchObject({ kind: "settled", reason: "done", saved: 1, effects: 0 });
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation", "generation", "coverage"]);
  expect(g).toHaveBeenCalledTimes(1);
  expect(c).toHaveBeenCalledTimes(1);
  expect(x.handled[0]!.batch.limits.jobCostCapUsd).toBe(10);
  expect(Object.isFrozen(x.handled[0]!.batch.limits)).toBe(true);
  expect(g.mock.calls[0]![0]).toMatchObject({ jobId: x.results[0]!.batchId, jobCostCapUsd: 10 });
  expect(h.host.inspect().jobs[0]).toMatchObject({ state: "settled", generateClaims: 1 });
  expect(x.scheduler.inspect(h.batch().directory)).toMatchObject({ state: "cooldown", dormant: false });
  const p = readIndex(h.dir).index.review!.suggestions[0]!.revision!;
  expect(p.generatedBody).toBeDefined();
  expect(p.autoEligible).toBe(false);
  expect(fs.existsSync(`${h.blocks}/.jev/revisions/${p.batchId}/${p.actionId}/before.md`)).toBe(true);
});
it("real scheduler owned recheck still respects changed budget [true,false]: 2R, zeroG/slot0, blocked job and dormant", async () => {
  const h = await hostFixture(2),
    x = connect(h.host, h.batch, {
      beforeAdmission: (index) => {
        if (index === 1) h.state.admit = false;
      },
    });
  x.natural();
  await x.settled();
  expect(x.admissions).toEqual([true, false]);
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation"]);
  expect(h.host.inspect().jobs[0]).toMatchObject({ state: "blocked-job", generateClaims: 0 });
  expect(x.results[0]!.reason).toBe("blocked-job");
  expect(x.scheduler.inspect(h.batch().directory)).toMatchObject({
    state: "quiet-wait",
    pendingCount: 1,
    dormant: true,
  });
  expect(x.clock.pendingTimers).toBe(0);
  expect(readIndex(h.dir).index.review?.suggestions ?? []).toEqual([]);
});
it("owned recheck grants only the exact active batch, never concurrent handler/new batch admission", async () => {
  const h = await hostFixture(2),
    x = connect(h.host, h.batch),
    real = h.registry.classify;
  let release: (() => void) | undefined;
  vi.spyOn(h.registry, "classify").mockImplementation(async (...args) => {
    if (!release)
      await new Promise<void>((r) => {
        release = r;
      });
    return real(...args);
  });
  x.natural();
  await vi.waitFor(() => expect(release).toBeDefined());
  const owned = x.handled[0]!;
  expect(h.host.canAttempt(owned.batch)).toBe(true);
  expect(h.host.canAttempt({ ...owned.batch })).toBe(false);
  expect(await h.host.handle(owned.batch, owned.attempt)).toMatchObject({ reason: "running" });
  expect(x.handled).toHaveLength(1);
  release!();
  await x.settled();
  expect(x.admissions).toEqual([true, true]);
  expect(h.calls.map((c) => c.kind)).toEqual(["relation", "relation", "generation", "coverage"]);
});
it("owned recheck remains epoch/lease-bound and cannot turn stale ownership into a new admission", async () => {
  const h = await hostFixture(2),
    x = connect(h.host, h.batch, { current: () => h.state.current }),
    real = h.registry.classify;
  let release: (() => void) | undefined;
  vi.spyOn(h.registry, "classify").mockImplementation(async (...args) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return real(...args);
  });
  x.natural();
  await vi.waitFor(() => expect(release).toBeDefined());
  const b = x.handled[0]!.batch;
  x.activity.generation++;
  expect(h.host.canAttempt(b)).toBe(false);
  h.state.current = false;
  expect(h.host.canAttempt(b)).toBe(false);
  release!();
  await x.settled();
  expect(h.calls.map((c) => c.kind)).toEqual(["relation"]);
  expect(h.host.inspect().jobs[0]).toMatchObject({ state: "blocked-job", generateClaims: 0 });
});
it("real scheduler source lane reaches fresh A/B D/C/review/E actual retire without generation or manual attempt context", async () => {
  const h = await setup();
  h.gcSourceReview();
  const binding = { registry: h.registry, budgetMs: 3000, maxOutputTokens: 2048 };
  let effects = 0;
  let x: ReturnType<typeof connect>;
  const host = createRevisionHost({
    client: h.client,
    binding: () => binding,
    isCurrent: () => h.state.current,
    canAttempt: () => true,
    autoEnabled: () => true,
    policyVersion: h.sourceFrozen.policyVersion,
    now: h.auditDeps.now,
    onAfterWrite: () => {
      effects++;
      x.activity.generation++;
    },
  });
  const batch = (): IncrementalBatch => ({
    v: 1,
    batchId: "selection",
    policyVersion: "p50-selection-v1",
    directory: h.sourceFrozen.directory,
    corpus: readIncrementalCorpus(h.sourceFrozen.directory)!,
    changeCount: 1,
    taskDoneEligible: false,
    lastExternalWriteAt: 0,
    activityLease: { generation: 0, lastActivityAt: 0 },
    limits: { autoActions: 2, generateRequests: 2, jobCostCapUsd: 10 },
  });
  x = connect(host, batch);
  const start = h.calls.length,
    g = h.gen.mock.calls.length;
  x.natural();
  await vi.waitFor(() => expect(x.results).toHaveLength(1));
  expect(x.results[0]).toMatchObject({ kind: "settled", saved: 1, effects: 1 });
  expect(effects).toBe(1);
  expect(h.calls.slice(start)).toEqual(["rel/main", "judge/main"]);
  expect(h.gen).toHaveBeenCalledTimes(g);
  expect(fs.readFileSync(h.contextPath, "utf8")).toContain("status: superseded");
  expect(fs.readFileSync(h.targetPath)).toEqual(h.successorAfter);
});
it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "scheduler invalid/unpaid explicit budget %s freezes safe0 and never admits host",
  async (cap) => {
    const h = await hostFixture(2),
      x = connect(h.host, h.batch, { cap });
    x.natural();
    expect(x.admissions).toEqual([false]);
    expect(x.handled).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(x.scheduler.inspect(h.batch().directory)).toMatchObject({ dormant: true, pendingCount: 1 });
    expect(x.clock.pendingTimers).toBe(0);
  },
);
it("first unavailable source scan parks the real scheduler without polling; permission recovery needs only the next natural opportunity", async () => {
  const h = await setup();
  h.gcSourceReview();
  const binding = { registry: h.registry, budgetMs: 3000, maxOutputTokens: 2048 };
  let x: ReturnType<typeof connect>;
  const host = createRevisionHost({
    client: h.client,
    binding: () => binding,
    isCurrent: () => h.state.current,
    canAttempt: () => true,
    autoEnabled: () => true,
    policyVersion: h.sourceFrozen.policyVersion,
    now: h.auditDeps.now,
    onAfterWrite: () => {
      x.activity.generation++;
    },
  });
  const batch: IncrementalBatch = {
    v: 1,
    batchId: "selection",
    policyVersion: "p50-selection-v1",
    directory: h.sourceFrozen.directory,
    corpus: readIncrementalCorpus(h.sourceFrozen.directory)!,
    changeCount: 1,
    taskDoneEligible: false,
    lastExternalWriteAt: 0,
    activityLease: { generation: 0, lastActivityAt: 0 },
    limits: { autoActions: 2, generateRequests: 2, jobCostCapUsd: 10 },
  };
  x = connect(host, () => batch);
  const calls = h.calls.length;
  fs.chmodSync(h.sourceAuditPath, 0o644);
  x.natural();
  await x.settled();
  expect(x.results[0]).toMatchObject({ kind: "cap-reached", reason: "pending" });
  expect(host.inspect()).toMatchObject({ jobs: [], directories: [], pendingSources: [h.dir] });
  expect(x.scheduler.inspect(batch.directory)).toMatchObject({ dormant: true, pendingCount: 1 });
  expect(x.clock.pendingTimers).toBe(0);
  expect(h.calls).toHaveLength(calls);
  x.clock.advance(1000);
  expect(x.results).toHaveLength(1);
  expect(h.calls).toHaveLength(calls);
  fs.chmodSync(h.sourceAuditPath, 0o600);
  expect(x.results).toHaveLength(1);
  x.natural();
  await vi.waitFor(() => expect(x.results).toHaveLength(2));
  expect(x.results[1]).toMatchObject({ kind: "settled", saved: 1, effects: 1 });
  expect(host.inspect().pendingSources).toEqual([]);
  expect(host.inspect().jobs).toHaveLength(1);
  expect(h.calls.slice(calls)).toEqual(["rel/main", "judge/main"]);
  expect(fs.readFileSync(h.contextPath, "utf8")).toContain("status: superseded");
});
