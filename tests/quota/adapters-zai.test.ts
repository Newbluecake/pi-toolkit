import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, kimiAdapter, selectAdapters } from "../../src/quota/adapters/index.js";
import type { AdapterDeps } from "../../src/quota/adapters/types.js";
import {
  ZAI_QUOTA_PATH,
  parseZaiQuota,
  zaiAdapter,
  zaiOverseasAdapter,
  zaiScopeOfUnit,
} from "../../src/quota/adapters/zai.js";

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
    apiKey: "sk-zai-test",
    now: () => NOW,
    baseUrl: "https://quota.example.test",
    userAgent: "Mozilla/5.0 (test) Chrome/128.0 Safari/537.36",
    ...overrides,
  };
  return { deps, calls };
}

describe("parseZaiQuota", () => {
  it("parses the verbatim field sample into two windows with raw ms resetAt", () => {
    const snapshot = parseZaiQuota(load("zai-quota-limit.json"), "zai-coding-cn", NOW);
    expect(snapshot).toEqual({
      provider: "zai-coding-cn",
      kind: "windows",
      windows: [
        { scope: "5h", usedPct: Math.round((79 / 28000) * 100), resetAt: 1790187105217 },
        { scope: "week", usedPct: Math.round((20486 / 140000) * 100), resetAt: 1790754528987 },
      ],
      fetchedAt: NOW,
      plan: "max",
    });
  });

  it("prefers self-computed currentValue/usage over the percentage field", () => {
    const snapshot = parseZaiQuota(load("zai-quota-limit.json"), "zai-coding-cn", NOW);
    const fiveHour = snapshot?.windows[0];
    if (!fiveHour) throw new Error("missing 5h window");
    expect(fiveHour.usedPct).toBe(0); // round(79/28000*100) = 0
    expect(fiveHour.usedPct).not.toBe(1); // the fixture's (wrong) percentage field
  });

  it("falls back to percentage only when usage <= 0", () => {
    const raw = {
      code: 200,
      data: {
        level: "max",
        limits: [{ unit: 3, usage: 0, currentValue: 0, percentage: 42, nextResetTime: 1234567890123 }],
      },
    };
    const snapshot = parseZaiQuota(raw, "zai-coding-cn", NOW);
    expect(snapshot?.windows).toEqual([{ scope: "5h", usedPct: 42, resetAt: 1234567890123 }]);
  });

  it("skips unknown units silently, keeping the recognized ones", () => {
    expect(zaiScopeOfUnit(3)).toBe("5h");
    expect(zaiScopeOfUnit(6)).toBe("week");
    expect(zaiScopeOfUnit(9)).toBeUndefined();
    expect(zaiScopeOfUnit("3")).toBeUndefined();
    const snapshot = parseZaiQuota(load("zai-quota-unknown-unit.json"), "zai-coding-cn", NOW);
    expect(snapshot?.windows.map((w) => w.scope)).toEqual(["5h", "week"]); // unit:9 dropped
    expect(snapshot?.windows[0]?.usedPct).toBe(25); // 7000/28000
    expect(snapshot?.plan).toBe("pro");
  });

  it("returns undefined for empty limits (no usable window = no snapshot)", () => {
    expect(parseZaiQuota(load("zai-quota-empty-limits.json"), "zai-coding-cn", NOW)).toBeUndefined();
  });

  it("returns undefined for every malformed shape without throwing", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      "nope",
      42,
      {}, // no code
      { code: 500, data: { limits: [] } }, // code !== 200
      { code: 200 }, // no data
      { code: 200, data: { level: "max" } }, // no limits
      { code: 200, data: { limits: "nope" } }, // limits not an array
      { code: 200, data: { limits: [{ unit: 3 }] } }, // entry without usable numbers
      { code: "200", data: { limits: [] } }, // code is a string
    ];
    for (const raw of malformed) {
      expect(() => parseZaiQuota(raw, "zai-coding-cn", NOW)).not.toThrow();
      expect(parseZaiQuota(raw, "zai-coding-cn", NOW)).toBeUndefined();
    }
  });
});

describe("zaiAdapter / zaiOverseasAdapter", () => {
  it("sends the bare key (no Bearer prefix) and hits {baseUrl}/api/monitor/usage/quota/limit", async () => {
    const { deps, calls } = makeDeps(load("zai-quota-limit.json"));
    const snapshot = await zaiAdapter.fetchQuota(deps);
    expect(snapshot?.provider).toBe("zai-coding-cn");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no call recorded");
    expect(call.url).toBe(`https://quota.example.test${ZAI_QUOTA_PATH}`);
    expect(call.headers.Authorization).toBe("sk-zai-test"); // 裸 key，无 Bearer
    expect(call.headers.Authorization).not.toMatch(/^Bearer /);
  });

  it("returns undefined without any fetchJson call when apiKey is undefined", async () => {
    const { deps, calls } = makeDeps(load("zai-quota-limit.json"), { apiKey: undefined });
    const snapshot = await zaiAdapter.fetchQuota(deps);
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
    await expect(zaiAdapter.fetchQuota(deps)).resolves.toBeUndefined();
  });

  it("overseas adapter: id 'zai', default baseUrl api.z.ai, parser shared", async () => {
    expect(zaiOverseasAdapter.id).toBe("zai");
    expect(zaiOverseasAdapter.defaultBaseUrl).toBe("https://api.z.ai");
    expect(zaiAdapter.defaultBaseUrl).toBe("https://open.bigmodel.cn");
    const { deps } = makeDeps(load("zai-quota-limit.json"));
    const snapshot = await zaiOverseasAdapter.fetchQuota(deps);
    expect(snapshot).toEqual({
      provider: "zai", // same parsed windows, different provider id
      kind: "windows",
      windows: [
        { scope: "5h", usedPct: Math.round((79 / 28000) * 100), resetAt: 1790187105217 },
        { scope: "week", usedPct: Math.round((20486 / 140000) * 100), resetAt: 1790754528987 },
      ],
      fetchedAt: NOW,
      plan: "max",
    });
  });
});

describe("adapter registry", () => {
  it("ADAPTERS covers all provider ids", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(["kimi-coding", "zai", "zai-coding-cn"]);
    expect(ADAPTERS["zai-coding-cn"]).toBe(zaiAdapter);
    expect(ADAPTERS.zai).toBe(zaiOverseasAdapter);
  });

  it("selectAdapters filters the whitelist in registry order", () => {
    expect(selectAdapters([])).toEqual([]);
    expect(selectAdapters(["kimi-coding", "zai"])).toEqual([zaiOverseasAdapter, kimiAdapter]);
    expect(selectAdapters(["nonsense" as never])).toEqual([]);
  });
});
