/**
 * web-hub-spawn plan §SP5: `hub/spawn/stderr-sink.ts` — the #10 hard gate (bounded stderr).
 *
 * Every disk behavior is exercised through an injectable `StderrFs` double (hanging writes,
 * ENOSPC, an in-memory collecting handle); only `ensureLogDir` and the perf/roundtrip cases use
 * a real tmpdir. The memory-bound assertions use a heapUsed delta with a 4 MiB threshold — an
 * unbounded implementation would retain ≥10 MiB, so the margin is 2.5×, not a tight race.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STDERR_FILE_MAX,
  STDERR_FILES_MAX,
  STDERR_QUEUE_BYTES,
  STDERR_RING_BYTES,
} from "../../../../src/web-hub/protocol/spawn.js";
import {
  createStderrSink,
  ensureLogDir,
  type SinkFileHandle,
  type StderrFs,
  type StderrSink,
} from "../../../../src/web-hub/hub/spawn/stderr-sink.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import { memLog, sleepReal, waitFor, type MemLog } from "../helpers.js";

let dir: string;
let log: MemLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-stderrsink-"));
  log = memLog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const deadline = (ms: number) => createReqDeadline(() => Date.now(), ms);

// ---------------------------------------------------------------------------
// fs doubles
// ---------------------------------------------------------------------------

interface FakeHandle extends SinkFileHandle {
  writes: Buffer[];
  closeCount: number;
}

/** Writes hang until `releaseAll()` — which also flips the disk back to fast. */
function hangingFs(): { fs: Partial<StderrFs>; handle: FakeHandle; releaseAll(): void } {
  let slow = true;
  const pending: Array<() => void> = [];
  const handle: FakeHandle = {
    writes: [],
    closeCount: 0,
    write(buf: Uint8Array) {
      handle.writes.push(Buffer.from(buf));
      return new Promise<void>((resolve) => {
        if (slow) pending.push(() => resolve());
        else resolve();
      });
    },
    close() {
      handle.closeCount += 1;
      return Promise.resolve();
    },
  };
  const fs: Partial<StderrFs> = {
    mkdirSync: () => {},
    readdirSync: () => [],
    statSync: () => {
      throw new Error("unused");
    },
    unlinkSync: () => {},
    open: () => Promise.resolve(handle),
  };
  const releaseAll = (): void => {
    slow = false; // the disk "recovers": writes started later resolve immediately
    for (const r of pending.splice(0)) r();
  };
  return { fs, handle, releaseAll };
}

/** Writes land in memory immediately — the "fast disk" content oracle. */
function collectingFs(): { fs: Partial<StderrFs>; handle: FakeHandle; content(): string } {
  const handle: FakeHandle = {
    writes: [],
    closeCount: 0,
    write(buf: Uint8Array) {
      handle.writes.push(Buffer.from(buf));
      return Promise.resolve();
    },
    close() {
      handle.closeCount += 1;
      return Promise.resolve();
    },
  };
  const fs: Partial<StderrFs> = {
    mkdirSync: () => {},
    readdirSync: () => [],
    statSync: () => {
      throw new Error("unused");
    },
    unlinkSync: () => {},
    open: () => Promise.resolve(handle),
  };
  return { fs, handle, content: () => Buffer.concat(handle.writes).toString("utf8") };
}

/** `open` never settles — pins ring/tail behavior with zero disk interference. */
function neverOpenFs(): Partial<StderrFs> {
  return {
    mkdirSync: () => {},
    readdirSync: () => [],
    statSync: () => {
      throw new Error("unused");
    },
    unlinkSync: () => {},
    open: () => new Promise<SinkFileHandle>(() => {}),
  };
}

function sink(fs?: Partial<StderrFs>, spawnId = "sp_Ab3dEf9hIj0K"): StderrSink {
  return createStderrSink({ dir, spawnId, fs, now: () => Date.now(), log });
}

/** Deterministic 16-byte repeating pattern covering `total` bytes. */
function pattern(total: number): Buffer {
  const unit = Buffer.from("0123456789abcdef");
  const out = Buffer.alloc(total);
  for (let off = 0; off < total; off += unit.length) {
    out.set(unit.subarray(0, Math.min(unit.length, total - off)), off);
  }
  return out;
}

