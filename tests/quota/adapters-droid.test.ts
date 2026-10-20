// quota-plan r2 §11：droid 适配器对子（§3）——解析守卫、共享在途请求
// （inflight 首个 await 前同步赋值）、401/402/403 warnOnce + lastProblem、
// 无 key 不发请求、零计时器、告警不含 key。

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDroidAdapters,
  DROID_COALESCE_MS,
  FACTORY_BASE_URL,
  FACTORY_LIMITS_PATH,
  parseFactoryLimits,
} from "../../src/quota/adapters/droid.js";
import type { AdapterDeps } from "../../src/quota/adapters/types.js";
import { createFetchJson } from "../../src/quota/http.js";

const NOW = 1_800_000_000_000; // 2027-01-15T06:40:00.000Z
const FUTURE = NOW + 3_600_000;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), `tests/fixtures/quota/${name}`), "utf8")) as unknown;
}

function deps(over: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    fetchJson: async () => undefined,
    apiKey: "factory-key-SECRET",
    now: () => NOW,
    baseUrl: FACTORY_BASE_URL,
    userAgent: "test-agent",
    ...over,
  };
}

describe("parseFactoryLimits", () => {
  it("parses the all-zero fixture into both pools (3 windows each, billing attached)", () => {
    const parsed = parseFactoryLimits(loadFixture("factory-limits-zero.json"), NOW);
    expect(parsed?.standard?.provider).toBe("droid-standard");
    expect(parsed?.core?.provider).toBe("droid-core");
    expect(parsed?.standard?.windows.map((w) => w.scope)).toEqual(["5h", "week", "month"]);
    expect(parsed?.standard?.windows.every((w) => w.usedPct === 0)).toBe(true);
    expect(parsed?.standard?.billing).toEqual({
      kind: "factory",
      pool: "standard",
      overage: "droidCore",
      extraUsageAllowed: false,
      extraUsageBalanceCents: 0,
    });
    expect(parsed?.core?.billing?.pool).toBe("core");
    expect(parsed?.standard?.fetchedAt).toBe(NOW);
  });

  it("parses an exhausted standard window and inactive core window (null windowEnd ⇒ 0%, no resetAt)", () => {
    const parsed = parseFactoryLimits(loadFixture("factory-limits-standard-exhausted.json"), NOW);
    const std = parsed?.standard;
    expect(std?.windows[0]).toMatchObject({ scope: "5h", usedPct: 100 });
    expect(std?.billing).toMatchObject({
      overage: "extraUsage",
      extraUsageAllowed: true,
      extraUsageBalanceCents: 1234,
    });
    // core fiveHour 的 windowEnd 为 null 且 secondsRemaining = 0 ⇒ 未激活 ⇒ 0%、无 resetAt。
    const coreFiveHour = parsed?.core?.windows.find((w) => w.scope === "5h");
    expect(coreFiveHour).toEqual({ scope: "5h", usedPct: 0 });
  });

  it("windowEnd as a number: >1e12 is ms, otherwise seconds", () => {
    const raw = {
      limits: {
        standard: {
          fiveHour: { usedPercent: 12, windowEnd: FUTURE },
          weekly: { usedPercent: 34, windowEnd: Math.floor(FUTURE / 1000) },
        },
      },
    };
    const parsed = parseFactoryLimits(raw, NOW);
    expect(parsed?.standard?.windows).toEqual([
      { scope: "5h", usedPct: 12, resetAt: FUTURE },
      { scope: "week", usedPct: 34, resetAt: Math.floor(FUTURE / 1000) * 1000 },
    ]);
  });

  it("windowEnd in the past ⇒ inactive window (0%, no resetAt)", () => {
    const raw = {
      limits: { standard: { fiveHour: { usedPercent: 88, windowEnd: NOW - 1_000 } } },
    };
    const parsed = parseFactoryLimits(raw, NOW);
    expect(parsed?.standard?.windows).toEqual([{ scope: "5h", usedPct: 0 }]);
  });

  it("windowEnd missing but secondsRemaining > 0 ⇒ resetAt = now + seconds", () => {
    const raw = {
      limits: { core: { weekly: { usedPercent: 41, secondsRemaining: 90 } } },
    };
    const parsed = parseFactoryLimits(raw, NOW);
    expect(parsed?.core?.windows).toEqual([{ scope: "week", usedPct: 41, resetAt: NOW + 90_000 }]);
  });

  it("windowEnd as an ISO string ⇒ Date.parse", () => {
    const iso = new Date(FUTURE).toISOString();
    const raw = { limits: { standard: { monthly: { usedPercent: 7, windowEnd: iso } } } };
    const parsed = parseFactoryLimits(raw, NOW);
    expect(parsed?.standard?.windows).toEqual([{ scope: "month", usedPct: 7, resetAt: FUTURE }]);
  });

  it("missing/non-object limits ⇒ undefined; empty pools ⇒ undefined", () => {
    expect(parseFactoryLimits(undefined, NOW)).toBeUndefined();
    expect(parseFactoryLimits(null, NOW)).toBeUndefined();
    expect(parseFactoryLimits("x", NOW)).toBeUndefined();
    expect(parseFactoryLimits({}, NOW)).toBeUndefined();
    expect(parseFactoryLimits({ limits: "nope" }, NOW)).toBeUndefined();
    expect(parseFactoryLimits({ limits: { standard: {}, core: {} } }, NOW)).toBeUndefined();
  });

  it("skips windows whose usedPercent is not a finite number; clamps negative percent to 0", () => {
    const raw = {
      limits: {
        standard: {
          fiveHour: { usedPercent: Number.NaN, windowEnd: FUTURE },
          weekly: { usedPercent: "high", windowEnd: FUTURE },
          monthly: { usedPercent: -3, windowEnd: FUTURE },
        },
      },
    };
    const parsed = parseFactoryLimits(raw, NOW);
    expect(parsed?.standard?.windows).toEqual([{ scope: "month", usedPct: 0, resetAt: FUTURE }]);
  });

  it("overage: only droidCore/extraUsage are recognized; anything else ⇒ off", () => {
    for (const [raw, want] of [
      ["droidCore", "droidCore"],
      ["extraUsage", "extraUsage"],
      ["blocked", "off"],
      [undefined, "off"],
      [42, "off"],
    ] as const) {
      const parsed = parseFactoryLimits(
        { overagePreference: raw, limits: { standard: { fiveHour: { usedPercent: 1, windowEnd: FUTURE } } } },
        NOW,
      );
      expect(parsed?.standard?.billing?.overage).toBe(want);
    }
  });

  it("overage: legacy `overage` name is a fallback; overagePreference wins", () => {
    const limits = { standard: { fiveHour: { usedPercent: 1, windowEnd: FUTURE } } };
    const ov = (root: Record<string, unknown>) =>
      parseFactoryLimits({ ...root, limits }, NOW)?.standard?.billing?.overage;
    expect(ov({ overage: "extraUsage" })).toBe("extraUsage");
    expect(ov({ overagePreference: "droidCore", overage: "extraUsage" })).toBe("droidCore");
    expect(ov({ overagePreference: "bogus", overage: "extraUsage" })).toBe("off");
  });

  it("extraUsageBalanceCents: negative/NaN/non-number ⇒ clamped to 0; rounds to integer cents", () => {
    const base = { limits: { core: { weekly: { usedPercent: 1, windowEnd: FUTURE } } } };
    expect(
      parseFactoryLimits({ ...base, extraUsageBalanceCents: -50 }, NOW)?.core?.billing?.extraUsageBalanceCents,
    ).toBe(0);
    expect(
      parseFactoryLimits({ ...base, extraUsageBalanceCents: Number.NaN }, NOW)?.core?.billing?.extraUsageBalanceCents,
    ).toBe(0);
    expect(parseFactoryLimits(base, NOW)?.core?.billing?.extraUsageBalanceCents).toBe(0);
    expect(
      parseFactoryLimits({ ...base, extraUsageBalanceCents: 99.6 }, NOW)?.core?.billing?.extraUsageBalanceCents,
    ).toBe(100);
  });
});

