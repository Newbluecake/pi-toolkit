/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #56 ⑦ step 7-1 — teardown matrix: WHICH component of WHICH stack is torn down, in WHAT order, per session entry.
 * (docs/dev/source-governance/batch2-plan.md §4.1 / §4.2.)
 *
 * It drives the REAL `activate()` (fake pi + fake ctx, throwaway $HOME) through the entries pi 1.3 really produces
 * (docs §4.1, pinned against real pi by tests/conformance/lifecycle-entries.test.ts):
 *   startup · same-cwd new/resume/fork (same module ⇒ stack.ts's `previous*` handoff = path A, after path C)
 *   · /reload and cross-cwd resume (fresh module ⇒ path C only) · quit · a second session_start without a shutdown
 *   (path B, the defensive block; unreachable in pi 1.3 but kept) .
 * and records an ordered log of every teardown call on the real components (helpers/teardown-probe.ts).
 *
 * THIS FILE PINS TODAY'S BEHAVIOUR, GAPS INCLUDED. The expectation tables below are the single source of truth for
 * the plan's §4.2 matrix; gaps are marked `GAP-Gn`. The 7a refactor (Stack.dispose + step table) must leave every
 * table byte-identical; each 7b fix flips exactly the cells of its own gap and says so in its commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILES } from "../governance/trace-profiles.js";
import { BASELINE, emitAll, fakeCtx, fakePi, resetGlobals, sandbox, type FakePi } from "./helpers/schedule-activate.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { getXsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { logMethod, trackTimers } from "./helpers/teardown-probe.js";
import { createGoalRecord } from "../../src/goal/state.js";
import { getChildSwitchCapability, resetChildSwitchCapabilityForTests } from "../../src/context-switch/capability.js";

const probe = {
  log: [] as string[],
  gen: 0,
  fakeActiveRun: false,
  stacks: [] as any[],
  broadcasters: [] as any[],
  coalescers: {} as Record<string, any>,
  wakes: [] as any[],
};

/**
 * Why `vi.doMock` + `installMocks()` instead of hoisted `vi.mock`: `vi.resetModules()` deliberately KEEPS mocked
 * modules (and the `importOriginal` result their factory captured), so a hoisted mock of src/stack.ts would pin ONE
 * module instance — and with it one set of stack.ts's module-level `previous*` variables — for the whole file. The
 * matrix needs a genuinely fresh stack.ts for every "fresh module" entry (/reload, cross-cwd), so every mock is
 * re-registered after each reset and re-runs its factory against a freshly evaluated original.
 */
const mocks: Array<[string, (importOriginal: () => Promise<any>) => any]> = [];
const mock = (path: string, factory: (importOriginal: () => Promise<any>) => any): void =>
  void mocks.push([path, factory]);
function freshModules(): void {
  vi.resetModules();
  for (const [path, factory] of mocks) vi.doMock(path, () => factory(() => vi.importActual(path)));
}

