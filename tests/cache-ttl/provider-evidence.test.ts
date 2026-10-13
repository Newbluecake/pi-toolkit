import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProviderEvidenceStore,
  NO_CACHE_VALUE_STREAK_LIMIT,
  PROVIDER_EVIDENCE_MAX_ROUTES,
  PROVIDER_EVIDENCE_TTL_MS,
  routeKey,
  WRITE1H_REFRESH_MIN_INTERVAL_MS,
} from "../../src/cache-ttl/provider-evidence.js";

const NOW = 10_000_000_000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-evidence-"));
  file = join(dir, "cache-provider-evidence.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("provider-evidence — write1h landing evidence (O1/O2)", () => {
  it("no observation ⇒ no evidence", () => {
    const store = createProviderEvidenceStore(file);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", NOW)).toBe(false);
  });

  it("noteWrite1hLanded ⇒ evidence, persisted across store instances", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("anthropic", "claude-x", NOW);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", NOW)).toBe(true);
    // A fresh instance reads the same file (cross-/reload persistence).
    const reopened = createProviderEvidenceStore(file);
    expect(reopened.hasWrite1hEvidence("anthropic", "claude-x", NOW + 1_000)).toBe(true);
  });

  it("evidence expires after the 30d rolling TTL", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("anthropic", "claude-x", NOW);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", NOW + PROVIDER_EVIDENCE_TTL_MS - 1)).toBe(true);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", NOW + PROVIDER_EVIDENCE_TTL_MS + 1)).toBe(false);
  });

  it("a fresh observation rolls the TTL forward", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("anthropic", "claude-x", NOW);
    const later = NOW + PROVIDER_EVIDENCE_TTL_MS - 1_000;
    store.noteWrite1hLanded("anthropic", "claude-x", later);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", later + PROVIDER_EVIDENCE_TTL_MS - 1)).toBe(true);
  });

  it("refresh within the min interval does not rewrite the file (rate limit)", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("anthropic", "claude-x", NOW);
    const before = readFileSync(file, "utf8");
    store.noteWrite1hLanded("anthropic", "claude-x", NOW + WRITE1H_REFRESH_MIN_INTERVAL_MS - 1);
    expect(readFileSync(file, "utf8")).toBe(before);
    // Past the interval it refreshes (and the stored timestamp moves).
    store.noteWrite1hLanded("anthropic", "claude-x", NOW + WRITE1H_REFRESH_MIN_INTERVAL_MS + 1);
    expect(readFileSync(file, "utf8")).not.toBe(before);
  });

  it("evidence is keyed per provider+model — a sibling route has none", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("anthropic", "claude-x", NOW);
    expect(store.hasWrite1hEvidence("anthropic", "claude-y", NOW)).toBe(false);
    expect(store.hasWrite1hEvidence("other", "claude-x", NOW)).toBe(false);
  });

  it("empty provider or modelId is ignored (no write, no throw)", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("", "claude-x", NOW);
    store.noteWrite1hLanded("anthropic", "", NOW);
    expect(store.hasWrite1hEvidence("", "claude-x", NOW)).toBe(false);
    expect(() => readFileSync(file, "utf8")).toThrow(); // nothing was ever written
  });
});

describe("provider-evidence — no-cache-value breaker (O3)", () => {
  it("streak below the limit does not trip", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT - 1; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
      expect(store.isNoCacheValue("cr", "model-x", NOW + i * 1_000)).toBe(false);
    }
  });

  it("trips at the limit and stays tripped (within TTL)", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
    }
    expect(store.isNoCacheValue("cr", "model-x", NOW + 99_000)).toBe(true);
    // persisted
    const reopened = createProviderEvidenceStore(file);
    expect(reopened.isNoCacheValue("cr", "model-x", NOW + 99_000)).toBe(true);
  });

  it("any cache read resets the streak and clears the trip immediately", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
    }
    expect(store.isNoCacheValue("cr", "model-x", NOW)).toBe(true);
    store.noteCacheRead("cr", "model-x", NOW + 5_000);
    expect(store.isNoCacheValue("cr", "model-x", NOW + 5_000)).toBe(false);
    // and the streak really restarted from zero
    store.noteZeroReadSession("cr", "model-x", NOW + 6_000);
    expect(store.isNoCacheValue("cr", "model-x", NOW + 6_000)).toBe(false);
  });

  it("noteCacheRead on a clean route writes nothing (no per-message disk churn)", () => {
    const store = createProviderEvidenceStore(file);
    store.noteCacheRead("cr", "model-x", NOW);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("a mid-streak cache read resets the consecutive count", () => {
    const store = createProviderEvidenceStore(file);
    store.noteZeroReadSession("cr", "model-x", NOW);
    store.noteZeroReadSession("cr", "model-x", NOW + 1_000);
    store.noteCacheRead("cr", "model-x", NOW + 2_000);
    store.noteZeroReadSession("cr", "model-x", NOW + 3_000);
    store.noteZeroReadSession("cr", "model-x", NOW + 4_000);
    // only 2 consecutive since the reset ⇒ not tripped
    expect(store.isNoCacheValue("cr", "model-x", NOW + 4_000)).toBe(false);
  });

  it("the trip itself ages out after the TTL (a fixed route gets a fresh chance)", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
    }
    // trip timestamp is NOW + 2_000 (the third noteZeroReadSession)
    expect(store.isNoCacheValue("cr", "model-x", NOW + 2_000 + PROVIDER_EVIDENCE_TTL_MS + 1)).toBe(false);
  });
});

