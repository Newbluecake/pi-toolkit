/**
 * Shared kit for the SP9 `/api/headless*` HTTP-layer suites (`api-headless.test.ts`,
 * `headless-matrix.test.ts`, `lan-headless.test.ts`): configurable fakes for the three
 * collaborators `createSpawnRoutes` needs (supervisor / dirs / first-prompt forwarder) plus a
 * one-call wiring helper, so the tests exercise the REAL route module through the REAL
 * `createHttpFrontend` HTTP stack (per the repo's `tests/web-hub/http/` style) without any
 * fork, procfs or reaper involvement.
 */
import { createCmdLimit } from "../../../src/web-hub/hub/cmd-limit.js";
import type { HubLog } from "../../../src/web-hub/hub/ports.js";
import { createSpawnRoutes } from "../../../src/web-hub/hub/spawn/routes.js";
import type { AdmitResult, DirService } from "../../../src/web-hub/hub/spawn/dirs.js";
import type { FirstPromptForwarder, FirstPromptStateView } from "../../../src/web-hub/hub/spawn/first-prompt.js";
import type { SpawnFrontendPort } from "../../../src/web-hub/hub/spawn/ports.js";
import type {
  AdmittedRequest,
  Death,
  InternalRecord,
  RemoveResult,
  SpawnSupervisor,
  StartResult,
} from "../../../src/web-hub/hub/spawn/supervisor.js";
import type { DirEntryWire, HubSpawnConfig, SpawnPolicyWire, SpawnState } from "../../../src/web-hub/protocol/spawn.js";
import { captureLog } from "./helpers.js";
import { type FakeClock } from "./lan-helpers.js";

// ---------------------------------------------------------------------------
// fake supervisor
// ---------------------------------------------------------------------------