mock("../../src/stack.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/stack.js")>();
  const { instrumentStack } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    buildSessionStack: (...args: Parameters<typeof real.buildSessionStack>) => {
      const gen = ++probe.gen;
      probe.log.push(`build:g${gen}:begin`);
      const stack = real.buildSessionStack(...args);
      instrumentStack(probe, stack, gen);
      probe.stacks.push(stack);
      probe.log.push(`build:g${gen}:end`);
      return stack;
    },
  };
});
mock("../../src/delivery/usage-broadcast.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/delivery/usage-broadcast.js")>();
  class Probed extends real.UsageBroadcaster {
    private readonly tag: string;
    constructor(deps: ConstructorParameters<typeof real.UsageBroadcaster>[0]) {
      super({
        ...deps,
        list: () =>
          probe.fakeActiveRun
            ? ([{ runId: "r_fake", status: "running", diag: { usage: { costUsd: 0 } } }] as any)
            : deps.list(),
      });
      this.tag = `g${probe.gen}`;
      probe.broadcasters.push(this);
    }
    override dispose(): void {
      probe.log.push(`${this.tag}.usageBroadcaster.dispose`);
      super.dispose();
    }
  }
  return { ...real, UsageBroadcaster: Probed };
});
mock("../../src/delivery/coalescer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/delivery/coalescer.js")>();
  const { logMethod: wrap } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    createCoalescer: (deps: Parameters<typeof real.createCoalescer>[0]) => {
      const c = real.createCoalescer(deps);
      const label = deps.windowMs === ACK_WINDOW_MS ? "ackHold" : "coalescer";
      wrap(probe, `g${probe.gen}.${label}`, c, "dispose");
      probe.coalescers[label] = c;
      return c;
    },
  };
});
mock("../../src/fabric/mailbox.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/fabric/mailbox.js")>();
  const { logMethod: wrap } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    createFabricMailbox: (...args: Parameters<typeof real.createFabricMailbox>) => {
      const m = real.createFabricMailbox(...args);
      wrap(probe, `g${probe.gen}.fabric.mailbox`, m, "dispose");
      return m;
    },
  };
});
mock("../../src/fabric/wake.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/fabric/wake.js")>();
  const { logMethod: wrap } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    createWakeService: (...args: Parameters<typeof real.createWakeService>) => {
      const w = real.createWakeService(...args);
      wrap(probe, `g${probe.gen}.fabric.wake`, w, "dispose");
      probe.wakes.push(w);
      return w;
    },
  };
});
mock("../../src/bash/child-registry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/bash/child-registry.js")>();
  const { logMethod: wrap } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    getChildBashRegistry: () => {
      const registry = real.getChildBashRegistry();
      wrap(probe, "childBashRegistry", registry, "sealAll");
      return registry;
    },
    declareHostBashViewCapability: (registry: any) => {
      const tag = `g${probe.gen}`;
      const release = real.declareHostBashViewCapability(registry);
      return () => {
        probe.log.push(`${tag}.hostBashViewCapability.release`);
        release();
      };
    },
  };
});
mock("../../src/bash/host.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/bash/host.js")>();
  return {
    ...real,
    killBashJobsBounded: (...args: Parameters<typeof real.killBashJobsBounded>) => {
      probe.log.push("bashJobs.killBounded");
      return real.killBashJobsBounded(...args);
    },
  };
});
mock("../../src/service/background-status.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/service/background-status.js")>();
  return {
    ...real,
    publishBackgroundStatus: (...args: Parameters<typeof real.publishBackgroundStatus>) => {
      const release = real.publishBackgroundStatus(...args);
      return () => {
        probe.log.push("backgroundStatus.release");
        release();
      };
    },
  };
});
mock("../../src/context-switch/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/context-switch/store.js")>();
  class Probed extends real.PendingHandoffStore {
    override clear(): void {
      probe.log.push("handoffStore.clear");
      super.clear();
    }
  }
  return { ...real, PendingHandoffStore: Probed };
});
mock("../../src/schedule/agent/surface.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/schedule/agent/surface.js")>();
  const { logMethod: wrap } = await import("./helpers/teardown-probe.js");
  return {
    ...real,
    wireScheduleSurface: (...args: Parameters<typeof real.wireScheduleSurface>) => {
      const surface = real.wireScheduleSurface(...args);
      wrap(probe, "scheduleSurface", surface, "shutdown");
      return surface;
    },
  };
});

const ACK_WINDOW_MS = 2_000;
const HOST_KEY = Symbol.for("pi-subagent:host");

/** Everything switched on that can run offline (the activation-trace `max` profile) + the delivery windows. */
const FULL = {
  ...(PROFILES.max.settings as Record<string, unknown>),
  coalesceWindowMs: 1_000,
  ackWindowMs: ACK_WINDOW_MS,
};

let box: ReturnType<typeof sandbox>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const LEDGER_KEY = Symbol.for("pi-subagent:xs-wake-ledger");
const resetLedger = () => delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];

