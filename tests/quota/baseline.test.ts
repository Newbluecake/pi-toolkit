// 2026-10-15 现场事件后继包：「最后接受读数」基线持久化（quota-state.json 的
// baselines 键，与 demotions 同文件读改写互存）——重启后 classifyDrop 仍有比较
// 基线，第一份全零垃圾读数不再被直接当真。
//
// fs 走 vi.mock 整体替换 + 透传原实现（同 demotion.test.ts 的理由：node:fs 的
// ESM 命名空间属性不可 configure）。

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
  BASELINE_TTL_MS,
  createBaselineStore,
  type BaselineStore,
  type BaselineStoreOptions,
} from "../../src/quota/baseline.js";

let dir: string;
let path: string;
let clock: { value: number };

beforeEach(() => {
  vi.mocked(fs.writeFileSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
  dir = fs.mkdtempSync(join(tmpdir(), "pi-quota-baseline-"));
  path = join(dir, "quota-state.json");
  clock = { value: 1_000 };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(overrides: Partial<BaselineStoreOptions> = {}): BaselineStore {
  return createBaselineStore({ path, now: () => clock.value, ...overrides });
}

/** resetAt 钉死：no-op 判定比对的是完整窗口内容，helper 不能随 clock 漂移。 */
const RESET_AT = 1_000 + 90 * 3_600_000;
const windows = (over: Partial<{ "5h": number; week: number; month: number }> = {}) => [
  { scope: "5h" as const, usedPct: over["5h"] ?? 12, resetAt: RESET_AT },
  { scope: "week" as const, usedPct: over.week ?? 56 },
  ...(over.month === undefined ? [] : [{ scope: "month" as const, usedPct: over.month }]),
];

describe("createBaselineStore", () => {
  it("set then get round-trips, and survives a store restart on the same path", () => {
    const s = store();
    s.set("droid-standard", { fetchedAt: clock.value, windows: windows() });
    expect(s.get("droid-standard", clock.value)).toMatchObject({ fetchedAt: clock.value });
    expect(s.get("droid-standard", clock.value)?.windows).toEqual(windows());
    const reopened = store(); // 重启：惰性重读同一文件
    expect(reopened.get("droid-standard", clock.value)?.windows).toEqual(windows());
  });

  it("no-op detection: identical windows ⇒ no disk write (only the in-memory fetchedAt moves)", () => {
    const s = store();
    s.set("kimi-coding", { fetchedAt: clock.value, windows: windows() });
    const writes = vi.mocked(fs.writeFileSync).mock.calls.length;
    clock.value += 600_000;
    s.set("kimi-coding", { fetchedAt: clock.value, windows: windows() }); // 内容未变
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(writes);
    expect(s.get("kimi-coding", clock.value)?.fetchedAt).toBe(clock.value); // TTL 计时延续
    clock.value += 600_000;
    s.set("kimi-coding", { fetchedAt: clock.value, windows: windows({ week: 58 }) }); // 内容变了
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(writes + 1);
    const reopened = store();
    expect(reopened.get("kimi-coding", clock.value)?.windows).toEqual(windows({ week: 58 }));
  });

  it("TTL: a baseline older than 7 days is invisible to get", () => {
    const s = store();
    s.set("zai", { fetchedAt: clock.value, windows: windows() });
    expect(s.get("zai", clock.value + BASELINE_TTL_MS - 1)).toBeDefined();
    expect(s.get("zai", clock.value + BASELINE_TTL_MS + 1)).toBeUndefined();
  });

  it("writes atomically via tmp + rename; corrupt file ⇒ empty table; old file (no baselines key) loads fine", () => {
    const s = store();
    s.set("a", { fetchedAt: clock.value, windows: windows() });
    const tmpPath = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[0];
    expect(tmpPath).toBe(`${path}.${process.pid}.tmp`);
    expect(vi.mocked(fs.renameSync).mock.calls.at(-1)?.[0]).toBe(tmpPath);
    fs.writeFileSync(path, "{ not json", "utf8");
    expect(store().get("a", clock.value)).toBeUndefined();
    // 旧版文件（只有 version + demotions，没有 baselines）：照常加载（空基线）。
    fs.writeFileSync(
      path,
      JSON.stringify({ version: 1, demotions: { zai: { level: 3, markedAt: 1, expiresAt: 9 } } }),
      "utf8",
    );
    expect(store().get("a", clock.value)).toBeUndefined();
  });

  it("shares the file with the demotion store: each flush preserves the other's top-level keys", async () => {
    const { createDemotionStore } = await import("../../src/quota/demotion.js");
    const b = store();
    b.set("kimi-coding", { fetchedAt: clock.value, windows: windows() });
    const d = createDemotionStore({ path, now: () => clock.value });
    d.mark("kimi-coding", 3, clock.value + 3_600_000, clock.value);
    // baseline 的后续 flush 不得抹掉 demotions，反之亦然（读改写互存）。
    clock.value += 600_000;
    b.set("kimi-coding", { fetchedAt: clock.value, windows: windows({ week: 60 }) });
    clock.value += 600_000;
    d.mark("zai", 3, clock.value + 3_600_000, clock.value);
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    const record = parsed as {
      version: number;
      demotions?: Record<string, unknown>;
      baselines?: Record<string, unknown>;
    };
    expect(record.version).toBe(1);
    expect(record.demotions?.["kimi-coding"]).toMatchObject({ level: 3 });
    expect(record.demotions?.zai).toMatchObject({ level: 3 });
    expect(record.baselines?.["kimi-coding"]).toMatchObject({ fetchedAt: clock.value - 600_000 });
    expect(record.baselines?.zai).toBeUndefined();
  });

  it("drops malformed entries silently (half a baseline is worse than none)", () => {
    fs.writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        baselines: {
          good: { fetchedAt: 5, windows: [{ scope: "5h", usedPct: 40 }] },
          "bad-window": { fetchedAt: 5, windows: [{ scope: "5h", usedPct: "x" }] },
          "no-windows": { fetchedAt: 5, windows: [] },
          "no-fetchedAt": { windows: [{ scope: "week", usedPct: 10 }] },
          notAnObject: 7,
        },
      }),
      "utf8",
    );
    const s = store();
    expect(s.get("good", clock.value)).toMatchObject({ fetchedAt: 5 });
    for (const key of ["bad-window", "no-windows", "no-fetchedAt", "notAnObject"]) {
      expect(s.get(key, clock.value)).toBeUndefined();
    }
  });

  it("keeps the in-memory state working when the directory is unwritable (warn once)", () => {
    const warn = vi.fn();
    const s = store({ path: join(dir, "no-such-dir", "quota-state.json"), warn });
    s.set("zai", { fetchedAt: clock.value, windows: windows() });
    s.set("kimi", { fetchedAt: clock.value, windows: windows() });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.get("zai", clock.value)?.windows).toEqual(windows());
  });
});
