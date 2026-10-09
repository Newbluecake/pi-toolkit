/**
 * web-hub session-history plan §4.8 step 6 (P-int) — the PD22 assembly gates: production uses
 * the REAL /proc scanner, and nothing but `HubDeps.spawnSeams` can change that. `main.ts` never
 * sets the seams, no environment variable and no `HubConfig` key can reach them, and the
 * history sources themselves never read `process.env`.
 *
 * Same lift as hub-spawn.test.ts: real `startHub` over a fake frontend, a fake reaper (no
 * watchdog child), a real tmp launcher fixture — the history service is constructed by the REAL
 * assembly (only its construction seams are observed), and `wrapHistory` is used strictly as
 * the observation seam PD22 defines (`diag()` reads, no behavior replacement).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendDeps, FrontendFactory, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { startHub, type RunningHub, type StartHubDeps } from "../../../src/web-hub/hub/hub.js";
import type { HistoryService, SessionPin } from "../../../src/web-hub/hub/spawn/history/ports.js";
import type { Reaper, ReaperTrackRecord } from "../../../src/web-hub/hub/spawn/reaper.js";
import { parseHubSpawnConfig } from "../../../src/web-hub/hub/spawn/config.js";
import type { HubSpawnConfig } from "../../../src/web-hub/protocol/spawn.js";
import { SPAWN_HISTORY_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { tmpDirs } from "./helpers.js";

const tmp = tmpDirs();
const hubs: RunningHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

// ---------------------------------------------------------------------------
// fixtures (hub-spawn.test.ts's shapes, trimmed to what the history assembly needs)
// ---------------------------------------------------------------------------

function launcherFixture(home: string): [string, string] {
  const pkgDir = join(home, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.2" }),
  );
  writeFileSync(join(pkgDir, "cli.js"), "// test launcher entry\n");
  return [process.execPath, join(pkgDir, "cli.js")];
}

function fakeReaper(): Reaper {
  let started = false;
  return {
    start: async () => {
      started = true;
      return true;
    },
    track: (_rec: ReaperTrackRecord) => {},
    untrack: (_pid: number) => {},
    close: () => {},
    get available() {
      return started;
    },
    onUnavailable: () => () => {},
    onRestart: () => () => {},
  };
}

/** Verifier r2 P1's middle failure point: the frontend FACTORY throwing during assembly. */
function frontendThrows(): FrontendFactory {
  return () => {
    throw new Error("frontend construction failed (test)");
  };
}

function fakeFrontend(listenFails = false): FrontendFactory & { deps: FrontendDeps[] } {
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    return {
      listen: async () => {
        if (listenFails) throw new Error("listen failed (test)");
        return { port: 43211 };
      },
      close: async () => {},
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    };
  }) as ReturnType<typeof fakeFrontend>;
  f.deps = [];
  return f;
}

interface AssemblyOpts {
  spawn?: HubSpawnConfig;
  spawnSeams?: StartHubDeps["spawnSeams"];
  /** Verifier P1-a: make `spawnSup.init()` reject (through `wrapSupervisor`) — the failure
   * point named by the finding, right after the history service is assigned + registered. */
  initFails?: boolean;
  /** Verifier P1-a: make the frontend's `listen()` reject — fails AFTER every cleanup entry
   * (incl. the spawn shutdown) is registered, so the rollback ordering can be asserted. */
  listenFails?: boolean;
  /** Verifier r2 P1: make the frontend FACTORY itself throw — the failure point between the
   * spawn assembly's early rollback entries and the frontend-side cleanup registrations. */
  frontendFails?: boolean;
}

interface Assembly {
  hub: RunningHub;
  history?: HistoryService;
  spawned: boolean;
}