beforeEach(() => {
  // A fresh module graph per test: stack.ts's module-level `previous*` handoff must start empty.
  freshModules();
  resetLedger();
  resetGlobals();
  resetSecureDomainForTests();
  probe.log.length = 0;
  probe.gen = 0;
  probe.fakeActiveRun = false;
  probe.stacks.length = 0;
  probe.broadcasters.length = 0;
  probe.coalescers = {};
  probe.wakes.length = 0;
  box = sandbox("pi-matrix-");
  logMethod(probe as any, "xsLedger", getXsWakeLedger(), "teardown");
});
afterEach(async () => {
  vi.useRealTimers();
  // Quit every activation the test left running: their self-rescheduling timers (sysload sampler, fleet widget,
  // usage tick…) would otherwise leak into the NEXT test's timer evidence.
  for (const act of booted.splice(0)) {
    if (act.shutDown) continue;
    await emitAll(
      act.h,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      fakeCtx(box.home, { sid: act.sid }).ctx,
    );
  }
  resetLedger();
  resetGlobals();
  resetSecureDomainForTests();
  box.cleanup();
});

interface Act {
  h: FakePi;
  sid: string;
  /** Texts the activation sent through `pi.sendUserMessage` (the /goal loop's only outward channel). */
  userMessages: string[];
  /** Set once a session_shutdown has been fired on it (afterEach quits every activation that never saw one). */
  shutDown?: true;
}
const booted: Act[] = [];
let sidCounter = 0;
const newSid = () => `019a0000-aaaa-7bbb-8ccc-${String(++sidCounter).padStart(12, "0")}`;

async function boot(settings: unknown = FULL): Promise<Act> {
  box.writeSettings(settings);
  const { default: activate } = await import("../../src/index.js");
  const h = fakePi();
  const userMessages: string[] = [];
  (h.pi as any).sendUserMessage = (text: string) => void userMessages.push(text);
  activate(h.pi);
  const act: Act = { h, sid: newSid(), userMessages };
  booted.push(act);
  return act;
}
async function fire(a: Act, type: string, reason: string, opts: { sid?: string; ctx?: any } = {}): Promise<void> {
  probe.log.push(`-- ${type}(${reason})`);
  if (type === "session_shutdown") a.shutDown = true;
  const ctx = opts.ctx ?? fakeCtx(box.home, { sid: opts.sid ?? a.sid }).ctx;
  await emitAll(a.h, type, { type, reason }, ctx);
  await tick();
  await tick();
  probe.log.push(`   host=${(globalThis as Record<symbol, unknown>)[HOST_KEY] === undefined ? "free" : "held"}`);
}

// ───────────────────────────── expected sequences = the columns of plan §4.2 ─────────────────────────────
// `g` is the stack generation label (g1, g2, …). Profiles: "full" = activation-trace `max` (xs on, no rootWakeRecovery,
// no external agent); "extRoot" = fabric+wake with xs OFF, a pending xs ledger record (⇒ rootWakeRecovery) and
// externalAgents.droid.enabled (⇒ external port). Rows marked GAP-Gn are today's holes: the cell is EMPTY on purpose.

type Profile = "full" | "extRoot";
const HELD = "   host=held";
const FREE = "   host=free";
const xsHead = (g: string, profile: Profile): string[] =>
  profile === "full" ? [`${g}.xs.dispose`] : [`${g}.rootWakeRecovery.dispose`];

