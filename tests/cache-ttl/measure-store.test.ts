import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import {
  applyUpdates,
  createMeasureStore,
  defaultMeasureStorePath,
  parseStoreText,
  serializeStore,
  trimStoreToBudget,
  type MeasureStoreFs,
} from "../../src/cache-ttl/measure-store.js";
import {
  MEASURE_STORE_LIMITS,
  type MeasureRouteIdentity,
  type MeasureRouteRecord,
  type MeasureRunRecord,
  type MeasureStoreFile,
} from "../../src/cache-ttl/measure-types.js";

const NOW = 1_792_300_000_000;

function run(
  i: number,
  o: {
    status?: MeasureRunRecord["status"];
    finishedAt?: number;
    renewsOnRead?: "true" | "unknown";
    lowerMs?: number;
  } = {},
): MeasureRunRecord {
  const lowerMs = o.lowerMs ?? 1_261_000;
  const sample = (g: number) => ({
    gapMs: g,
    verdict: "hit" as const,
    idleMs: [g - 800, g + 2_400] as const,
    P: 14_822 + i,
    C: 14_796,
    B: 0,
    S: 14_799,
    cacheEvidence: "valid" as const,
    billing: "complete" as const,
  });
  return {
    runId: `m-mgx1a2-${String(i).padStart(8, "0")}`,
    status: o.status ?? "complete",
    startedAt: (o.finishedAt ?? NOW) - 3_720_000,
    finishedAt: o.finishedAt ?? NOW,
    load: { prefixes: 6, ownTokens: 88_700 },
    ttl: {
      lowerMs,
      missMs: 1_862_000,
      reachedMaxGap: false,
      consistent: true,
      validHits: 4,
      validMisses: 1,
      eligible: true,
    },
    samples: [180_000, 360_000, 660_000, 1_260_000, 1_860_000, 3_660_000].map(sample),
    control: { verdict: "hit", attempts: 1 },
    landed1h: "unknown",
    renewal: {
      renewsOnRead: o.renewsOnRead ?? "true",
      basis: "paired-empirical",
      assumptions: ["same backend class", "same eviction pressure", "same cache policy across prefixes"],
      touchedGapMs: 1_260_000,
      untouchedGapMs: 1_860_000,
      ceilingMs: 1_866_000,
      ageRMs: [1_872_000, 1_879_000],
      idleRMs: [598_000, 604_000],
      missAgeMs: [1_858_000, 1_866_000],
      read: { verdict: "hit", sentAt: NOW, headersAt: NOW + 800, P: 14_830, C: 14_796, B: 0, S: 14_799 },
    },
    requests: { cap: 17, sent: 12, possiblyBilled: 0 },
    cost: {
      knownUsd: 0.29,
      unknownUsd: [0, 0.0002],
      unknownItems: ["output×12"],
      estimate: {
        typicalUsd: 0.2,
        conditionalWorstUsd: 0.71,
        pBound: 20_913,
        requestCap: 17,
        conditions: ["C1", "C2", "C3"],
      },
    },
    toolkitVersion: "0.6.1",
    piVersion: "1.2.0",
  };
}

const route = (i: number): MeasureRouteIdentity => ({
  key: `sha256:${i.toString(16).padStart(64, "0")}`,
  label: `openai-responses · relay-${i}.example · /v1 · gpt-6-sol`,
  api: "openai-responses",
  wireModel: "gpt-6-sol",
  requestedRetention: "short",
  effectiveTier: "auto",
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "measure-store-"));
  file = path.join(dir, "agent", "cache-ttl-measurements.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (extra: Partial<Parameters<typeof createMeasureStore>[0]> = {}) => {
  const clock = new FakeClock(NOW);
  const slot = createMeasureClaim().persistSlot;
  const store = createMeasureStore({ filePath: file, clock, slot, ...extra });
  return { store, clock, slot };
};
const readFileJson = (): MeasureStoreFile => JSON.parse(fs.readFileSync(file, "utf8")) as MeasureStoreFile;