describe("stderr-sink 基本行为 (plan §SP5)", () => {
  it("pushes reach the real file; tail() and stats() agree; close() flushes", async () => {
    const s = sink();
    s.push(Buffer.from("line one\n"));
    s.push(Buffer.from("line two\n"));
    await s.close(deadline(2_000));
    const content = await import("node:fs/promises").then((m) =>
      m.readFile(join(dir, "sp_Ab3dEf9hIj0K.stderr.log"), "utf8"),
    );
    expect(content).toBe("line one\nline two\n");
    expect(s.tail()).toBe("line one\nline two\n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const st = s.stats();
    expect(st.dropped).toBe(0);
    expect(st.written).toBe(18);
    expect(st.error).toBeUndefined();
  });

  it("a sink closed without any push never creates the dir or the file", async () => {
    const s = createStderrSink({ dir: join(dir, "spawn"), spawnId: "sp_x", now: () => Date.now(), log });
    await s.close(deadline(1_000));
    expect(existsSync(join(dir, "spawn"))).toBe(false);
  });

  it("tail() survives multibyte UTF-8 split across chunk boundaries", () => {
    const s = sink(neverOpenFs());
    const full = Buffer.from("héllo wörld ✓ 汉字");
    s.push(full.subarray(0, 2)); // splits é
    s.push(full.subarray(2, 9)); // splits ö
    s.push(full.subarray(9));
    expect(s.tail(1024)).toBe("héllo wörld ✓ 汉字");
  });

  it("ring wraps across chunk boundaries: tail(64 KiB) is exactly the last 64 KiB of the stream", () => {
    const s = sink(neverOpenFs());
    const stream = pattern(100_000);
    for (let off = 0; off < stream.length; off += 97) {
      s.push(stream.subarray(off, Math.min(off + 97, stream.length)));
    }
    const tailed = s.tail(STDERR_RING_BYTES);
    expect(Buffer.byteLength(tailed)).toBe(STDERR_RING_BYTES);
    expect(tailed).toBe(stream.subarray(stream.length - STDERR_RING_BYTES).toString("utf8"));
  });

  it("push after close is ring-only and counted as dropped", async () => {
    const c = collectingFs();
    const s = sink(c.fs);
    s.push(Buffer.from("before"));
    await s.close(deadline(1_000));
    s.push(Buffer.from("after"));
    expect(c.content()).toBe("before");
    expect(s.tail()).toBe("beforeafter");
    expect(s.stats().dropped).toBe(5);
    await s.close(deadline(1_000)); // memoized — no error, no extra work
    expect(c.handle.closeCount).toBe(1);
  });
});

describe("慢盘与内存上界（#10 硬门槛）", () => {
  it("hanging write + 10 MiB pushed: ≤128 KiB retained, dropped>0, ring keeps last 64 KiB", async () => {
    const h = hangingFs();
    const s = sink(h.fs);
    const stream = pattern(10 * 1024 * 1024);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let off = 0; off < stream.length; off += 10 * 1024) {
      s.push(stream.subarray(off, off + 10 * 1024));
    }
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;

    expect(heapDelta).toBeLessThan(4 * 1024 * 1024); // ring 64 KiB + queue 64 KiB (+ slack)
    await waitFor(() => h.handle.writes.length === 1); // exactly one write in flight
    const st = s.stats();
    expect(st.dropped).toBeGreaterThan(0);
    // Accepted-for-disk = in-flight(10 KiB) + queued(≤64 KiB) ⇒ dropped ≈ total − that.
    expect(st.dropped).toBeGreaterThan(10 * 1024 * 1024 - 80 * 1024);
    expect(Buffer.byteLength(s.tail(STDERR_RING_BYTES))).toBe(STDERR_RING_BYTES);
    expect(s.tail(STDERR_RING_BYTES)).toBe(stream.subarray(stream.length - STDERR_RING_BYTES).toString("utf8"));

    h.releaseAll();
    await s.close(deadline(2_000));
    const fin = s.stats();
    expect(fin.error).toBeUndefined();
    expect(fin.written + fin.dropped).toBe(10 * 1024 * 1024); // byte conservation
  });

  it("100k × 10-byte pushes complete in <200 ms (push is O(1))", async () => {
    const s = sink(); // real fs on a real tmpdir
    const chunk = Buffer.from("0123456789");
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) s.push(chunk);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
    await s.close(deadline(2_000));
    const st = s.stats();
    expect(st.written + st.dropped).toBe(1_000_000);
  });

  it("overflow drops the oldest BLOCK: the whole first queued chunk goes first", async () => {
    const h = hangingFs();
    const s = sink(h.fs);
    s.push(Buffer.from("A")); // goes in flight
    await waitFor(() => h.handle.writes.length === 1);
    s.push(Buffer.alloc(STDERR_QUEUE_BYTES, 0x62)); // exactly fills the queue
    s.push(Buffer.from("C")); // overflows ⇒ drops the 64 KiB block B, keeps C
    expect(s.stats().dropped).toBe(STDERR_QUEUE_BYTES);
    h.releaseAll();
    await s.close(deadline(2_000));
    const st = s.stats();
    expect(st.dropped).toBe(STDERR_QUEUE_BYTES); // A and C both written
    expect(st.written).toBe(1 + 1);
  });
});