/** Path C = index.ts's session_shutdown handlers in registration order (C1 xs · C2 status · C3 handoff · C4 main). */
function pathC(g: string, reason: string, profile: Profile = "full", o: { kill?: boolean } = {}): string[] {
  return [
    // C1 — fabric/xs/activate.ts, registered early and synchronous
    ...(profile === "full" ? [`${g}.xs.fence.session_shutdown`, `${g}.xs.dispose`] : [`${g}.rootWakeRecovery.dispose`]),
    ...(reason === "reload" ? [] : ["xsLedger.teardown"]), // reload deliberately keeps pending xs authorisations
    // C2 — background-status release (+ HOST_KEY release, observed through the `host=` marker)
    "backgroundStatus.release",
    // C3 — compact-hint register.ts
    "handoffStore.clear",
    // C4 — the main async handler
    `${g}.backgroundCompletions.dispose`, // must be first: stop broadcasting before anything settles
    "scheduleSurface.shutdown",
    `${g}.schedule.shutdown`, // closeEpoch BEFORE the run drain
    `${g}.schedule.dispose`, // (nested inside shutdown)
    `${g}.scheduleBackground.dispose`, // AFTER closeEpoch
    `${g}.fleetWidget.dispose`,
    `${g}.archive.dispose`,
    `${g}.keepalive.dispose`,
    `${g}.quota.dispose`,
    `${g}.dynamic.dispose`,
    `${g}.load.dispose`,
    `${g}.rpc.close`,
    `${g}.bashJobRecovery.dispose`,
    `${g}.fabric.mailbox.dispose`, // before run shutdown: late verdicts must not reach the shared outbox
    `${g}.fabric.wake.dispose`, // (nested inside mailbox.dispose ⇒ closes G12)
    `${g}.workflow.runs.shutdown`,
    `${g}.query.waitAll`,
    `${g}.workflow.runs.drain`,
    `${g}.runJournal.flushPending`,
    `${g}.workflow.runs.seal`,
    `${g}.worktreeLate.dispose`, // after seal
    `${g}.worktreeOrphansStartup.dispose`,
    // G7 FIXED (7b): the external-agent port's directory probe is now stopped on shutdown too — /reload and cross-cwd
    // resume re-import the module, so path A never reaches the old port there.
    ...(profile === "extRoot" ? [`${g}.external.dispose`] : []),
    `${g}.hostBashViewCapability.release`,
    // GAP-G1 usageBroadcaster · GAP-G2 coalescer · GAP-G3 ackHold · GAP-G4 bashJobs manager:
    // none of them is touched on this path — they are disposed only by path A (same-module rebuild).
    ...(reason === "quit" ? [...(o.kill ? ["bashJobs.killBounded"] : []), "childBashRegistry.sealAll"] : []),
  ];
}

/** Path A = the top of the NEXT `buildSessionStack` in the same module (module-level `previous*` handoff). */
function pathA(g: string, profile: Profile = "full", o: { fabricAlreadyDisposed?: boolean } = {}): string[] {
  return [
    ...xsHead(g, profile),
    `${g}.backgroundCompletions.dispose`,
    `${g}.fleetWidget.dispose`,
    `${g}.usageBroadcaster.dispose`,
    `${g}.coalescer.dispose`,
    `${g}.ackHold.dispose`,
    `${g}.bashJobs.dispose`,
    `${g}.archive.dispose`,
    `${g}.bashJobRecovery.dispose`,
    `${g}.fabric.mailbox.dispose`,
    ...(o.fabricAlreadyDisposed === true ? [] : [`${g}.fabric.wake.dispose`]),
    `${g}.keepalive.dispose`,
    `${g}.quota.dispose`,
    `${g}.workflow.runs.abandon`,
    `${g}.worktreeLate.dispose`,
    `${g}.worktreeOrphansStartup.dispose`,
    `${g}.hostBashViewCapability.release`,
    ...(profile === "extRoot" ? [`${g}.external.dispose`] : []),
  ];
}

/** Path B = index.ts's session_start defensive block (a second session_start on the same activation). */
function pathB(g: string, profile: Profile = "full"): string[] {
  return [
    ...xsHead(g, profile),
    "xsLedger.teardown", // only because the new session id differs ⇒ proven end of the old session
    `${g}.backgroundCompletions.dispose`,
    `${g}.fleetWidget.dispose`,
    `${g}.archive.dispose`,
    `${g}.keepalive.dispose`,
    `${g}.quota.dispose`,
    ...(profile === "extRoot" ? [`${g}.external.dispose`] : []),
    `${g}.dynamic.dispose`,
    `${g}.load.dispose`,
    `${g}.schedule.dispose`, // dispose only — no closeEpoch (the next stack recovers the epoch)
    `${g}.scheduleBackground.dispose`,
    `${g}.rpc.close`,
    `${g}.fabric.mailbox.dispose`,
    `${g}.fabric.wake.dispose`,
    `${g}.workflow.runs.abandon`,
    // GAP-G5 bashJobRecovery · GAP-G6 worktreeLate / worktreeOrphansStartup / hostBashViewCapability · usage/coalescers/
    // bashJobs: only path A touches them (path B is unreachable in pi 1.3, see tests/conformance/lifecycle-entries).
  ];
}