describe("path + atomic 0600 write", () => {
  it("default path honours PI_CODING_AGENT_DIR else ~/.pi/agent", () => {
    expect(defaultMeasureStorePath({ PI_CODING_AGENT_DIR: "/x/agent" } as NodeJS.ProcessEnv, "/home/u")).toBe(
      "/x/agent/cache-ttl-measurements.json",
    );
    expect(defaultMeasureStorePath({} as NodeJS.ProcessEnv, "/home/u")).toBe(
      "/home/u/.pi/agent/cache-ttl-measurements.json",
    );
    expect(defaultMeasureStorePath({ PI_CODING_AGENT_DIR: "" } as NodeJS.ProcessEnv, "/home/u")).toBe(
      "/home/u/.pi/agent/cache-ttl-measurements.json",
    );
  });

  it("writes schema v1, dir 0700, file 0600, no tmp left behind, lastSavedAt set, state idle", async () => {
    const { store, clock } = mk();
    expect(store.persistState).toBe("idle");
    store.persist(route(1), "latest", run(1));
    await store.flush();
    const body = readFileJson();
    expect(body.version).toBe(1);
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({ key: route(1).key, label: route(1).label, inProgress: null });
    expect(body.routes[0]!.latest!.runId).toBe(run(1).runId);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["cache-ttl-measurements.json"]);
    expect(store.lastSavedAt).toBe(clock.now());
    expect(store.persistState).toBe("idle");
  });

  it("keeps only latest + inProgress per route; a later persist replaces the slot; null clears inProgress", async () => {
    const { store } = mk();
    store.persist(route(1), "inProgress", run(1, { status: "running" }));
    await store.flush();
    expect(readFileJson().routes[0]!.inProgress!.status).toBe("running");
    store.persist(route(1), "latest", run(2));
    store.persist(route(1), "inProgress", null);
    await store.flush();
    const r = readFileJson().routes[0]!;
    expect(r.inProgress).toBeNull();
    expect(r.latest!.runId).toBe(run(2).runId);
    store.persist(route(1), "latest", run(3));
    await store.flush();
    expect(readFileJson().routes[0]!.latest!.runId).toBe(run(3).runId);
    expect(Object.keys(readFileJson().routes[0]!).sort()).toEqual([
      "api",
      "effectiveTier",
      "inProgress",
      "key",
      "label",
      "latest",
      "requestedRetention",
      "wireModel",
    ]);
  });

  it("attributes save times to the committed run only, including across /reload stores", async () => {
    const { store, clock, slot } = mk();
    const old = run(1),
      next = run(2);
    store.persist(route(1), "latest", old);
    await store.flush();
    expect(store.lastSavedAtFor(old.runId)).toBe(NOW);
    clock.advance(600000);
    const reloaded = createMeasureStore({ filePath: file, clock, slot });
    expect(reloaded.lastSavedAt).toBe(NOW);
    expect(reloaded.lastSavedAtFor(next.runId)).toBeUndefined();
    reloaded.persist(route(1), "inProgress", next);
    expect(reloaded.lastSavedAtFor(next.runId)).toBeUndefined(); // intent is NOT a successful save
    await reloaded.flush();
    expect(store.lastSavedAtFor(old.runId)).toBe(NOW);
    expect(store.lastSavedAtFor(next.runId)).toBe(NOW + 600000);
  });
  it("never throws, even when the directory cannot be created (state returns to idle, nothing saved)", async () => {
    fs.writeFileSync(path.join(dir, "agent"), "i am a file, not a directory");
    const { store } = mk();
    expect(() => store.persist(route(1), "latest", run(1))).not.toThrow();
    await store.flush();
    expect(store.persistState).toBe("idle");
    expect(store.lastSavedAt).toBeUndefined();
    expect(store.lastSavedAtFor(run(1).runId)).toBeUndefined();
    // a later persist after the obstacle is gone works again
    fs.rmSync(path.join(dir, "agent"));
    store.persist(route(1), "latest", run(1));
    await store.flush();
    expect(store.lastSavedAt).toBe(NOW);
    expect(store.lastSavedAtFor(run(1).runId)).toBe(NOW);
  });
});

