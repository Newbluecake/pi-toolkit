/**
 * Contract test ⑦ (plan §11 表格): the startup cancellation chain (§3.1 /
 * §1.4.2). Each scenario injects a hang at one of the three cancellable steps
 * (`fs.lstat` inside `acquireSingleton`'s post-bind identity computation,
 * `frontend.listen`, `lanAssembly.build`) and asserts `startHub` still
 * settles within `HUB_START_DEADLINE_MS` (faked via `vi.useFakeTimers()` —
 * the frozen `StartHubDeps` shape has no deadline override, so real time is
 * never actually spent waiting out the real 20s), that nothing is left
 * bound/dangling once the abandoned step eventually completes in the
 * background, and that `process.exit` is never called (startup failure is a
 * plain `throw`, never a process-level escape hatch).
 *
 * `advanceThroughRealIO` (below) is the load-bearing piece: `startHub`'s
 * early steps (`ensurePrivateDir`, `acquireSingleton`'s lock/bind) are real,
 * unmocked `fs`/`net` I/O in every one of these tests, and a single
 * `vi.advanceTimersByTimeAsync(HUB_START_DEADLINE_MS)` call fires the
 * (fake-timer) deadline before that real I/O gets a genuine event-loop turn
 * to complete — confirmed by instrumentation while writing this suite: the
 * injected hang was never even reached, so the original three tests below
 * were passing for the wrong reason. Advancing in small steps, each followed
 * by a *real* `setImmediate` yield (excluded from `toFake`), gives real I/O
 * actual turns to run between virtual-time increments.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import type { FrontendDeps, FrontendFactory, HttpFrontend, LanAssembly } from "../../../src/web-hub/hub/ports.js";
import { HUB_START_DEADLINE_MS, startHub } from "../../../src/web-hub/hub/hub.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { acquireSingleton } from "../../../src/web-hub/hub/singleton.js";
import { config, tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();
/** `setImmediate`/`Date` stay real; only the timers `startHub`'s deadline and our own injected delays use are faked. */
const FAKE_TIMER_OPTS = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] } as const;

afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

/** See the file-header note: interleaves fake-timer advancement with real event-loop turns. */
async function advanceThroughRealIO(totalMs: number, stepMs = 25): Promise<void> {
  for (let advanced = 0; advanced < totalMs; advanced += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - advanced));
    // Several real yields per step: under load (this file running alongside many others in the
    // same worker), a single setImmediate isn't always enough for the real fs/net op ahead of us
    // to actually settle before we move on.
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Retries `acquireSingleton` until it succeeds as owner. The abandoned/aborted attempt's own
 * cleanup (closeServer for the socket, then closeServer for the instance guard, sequentially in
 * its `finally` chain) can leave a short real-time gap where the socket file is already gone but
 * the Linux abstract-namespace guard hasn't been released yet — polling the socket file alone
 * (as an earlier version of this test did) races that gap; retrying the real acquisition itself
 * does not.
 */