describe("磁盘错误（ENOSPC）", () => {
  it("write error closes the handle, sets error, ring/tail keep working", async () => {
    const handle: FakeHandle = {
      writes: [],
      closeCount: 0,
      write() {
        return Promise.reject(Object.assign(new Error("no space"), { code: "ENOSPC" }));
      },
      close() {
        handle.closeCount += 1;
        return Promise.resolve();
      },
    };
    const fs: Partial<StderrFs> = {
      mkdirSync: () => {},
      readdirSync: () => [],
      statSync: () => {
        throw new Error("unused");
      },
      unlinkSync: () => {},
      open: () => Promise.resolve(handle),
    };
    const s = sink(fs);
    s.push(Buffer.from("hello world"));
    await waitFor(() => s.stats().error !== undefined);

    const st = s.stats();
    expect(st.error).toBe("ENOSPC");
    expect(handle.closeCount).toBe(1);
    expect(st.written).toBe(0);
    expect(st.dropped).toBe(11); // the queued bytes died with the writer
    expect(s.tail()).toBe("hello world"); // ring unaffected

    s.push(Buffer.from(" more"));
    const st2 = s.stats();
    expect(st2.error).toBe("ENOSPC");
    expect(st2.dropped).toBe(16);
    expect(s.tail()).toBe("hello world more");
    await s.close(deadline(1_000)); // resolves: writer already terminal
    expect(handle.closeCount).toBe(1); // no double close
  });
});

describe("256 KiB 文件上限与截断标记", () => {
  it("crossing the cap writes the exact-fit prefix, one marker, then stops for good", async () => {
    const c = collectingFs();
    const s = sink(c.fs);
    const stream = pattern(300_000);
    const chunkLen = 1_000;
    const fullChunks = Math.floor(STDERR_FILE_MAX / chunkLen); // 262 → 262_000 bytes
    for (let i = 0; i < fullChunks; i++) {
      s.push(stream.subarray(i * chunkLen, (i + 1) * chunkLen));
      await sleepReal(1); // let the single-writer drain keep pace (deterministic counts)
    }
    expect(s.stats().written).toBe(STDERR_FILE_MAX - (STDERR_FILE_MAX % chunkLen));

    s.push(stream.subarray(fullChunks * chunkLen, fullChunks * chunkLen + chunkLen)); // crosses the cap
    await waitFor(() => s.stats().written >= STDERR_FILE_MAX);
    s.push(Buffer.from("zzzzzzzzzz")); // post-cap: never written
    await sleepReal(5);

    const marker = `\n[truncated 856 bytes]\n`; // 1000-byte chunk − 144-byte exact-fit prefix
    expect(c.content()).toBe(stream.subarray(0, STDERR_FILE_MAX).toString("utf8") + marker);
    const st = s.stats();
    expect(st.written).toBe(STDERR_FILE_MAX + Buffer.byteLength(marker));
    expect(st.dropped).toBe(856 + 10);
    expect(st.error).toBeUndefined();
    expect(c.handle.closeCount).toBe(1); // capped+drained ⇒ fd released early
    expect(c.handle.writes.length).toBe(fullChunks + 2); // 262 data + prefix + marker

    await s.close(deadline(1_000));
    expect(c.handle.closeCount).toBe(1); // already closed — not re-closed
  });
});

