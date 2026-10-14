/**
 * external-agent quota-plan r2 §9A.4 / §11（P7wa wiring）：`wireWebHub` + 假连接 ——
 * `hello_ack.caps ∋ quota.pools.v1` 决定 droid 行 / month / billing / problems 是否上
 * `StatusInfo.quota`；重连到带 cap 的新 hub ⇒ 下一个 1Hz tick 的指纹门控自动发布新帧；
 * `quotaProblems` getter 抛错 ⇒ 视为无 problems（不拖垮 status）。纯投影语义（id 守卫、
 * billing 字段、problems 截断、字节不变）由 quota-sampler.test.ts 钉住，这里只证装配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import { QUOTA_POOLS_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
import type { ProviderVerdict, WindowVerdict } from "../../../src/quota/ladder.js";
import type { QuotaProblem } from "../../../src/quota/types.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-qp-");
  resetGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

function window(over: Partial<WindowVerdict> = {}): WindowVerdict {
  return { scope: "5h", usedPct: 10, level: 0, reason: "none", ...over };
}

const kimi: ProviderVerdict = {
  provider: "kimi-coding",
  level: 1,
  windows: [window({ scope: "week", usedPct: 55, level: 1 })],
  demoted: false,
  fetchedAt: 1_000,
  stale: false,
};
const droidStd: ProviderVerdict = {
  provider: "droid-standard",
  level: 3,
  windows: [
    window({ scope: "5h", usedPct: 100, level: 3, reason: "exhausted" }),
    window({ scope: "month", usedPct: 88, level: 2, resetAt: 9_000 }),
  ],
  demoted: false,
  fetchedAt: 1_000,
  stale: false,
  billing: {
    kind: "factory",
    pool: "standard",
    overage: "extraUsage",
    extraUsageAllowed: true,
    extraUsageBalanceCents: 1_234,
    gateOpen: true,
  },
};
const droidCore: ProviderVerdict = {
  provider: "droid-core",
  level: 0,
  windows: [window({ scope: "month", usedPct: 3 })],
  demoted: false,
  fetchedAt: 1_000,
  stale: false,
};

interface Knobs {
  verdicts: ProviderVerdict[];
  problems: QuotaProblem[];
  problemsThrow: boolean;
}
const knobs = (): Knobs => ({ verdicts: [droidStd, kimi, droidCore], problems: [], problemsThrow: false });

function quotaDeps(k: Knobs): { quota: () => ProviderVerdict[]; quotaProblems: () => QuotaProblem[] } {
  return {
    quota: () => k.verdicts,
    quotaProblems: () => {
      if (k.problemsThrow) throw new Error("boom");
      return k.problems;
    },
  };
}

type Sock = ReturnType<typeof fakeNet>["sockets"][number];

async function start(extra: Partial<WebHubDeps>, caps?: string[]): Promise<{ n: ReturnType<typeof fakeNet>; s: Sock }> {
  const n = fakeNet();
  const { pi, fire } = fakePi();
  wireWebHub(pi, deps({ netConnect: n.netConnect, ...extra }));
  const { ctx } = fakeCtx({ mode: "tui" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await vi.advanceTimersByTimeAsync(0);
  const s = n.sockets[0]!;
  s.emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  s.hub(ackFrame("a1-quotaaa", 4242, caps));
  await vi.advanceTimersByTimeAsync(0);
  return { n, s };
}

async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
  }
}

type QuotaFrame = {
  quota?: {
    providers?: Array<{ id: string; windows?: Array<{ scope: string }>; billing?: Record<string, unknown> }>;
    problems?: Array<{ family: string; status: number }>;
  };
};
const statusFrames = (s: Sock) => s.frames().filter((f) => f.t === "status") as QuotaFrame[];
const lastQuota = (s: Sock) => statusFrames(s).at(-1)?.quota;

describe("quota pools cap gating (P7wa, §9A.4)", () => {
  it("hub WITHOUT quota.pools.v1 ⇒ no droid rows / month / billing / problems on any frame", async () => {
    const k = knobs();
    k.problems = [{ family: "droid", status: 402 }];
    const { s } = await start(quotaDeps(k), ["cmd.v1"]); // live, no quota.pools.v1
    await tick(3);
    const quota = lastQuota(s)!;
    expect(quota).toBeDefined();
    expect(quota.providers?.map((p) => p.id)).toEqual(["kimi-coding"]);
    for (const f of statusFrames(s)) {
      expect(JSON.stringify(f.quota)).not.toContain("droid");
      expect(JSON.stringify(f.quota)).not.toContain("month");
      expect(JSON.stringify(f.quota)).not.toContain("billing");
      expect(JSON.stringify(f.quota)).not.toContain("problems");
    }
  });

  it("hub WITH quota.pools.v1 ⇒ droid rows (incl. month), billing, problems ride the frame", async () => {
    const k = knobs();
    k.problems = [
      { family: "droid", status: 402 },
      { family: "other", status: 401 },
    ];
    const { s } = await start(quotaDeps(k), [QUOTA_POOLS_HUB_CAP]);
    await tick(2);
    const quota = lastQuota(s)!;
    expect(quota.providers?.map((p) => p.id)).toEqual(["droid-standard", "kimi-coding", "droid-core"]);
    expect(quota.providers?.[0]?.windows?.map((w) => w.scope)).toEqual(["5h", "month"]);
    expect(quota.providers?.[0]?.billing).toEqual({
      overage: "extraUsage",
      extraUsageBalanceCents: 1_234,
      gateOpen: true,
    });
    expect(quota.problems).toEqual([{ family: "droid", status: 402 }]); // 非 droid family 被丢弃
  });

  it("cap appears on reconnect ⇒ the next tick publishes the droid frame (fingerprint flip)", async () => {
    const k = knobs();
    k.problems = [{ family: "droid", status: 402 }];
    const { n, s } = await start(quotaDeps(k), ["cmd.v1"]);
    await tick(1);
    expect(lastQuota(s)?.providers?.map((p) => p.id)).toEqual(["kimi-coding"]); // legacy first

    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700); // past connection.ts's 0.5s±20% backoff
    const s2 = n.sockets.at(-1)!;
    expect(s2).not.toBe(s);
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-quotaaa", 4242, [QUOTA_POOLS_HUB_CAP])); // upgraded hub
    await tick(2);
    const quota = lastQuota(s2)!;
    expect(quota.providers?.map((p) => p.id)).toEqual(["droid-standard", "kimi-coding", "droid-core"]);
    expect(quota.problems).toEqual([{ family: "droid", status: 402 }]);
  });

  it("cap disappears on reconnect ⇒ the projection folds back to the legacy shape", async () => {
    const k = knobs();
    const { n, s } = await start(quotaDeps(k), [QUOTA_POOLS_HUB_CAP]);
    await tick(1);
    expect(lastQuota(s)?.providers?.map((p) => p.id)).toEqual(["droid-standard", "kimi-coding", "droid-core"]);

    s.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(700);
    const s2 = n.sockets.at(-1)!;
    s2.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    s2.hub(ackFrame("a1-quotaaa", 4242, ["cmd.v1"])); // downgraded hub
    await tick(2);
    expect(lastQuota(s2)?.providers?.map((p) => p.id)).toEqual(["kimi-coding"]);
  });

  it("quotaProblems getter throwing ⇒ treated as no problems; the status frame survives", async () => {
    const k = knobs();
    k.problemsThrow = true;
    const { s } = await start(quotaDeps(k), [QUOTA_POOLS_HUB_CAP]);
    await tick(3);
    const quota = lastQuota(s)!;
    expect(quota.providers?.map((p) => p.id)).toEqual(["droid-standard", "kimi-coding", "droid-core"]);
    expect(quota.problems).toBeUndefined();
    k.problemsThrow = false;
    k.problems = [{ family: "droid", status: 401 }];
    await tick(1);
    expect(lastQuota(s)?.problems).toEqual([{ family: "droid", status: 401 }]);
  });

  it("problems-only (verdicts getter empty) ⇒ quota frame carries providers:[] + problems", async () => {
    const k = knobs();
    k.verdicts = [];
    k.problems = [{ family: "droid", status: 402 }];
    const { s } = await start(quotaDeps(k), [QUOTA_POOLS_HUB_CAP]);
    await tick(2);
    const quota = lastQuota(s)!;
    expect(quota.providers).toEqual([]);
    expect(quota.problems).toEqual([{ family: "droid", status: 402 }]);
  });

  it("no quota deps ⇒ the field never appears", async () => {
    const { s } = await start({}, [QUOTA_POOLS_HUB_CAP]);
    await tick(2);
    for (const f of statusFrames(s)) expect("quota" in f).toBe(false);
  });
});
