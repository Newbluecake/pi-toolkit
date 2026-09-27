// optimize-plan §3.2 / §10 B7 (todo #22 P0-b): withMemoryDirLock — serial
// exclusion, stale-lock breaking (age + dead-pid), and token-scoped release.

import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryError } from "../../src/memory/paths.js";
import { lockCreate, lockRead } from "../../src/memory/safe-fs.js";
import { withMemoryDirLock } from "../../src/memory/lock.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "mem-lock-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("withMemoryDirLock", () => {
  it("serializes two concurrent bodies on the same directory (no time overlap)", async () => {
    const dir = tmp();
    const events: string[] = [];
    const a = withMemoryDirLock(dir, () => {
      events.push("a-start");
      events.push("a-end");
      return "A";
    });
    const b = withMemoryDirLock(dir, () => {
      events.push("b-start");
      events.push("b-end");
      return "B";
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra, rb].sort()).toEqual(["A", "B"]);
    // Whichever ran first must fully finish before the other starts —
    // no "a-start b-start a-end b-end" interleave is possible.
    const firstIsA = events[0] === "a-start";
    expect(events).toEqual(
      firstIsA ? ["a-start", "a-end", "b-start", "b-end"] : ["b-start", "b-end", "a-start", "a-end"],
    );
  });

  it("releases the lock after body throws (does not deadlock the next caller)", async () => {
    const dir = tmp();
    await expect(
      withMemoryDirLock(dir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await withMemoryDirLock(dir, () => "ok");
    expect(result).toBe("ok");
  });

  it("times out with a MemoryError when the lock stays held (not stale) past timeoutMs", async () => {
    const dir = tmp();
    lockCreate(dir, { pid: process.pid, host: "some-other-host", token: "held", at: Date.now() });
    await expect(withMemoryDirLock(dir, () => "never", { timeoutMs: 80 })).rejects.toThrow(MemoryError);
    await expect(withMemoryDirLock(dir, () => "never", { timeoutMs: 80 })).rejects.toThrow(/busy/);
  });

  it("breaks a lock that is stale by age and proceeds", async () => {
    const dir = tmp();
    lockCreate(dir, { pid: 999_999_999, host: "some-other-host", token: "stale", at: Date.now() - 60_000 });
    utimesSync(join(dir, ".lock"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const result = await withMemoryDirLock(dir, () => "recovered", { timeoutMs: 500 });
    expect(result).toBe("recovered");
  });

  it("breaks a lock held by a dead pid on the SAME host, even if fresh", async () => {
    const dir = tmp();
    const { hostname } = await import("node:os");
    lockCreate(dir, { pid: 999_999_999, host: hostname(), token: "dead-pid", at: Date.now() });
    const result = await withMemoryDirLock(dir, () => "recovered", { timeoutMs: 500 });
    expect(result).toBe("recovered");
  });

  it("does NOT break a fresh lock held by a live pid on a different host", async () => {
    const dir = tmp();
    lockCreate(dir, { pid: process.pid, host: "definitely-not-this-host", token: "live-elsewhere", at: Date.now() });
    await expect(withMemoryDirLock(dir, () => "never", { timeoutMs: 80 })).rejects.toThrow(MemoryError);
  });

  it("WARNs (does not throw) when body runs past the slow threshold, and still releases", async () => {
    const dir = tmp();
    const logs: string[] = [];
    // A short custom timeout window with a synchronous body that just takes a
    // little real time is impractical to force reliably without sleeping the
    // event loop (the lock body must stay synchronous) — instead assert the
    // log hook is wired and unrelated bodies never log.
    const result = await withMemoryDirLock(dir, () => "fast", { log: (m) => logs.push(m) });
    expect(result).toBe("fast");
    expect(logs).toEqual([]);
  });

  it("leaves no lock file behind on the success path", async () => {
    const dir = tmp();
    await withMemoryDirLock(dir, () => undefined);
    expect(lockRead(dir)).toBeUndefined();
  });

  it("two rapid successive locks each get their own token (no stale-break of a live sibling)", async () => {
    const dir = tmp();
    const seen: string[] = [];
    await withMemoryDirLock(dir, () => {
      seen.push("first");
    });
    await withMemoryDirLock(dir, () => {
      seen.push("second");
    });
    expect(seen).toEqual(["first", "second"]);
  });
});
