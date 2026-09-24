// quota-plan §9.2 service.test.ts — QuotaService（§3.8）：TTL 缓存、在途去重、
// 静默降级隔离、同步 verdicts、刷新落地 mark 降位、观测重置 clear + 清环、
// setStatus 生命周期、M3 dispose 单一所有者（幂等 / 在途防护）、零 timer。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_SETTINGS, type QuotaSettings } from "../../src/config/settings.js";
import { createDemotionStore, type DemotionStore } from "../../src/quota/demotion.js";
import { createQuotaService, type QuotaService } from "../../src/quota/service.js";
import type { QuotaRecoveryEvent } from "../../src/quota/ladder.js";
import type { ProviderAdapter, QuotaProviderId, QuotaSnapshot, QuotaWindowsSnapshot } from "../../src/quota/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-quota-service-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 可编程桩 adapter：set() 换实现，fetches() 计数（无实现时返回 undefined）。 */
interface Stub {
  readonly adapter: ProviderAdapter;
  set(impl: () => Promise<QuotaSnapshot | undefined> | QuotaSnapshot | undefined): void;
  fetches(): number;
}

function stubAdapter(id: QuotaProviderId): Stub {
  let impl: (() => Promise<QuotaSnapshot | undefined> | QuotaSnapshot | undefined) | undefined = undefined;
  let count = 0;
  return {
    adapter: {
      id,
      kind: "windows",
      fetchQuota: async () => {
        count += 1;
        return impl === undefined ? undefined : await impl();
      },
    },
    set: (next) => {
      impl = next;
    },
    fetches: () => count,
  };
}

function windowsSnapshot(
  provider: QuotaProviderId,
  windows: readonly { scope: "5h" | "week"; usedPct: number; resetAt?: number }[],
  fetchedAt: number,
): QuotaWindowsSnapshot {
  return {
    provider,
    kind: "windows",
    windows: windows.map((w) => ({
      scope: w.scope,
      usedPct: w.usedPct,
      ...(w.resetAt === undefined ? {} : { resetAt: w.resetAt }),
    })),
    fetchedAt,
  };
}

interface Fixture {
  readonly clock: FakeClock;
  readonly service: QuotaService;
  readonly demotions: DemotionStore;
  readonly zai: Stub;
  readonly kimi: Stub;
  readonly setStatus: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  /** onObservedReset 的默认收集器（额度恢复播报）；自定义回调时恒空。 */
  readonly events: QuotaRecoveryEvent[];
}

function makeFixture(
  settingsOver: Partial<QuotaSettings> = {},
  onObservedReset?: (event: QuotaRecoveryEvent) => void,
): Fixture {
  const clock = new FakeClock(1_000);
  const settings: QuotaSettings = { ...DEFAULT_SETTINGS.quota, ...settingsOver };
  const zai = stubAdapter("zai-coding-cn");
  const kimi = stubAdapter("kimi-coding");
  const setStatus = vi.fn();
  const warn = vi.fn();
  const events: QuotaRecoveryEvent[] = [];
  const demotions = createDemotionStore({ path: join(dir, "quota-state.json"), now: () => clock.now(), warn });
  const service = createQuotaService({
    settings,
    clock,
    adapters: [zai.adapter, kimi.adapter],
    credentials: () => "sk-test",
    fetchJson: async () => undefined,
    demotions,
    setStatus,
    warn,
    onObservedReset: onObservedReset ?? ((event) => events.push(event)),
  });
  return { clock, service, demotions, zai, kimi, setStatus, warn, events };
}

