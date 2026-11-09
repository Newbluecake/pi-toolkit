import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSweepRunner, readArchiveIndex, restoreBlock } from "../../../src/memory/govern/sweep.js";
import { createBlockLocked, readCorpus } from "../../../src/memory/blocks/store.js";
import { readGovernBlock } from "../../../src/memory/govern/supersede.js";
import { serializeBlock } from "../../../src/memory/blocks/format.js";
import * as locks from "../../../src/memory/lock.js";
import { MemoryError } from "../../../src/memory/paths.js";
import { createGovernanceSignals, type BudgetObservation } from "../../../src/memory/govern/signals.js";
import * as planModule from "../../../src/memory/govern/sweep-plan.js";
const roots: string[] = [];
const now = new Date("2026-11-06T00:00:00Z");
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sweep-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
  return dir;
}
function expired(dir: string) {
  return createBlockLocked(join(dir, "blocks"), "quota", { authority: "agent", expires: "2026-11-01" }, "expired", now);
}
function runner(extra: Partial<Parameters<typeof createSweepRunner>[0]> = {}) {
  return createSweepRunner({ enabled: true, now: () => now.getTime(), ...extra });
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("archives and notifies, origin sweep is inert; restore uses mapping", async () => {
  const d = setup(),
    b = expired(d),
    notices: string[] = [],
    origins: string[] = [];
  const r = runner({ notify: (m) => notices.push(m), onAfterWrite: (o) => origins.push(o) });
  const result = await r.runSweep(d, "write");
  expect(result.archived).toEqual([b.id]);
  expect(result.operations).toBeLessThanOrEqual(50);
  expect(readCorpus(join(d, "blocks")).blocks).toHaveLength(0);
  expect(notices[0]).toContain("archived 1");
  expect(origins).toEqual(["sweep"]);
  for (const origin of ["sweep", "revision", "p50-auto"])
    expect((await r.runSweep(d, "write", undefined, origin)).stopped).toBe("self");
  expect(await restoreBlock(d, b.id)).toContain("restored:");
  expect(readGovernBlock(d, b.id).meta.status).toBe("active");
  expect(readArchiveIndex(d)).toEqual({});
});
it("archive collisions, ambiguity, explicit revision storage name and active conflict", async () => {
  const d = setup(),
    b = expired(d);
  mkdirSync(join(d, "blocks/archive"));
  writeFileSync(join(d, "blocks/archive", `${b.id}.md`), b.raw);
  writeFileSync(
    join(d, "blocks/archive/index.json"),
    JSON.stringify({ [`${b.id}.md`]: { id: b.id, archivedAt: now.toISOString(), reason: "write" } }),
  );
  await runner().runSweep(d, "write");
  expect(Object.keys(readArchiveIndex(d))).toEqual([`${b.id}.md`, `${b.id}.r1.md`]);
  await expect(restoreBlock(d, b.id)).rejects.toThrow("ambiguous");
  expect(await restoreBlock(d, `${b.id}.r1`)).toContain("restored:");
  await expect(restoreBlock(d, b.id)).rejects.toThrow("conflict");
  expect(Object.keys(readArchiveIndex(d))).toEqual([`${b.id}.md`]);
});
it("cleans mapping-before-rename crash and heals rename-before-status crash", async () => {
  const d = setup(),
    b = expired(d);
  mkdirSync(join(d, "blocks/archive"));
  writeFileSync(join(d, "blocks/archive", `${b.id}.r1.md`), b.raw);
  writeFileSync(
    join(d, "blocks/archive/index.json"),
    JSON.stringify({
      "quota.999.md": { id: "quota.999", archivedAt: now.toISOString(), reason: "write" },
      [`${b.id}.r1.md`]: { id: b.id, archivedAt: now.toISOString(), reason: "write" },
    }),
  );
  await runner().runSweep(d, "startup");
  expect(readArchiveIndex(d)).not.toHaveProperty("quota.999.md");
  expect(readFileSync(join(d, "blocks/archive", `${b.id}.r1.md`), "utf8")).toContain("status: archived");
});
it("2000 corpus is bounded by real file operations and leaves remainder", async () => {
  const d = setup();
  for (let n = 1; n <= 2000; n++)
    writeFileSync(
      join(d, "blocks", `quota.${String(n).padStart(3, "0")}.md`),
      serializeBlock(
        {
          kind: "block",
          authority: "agent",
          status: "active",
          version: 1,
          created: now.toISOString(),
          updated: now.toISOString(),
          expires: "2026-11-01",
        },
        "expired",
      ),
    );
  const started = Date.now();
  const result = await runner({ now: Date.now }).runSweep(d, "write");
  const elapsed = Date.now() - started;
  console.log(
    `[P5a corpus=2000] elapsed=${elapsed}ms operations=${result.operations} archived=${result.archived.length}`,
  );
  expect(elapsed).toBeLessThan(1000);
  expect(result.operations).toBeLessThanOrEqual(50);
  expect(result.archived.length).toBeGreaterThan(0);
  expect(result.archived.length).toBeLessThan(50);
  expect(readCorpus(join(d, "blocks")).blocks.length).toBe(2000 - result.archived.length);
});
it("off, gate denied and aborted have zero disk effects", async () => {
  for (const mode of ["off", "gate", "abort"]) {
    const d = setup(),
      b = expired(d);
    const result = await runner({
      enabled: mode !== "off",
      ...(mode === "gate"
        ? {
            gate: {
              capture() {},
              check() {
                return { ok: false as const, reason: "locked" };
              },
            },
          }
        : {}),
    }).runSweep(d, "write", mode === "abort" ? AbortSignal.abort() : undefined);
    expect(result.operations).toBe(0);
    expect(readFileSync(join(d, "blocks", `${b.id}.md`), "utf8")).toBe(b.raw);
    expect(readdirSync(join(d, "blocks"))).toEqual([".layout.json", `${b.id}.md`]);
  }
});
it("wall budget and mid-operation shutdown stop without corrupting mapped archive", async () => {
  const d = setup();
  expired(d);
  let ticks = 0;
  const budget = await runner({ now: () => now.getTime() + ++ticks * 400 }).runSweep(d, "write");
  expect(budget.stopped).toContain("budget");
  const abort = new AbortController();
  let checks = 0;
  const stopped = await runner({
    gate: {
      capture() {},
      check() {
        if (++checks === 6) abort.abort();
        return { ok: true as const };
      },
    },
  }).runSweep(d, "reload", abort.signal);
  expect(stopped.stopped).toContain("ABORTED");
  await runner().runSweep(d, "reload");
  expect(existsSync(join(d, "blocks/archive/index.json"))).toBe(true);
});
it("reentrant signals merge once and yield is invoked without timers", async () => {
  const d = setup();
  expired(d);
  let yields = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const r = runner({
    yield: async () => {
      yields++;
      if (yields === 1) await held;
    },
  });
  const a = r.runSweep(d, "write");
  const b = r.runSweep(d, "push");
  r.runSweep(d, "release");
  release();
  await Promise.all([a, b]);
  expect(yields).toBe(4);
});
it("admitted budget observations bypass only the corpus debounce and use current render statistics", async () => {
  const d = setup();
  createBlockLocked(join(d, "blocks"), "rules", { authority: "user", scope: "global" }, "rule", now);
  const r = runner({ render: { residentBytes: 0, residentBudget: 100, indexOverflow: false } });
  expect((await r.runSweep(d, "write")).suggestions).toBe(0);
  expect((await r.runSweep(d, "budget")).stopped).toBe("unchanged");
  const result = await r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 0,
    residentBudget: 100,
    indexOverflow: true,
  });
  expect(result.stopped).toBe("done");
  expect(result.suggestions).toBe(1);
  expect((await r.runSweep(d, "write")).stopped).toBe("unchanged");
});