export interface FakeSpawnSupervisor extends SpawnSupervisor {
  startCalls: AdmittedRequest[];
  stopCalls: Array<{ spawnId: string; force: boolean }>;
  policyCalls: Array<{
    principal: string;
    listener: "loopback" | "lan";
    scheme: "http" | "https";
    viaTrustedProxy: boolean;
  }>;
  setPolicy(
    policyOrFn: SpawnPolicyWire | ((args: FakeSpawnSupervisor["policyCalls"][number]) => SpawnPolicyWire),
  ): void;
  setStartResult(result: StartResult): void;
  setStopResult(result: { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" }): void;
  seedRecord(rec: Partial<InternalRecord> & Pick<InternalRecord, "spawnId">): InternalRecord;
  recordsOut: InternalRecord[];
  /** web-hub-delete-session plan v2 §2.4/§7.1: `remove()`'s call log + controllable result
   * (default: look up the seeded record in `recordsOut` and mirror the real supervisor's
   * non-terminal→pending / terminal+confirmed→removed behavior off its `state`/`exit`). */
  removeCalls: Array<{ spawnId: string }>;
  setRemoveResult(resultOrFn: RemoveResult | ((spawnId: string) => RemoveResult)): void;
  /** Controllable `lookupByAgentKey`/`deathOf` — default lookup scans `recordsOut` by agentKey
   * (latest `updatedAt`); default deathOf is "unknown" unless overridden. */
  setDeathOf(resultOrFn: Death | undefined | ((spawnId: string) => Death | undefined)): void;
}

export const ALLOWED_POLICY: SpawnPolicyWire = {
  allowed: true,
  confirm: "unknown-dir",
  scope: "known",
  max: 4,
  maxPerPrincipal: 2,
  active: 0,
  activeMine: 0,
  registerTimeoutS: 30,
  maxLifetimeMinutes: 720,
};

export function fakeSpawnSupervisor(): FakeSpawnSupervisor {
  const startCalls: AdmittedRequest[] = [];
  const stopCalls: FakeSpawnSupervisor["stopCalls"] = [];
  const policyCalls: FakeSpawnSupervisor["policyCalls"] = [];
  let policyFn: (args: FakeSpawnSupervisor["policyCalls"][number]) => SpawnPolicyWire = () => ({ ...ALLOWED_POLICY });
  let startResult: StartResult = { ok: true, spawnId: "" }; // spawnId patched per call
  let stopResult: { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" } = {
    ok: true,
    state: "stopping",
  };
  const recordsOut: InternalRecord[] = [];
  const removeCalls: FakeSpawnSupervisor["removeCalls"] = [];
  let removeFn: ((spawnId: string) => RemoveResult) | undefined;
  let deathFn: (spawnId: string) => Death | undefined = () => "unknown";
  return {
    startCalls,
    stopCalls,
    policyCalls,
    recordsOut,
    removeCalls,
    setRemoveResult(resultOrFn) {
      removeFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setDeathOf(resultOrFn) {
      deathFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setPolicy(policyOrFn) {
      policyFn = typeof policyOrFn === "function" ? policyOrFn : () => ({ ...policyOrFn });
    },
    setStartResult(result) {
      startResult = result;
    },
    setStopResult(result) {
      stopResult = result;
    },
    seedRecord(partial) {
      const rec: InternalRecord = {
        state: "starting",
        cwd: "/home/u/proj",
        dev: 1,
        ino: 2,
        createdAt: 1,
        updatedAt: 1,
        owner: { listener: "loopback", reqId: "req-aaaaaaaaaaaaaaaa" },
        linked: false,
        control: undefined,
        sessionId: undefined,
        hintDetail: undefined,
        uiCancelled: [],
        stderrTail: () => undefined,
        removePending: false,
        ...partial,
      };
      recordsOut.push(rec);
      return rec;
    },
    async init() {},
    policy(principal, listener, scheme, viaTrustedProxy) {
      const args = { principal, listener, scheme, viaTrustedProxy };
      policyCalls.push(args);
      return policyFn(args);
    },
    start(req) {
      startCalls.push(req);
      if (startResult.ok) {
        // mirror the real supervisor: a successful start owns a `starting` record from now on
        // (dup replays look it up by spawnId — the "202 ⇔ 有记录" contract)
        recordsOut.push({
          spawnId: req.spawnId,
          state: "starting",
          cwd: req.admitted.realpath,
          dev: req.admitted.dev,
          ino: req.admitted.ino,
          createdAt: 1,
          updatedAt: 1,
          owner: { ...req.owner },
          ...(req.firstPrompt === undefined
            ? {}
            : { firstPrompt: { state: "pending" as const, textLen: req.firstPrompt.textLen } }),
          linked: false,
          control: undefined,
          sessionId: undefined,
          hintDetail: undefined,
          uiCancelled: [],
          stderrTail: () => undefined,
          removePending: false,
        });
        return { ok: true, spawnId: req.spawnId };
      }
      return startResult;
    },
    stop(spawnId, force) {
      stopCalls.push({ spawnId, force });
      return stopResult;
    },
    records() {
      return recordsOut;
    },
    isManaged: () => false,
    noteVersion() {},
    liveCount() {
      return recordsOut.filter((r) => r.state !== "exited" && r.state !== "failed").length;
    },
    busyCount() {
      return 0;
    },
    noteSpawnChanged() {},
    lookupByAgentKey(agentKey) {
      let best: InternalRecord | undefined;
      for (const rec of recordsOut) {
        if (rec.agentKey !== agentKey) continue;
        if (best === undefined || rec.updatedAt > best.updatedAt) best = rec;
      }
      return best === undefined ? undefined : { spawnId: best.spawnId };
    },
    remove(spawnId, deadline) {
      removeCalls.push({ spawnId });
      if (removeFn !== undefined) return removeFn(spawnId);
      const rec = recordsOut.find((r) => r.spawnId === spawnId);
      if (rec === undefined) return { ok: false, code: "E_NOT_FOUND" };
      const terminal = rec.state === "exited" || rec.state === "failed";
      if (!terminal) {
        if (deadline.remaining() < 500) return { ok: false, code: "E_DEADLINE" };
        return { ok: true, outcome: "pending", state: "stopping" };
      }
      const d = deathFn(spawnId);
      if (d === "confirmed") return { ok: true, outcome: "removed" };
      return { ok: false, code: "E_AGENT_ONLINE", reason: "exit-unconfirmed" };
    },
    deathOf(spawnId) {
      return deathFn(spawnId);
    },
    async shutdown() {},
  };
}

// ---------------------------------------------------------------------------
// fake dirs
// ---------------------------------------------------------------------------

export interface FakeDirs extends DirService {
  admitCalls: Array<{ raw: string; scope: "known" | "roots" }>;
  knownEntries: DirEntryWire[];
  knownPartial: boolean;
  setAdmitResult(result: AdmitResult | ((raw: string, scope: "known" | "roots") => AdmitResult)): void;
}

export function fakeDirs(): FakeDirs {
  const admitCalls: FakeDirs["admitCalls"] = [];
  let admitFn: (raw: string, scope: "known" | "roots") => AdmitResult = (raw) => ({
    ok: true,
    realpath: raw,
    dev: 11,
    ino: 22,
    known: true,
  });
  return {
    admitCalls,
    knownEntries: [],
    knownPartial: false,
    setAdmitResult(resultOrFn) {
      admitFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    async known() {
      return { entries: this.knownEntries, partial: this.knownPartial };
    },
    async admit(raw, scope) {
      admitCalls.push({ raw, scope });
      return admitFn(raw, scope);
    },
    pinSync() {
      return { ok: true, fd: 9, cwdArg: "/proc/self/fd/9" };
    },
  };
}

// ---------------------------------------------------------------------------
// fake first-prompt forwarder
// ---------------------------------------------------------------------------

export interface FakeFirstPrompt extends FirstPromptForwarder {
  accepts: Array<{ spawnId: string; text: string; deliver: "steer" | "followUp"; deadlineAt: number }>;
  setView(spawnId: string, view: FirstPromptStateView): void;
}

export function fakeFirstPrompt(): FakeFirstPrompt {
  const accepts: FakeFirstPrompt["accepts"] = [];
  const views = new Map<string, FirstPromptStateView>();
  return {
    accepts,
    setView(spawnId, view) {
      views.set(spawnId, view);
    },
    accept(spawnId, fp, _origin, deadlineAt) {
      accepts.push({ spawnId, text: fp.text, deliver: fp.deliver, deadlineAt });
    },
    onLive() {},
    onLink() {},
    onTerminal() {},
    state(spawnId) {
      return views.get(spawnId);
    },
    sendingCount() {
      return 0;
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

export interface SpawnKit {
  supervisor: FakeSpawnSupervisor;
  dirs: FakeDirs;
  firstPrompt: FakeFirstPrompt;
  log: HubLog & { lines: ReturnType<typeof captureLog>["lines"] };
  clock: FakeClock;
  spawn: SpawnFrontendPort;
  cfg: HubSpawnConfig;
}

export const KIT_CFG: HubSpawnConfig = {
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 30,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "known",
};

/** Real `createSpawnRoutes` over the fakes, with a controllable clock (rate/idempotency-TTL tests). */
export function spawnKit(cfg: Partial<HubSpawnConfig> = {}, clock: FakeClock): SpawnKit {
  const supervisor = fakeSpawnSupervisor();
  const dirs = fakeDirs();
  const firstPrompt = fakeFirstPrompt();
  const log = captureLog();
  const full: HubSpawnConfig = { ...KIT_CFG, ...cfg };
  const spawn = createSpawnRoutes({
    supervisor,
    dirs,
    firstPrompt,
    cfg: full,
    limit: createCmdLimit(clock.now),
    rejectAudit429: new Map(),
    log,
    now: clock.now,
  });
  return { supervisor, dirs, firstPrompt, log, clock, spawn, cfg: full };
}