async function startAssembly(opts: AssemblyOpts = {}): Promise<Assembly> {
  const home = tmp.make("wh-histasm-");
  let history: HistoryService | undefined;
  const callerWrapSup = opts.spawnSeams?.wrapSupervisor;
  const deps: StartHubDeps = {
    uid: process.getuid?.() ?? 0,
    childUmask: 0o022,
    spawnSeams: {
      reaper: fakeReaper(),
      ...(callerWrapSup === undefined ? {} : { wrapSupervisor: callerWrapSup }),
      // composed AFTER the caller's wrapper so the rejection wraps the spied supervisor too
      ...(opts.initFails === true
        ? {
            wrapSupervisor: (sup: import("../../../src/web-hub/hub/spawn/supervisor.js").SpawnSupervisor) => ({
              ...(callerWrapSup !== undefined ? callerWrapSup(sup) : sup),
              init: () => Promise.reject(new Error("init failed (test)")),
            }),
          }
        : {}),
      ...(opts.spawnSeams === undefined
        ? {}
        : {
            ...(opts.spawnSeams.historyProcFs === undefined ? {} : { historyProcFs: opts.spawnSeams.historyProcFs }),
            // verifier r2 P2: the SYNC /proc seam must be forwarded too — a silently dropped
            // historyProcSyncFs would make every sync-seam test vacuous.
            ...(opts.spawnSeams.historyProcSyncFs === undefined
              ? {}
              : { historyProcSyncFs: opts.spawnSeams.historyProcSyncFs }),
            ...(opts.spawnSeams.wrapHistory === undefined ? {} : { wrapHistory: opts.spawnSeams.wrapHistory }),
          }),
    },
  };
  const hub = await startHub(
    {
      v: 1,
      home,
      port: 0,
      idleExitMinutes: 10,
      pluginVersion: "1.2.3",
      buildId: "1.2.3@asm",
      launcher: launcherFixture(home),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    },
    // verifier r2 P1: a THIRD injectable failure point — the frontend FACTORY itself throwing
    // fails startup after the spawn assembly (both early rollback entries registered) but
    // BEFORE any frontend-side cleanup entry exists.
    opts.frontendFails === true ? frontendThrows() : fakeFrontend(opts.listenFails === true),
    deps,
  );
  if ("exists" in hub) throw new Error("unexpected exists");
  hubs.push(hub);
  return { hub, history, spawned: opts.spawn !== undefined };
}

const HISTORY_CFG: HubSpawnConfig = {
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 3,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "off",
  history: true,
};