it("keeps an admitted budget observation when a later event coalesces into the trailing pass", async () => {
  const d = setup();
  createBlockLocked(join(d, "blocks"), "rules", { authority: "user", scope: "global" }, "rule", now);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let yields = 0;
  const r = runner({
    yield: async () => {
      if (++yields === 1) await held;
    },
  });
  const first = r.runSweep(d, "write");
  const budget = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 0,
    residentBudget: 100,
    indexOverflow: true,
  });
  r.runSweep(d, "push");
  release();
  expect((await first).suggestions).toBe(0);
  expect((await budget).suggestions).toBe(1);
});

it("R1: budget arriving during the trailing pass is not settled by the old pass and can retry", async () => {
  const d = setup();
  createBlockLocked(join(d, "blocks"), "rules", { authority: "user", scope: "global" }, "rule", now);
  let releaseFirst = () => {},
    releaseTail = () => {},
    tailStarted = () => {};
  const firstHold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const tailHold = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const tailReady = new Promise<void>((resolve) => {
    tailStarted = resolve;
  });
  let yields = 0;
  const r = runner({
    yield: async () => {
      yields++;
      if (yields === 1) await firstHold;
      if (yields === 2) {
        tailStarted();
        await tailHold;
      }
    },
  });
  const signals = createGovernanceSignals();
  const plans = vi.spyOn(planModule, "planSweep");
  const observation = (budget: number): BudgetObservation => ({
    identity: { realpath: d, dev: 1, ino: 2 },
    stats: {
      corpusFingerprint: "corpus",
      localToday: "2026-11-06",
      policyVersion: "v1",
      resident: { inputFingerprint: "resident", usedBytes: 200, budgetBytes: budget, over: true },
      index: { inputFingerprint: "index", limitBytes: 2048, omittedCount: 0, over: false },
    },
  });
  const first = r.runSweep(d, "write");
  const a = observation(100);
  signals.observeBudget(a);
  const batchA = signals.consumeBudgets(a.identity, { external: false });
  const tail = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 100,
    indexOverflow: false,
  });
  releaseFirst();
  await tailReady;
  const b = observation(50);
  signals.observeBudget(b);
  const batchB = signals.consumeBudgets(b.identity, { external: false });
  const skipped = await r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 50,
    indexOverflow: false,
  });
  expect(skipped.stopped).toBe("not-executed");
  signals.settleBudgets(batchB, skipped.stopped === "done");
  expect(signals.consumeBudgets(b.identity, { external: false })).toEqual([]);
  releaseTail();
  expect((await first).stopped).toBe("done");
  const resultA = await tail;
  expect(resultA.stopped).toBe("done");
  expect(plans.mock.calls.map((call) => [call[4], call[5]?.residentBudget])).toEqual([
    ["write", undefined],
    ["budget", 100],
  ]);
  signals.settleBudgets(batchA, true);
  const retry = signals.consumeBudgets(b.identity, { external: true });
  expect(retry).toHaveLength(1);
  expect(retry[0]?.observation.stats.resident.budgetBytes).toBe(50);
  expect(
    (
      await r.runSweep(d, "budget", undefined, undefined, {
        residentBytes: 200,
        residentBudget: 50,
        indexOverflow: false,
      })
    ).stopped,
  ).toBe("done");
  signals.settleBudgets(retry, true);
  expect(plans.mock.calls.map((call) => [call[4], call[5]?.residentBudget])).toEqual([
    ["write", undefined],
    ["budget", 100],
    ["budget", 50],
  ]);
  plans.mockRestore();
  expect(signals.consumeBudgets(b.identity, { external: true })).toEqual([]);
});