const startupLog = (g = "g1"): string[] => ["-- session_start(startup)", `build:${g}:begin`, `build:${g}:end`, HELD];

async function startup(settings: unknown = FULL): Promise<string[]> {
  const a = await boot(settings);
  await fire(a, "session_start", "startup");
  return [...probe.log];
}
async function sameModuleSwitch(reason: string, settings: unknown = FULL, ledger = false): Promise<string[]> {
  const a = await boot(settings);
  if (ledger) putPendingWake(a.sid);
  await fire(a, "session_start", "startup");
  await fire(a, "session_shutdown", reason);
  const b = await boot(settings);
  await fire(b, "session_start", reason);
  return [...probe.log];
}
async function freshModuleSwitch(reason: string): Promise<string[]> {
  const a = await boot();
  await fire(a, "session_start", "startup");
  await fire(a, "session_shutdown", reason);
  freshModules();
  const b = await boot();
  await fire(b, "session_start", reason);
  return [...probe.log];
}
async function quit(settings: unknown = FULL): Promise<string[]> {
  const a = await boot(settings);
  await fire(a, "session_start", "startup");
  await fire(a, "session_shutdown", "quit");
  return [...probe.log];
}
async function defensive(settings: unknown = FULL, ledger = false): Promise<string[]> {
  const a = await boot(settings);
  if (ledger) putPendingWake(a.sid);
  await fire(a, "session_start", "startup");
  await fire(a, "session_start", "new", { sid: newSid() });
  return [...probe.log];
}
async function rebuildOnly(): Promise<string[]> {
  box.writeSettings(FULL);
  const { buildSessionStack } = await import("../../src/stack.js");
  const { loadSettingsFromFile } = await import("../../src/config/settings.js");
  const settings = loadSettingsFromFile(box.settingsPath);
  const types = { get: () => undefined, list: () => [], reload: async () => undefined } as any;
  const h = fakePi();
  const { ctx } = fakeCtx(box.home, { sid: newSid() });
  buildSessionStack(h.pi, ctx, settings, types, []);
  buildSessionStack(h.pi, ctx, settings, types, []);
  const log = [...probe.log];
  // No activation owns these stacks, so release the surviving one by hand (its timers would leak into later tests).
  const last = probe.stacks[probe.stacks.length - 1];
  for (const part of [
    last.xs,
    last.backgroundCompletions,
    last.fleetWidget,
    last.bashJobs,
    last.archive,
    last.bashJobRecovery,
    last.fabric,
    last.keepalive,
    last.quota,
    last.dynamic,
    last.load,
    last.rpc,
    last.worktreeLate,
    last.external,
  ])
    (part?.dispose ?? part?.close)?.call(part);
  last.workflow.runs.abandon();
  return log;
}

const EXT_ROOT = {
  ...FULL,
  fabric: { enabled: true, wake: { enabled: true } },
  externalAgents: { droid: { enabled: true } },
};
function putPendingWake(sessionId: string): void {
  getXsWakeLedger().put({ token: "t1", sessionId, xid: "x1", dispatchedAt: Date.now(), deadlineAt: Date.now() + 1e9 });
}

