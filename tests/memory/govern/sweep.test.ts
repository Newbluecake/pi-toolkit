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
  expect((await r.runSweep(d, "write", undefined, "sweep")).stopped).toBe("self");
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