describe("createQuotaService", () => {
  it("uses refreshHotMs for L1 providers while keeping cold providers on refreshMs", async () => {
    const f = makeFixture({ refreshHotMs: 120_000 });
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 50 }], f.clock.now()));
    f.kimi.set(() => windowsSnapshot("kimi-coding", [{ scope: "5h", usedPct: 10 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(120_001);
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(2);
    expect(f.kimi.fetches()).toBe(1);
  });

  it("uses refreshHotMs when forecast ETA is below one hour even below the L1 percentage", async () => {
    const f = makeFixture({ refreshHotMs: 120_000, l1Percent: 95, l2Percent: 96, l3Percent: 97 });
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 10 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(DEFAULT_SETTINGS.quota.refreshMs);
    // 10% → 25% over refreshMs (10 min) ⇒ 1.5%/min, 75% left ⇒ ETA 50 min: inside the
    // 1h hot window but above the 30-min l3EtaMs escalation, so only the ETA branch
    // (not a level ≥ 1) can make this provider hot.
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 25 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(120_001);
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(3);
  });

  it("refreshIfStale fetches every adapter once, and the TTL window suppresses re-fetches", async () => {
    const f = makeFixture();
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 10 }], f.clock.now()));
    f.kimi.set(() => windowsSnapshot("kimi-coding", [{ scope: "5h", usedPct: 5 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(1);
    expect(f.kimi.fetches()).toBe(1);
    f.service.refreshIfStale(); // TTL 内 ⇒ 空转
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(1);
    expect(f.kimi.fetches()).toBe(1);
    f.clock.advance(DEFAULT_SETTINGS.quota.refreshMs); // 恰好到 TTL 边界 ⇒ 重新拉
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(2);
    // 无凭据/失败（impl 缺省 ⇒ undefined）后按 refreshMs 退避，不被每轮 turn 撞击。
    const g = makeFixture();
    g.service.refreshIfStale();
    await g.service.whenIdle();
    expect(g.zai.fetches()).toBe(1); // 失败，无快照
    g.clock.advance(DEFAULT_SETTINGS.quota.refreshMs - 1);
    g.service.refreshIfStale();
    await g.service.whenIdle();
    expect(g.zai.fetches()).toBe(1); // 退避期内不重试
    g.clock.advance(1);
    g.service.refreshIfStale();
    await g.service.whenIdle();
    expect(g.zai.fetches()).toBe(2);
  });

  it("dedupes in-flight refreshes per provider (two calls, one round-trip)", async () => {
    const f = makeFixture();
    let release!: (snapshot: QuotaSnapshot) => void;
    f.zai.set(
      () =>
        new Promise<QuotaSnapshot>((resolve) => {
          release = (snapshot) => resolve(snapshot);
        }),
    );
    f.service.refreshIfStale();
    f.service.refreshIfStale(); // 在途 ⇒ 直接空转
    expect(f.zai.fetches()).toBe(1);
    release(windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 20 }], f.clock.now()));
    await f.service.whenIdle();
    expect(f.service.verdictFor("zai-coding-cn")?.level).toBe(0);
    expect(f.zai.fetches()).toBe(1);
  });

  it("isolates a throwing / undefined adapter: the other provider's snapshot still lands", async () => {
    const f = makeFixture();
    f.zai.set(() => Promise.reject(new Error("boom")));
    f.kimi.set(() => windowsSnapshot("kimi-coding", [{ scope: "5h", usedPct: 8 }], f.clock.now()));
    expect(() => f.service.refreshIfStale()).not.toThrow();
    await f.service.whenIdle();
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("zai-coding-cn refresh failed"));
    expect(f.service.verdicts().map((v) => v.provider)).toEqual(["kimi-coding"]);
    // verdicts() 是同步的：无 await 也直接得到数组。
    expect(Array.isArray(f.service.verdicts())).toBe(true);
  });

  it("verdicts() is synchronous and returns [] before any snapshot lands", () => {
    const f = makeFixture();
    expect(f.service.verdicts()).toEqual([]);
    expect(f.service.verdictFor("zai-coding-cn")).toBeUndefined();
    expect(f.service.verdictFor("not-a-provider")).toBeUndefined();
    expect(f.setStatus).toHaveBeenCalledWith(undefined); // 创建时清占位（§7）
  });

  it("marks the demotion on landing when the verdict reaches level >= 2", async () => {
    const f = makeFixture();
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 95, resetAt: 50_000 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    const record = f.demotions.get("zai-coding-cn", f.clock.now());
    expect(record).toMatchObject({ level: 3, expiresAt: 50_000 }); // 最早触发窗口 resetAt
    const verdict = f.service.verdictFor("zai-coding-cn");
    expect(verdict?.level).toBe(3);
    expect(verdict?.demoted).toBe(true);
  });

  it("observed reset clears the demotion and the sample rings (eta probe)", async () => {
    // l3EtaMs=0 ⇒ forecast 不按 ETA 硬线抬级，etaMs 只作环探针。窗口重置时刻 R 落在第 3、4 次
    // 拉取之间：第 4 次拉取时旧 resetAt 已过——这是观测重置的「证据」（2026-09 修订：无证据的
    // 回落会被当作可疑读数拒收，见下方 anomaly-guard 用例）。
    const f = makeFixture({ l3EtaMs: 0 });
    const t0 = f.clock.now();
    const R = t0 + 1_500_000; // t0+25min
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60, resetAt: R }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(600_000); // 10min
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 80, resetAt: R }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    // 80% ⇒ L2 只提示、不降位（订阅优先用完）；环 [60@t0, 80@t1] ⇒ eta = (100-80)/(20/10min) = 10min。
    expect(f.demotions.get("zai-coding-cn", f.clock.now())).toBeUndefined();
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(600_000);
    f.clock.advance(600_000);
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 92, resetAt: R }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    // 92% ⇒ L3 ⇒ 降位标记；环 [60@t0, 92@t2] ⇒ eta = (100-92)/(32/20min) = 5min。
    expect(f.demotions.get("zai-coding-cn", f.clock.now())?.level).toBe(3);
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(300_000);
    f.clock.advance(600_000); // t3 = t0+30min > R
    f.zai.set(() =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 5, resetAt: R + 18_000_000 }], f.clock.now()),
    );
    f.service.refreshIfStale();
    await f.service.whenIdle();
    // 92→5（≥15）且旧 resetAt 已过 ⇒ 观测重置：clear 降位 + 清环。
    expect(f.demotions.get("zai-coding-cn", f.clock.now())).toBeUndefined();
    const after = f.service.verdictFor("zai-coding-cn");
    expect(after?.level).toBe(0);
    expect(after?.demoted).toBe(false);
    expect(after?.windows[0]?.usedPct).toBe(5);
    expect(after?.windows[0]?.etaMs).toBeUndefined(); // 环只剩 1 个样本 ⇒ too-few
  });

  it("writes the HUD line after a landing and clears it on dispose", async () => {
    const f = makeFixture();
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 10 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.setStatus).toHaveBeenLastCalledWith("quota zai 10%");
    f.service.dispose();
    expect(f.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("stops issuing requests after dispose", async () => {
    const f = makeFixture();
    f.service.dispose();
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.zai.fetches()).toBe(0);
    expect(f.kimi.fetches()).toBe(0);
  });

  it("creates zero timers over its whole lifecycle (FakeClock.pendingTimers === 0)", async () => {
    const f = makeFixture();
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 40 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(DEFAULT_SETTINGS.quota.refreshMs);
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.service.dispose();
    expect(f.clock.pendingTimers).toBe(0); // D2：零 setInterval/setTimeout
  });

  it("double dispose clears the status exactly once (M3)", async () => {
    const f = makeFixture();
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 10 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    const callsBeforeDispose = f.setStatus.mock.calls.length;
    f.service.dispose();
    f.service.dispose();
    const after = f.setStatus.mock.calls.slice(callsBeforeDispose);
    expect(after).toEqual([[undefined]]); // 恰一次、且只清一次
  });

  it("an in-flight refresh landing after dispose writes no status and no snapshot (M3)", async () => {
    const f = makeFixture();
    let release!: (snapshot: QuotaSnapshot) => void;
    f.zai.set(
      () =>
        new Promise<QuotaSnapshot>((resolve) => {
          release = (snapshot) => resolve(snapshot);
        }),
    );
    f.service.refreshIfStale();
    f.service.dispose();
    release(windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 30 }], f.clock.now()));
    await f.service.whenIdle();
    expect(f.setStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^quota /));
    expect(f.service.verdictFor("zai-coding-cn")).toBeUndefined();
    expect(f.demotions.list(f.clock.now())).toHaveLength(0);
  });
});