describe("createDroidAdapters", () => {
  it("sends Bearer auth + User-Agent to {baseUrl}/api/billing/limits", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const pair = createDroidAdapters({ isActive: () => true });
    const payload = loadFixture("factory-limits-zero.json");
    await pair.standard.fetchQuota(
      deps({
        baseUrl: "https://factory.internal",
        fetchJson: async (url, init) => {
          calls.push({ url, headers: { ...init.headers } });
          return payload;
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://factory.internal${FACTORY_LIMITS_PATH}`);
    expect(calls[0]?.headers.Authorization).toBe("Bearer factory-key-SECRET");
    expect(calls[0]?.headers["User-Agent"]).toBe("test-agent");
  });

  it("no key ⇒ no request at all (both pools)", async () => {
    const fetchJson = vi.fn(async () => undefined);
    const pair = createDroidAdapters({ isActive: () => true });
    expect(await pair.standard.fetchQuota(deps({ apiKey: undefined, fetchJson }))).toBeUndefined();
    expect(await pair.core.fetchQuota(deps({ apiKey: "", fetchJson }))).toBeUndefined();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("both pools in one pass share a single request (inflight is assigned synchronously before the first await)", async () => {
    let fetches = 0;
    let release!: (value: unknown) => void;
    const pair = createDroidAdapters({ isActive: () => true });
    const fetchJson = vi.fn(
      () =>
        new Promise<unknown>((res) => {
          fetches += 1;
          release = res;
        }),
    );
    // 同 pass 串行调用（service 语义）：第二个 fetchQuota 启动时第一个尚未落地。
    const p1 = pair.standard.fetchQuota(deps({ fetchJson }));
    const p2 = pair.core.fetchQuota(deps({ fetchJson }));
    expect(fetches).toBe(1); // inflight 已同步挂上 ⇒ 第二次调用直接搭车
    release(loadFixture("factory-limits-zero.json"));
    const [standard, core] = await Promise.all([p1, p2]);
    expect(fetches).toBe(1);
    expect(standard?.provider).toBe("droid-standard");
    expect(core?.provider).toBe("droid-core");
  });

  it("coalesces a second pass within DROID_COALESCE_MS without a new request", async () => {
    let fetches = 0;
    let now = NOW;
    const pair = createDroidAdapters({ isActive: () => true });
    const fetchJson = vi.fn(async () => {
      fetches += 1;
      return loadFixture("factory-limits-zero.json");
    });
    await pair.standard.fetchQuota(deps({ fetchJson, now: () => now }));
    now += DROID_COALESCE_MS - 1;
    await pair.core.fetchQuota(deps({ fetchJson, now: () => now }));
    expect(fetches).toBe(1);
    now += 2; // 超出合并窗口 ⇒ 重新请求
    await pair.core.fetchQuota(deps({ fetchJson, now: () => now }));
    expect(fetches).toBe(2);
  });

  it("401/402/403 ⇒ lastProblem + per-status warnOnce (never containing the key); success clears it", async () => {
    const warnings: string[] = [];
    // coalesceMs: 0 —— 每条用例都要独立发起请求（合并窗口会搭车，不触发 onHttpError）。
    const pair = createDroidAdapters({ isActive: () => true, warn: (m) => warnings.push(m), coalesceMs: 0 });
    for (const status of [401, 402, 403, 401]) {
      const fetchJson: AdapterDeps["fetchJson"] = async (_url, init) => {
        init.onHttpError?.(status);
        return undefined;
      };
      expect(await pair.standard.fetchQuota(deps({ fetchJson }))).toBeUndefined();
      expect(pair.standard.lastProblem?.()).toEqual({ family: "droid", status });
    }
    expect(warnings).toHaveLength(3); // 同一状态码只告警一次（401 第二次不重复）
    for (const w of warnings) expect(w).not.toContain("factory-key-SECRET");
    expect(warnings.join("\n")).not.toContain("Bearer factory");
    // 成功后清除 problem。
    const ok: AdapterDeps["fetchJson"] = async () => loadFixture("factory-limits-zero.json");
    expect(await pair.standard.fetchQuota(deps({ fetchJson: ok }))).toBeDefined();
    expect(pair.standard.lastProblem?.()).toBeUndefined();
    expect(pair.core.lastProblem?.()).toBeUndefined();
  });

  it("health evidence is independent of warnOnce; only a parsed success clears it; observers cannot break fetch", async () => {
    const observed = vi.fn();
    const pair = createDroidAdapters({ isActive: () => true, onAvailability: observed, coalesceMs: 0 });
    const denied: AdapterDeps["fetchJson"] = async (_url, init) => {
      init.onHttpError?.(401);
      return undefined;
    };
    await pair.standard.fetchQuota(deps({ fetchJson: denied }));
    await pair.core.fetchQuota(deps({ fetchJson: denied }));
    expect(observed.mock.calls).toEqual([[{ family: "droid", status: 401 }], [{ family: "droid", status: 401 }]]);
    await pair.standard.fetchQuota(deps({ fetchJson: async () => ({ limits: {} }) }));
    expect(observed).toHaveBeenCalledTimes(2); // malformed/failed requests never recover auth
    const payload = loadFixture("factory-limits-zero.json");
    expect(await pair.standard.fetchQuota(deps({ fetchJson: async () => payload }))).toBeDefined();
    expect(observed.mock.calls[2]).toEqual([undefined]);
    const throwing = createDroidAdapters({
      isActive: () => true,
      onAvailability: () => {
        throw new Error("observer");
      },
    });
    expect(await throwing.standard.fetchQuota(deps({ fetchJson: async () => payload }))).toMatchObject({
      provider: "droid-standard",
    });
  });

  it("lastProblem is shared by the pair and visible on the core adapter too", async () => {
    const pair = createDroidAdapters({ isActive: () => true });
    const fetchJson: AdapterDeps["fetchJson"] = async (_url, init) => {
      init.onHttpError?.(402);
      return undefined;
    };
    await pair.core.fetchQuota(deps({ fetchJson }));
    expect(pair.standard.lastProblem?.()).toEqual({ family: "droid", status: 402 });
  });

  it("an injected fetchJson that throws never escapes fetchQuota", async () => {
    // coalesceMs: 0 —— 本条验证的是抛错后的重试，不蹈合并窗口。
    const pair = createDroidAdapters({ isActive: () => true, coalesceMs: 0 });
    const fetchJson: AdapterDeps["fetchJson"] = async () => {
      throw new Error("boom");
    };
    await expect(pair.standard.fetchQuota(deps({ fetchJson }))).resolves.toBeUndefined();
    // 抛错落地后 inflight 已清理 ⇒ 下一次调用重新发起。
    let called = 0;
    await pair.standard.fetchQuota(
      deps({
        fetchJson: async () => {
          called += 1;
          return loadFixture("factory-limits-zero.json");
        },
      }),
    );
    expect(called).toBe(1);
  });

  it("isActive is surfaced verbatim for the service gate (inactive ⇒ service skips before reading credentials)", () => {
    let active = false;
    const pair = createDroidAdapters({ isActive: () => active });
    expect(pair.standard.isActive?.()).toBe(false);
    active = true;
    expect(pair.core.isActive?.()).toBe(true);
  });

  it("402 end-to-end through createFetchJson: onHttpError fires once at the final failure with the status", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Organization does not have an active paid subscription", { status: 402 }),
    );
    const fetchJson = createFetchJson({ fetchImpl: fetchImpl as unknown as typeof fetch, warn: () => undefined });
    const pair = createDroidAdapters({ isActive: () => true, warn: () => undefined });
    const snapshot = await pair.standard.fetchQuota(deps({ fetchJson }));
    expect(snapshot).toBeUndefined();
    expect(pair.standard.lastProblem?.()).toEqual({ family: "droid", status: 402 });
  });
});