describe("close(deadline) 预算（plan §SP5: raceDeadline）", () => {
  it("a hanging write makes close() return within deadline+slack, queue abandoned", async () => {
    const h = hangingFs();
    const s = sink(h.fs);
    s.push(Buffer.from("in-flight"));
    await waitFor(() => h.handle.writes.length === 1);
    s.push(Buffer.from("queued")); // stays queued while the write hangs

    const t0 = Date.now();
    await s.close(deadline(50));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThanOrEqual(60);
    const abandoned = s.stats();
    expect(abandoned.dropped).toBe(15); // queue (6) + the in-flight write charged up front
    expect(abandoned.written).toBe(0);
    expect(h.handle.closeCount).toBe(0); // handle still held by the in-flight write

    h.releaseAll(); // the write finally lands → refunded, then the handle closes
    await waitFor(() => h.handle.closeCount === 1);
    const fin = s.stats();
    expect(fin.written).toBe(9);
    expect(fin.dropped).toBe(6); // byte conservation: 9 + 6 === 15 pushed
  });

  it("close() while open() is still pending waits for it within budget", async () => {
    let releaseOpen: (() => void) | undefined;
    const c = collectingFs();
    const fs: Partial<StderrFs> = {
      ...c.fs,
      open: () =>
        new Promise<SinkFileHandle>((resolve) => {
          releaseOpen = () => resolve(c.handle);
        }),
    };
    const s = sink(fs);
    s.push(Buffer.from("during-open"));
    const closing = s.close(deadline(500));
    await sleepReal(30);
    expect(c.handle.writes.length).toBe(0); // still waiting on open
    releaseOpen?.();
    await closing;
    expect(c.content()).toBe("during-open"); // queued data flushed after open landed
    expect(c.handle.closeCount).toBe(1);
  });
});

describe("ensureLogDir（文件数上限淘汰）", () => {
  it("keeps ≤19 stderr logs (oldest mtime evicted), leaves foreign files alone, 0700 dir", () => {
    const realDirFs = {
      mkdirSync: (p: string, o: { recursive: true; mode: number }) => mkdirSync(p, o),
      readdirSync: (p: string) => readdirSync(p),
      statSync: (p: string) => statSync(p),
      unlinkSync: (p: string) => {
        rmSync(p);
      },
    };
    ensureLogDir(dir, realDirFs); // fresh dir
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const base = Date.now() / 1000 - 100_000;
    for (let i = 0; i < 25; i++) {
      const p = join(dir, `sp_${String(i).padStart(3, "0")}.stderr.log`);
      writeFileSync(p, `log ${i}`);
      utimesSync(p, base + i, base + i);
    }
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "other.log"), "not ours");

    ensureLogDir(dir, realDirFs);
    const remaining = readdirSync(dir)
      .filter((n) => n.endsWith(".stderr.log"))
      .sort();
    expect(remaining.length).toBe(STDERR_FILES_MAX - 1);
    expect(remaining[0]).toBe("sp_006.stderr.log"); // 6 oldest evicted
    expect(remaining.at(-1)).toBe("sp_024.stderr.log");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "other.log"))).toBe(true);
  });

  it("is a no-op below the cap (no needless unlinks)", () => {
    const unlinked: string[] = [];
    const fs: Partial<StderrFs> = {
      mkdirSync: () => {},
      readdirSync: () => ["sp_a.stderr.log", "sp_b.stderr.log"],
      statSync: () => ({ mtimeMs: 1, isFile: () => true }),
      unlinkSync: (p) => {
        unlinked.push(p);
      },
    };
    ensureLogDir(dir, fs as Pick<StderrFs, "mkdirSync" | "readdirSync" | "statSync" | "unlinkSync">);
    expect(unlinked).toEqual([]);
  });
});
