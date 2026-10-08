/**
 * web-hub session-history plan §4.5.4 (`cwd.ts`): the six-state cwd status cache.
 */
import { describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import { createHistoryIoGate } from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createCwdCache, type CwdFs } from "../../../../../src/web-hub/hub/spawn/history/cwd.js";

function fakeFs(over: Partial<CwdFs>): CwdFs {
  return {
    realpath: async (p) => p,
    stat: async () => ({ isDirectory: () => true }),
    access: async () => undefined,
    ...over,
  };
}

function err(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("createCwdCache", () => {
  const now = () => 0;
  const gate = () => createHistoryIoGate();
  const deadline = () => createReqDeadline(now, 5000);

  it("ok: realpath === cwd, is a dir, accessible", async () => {
    const cache = createCwdCache();
    const state = await cache.check("/w/p", deadline(), { fs: fakeFs({}), gate: gate(), now });
    expect(state).toBe("ok");
  });

  it("gone: realpath ENOENT/ENOTDIR", async () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const cache = createCwdCache();
      const fs = fakeFs({ realpath: () => Promise.reject(err(code)) });
      expect(await cache.check("/w/p", deadline(), { fs, gate: gate(), now })).toBe("gone");
    }
  });

  it("no-access: other realpath errors, or EACCES on access()", async () => {
    const cache1 = createCwdCache();
    const fs1 = fakeFs({ realpath: () => Promise.reject(err("EACCES")) });
    expect(await cache1.check("/w/p", deadline(), { fs: fs1, gate: gate(), now })).toBe("no-access");

    const cache2 = createCwdCache();
    const fs2 = fakeFs({ access: () => Promise.reject(err("EACCES")) });
    expect(await cache2.check("/w/p", deadline(), { fs: fs2, gate: gate(), now })).toBe("no-access");
  });

  it("not-dir: realpath resolves to a non-directory", async () => {
    const cache = createCwdCache();
    const fs = fakeFs({ stat: async () => ({ isDirectory: () => false }) });
    expect(await cache.check("/w/p", deadline(), { fs, gate: gate(), now })).toBe("not-dir");
  });

  it("moved: realpath differs from the requested cwd", async () => {
    const cache = createCwdCache();
    const fs = fakeFs({ realpath: async () => "/elsewhere" });
    expect(await cache.check("/w/p", deadline(), { fs, gate: gate(), now })).toBe("moved");
  });

  it("caches a resolved state for HISTORY_CWD_CACHE_MS and does not re-call fs", async () => {
    let calls = 0;
    let clock = 0;
    const cache = createCwdCache(1000);
    const fs = fakeFs({
      realpath: async (p) => {
        calls += 1;
        return p;
      },
    });
    const deps = { fs, gate: gate(), now: () => clock };
    await cache.check(
      "/w/p",
      createReqDeadline(() => clock, 5000),
      deps,
    );
    expect(calls).toBe(1);
    clock = 500; // still within the cache window
    await cache.check(
      "/w/p",
      createReqDeadline(() => clock, 5000),
      deps,
    );
    expect(calls).toBe(1);
    clock = 1500; // past the cache window
    await cache.check(
      "/w/p",
      createReqDeadline(() => clock, 5000),
      deps,
    );
    expect(calls).toBe(2);
  });

  it("budget exhausted (deadline has nothing left) ⇒ unknown, uncached", async () => {
    const cache = createCwdCache();
    let calls = 0;
    const fs = fakeFs({
      realpath: async (p) => {
        calls += 1;
        return p;
      },
    });
    const exhausted = createReqDeadline(now, 0);
    expect(await cache.check("/w/p", exhausted, { fs, gate: gate(), now })).toBe("unknown");
    expect(calls).toBe(0);
    // a later, healthy request is NOT poisoned by the previous unknown (no caching of unknown)
    expect(await cache.check("/w/p", deadline(), { fs, gate: gate(), now })).toBe("ok");
    expect(calls).toBe(1);
  });

  it("a gate at admission capacity ⇒ unknown, uncached (never resolved as no-access)", async () => {
    const cache = createCwdCache();
    const g = createHistoryIoGate(0); // never admits anything
    const fs = fakeFs({});
    expect(await cache.check("/w/p", deadline(), { fs, gate: g, now })).toBe("unknown");
    expect(cache.size()).toBe(0);
  });
});