describe("single coalesced writer", () => {
  function countingFs(real: MeasureStoreFs = fs.promises as unknown as MeasureStoreFs) {
    const stats = { writes: 0, inflight: 0, maxInflight: 0 };
    let gate: (() => void) | undefined;
    let hold = false;
    const wrapped: MeasureStoreFs = {
      ...real,
      mkdir: (d, o) => real.mkdir(d, o),
      stat: (f) => real.stat(f),
      readFile: (f, e) => real.readFile(f, e),
      unlink: (f) => real.unlink(f),
      rename: (a, b) => real.rename(a, b),
      writeFile: async (f, d, o) => {
        stats.writes++;
        stats.inflight++;
        stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
        if (hold) await new Promise<void>((r) => (gate = r));
        try {
          return await real.writeFile(f, d, o);
        } finally {
          stats.inflight--;
        }
      },
    };
    return {
      wrapped,
      stats,
      holdNext: () => (hold = true),
      release: () => {
        hold = false;
        gate?.();
      },
    };
  }

  it("one write in flight; a burst of persists coalesces into the newest snapshot (≤ 2 physical writes)", async () => {
    const c = countingFs();
    const { store } = mk({ fs: c.wrapped });
    c.holdNext();
    store.persist(route(1), "latest", run(1));
    await new Promise((r) => setTimeout(r, 20)); // first write is now blocked inside writeFile
    for (let i = 2; i <= 30; i++) store.persist(route(1), "latest", run(i));
    store.persist(route(2), "latest", run(99));
    expect(store.persistState).toBe("writing");
    c.release();
    await store.flush();
    expect(c.stats.writes).toBeLessThanOrEqual(2);
    expect(c.stats.maxInflight).toBe(1);
    const body = readFileJson();
    expect(body.routes.find((r) => r.key === route(1).key)!.latest!.runId).toBe(run(30).runId);
    expect(body.routes.find((r) => r.key === route(2).key)!.latest!.runId).toBe(run(99).runId);
  });

  it("two store instances sharing the process slot (a /reload) still produce ONE writer", async () => {
    const c = countingFs();
    const clock = new FakeClock(NOW);
    const slot = createMeasureClaim().persistSlot;
    const a = createMeasureStore({ filePath: file, clock, slot, fs: c.wrapped });
    const b = createMeasureStore({ filePath: file, clock, slot, fs: c.wrapped });
    c.holdNext();
    a.persist(route(1), "latest", run(1));
    await new Promise((r) => setTimeout(r, 20));
    b.persist(route(2), "latest", run(2));
    c.release();
    await a.flush();
    await b.flush();
    expect(c.stats.maxInflight).toBe(1);
    const keys = readFileJson()
      .routes.map((r) => r.key)
      .sort();
    expect(keys).toEqual([route(1).key, route(2).key].sort());
  });
});

describe("cross-process whole-file last-writer-wins", () => {
  it("re-reads before writing: another process's routes survive, the same route+slot is overwritten by us", async () => {
    const { store } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    // another pi process (older view) writes a different route and its own view of route 1
    const external = readFileJson();
    external.routes.push({ ...route(7), latest: run(7), inProgress: null });
    external.routes[0] = { ...external.routes[0]!, latest: run(50) };
    fs.writeFileSync(file, JSON.stringify(external), { mode: 0o600 });
    store.persist(route(1), "latest", run(2));
    store.persist(route(3), "inProgress", run(3, { status: "running" }));
    await store.flush();
    const body = readFileJson();
    expect(body.routes.map((r) => r.key).sort()).toEqual([route(1).key, route(3).key, route(7).key].sort());
    expect(body.routes.find((r) => r.key === route(1).key)!.latest!.runId).toBe(run(2).runId); // ours wins
    expect(body.routes.find((r) => r.key === route(7).key)!.latest!.runId).toBe(run(7).runId); // theirs kept
  });

  it("only the slot we write is replaced: their inProgress of the same route stays when we write latest", () => {
    const base: MeasureStoreFile = {
      version: 1,
      routes: [{ ...route(1), latest: run(1), inProgress: run(9, { status: "running" }) }],
    };
    const out = applyUpdates(base, [{ route: route(1), slot: "latest", run: run(2) }]);
    expect(out.routes[0]!.latest!.runId).toBe(run(2).runId);
    expect(out.routes[0]!.inProgress!.runId).toBe(run(9).runId);
  });
});

