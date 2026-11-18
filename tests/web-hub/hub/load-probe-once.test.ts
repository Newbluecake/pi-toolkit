/**
 * darwin-plan §4.2-H (修订 #5): the hub's ONE load startup probe, shared by every consumer.
 *
 * Before S2 the probe ran twice — `assembleHubCaps` (the `load.v1` cap) and `createHubLoad`
 * (the service) each probed independently. On Linux both /proc reads agree; on darwin the
 * probe is a SUBPROCESS, so two probes can disagree (cap without service, or service without
 * cap — the UI would either show a cap that never produces a frame, or silently drop frames).
 * S2 unifies them: `prepareHubChannels` computes `ctx.loadProbeOk` ONCE per hub lifetime; the
 * cap declaration and the frontend handoff (`FrontendDeps.loadProbed` → http.ts →
 * `createHubLoad({probed})`) both read that one value.
 *
 * What this file pins, tier1 and subprocess-free on every platform:
 * 1. `hubLoadProbe`'s platform dispatch (linux = original /proc/stat logic; other non-darwin
 *    platforms false; darwin consults the injectable `probeDarwin` seam — the REAL darwin
 *    probe is a sysctl subprocess and belongs to S4's mac smoke, never here).
 * 2. `createHubLoad`'s probe precedence: `probed` set ⇒ never probes; `probed` absent ⇒ probes
 *    exactly once (the pre-S2 behavior for every old test double that ignores the field).
 * 3. The hub assembly: an injected flip probe (true, then false forever) is called EXACTLY
 *    once per start, and the one result reaches BOTH consumers — `HubInfo.caps` carries
 *    `load.v1` ⇔ the frontend receives `loadProbed === true` (which http.ts turns into the
 *    service, the `/api/load/top` route and the SSE `load` frames — those wire-level halves
 *    are pinned by the tier2 `tests/integration/web-hub-load.test.ts` real-hub suite).
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { HubLoadConfig } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { createHubLoad, hubLoadProbe, LOAD_HUB_CAP } from "../../../src/web-hub/hub/load.js";
import { config, tmpDirs } from "./helpers.js";

const loadConfig: HubLoadConfig = {
  sampleIntervalMs: 5_000,
  sustainMs: 60_000,
  recoverMs: 30_000,
  thresholds: {
    cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
    mem: { warnAvailPercent: 15, critAvailPercent: 8 },
    disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
  },
};

/** Same fake-frontend pattern as caps-coexist.test.ts: no listener, no socket — the factory
 *  only captures the FrontendDeps so the loadProbed handoff is observable without HTTP. */
function fakeFrontend(): { factory: FrontendFactory; deps: FrontendDeps[] } {
  const deps: FrontendDeps[] = [];
  const factory: FrontendFactory = (captured): HttpFrontend => {
    deps.push(captured);
    return {
      listen: async () => ({ port: 43210 }),
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  };
  return { factory, deps };
}

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close("test");
  tmp.cleanup();
});

describe("hubLoadProbe platform dispatch (darwin-plan §2.6)", () => {
  it("darwin consults the injected probeDarwin seam", () => {
    expect(hubLoadProbe({ platform: "darwin", probeDarwin: () => true })).toBe(true);
    expect(hubLoadProbe({ platform: "darwin", probeDarwin: () => false })).toBe(false);
  });

  it("every other non-linux platform stays false", () => {
    expect(hubLoadProbe({ platform: "win32" })).toBe(false);
    expect(hubLoadProbe({ platform: "freebsd" })).toBe(false);
    expect(hubLoadProbe({ platform: "sunos" })).toBe(false);
  });

  it("linux keeps the original /proc/stat probe verbatim", () => {
    // The pre-S2 logic: open /proc/stat, bounded read, `/^cpu(?:\s|\d)/m`. On a Linux CI host
    // that is always true; on a mac dev machine /proc does not exist ⇒ false — both are the
    // ORIGINAL behavior, asserted host-agnostically. (The real default `hubLoadProbe()` on
    // darwin runs a sysctl subprocess — S4's mac smoke owns that, never this tier1 file.)
    expect(hubLoadProbe({ platform: "linux" })).toBe(existsSync("/proc/stat"));
  });
});

