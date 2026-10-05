/**
 * web-hub-spawn plan §SP5: `hub/spawn/store.ts` — spawns.json persistence.
 *
 * Covers the plan's acceptance list: roundtrip + 0600, corrupt rename (exactly one kept),
 * >256 KiB ignore-in-place, debounce coalescing, saveNow bypassing it, the #5 hard gate
 * (flushAndClose), ENOSPC/rename failure recovery, record trimming + the 64 KiB envelope cap,
 * and pid+gen tmp naming. Failure injection goes through `deps.fs` (Partial<SyncFs>) — never
 * by monkeypatching node:fs.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPAWN_NONTERMINAL_MAX, SPAWN_TERMINAL_KEEP } from "../../../../src/web-hub/protocol/spawn.js";
import {
  SPAWNS_DEBOUNCE_MS,
  SPAWNS_FILE_TARGET_BYTES,
  SPAWNS_READ_MAX_BYTES,
  createSpawnStore,
  type StoredRecord,
  type SyncFs,
} from "../../../../src/web-hub/hub/spawn/store.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { memLog, type MemLog } from "../helpers.js";

let dir: string;
let log: MemLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-spawnstore-"));
  log = memLog();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const file = (): string => join(dir, "spawns.json");

function rec(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    spawnId: "sp_Ab3dEf9hIj0Kmnop",
    state: "live",
    cwd: "/home/u/proj",
    dev: 2049,
    ino: 1234567,
    createdAt: 1_000,
    updatedAt: 1_500,
    owner: { listener: "loopback", user: null, reqId: "req-aaaaaaaaaaaaaaaa" },
    agentKey: "a5151-abcdef",
    endReason: null,
    exit: null,
    hint: null,
    ...over,
  };
}

const d = (): ReqDeadlineLike => createReqDeadline(() => Date.now(), 5_000);
type ReqDeadlineLike = ReturnType<typeof createReqDeadline>;

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("createSpawnStore: 往返与文件属性 (plan §SP5)", () => {
  it("saveNow → load roundtrips records and writer, file is 0600, envelope v=2", () => {
    const records = [
      rec({ spawnId: "sp_live1", state: "starting", pid: 5151, procStartTicks: 77, uid: 1000, bootId: "b-1" }),
      rec({ spawnId: "sp_done1", state: "failed", endReason: "spawn_error", firstPrompt: undefined }),
    ];
    const s = createSpawnStore({
      file: file(),
      log,
      now: () => 123,
      writer: { pid: 42, startedAt: 99, bootId: "boot-z" },
    });
    expect(s.saveNow(records)).toEqual({ ok: true });
    expect(statSync(file()).mode & 0o777).toBe(0o600);

    const loaded = createSpawnStore({ file: file(), log, now: () => 456 }).load(d());
    expect(loaded.corrupt).toBeUndefined();
    expect(loaded.writer).toEqual({ pid: 42, startedAt: 99, bootId: "boot-z" });
    expect(loaded.records).toEqual(records);
    expect(readJson(file()).v).toBe(2);
  });

  it("load on a fresh state dir yields empty records, no writer, no file created", () => {
    const loaded = createSpawnStore({ file: file(), log, now: () => 1 }).load(d());
    expect(loaded).toEqual({ records: [] });
    expect(existsSync(file())).toBe(false);
  });

  it('default writer carries this process pid, now(), and the /proc boot_id (or "")', () => {
    const s = createSpawnStore({ file: file(), log, now: () => 777_000 });
    s.saveNow([rec()]);
    const env = readJson(file());
    const writer = env.writer as Record<string, unknown>;
    expect(writer.pid).toBe(process.pid);
    expect(writer.startedAt).toBe(777_000);
    expect(typeof writer.bootId).toBe("string");
  });

  it("gen seeds from the loaded file so it stays monotonic across hub restarts", () => {
    const a = createSpawnStore({ file: file(), log, now: () => 1 });
    a.saveNow([rec()]);
    a.saveNow([rec()]);
    const genAfterTwo = a.gen;
    const b = createSpawnStore({ file: file(), log, now: () => 2 });
    expect(b.gen).toBe(0); // not seeded until load()
    b.load(d());
    expect(b.gen).toBe(genAfterTwo);
    b.saveNow([rec()]);
    expect((readJson(file()).gen as number) > genAfterTwo).toBe(true);
  });
});

describe("损坏与防御性读取 (plan §SP5 / arch §7.7)", () => {
  it("unparseable JSON is renamed .corrupt-<ts>, records empty, corrupt flag set", () => {
    writeFileSync(file(), "{not json", { mode: 0o600 });
    const loaded = createSpawnStore({ file: file(), log, now: () => 5_000 }).load(d());
    expect(loaded).toEqual({ records: [], corrupt: true });
    expect(existsSync(file())).toBe(false);
    const leftovers = readdirSync(dir).filter((n) => n.startsWith("spawns.json.corrupt-"));
    expect(leftovers.length).toBe(1);
  });

  it("a second corrupt file replaces the first — exactly one kept", () => {
    writeFileSync(file(), "garbage1", { mode: 0o600 });
    createSpawnStore({ file: file(), log, now: () => 5_000 }).load(d());
    writeFileSync(file(), "garbage2", { mode: 0o600 });
    createSpawnStore({ file: file(), log, now: () => 9_000 }).load(d());
    const leftovers = readdirSync(dir).filter((n) => n.startsWith("spawns.json.corrupt-"));
    expect(leftovers).toEqual(["spawns.json.corrupt-9000"]);
  });

  it("shape violations (bad state enum / bad owner / bad v) read as corrupt too", () => {
    for (const bad of [
      JSON.stringify({ v: 3, records: [] }),
      JSON.stringify({ v: 2, records: [{ spawnId: "x", state: "zombie" }] }),
      JSON.stringify({ v: 2, records: [{ spawnId: "x", state: "live", owner: { listener: "wan" } }] }),
      JSON.stringify({ v: 2, records: [rec({ pid: "not-a-number" as unknown as number })] }),
    ]) {
      writeFileSync(file(), bad, { mode: 0o600 });
      expect(createSpawnStore({ file: file(), log, now: () => 1 }).load(d())).toEqual({ records: [], corrupt: true });
    }
  });

  it("an oversize (>256 KiB) file is ignored in place — not renamed, flagged corrupt", () => {
    writeFileSync(file(), "x".repeat(SPAWNS_READ_MAX_BYTES + 1024), { mode: 0o600 });
    const loaded = createSpawnStore({ file: file(), log, now: () => 1 }).load(d());
    expect(loaded).toEqual({ records: [], corrupt: true });
    expect(existsSync(file())).toBe(true); // untouched — the next successful write replaces it
    expect(readdirSync(dir).some((n) => n.includes(".corrupt-"))).toBe(false);
  });

  it("an expired deadline skips the read entirely (sync IO checks budget before starting)", () => {
    writeFileSync(file(), JSON.stringify({ v: 2, records: [] }), { mode: 0o600 });
    const expired = createReqDeadline(() => Date.now(), -1);
    expect(createSpawnStore({ file: file(), log, now: () => 1 }).load(expired)).toEqual({ records: [] });
    // File untouched: a later load with budget still reads it.
    expect(createSpawnStore({ file: file(), log, now: () => 1 }).load(d())).toEqual({ records: [] });
  });
});

describe("写失败与恢复 (plan §SP5: ENOSPC / rename 失败)", () => {
  it("writeFileSync failure: tmp removed, healthy=false, code returned, one error log", () => {
    const tmpNames: string[] = [];
    const fs: Partial<SyncFs> = {
      writeFileSync: (p: string) => {
        tmpNames.push(p);
        throw Object.assign(new Error("boom"), { code: "ENOSPC" });
      },
    };
    const s = createSpawnStore({ file: file(), log, now: () => 1, fs });
    expect(s.saveNow([rec()])).toEqual({ ok: false, code: "ENOSPC" });
    expect(s.healthy).toBe(false);
    expect(tmpNames[0]).toMatch(/spawns\.json\.tmp-\d+-1$/);
    expect(readdirSync(dir).some((n) => n.includes(".tmp-"))).toBe(false);
    expect(log.lines.filter((l) => l.level === "error").length).toBe(1);

    // Same store, real fs underneath nothing — still failing, but the error log is throttled.
    expect(s.saveNow([rec()])).toEqual({ ok: false, code: "ENOSPC" });
    expect(log.lines.filter((l) => l.level === "error").length).toBe(1);

    // Recovery: a fresh store (write works again) flips healthy back and persists.
    const ok = createSpawnStore({ file: file(), log, now: () => 2 });
    expect(ok.saveNow([rec()])).toEqual({ ok: true });
    expect(ok.healthy).toBe(true);
    expect(existsSync(file())).toBe(true);
  });

  it("renameSync failure: tmp removed, unhealthy, code surfaces", () => {
    const fs: Partial<SyncFs> = {
      renameSync: () => {
        throw Object.assign(new Error("nope"), { code: "EPERM" });
      },
    };
    const s = createSpawnStore({ file: file(), log, now: () => 1, fs });
    expect(s.saveNow([rec()])).toEqual({ ok: false, code: "EPERM" });
    expect(s.healthy).toBe(false);
    expect(readdirSync(dir).some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("error logging re-arms after the 60s throttle window", () => {
    let clock = 0;
    let failWrite = true;
    const fs: Partial<SyncFs> = {
      writeFileSync: (p, data, opts) => {
        if (failWrite) throw Object.assign(new Error("boom"), { code: "ENOSPC" });
        realWriteFileSync(p, data, opts);
      },
    };
    const s = createSpawnStore({ file: file(), log, now: () => clock, fs });
    s.saveNow([rec()]); // t=0 → logs
    clock = 30_000;
    s.saveNow([rec()]); // t=30s → throttled
    clock = 61_000;
    s.saveNow([rec()]); // t=61s → logs again
    expect(log.lines.filter((l) => l.level === "error").length).toBe(2);
    failWrite = false;
    clock = 62_000;
    expect(s.saveNow([rec()])).toEqual({ ok: true });
    expect(s.healthy).toBe(true);
  });
});

describe("防抖与 saveNow 直写 (plan §SP5)", () => {
  it("three markDirty calls inside the window coalesce into one write of the LATEST data", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.saveNow([rec({ spawnId: "sp_seed" })]);
    const gen0 = s.gen;

    s.markDirty(() => [rec({ spawnId: "sp_a" })]);
    s.markDirty(() => [rec({ spawnId: "sp_b" })]);
    s.markDirty(() => [rec({ spawnId: "sp_c" })]);
    expect(vi.getTimerCount()).toBe(1);
    expect(existsSync(file())).toBe(true); // seed write already on disk
    writeFileSync(file(), "stale", { mode: 0o600 }); // marker: debounce must overwrite it

    vi.advanceTimersByTime(SPAWNS_DEBOUNCE_MS);
    expect(vi.getTimerCount()).toBe(0);
    const env = readJson(file());
    expect((env.records as Array<{ spawnId: string }>).map((r) => r.spawnId)).toEqual(["sp_c"]);
    expect(s.gen).toBe(gen0 + 1); // exactly one write
  });

  it("saveNow bypasses the debounce and cancels the pending flush", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.markDirty(() => [rec({ spawnId: "sp_dirty" })]);
    expect(s.saveNow([rec({ spawnId: "sp_now" })])).toEqual({ ok: true });
    expect((readJson(file()).records as Array<{ spawnId: string }>)[0]!.spawnId).toBe("sp_now");
    const genAfter = s.gen;
    vi.advanceTimersByTime(SPAWNS_DEBOUNCE_MS * 3);
    expect(s.gen).toBe(genAfter); // the cancelled debounce never re-writes
    expect((readJson(file()).records as Array<{ spawnId: string }>)[0]!.spawnId).toBe("sp_now");
  });
});

describe("flushAndClose（#5 硬门槛）", () => {
  it("cancels the timer, writes dirty data exactly once, then every write is a no-op", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.markDirty(() => [rec({ spawnId: "sp_pending" })]);
    expect(vi.getTimerCount()).toBe(1);

    s.flushAndClose(d());
    expect(s.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // pending timer cleared — nothing left to fire
    const env = readJson(file());
    expect((env.records as Array<{ spawnId: string }>)[0]!.spawnId).toBe("sp_pending");
    const genAfterClose = s.gen;
    expect(genAfterClose).toBe(1); // seed(0 writes before) → exactly one write happened

    expect(s.saveNow([rec({ spawnId: "sp_late" })])).toEqual({ ok: false, code: "E_CLOSED" });
    s.markDirty(() => [rec({ spawnId: "sp_late2" })]);
    expect(vi.getTimerCount()).toBe(0); // markDirty after close is a no-op
    expect(log.lines.some((l) => l.level === "info" && l.msg.includes("no-op"))).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(s.gen).toBe(genAfterClose); // no hidden writes
    expect((readJson(file()).records as Array<{ spawnId: string }>)[0]!.spawnId).toBe("sp_pending");

    // Second flushAndClose: idempotent, zero side effects.
    s.flushAndClose(d());
    expect(s.gen).toBe(genAfterClose);
    expect(s.closed).toBe(true);
  });

  it("a clean close (nothing dirty) writes nothing", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.flushAndClose(d());
    expect(s.gen).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it("close still persists after failed writes (dirty stayed true) — crash-path semantics", () => {
    let failWrite = true;
    const fs: Partial<SyncFs> = {
      writeFileSync: (p, data, opts) => {
        if (failWrite) throw Object.assign(new Error("boom"), { code: "ENOSPC" });
        realWriteFileSync(p, data, opts);
      },
    };
    const s = createSpawnStore({ file: file(), log, now: () => 1, fs });
    s.markDirty(() => [rec({ spawnId: "sp_retry" })]);
    expect(s.saveNow([rec()]).ok).toBe(false);
    failWrite = false;
    s.flushAndClose(d()); // disk recovered → the close-time retry lands
    expect(existsSync(file())).toBe(true);
    expect((readJson(file()).records as Array<{ spawnId: string }>)[0]!.spawnId).toBe("sp_retry");
  });
});

describe("记录裁剪与 64 KiB 上限 (plan §SP5)", () => {
  it("non-terminal capped at 16 (oldest createdAt evicted), terminal at 20 (oldest updatedAt)", () => {
    const nonTerm: StoredRecord[] = Array.from({ length: SPAWN_NONTERMINAL_MAX + 2 }, (_, i) =>
      rec({ spawnId: `sp_n${String(i).padStart(2, "0")}`, state: "live", createdAt: 2_000 + i, updatedAt: 9_000 }),
    );
    const term: StoredRecord[] = Array.from({ length: SPAWN_TERMINAL_KEEP + 5 }, (_, i) =>
      rec({
        spawnId: `sp_t${String(i).padStart(2, "0")}`,
        state: "exited",
        createdAt: 500 + i,
        updatedAt: 1_000 + i,
        endReason: "user",
      }),
    );
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.saveNow([...nonTerm, ...term]);
    const ids = (readJson(file()).records as Array<{ spawnId: string }>).map((r) => r.spawnId);
    // Newest 16 non-terminal (n02..n17) and newest 20 terminal (t05..t24), relative order kept.
    expect(ids.filter((x) => x.startsWith("sp_n"))).toEqual(
      Array.from({ length: SPAWN_NONTERMINAL_MAX }, (_, i) => `sp_n${String(i + 2).padStart(2, "0")}`),
    );
    expect(ids.filter((x) => x.startsWith("sp_t"))).toEqual(
      Array.from({ length: SPAWN_TERMINAL_KEEP }, (_, i) => `sp_t${String(i + 5).padStart(2, "0")}`),
    );
  });

  it("fat terminal records are evicted until the serialized envelope fits 64 KiB", () => {
    const fat = "d".repeat(5_000);
    const term: StoredRecord[] = Array.from({ length: 30 }, (_, i) =>
      rec({ spawnId: `sp_f${String(i).padStart(2, "0")}`, state: "failed", cwd: fat, updatedAt: 1_000 + i }),
    );
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    s.saveNow(term);
    expect(statSync(file()).size).toBeLessThanOrEqual(SPAWNS_FILE_TARGET_BYTES);
    const kept = (readJson(file()).records as Array<{ spawnId: string }>).map((r) => r.spawnId);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(30);
    expect(kept[kept.length - 1]).toBe("sp_f29"); // newest survivors are kept
  });

  it("with no terminal records left, the oversize envelope is written anyway (warned)", () => {
    const fat = "d".repeat(4_600);
    const nonTerm: StoredRecord[] = Array.from({ length: SPAWN_NONTERMINAL_MAX }, (_, i) =>
      rec({ spawnId: `sp_w${String(i).padStart(2, "0")}`, state: "live", cwd: fat, createdAt: i }),
    );
    const s = createSpawnStore({ file: file(), log, now: () => 1 });
    expect(s.saveNow(nonTerm)).toEqual({ ok: true });
    expect(statSync(file()).size).toBeGreaterThan(SPAWNS_FILE_TARGET_BYTES);
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("exceeds target"))).toBe(true);
    // And it still loads (≤256 KiB read cap).
    expect(createSpawnStore({ file: file(), log, now: () => 2 }).load(d()).records.length).toBe(SPAWN_NONTERMINAL_MAX);
  });
});

describe("tmp 命名与 gen (plan §SP5: tmp-<pid>-<gen>)", () => {
  it("tmp names carry pid and strictly increasing gen; rename consumes them", () => {
    const tmps: string[] = [];
    const renames: Array<{ from: string; to: string }> = [];
    const fs: Partial<SyncFs> = {
      writeFileSync: (p) => {
        tmps.push(p);
      },
      renameSync: (from, to) => {
        renames.push({ from, to });
      },
    };
    const s = createSpawnStore({ file: file(), log, now: () => 1, fs });
    s.saveNow([rec()]);
    s.saveNow([rec()]);
    s.saveNow([rec()]);
    expect(tmps).toEqual([1, 2, 3].map((g) => join(dir, `spawns.json.tmp-${process.pid}-${g}`)));
    expect(renames.every((r) => r.to === file())).toBe(true);
  });
});
