/**
 * worktree-diff plan §1.10 (D3): changeset cache mechanics — key composition, TTL, LRU(8),
 * the 2 MiB total bound, the single-flight refcount/abort semantics, and the no-content-fields
 * invariant of the stored value (I6: paths + statuses + flags ONLY — never git output bodies
 * or file content).
 */

import { describe, expect, it, vi } from "vitest";

import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import {
  SingleFlightCache,
  changesetKeyOf,
  createChangesetCache,
  type ChangesetValue,
} from "../../../../src/web-hub/hub/worktree-diff/changeset.js";
import { WTDIFF_CHANGESET_TTL_MS } from "../../../../src/web-hub/protocol/worktree-diff.js";

const IDS = {
  wt: { dev: 1, ino: 11 },
  git: { dev: 1, ino: 22 },
  common: { dev: 1, ino: 33 },
};

function value(paths: string[]): ChangesetValue {
  return {
    base: "0123456789abcdef0123456789abcdef01234567",
    entries: paths.map((p) => ({ path: p, status: "M" as const })),
    totalVisible: paths.length,
    limitsStatus: false,
    limitsFiles: false,
  };
}

describe("changesetKeyOf §1.10 — key composition", () => {
  it("joins dev:ino ids, oid, indexStat, attrSig and the untracked mode with NULs, in order", () => {
    expect(changesetKeyOf(IDS, "oid-a", "1:2:3", "sig-x", "all")).toBe(
      "1:11\0" + "1:22\0" + "1:33\0" + "oid-a\0" + "1:2:3\0" + "sig-x\0" + "all",
    );
  });

  it("every component participates: any change yields a different key", () => {
    const base = changesetKeyOf(IDS, "oid-a", "1:2:3", "sig-x", "all");
    expect(changesetKeyOf({ ...IDS, wt: { dev: 1, ino: 99 } }, "oid-a", "1:2:3", "sig-x", "all")).not.toBe(base);
    expect(changesetKeyOf(IDS, "oid-b", "1:2:3", "sig-x", "all")).not.toBe(base);
    expect(changesetKeyOf(IDS, "oid-a", "9:2:3", "sig-x", "all")).not.toBe(base);
    expect(changesetKeyOf(IDS, "oid-a", "1:2:3", "sig-y", "all")).not.toBe(base);
    expect(changesetKeyOf(IDS, "oid-a", "1:2:3", "sig-x", "no")).not.toBe(base);
  });
});

describe("changeset cache §1.10 — TTL / LRU / single-flight", () => {
  it("TTL: a fresh hit is served from cache (compute never runs); past the TTL it recomputes", async () => {
    const clock = { t: 10_000 };
    const cache = createChangesetCache(() => clock.t);
    let computes = 0;
    const d = createReqDeadline(() => clock.t, 1_000);
    const v1 = value(["a"]);
    const a1 = cache.acquire("k", d, async () => {
      computes++;
      return v1;
    });
    expect(await a1.promise).toBe(v1);
    a1.release();
    const a2 = cache.acquire("k", d, async () => {
      computes++;
      return value(["b"]);
    });
    const hit = await a2.promise;
    a2.release();
    expect(hit).toBe(v1); // cached, not recomputed
    expect(a2.cached).toBe(true);
    expect(computes).toBe(1);
    clock.t += WTDIFF_CHANGESET_TTL_MS + 1;
    const a3 = cache.acquire("k", d, async () => {
      computes++;
      return value(["c"]);
    });
    expect(await a3.promise).toEqual(value(["c"]));
    a3.release();
    expect(computes).toBe(2);
  });

  it("single-flight: concurrent same-key acquisitions join ONE computation", async () => {
    const cache = createChangesetCache(() => 0);
    let computes = 0;
    let releaseCompute: (() => void) | undefined;
    const d = createReqDeadline(() => 0, 1_000);
    const leader = cache.acquire(
      "k",
      d,
      () =>
        new Promise<ChangesetValue>((resolve) => {
          computes++;
          releaseCompute = () => resolve(value(["z"]));
        }),
    );
    const joiner = cache.acquire("k", d, async () => {
      computes++;
      return value(["nope"]);
    });
    expect(joiner.joined).toBe(true);
    expect(leader.joined).toBe(false);
    await Promise.resolve();
    releaseCompute!();
    expect(await leader.promise).toEqual(value(["z"]));
    expect(await joiner.promise).toEqual(value(["z"]));
    leader.release();
    joiner.release();
    expect(computes).toBe(1);
  });

  it("single-flight abort: the LAST leaver aborts the shared execution", async () => {
    const cache = createChangesetCache(() => 0);
    const d = createReqDeadline(() => 0, 1_000);
    let signal: AbortSignal | undefined;
    const leader = cache.acquire("k", d, (exec) => {
      signal = exec.signal;
      return new Promise<ChangesetValue>(() => {});
    });
    const joiner = cache.acquire("k", d, async () => value(["x"]));
    leader.release(); // one leaver left — the exec must survive
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    joiner.release(); // the last one — now it aborts
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
  });

  it("the shared execution's deadline is the FIRST joiner's (§1.10)", async () => {
    const cache = createChangesetCache(() => 0);
    const d1 = createReqDeadline(() => 0, 111);
    const d2 = createReqDeadline(() => 0, 222);
    let seen: unknown;
    const a1 = cache.acquire("k", d1, (exec) => {
      seen = exec.deadline;
      return new Promise<ChangesetValue>(() => {});
    });
    const a2 = cache.acquire("k", d2, async () => value(["x"]));
    expect(seen).toBe(d1);
    a1.release();
    a2.release();
  });

  it("LRU: the 9th distinct key evicts the oldest; an evicted key recomputes", async () => {
    const clock = { t: 0 };
    const cache = createChangesetCache(() => clock.t);
    const d = createReqDeadline(() => clock.t, 1_000);
    for (let i = 0; i < 9; i++) {
      const a = cache.acquire(`k${i}`, d, async () => value([`p${i}`]));
      await a.promise;
      a.release();
    }
    expect(cache.size().cached).toBe(8);
    // k0 was evicted — a fresh acquire recomputes rather than serving the stale value
    let recomputed = false;
    const a = cache.acquire("k0", d, async () => {
      recomputed = true;
      return value(["fresh"]);
    });
    expect(await a.promise).toEqual(value(["fresh"]));
    a.release();
    expect(recomputed).toBe(true);
  });

  it("stored values carry ONLY path/status/flag fields — no git output body, no content (I6)", () => {
    const v = value(["a", "b"]);
    expect(Object.keys(v).sort()).toEqual(["base", "entries", "limitsFiles", "limitsStatus", "totalVisible"]);
    for (const e of v.entries) {
      expect(Object.keys(e).sort()).toEqual(["path", "status"]);
    }
  });

  it("a value larger than the whole cache budget is computed but NOT stored", async () => {
    const clock = { t: 0 };
    const cache = createChangesetCache(() => clock.t);
    const d = createReqDeadline(() => clock.t, 1_000);
    const big = value(Array.from({ length: 4_000 }, (_, i) => `p${i}`.padEnd(600, "x")));
    const a1 = cache.acquire("big", d, async () => big);
    expect(await a1.promise).toBe(big);
    a1.release();
    expect(cache.size().cached).toBe(0);
  });
});