describe("provider-evidence — probe records (O4)", () => {
  it("noteProbe stores the verdict and feeds write1h evidence when landed", () => {
    const store = createProviderEvidenceStore(file);
    store.noteProbe("kimi-coding", "k3", { cacheAlive: true, immediateHit: true, write1hLanded: false }, NOW);
    const route = store.readRoute("kimi-coding", "k3", NOW);
    expect(route?.probedAt).toBe(NOW);
    expect(route?.probe).toEqual({ cacheAlive: true, immediateHit: true, write1hLanded: false });
    expect(store.hasWrite1hEvidence("kimi-coding", "k3", NOW)).toBe(false);
  });

  it("a probe with write1hLanded:true records landing evidence", () => {
    const store = createProviderEvidenceStore(file);
    store.noteProbe("anthropic", "claude-x", { cacheAlive: true, immediateHit: true, write1hLanded: true }, NOW);
    expect(store.hasWrite1hEvidence("anthropic", "claude-x", NOW)).toBe(true);
  });

  it("a probe hit resets the no-cache-value breaker (it IS a cache read)", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
    }
    store.noteProbe("cr", "model-x", { cacheAlive: true, immediateHit: true, write1hLanded: false }, NOW + 9_000);
    expect(store.isNoCacheValue("cr", "model-x", NOW + 9_000)).toBe(false);
  });

  it("a probe MISS does not reset the breaker", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("cr", "model-x", NOW + i * 1_000);
    }
    store.noteProbe("cr", "model-x", { cacheAlive: false, immediateHit: false, write1hLanded: false }, NOW + 9_000);
    expect(store.isNoCacheValue("cr", "model-x", NOW + 9_000)).toBe(true);
  });
});

describe("provider-evidence — degradation and hygiene", () => {
  it("a corrupt file degrades to empty (never throws, never claims evidence)", () => {
    writeFileSync(file, "not json {{{", "utf8");
    const store = createProviderEvidenceStore(file);
    expect(store.hasWrite1hEvidence("a", "b", NOW)).toBe(false);
    expect(store.isNoCacheValue("a", "b", NOW)).toBe(false);
    expect(store.readRoute("a", "b", NOW)).toBeUndefined();
  });

  it("a file over the read cap is treated as corrupt", () => {
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 120), "utf8");
    const store = createProviderEvidenceStore(file);
    expect(store.hasWrite1hEvidence("a", "b", NOW)).toBe(false);
  });

  it("write failures are swallowed (read-only directory)", () => {
    const roDir = join(dir, "ro");
    mkdirSync(roDir);
    const roFile = join(roDir, "evidence.json");
    const store = createProviderEvidenceStore(roFile);
    store.noteWrite1hLanded("a", "b", NOW);
    chmodSync(roDir, 0o500);
    try {
      expect(() =>
        store.noteProbe("a", "b", { cacheAlive: true, immediateHit: true, write1hLanded: true }, NOW),
      ).not.toThrow();
      // in-memory state still works for this process
      expect(store.hasWrite1hEvidence("a", "b", NOW)).toBe(true);
    } finally {
      chmodSync(roDir, 0o700);
    }
  });

  it("route cap evicts the idlest route first", () => {
    const store = createProviderEvidenceStore(file);
    for (let i = 0; i < PROVIDER_EVIDENCE_MAX_ROUTES + 5; i += 1) {
      store.noteProbe("p", `m${i}`, { cacheAlive: false, immediateHit: false, write1hLanded: false }, NOW + i);
    }
    expect(store.readRoute("p", "m0", NOW + 10_000)).toBeUndefined();
    expect(store.readRoute("p", `m${PROVIDER_EVIDENCE_MAX_ROUTES + 4}`, NOW + 10_000)).toBeDefined();
  });

  it("partially-corrupt route entries are sanitized field-by-field", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        routes: {
          [routeKey("a", "b")]: { write1hLandedAt: NOW, zeroReadSessions: "nope", probe: { cacheAlive: 1 } },
          bad: 42,
        },
      }),
      "utf8",
    );
    const store = createProviderEvidenceStore(file);
    expect(store.hasWrite1hEvidence("a", "b", NOW)).toBe(true);
    expect(store.readRoute("a", "b", NOW)?.zeroReadSessions).toBe(0);
    expect(store.readRoute("a", "b", NOW)?.probe).toBeUndefined();
  });

  it("a wrong-version file degrades to empty", () => {
    writeFileSync(file, JSON.stringify({ version: 99, routes: {} }), "utf8");
    const store = createProviderEvidenceStore(file);
    expect(store.readRoute("a", "b", NOW)).toBeUndefined();
  });

  it("regression: an observation at epoch 0 is real evidence, not an empty record (0 is a timestamp, not a sentinel)", () => {
    const store = createProviderEvidenceStore(file);
    store.noteWrite1hLanded("a", "b", 0);
    expect(store.hasWrite1hEvidence("a", "b", 300_000)).toBe(true);
    const reopened = createProviderEvidenceStore(file);
    expect(reopened.hasWrite1hEvidence("a", "b", 300_000)).toBe(true);
  });
});