describe("teardown matrix: ordered calls per entry (FULL profile)", () => {
  it("startup tears nothing down", async () => {
    expect(await startup()).toEqual(startupLog());
  }, 60_000);

  it("pins the session_shutdown / session_start handler counts (order anchors for the other modules' handlers)", async () => {
    const a = await boot();
    // FULL: C1/C2/C3/C4 above are four of the 14 shutdown handlers (the rest: merged plugins, cache-ttl, schedule
    // message scheduler, web-hub, topic-switch, …). pi awaits them one after another in this registration order.
    expect(a.h.handlers.get("session_shutdown")?.length).toBe(14);
    expect(a.h.handlers.get("session_start")?.length).toBe(16);
    freshModules();
    resetGlobals();
    const minimal = await boot(BASELINE);
    expect(minimal.h.handlers.get("session_shutdown")?.length).toBe(8);
    expect(minimal.h.handlers.get("session_start")?.length).toBe(8);
  }, 60_000);

  it.each(["new", "resume", "fork"])(
    "same-cwd %s (same module): path C of the old stack, then path A in the next build",
    async (reason) => {
      expect(await sameModuleSwitch(reason)).toEqual([
        ...startupLog(),
        `-- session_shutdown(${reason})`,
        ...pathC("g1", reason),
        FREE,
        `-- session_start(${reason})`,
        "build:g2:begin",
        ...pathA("g1", "full", { fabricAlreadyDisposed: true }),
        "build:g2:end",
        HELD,
      ]);
    },
    60_000,
  );

  it("/reload (fresh module): path C only — the new module's build has nothing to hand off", async () => {
    expect(await freshModuleSwitch("reload")).toEqual([
      ...startupLog(),
      "-- session_shutdown(reload)",
      ...pathC("g1", "reload"),
      FREE,
      "-- session_start(reload)",
      "build:g2:begin",
      "build:g2:end",
      HELD,
    ]);
  }, 60_000);

  it("cross-cwd resume (fresh module): like /reload, plus the xs ledger teardown (reason ≠ reload)", async () => {
    expect(await freshModuleSwitch("resume")).toEqual([
      ...startupLog(),
      "-- session_shutdown(resume)",
      ...pathC("g1", "resume"),
      FREE,
      "-- session_start(resume)",
      "build:g2:begin",
      "build:g2:end",
      HELD,
    ]);
  }, 60_000);

  it("quit: path C, then the child bash registry is sealed; shutdownPolicy=kill adds the bounded kill before it", async () => {
    expect(await quit()).toEqual([...startupLog(), "-- session_shutdown(quit)", ...pathC("g1", "quit"), FREE]);
    probe.log.length = 0;
    probe.gen = 0;
    freshModules();
    resetGlobals();
    expect(await quit({ ...FULL, bashJobs: { enabled: true, shutdownPolicy: "kill" } })).toEqual([
      ...startupLog(),
      "-- session_shutdown(quit)",
      ...pathC("g1", "quit", "full", { kill: true }),
      FREE,
    ]);
  }, 60_000);

  it("a second session_start without a shutdown (path B, unreachable in pi 1.3): B first, then A", async () => {
    expect(await defensive()).toEqual([
      ...startupLog(),
      "-- session_start(new)",
      ...pathB("g1"),
      "build:g2:begin",
      ...pathA("g1", "full", { fabricAlreadyDisposed: true }),
      "build:g2:end",
      HELD,
    ]);
  }, 60_000);

  it("path A alone (a rebuild with neither B nor C before it) also disposes the wake service through the mailbox", async () => {
    expect(await rebuildOnly()).toEqual([
      "build:g1:begin",
      "build:g1:end",
      "build:g2:begin",
      ...pathA("g1", "full"),
      "build:g2:end",
    ]);
  }, 60_000);
});

describe("teardown matrix: rootWakeRecovery + external agent (EXT_ROOT profile)", () => {
  it("same-cwd new: C disposes rootWakeRecovery and the external port (G7), A disposes both again (idempotent)", async () => {
    expect(await sameModuleSwitch("new", EXT_ROOT, true)).toEqual([
      ...startupLog(),
      "-- session_shutdown(new)",
      ...pathC("g1", "new", "extRoot"),
      FREE,
      "-- session_start(new)",
      "build:g2:begin",
      ...pathA("g1", "extRoot", { fabricAlreadyDisposed: true }),
      "build:g2:end",
      HELD,
    ]);
  }, 60_000);

  it("path B disposes the external port too (between quota and dynamic)", async () => {
    expect(await defensive(EXT_ROOT, true)).toEqual([
      ...startupLog(),
      "-- session_start(new)",
      ...pathB("g1", "extRoot"),
      "build:g2:begin",
      ...pathA("g1", "extRoot", { fabricAlreadyDisposed: true }),
      "build:g2:end",
      HELD,
    ]);
  }, 60_000);
});

