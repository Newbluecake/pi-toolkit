/**
 * opencode-go 适配器测试（docs/dev/quota/README.md）：解析（rolling/weekly/monthly
 * ⇒ 5h/week/month）+ percent clamp + resetsAt ISO→ms + 全 typeof 守卫（形状不符/异常
 * 一律 undefined，绝不抛）+ 无 key 零请求。端点契约见 src/quota/adapters/opencode.ts
 * 头注释（2026-11-03 真实 key 实测）。
 */
import { describe, expect, it } from "vitest";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_USAGE_PATH,
  opencodeGoAdapter,
  parseOpencodeGoQuota,
} from "../../src/quota/adapters/opencode.js";
import type { AdapterDeps } from "../../src/quota/adapters/types.js";

const NOW = 1_790_000_000_000;
const ROLLING_RESET = "2026-11-03T19:00:00.000Z";
const WEEKLY_RESET = "2026-11-09T00:00:00.000Z";
const MONTHLY_RESET = "2026-12-01T00:00:00.000Z";

/** 实测响应形状（percent 值换成有区分度的样本）。 */
function sampleRaw(): unknown {
  return {
    usage: {
      rolling: { status: "ok", percent: 12.4, resetsAt: ROLLING_RESET },
      weekly: { status: "ok", percent: 55.6, resetsAt: WEEKLY_RESET },
      monthly: { status: "ok", percent: 3, resetsAt: MONTHLY_RESET },
    },
  };
}

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
    apiKey: "sk-opencode-test",
    now: () => NOW,
    baseUrl: "https://quota.example.test",
    userAgent: "Mozilla/5.0 (test) Chrome/128.0 Safari/537.36",
    ...overrides,
  };
  return { deps, calls };
}

describe("parseOpencodeGoQuota", () => {
  it("parses the sampled response: rolling→5h, weekly→week, monthly→month", () => {
    const snapshot = parseOpencodeGoQuota(sampleRaw(), NOW);
    expect(snapshot).toEqual({
      provider: "opencode-go",
      kind: "windows",
      windows: [
        { scope: "5h", usedPct: 12, resetAt: Date.parse(ROLLING_RESET) },
        { scope: "week", usedPct: 56, resetAt: Date.parse(WEEKLY_RESET) },
        { scope: "month", usedPct: 3, resetAt: Date.parse(MONTHLY_RESET) },
      ],
      fetchedAt: NOW,
    });
  });

  it("maps resetsAt ISO strings to Date.parse epoch ms", () => {
    const windows = parseOpencodeGoQuota(sampleRaw(), NOW)?.windows ?? [];
    expect(windows[0]?.resetAt).toBe(Date.parse(ROLLING_RESET));
    expect(windows[1]?.resetAt).toBe(Date.parse(WEEKLY_RESET));
    expect(windows[2]?.resetAt).toBe(Date.parse(MONTHLY_RESET));
  });

  it("clamps percent to 0..100 and rounds", () => {
    const snapshot = parseOpencodeGoQuota(
      {
        usage: {
          rolling: { status: "ok", percent: 140, resetsAt: ROLLING_RESET },
          weekly: { status: "ok", percent: -5, resetsAt: WEEKLY_RESET },
        },
      },
      NOW,
    );
    expect(snapshot?.windows.map((w) => [w.scope, w.usedPct])).toEqual([
      ["5h", 100],
      ["week", 0],
    ]);
  });

  it("omits resetAt when resetsAt is missing or unparseable", () => {
    const snapshot = parseOpencodeGoQuota(
      {
        usage: {
          rolling: { status: "ok", percent: 10 },
          weekly: { status: "ok", percent: 20, resetsAt: "not-a-date" },
          monthly: { status: "ok", percent: 30, resetsAt: MONTHLY_RESET },
        },
      },
      NOW,
    );
    expect(snapshot?.windows).toEqual([
      { scope: "5h", usedPct: 10 },
      { scope: "week", usedPct: 20 },
      { scope: "month", usedPct: 30, resetAt: Date.parse(MONTHLY_RESET) },
    ]);
  });

  it("drops a malformed window but keeps the parseable ones", () => {
    const snapshot = parseOpencodeGoQuota(
      {
        usage: {
          rolling: { status: "ok", percent: "12", resetsAt: ROLLING_RESET }, // 字符串 percent ⇒ 丢
          weekly: null, // 非 record ⇒ 丢
          monthly: { status: "ok", percent: 7, resetsAt: MONTHLY_RESET },
        },
      },
      NOW,
    );
    expect(snapshot?.windows).toEqual([{ scope: "month", usedPct: 7, resetAt: Date.parse(MONTHLY_RESET) }]);
  });

  it("returns undefined when no window parses or the shape is off — never throws", () => {
    for (const raw of [
      undefined,
      null,
      0,
      "nope",
      true,
      [],
      {},
      { usage: null },
      { usage: [] },
      { usage: {} },
      { usage: { rolling: {}, weekly: {}, monthly: {} } },
      { usage: { rolling: { percent: Number.NaN } } },
      { usage: { rolling: { percent: Number.POSITIVE_INFINITY } } },
    ]) {
      expect(() => parseOpencodeGoQuota(raw, NOW)).not.toThrow();
      expect(parseOpencodeGoQuota(raw, NOW)).toBeUndefined();
    }
  });
});