describe("budget (64 realistic full routes)", () => {
  const fullRoutes = (n: number): MeasureRouteRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      ...route(i),
      latest: run(i, { finishedAt: NOW - i * 3_600_000 }),
      inProgress: run(1000 + i, { status: "running", finishedAt: NOW - i * 3_600_000 }),
    }));

  it("a compact record is ~1.9 KiB, so 64 routes with both records exceed the 192 KiB write budget (trimming applies)", () => {
    const one = Buffer.byteLength(JSON.stringify(run(1)), "utf8");
    expect(one).toBeGreaterThan(1_800);
    expect(one).toBeLessThan(3_500);
    const file64: MeasureStoreFile = { version: 1, routes: fullRoutes(64) };
    expect(Buffer.byteLength(serializeStore(file64), "utf8")).toBeGreaterThan(MEASURE_STORE_LIMITS.writeBudgetBytes);
  });

  it("trims stepwise: inProgress of non-live runs first, samples/renewal.read of old routes next, whole oldest routes last", () => {
    const full: MeasureStoreFile = { version: 1, routes: fullRoutes(64) };
    const live = new Set([route(0).key]);
    const budget = MEASURE_STORE_LIMITS.writeBudgetBytes;
    const out = trimStoreToBudget(full, live);
    const bytes = Buffer.byteLength(serializeStore(out), "utf8");
    expect(bytes).toBeLessThanOrEqual(budget);
    expect(bytes).toBeLessThan(MEASURE_STORE_LIMITS.readCapBytes);
    // step 1 dropped non-live inProgress, the live route kept its inProgress
    expect(out.routes.find((r) => r.key === route(0).key)!.inProgress).not.toBeNull();
    expect(out.routes.filter((r) => r.key !== route(0).key).every((r) => r.inProgress === null)).toBe(true);
    // the live route's detail is intact
    const liveRoute = out.routes.find((r) => r.key === route(0).key)!;
    expect(liveRoute.latest!.samples).toHaveLength(6);
    expect(liveRoute.latest!.renewal!.read).toBeDefined();
    // every kept `latest` still has its summary (ttl) even when its samples were trimmed
    for (const r of out.routes) expect(r.latest!.ttl.lowerMs).toBe(1_261_000);
    // the NEWEST non-live routes keep their samples longer than the OLDEST (oldest-first trimming)
    const stripped = out.routes.filter((r) => r.latest!.samples.length === 0).map((r) => r.key);
    const newestNonLive = route(1).key;
    if (stripped.length > 0) expect(stripped).not.toContain(newestNonLive);
  });

  it("step by step: with a budget only trimming step 1 must satisfy, samples are untouched", () => {
    const full: MeasureStoreFile = { version: 1, routes: fullRoutes(40) };
    const withoutInProgress = serializeStore({
      version: 1,
      routes: full.routes.map((r) => ({ ...r, inProgress: null })),
    });
    const budget = Buffer.byteLength(withoutInProgress, "utf8");
    const out = trimStoreToBudget(full, new Set(), budget);
    expect(out.routes.every((r) => r.inProgress === null && r.latest!.samples.length === 6)).toBe(true);
    // one byte less forces step 2 on the oldest route only
    const out2 = trimStoreToBudget(full, new Set(), budget - 1);
    const stripped = out2.routes.filter((r) => r.latest!.samples.length === 0);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]!.key).toBe(route(39).key); // oldest activity first
    expect(stripped[0]!.latest!.renewal!.read).toBeUndefined();
    expect(stripped[0]!.latest!.renewal!.renewsOnRead).toBe("true");
  });

  it("route cap: the 65th route evicts the oldest non-live one", () => {
    const full: MeasureStoreFile = {
      version: 1,
      routes: fullRoutes(65).map((r) => ({ ...r, inProgress: null, latest: { ...r.latest!, samples: [] } })),
    };
    const out = trimStoreToBudget(full, new Set([route(64).key]));
    expect(out.routes).toHaveLength(64);
    expect(out.routes.map((r) => r.key)).toContain(route(64).key); // live kept although oldest
    expect(out.routes.map((r) => r.key)).not.toContain(route(63).key); // oldest non-live gone
  });

  it("the live route survives even a tiny budget as far as physically possible (detail first, then whole routes)", () => {
    const full: MeasureStoreFile = { version: 1, routes: fullRoutes(5) };
    const tiny = 4_000;
    const out = trimStoreToBudget(full, new Set([route(0).key]), tiny);
    expect(Buffer.byteLength(serializeStore(out), "utf8")).toBeLessThanOrEqual(tiny);
    expect(out.routes.map((r) => r.key)).toContain(route(0).key);
  });

  it("end-to-end: persisting 64+ realistic routes through the writer yields a readable file under both caps", async () => {
    const { store } = mk();
    for (let i = 0; i < 70; i++) {
      store.persist(route(i), "latest", run(i, { finishedAt: NOW - i * 3_600_000 }));
      store.persist(route(i), "inProgress", run(1000 + i, { status: "running", finishedAt: NOW - i * 3_600_000 }));
      await store.flush();
    }
    const size = fs.statSync(file).size;
    expect(size).toBeLessThanOrEqual(MEASURE_STORE_LIMITS.writeBudgetBytes);
    expect(size).toBeLessThan(MEASURE_STORE_LIMITS.readCapBytes);
    const parsed = parseStoreText(fs.readFileSync(file, "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.routes.length).toBeLessThanOrEqual(64);
    // our own output is always readable back
    expect(await store.readRoute(route(69).key)).toBeDefined();
  });
});

