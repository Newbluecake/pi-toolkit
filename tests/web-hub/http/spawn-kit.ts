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
import type { SpawnPrefs } from "../../../src/web-hub/hub/spawn/prefs.js";
import type { SpawnFrontendPort } from "../../../src/web-hub/hub/spawn/ports.js";
import type {
  AdmittedRequest,
  Death,
  InternalRecord,
  RemoveResult,
  SpawnSupervisor,
  StartResult,
} from "../../../src/web-hub/hub/spawn/supervisor.js";
import type {
  CaptureSessionPathPin,
  ForkSnapshot,
  HistoryListQuery,
  HistoryPageResult,
  HistoryService,
  OccupancyProof,
  ProcScanToken,
  ResolveResult,
  SessionPathPin,
  SessionPin,
  SnapshotResult,
  VerifySessionPathPin,
} from "../../../src/web-hub/hub/spawn/history/ports.js";
import type { SessionRefWire } from "../../../src/web-hub/protocol/session-history.js";
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
        // (dup replays look it up by spawnId — the "202 ⇔ 有记录" contract). session-history plan
        // §4.6.3: a session-backed start also mirrors `sessionTarget`/`from` so dup-replay tests can
        // read them off the fake record exactly like the real supervisor would.
        recordsOut.push({
          spawnId: req.spawnId,
          state: "starting",
          cwd: req.admitted.realpath,
          dev: req.admitted.dev,
          ino: req.admitted.ino,
          createdAt: 1,
          updatedAt: 1,
          owner: { ...req.owner },
          ...(req.model === undefined ? {} : { model: req.model }),
          ...(req.firstPrompt === undefined
            ? {}
            : { firstPrompt: { state: "pending" as const, textLen: req.firstPrompt.textLen } }),
          ...(req.session === undefined
            ? {}
            : req.session.mode === "resume"
              ? { sessionTarget: { id: req.session.id, file: req.session.abs }, from: "history" as const }
              : { sessionTarget: { id: req.session.newId ?? req.session.id }, from: "fork" as const }),
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
  admitCalls: Array<{ raw: string; scope: "known" | "roots"; sessionBacked?: true }>;
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
    async admit(raw, scope, _deadline, opts) {
      admitCalls.push({ raw, scope, ...(opts?.sessionBacked === true ? { sessionBacked: true } : {}) });
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
// fake prefs (default-model plan §3 ④: memory-only, controllable persist failures)
// ---------------------------------------------------------------------------

export interface FakeSpawnPrefs extends SpawnPrefs {
  setCalls: Array<string | null>;
  setPersistResult: { ok: true } | { ok: false; code: string };
  setPersistResultOrFn: ((v: string | null) => { ok: true } | { ok: false; code: string }) | undefined;
  setValue(value: string | null): void;
  setPersistResultTo(
    resultOrFn:
      { ok: true } | { ok: false; code: string } | ((v: string | null) => { ok: true } | { ok: false; code: string }),
  ): void;
}

export function fakeSpawnPrefs(initial: string | null = null): FakeSpawnPrefs {
  const setCalls: FakeSpawnPrefs["setCalls"] = [];
  let current = initial;
  let persistResult: FakeSpawnPrefs["setPersistResult"] = { ok: true };
  let persistFn: ((v: string | null) => { ok: true } | { ok: false; code: string }) | undefined;
  return {
    setCalls,
    setPersistResult: { ok: true },
    setPersistResultOrFn: undefined,
    get: () => current,
    set(v) {
      setCalls.push(v);
      const r = persistFn !== undefined ? persistFn(v) : persistResult;
      if (r.ok) current = v;
      return r;
    },
    close() {},
    setValue(value: string | null) {
      current = value;
    },
    setPersistResultTo(resultOrFn) {
      if (typeof resultOrFn === "function") {
        persistFn = resultOrFn;
      } else {
        persistFn = undefined;
        persistResult = resultOrFn;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// fake history service (session-history plan §4.6.5)
// ---------------------------------------------------------------------------

export interface FakeSessionPin extends SessionPin {
  releaseCalls: number;
}

/** A fresh `SessionPin` fake; `release()` increments `releaseCalls` — overridable via `over`. */
export function fakeSessionPin(over: Partial<SessionPin> = {}): FakeSessionPin {
  const pin: FakeSessionPin = {
    abs: "/home/u/.pi/agent/sessions/--w-proj--/sess-old.jsonl",
    root: { dev: 1, ino: 1 },
    dir: { dev: 1, ino: 2 },
    file: { dev: 1, ino: 3 },
    id: "sess-old",
    cwd: "/home/u/proj",
    kind: "main",
    size: 256,
    releaseCalls: 0,
    release() {
      pin.releaseCalls += 1;
    },
    ...over,
  };
  return pin;
}

export interface FakeSessionPathPinOps {
  capture: CaptureSessionPathPin;
  verify: VerifySessionPathPin;
  captureCalls: Array<{ abs: string; uid: number }>;
  verifyCalls: Array<{ pin: SessionPathPin; reported: string | undefined }>;
  setCaptureResult(
    result: ReturnType<CaptureSessionPathPin> | ((abs: string, uid: number) => ReturnType<CaptureSessionPathPin>),
  ): void;
  setVerifyResult(
    result:
      | ReturnType<VerifySessionPathPin>
      | ((pin: SessionPathPin, reported: string | undefined) => ReturnType<VerifySessionPathPin>),
  ): void;
}

/** `history/pin.ts`'s sync capture+verify pair (P-scan), faked for supervisor-side tests. */
export function fakeSessionPathPin(): FakeSessionPathPinOps {
  const captureCalls: FakeSessionPathPinOps["captureCalls"] = [];
  const verifyCalls: FakeSessionPathPinOps["verifyCalls"] = [];
  let captureFn: (abs: string, uid: number) => ReturnType<CaptureSessionPathPin> = (abs) => ({
    ok: true,
    pin: { abs, root: { dev: 1, ino: 1 }, dir: { dev: 1, ino: 2 }, file: { dev: 1, ino: 3 } },
  });
  let verifyFn: (pin: SessionPathPin, reported: string | undefined) => ReturnType<VerifySessionPathPin> = () => ({
    ok: true,
  });
  return {
    captureCalls,
    verifyCalls,
    setCaptureResult(resultOrFn) {
      captureFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setVerifyResult(resultOrFn) {
      verifyFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    capture(abs, uid) {
      captureCalls.push({ abs, uid });
      return captureFn(abs, uid);
    },
    verify(pin, reported) {
      verifyCalls.push({ pin, reported });
      return verifyFn(pin, reported);
    },
  };
}

export interface FakeHistoryService extends HistoryService {
  calls: string[];
  pageCalls: HistoryListQuery[];
  resolveCalls: Array<{ ref: SessionRefWire; cwd: string }>;
  proveCalls: SessionPin[];
  reproveCalls: Array<{ pin: SessionPin; scan: ProcScanToken }>;
  verifyForSpawnCalls: SessionPin[];
  snapshotCalls: SessionPin[];
  verifySnapshotCalls: ForkSnapshot[];
  discardedSnapshots: string[];
  setPageResult(result: HistoryPageResult | ((q: HistoryListQuery) => HistoryPageResult)): void;
  setResolveResult(result: ResolveResult | ((ref: SessionRefWire, cwd: string) => ResolveResult)): void;
  setProveResult(result: OccupancyProof | ((pin: SessionPin) => OccupancyProof)): void;
  setReproveResult(result: OccupancyProof | ((pin: SessionPin, scan: ProcScanToken) => OccupancyProof)): void;
  setVerifyForSpawnResult(result: { ok: true } | { ok: false; reason: "session-changed" }): void;
  setSnapshotResult(result: SnapshotResult | ((pin: SessionPin) => SnapshotResult)): void;
  setVerifySnapshotResult(ok: boolean): void;
}

const defaultProcScanToken: ProcScanToken = { at: 0, complete: true, pids: new Map() };

/**
 * The hub-side `HistoryService` port, faked (session-history plan §4.6.5): every method is
 * programmable, `calls` records invocation order (for the gate-order test anchor), and
 * `reprove`/`verifyForSpawn`/`verifySnapshot` are synchronous (matching the real interface).
 */
export function fakeHistory(): FakeHistoryService {
  const calls: string[] = [];
  const pageCalls: FakeHistoryService["pageCalls"] = [];
  const resolveCalls: FakeHistoryService["resolveCalls"] = [];
  const proveCalls: FakeHistoryService["proveCalls"] = [];
  const reproveCalls: FakeHistoryService["reproveCalls"] = [];
  const verifyForSpawnCalls: FakeHistoryService["verifyForSpawnCalls"] = [];
  const snapshotCalls: FakeHistoryService["snapshotCalls"] = [];
  const verifySnapshotCalls: FakeHistoryService["verifySnapshotCalls"] = [];
  const discardedSnapshots: string[] = [];

  let pageFn: (q: HistoryListQuery) => HistoryPageResult = () => ({
    ok: true,
    page: { items: [], stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 0, dirsTotal: 0 } } },
  });
  let resolveFn: (ref: SessionRefWire, cwd: string) => ResolveResult = () => ({ ok: true, pin: fakeSessionPin() });
  let proveFn: (pin: SessionPin) => OccupancyProof = () => ({ free: true, scan: defaultProcScanToken });
  let reproveFn: (pin: SessionPin, scan: ProcScanToken) => OccupancyProof = () => ({
    free: true,
    scan: defaultProcScanToken,
  });
  let verifyForSpawnFn: () => { ok: true } | { ok: false; reason: "session-changed" } = () => ({ ok: true });
  let snapshotFn: (pin: SessionPin) => SnapshotResult = () => ({
    ok: true,
    snapshot: {
      path: "/home/u/.pi/agent/web-hub/spawn/fork-src/snap-fake.jsonl",
      dev: 1,
      ino: 9,
      size: 256,
      discard() {
        discardedSnapshots.push(this.path);
      },
    },
  });
  let verifySnapshotOk = true;

  return {
    calls,
    pageCalls,
    resolveCalls,
    proveCalls,
    reproveCalls,
    verifyForSpawnCalls,
    snapshotCalls,
    verifySnapshotCalls,
    discardedSnapshots,
    setPageResult(resultOrFn) {
      pageFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setResolveResult(resultOrFn) {
      resolveFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setProveResult(resultOrFn) {
      proveFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setReproveResult(resultOrFn) {
      reproveFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setVerifyForSpawnResult(result) {
      verifyForSpawnFn = () => result;
    },
    setSnapshotResult(resultOrFn) {
      snapshotFn = typeof resultOrFn === "function" ? resultOrFn : () => resultOrFn;
    },
    setVerifySnapshotResult(ok) {
      verifySnapshotOk = ok;
    },
    async page(q) {
      calls.push("page");
      pageCalls.push(q);
      return pageFn(q);
    },
    async resolve(ref, cwd) {
      calls.push("resolve");
      resolveCalls.push({ ref, cwd });
      return resolveFn(ref, cwd);
    },
    async prove(pin) {
      calls.push("prove");
      proveCalls.push(pin);
      return proveFn(pin);
    },
    reprove(pin, scan) {
      calls.push("reprove");
      reproveCalls.push({ pin, scan });
      return reproveFn(pin, scan);
    },
    verifyForSpawn(pin) {
      calls.push("verifyForSpawn");
      verifyForSpawnCalls.push(pin);
      return verifyForSpawnFn();
    },
    async snapshot(pin) {
      calls.push("snapshot");
      snapshotCalls.push(pin);
      return snapshotFn(pin);
    },
    verifySnapshot(s) {
      calls.push("verifySnapshot");
      verifySnapshotCalls.push(s);
      return verifySnapshotOk;
    },
    diag() {
      return { procFsSource: "seam", fsSource: "seam", fds: { gen: 0, pin: 0, temp: 0, max: 32 } };
    },
    async dispose() {},
  };
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

export interface SpawnKit {
  supervisor: FakeSpawnSupervisor;
  dirs: FakeDirs;
  firstPrompt: FakeFirstPrompt;
  prefs: FakeSpawnPrefs;
  log: HubLog & { lines: ReturnType<typeof captureLog>["lines"] };
  clock: FakeClock;
  spawn: SpawnFrontendPort;
  cfg: HubSpawnConfig;
  history?: FakeHistoryService;
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

/** Real `createSpawnRoutes` over the fakes, with a controllable clock (rate/idempotency-TTL tests).
 *  `history` (session-history plan §4.6.5): omitted ⇒ `deps.history` is undefined —
 *  byte-identical to history-off even when `cfg.history` is explicitly `true`. */
export function spawnKit(
  cfg: Partial<HubSpawnConfig> = {},
  clock: FakeClock,
  prefs: FakeSpawnPrefs = fakeSpawnPrefs(),
  history?: FakeHistoryService,
): SpawnKit {
  const supervisor = fakeSpawnSupervisor();
  const dirs = fakeDirs();
  const firstPrompt = fakeFirstPrompt();
  const log = captureLog();
  const full: HubSpawnConfig = { ...KIT_CFG, ...cfg };
  const spawn = createSpawnRoutes({
    supervisor,
    dirs,
    firstPrompt,
    prefs,
    cfg: full,
    limit: createCmdLimit(clock.now),
    rejectAudit429: new Map(),
    log,
    now: clock.now,
    ...(history === undefined ? {} : { history }),
  });
  return {
    supervisor,
    dirs,
    firstPrompt,
    prefs,
    log,
    clock,
    spawn,
    cfg: full,
    ...(history === undefined ? {} : { history }),
  };
}
