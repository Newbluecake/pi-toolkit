/**
 * cache-keepalive-web plan §3.6: deps.cacheKeepalive → StatusInfo.cacheKeepalive through the status-slot
 * pipeline (1Hz fingerprint gate, session boundary, snapshot_req, byte-equality without the dep).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireWebHub, type WebHubDeps } from "../../../src/web-hub/agent/index.js";
import type { CacheKeepaliveInput } from "../../../src/web-hub/agent/cache-keepalive.js";
import { createInitialSessionTotals, createInitialWindowState } from "../../../src/cache-ttl/keepalive-state.js";
import type { KeepaliveReport, LineState } from "../../../src/cache-ttl/keepalive-state.js";
import { ackFrame, fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-ka-");
  resetGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

interface Knobs {
  pings: number;
  armed: boolean;
  mode: "auto" | "on" | "off";
  lines: Record<string, LineState>;
  throws: boolean;
  empty: boolean;
}
const knobs = (): Knobs => ({ pings: 3, armed: false, mode: "auto", lines: {}, throws: false, empty: false });
function getter(k: Knobs): () => CacheKeepaliveInput | undefined {
  return () => {
    if (k.throws) throw new Error("boom");
    if (k.empty) return undefined;
    const report: KeepaliveReport = {
      enabled: true,
      armed: k.armed,
      window: { ...createInitialWindowState(), pings: 1 },
      session: { ...createInitialSessionTotals(), pings: k.pings, cacheReadTokens: 1000, lineStates: k.lines },
      config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
      costUsd: 0.1,
      dropped: { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 },
      lastSkip: undefined,
      prefixSource: "usage",
      supportsLongCacheRetention: true,
      lastPingDiagnostics: undefined,
      currentLineKey: "k1",
      now: Date.now() as never,
    };
    return { report, mode: k.mode, dirty: false };
  };
}

type Sock = ReturnType<typeof fakeNet>["sockets"][number];
async function goLive(n: ReturnType<typeof fakeNet>): Promise<Sock> {
  await vi.advanceTimersByTimeAsync(0);
  const s = n.sockets[0]!;
  s.emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  s.hub(ackFrame());
  await vi.advanceTimersByTimeAsync(0);
  return s;
}
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
  }
}
const statusFrames = (s: Sock) => s.frames().filter((f) => f.t === "status");
type KaFrame = { cacheKeepalive?: { session: { pings: number }; mode: string; lines: Array<{ retryAt?: number }> } };

async function start(k: Knobs | undefined, extra: Partial<WebHubDeps> = {}) {
  const n = fakeNet();
  const { pi, fire } = fakePi();
  wireWebHub(
    pi,
    deps({ netConnect: n.netConnect, ...(k !== undefined ? { cacheKeepalive: getter(k) } : {}), ...extra }),
  );
  const { ctx } = fakeCtx({ mode: "tui" });
  fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  const s = await goLive(n);
  return { n, s, pi, fire, ctx };
}

describe("cacheKeepalive slot wiring (P-A)", () => {
  it("dep ⇒ frame carries the field; quiet ticks (incl. armed flapping) add no frames; a ping landing ≤ 1 tick publishes", async () => {
    const k = knobs();
    const { s } = await start(k);
    await tick(1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.session.pings).toBe(3);
    const before = statusFrames(s).length;
    for (let i = 0; i < 4; i++) {
      k.armed = !k.armed; // tool_start / tool_end flapping
      await tick(1);
    }
    expect(statusFrames(s).length).toBe(before);
    k.pings = 4;
    await tick(1);
    expect(statusFrames(s).length).toBe(before + 1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.session.pings).toBe(4);
    k.mode = "on";
    await tick(1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.mode).toBe("on");
  });

  it("cooldown expiry flips retryAt presence ⇒ exactly one frame", async () => {
    const k = knobs();
    k.lines = {
      k1: {
        label: "p/m@h",
        status: 403,
        consecutive: 2,
        total: 2,
        open: true,
        trips: 2,
        updatedAt: 1,
        resetEligibleAt: Date.now() + 2_500,
      },
    };
    const { s } = await start(k);
    await tick(1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.lines[0]?.retryAt).toBeTypeOf("number");
    const before = statusFrames(s).length;
    await tick(1); // t+2s: still cooling
    expect(statusFrames(s).length).toBe(before);
    await tick(1); // crosses 2.5s
    expect(statusFrames(s).length).toBe(before + 1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.lines[0]?.retryAt).toBeUndefined();
    await tick(3);
    expect(statusFrames(s).length).toBe(before + 1);
  });

  it("no dep ⇒ key never appears", async () => {
    const { s } = await start(undefined);
    await tick(3);
    for (const f of statusFrames(s)) expect("cacheKeepalive" in f).toBe(false);
  });

  it("getter returning undefined (silent / holder empty) ⇒ absent", async () => {
    const k = knobs();
    k.empty = true;
    const { s } = await start(k);
    await tick(2);
    for (const f of statusFrames(s)) expect("cacheKeepalive" in f).toBe(false);
  });

  it("getter throwing ⇒ field absent, no crash, ticks keep working", async () => {
    const k = knobs();
    k.throws = true;
    const { s } = await start(k);
    await tick(3);
    for (const f of statusFrames(s)) expect("cacheKeepalive" in f).toBe(false);
    k.throws = false;
    await tick(1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.session.pings).toBe(3);
  });

  it("stack rebuild (getter now reads a different service) ⇒ next frame swaps content", async () => {
    const k = knobs();
    const { s } = await start(k);
    await tick(1);
    k.pings = 9; // holder.current points at a fresh service
    await tick(1);
    expect((statusFrames(s).at(-1) as KaFrame).cacheKeepalive?.session.pings).toBe(9);
  });

  it("snapshot_req reply carries the field", async () => {
    const k = knobs();
    const { s } = await start(k);
    await tick(1);
    s.hub({ t: "snapshot_req", rid: "r-ka" });
    await tick(1);
    const reply = s.frames().find((f) => f.t === "snapshot_reply") as { status?: KaFrame };
    expect(reply?.status?.cacheKeepalive?.session.pings).toBe(3);
  });

  it("session_start resets the fingerprint: an unchanged projection re-publishes after a new session", async () => {
    const k = knobs();
    const { s, fire, ctx } = await start(k);
    await tick(2);
    const before = statusFrames(s).filter((f) => "cacheKeepalive" in f).length;
    fire("session_start", { type: "session_start", reason: "new" }, ctx);
    await tick(2);
    expect(statusFrames(s).filter((f) => "cacheKeepalive" in f).length).toBeGreaterThan(before);
  });
});