// ─────────────────────────────── gaps, with evidence (fake timers) ───────────────────────────────
// Each test pins what happens TODAY after a /reload-style shutdown (fresh module ⇒ path A never runs). A 7b fix flips
// exactly one of these tests and says so in its commit.

const FAKE = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const };
// web-hub (its reconnect timer) is out of ⑦'s scope; external-agent's background catalog probe of the EXT_ROOT tests
// (started during EXT_ROOT boot, before any shutdown can stop it) can still be settling when the next test installs fake timers.
const notWebHub = (sites: Array<{ site: string }>) =>
  sites.filter((o) => !o.site.startsWith("src/web-hub/") && !o.site.startsWith("src/external-agent/"));
const payload = (runId: string, status: string) => ({
  key: `${runId}:1`,
  runId,
  generation: 1,
  status,
  textPreview: "done",
  diag: {},
  createdAt: 0,
  reconcileRound: 0,
});
const completionsOf = (h: FakePi) => h.sent.filter((m) => m.message?.customType === "subagent:notification").length;

describe("teardown matrix: residual timers and the gaps they prove (after a /reload-style shutdown)", () => {
  let timers: ReturnType<typeof trackTimers>;
  beforeEach(() => {
    vi.useFakeTimers(FAKE as any);
    timers = trackTimers();
  });
  afterEach(() => timers.stop());

  it("baseline: an idle FULL stack leaves no timer of its own behind after shutdown (only the web-hub reconnect timer, out of scope)", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    expect(notWebHub(timers.outstanding()).length).toBeGreaterThan(0); // the stack really armed timers…
    await fire(a, "session_shutdown", "reload");
    expect(notWebHub(timers.outstanding())).toEqual([]); // …and path C cleared every one of them
  }, 60_000);

  it("every timer the stack arms is unref'd (I5)", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    probe.broadcasters[0].poke();
    const live = timers.outstanding();
    expect(live.length).toBeGreaterThan(0);
    expect(live.filter((o) => o.ref).map((o) => o.site)).toEqual([]);
  }, 60_000);

  it("GAP-G1: the usage broadcaster of the outgoing stack keeps ticking at 1 Hz on the OLD pi after session_shutdown", async () => {
    probe.fakeActiveRun = true; // the broadcaster believes one run is in flight ⇒ it re-arms forever
    const a = await boot();
    let emitted = 0;
    (a.h.pi as any).events.emit = (channel: string) => channel === "subagent:usage" && void emitted++;
    await fire(a, "session_start", "startup");
    probe.broadcasters[0].poke();
    expect(emitted).toBe(1);
    await fire(a, "session_shutdown", "reload");
    const atShutdown = emitted;
    expect(timers.outstanding().map((o) => o.site)).toContain("src/delivery/usage-broadcast.ts");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitted - atShutdown).toBe(60); // one frame per second, indefinitely (only process exit stops it)
  }, 60_000);

  it("GAP-G2/G3: a coalescer / ackHold hold-window of the outgoing stack still flushes through the OLD pi after shutdown", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    probe.coalescers.coalescer.submit(payload("r_c", "completed"));
    probe.coalescers.ackHold.submit(payload("r_a", "completed"));
    expect(completionsOf(a.h)).toBe(0); // both buffered
    await fire(a, "session_shutdown", "reload");
    expect(completionsOf(a.h)).toBe(0); // path C did not flush or dispose them
    expect(
      notWebHub(timers.outstanding())
        .map((o) => `${o.site}:${o.ms}`)
        .sort(),
    ).toEqual(["src/delivery/coalescer.ts:1000", "src/delivery/coalescer.ts:2000"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completionsOf(a.h)).toBe(1); // coalescer window (GAP-G2)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completionsOf(a.h)).toBe(2); // ackHold window (GAP-G3)
  }, 60_000);

  it("GAP-G10: a notifier retry already scheduled at shutdown still runs on the OLD pi (bounded by deliveryAttempts=3)", async () => {
    const a = await boot();
    let sends = 0;
    (a.h.pi as any).sendMessage = () => {
      sends++;
      throw new Error("stale ctx");
    };
    await fire(a, "session_start", "startup");
    probe.stacks[0].notifier.enqueue(payload("r_n", "failed")); // not coalescible ⇒ sent at once, throws, retry armed
    expect(sends).toBe(1);
    await fire(a, "session_shutdown", "reload");
    expect(timers.outstanding().map((o) => o.site)).toContain("src/delivery/notifier.ts");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sends).toBe(3); // two more attempts after shutdown, then the notifier gives up
    expect(notWebHub(timers.outstanding())).toEqual([]);
  }, 60_000);

  it("GAP-G9: the /goal delivery watchdog survives shutdown and keeps talking through the OLD pi", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    const goal = probe.stacks[0].goal;
    goal.record = createGoalRecord({
      objective: "x",
      maxTurns: 20,
      maxMinutes: 0,
      budgetTokens: 0,
      budgetCostUsd: 0,
      now: Date.now(),
    });
    const tui = fakeCtx(box.home, { sid: a.sid, mode: "tui" }).ctx;
    await emitAll(a.h, "agent_settled", { type: "agent_settled" }, tui);
    await tick();
    await tick();
    expect(a.userMessages.length).toBe(1); // the continuation
    expect(timers.outstanding().map((o) => o.site)).toContain("src/goal/hook.ts");
    await fire(a, "session_shutdown", "reload");
    expect(timers.outstanding().map((o) => o.site)).toContain("src/goal/hook.ts"); // not cancelled
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.userMessages.length).toBe(3); // retry at 30 s + brake report at 60 s, both after shutdown
  }, 60_000);

  it("GAP-G12 CLOSED: wake-service timers are cleared by fabric.dispose (mailbox.dispose → inbox.dispose), nothing outlives shutdown", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    expect(probe.wakes[0].subscribe("r_successor", "r_waker")).toBe("ok");
    expect(timers.outstanding().map((o) => o.site)).toContain("src/fabric/wake.ts"); // 10-min subscriber watch armed
    await fire(a, "session_shutdown", "reload");
    expect(timers.outstanding().filter((o) => o.site === "src/fabric/wake.ts")).toEqual([]);
    expect(notWebHub(timers.outstanding())).toEqual([]);
  }, 60_000);
});

