// quota-plan §9.2 demotion.test.ts — D6 / §5.3 的文件级降位标记持久化：
// 重启存活、双重过期（TTL ① / 观测重置走 clear）、幂等 mark、损坏文件视为
// 空表、目录不可写内存态照常、tmp+rename 原子写。

// fs 走 vi.mock 整体替换 + 透传原实现：node:fs 的 ESM 命名空间属性不可
// configure（vi.spyOn 直接抛 "Cannot redefine property"），call-through 的
// module mock 是断言落盘行为（次数 / tmp+rename 参数）的唯一可靠途径。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DEMOTION_TTL_MS,
  createDemotionStore,
  type DemotionStore,
  type DemotionStoreOptions,
} from "../../src/quota/demotion.js";

let dir: string;
let path: string;
let clock: { value: number };

beforeEach(() => {
  vi.mocked(fs.writeFileSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
  dir = fs.mkdtempSync(join(tmpdir(), "pi-quota-demotion-"));
  path = join(dir, "quota-state.json");
  clock = { value: 1_000 };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(overrides: Partial<DemotionStoreOptions> = {}): DemotionStore {
  return createDemotionStore({ path, now: () => clock.value, ...overrides });
}

describe("createDemotionStore", () => {
  it("mark then get round-trips, and survives a store restart on the same path", () => {
    const s = store();
    s.mark("zai-coding-cn", 2, 9_000, 1_000);
    const record = s.get("zai-coding-cn", 2_000);
    expect(record).toMatchObject({ provider: "zai-coding-cn", level: 2, markedAt: 1_000, expiresAt: 9_000 });
    expect(s.get("kimi-coding", 2_000)).toBeUndefined();
    // 重启（新 store 实例、同一路径）后仍可读（D6：跨进程存活）。
    const reopened = store();
    expect(reopened.get("zai-coding-cn", 2_000)).toMatchObject({ level: 2, expiresAt: 9_000 });
    expect(reopened.list(2_000)).toHaveLength(1);
  });

  it("expires via TTL: now >= expiresAt hides the record from get and list", () => {
    const s = store();
    s.mark("zai", 3, 5_000, 1_000);
    expect(s.get("zai", 4_999)).toBeDefined();
    expect(s.get("zai", 5_000)).toBeUndefined(); // now >= expiresAt（闭区间命中）
    expect(s.list(5_000)).toHaveLength(0);
  });

  it("falls back to the 6h TTL when resetAt is unknown (or already in the past)", () => {
    const s = store();
    s.mark("moonshot", 3, undefined, 1_000);
    expect(s.get("moonshot", 1_000)?.expiresAt).toBe(1_000 + DEFAULT_DEMOTION_TTL_MS);
    s.mark("zai", 3, 500, 1_000); // resetAt 已过期 ⇒ 同样走 TTL
    expect(s.get("zai", 1_000)?.expiresAt).toBe(1_000 + DEFAULT_DEMOTION_TTL_MS);
  });

  it("is idempotent: repeating the same mark does not hit the disk again", () => {
    const spy = vi.mocked(fs.writeFileSync);
    const s = store();
    s.mark("zai-coding-cn", 2, 9_000, 1_000);
    const writesAfterFirst = spy.mock.calls.length;
    expect(writesAfterFirst).toBeGreaterThanOrEqual(1);
    s.mark("zai-coding-cn", 2, 9_000, 2_000); // 同 level、未过期 ⇒ 不改写
    expect(spy.mock.calls.length).toBe(writesAfterFirst);
    // 内容未变 ⇒ flush 也不落盘。
    s.clear("kimi-coding"); // 不在表里 ⇒ 无事发生
    expect(spy.mock.calls.length).toBe(writesAfterFirst);
  });

  it("rewrites when the level is raised (2 -> 3) but not lowered (3 -> 2)", () => {
    const s = store();
    s.mark("kimi-coding", 2, 9_000, 1_000);
    expect(s.get("kimi-coding", 1_500)?.level).toBe(2);
    s.mark("kimi-coding", 3, 9_000, 2_000); // 抬升 ⇒ 改写
    expect(s.get("kimi-coding", 2_500)?.level).toBe(3);
    s.mark("kimi-coding", 2, 9_000, 3_000); // 降写不生效（保持最高级）
    expect(s.get("kimi-coding", 3_500)?.level).toBe(3);
    // 已过期后再 mark 同 level ⇒ 允许改写（过期即视为无记录）。
    clock.value = 9_000;
    s.mark("kimi-coding", 2, 20_000, 9_000);
    expect(s.get("kimi-coding", 9_500)?.level).toBe(2);
  });

  it("clear takes effect immediately and persists across a restart", () => {
    const s = store();
    s.mark("zai", 2, undefined, 1_000);
    expect(s.get("zai", 1_500)).toBeDefined();
    s.clear("zai");
    expect(s.get("zai", 1_500)).toBeUndefined();
    expect(store().get("zai", 1_500)).toBeUndefined(); // 已落盘
  });

  it("treats a corrupted file as an empty table and keeps working", () => {
    fs.writeFileSync(path, "not json", "utf8");
    const warn = vi.fn();
    const s = store({ warn });
    expect(s.get("zai-coding-cn", 1_000)).toBeUndefined();
    expect(() => s.list(1_000)).not.toThrow();
    expect(warn).not.toHaveBeenCalled(); // 静默降级（R6：不打 WARN）
    // 后续 mark/get 正常工作，损坏内容被有效表覆盖。
    s.mark("zai-coding-cn", 3, 5_000, 1_000);
    expect(s.get("zai-coding-cn", 2_000)?.level).toBe(3);
    const reopened = store();
    expect(reopened.get("zai-coding-cn", 2_000)?.level).toBe(3);
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    expect(parsed).toMatchObject({ version: 1, demotions: { "zai-coding-cn": { level: 3 } } });
  });

  it("keeps the in-memory state working when the directory is unwritable", () => {
    // 父路径是一个普通文件 ⇒ writeFileSync 必然 ENOTDIR（跨平台确定性失败）。
    const blocker = join(dir, "blocker");
    fs.writeFileSync(blocker, "", "utf8");
    const warn = vi.fn();
    const s = createDemotionStore({
      path: join(blocker, "quota-state.json"),
      now: () => clock.value,
      warn,
    });
    expect(() => {
      s.mark("zai", 3, undefined, 1_000);
      s.mark("kimi-coding", 2, undefined, 1_000);
    }).not.toThrow();
    expect(s.get("zai", 2_000)?.level).toBe(3); // 内存态照常
    expect(s.list(2_000)).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1); // 写失败只 WARN 一次，不刷屏
  });

  it("writes atomically via tmp + rename", () => {
    const writeSpy = vi.mocked(fs.writeFileSync);
    const renameSpy = vi.mocked(fs.renameSync);
    const s = store();
    s.mark("zai", 2, 9_000, 1_000);
    expect(renameSpy).toHaveBeenCalled();
    const tmpArg = writeSpy.mock.calls[0]?.[0];
    expect(typeof tmpArg === "string" && tmpArg.endsWith(".tmp")).toBe(true);
    expect(tmpArg).toBe(`${path}.${process.pid}.tmp`);
    const renameArgs = renameSpy.mock.calls[0];
    expect(renameArgs?.[0]).toBe(`${path}.${process.pid}.tmp`);
    expect(renameArgs?.[1]).toBe(path);
  });
});