// 2026-09-24 kimi 现场：上游 502 风暴期间 /usages 短暂返回归零、无 resetAt 的窗口；
// 旧实现无条件接受 ⇒ 注入「5h 已用 0%，派单不变」、样本环被 0 污染（随后报出「100% 且
// 不足 1 分钟内耗尽」），若 5h 当时非 0 还会清掉降位。
describe("createQuotaService anomaly guard (drops need reset evidence)", () => {
  const HOUR = 3_600_000;
  const REFRESH = DEFAULT_SETTINGS.quota.refreshMs;

  async function land(f: Fixture, stub: Stub, snapshot: () => QuotaSnapshot): Promise<void> {
    stub.set(snapshot);
    f.service.refreshIfStale();
    await f.service.whenIdle();
  }

  /** kimi 现场形状：5h 空闲、7d 耗尽 ⇒ L3 + 降位至 7d 重置时刻。 */
  async function kimiExhausted(f: Fixture): Promise<{ r5h: number; rWeek: number; t0: number }> {
    const t0 = f.clock.now();
    const r5h = t0 + 3 * HOUR;
    const rWeek = t0 + 90 * HOUR;
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 0, resetAt: r5h },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    return { r5h, rWeek, t0 };
  }

  const zeroed = (f: Fixture) => (): QuotaSnapshot =>
    windowsSnapshot(
      "kimi-coding",
      [
        { scope: "5h", usedPct: 0 },
        { scope: "week", usedPct: 0 },
      ],
      f.clock.now(),
    );

  it("rejects a transient zeroed snapshot: snapshot, demotion and HUD stay put; warns once", async () => {
    const f = makeFixture();
    const { rWeek, t0 } = await kimiExhausted(f);
    expect(f.demotions.get("kimi-coding", f.clock.now())).toMatchObject({ level: 3, expiresAt: rWeek });
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed(f));
    const v = f.service.verdictFor("kimi-coding");
    expect(v?.fetchedAt).toBe(t0); // 快照未被替换
    expect(v?.windows.map((w) => w.usedPct)).toEqual([0, 100]);
    expect(v?.level).toBe(3);
    expect(v?.demoted).toBe(true);
    expect(v?.demotedUntil).toBe(rWeek);
    expect(f.demotions.get("kimi-coding", f.clock.now())).toMatchObject({ level: 3, expiresAt: rWeek });
    const warns = f.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("without reset evidence"));
    expect(warns).toEqual([expect.stringContaining("kimi-coding")]);
    expect(warns[0]).toContain("week 100%→0%");
    // 被拒后不在故障风暴里连撞端点：确认读数至少隔一个 refreshMs。
    const fetches = f.kimi.fetches();
    f.service.refreshIfStale();
    await f.service.whenIdle();
    expect(f.kimi.fetches()).toBe(fetches);
  });

  it("rejected reads never enter the forecast ring (eta keeps the pre-anomaly slope)", async () => {
    const f = makeFixture({ l3EtaMs: 0 });
    const reset = f.clock.now() + 4 * HOUR;
    const snap = (pct: number, resetAt?: number) => (): QuotaSnapshot =>
      windowsSnapshot(
        "zai-coding-cn",
        [resetAt === undefined ? { scope: "5h", usedPct: pct } : { scope: "5h", usedPct: pct, resetAt }],
        f.clock.now(),
      );
    await land(f, f.zai, snap(40, reset));
    f.clock.advance(REFRESH);
    await land(f, f.zai, snap(60, reset));
    // 环 [40@t0, 60@t1] ⇒ eta = (100-60)/(20/10min) = 20min
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(1_200_000);
    f.clock.advance(REFRESH);
    await land(f, f.zai, snap(0)); // 可疑：60→0，无 resetAt
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.usedPct).toBe(60);
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(1_200_000);
    f.clock.advance(REFRESH);
    await land(f, f.zai, snap(65, reset));
    // 环 [40@t0, 60@t1, 65@t3] ⇒ eta = (100-65)/(25/30min) = 42min；若 0 进过环则是 [0, 65] 的陡斜率。
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(2_520_000);
  });

  it("accepts the drop when the next read (one refresh later) repeats it — server-side early reset", async () => {
    const f = makeFixture();
    await kimiExhausted(f);
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed(f));
    expect(f.service.verdictFor("kimi-coding")?.level).toBe(3); // 第一次：拒收
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed(f));
    const v = f.service.verdictFor("kimi-coding");
    expect(v?.fetchedAt).toBe(f.clock.now());
    expect(v?.windows.map((w) => w.usedPct)).toEqual([0, 0]);
    expect(v?.level).toBe(0);
    expect(v?.demoted).toBe(false);
    expect(f.demotions.get("kimi-coding", f.clock.now())).toBeUndefined();
  });

  it("a normal read in between discards the pending suspect — a later anomaly is rejected afresh", async () => {
    const f = makeFixture();
    const { r5h, rWeek } = await kimiExhausted(f);
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed(f)); // 可疑
    f.clock.advance(REFRESH);
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 0, resetAt: r5h },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    ); // 正常读数落地
    const normalAt = f.clock.now();
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed(f)); // 新一轮异常：不能被上上次的可疑读数「确认」
    expect(f.service.verdictFor("kimi-coding")?.fetchedAt).toBe(normalAt);
    expect(f.service.verdictFor("kimi-coding")?.level).toBe(3);
    expect(f.demotions.get("kimi-coding", f.clock.now())?.level).toBe(3);
  });

  it("old resetAt already passed ⇒ immediate observed reset, demotion cleared", async () => {
    const f = makeFixture();
    const t0 = f.clock.now();
    f.demotions.mark("zai-coding-cn", 3, t0 + 48 * HOUR, t0); // 持久化的降位（跨进程遗留）
    await land(f, f.zai, () =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60, resetAt: t0 + 300_000 }], f.clock.now()),
    );
    expect(f.service.verdictFor("zai-coding-cn")?.demoted).toBe(true);
    f.clock.advance(REFRESH); // 越过旧 resetAt
    await land(f, f.zai, () => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 3 }], f.clock.now()));
    const v = f.service.verdictFor("zai-coding-cn");
    expect(v?.windows[0]?.usedPct).toBe(3);
    expect(v?.demoted).toBe(false);
    expect(f.demotions.get("zai-coding-cn", f.clock.now())).toBeUndefined();
  });

  it("resetAt moved forward ⇒ immediate observed reset even while another window stays idle", async () => {
    // kimi 形状：5h 恒 0（无法回落），7d 提前重置并给出新的重置时刻。旧规则要求「全部窗口
    // 回落」，此时降位永远清不掉；现在任一窗口有证据的重置即清。
    const f = makeFixture();
    const { r5h, rWeek } = await kimiExhausted(f);
    f.clock.advance(REFRESH);
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 0, resetAt: r5h },
          { scope: "week", usedPct: 2, resetAt: rWeek + 168 * HOUR },
        ],
        f.clock.now(),
      ),
    );
    const v = f.service.verdictFor("kimi-coding");
    expect(v?.windows.map((w) => w.usedPct)).toEqual([0, 2]);
    expect(v?.level).toBe(0);
    expect(f.demotions.get("kimi-coding", f.clock.now())).toBeUndefined();
    expect(f.warn).not.toHaveBeenCalledWith(expect.stringContaining("without reset evidence"));
  });

  it("a verified reset of one window re-marks the demotion when another window is still L3", async () => {
    const f = makeFixture();
    const t0 = f.clock.now();
    const rWeek = t0 + 90 * HOUR;
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 60, resetAt: t0 + 300_000 },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    f.clock.advance(REFRESH); // 5h 旧 resetAt 已过 ⇒ 5h 的回落有证据
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 1, resetAt: t0 + 5 * HOUR },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    const v = f.service.verdictFor("kimi-coding");
    expect(v?.level).toBe(3);
    expect(v?.demoted).toBe(true);
    expect(f.demotions.get("kimi-coding", f.clock.now())).toMatchObject({ level: 3, expiresAt: rWeek });
  });
});

