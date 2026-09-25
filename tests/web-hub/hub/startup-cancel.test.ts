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
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import type { FrontendDeps, FrontendFactory, HttpFrontend, LanAssembly } from "../../../src/web-hub/hub/ports.js";
import { HUB_START_DEADLINE_MS, startHub } from "../../../src/web-hub/hub/hub.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { acquireSingleton } from "../../../src/web-hub/hub/singleton.js";
import { config, tmpDirs, waitFor } from "./helpers.js";

const tmp = tmpDirs();

afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

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
    vi.useFakeTimers();
    const home = tmp.make("wh-cancel-lstat-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const hungLstat = () => new Promise<never>(() => {});
    const p = startHub(config({ home }), fakeFrontend(), {
      uid,
      fs: { lstat: hungLstat as unknown as typeof import("node:fs/promises").lstat },
    });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await vi.advanceTimersByTimeAsync(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    await waitFor(() => !existsSync(paths.socketPath), 3_000);
    const again = await acquireSingleton(paths, { probeMs: 200 });
    expect(again.kind).toBe("owner");
    if (again.kind === "owner") await again.release();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a never-resolving frontend.listen ⇒ startHub rejects 'start timeout'; the socket is released afterwards", async () => {
    vi.useFakeTimers();
    const home = tmp.make("wh-cancel-listen-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const fe = fakeFrontend({ hang: "listen" });
    const p = startHub(config({ home }), fe, { uid });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await vi.advanceTimersByTimeAsync(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    await waitFor(() => !existsSync(paths.socketPath), 3_000);
    const again = await acquireSingleton(paths, { probeMs: 200 });
    expect(again.kind).toBe("owner");
    if (again.kind === "owner") await again.release();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("a never-resolving lanAssembly.build ⇒ startHub rejects 'start timeout'; the socket is released afterwards", async () => {
    vi.useFakeTimers();
    const home = tmp.make("wh-cancel-lan-");
    const uid = process.getuid?.() ?? 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const hangingAssembly: LanAssembly = { build: () => new Promise(() => {}) };
    const cfg = config({ home });
    cfg.lan = { port: cfg.port + 1, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
    const p = startHub(cfg, fakeFrontend(), { uid, lanAssembly: hangingAssembly });
    const assertion = expect(p).rejects.toThrow(/start timeout/);
    await vi.advanceTimersByTimeAsync(HUB_START_DEADLINE_MS);
    await assertion;
    vi.useRealTimers();

    const paths = resolveHubPaths({ home, uid });
    await waitFor(() => !existsSync(paths.socketPath), 3_000);
    const again = await acquireSingleton(paths, { probeMs: 200 });
    expect(again.kind).toBe("owner");
    if (again.kind === "owner") await again.release();
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