it("R1: a new event during the trailing pass is dormant, not attributed to that pass", async () => {
  const d = setup();
  let releaseFirst = () => {},
    releaseTail = () => {},
    tailStarted = () => {};
  const firstHold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const tailHold = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const tailReady = new Promise<void>((resolve) => {
    tailStarted = resolve;
  });
  let yields = 0;
  const r = runner({
    yield: async () => {
      if (++yields === 1) await firstHold;
      else if (yields === 2) {
        tailStarted();
        await tailHold;
      }
    },
  });
  const signals = createGovernanceSignals();
  const first = r.runSweep(d, "write");
  const tail = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 100,
    indexOverflow: false,
  });
  releaseFirst();
  await tailReady;
  signals.markSignal("release", { success: true, readOnly: false });
  const events = signals.consumeSignals({})!;
  const skipped = await r.runSweep(d, "release");
  expect(skipped.stopped).toBe("not-executed");
  signals.deferSignals(events);
  expect(signals.consumeSignals({})).toBeUndefined();
  releaseTail();
  await Promise.all([first, tail]);
  expect(signals.consumeSignals({ external: true })).toEqual(["release"]);
});

it("R1: superseded queued budgets cannot receive another queued budget's result", async () => {
  const d = setup();
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let yields = 0;
  const r = runner({
    yield: async () => {
      if (++yields === 1) await hold;
    },
  });
  const first = r.runSweep(d, "write");
  const old = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 100,
    indexOverflow: false,
  });
  const current = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 50,
    indexOverflow: false,
  });
  expect((await old).stopped).toBe("not-executed");
  release();
  expect((await first).stopped).toBe("done");
  expect((await current).stopped).toBe("done");
});