describe("corrupt / oversize / unknown version ⇒ one `.corrupt` backup, treated as empty", () => {
  const backup = () => `${file}.corrupt`;
  const seed = (text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it("garbage JSON", async () => {
    seed("{not json");
    const { store } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    expect(fs.readFileSync(backup(), "utf8")).toBe("{not json");
    expect(readFileJson().routes).toHaveLength(1);
  });

  it("unknown schema version", async () => {
    seed(JSON.stringify({ version: 2, routes: [] }));
    const { store } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    expect(JSON.parse(fs.readFileSync(backup(), "utf8"))).toEqual({ version: 2, routes: [] });
    expect(readFileJson().version).toBe(1);
  });

  it("over the 256 KiB read cap", async () => {
    seed(" ".repeat(MEASURE_STORE_LIMITS.readCapBytes + 1));
    const { store } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    expect(fs.statSync(backup()).size).toBe(MEASURE_STORE_LIMITS.readCapBytes + 1);
    expect(readFileJson().routes).toHaveLength(1);
  });

  it("the backup is a SINGLE file: the next corruption overwrites it", async () => {
    seed("first-corrupt");
    const { store } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    seed("second-corrupt");
    store.persist(route(2), "latest", run(2));
    await store.flush();
    expect(fs.readFileSync(backup(), "utf8")).toBe("second-corrupt");
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([
      "cache-ttl-measurements.json",
      "cache-ttl-measurements.json.corrupt",
    ]);
  });

  it("readRoute on a corrupt file returns undefined without touching it", async () => {
    seed("garbage");
    const { store } = mk();
    expect(await store.readRoute(route(1).key)).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("garbage");
    expect(fs.existsSync(backup())).toBe(false);
  });

  it("malformed ROUTES are dropped individually, the rest of the file is kept", () => {
    const good = { ...route(1), latest: run(1), inProgress: null };
    const parsed = parseStoreText(
      JSON.stringify({
        version: 1,
        routes: [good, { key: 5 }, { ...good, api: "nope" }, null, { ...good, key: "sha256:x", latest: { runId: 1 } }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.routes.map((r) => r.key)).toEqual([route(1).key]);
  });
});

describe("zombie fencing (each step raced against 2 s)", () => {
  function stuckFs(stuck: "writeFile" | "readFile" | "rename" | "mkdir") {
    const real = fs.promises as unknown as MeasureStoreFs;
    const releases: Array<() => void> = [];
    const calls = { writeFile: 0 };
    const hang = <T>(p: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => releases.push(() => p().then(resolve, reject)));
    const wrapped: MeasureStoreFs = {
      mkdir: (d, o) => (stuck === "mkdir" ? hang(() => real.mkdir(d, o)) : real.mkdir(d, o)),
      stat: (f) => real.stat(f),
      readFile: (f, e) => (stuck === "readFile" ? hang(() => real.readFile(f, e)) : real.readFile(f, e)),
      writeFile: (f, d, o) => {
        calls.writeFile++;
        return stuck === "writeFile" ? hang(() => real.writeFile(f, d, o)) : real.writeFile(f, d, o);
      },
      rename: (a, b) => (stuck === "rename" ? hang(() => real.rename(a, b)) : real.rename(a, b)),
      unlink: (f) => real.unlink(f),
    };
    return { wrapped, releases, calls };
  }

  for (const step of ["writeFile", "rename", "readFile", "mkdir"] as const) {
    it(`a ${step} that never settles ⇒ zombie after 2 s; later persists are skipped; late completion is ignored`, async () => {
      // readFile only runs when the file exists
      if (step === "readFile") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version: 1, routes: [] }));
      }
      const s = stuckFs(step);
      const { store, clock, slot } = mk({ fs: s.wrapped });
      store.persist(route(1), "latest", run(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(store.persistState).toBe("writing");
      clock.advance(MEASURE_STORE_LIMITS.persistStepDeadlineMs - 1);
      await new Promise((r) => setTimeout(r, 5));
      expect(store.persistState).toBe("writing"); // deadline not reached yet
      clock.advance(1);
      await store.flush();
      expect(store.persistState).toBe("zombie");
      expect(slot.zombieSince).toBe(clock.now());
      expect(store.lastSavedAt).toBeUndefined();
      // skipped + reported
      const writesBefore = s.calls.writeFile;
      store.persist(route(2), "latest", run(2));
      store.persist(route(3), "inProgress", run(3, { status: "running" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(slot.pending.size).toBe(0);
      expect(s.calls.writeFile).toBe(writesBefore);
      expect(store.persistState).toBe("zombie");
      // the stuck operation finally completes — nothing changes in the slot
      for (const r of s.releases) r();
      await new Promise((r) => setTimeout(r, 30));
      expect(store.persistState).toBe("zombie");
      expect(store.lastSavedAt).toBeUndefined();
    });
  }

  it("zombie is process-wide: a second store instance (after /reload) on the same slot skips too", async () => {
    const s = stuckFs("writeFile");
    const clock = new FakeClock(NOW);
    const slot = createMeasureClaim().persistSlot;
    const a = createMeasureStore({ filePath: file, clock, slot, fs: s.wrapped });
    a.persist(route(1), "latest", run(1));
    await new Promise((r) => setTimeout(r, 30));
    clock.advance(2_000);
    await a.flush();
    const b = createMeasureStore({ filePath: file, clock, slot });
    b.persist(route(2), "latest", run(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(b.persistState).toBe("zombie");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a fast step never leaves a pending timer behind", async () => {
    const { store, clock } = mk();
    store.persist(route(1), "latest", run(1));
    await store.flush();
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("lookupLearnedTtl (consumer API; eligible records only)", () => {
  const seed = async (r: MeasureRunRecord, which: "latest" | "inProgress" = "latest") => {
    const { store } = mk();
    store.persist(route(1), which, r);
    await store.flush();
    return store;
  };

  it("returns lowerMs, renewal true + basis and sampledAt for a fresh eligible record", async () => {
    const store = await seed(run(1));
    expect(await store.lookupLearnedTtl(route(1).key, NOW + 1_000)).toEqual({
      lowerMs: 1_261_000,
      renewsOnRead: "true",
      renewalBasis: "paired-empirical",
      sampledAt: NOW,
    });
  });

  it("renewal unknown ⇒ renewsOnRead unknown, no basis; a stored 'false' is read as unknown", async () => {
    const unknown = await seed(run(1, { renewsOnRead: "unknown" }));
    expect(await unknown.lookupLearnedTtl(route(1).key, NOW)).toEqual({
      lowerMs: 1_261_000,
      renewsOnRead: "unknown",
      sampledAt: NOW,
    });
    const r = run(2);
    (r.renewal as { renewsOnRead: string }).renewsOnRead = "false";
    const falsy = await seed(r);
    expect((await falsy.lookupLearnedTtl(route(1).key, NOW))!.renewsOnRead).toBe("unknown");
  });

  it("stale (> 30 d), ineligible, other key and inProgress-only records return undefined", async () => {
    const store = await seed(run(1));
    expect(await store.lookupLearnedTtl(route(1).key, NOW + 30 * 24 * 3_600_000 + 1)).toBeUndefined();
    expect(await store.lookupLearnedTtl(route(2).key, NOW)).toBeUndefined();
    expect(await (await seed(run(1, { status: "cancelled" }))).lookupLearnedTtl(route(1).key, NOW)).toBeUndefined();
    expect(await (await seed(run(1, { lowerMs: 100_000 }))).lookupLearnedTtl(route(1).key, NOW)).toBeUndefined();
    expect(await (await seed(run(1), "inProgress")).lookupLearnedTtl(route(1).key, NOW)).toBeUndefined();
  });

  it("a missing file ⇒ undefined (no throw)", async () => {
    const { store } = mk();
    expect(await store.lookupLearnedTtl(route(1).key, NOW)).toBeUndefined();
    expect(await store.readRoute(route(1).key)).toBeUndefined();
  });
});