// 额度恢复播报（applySnapshot 观测重置分支 → onObservedReset）：只在该分支发事件，
// 事件携带终态判定（含当场重建的降位）与镜像闸门判定；可疑读数拒收路径零事件。
describe("createQuotaService recovery events (observed reset → onObservedReset)", () => {
  const HOUR = 3_600_000;
  const REFRESH = DEFAULT_SETTINGS.quota.refreshMs;

  async function land(f: Fixture, stub: Stub, snapshot: () => QuotaSnapshot): Promise<void> {
    stub.set(snapshot);
    f.service.refreshIfStale();
    await f.service.whenIdle();
  }

  it("an evidence-backed reset (old resetAt passed) emits exactly one event with the terminal verdict", async () => {
    const f = makeFixture();
    const t0 = f.clock.now();
    f.demotions.mark("zai-coding-cn", 3, t0 + 48 * HOUR, t0); // 跨进程遗留的降位
    await land(f, f.zai, () =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60, resetAt: t0 + 300_000 }], f.clock.now()),
    );
    expect(f.events).toHaveLength(0); // 首次落地无回落 ⇒ 无事件
    f.clock.advance(REFRESH); // 越过旧 resetAt ⇒ 回落带证据
    await land(f, f.zai, () => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 5 }], f.clock.now()));
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    if (e === undefined) throw new Error("event missing");
    expect(e.provider).toBe("zai-coding-cn");
    expect([...e.resetScopes]).toEqual(["5h"]);
    expect(e.verdict.level).toBe(0);
    expect(e.verdict.demoted).toBe(false); // 降位已清且未重建
    expect(e.gateBlocked).toBe(false);
    expect(e.at).toBe(f.clock.now());
  });

  it("a suspect read emits nothing; only the confirming second read emits (two-confirmation reset)", async () => {
    const f = makeFixture();
    const t0 = f.clock.now();
    const r5h = t0 + 3 * HOUR;
    const rWeek = t0 + 90 * HOUR;
    const zeroed = (): QuotaSnapshot =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 0 },
          { scope: "week", usedPct: 0 },
        ],
        f.clock.now(),
      );
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 0, resetAt: r5h },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed); // 第一次归零：拒收 ⇒ 零事件（误报免疫）
    expect(f.events).toHaveLength(0);
    f.clock.advance(REFRESH);
    await land(f, f.kimi, zeroed); // 第二次同样回落 ⇒ 确认 ⇒ 恰一条
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    if (e === undefined) throw new Error("event missing");
    expect(e.provider).toBe("kimi-coding");
    expect([...e.resetScopes]).toEqual(["week"]); // 5h 恒 0 无回落
    expect(e.verdict.level).toBe(0);
    expect(e.gateBlocked).toBe(false);
  });

  it("a partial reset with the other window still L3 emits the event with the re-marked demotion", async () => {
    const f = makeFixture();
    const t0 = f.clock.now();
    const rWeek = t0 + 90 * HOUR;
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 60, resetAt: t0 + 300_000 },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    f.clock.advance(REFRESH); // 5h 旧 resetAt 已过 ⇒ 5h 的回落有证据
    await land(f, f.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 1, resetAt: t0 + 5 * HOUR },
          { scope: "week", usedPct: 100, resetAt: rWeek },
        ],
        f.clock.now(),
      ),
    );
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    if (e === undefined) throw new Error("event missing");
    expect([...e.resetScopes]).toEqual(["5h"]);
    // 终态：7d 仍 L3 ⇒ 降位当场重建，闸门仍拦——事件不得拿 clear 后的中间态报「已放行」。
    expect(e.verdict.level).toBe(3);
    expect(e.verdict.demoted).toBe(true);
    expect(e.verdict.demotedUntil).toBe(rWeek);
    expect(e.gateBlocked).toBe(true);
  });

  it("gateBlocked mirrors the settings: gate=false stays open even at L3; gateLevel=2 trips on a post-reset L2", async () => {
    const off = makeFixture({ gate: false });
    const t0 = off.clock.now();
    await land(off, off.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 60, resetAt: t0 + 300_000 },
          { scope: "week", usedPct: 100, resetAt: t0 + 90 * HOUR },
        ],
        off.clock.now(),
      ),
    );
    off.clock.advance(REFRESH);
    await land(off, off.kimi, () =>
      windowsSnapshot(
        "kimi-coding",
        [
          { scope: "5h", usedPct: 1, resetAt: t0 + 5 * HOUR },
          { scope: "week", usedPct: 100, resetAt: t0 + 90 * HOUR },
        ],
        off.clock.now(),
      ),
    );
    expect(off.events[0]?.gateBlocked).toBe(false); // 闸门整体关闭 ⇒ 不拦

    const low = makeFixture({ gateLevel: 2 });
    const s0 = low.clock.now();
    await land(low, low.zai, () =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 95, resetAt: s0 + 300_000 }], low.clock.now()),
    );
    low.clock.advance(REFRESH);
    await land(low, low.zai, () =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 80, resetAt: s0 + 5 * HOUR }], low.clock.now()),
    );
    expect(low.events).toHaveLength(1);
    expect(low.events[0]?.verdict.level).toBe(2); // 80% ⇒ L2（90 才是 L3）
    expect(low.events[0]?.gateBlocked).toBe(true); // gateLevel=2 ⇒ 仍拦
  });

  it("a normal landing without any drop emits no event", async () => {
    const f = makeFixture();
    await land(f, f.zai, () =>
      windowsSnapshot(
        "zai-coding-cn",
        [{ scope: "5h", usedPct: 40, resetAt: f.clock.now() + 4 * HOUR }],
        f.clock.now(),
      ),
    );
    f.clock.advance(REFRESH);
    await land(f, f.zai, () =>
      windowsSnapshot(
        "zai-coding-cn",
        [{ scope: "5h", usedPct: 60, resetAt: f.clock.now() + 4 * HOUR }],
        f.clock.now(),
      ),
    );
    expect(f.events).toHaveLength(0);
  });

  it("a throwing recovery listener is swallowed: state still lands, warns once", async () => {
    const f = makeFixture({}, () => {
      throw new Error("listener boom");
    });
    const t0 = f.clock.now();
    await land(f, f.zai, () =>
      windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60, resetAt: t0 + 300_000 }], f.clock.now()),
    );
    f.clock.advance(REFRESH);
    await land(f, f.zai, () => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 5 }], f.clock.now()));
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("recovery listener failed"));
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("listener boom"));
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.usedPct).toBe(5); // 快照照常落地
    expect(f.demotions.get("zai-coding-cn", f.clock.now())).toBeUndefined();
  });
});
