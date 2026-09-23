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
}

function makeFixture(settingsOver: Partial<QuotaSettings> = {}): Fixture {
  const clock = new FakeClock(1_000);
  const settings: QuotaSettings = { ...DEFAULT_SETTINGS.quota, ...settingsOver };
  const zai = stubAdapter("zai-coding-cn");
  const kimi = stubAdapter("kimi-coding");
  const setStatus = vi.fn();
  const warn = vi.fn();
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
  });
  return { clock, service, demotions, zai, kimi, setStatus, warn };
}

describe("createQuotaService", () => {
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
    // l3EtaMs=0 + 无 resetAt ⇒ forecast 不抬级，etaMs 只作环探针。
    const f = makeFixture({ l3EtaMs: 0 });
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    f.clock.advance(600_000); // 10min
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 80 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    // 80% ⇒ L2 ⇒ 降位标记；环 [60@t0, 80@t1] ⇒ eta = (100-80)/(20/10min) = 10min。
    expect(f.demotions.get("zai-coding-cn", f.clock.now())?.level).toBe(2);
    expect(f.service.verdictFor("zai-coding-cn")?.windows[0]?.etaMs).toBe(600_000);
    f.clock.advance(600_000);
    f.zai.set(() => windowsSnapshot("zai-coding-cn", [{ scope: "5h", usedPct: 5 }], f.clock.now()));
    f.service.refreshIfStale();
    await f.service.whenIdle();
    // 全部窗口跌幅 80→5（≥15）⇒ 观测重置：clear 降位 + 清环。
    expect(f.demotions.get("zai-coding-cn", f.clock.now())).toBeUndefined();
    const after = f.service.verdictFor("zai-coding-cn");
    expect(after?.level).toBe(0);
    expect(after?.demoted).toBe(false);
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