async function waitForOwner(
  paths: Parameters<typeof acquireSingleton>[0],
  timeoutMs = 8_000, // generous: under full-suite parallel load, contention can slow retries down
): Promise<Extract<Awaited<ReturnType<typeof acquireSingleton>>, { kind: "owner" }>> {
  const startedAt = Date.now();
  for (;;) {
    // lockStaleMs: 0 — under heavy contention (a fully loaded test suite), the abandoned
    // attempt's own releaseLock() can itself exceed even LOCK_RELEASE_DEADLINE_MS and fail-safe
    // by leaving a fresh, live-pid lock file behind (correct: it never deletes a lock it
    // couldn't verify is still ours in time). A *later* starter configured with any nonzero
    // staleness tolerance would then correctly refuse to steal that lock from what looks like a
    // still-live holder (same process, still running) — exactly what the existing stale-lock
    // safety check is for, just not on a timescale this test can afford to wait out. Forcing
    // immediate staleness here is what a differently-configured, unrelated real starter would
    // eventually do anyway once `lockStaleMs` really elapses; it isn't bypassing a check this
    // test is trying to verify.
    const r = await acquireSingleton(paths, { probeMs: 100, lockStaleMs: 0 });
    if (r.kind === "owner") return r;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitForOwner timeout (last kind: ${r.kind})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeFrontend(opts: { hang?: "listen" } = {}): FrontendFactory & { closed: number } {
  const f = ((_deps: FrontendDeps): HttpFrontend => {
    return {
      listen: () => (opts.hang === "listen" ? new Promise<never>(() => {}) : Promise.resolve({ port: 40099 })),
      close: async () => {
        f.closed++;
      },
      clientCount: () => 0,
    };
  }) as FrontendFactory & { closed: number };
  f.closed = 0;
  return f;
}

describe("startup cancellation chain (plan §3.1 / §1.4.2, contract ⑦)", () => {
  it("a never-resolving fs.lstat (post-bind identity) ⇒ startHub rejects 'start timeout'; the singleton self-cleans", async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const home = tmp.make("wh-cancel-lstat-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let called = false;
    const hungLstat = () => {
      called = true;
      return new Promise<never>(() => {});
    };
    const p = startHub(config({ home }), fakeFrontend(), {
      uid,
      fs: { lstat: hungLstat as unknown as typeof import("node:fs/promises").lstat },
    });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(called).toBe(true); // the injected hang was actually reached, not skipped by an earlier abort
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a never-resolving frontend.listen ⇒ startHub rejects 'start timeout'; the socket is released afterwards", async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const home = tmp.make("wh-cancel-listen-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const fe = fakeFrontend({ hang: "listen" });
    const p = startHub(config({ home }), fe, { uid });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a never-resolving lanAssembly.build ⇒ startHub rejects 'start timeout'; the socket is released afterwards", async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const home = tmp.make("wh-cancel-lan-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let called = false;
    const hangingAssembly: LanAssembly = {
      build: () => {
        called = true;
        return new Promise(() => {});
      },
    };
    const cfg = config({ home });
    cfg.lan = { port: cfg.port + 1, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
    const p = startHub(cfg, fakeFrontend(), { uid, lanAssembly: hangingAssembly });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(called).toBe(true); // the injected hang was actually reached
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a plain (unhung) startHub still completes well inside the deadline (sanity: fake timers don't break the happy path)", async () => {
    const home = tmp.make("wh-cancel-happy-");
    const fe = fakeFrontend();
    const hub = await startHub(config({ home }), fe, { uid: process.getuid?.() ?? 0 });
    if ("exists" in hub) throw new Error("unexpected exists");
    await hub.close("test");
  });
});

// 审查修复 #6：三个可取消步骤各补一个“deadline 之后才 resolve”的场景（与上面“永不 resolve”互补：
// 前者验证迟到的真实值/真实资源到达后真正被自清理/丢弃，而不是“永远没机会跑到那一步”）。
describe("startup cancellation chain: results that resolve *after* the deadline (contract ⑦, review fix #6)", () => {
  it("a delayed-resolve fs.lstat: startHub rejects on time; once the real lstat value arrives later it is discarded (a fresh acquireSingleton still succeeds as owner)", async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const home = tmp.make("wh-cancel-lstat-late-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const realLstat = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).lstat;
    let called = false;
    const delayedLstat = ((path: Parameters<typeof realLstat>[0]) =>
      new Promise((resolve, reject) => {
        called = true;
        setTimeout(() => {
          realLstat(path).then(resolve, reject);
        }, HUB_START_DEADLINE_MS + 5_000); // resolves well after the deadline fires
      })) as unknown as typeof import("node:fs/promises").lstat;
    const p = startHub(config({ home }), fakeFrontend(), { uid, fs: { lstat: delayedLstat } });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion; // startHub already settled — the injected lstat hasn't fired yet
    // let the injected delayed lstat's own timer (and its real lstat call) actually fire and settle
    await advanceThroughRealIO(26_000);
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(called).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a delayed-resolve frontend.listen against a *real* bound socket: startHub rejects on time; the real server is actually closed once it notices the late abort", async () => {
    const home = tmp.make("wh-cancel-listen-late-");
    const uid = process.getuid?.() ?? 0;

    // Bind the *real* server with real timers/IO, before engaging any fake timer at all — mixing
    // a real net.Server.listen() bind with fake timers is exactly the trap `advanceThroughRealIO`
    // exists for elsewhere in this file; sidestepping it here by binding first is simpler and
    // just as faithful (the point under test is the *delayed resolve + late self-close*, not the
    // bind itself).
    const srv = net.createServer();
    srv.unref();
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = srv.address();
    const boundPort = addr !== null && typeof addr === "object" ? addr.port : 0;
    expect(boundPort).toBeGreaterThan(0);

    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let serverClosed = false;
    const fe = ((_deps: FrontendDeps): HttpFrontend => ({
      // Mirrors http.ts's own listen(opts) contract: resolution is deliberately delayed past the
      // deadline against the *already-bound* real server; a late abort self-closes it.
      listen: (opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = opts?.signal;
          let lateAbort = false;
          const onAbort = (): void => {
            lateAbort = true;
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            if (lateAbort) {
              srv.close(() => {
                serverClosed = true;
                reject(new Error("aborted: late listen self-closed"));
              });
              return;
            }
            resolve({ port: boundPort });
          }, HUB_START_DEADLINE_MS + 5_000);
        }),
      close: async () => {},
      clientCount: () => 0,
    })) as FrontendFactory;

    const p = startHub(config({ home }), fe, { uid });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion;
    expect(serverClosed).toBe(false); // the delayed timer hasn't fired yet
    await advanceThroughRealIO(26_000); // let it fire and self-close
    vi.useRealTimers();
    await waitFor(() => serverClosed, 3_000);

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a delayed-resolve lanAssembly.build: startHub rejects on time; once it resolves later its LanFrontendDeps are never wired into a frontend (no crash, no leaked fe)", async () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    const home = tmp.make("wh-cancel-lan-late-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const cfg = config({ home });
    cfg.lan = { port: cfg.port + 1, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };

    let called = false;
    let buildResolved = false;
    const delayedAssembly: LanAssembly = {
      build: () =>
        new Promise((resolve) => {
          called = true;
          setTimeout(() => {
            buildResolved = true;
            resolve({
              cfg: cfg.lan!,
              store: {} as never,
              kdf: {} as never,
              limiter: {} as never,
              admission: {} as never,
              hosts: {} as never,
              scope: {} as never,
              onStatus: () => {},
            });
          }, HUB_START_DEADLINE_MS + 5_000);
        }),
    };
    const fe = fakeFrontend();
    const p = startHub(cfg, fe, { uid, lanAssembly: delayedAssembly });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await advanceThroughRealIO(HUB_START_DEADLINE_MS);
    await assertion;
    expect(buildResolved).toBe(false);
    await advanceThroughRealIO(26_000); // let the delayed build() actually resolve
    vi.useRealTimers();
    await waitFor(() => buildResolved, 3_000);
    expect(fe.closed).toBe(0); // never constructed/closed: build() never got to hand off to frontend()

    const paths = resolveHubPaths({ home, uid });
    const again = await waitForOwner(paths);
    await again.release();
    expect(called).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