describe("opencodeGoAdapter", () => {
  it("has the pinned identity (id/kind/defaultBaseUrl)", () => {
    expect(opencodeGoAdapter.id).toBe("opencode-go");
    expect(opencodeGoAdapter.kind).toBe("windows");
    expect(opencodeGoAdapter.defaultBaseUrl).toBe(OPENCODE_GO_BASE_URL);
    expect(opencodeGoAdapter.defaultBaseUrl).toBe("https://opencode.ai");
  });

  it("GETs {baseUrl}/zen/go/v1/usage with a Bearer token", async () => {
    const { deps, calls } = makeDeps(sampleRaw());
    const snapshot = await opencodeGoAdapter.fetchQuota(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://quota.example.test${OPENCODE_GO_USAGE_PATH}`);
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-opencode-test");
    expect(snapshot?.provider).toBe("opencode-go");
    expect(snapshot?.windows).toHaveLength(3);
  });

  it("sends the configured User-Agent and none when it is the empty string", async () => {
    const withUa = makeDeps(sampleRaw());
    await opencodeGoAdapter.fetchQuota(withUa.deps);
    expect(withUa.calls[0]?.headers["User-Agent"]).toBe("Mozilla/5.0 (test) Chrome/128.0 Safari/537.36");
    const withoutUa = makeDeps(sampleRaw(), { userAgent: "" });
    await opencodeGoAdapter.fetchQuota(withoutUa.deps);
    expect(withoutUa.calls[0]?.headers["User-Agent"]).toBeUndefined();
  });

  it("never sends a request without a key (undefined / empty string)", async () => {
    for (const apiKey of [undefined, ""]) {
      const { deps, calls } = makeDeps(sampleRaw(), { apiKey });
      expect(await opencodeGoAdapter.fetchQuota(deps)).toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  });

  it("fetch failure / non-object payload ⇒ undefined, never throws", async () => {
    const failed = makeDeps(undefined);
    expect(await opencodeGoAdapter.fetchQuota(failed.deps)).toBeUndefined();
    const garbage = makeDeps({ usage: "nope" });
    expect(await opencodeGoAdapter.fetchQuota(garbage.deps)).toBeUndefined();
  });

  it("swallows an injected fetchJson throw (never-throws contract)", async () => {
    const { deps } = makeDeps(sampleRaw());
    const throwing: AdapterDeps = {
      ...deps,
      fetchJson: async () => {
        throw new Error("injected boom");
      },
    };
    expect(await opencodeGoAdapter.fetchQuota(throwing)).toBeUndefined();
  });

  it("passes the abort signal through when present", async () => {
    const controller = new AbortController();
    const { deps, calls } = makeDeps(sampleRaw(), { signal: controller.signal });
    await opencodeGoAdapter.fetchQuota(deps);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
