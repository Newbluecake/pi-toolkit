import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIMI_USAGES_PATH, kimiAdapter, parseKimiQuota } from "../../src/quota/adapters/kimi.js";
import type { AdapterDeps } from "../../src/quota/adapters/types.js";
import { DEFAULT_USER_AGENT } from "../../src/quota/http.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "quota");
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const NOW = 1_790_000_000_000;

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal | undefined;
}

function makeDeps(raw: unknown, overrides: Partial<AdapterDeps> = {}): { deps: AdapterDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: AdapterDeps = {
    fetchJson: async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal });
      return raw;
    },
    apiKey: "sk-kimi-test",
    now: () => NOW,
    baseUrl: "https://quota.example.test",
    userAgent: "Mozilla/5.0 (test) Chrome/128.0 Safari/537.36",
    ...overrides,
  };
  return { deps, calls };
}

describe("parseKimiQuota", () => {
  it("parses the verbatim field sample: usages.limit_5h/limit_7d → [{5h,0},{week,100}] (#kimi-week-trap data)", () => {
    const snapshot = parseKimiQuota(load("kimi-usages.json"), NOW);
    expect(snapshot).toEqual({
      provider: "kimi-coding",
      kind: "windows",
      windows: [
        { scope: "5h", usedPct: 0, resetAt: Date.parse("2026-09-23T18:06:32Z") },
        { scope: "week", usedPct: 100, resetAt: Date.parse("2026-09-28T01:06:32Z") },
      ],
      fetchedAt: NOW,
    });
  });

  it("maps reset_time ISO strings to Date.parse epoch ms", () => {
    const snapshot = parseKimiQuota(load("kimi-usages.json"), NOW);
    const windows = snapshot?.windows ?? [];
    expect(windows[0]?.resetAt).toBe(Date.parse("2026-09-23T18:06:32Z"));
    expect(windows[1]?.resetAt).toBe(Date.parse("2026-09-28T01:06:32Z"));
  });

  it("falls back to usage + limits[] when top-level usages is absent (legacy path)", () => {
    const snapshot = parseKimiQuota(load("kimi-usages-legacy.json"), NOW);
    expect(snapshot?.windows).toEqual([
      { scope: "5h", usedPct: 0, resetAt: Date.parse("2026-09-23T18:06:33.380237Z") }, // (100-100)/100
      { scope: "week", usedPct: 100, resetAt: Date.parse("2026-09-28T01:06:33.380237Z") }, // used/limit
    ]);
  });

  it("prefers top-level usages over the legacy fallback when both exist and disagree", () => {
    const raw = {
      usage: { limit: "100", used: "100", resetTime: "2026-09-28T01:06:33.380237Z" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", remaining: "0", resetTime: "2026-09-23T18:06:33.380237Z" },
        },
      ],
      usages: {
        limit_5h: { used_ratio: 0.1, reset_time: "2026-09-23T18:06:32Z" },
        limit_7d: { used_ratio: 0.2, reset_time: "2026-09-28T01:06:32Z" },
      },
    };
    const snapshot = parseKimiQuota(raw, NOW);
    expect(snapshot?.windows.map((w) => [w.scope, w.usedPct])).toEqual([
      ["5h", 10],
      ["week", 20],
    ]);
  });

  it("ignores totalQuota (upstream bug MoonshotAI/kimi-code#1569 — the field is always 99)", () => {
    // kimi-usages.json carries the decoy "totalQuota": 99 verbatim.
    const fixture = load("kimi-usages.json") as Record<string, unknown>;
    expect(fixture.totalQuota).toBe(99);
    const snapshot = parseKimiQuota(fixture, NOW);
    const usedPcts = (snapshot?.windows ?? []).map((w) => w.usedPct);
    expect(usedPcts).toEqual([0, 100]);
    expect(usedPcts).not.toContain(99);
  });

  it("clamps out-of-range used_ratio (-1 → 0, 2 → 100)", () => {
    const base = load("kimi-usages.json") as {
      usages: { limit_5h: { used_ratio: number }; limit_7d: { used_ratio: number } };
    };
    for (const [ratio, expected] of [
      [-1, 0],
      [2, 100],
    ] as const) {
      const mutated = structuredClone(base);
      mutated.usages.limit_5h.used_ratio = ratio;
      const snapshot = parseKimiQuota(mutated, NOW);
      expect(snapshot?.windows[0]?.usedPct).toBe(expected);
    }
  });

  it("returns undefined for every malformed shape without throwing", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      "nope",
      42,
      {},
      { usages: {} }, // usages present but empty + no legacy → nothing usable
      { usages: { limit_5h: { used_ratio: "zero" } } }, // ratio not a number
      { code: 200 },
    ];
    for (const raw of malformed) {
      expect(() => parseKimiQuota(raw, NOW)).not.toThrow();
      expect(parseKimiQuota(raw, NOW)).toBeUndefined();
    }
  });
});

describe("kimiAdapter.fetchQuota", () => {
  it("sends Authorization: Bearer <key> with a browser User-Agent (Cloudflare 1010 regression)", async () => {
    const { deps, calls } = makeDeps(load("kimi-usages.json"));
    const snapshot = await kimiAdapter.fetchQuota(deps);
    expect(snapshot?.kind).toBe("windows");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no call recorded");
    expect(call.url).toBe(`https://quota.example.test${KIMI_USAGES_PATH}`);
    expect(call.headers.Authorization).toBe("Bearer sk-kimi-test");
    expect(call.headers["User-Agent"]).toBeTruthy();
    expect(call.headers["User-Agent"]).not.toMatch(/curl|node/i);
  });

  it("falls back to DEFAULT_USER_AGENT when deps.userAgent is empty", async () => {
    const { deps, calls } = makeDeps(load("kimi-usages.json"), { userAgent: "" });
    await kimiAdapter.fetchQuota(deps);
    expect(calls[0]?.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });

  it("returns undefined without any fetchJson call when apiKey is undefined", async () => {
    const { deps, calls } = makeDeps(load("kimi-usages.json"), { apiKey: undefined });
    const snapshot = await kimiAdapter.fetchQuota(deps);
    expect(snapshot).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("swallows fetchJson rejections (never throws)", async () => {
    const deps: AdapterDeps = {
      ...makeDeps(undefined).deps,
      fetchJson: async () => {
        throw new Error("boom");
      },
    };
    await expect(kimiAdapter.fetchQuota(deps)).resolves.toBeUndefined();
  });

  it("exposes id / kind / defaultBaseUrl for the registry", () => {
    expect(kimiAdapter.id).toBe("kimi-coding");
    expect(kimiAdapter.kind).toBe("windows");
    expect(kimiAdapter.defaultBaseUrl).toBe("https://api.kimi.com");
  });
});