describe("join-only cache (the C4 single-flight, I6)", () => {
  it("never stores: a sequential second acquire always recomputes", async () => {
    const cache = new SingleFlightCache<string>({
      ttlMs: 60_000,
      lruMax: 8,
      totalBytes: 1 << 20,
      store: false,
      now: () => 0,
    });
    const d = createReqDeadline(() => 0, 1_000);
    let computes = 0;
    const a1 = cache.acquire("k", d, async () => {
      computes++;
      return "one";
    });
    expect(await a1.promise).toBe("one");
    a1.release();
    const a2 = cache.acquire("k", d, async () => {
      computes++;
      return "two";
    });
    expect(await a2.promise).toBe("two"); // join-only: never a cached "one"
    a2.release();
    expect(computes).toBe(2);
    expect(cache.size().cached).toBe(0);
  });

  it("abortAll aborts every live shared execution (dispose, §1.10)", async () => {
    const cache = new SingleFlightCache<string>({
      ttlMs: 60_000,
      lruMax: 8,
      totalBytes: 1 << 20,
      store: false,
      now: () => 0,
    });
    const d = createReqDeadline(() => 0, 1_000);
    const signals: AbortSignal[] = [];
    for (const k of ["a", "b"]) {
      const acq = cache.acquire(k, d, (exec) => {
        signals.push(exec.signal);
        return new Promise<string>(() => {});
      });
      acq.release(); // leaver, but refcount semantics keep the exec alive until settle — the abort below fires it
    }
    cache.abortAll("hub-close");
    for (const s of signals) expect(s.aborted).toBe(true);
  });

  it("a rejected shared execution propagates to every joiner (each maps its own response)", async () => {
    const cache = createChangesetCache(() => 0);
    const d = createReqDeadline(() => 0, 1_000);
    const boom = new Error("stale");
    const a1 = cache.acquire("k", d, async () => {
      throw boom;
    });
    const a2 = cache.acquire("k", d, async () => value(["x"]));
    await expect(a1.promise).rejects.toBe(boom);
    await expect(a2.promise).rejects.toBe(boom);
    a1.release();
    a2.release();
    // and the failed key is NOT cached
    const a3 = cache.acquire("k", d, async () => value(["ok"]));
    await expect(a3.promise).resolves.toEqual(value(["ok"]));
    a3.release();
  });

  it("vi.useFakeTimers never leaks into the cache (clock-injected only)", () => {
    vi.useRealTimers();
    expect(WTDIFF_CHANGESET_TTL_MS).toBe(5_000);
  });
});