it.each(["first-fails", "tail-fails"])("R1: independent pass outcomes %s", async (mode) => {
  const d = setup();
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let yields = 0,
    locksCalled = 0;
  const original = locks.withMemoryDirLock;
  const spy = vi.spyOn(locks, "withMemoryDirLock").mockImplementation((...args) => {
    locksCalled++;
    if ((mode === "first-fails" && locksCalled === 1) || (mode === "tail-fails" && locksCalled === 2))
      return Promise.reject(new MemoryError("memory dir busy"));
    return original(...args);
  });
  const r = runner({
    yield: async () => {
      if (++yields === 1) await hold;
    },
  });
  const first = r.runSweep(d, "write");
  const tail = r.runSweep(d, "budget", undefined, undefined, {
    residentBytes: 200,
    residentBudget: 50,
    indexOverflow: true,
  });
  release();
  const [a, b] = await Promise.all([first, tail]);
  expect(a.stopped).toBe(mode === "first-fails" ? "memory dir busy" : "done");
  expect(b.stopped).toBe(mode === "tail-fails" ? "memory dir busy" : "done");
  spy.mockRestore();
});

it("busy lock is abandoned instead of retrying a sweep", async () => {
  const d = setup();
  expired(d);
  const spy = vi.spyOn(locks, "withMemoryDirLock").mockRejectedValueOnce(new MemoryError("memory dir busy"));
  const result = await runner().runSweep(d, "write");
  expect(result.stopped).toContain("busy");
  expect(result.operations).toBe(0);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

it("continuous external revisions fail CAS without spinning, then unchanged signal is suppressed", async () => {
  const d = setup();
  const blocks = Array.from({ length: 20 }, () => expired(d));
  let checks = 0;
  const diag: string[] = [];
  const gate = {
    capture() {},
    check() {
      checks++;
      if (existsSync(join(d, ".lock")))
        for (const b of blocks)
          writeFileSync(join(d, "blocks", `${b.id}.md`), b.raw.replace("expired", `external revision ${checks}`));
      return { ok: true as const };
    },
  };
  const r = runner({ gate, diag: (m) => diag.push(m) });
  const result = await r.runSweep(d, "write");
  expect(result.stopped).toBe("no-progress");
  expect(result.archived).toEqual([]);
  expect(checks).toBeLessThan(100);
  expect(diag[0]).toContain("no progress");
  expect((await r.runSweep(d, "write")).stopped).toBe("unchanged");
});
it("shutdown delivered during a real yield stops between archive operations", async () => {
  const d = setup();
  Array.from({ length: 3 }, () => expired(d));
  const abort = new AbortController();
  const result = await runner({ yield: async () => abort.abort() }).runSweep(d, "reload", abort.signal);
  expect(result.archived).toHaveLength(1);
  expect(result.stopped).toContain("ABORTED");
  expect(readCorpus(join(d, "blocks")).blocks).toHaveLength(2);
});
it("grandfathered oversize agent can archive/restore without truncating its body", async () => {
  const d = setup();
  const body = "存量".repeat(800);
  writeFileSync(
    join(d, "blocks/quota.007.md"),
    serializeBlock(
      {
        kind: "block",
        authority: "agent",
        status: "active",
        version: 1,
        created: now.toISOString(),
        updated: now.toISOString(),
        expires: "2000-01-01",
      },
      body,
      { allowOversize: true },
    ),
  );
  expect((await runner().runSweep(d, "write")).archived).toEqual(["quota.007"]);
  await restoreBlock(d, "quota.007");
  expect(readGovernBlock(d, "quota.007").body).toBe(body);
});

it("archive storage names exhausted through r999 skip without overwriting the source or archives", async () => {
  const d = setup(),
    b = expired(d),
    archive = join(d, "blocks/archive");
  mkdirSync(archive);
  const names = [`${b.id}.md`, ...Array.from({ length: 999 }, (_, i) => `${b.id}.r${i + 1}.md`)];
  for (const name of names) writeFileSync(join(archive, name), `occupied:${name}`);
  const diagnostics: string[] = [];
  const result = await runner({ diag: (message) => diagnostics.push(message) }).runSweep(d, "write");
  expect(result.archived).toEqual([]);
  expect(result.operations).toBe(0);
  expect(diagnostics).toContain("archive name exhaustion");
  expect(readFileSync(join(d, "blocks", `${b.id}.md`), "utf8")).toBe(b.raw);
  expect(readdirSync(archive).sort()).toEqual([...names].sort());
  for (const name of names) expect(readFileSync(join(archive, name), "utf8")).toBe(`occupied:${name}`);
  expect(existsSync(join(archive, "index.json"))).toBe(false);
});

it("sweep updates only its own persisted clock and fingerprint, never semantic review state", async () => {
  const d = setup();
  createBlockLocked(join(d, "blocks"), "rule", { authority: "user", expires: "2020-01-01" }, "rule", now);
  const { readIndex, writeIndexPatch } = await import("../../../src/memory/jev/index-store.js");
  const original = {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    corpusFp: "semantic-fingerprint",
    suggestions: [],
    dismissed: [],
  };
  await writeIndexPatch(d, { review: original });
  await runner().runSweep(d, "startup");
  const after = readIndex(d).index.review!;
  expect(after.lastRunAt).toBe(original.lastRunAt);
  expect(after.corpusFp).toBe(original.corpusFp);
  expect(after.sweepLastRunAt).toBe(now.toISOString());
  expect(after.sweepCorpusFp).toBeTruthy();
  expect(after.suggestions.map((s) => s.kind)).toContain("expired-user");
  await writeIndexPatch(d, {
    review: { ...original, lastRunAt: "2026-11-07T00:00:00.000Z", corpusFp: "new-semantic" },
  });
  expect(readIndex(d).index.review).toMatchObject({
    sweepLastRunAt: after.sweepLastRunAt,
    sweepCorpusFp: after.sweepCorpusFp,
    corpusFp: "new-semantic",
  });
});

it("never rewrites archived historical oversized metadata during recovery or restore", async () => {
  const d = setup();
  mkdirSync(join(d, "blocks/archive"));
  const name = "old.001.md";
  const raw = serializeBlock(
    {
      kind: "block",
      authority: "agent",
      status: "active",
      version: 1,
      created: now.toISOString(),
      updated: now.toISOString(),
    },
    "old",
  ).replace("status: active", `status: active\nwhen: ${"w".repeat(95)}`);
  const path = join(d, "blocks/archive", name);
  writeFileSync(path, raw);
  writeFileSync(
    join(d, "blocks/archive/index.json"),
    JSON.stringify({ [name]: { id: "old.001", archivedAt: now.toISOString(), reason: "write" } }),
  );
  await runner().runSweep(d, "startup");
  expect(readFileSync(path, "utf8")).toBe(raw);
  await expect(restoreBlock(d, "old.001")).rejects.toThrow(
    /E_META: archived when exceeds limit \(95B > 70B\).*manually/,
  );
  writeFileSync(path, raw.replace("kind: block\n", ""));
  await expect(restoreBlock(d, "old.001")).rejects.toThrow("structural corruption");
  writeFileSync(path, raw);
  expect(readFileSync(path, "utf8")).toBe(raw);
});