describe("teardown matrix: activate-level gaps (no timers needed)", () => {
  it("GAP-G8: holder.current is never cleared — a tool call after shutdown is still served by the torn-down stack", async () => {
    const a = await boot();
    await fire(a, "session_start", "startup");
    await fire(a, "session_shutdown", "reload");
    const tool = a.h.tools.get("get_run_result");
    expect(tool).toBeDefined();
    const result = await tool
      .execute("call-1", { runId: "r_missing" }, undefined, undefined, fakeCtx(box.home).ctx)
      .catch((e: Error) => e);
    expect(String((result as any)?.message ?? "")).not.toMatch(/no active session yet/);
  }, 60_000);

  it("GAP-G11: every activate() leaves one more child-switch onDisabled listener behind (N toasts for one event)", async () => {
    const toasts: string[] = [];
    const uiCtx = (label: string) => {
      const { ctx } = fakeCtx(box.home, { sid: newSid() });
      ctx.hasUI = true;
      ctx.ui.notify = (message: string) => /switch_context/.test(message) && void toasts.push(label);
      return ctx;
    };
    const a = await boot();
    await fire(a, "session_start", "startup", { ctx: uiCtx("a") });
    await fire(a, "session_shutdown", "new");
    const b = await boot();
    await fire(b, "session_start", "new", { ctx: uiCtx("b") });
    await fire(b, "session_shutdown", "new");
    const c = await boot();
    await fire(c, "session_start", "new", { ctx: uiCtx("c") });
    getChildSwitchCapability().noteFatal("matrix-probe");
    expect(toasts.sort()).toEqual(["a", "b", "c"]); // one event, three toasts — two of them on dead contexts
    resetChildSwitchCapabilityForTests();
  }, 60_000);
});