describe("createHubLoad probe precedence (probed / probe)", () => {
  it("probed:true creates the service without ever probing", async () => {
    let calls = 0;
    const service = createHubLoad(loadConfig, {
      home: "/",
      probe: () => {
        calls++;
        return true;
      },
      probed: true,
      io: {},
    });
    expect(service).toBeDefined();
    expect(calls).toBe(0);
    await service!.dispose();
  });

  it("probed:false skips the service and never probes", () => {
    let calls = 0;
    const service = createHubLoad(loadConfig, {
      home: "/",
      probe: () => {
        calls++;
        return true;
      },
      probed: false,
      io: {},
    });
    expect(service).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("probed absent ⇒ the service probes exactly once itself (pre-S2 behavior)", async () => {
    let calls = 0;
    const service = createHubLoad(loadConfig, {
      home: "/",
      probe: () => {
        calls++;
        return true;
      },
      io: {},
    });
    expect(service).toBeDefined();
    expect(calls).toBe(1);
    await service!.dispose();
    expect(calls).toBe(1);
  });

  it("probed absent and probe false ⇒ no service (fail-closed)", () => {
    const service = createHubLoad(loadConfig, { home: "/", probe: () => false, io: {} });
    expect(service).toBeUndefined();
  });

  it("a malformed config never reaches the probe, even with probed:true", () => {
    let calls = 0;
    const service = createHubLoad(
      { ...loadConfig, recoverMs: 1 },
      {
        home: "/",
        probe: () => {
          calls++;
          return true;
        },
        probed: true,
      },
    );
    expect(service).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("hub assembly probes the load host exactly once and shares the one result", () => {
  it("flip probe (true then false): exactly ONE call, caps ∋ load.v1, frontend loadProbed === true", async () => {
    const home = tmp.make("wh-load-probe-");
    const fe = fakeFrontend();
    let calls = 0;
    const flipProbe = (): boolean => {
      const result = calls === 0;
      calls++;
      return result;
    };
    const hub = await startHub(config({ home, load: loadConfig }), fe.factory, {
      loadSeams: { probe: flipProbe },
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    expect(calls).toBe(1);
    expect(hub.info.caps).toContain(LOAD_HUB_CAP);
    expect(fe.deps).toHaveLength(1);
    expect(fe.deps[0]!.loadProbed).toBe(true);
    // The service side never re-probes (createHubLoad precedence pinned above), so the flip
    // probe returning false FOREVER after the first call cannot produce a cap/service split.
    expect(calls).toBe(1);
    await hub.close("test");
    expect(calls).toBe(1);
  });

  it("constant-false probe: ONE call, no load.v1 cap, frontend loadProbed === false", async () => {
    const home = tmp.make("wh-load-probe-");
    const fe = fakeFrontend();
    let calls = 0;
    const hub = await startHub(config({ home, load: loadConfig }), fe.factory, {
      loadSeams: {
        probe: () => {
          calls++;
          return false;
        },
      },
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    expect(calls).toBe(1);
    expect(hub.info.caps).not.toContain(LOAD_HUB_CAP);
    expect(fe.deps[0]!.loadProbed).toBe(false);
    await hub.close("test");
    expect(calls).toBe(1);
  });

  it("feature off (no config.load): zero probe calls, no loadProbed key, no cap (I9)", async () => {
    const home = tmp.make("wh-load-probe-");
    const fe = fakeFrontend();
    let calls = 0;
    const hub = await startHub(config({ home }), fe.factory, {
      loadSeams: {
        probe: () => {
          calls++;
          return true;
        },
      },
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    expect(calls).toBe(0);
    expect(hub.info.caps).not.toContain(LOAD_HUB_CAP);
    expect(fe.deps[0]!.loadProbed).toBeUndefined();
    expect("loadProbed" in fe.deps[0]!).toBe(false);
    await hub.close("test");
  });

  it("malformed config.load: the probe is short-circuited away, loadProbed === false", async () => {
    const home = tmp.make("wh-load-probe-");
    const fe = fakeFrontend();
    let calls = 0;
    const hub = await startHub(config({ home, load: { ...loadConfig, recoverMs: 1 } }), fe.factory, {
      loadSeams: {
        probe: () => {
          calls++;
          return true;
        },
      },
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);
    // The normalize gate short-circuits BEFORE the probe — a malformed feature key probes
    // nothing, declares no cap, and still hands the frontend a definite false (never a
    // stale/undefined value that could fall back to a second probe downstream).
    expect(calls).toBe(0);
    expect(hub.info.caps).not.toContain(LOAD_HUB_CAP);
    expect(fe.deps[0]!.loadProbed).toBe(false);
    await hub.close("test");
  });
});