describe("web-hub session-history assembly (PD22 / §4.8 step 6)", () => {
  it("no seam ⇒ the service runs the REAL procFs and fs (diag: default/default)", async () => {
    let captured: HistoryService | undefined;
    const asm = await startAssembly({
      spawn: HISTORY_CFG,
      spawnSeams: {
        wrapHistory: (svc) => {
          captured = svc;
          return svc;
        },
      },
    });
    void asm;
    expect(captured).toBeDefined();
    expect(captured!.diag().procFsSource).toBe("default");
    expect(captured!.diag().fsSource).toBe("default");
  }, 20_000);

  it("hostile env vars are ignored — the hub never reads procFs/seams from the environment", async () => {
    const saved: Record<string, string | undefined> = {};
    const hostile: Array<[string, string]> = [
      ["PI_WEBHUB_HISTORY_PROCFS", "/tmp/definitely-not-a-real-procfs"],
      ["PI_WEBHUB_HISTORY_PROCSYNCFS", "/tmp/definitely-not-a-real-procfs"],
      ["PI_WEBHUB_PROCSYNCFS", "1"],
      ["PI_WEBHUB_SPAWN_SEAMS", JSON.stringify({ procFs: {}, procSyncFs: {} })],
      ["PI_WEBHUB_HISTORY_FS", "/tmp/x"],
      ["PI_WEBHUB_HISTORY_SEAM", "1"],
    ];
    for (const [k, v] of hostile) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      let captured: HistoryService | undefined;
      await startAssembly({
        spawn: HISTORY_CFG,
        spawnSeams: {
          wrapHistory: (svc) => {
            captured = svc;
            return svc;
          },
        },
      });
      expect(captured!.diag().procFsSource).toBe("default");
      expect(captured!.diag().fsSource).toBe("default");
      // the SYNC reader is the DEFAULT real /proc one too: with no seam anywhere, a re-prove
      // over an EMPTY token against the real /proc must find this process's own parent
      // (vitest's main process — same-uid node*, not the hub pid) ⇒ NOT free. An env-injected
      // or config-injected sync view would have to make this verdict something else.
      const emptyToken = { at: 0, complete: true, pids: new Map() } as Parameters<HistoryService["reprove"]>[1];
      const v = captured!.reprove(fakePin(), emptyToken);
      expect(v.free).toBe(false);
    } finally {
      for (const [k] of hostile) {
        const prev = saved[k];
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
      }
    }
  }, 20_000);

  it("HubConfig.spawn keys historyProcFs/procFs/seams/fs are IGNORED (dispatcher ruling in config.ts: rejecting unknown keys would let a newer agent disable spawn on an older hub) — no config key ever reaches the seam", () => {
    const base = {
      roots: [],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 3,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 30,
      lan: "off" as const,
      history: true,
    };
    for (const key of ["historyProcFs", "historyProcSyncFs", "procSyncFs", "procFs", "seams", "fs", "wrapHistory"]) {
      const res = parseHubSpawnConfig({ ...base, [key]: { readdirProc: async () => [] } });
      expect(res.ok, `spawn.${key} must not reject the block (unknown keys are inert)`).toBe(true);
      if (res.ok) {
        // …and the parsed config carries NONE of them — the seam surface stays unreachable
        for (const k of ["historyProcFs", "historyProcSyncFs", "procSyncFs", "procFs", "seams", "fs", "wrapHistory"]) {
          expect((res.spawn as Record<string, unknown>)[k]).toBeUndefined();
        }
        expect(res.spawn.history).toBe(true);
      }
    }
  });

  /** A minimal main-kind pin for driving `reprove` directly through a captured service. */
  function fakePin(): SessionPin {
    return {
      id: "asm-pin",
      cwd: "/",
      kind: "main",
      size: 0,
      abs: "/asm-pin.jsonl",
      root: { dev: 0, ino: 0 },
      dir: { dev: 0, ino: 0 },
      file: { dev: 0, ino: 0 },
      release(): void {},
    };
  }

  it("verifier r2 P2: an injected historyProcSyncFs seam IS plumbed — a re-prove enumerates pids through it (and only through it), proving the sync seam reachable and the default reader bypassed", async () => {
    let syncReaddirCalls = 0;
    let captured: HistoryService | undefined;
    await startAssembly({
      spawn: HISTORY_CFG,
      spawnSeams: {
        historyProcSyncFs: {
          readdirProcSync: () => {
            syncReaddirCalls += 1;
            return []; // an empty /proc: the sync re-stat must find NOTHING to flag
          },
        },
        wrapHistory: (svc) => {
          captured = svc;
          return svc;
        },
      },
    });
    const emptyToken = { at: 0, complete: true, pids: new Map() } as Parameters<HistoryService["reprove"]>[1];
    const verdict = captured!.reprove(fakePin(), emptyToken);
    expect(syncReaddirCalls).toBe(1); // the seam's enumeration ran — hub.ts forwarded it
    expect(verdict.free).toBe(true); // empty sync view ⇒ no candidates ⇒ free
  }, 20_000);

  it('an injected historyProcFs seam ⇒ diag().procFsSource === "seam" (the seam itself works)', async () => {
    let captured: HistoryService | undefined;
    await startAssembly({
      spawn: HISTORY_CFG,
      spawnSeams: {
        historyProcFs: { readdirProc: async () => [] },
        wrapHistory: (svc) => {
          captured = svc;
          return svc;
        },
      },
    });
    expect(captured!.diag().procFsSource).toBe("seam");
    expect(captured!.diag().fsSource).toBe("default"); // the fs seam stays unreachable from HubDeps
  }, 20_000);

  it("history:false / absent ⇒ NO service is constructed at all and the cap is not advertised", async () => {
    for (const spawn of [undefined, { ...HISTORY_CFG, history: false }]) {
      let captured: HistoryService | undefined;
      const asm = await startAssembly({
        ...(spawn === undefined ? {} : { spawn }),
        spawnSeams: {
          wrapHistory: (svc) => {
            captured = svc;
            return svc;
          },
        },
      });
      expect(captured, "no history service may exist when the feature is off").toBeUndefined();
      expect(asm.hub.info.caps).not.toContain(SPAWN_HISTORY_HUB_CAP);
    }
  }, 30_000);

  // ---- verifier P1-a: startup rollback must release the history service -----------------------------

  /** A wrapHistory that records dispose calls onto `order`, wrapping the REAL dispose. */
  function historyDisposeSpy(order: string[]): {
    wrap: NonNullable<StartHubDeps["spawnSeams"]>["wrapHistory"];
    disposeCount: () => number;
  } {
    let count = 0;
    return {
      wrap: (svc) => ({
        ...svc,
        dispose: () => {
          count += 1;
          order.push("history.dispose");
          return svc.dispose();
        },
      }),
      disposeCount: () => count,
    };
  }

  it("P1-a: a spawnSup.init() failure after the service was assigned still disposes the history service exactly once", async () => {
    const order: string[] = [];
    const spy = historyDisposeSpy(order);
    let shutdownCalls = 0;
    await expect(
      startAssembly({
        spawn: HISTORY_CFG,
        initFails: true,
        spawnSeams: {
          wrapHistory: spy.wrap,
          wrapSupervisor: (sup) => ({
            ...sup,
            shutdown: (d, o) => {
              shutdownCalls += 1;
              order.push("spawn-shutdown");
              return sup.shutdown(d, o);
            },
          }),
        },
      }),
    ).rejects.toThrow("init failed (test)");
    // verifier r2 P1: the EARLY entry now covers init failures too — supervisor shutdown runs
    // (exactly once — the once-promise dedupes both entries), and BEFORE the history dispose.
    expect(shutdownCalls).toBe(1);
    expect(order).toEqual(["spawn-shutdown", "history.dispose"]);
    expect(spy.disposeCount()).toBe(1); // not zero (the old late-registration leak), not two
  }, 20_000);

  it("P1-a (r2): a frontend-FACTORY failure (between the spawn assembly and the frontend-side entries) ⇒ same order, exactly once each", async () => {
    const order: string[] = [];
    const spy = historyDisposeSpy(order);
    let shutdownCalls = 0;
    await expect(
      startAssembly({
        spawn: HISTORY_CFG,
        frontendFails: true,
        spawnSeams: {
          wrapHistory: spy.wrap,
          wrapSupervisor: (sup) => ({
            ...sup,
            shutdown: (d, o) => {
              shutdownCalls += 1;
              order.push("spawn-shutdown");
              return sup.shutdown(d, o);
            },
          }),
        },
      }),
    ).rejects.toThrow("frontend construction failed (test)");
    expect(shutdownCalls).toBe(1);
    expect(order).toEqual(["spawn-shutdown", "history.dispose"]);
    expect(spy.disposeCount()).toBe(1);
  }, 20_000);

  it("P1-a: a later assembly failure rolls back supervisor shutdown BEFORE history dispose, exactly once each", async () => {
    const order: string[] = [];
    const spy = historyDisposeSpy(order);
    let shutdownCalls = 0;
    await expect(
      startAssembly({
        spawn: HISTORY_CFG,
        listenFails: true,
        spawnSeams: {
          wrapHistory: spy.wrap,
          wrapSupervisor: (sup) => ({
            ...sup,
            shutdown: (d, o) => {
              shutdownCalls += 1;
              order.push("spawn-shutdown");
              return sup.shutdown(d, o);
            },
          }),
        },
      }),
    ).rejects.toThrow("listen failed (test)");
    expect(order).toContain("spawn-shutdown");
    expect(order).toContain("history.dispose");
    expect(order.indexOf("spawn-shutdown")).toBeLessThan(order.indexOf("history.dispose"));
    // verifier r2 P1: BOTH entries exist on this path (early + §SP13-late) yet the shared
    // once-promise runs the real shutdown exactly once, supervisor still first.
    expect(shutdownCalls).toBe(1);
    expect(spy.disposeCount()).toBe(1); // rollback ran it once; no runtime-close double-dispose
  }, 20_000);

  it("source scan: main.ts carries no seam names; history/** never reads process.env; hub.ts only wires spawnSeams", () => {
    const main = readFileSync("src/web-hub/hub/main.ts", "utf8");
    // verifier r2 P2: BOTH proc views + every seam name are forbidden in the production entry
    for (const forbidden of [
      "historyProcFs",
      "historyProcSyncFs",
      "procSyncFs",
      "procFs",
      "wrapHistory",
      "spawnSeams",
    ]) {
      expect(main).not.toContain(forbidden);
    }
    const historyDir = "src/web-hub/hub/spawn/history";
    for (const name of readdirSync(historyDir)) {
      if (!name.endsWith(".ts")) continue;
      // strip line comments first — ports.ts legitimately DOCUMENTS the agentDir source in one
      const src = readFileSync(join(historyDir, name), "utf8")
        .split("\n")
        .map((l) => l.replace(/\s*\/\/.*$/, "").replace(/\/\*.*\*\//g, ""))
        .join("\n");
      expect(src.includes("process.env"), `${historyDir}/${name} must not read process.env`).toBe(false);
    }
  });
});
