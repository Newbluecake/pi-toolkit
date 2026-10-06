/**
 * web-hub-spawn plan §SP7 (arch v2 §3.1/§7.5–§7.7): the managed-spawn supervisor — one instance
 * per hub, owning the per-record state machine ①–⑩, the launch-failure circuit breaker, the
 * resource limits, boot-time orphan recovery and the graded shutdown.
 *
 * State machine (plan §3.1, every timer an absolute deadline + unref'd timer):
 *
 *   ① intent       `store.saveNow(launching)` BEFORE any fork (L1); requires ≥500ms request
 *                  deadline left; write failure ⇒ `E_LAUNCHER{persist}`, no fork.
 *   ② pin cwd      `dirs.pinSync` re-checks admit's dev/ino through `open(O_DIRECTORY)` — a
 *                  `changed` dir fails the record `failed{spawn_error}` (breaker-EXEMPT: the
 *                  user's cwd raced away, not the launcher) and answers `E_DIR{changed}`.
 *   ③ fork         launcher fingerprint recheck (sync, two stats) → umask swap →
 *                  `spawn(launcher[0], [launcher[1], "--mode", "rpc"], {cwd: /proc/self/fd/N,
 *                  detached})` → umask restore → `closeSync(fd)`, all in try/finally. A sync
 *                  throw fails the record `failed{spawn_error}` (breaker counts) but start()
 *                  still returns ok — the record exists, so HTTP keeps its "202 ⇔ record"
 *                  contract and the failure rides the SSE.
 *   ④ identity     sync `/proc/<pid>/stat` → starttime (+pgrp/uid) → `store.saveNow(pid+
 *                  identity)` → `reaper.track` (L2) → stdio listeners attached. An unreadable
 *                  stat only records the pid; the exit event resolves it.
 *   ⑤ spawn event  `spawn`/`error` within SPAWN_EVENT_MS, else SIGKILL + `failed{spawn_error}`.
 *   ⑥ hello        bus `agent_up` with `agent.pid === child.pid` binds the agentKey AND checks
 *                  `agent.cwd === realpath` — mismatch ⇒ stop-escalation +
 *                  `failed{cwd_mismatch}`.
 *   ⑦ session      bus `session` (or a session already present at bind) ⇒ `live`: breaker
 *                  cleared, lifetime deadline armed, `onLive` bridge fired (SP8). The shared
 *                  register deadline (⑥+⑦ = createdAt + registerTimeoutS) expiring ⇒
 *                  `failed{register_timeout}` + hint `…-hello` (unbound) / `…-session`.
 *   ⑧ first prompt owned by SP8's forwarder; this module only bridges onLive/onLink/onTerminal
 *                  and re-pushes on `noteSpawnChanged` (the forwarder's `onChange` landing).
 *   ⑨ lifetime     `createdAt + maxLifetimeMinutes*60s` ⇒ stop-escalation ⇒ `exited{lifetime}`.
 *   ⑩ escalation   `stdin.end()` → +STOP_TERM_MS SIGTERM(-pgid) → +STOP_KILL_MS SIGKILL(-pgid)
 *                  → +EXIT_GUARD_MS fallback terminal (`exit.unconfirmed`). EVERY signal is
 *                  preceded by a synchronous identity re-verify (L5); a failed verify sends
 *                  nothing and waits for the guard.
 *
 * Circuit breaker (db-client paradigm, plan §3.1): launch failures (`spawn_error` /
 * `register_timeout` / `exited_early` / `cwd_mismatch`) enter a 10-minute window; after the n-th
 * the next start cools down `[0, 5s, 30s][min(n-1,2)]`; ≥4 in the window opens the breaker for
 * 10 minutes with a single half-open probe afterwards; ANY record reaching `live` clears it.
 * The hub NEVER ends an existing session to admit a new one (arch §6.5) — a full table just
 * fails the new start, existing records untouched.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HubEvent, HubLog } from "../ports.js";
import { createReqDeadline, deriveBudget, type ReqDeadline } from "../req-deadline.js";
import {
  parsePgrp,
  parseStartTicks,
  parseUidLine,
  readStatSync,
  type ProcSyncDeps,
  type SpawnedIdentity,
  type SpawnIdentityRejectReason,
} from "../../protocol/proc-identity.js";
import {
  EXIT_GUARD_MS,
  SPAWN_BACKOFF_MS,
  SPAWN_BREAKER_OPEN_MS,
  SPAWN_EVENT_MS,
  SPAWN_FAIL_WINDOW_MS,
  SPAWN_STARTING_MAX,
  SPAWN_TERMINAL_KEEP,
  STOP_KILL_MS,
  STOP_TERM_MS,
  type FirstPromptState,
  type HubSpawnConfig,
  type SpawnEndReason,
  type SpawnPolicyWire,
  type SpawnRecordPublic,
  type SpawnState,
  type SpawnsPayload,
} from "../../protocol/spawn.js";
import type { Reaper, ReaperTrackRecord } from "./reaper.js";
import type { SpawnRegistryPort } from "./ports.js";
import { createRpcStdio, type RpcStdio } from "./rpc-stdio.js";
import { createStderrSink, type StderrSink } from "./stderr-sink.js";
import { isTerminalSpawnState, type SpawnStore, type StoredOwner, type StoredRecord } from "./store.js";
import type { DirService } from "./dirs.js";
import {
  checkLauncherAsync,
  compareDotVersions,
  recheckLauncherSync,
  type LauncherCheckResult,
  type LauncherFs,
} from "./launcher-check.js";

// ---------------------------------------------------------------------------
// audit (arch §6.6 shape, verbatim — SP9's auditSpawn consumes these records)
// ---------------------------------------------------------------------------

export interface SpawnAuditRecord {
  audit: "spawn";
  phase: "request" | "reject" | "state" | "remove";
  endpoint?: "list" | "dirs" | "spawn" | "stop" | "remove";
  reqId?: string;
  listener?: "loopback" | "lan";
  ip?: string;
  user?: string;
  spawnId?: string;
  cwd?: string;
  known?: boolean;
  confirmed?: boolean;
  dup?: boolean;
  pid?: number;
  state?: SpawnState;
  code?: string | null;
  endReason?: SpawnEndReason;
  exitCode?: number | null;
  signal?: string | null;
  ms?: number;
  limit?: "global" | "principal" | "starting";
  active?: number;
  max?: number;
  firstPrompt?: FirstPromptState;
  textLen?: number;
  attempts?: number;
  identity?: "ok" | SpawnIdentityRejectReason;
  reaper?: "track" | "untrack" | "escalate";
}

// ---------------------------------------------------------------------------
// request / result shapes
// ---------------------------------------------------------------------------

/**
 * The first-prompt slice `start()` persists on the launching record — LENGTH only, never the
 * text (arch §6.4/§7.7). The text itself goes to SP8's forwarder through the routes (SP9).
 */
export interface AdmittedFirstPrompt {
  textLen: number;
  deliver: "steer" | "followUp";
}

/** What SP9's routes hand to `start()` after their own admit/confirm/auth gates. */
export interface AdmittedRequest {
  /** Routes generate it (SPAWN_ID_RE-shaped); the supervisor never invents ids. */
  spawnId: string;
  /** `dirs.admit()`'s success result — pinSync re-verifies dev/ino at fork time. */
  admitted: { realpath: string; dev: number; ino: number; known: boolean };
  owner: StoredOwner;
  firstPrompt?: AdmittedFirstPrompt;
}

export type StartFailureCode = "E_LIMIT" | "E_LAUNCHER" | "E_SPAWN_DENIED" | "E_DEADLINE" | "E_DIR";

export type StartResult =
  | { ok: true; spawnId: string }
  | {
      ok: false;
      code: StartFailureCode;
      /** `E_LAUNCHER`/`E_DIR`/`E_SPAWN_DENIED`: the reason detail; `E_LIMIT` is "limit". */
      reason?: string;
      limit?: "global" | "principal" | "starting";
      active?: number;
      max?: number;
      retryAfterS?: number;
    };

/** arch §6.0: a principal is `${listener}:${user ?? "token"}` — limits and audits charge it. */
export function spawnPrincipal(owner: StoredOwner): string {
  return `${owner.listener}:${owner.user ?? "token"}`;
}

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §2.1/§2.2: death confirmation & deletion result shapes
// ---------------------------------------------------------------------------

/**
 * §2.1's three-way death verdict for a TERMINAL record: `"confirmed"` means the process is
 * provably gone (a real exit event, or `probeIdentity`'s `/proc` evidence); `"alive"` means
 * `/proc` evidence says it is still running; `"unknown"` means neither can be shown — B-alive
 * treats `"alive"` and `"unknown"` identically (fail closed, never delete).
 */
export type Death = "confirmed" | "alive" | "unknown";

/** `supervisor.remove()`'s result (§2.2) — the ONLY entry point `hub/agent-remove.ts` drives. */
export type RemoveResult =
  | { ok: true; outcome: "removed" }
  | { ok: true; outcome: "pending"; state: "stopping" }
  | { ok: false; code: "E_AGENT_ONLINE"; reason: "exit-unconfirmed" }
  | { ok: false; code: "E_NOT_FOUND" }
  | { ok: false; code: "E_DEADLINE" };

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * The in-memory record `records()` hands to SP9's projections: everything `StoredRecord`
 * persists plus the runtime-only fields the owner projection needs. First-prompt TEXT never
 * appears here at any layer (arch §6.4) — the forwarder (SP8) keeps it off this type entirely.
 */
export interface InternalRecord extends StoredRecord {
  /** Bus link state of the bound agent (`agent_down` ⇒ false until its next `agent_up`). */
  linked: boolean;
  /** `getCaps(boundKey)?.includes("cmd.v1")` — set when the record goes live. */
  control: boolean | undefined;
  /** Session id of the bound agent once live (the SP8 onLive bridge payload). */
  sessionId: string | undefined;
  /** Owner-only free text (protocol-error detail, sync-spawn-error detail). */
  hintDetail: string | undefined;
  /**
   * Last ≤3 auto-cancelled third-party dialogs (owner projection `uiCancelled`). Readonly view
   * for projections; the supervisor narrows it to a mutable array internally (arrays narrow
   * readonly→mutable legally in interface extension).
   */
  readonly uiCancelled: ReadonlyArray<{ method: string; title?: string; at: number }>;
  /** Owner projection `stderrTail` (≤4 KiB); undefined once the sink is gone. */
  stderrTail(): string | undefined;
  /** web-hub-delete-session plan v2 §2.2: a delete was requested and has not yet been resolved
   * (deleted, or abandoned per B-alive) — mirrors `StoredRecord.removeIntent` in memory as a
   * definite boolean (never `undefined`). Drives `SpawnRecordPublic.removing` in both
   * projections (`project.ts`'s `toPublic` and this module's own `publicItem`). */
  removePending: boolean;
}

interface StopState {
  readonly reason: SpawnEndReason;
  readonly terminalState: "exited" | "failed";
  stage: number;
}

interface Supervised extends InternalRecord {
  uiCancelled: Array<{ method: string; title?: string; at: number }>;
  child: ChildProcess | undefined;
  stdio: RpcStdio | undefined;
  sink: StderrSink | undefined;
  /** ⑤ settled: the `spawn` (or `error`) event arrived — later `error` events are noise. */
  spawnEventSettled: boolean;
  everLive: boolean;
  /** §3.1 ②'s exemption: pin-changed failures carry endReason spawn_error but never trip the breaker. */
  breakerExempt: boolean;
  registerDeadlineAt: number | undefined;
  lifetimeDeadlineAt: number | undefined;
  spawnEventTimer: NodeJS.Timeout | undefined;
  registerTimer: NodeJS.Timeout | undefined;
  lifetimeTimer: NodeJS.Timeout | undefined;
  stopTimer: NodeJS.Timeout | undefined;
  lastOpenCount: number;
  stop: StopState | undefined;
}

// ---------------------------------------------------------------------------
// supervisor surface
// ---------------------------------------------------------------------------

export interface SpawnSupervisor {
  /** store.load + orphan recovery + launcher init check + reaper.start (plan §SP7). */
  init(deadline: ReqDeadline): Promise<void>;
  policy(
    principal: string,
    listener: "loopback" | "lan",
    scheme: "http" | "https",
    viaTrustedProxy: boolean,
  ): SpawnPolicyWire;
  /** Fully synchronous ①–④ (plan §SP7); never awaits. */
  start(req: AdmittedRequest, deadline: ReqDeadline): StartResult;
  stop(spawnId: string, force: boolean): { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" };
  /** For SP9's project.ts. */
  records(): readonly InternalRecord[];
  /** hub.ts's onVersion gate: does this agentKey belong to a managed, non-terminal record? */
  isManaged(agentKey: string): boolean;
  /** A managed agent reporting a plugin version newer than the hub's ⇒ `hint:"newer-plugin"`. */
  noteVersion(agentKey: string, pluginVersion: string): void;
  /** Non-terminal record count (idle/supersede gating; arch §7.8 "子进程存在时"). */
  liveCount(): number;
  /** Live records whose bound agent reports `status.busy` (supersede quiet, plan §SP10). */
  busyCount(): number;
  /** SP8's `onChange` landing: same-tick merged `spawns` push + debounced persist. */
  noteSpawnChanged(spawnId: string): void;
  /** web-hub-delete-session plan v2 §2.2: the remove router's managed lookup — the LATEST
   * record (any state, not just non-terminal — unlike the private `findByAgentKey`) bound to
   * `agentKey`. Undefined when no record was ever bound to that key. */
  lookupByAgentKey(agentKey: string): { spawnId: string } | undefined;
  /** web-hub-delete-session plan v2 §2.2: the single deletion entry point for a managed record
   * (by `spawnId`). Non-terminal ⇒ persists a remove intent and enters (or confirms) the stop
   * grace, `"pending"`; terminal ⇒ judged immediately by `deathOf` — `"removed"` or refused
   * `E_AGENT_ONLINE{reason:"exit-unconfirmed"}` with the record untouched (B-alive). */
  remove(spawnId: string, deadline: ReqDeadline): RemoveResult;
  /** web-hub-delete-session plan v2 §2.4: read-only death verdict for a record, by `spawnId` —
   * shares `remove()`'s private judgment (§2.1). Undefined when no such record exists. */
  deathOf(spawnId: string): Death | undefined;
  /** arch §7.6 graded shutdown: bounded graceful wait → verified SIGTERM → flush → reaper EOF. */
  shutdown(deadline: ReqDeadline): Promise<void>;
}

export interface SpawnSupervisorDeps {
  cfg: HubSpawnConfig;
  registry: SpawnRegistryPort;
  log: HubLog;
  now: () => number;
  store: SpawnStore;
  reaper: Reaper;
  dirs: DirService;
  /** `HubConfig.launcher` — the only exec source (D15); undefined ⇒ policy `launcher/missing`. */
  launcher: readonly [string, string] | undefined;
  env: NodeJS.ProcessEnv;
  /** The umask children should inherit (hub main.ts's pre-0o077 capture); undefined ⇒ no swap. */
  childUmask: number | undefined;
  platform: { ok: true } | { ok: false; detail: string };
  /** Injectable fork — tests inject a fake ChildProcess. */
  spawnFn?: typeof spawn;
  /** `/proc` sync reads (④ identity capture, ⑩ pre-signal verify, boot recovery). */
  proc?: ProcSyncDeps;
  audit(record: SpawnAuditRecord): void;
  /** Fired exactly once per record entering `live` (SP8's first-prompt gate). */
  onLive?: (rec: InternalRecord) => void;
  /** Bound-agent link transitions (SP8's await-link retry phase). */
  onLink?: (spawnId: string, linked: boolean) => void;
  /** Record went terminal without ever being live (SP8's `expired{never_live|stopped}`). */
  onTerminal?: (spawnId: string, reason: "never_live" | "stopped") => void;
  /** web-hub-delete-session plan v2 §2.2: fired exactly once per record actually deleted from
   * memory (`deleteRecord`, the ONLY call site) — `agentKey` is whatever the record had bound
   * (possibly undefined for a record that died before ever linking). `hub.ts` wires this to
   * `registry.remove(key, { allowConnected: true })` so an agent card disappears in lockstep
   * with its spawn record once death is confirmed. */
  onRemoved?: (spawnId: string, agentKey: string | undefined) => void;
  // ---- additive seams beyond the plan's literal dep list (all optional; wiring & test doubles)
  /** fs seams for launcher-check (default: real fs). */
  launcherFs?: LauncherFs;
  /** Closes pinSync's fd after fork (default: node:fs closeSync) — injectable for fake dirs. */
  closeSync?: (fd: number) => void;
  /** Umask swap seam (default: process.umask) — tests pin the [inherited, 0o077] sequence. */
  umask?: (mask: number) => number;
  /** Group/pid signal seam (default: process.kill). */
  kill?: (pid: number, signal: string) => void;
  /** Default: process.getuid. */
  getuid?: () => number;
  /** `/proc` listing for the launching-record environ scan (default: node:fs readdirSync). */
  readdirSync?: (path: string) => string[];
  /** The hub's own pluginVersion — `noteVersion`'s "newer" reference. */
  pluginVersion?: string;
  /** stderr logDir (SP5's sink); undefined ⇒ stderr data is dropped (no disk touch). */
  stderrDir?: string;
}

// ---------------------------------------------------------------------------
// tunables not already in protocol/spawn.ts
// ---------------------------------------------------------------------------

/** §3.1 ①: the synchronous intent+fork stretch needs this much request budget left, else 504. */
export const INTENT_MIN_REMAINING_MS = 500;
/** §7.6/§4.2: the umask the hub itself runs under (main.ts set it before anything else). */
export const HUB_UMASK = 0o077;
/** arch §7.7 recovery: the environ scan's own budget. */
export const RECOVER_SCAN_BUDGET_MS = 1_000;
/** arch §7.7 recovery: TERM → KILL spacing for orphans (mirrors ⑩'s kill spacing). */
export const RECOVER_KILL_AFTER_MS = STOP_KILL_MS;
/** arch §7.7 recovery: max procs examined in one environ scan. */
export const RECOVER_SCAN_MAX_PROCS = 4096;
/** arch §7.4 USER_HZ — `/proc/<pid>/stat` starttime is in 1/100 s units. */
const PROC_CLOCK_HZ = 100;

const BREAKER_REASONS: ReadonlySet<string> = new Set([
  "spawn_error",
  "register_timeout",
  "exited_early",
  "cwd_mismatch",
]);
/** `onTerminal` reasons that mean "failed before ever live" (vs. user/lifetime/hub stops). */
const NEVER_LIVE_REASONS: ReadonlySet<string> = new Set([
  "spawn_error",
  "register_timeout",
  "exited_early",
  "cwd_mismatch",
  "protocol_error",
]);

// ---------------------------------------------------------------------------
// the supervisor
// ---------------------------------------------------------------------------

export function createSpawnSupervisor(deps: SpawnSupervisorDeps): SpawnSupervisor {
  const { cfg, registry, log, now, store, reaper, dirs } = deps;
  const spawnFn = deps.spawnFn ?? spawn;
  const procDeps: ProcSyncDeps = deps.proc ?? {};
  const closeFd = deps.closeSync ?? ((fd: number) => closeSync(fd));
  const umaskFn = deps.umask ?? ((mask: number) => process.umask(mask));
  const killFn = deps.kill ?? ((pid: number, signal: string) => process.kill(pid, signal));
  const getuidFn = deps.getuid ?? (() => process.getuid?.() ?? 0);
  const readdirFn = deps.readdirSync ?? ((path: string) => readdirSync(path));
  const readProc = procDeps.readFileSync ?? ((path: string) => readFileSync(path, { encoding: "utf8" }));

  const records = new Map<string, Supervised>();

  let initialized = false;
  let closedFlag = false;
  let shutdownPromise: Promise<void> | undefined;
  /** web-hub-delete-session plan v2 §2.6: the single deferred "did the boot-recovered remove
   * intents actually die" timer armed by `init()`; cleared on `shutdown()` like every other
   * record timer. */
  let removeConfirmTimer: NodeJS.Timeout | undefined;
  let platformFail = false;
  let launcherCheck: LauncherCheckResult | undefined;
  let launcherChanged = false;
  let reaperDown = false;

  // breaker state
  let failTimestamps: number[] = [];
  let breakerUntil = 0;
  let halfOpenProbe = false;

  // same-tick merged spawns push
  let pushScheduled = false;

  const unsubscribeBus = registry.bus.subscribe((e) => onBusEvent(e));
  reaper.onRestart(() => {
    // L2: a respawned reaper re-tracks every non-terminal record with a full identity.
    for (const rec of records.values()) {
      if (isTerminalSpawnState(rec.state)) continue;
      const t = trackIdentityOf(rec);
      if (t !== undefined) reaper.track(t);
    }
  });
  reaper.onUnavailable(() => {
    reaperDown = true; // §6.5: refuse new spawns; existing sessions keep running
  });

  // hub boot id — read once, sync, through the same seam ④ uses; "" ⇒ verify fails closed.
  let hubBootId = "";
  {
    const platform = procDeps.platform ?? process.platform;
    if (platform === "linux") {
      try {
        const raw = readProc("/proc/sys/kernel/random/boot_id").trim();
        if (raw.length > 0) hubBootId = raw;
      } catch {
        /* unreadable /proc — every verify below fails closed */
      }
    }
  }

  // ----------------------------------------------------------------- timers

  function arm(delayMs: number, fire: () => void): NodeJS.Timeout {
    const t = setTimeout(fire, Math.max(0, delayMs));
    t.unref?.();
    return t;
  }

  function clearHandle(h: NodeJS.Timeout | undefined): NodeJS.Timeout | undefined {
    if (h !== undefined) clearTimeout(h);
    return undefined;
  }

  function clearRecordTimers(rec: Supervised): void {
    rec.spawnEventTimer = clearHandle(rec.spawnEventTimer);
    rec.registerTimer = clearHandle(rec.registerTimer);
    rec.lifetimeTimer = clearHandle(rec.lifetimeTimer);
    rec.stopTimer = clearHandle(rec.stopTimer);
  }

  /** Absolute-deadline timer that distrusts timer precision (arch §7.5): an early wake re-arms. */
  function armRegisterTimer(rec: Supervised): void {
    const at = rec.registerDeadlineAt;
    if (at === undefined) return;
    rec.registerTimer = arm(at - now(), () => {
      if (at - now() > 0) {
        armRegisterTimer(rec);
        return;
      }
      onRegisterDeadline(rec);
    });
  }

  function armLifetimeTimer(rec: Supervised): void {
    const at = rec.lifetimeDeadlineAt;
    if (at === undefined) return;
    rec.lifetimeTimer = arm(at - now(), () => {
      if (at - now() > 0) {
        armLifetimeTimer(rec);
        return;
      }
      onLifetimeDeadline(rec);
    });
  }

  // ----------------------------------------------------------------- persistence & push

  function toStored(rec: Supervised): StoredRecord {
    const out: StoredRecord = {
      spawnId: rec.spawnId,
      state: rec.state,
      cwd: rec.cwd,
      dev: rec.dev,
      ino: rec.ino,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      owner: {
        listener: rec.owner.listener,
        reqId: rec.owner.reqId,
        ...(rec.owner.user !== undefined ? { user: rec.owner.user } : {}),
      },
    };
    if (rec.pid !== undefined) out.pid = rec.pid;
    if (rec.procStartTicks !== undefined) out.procStartTicks = rec.procStartTicks;
    if (rec.bootId !== undefined) out.bootId = rec.bootId;
    if (rec.uid !== undefined) out.uid = rec.uid;
    if (rec.agentKey !== undefined) out.agentKey = rec.agentKey;
    if (rec.endReason !== undefined) out.endReason = rec.endReason;
    if (rec.exit !== undefined) out.exit = rec.exit;
    if (rec.hint !== undefined) out.hint = rec.hint;
    if (rec.firstPrompt !== undefined) out.firstPrompt = rec.firstPrompt;
    if (rec.stderrLog !== undefined) out.stderrLog = rec.stderrLog;
    if (rec.removePending) out.removeIntent = true;
    if (rec.noProcess !== undefined) out.noProcess = rec.noProcess;
    return out;
  }

  function storedSnapshot(): StoredRecord[] {
    return [...records.values()].map(toStored);
  }

  function persistDebounced(): void {
    if (store.closed) return;
    store.markDirty(storedSnapshot);
  }

  function publicItem(rec: Supervised): SpawnRecordPublic {
    const item: SpawnRecordPublic = {
      spawnId: rec.spawnId,
      state: rec.state === "launching" ? "starting" : rec.state,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      cwdLabel: basename(rec.cwd),
      origin: { listener: rec.owner.listener, reqId: rec.owner.reqId },
    };
    if (rec.pid !== undefined) item.pid = rec.pid;
    if (rec.agentKey !== undefined) item.agentKey = rec.agentKey;
    if (rec.agentKey !== undefined) item.linked = rec.linked;
    if (rec.state === "live" && rec.control !== undefined) item.control = rec.control;
    if (rec.endReason !== undefined && rec.endReason !== null) item.endReason = rec.endReason;
    if (rec.exit !== undefined && rec.exit !== null) item.exit = rec.exit;
    if (rec.hint !== undefined && rec.hint !== null) item.hint = rec.hint;
    if (rec.uiCancelled.length > 0) item.uiCancelledCount = rec.uiCancelled.length;
    if (rec.firstPrompt !== undefined) item.firstPrompt = { state: rec.firstPrompt.state };
    if (rec.removePending) item.removing = true;
    return item;
  }

  /** SSE `spawns` snapshot: the Public projection ONLY (arch §6.4). */
  function publicPayload(): SpawnsPayload {
    let active = 0;
    const items: SpawnRecordPublic[] = [];
    for (const rec of records.values()) {
      if (!isTerminalSpawnState(rec.state)) active += 1;
      items.push(publicItem(rec));
    }
    return { items, active, max: cfg.maxProcesses };
  }

  /** plan §SP7: same-tick transitions merge (queueMicrotask) into ONE publish + markDirty. */
  function schedulePush(): void {
    if (pushScheduled) return;
    pushScheduled = true;
    queueMicrotask(() => {
      pushScheduled = false;
      try {
        registry.publish({ type: "spawns", payload: publicPayload() });
      } catch (err) {
        log.warn("spawn supervisor: spawns publish failed", { error: String(err) });
      }
      persistDebounced();
    });
  }

  function auditState(rec: Supervised): void {
    const entry: SpawnAuditRecord = {
      audit: "spawn",
      phase: "state",
      spawnId: rec.spawnId,
      state: rec.state === "launching" ? "starting" : rec.state,
    };
    if (rec.pid !== undefined) entry.pid = rec.pid;
    if (rec.endReason !== undefined && rec.endReason !== null) entry.endReason = rec.endReason;
    if (rec.exit !== undefined && rec.exit !== null) {
      entry.exitCode = rec.exit.code;
      if (rec.exit.signal !== null) entry.signal = rec.exit.signal;
    }
    deps.audit(entry);
  }

  // ----------------------------------------------------------------- breaker

  function pruneFailures(t: number): void {
    while (failTimestamps.length > 0 && t - failTimestamps[0]! >= SPAWN_FAIL_WINDOW_MS) failTimestamps.shift();
  }

  function clearBreaker(): void {
    failTimestamps = [];
    breakerUntil = 0;
    halfOpenProbe = false;
  }

  function noteLaunchFailure(): void {
    const t = now();
    pruneFailures(t);
    failTimestamps.push(t);
    halfOpenProbe = false;
    if (failTimestamps.length >= 4) {
      breakerUntil = t + SPAWN_BREAKER_OPEN_MS;
      log.error("spawn supervisor: launch breaker opened", { failures: failTimestamps.length });
    }
  }

  /** The start()-side breaker/cooldown gate; undefined ⇒ proceed. */
  function breakerGate(t: number): StartResult | undefined {
    pruneFailures(t);
    if (breakerUntil > t) {
      return { ok: false, code: "E_LAUNCHER", reason: "breaker", retryAfterS: Math.ceil((breakerUntil - t) / 1000) };
    }
    if (breakerUntil > 0) {
      // Open period elapsed ⇒ half-open: exactly one probe goes through (plan §3.1).
      if (halfOpenProbe) return { ok: false, code: "E_LAUNCHER", reason: "cooldown", retryAfterS: 1 };
      halfOpenProbe = true;
      return undefined;
    }
    if (failTimestamps.length > 0) {
      const last = failTimestamps[failTimestamps.length - 1] ?? t;
      const cooldown = SPAWN_BACKOFF_MS[Math.min(failTimestamps.length - 1, SPAWN_BACKOFF_MS.length - 1)] ?? 0;
      if (cooldown > 0 && t - last < cooldown) {
        return {
          ok: false,
          code: "E_LAUNCHER",
          reason: "cooldown",
          retryAfterS: Math.ceil((cooldown - (t - last)) / 1000),
        };
      }
    }
    return undefined;
  }

  // ----------------------------------------------------------------- identity (sync, L5)

  function trackIdentityOf(rec: Supervised): ReaperTrackRecord | undefined {
    if (
      rec.pid === undefined ||
      rec.procStartTicks === undefined ||
      rec.bootId === undefined ||
      rec.uid === undefined
    ) {
      return undefined;
    }
    return { spawnId: rec.spawnId, pid: rec.pid, startTicks: rec.procStartTicks, bootId: rec.bootId, uid: rec.uid };
  }

  /**
   * The synchronous identity verify every signal-sending path runs first (L5): platform →
   * bootId → `/proc/<pid>/stat` (starttime, pgrp when group) → `/proc/<pid>/status` (uid).
   * Any unreadable `/proc` fails CLOSED — no signal.
   */
  function identityOf(rec: Supervised): SpawnedIdentity | undefined {
    if (
      rec.pid === undefined ||
      rec.procStartTicks === undefined ||
      rec.bootId === undefined ||
      rec.uid === undefined
    ) {
      return undefined;
    }
    return { pid: rec.pid, procStartTicks: rec.procStartTicks, bootId: rec.bootId, uid: rec.uid };
  }

  /**
   * The SYNCHRONOUS identity verify every signal-sending path runs first (L5): platform →
   * bootId → `/proc/<pid>/stat` (starttime, pgrp when group) → `/proc/<pid>/status` (uid) —
   * and the caller sends its signal in the SAME synchronous segment, so no await can open a
   * verify→kill TOCTOU window (review re-run #3; shared by ⑩, ⑤ and the boot-recovery chain).
   * Any unreadable `/proc` fails CLOSED — no signal.
   */
  function verifyIdentityById(id: SpawnedIdentity, group: boolean): { ok: true; pid: number } | { ok: false } {
    const platform = procDeps.platform ?? process.platform;
    if (platform !== "linux" || hubBootId === "" || hubBootId !== id.bootId) return { ok: false };
    const stat = readStatSync(id.pid, procDeps);
    if (stat === undefined) return { ok: false };
    const startTicks = parseStartTicks(stat);
    if (startTicks !== id.procStartTicks) return { ok: false };
    if (group) {
      const pgrp = parsePgrp(stat);
      if (pgrp !== id.pid) return { ok: false };
    }
    let status: string;
    try {
      status = readProc(`/proc/${id.pid}/status`);
    } catch {
      return { ok: false };
    }
    const uid = parseUidLine(status);
    if (uid === undefined || uid.real !== id.uid || uid.effective !== id.uid) return { ok: false };
    return { ok: true, pid: id.pid };
  }

  function verifyIdentitySync(rec: Supervised, group: boolean): { ok: true; pid: number } | { ok: false } {
    const id = identityOf(rec);
    if (id === undefined) return { ok: false };
    return verifyIdentityById(id, group);
  }

  function groupKill(pid: number, signal: string): boolean {
    try {
      killFn(-pid, signal);
      return true;
    } catch {
      return false; // ESRCH (already gone) / EPERM — the guard timer owns the record either way
    }
  }

  // ----------------------------------------------------------------- §2.1 death confirmation

  function errCodeOf(err: unknown): string | undefined {
    if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
    return undefined;
  }

  /** `/proc/<pid>/stat` state char (field 3, after `pid (comm)`) — `Z`/`X` mean the kernel has
   *  already torn the process down even though it may not be reaped yet (plan v2 §2.1). */
  function parseStatStateChar(stat: string): string | undefined {
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const rest = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    return rest[0];
  }

  /**
   * web-hub-delete-session plan v2 §2.1's read-only death probe. Deliberately NOT
   * `verifyIdentityById`: that one collapses "doesn't exist" and "can't tell" into one `false`,
   * which is exactly the ambiguity a delete decision must not have (B-alive: "alive" and
   * "unknown" are handled identically by the caller, but the DISTINCTION from "confirmed" is the
   * whole point). Never sends a signal, so it needs none of L5's same-synchronous-segment
   * discipline. Order mirrors the plan's table: identity quadruple → platform/bootId →
   * `/proc/<pid>/stat` existence → starttime (pid reuse) → zombie state → `/proc/<pid>/status` uid.
   */
  function probeIdentity(rec: Supervised): Death {
    if (
      rec.pid === undefined ||
      rec.procStartTicks === undefined ||
      rec.bootId === undefined ||
      rec.uid === undefined
    ) {
      return "unknown"; // identity quadruple incomplete (e.g. ④'s /proc was unreadable at fork time)
    }
    const platform = procDeps.platform ?? process.platform;
    if (platform !== "linux" || hubBootId === "") return "unknown";
    if (rec.bootId !== hubBootId) return "confirmed"; // the machine rebooted since this was forked
    let stat: string;
    try {
      stat = readProc(`/proc/${rec.pid}/stat`);
    } catch (err) {
      const code = errCodeOf(err);
      return code === "ENOENT" || code === "ESRCH" ? "confirmed" : "unknown";
    }
    const startTicks = parseStartTicks(stat);
    if (startTicks === undefined) return "unknown"; // malformed /proc content — fail closed
    if (startTicks !== rec.procStartTicks) return "confirmed"; // the pid has been reused
    const state = parseStatStateChar(stat);
    if (state === "Z" || state === "X") return "confirmed";
    let status: string;
    try {
      status = readProc(`/proc/${rec.pid}/status`);
    } catch {
      return "unknown";
    }
    const uid = parseUidLine(status);
    if (uid === undefined) return "unknown";
    return uid.real !== rec.uid ? "confirmed" : "alive"; // not the same process — someone reused the pid
  }

  /**
   * web-hub-delete-session plan v2 §2.1: the ONE place that judges whether a record's process is
   * actually gone. A real (non-`unconfirmed`) exit event is authoritative on its own; a
   * `pid === undefined` record needs persisted `noProcess` evidence to be `confirmed` (C1: a
   * crash between fork and pid persist must never be assumed dead); everything else falls to the
   * `/proc` probe above.
   */
  function computeDeath(rec: Supervised): Death {
    if (rec.pid === undefined) {
      return rec.noProcess === "never-forked" || rec.noProcess === "boot-changed" ? "confirmed" : "unknown";
    }
    if (rec.exit !== undefined && rec.exit !== null && rec.exit.unconfirmed !== true) return "confirmed";
    return probeIdentity(rec);
  }

  /**
   * web-hub-delete-session plan v2 §2.2: the ONLY place a managed record is ever deleted from
   * memory. Guards against a double-delete/trim race (the record may have already been evicted
   * by `trimTerminalRecords()` moments earlier in the SAME synchronous turn).
   */
  function deleteRecord(rec: Supervised): void {
    if (records.get(rec.spawnId) !== rec) return;
    records.delete(rec.spawnId);
    persistDebounced();
    schedulePush();
    deps.audit({ audit: "spawn", phase: "remove", spawnId: rec.spawnId });
    deps.onRemoved?.(rec.spawnId, rec.agentKey);
  }

  // ----------------------------------------------------------------- per-record plumbing

  function writeStdin(rec: Supervised, line: string): boolean {
    const stdin = rec.child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) return false;
    try {
      return stdin.write(line);
    } catch {
      return false; // EPIPE — the exit event is the truth
    }
  }

  function writeStdinEnd(rec: Supervised): void {
    const stdin = rec.child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) return;
    try {
      stdin.end();
    } catch {
      /* pipe already broken — EOF reaches the child either way */
    }
  }

  function holdAllowed(rec: Supervised): boolean {
    if (!rec.linked || rec.agentKey === undefined) return false;
    return (registry.getCaps(rec.agentKey) ?? []).includes("dialog.v1");
  }

  function onUiCancelled(rec: Supervised, e: { method: string; title?: string; at: number }): void {
    rec.uiCancelled.push(e);
    if (rec.uiCancelled.length > 3) rec.uiCancelled.splice(0, rec.uiCancelled.length - 3);
    rec.updatedAt = now();
    persistDebounced();
    schedulePush();
  }

  function onProtocolError(rec: Supervised, detail: string): void {
    if (isTerminalSpawnState(rec.state) || rec.state === "stopping") return;
    rec.hint = "protocol-error";
    rec.hintDetail = detail;
    enterStopping(rec, "protocol_error");
  }

  function cleanupHandles(rec: Supervised): void {
    rec.stdio?.dispose();
    rec.stdio = undefined;
    const sink = rec.sink;
    rec.sink = undefined;
    if (sink !== undefined) void sink.close(createReqDeadline(now, 300));
    rec.child = undefined;
  }

  /** Terminal retention in memory: keep ≤SPAWN_TERMINAL_KEEP finished records for stop()/GETs. */
  function trimTerminalRecords(): void {
    const terminal = [...records.values()].filter((r) => isTerminalSpawnState(r.state));
    if (terminal.length <= SPAWN_TERMINAL_KEEP) return;
    terminal.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const rec of terminal.slice(0, terminal.length - SPAWN_TERMINAL_KEEP)) records.delete(rec.spawnId);
  }

  function finalizeTerminal(rec: Supervised): void {
    if (isTerminalSpawnState(rec.state)) return;
    rec.state = rec.stop?.terminalState ?? "exited";
    rec.endReason = rec.endReason ?? rec.stop?.reason ?? "crash";
    rec.updatedAt = now();
    clearRecordTimers(rec);
    if (rec.pid !== undefined) reaper.untrack(rec.pid);
    const reason = rec.endReason;
    if (BREAKER_REASONS.has(reason) && !rec.breakerExempt) noteLaunchFailure();
    if (!rec.everLive) {
      deps.onTerminal?.(rec.spawnId, NEVER_LIVE_REASONS.has(reason) ? "never_live" : "stopped");
    }
    cleanupHandles(rec);
    auditState(rec);
    persistDebounced();
    schedulePush();
    trimTerminalRecords();
    // web-hub-delete-session plan v2 §2.2: a pending delete's verdict is pinned to the SAME
    // termination this function already handles — crash, guard timeout, spawn_error, user stop,
    // all of them — never a separate code path. `deleteRecord` guards its own trim race.
    if (rec.removePending && records.get(rec.spawnId) === rec) {
      if (computeDeath(rec) === "confirmed") {
        deleteRecord(rec);
      } else {
        rec.removePending = false;
        persistDebounced();
        schedulePush();
        deps.audit({ audit: "spawn", phase: "remove", spawnId: rec.spawnId, code: "E_EXIT_UNCONFIRMED" });
      }
    }
  }

  function failSpawnError(rec: Supervised, detail: string): void {
    if (isTerminalSpawnState(rec.state)) return;
    rec.endReason = "spawn_error";
    rec.hintDetail = detail;
    rec.stop = { reason: "spawn_error", terminalState: "failed", stage: 3 };
    finalizeTerminal(rec);
  }

  // ----------------------------------------------------------------- ⑩ stop escalation

  function enterStopping(rec: Supervised, reason: SpawnEndReason): void {
    if (isTerminalSpawnState(rec.state) || rec.state === "stopping") return;
    const failure =
      reason === "spawn_error" ||
      reason === "register_timeout" ||
      reason === "exited_early" ||
      reason === "cwd_mismatch" ||
      (reason === "protocol_error" && !rec.everLive);
    rec.state = "stopping";
    rec.endReason = reason;
    rec.stop = { reason, terminalState: failure ? "failed" : "exited", stage: 0 };
    rec.updatedAt = now();
    rec.registerTimer = clearHandle(rec.registerTimer);
    rec.lifetimeTimer = clearHandle(rec.lifetimeTimer);
    rec.spawnEventTimer = clearHandle(rec.spawnEventTimer);
    auditState(rec);
    persistDebounced();
    schedulePush();
    escalateStep(rec, 0);
  }

  /**
   * ⑩'s ladder: stage 0 `stdin.end()` (+STOP_TERM_MS) → 1 SIGTERM(-pgid) (+STOP_KILL_MS) →
   * 2 SIGKILL(-pgid) (+EXIT_GUARD_MS) → 3 guard terminal. Every signal is preceded by the sync
   * identity verify; a failed verify sends NOTHING and waits for the guard (L5).
   */
  function escalateStep(rec: Supervised, stage: number): void {
    if (isTerminalSpawnState(rec.state) || rec.stop === undefined) return;
    rec.stopTimer = clearHandle(rec.stopTimer); // a force-stop jumps stages — never double-fire
    rec.stop.stage = stage;
    if (stage === 0) {
      writeStdinEnd(rec);
      rec.stopTimer = arm(STOP_TERM_MS, () => escalateStep(rec, 1));
      return;
    }
    if (stage === 1 || stage === 2) {
      const signal = stage === 1 ? "SIGTERM" : "SIGKILL";
      const verified = verifyIdentitySync(rec, true);
      if (!verified.ok) {
        rec.stopTimer = arm(EXIT_GUARD_MS, () => guardTerminal(rec)); // L5: no signal, wait for guard
        return;
      }
      groupKill(verified.pid, signal);
      rec.stopTimer = arm(stage === 1 ? STOP_KILL_MS : EXIT_GUARD_MS, () =>
        stage === 1 ? escalateStep(rec, 2) : guardTerminal(rec),
      );
      return;
    }
    guardTerminal(rec);
  }

  function guardTerminal(rec: Supervised): void {
    if (isTerminalSpawnState(rec.state)) return;
    rec.exit = { code: null, signal: null, unconfirmed: true };
    finalizeTerminal(rec);
  }

  // ----------------------------------------------------------------- child events

  function onChildError(rec: Supervised, err: Error): void {
    if (isTerminalSpawnState(rec.state)) return;
    if (rec.spawnEventSettled) {
      log.warn("spawn supervisor: child error after spawn", { spawnId: rec.spawnId, error: String(err) });
      return; // post-spawn 'error' (e.g. signal delivery failure) — exit remains the truth
    }
    rec.spawnEventSettled = true;
    rec.spawnEventTimer = clearHandle(rec.spawnEventTimer);
    failSpawnError(rec, String(err));
  }

  function onSpawnEventTimeout(rec: Supervised): void {
    if (isTerminalSpawnState(rec.state) || rec.spawnEventSettled) return;
    rec.spawnEventSettled = true;
    // L5 (review re-run #1): a signal needs a verified identity in the SAME synchronous
    // segment. When the verify fails (④ never captured one, or /proc no longer agrees) we send
    // NOTHING: the record still goes terminal here, while the exit event (if a process exists
    // at all) and the reaper (if ④ tracked it) own the process — never trade "no orphan" for
    // "wrong pid killed".
    const verified = verifyIdentitySync(rec, false);
    if (verified.ok) groupKill(verified.pid, "SIGKILL");
    failSpawnError(rec, "spawn event timeout");
  }

  function onChildExit(rec: Supervised, code: number | null, signal: string | null): void {
    if (isTerminalSpawnState(rec.state)) {
      cleanupHandles(rec);
      return;
    }
    rec.exit = { code, signal };
    if (rec.state === "stopping") {
      // reason + terminalState already captured at enterStopping
    } else if (rec.state === "live") {
      rec.endReason = "crash";
      rec.stop = { reason: "crash", terminalState: "exited", stage: 3 };
    } else {
      rec.endReason = "exited_early";
      rec.stop = { reason: "exited_early", terminalState: "failed", stage: 3 };
    }
    finalizeTerminal(rec);
  }

  // ----------------------------------------------------------------- ⑥⑦⑨ deadlines

  function onRegisterDeadline(rec: Supervised): void {
    if (isTerminalSpawnState(rec.state) || rec.state === "live" || rec.state === "stopping") return;
    rec.hint = rec.agentKey === undefined ? "register-timeout-hello" : "register-timeout-session";
    enterStopping(rec, "register_timeout");
  }

  function onLifetimeDeadline(rec: Supervised): void {
    if (isTerminalSpawnState(rec.state) || rec.state !== "live") return;
    enterStopping(rec, "lifetime");
  }

  function goLive(rec: Supervised, sessionId: string): void {
    if (isTerminalSpawnState(rec.state) || rec.state !== "starting") return;
    rec.state = "live";
    rec.everLive = true;
    rec.sessionId = sessionId;
    rec.control = rec.agentKey !== undefined && (registry.getCaps(rec.agentKey) ?? []).includes("cmd.v1");
    if (rec.control !== true) rec.hint = "control-off";
    rec.registerTimer = clearHandle(rec.registerTimer);
    rec.lifetimeDeadlineAt = rec.createdAt + cfg.maxLifetimeMinutes * 60_000;
    armLifetimeTimer(rec);
    clearBreaker(); // §3.1 ⑦: live ⇒ 熔断计数清零
    rec.updatedAt = now();
    auditState(rec);
    persistDebounced();
    schedulePush();
    deps.onLive?.(rec);
  }

  // ----------------------------------------------------------------- bus

  function findByAgentKey(agentKey: string): Supervised | undefined {
    for (const rec of records.values()) {
      if (!isTerminalSpawnState(rec.state) && rec.agentKey === agentKey) return rec;
    }
    return undefined;
  }

  function onBusEvent(e: HubEvent): void {
    if (closedFlag) return;
    if (e.type === "agent_up") {
      for (const rec of records.values()) {
        if (isTerminalSpawnState(rec.state)) continue;
        if (rec.agentKey === e.agent.agentKey) {
          if (!rec.linked) {
            rec.linked = true;
            rec.stdio?.onSlot(rec.lastOpenCount, true);
            deps.onLink?.(rec.spawnId, true);
            rec.updatedAt = now();
            persistDebounced();
            schedulePush();
          }
          continue;
        }
        const child = rec.child;
        if (rec.agentKey === undefined && child !== undefined && child.pid === e.agent.pid) {
          rec.agentKey = e.agent.agentKey;
          rec.linked = true;
          rec.updatedAt = now();
          if (e.agent.cwd !== rec.cwd) {
            rec.hint = "cwd-mismatch";
            enterStopping(rec, "cwd_mismatch");
            continue;
          }
          const sess = registry.get(e.agent.agentKey)?.session;
          if (sess !== undefined) goLive(rec, sess.sessionId);
          else {
            persistDebounced();
            schedulePush();
          }
        }
      }
      return;
    }
    if (e.type === "session") {
      const rec = findByAgentKey(e.agentKey);
      if (rec !== undefined && rec.state === "starting") goLive(rec, e.session.sessionId);
      return;
    }
    if (e.type === "dialogs") {
      const rec = findByAgentKey(e.agentKey);
      if (rec !== undefined) {
        rec.lastOpenCount = e.open.length;
        rec.stdio?.onSlot(e.open.length, rec.linked);
      }
      return;
    }
    if (e.type === "agent_down") {
      const rec = findByAgentKey(e.agentKey);
      if (rec !== undefined && rec.linked) {
        rec.linked = false;
        rec.stdio?.onSlot(rec.lastOpenCount, false);
        deps.onLink?.(rec.spawnId, false);
        rec.updatedAt = now();
        persistDebounced();
        schedulePush();
      }
      return;
    }
  }

  // ----------------------------------------------------------------- limits

  function countNonTerminal(): number {
    let n = 0;
    for (const rec of records.values()) if (!isTerminalSpawnState(rec.state)) n += 1;
    return n;
  }

  function countNonTerminalWhere(pred: (rec: Supervised) => boolean): number {
    let n = 0;
    for (const rec of records.values()) if (!isTerminalSpawnState(rec.state) && pred(rec)) n += 1;
    return n;
  }

  // ----------------------------------------------------------------- ①–④ start

  function start(req: AdmittedRequest, deadline: ReqDeadline): StartResult {
    if (closedFlag) return { ok: false, code: "E_LAUNCHER", reason: "closed" };
    if (platformFail) return { ok: false, code: "E_SPAWN_DENIED", reason: "platform" };
    if (records.has(req.spawnId)) return { ok: true, spawnId: req.spawnId }; // defensive dup
    if (deadline.remaining() < INTENT_MIN_REMAINING_MS) return { ok: false, code: "E_DEADLINE" };

    const t0 = now();

    // limits (arch §6.5 — the hub never ends an existing session to admit a new one)
    const active = countNonTerminal();
    if (active >= cfg.maxProcesses) {
      return { ok: false, code: "E_LIMIT", reason: "limit", limit: "global", active, max: cfg.maxProcesses };
    }
    const principal = spawnPrincipal(req.owner);
    const mine = countNonTerminalWhere((r) => spawnPrincipal(r.owner) === principal);
    if (mine >= cfg.maxPerPrincipal) {
      return {
        ok: false,
        code: "E_LIMIT",
        reason: "limit",
        limit: "principal",
        active: mine,
        max: cfg.maxPerPrincipal,
      };
    }
    const startingN = countNonTerminalWhere((r) => r.state === "launching" || r.state === "starting");
    if (startingN >= SPAWN_STARTING_MAX) {
      return {
        ok: false,
        code: "E_LIMIT",
        reason: "limit",
        limit: "starting",
        active: startingN,
        max: SPAWN_STARTING_MAX,
      };
    }

    // cooldown & breaker
    const gate = breakerGate(t0);
    if (gate !== undefined) return gate;

    // store / reaper / launcher fingerprint (plan §SP7 gate order)
    if (!store.healthy) return { ok: false, code: "E_LAUNCHER", reason: "persist" };
    if (!reaper.available || reaperDown) return { ok: false, code: "E_LAUNCHER", reason: "reaper" };
    const launcher = deps.launcher;
    if (launcherChanged) return { ok: false, code: "E_LAUNCHER", reason: "changed" };
    if (launcher === undefined) return { ok: false, code: "E_LAUNCHER", reason: "missing" };
    if (launcherCheck === undefined) return { ok: false, code: "E_LAUNCHER", reason: "unverifiable" };
    if (!launcherCheck.ok) return { ok: false, code: "E_LAUNCHER", reason: launcherCheck.reason };
    if (!recheckLauncherSync(launcherCheck.fp, deps.launcherFs)) {
      launcherChanged = true; // arch §4.2: degrade to launcher/changed until /webhub restart
      return { ok: false, code: "E_LAUNCHER", reason: "changed" };
    }

    const rec: Supervised = {
      spawnId: req.spawnId,
      state: "launching",
      cwd: req.admitted.realpath,
      dev: req.admitted.dev,
      ino: req.admitted.ino,
      createdAt: t0,
      updatedAt: t0,
      owner: {
        listener: req.owner.listener,
        reqId: req.owner.reqId,
        ...(req.owner.user !== undefined ? { user: req.owner.user } : {}),
      },
      ...(req.firstPrompt !== undefined
        ? { firstPrompt: { state: "pending" as const, textLen: req.firstPrompt.textLen } }
        : {}),
      linked: false,
      control: undefined,
      sessionId: undefined,
      hintDetail: undefined,
      uiCancelled: [],
      stderrTail: () => (rec.sink !== undefined ? rec.sink.tail() : undefined),
      child: undefined,
      stdio: undefined,
      sink: undefined,
      spawnEventSettled: false,
      everLive: false,
      breakerExempt: false,
      registerDeadlineAt: undefined,
      lifetimeDeadlineAt: undefined,
      spawnEventTimer: undefined,
      registerTimer: undefined,
      lifetimeTimer: undefined,
      stopTimer: undefined,
      lastOpenCount: 0,
      stop: undefined,
      removePending: false,
    };

    // ① intent — L1: on disk BEFORE the fork
    records.set(rec.spawnId, rec);
    const saved = store.saveNow(storedSnapshot());
    if (!saved.ok) {
      records.delete(rec.spawnId);
      return { ok: false, code: "E_LAUNCHER", reason: "persist" };
    }

    // ② pin cwd (TOCTOU re-check)
    const pin = dirs.pinSync({ realpath: rec.cwd, dev: rec.dev, ino: rec.ino });
    if (!pin.ok) {
      // Review re-run #5: ONE terminal entry point — finalizeTerminal drives the audit, the
      // pushes, the retention trim AND the SP8 onTerminal bridge (never_live), so the
      // forwarder's pending prompt expires instead of leaking. breakerExempt keeps §3.1 ②'s
      // "cwd raced away under the user" out of the launcher breaker. web-hub-delete-session plan
      // v2 §2.1 (C1): pid never existed for this record — `noProcess:"never-forked"` lets a
      // later delete be `confirmed` instead of fail-closed `unknown`.
      rec.breakerExempt = true;
      rec.endReason = "spawn_error";
      rec.noProcess = "never-forked";
      rec.stop = { reason: "spawn_error", terminalState: "failed", stage: 3 };
      finalizeTerminal(rec);
      return { ok: false, code: "E_DIR", reason: pin.reason };
    }

    // ③ fork — umask swap around a fully synchronous spawn, fd closed in finally
    let child: ChildProcess | undefined;
    try {
      if (deps.childUmask !== undefined) umaskFn(deps.childUmask);
      try {
        const childEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(deps.env)) {
          if (v === undefined || k.startsWith("PI_WEBHUB_")) continue;
          childEnv[k] = v;
        }
        childEnv.PI_WEBHUB_HEADLESS = "1";
        childEnv.PI_WEBHUB_SPAWN_ID = rec.spawnId;
        childEnv.PWD = rec.cwd;
        child = spawnFn(launcher[0], [launcher[1], "--mode", "rpc"], {
          cwd: pin.cwdArg,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
        });
        rec.child = child;
      } finally {
        if (deps.childUmask !== undefined) umaskFn(HUB_UMASK);
        closeFd(pin.fd);
      }
    } catch (err) {
      // §3.1 ③ + its note: the record exists (① built it), so the route still answers 202 —
      // the failure rides the spawns SSE. Breaker counts. web-hub-delete-session plan v2 §2.1
      // (C1): node's synchronous `spawn` throw only happens before the fork itself.
      rec.noProcess = "never-forked";
      failSpawnError(rec, err instanceof Error ? err.message : String(err));
      return { ok: true, spawnId: rec.spawnId };
    }
    if (child === undefined) {
      rec.noProcess = "never-forked";
      failSpawnError(rec, "spawnFn returned no child");
      return { ok: true, spawnId: rec.spawnId };
    }

    // ④ identity — same synchronous segment as the fork (L1's second save)
    rec.pid = child.pid ?? 0;
    const stat = readStatSync(rec.pid, procDeps);
    if (stat !== undefined) {
      const startTicks = parseStartTicks(stat);
      if (startTicks !== undefined && hubBootId !== "") {
        rec.procStartTicks = startTicks;
        rec.bootId = hubBootId;
        rec.uid = getuidFn();
      }
    }
    rec.state = "starting";
    rec.updatedAt = now();
    // L1 write #2 (review re-run #2): the pid+identity MUST land on disk in this same
    // synchronous segment — a failed write means the child can never be recovered from
    // spawns.json, so it must not outlive its record: stop it through the full verified
    // escalation chain and finish failed{spawn_error} instead of "starting".
    const saved2 = store.saveNow(storedSnapshot());
    // L2: the in-memory identity is complete — reaper.track stands even when the disk write failed.
    const track = trackIdentityOf(rec);
    if (track !== undefined) reaper.track(track);
    // wiring every early-terminal path still needs; the full stdio setup comes after the gate.
    // The 'error' listener MUST precede the saved2 gate too (review re-run 2, item #1): a child
    // whose L1 pid persist failed still owns live pipes, and an async 'error' with no listener
    // would throw as an unhandled EventEmitter error and take the hub down.
    child.stdin?.on("error", () => {}); // EPIPE is the orderly path, never an error here
    child.on("error", (err) => onChildError(rec, err));
    child.on("exit", (code, signal) => onChildExit(rec, code, signal));
    if (!saved2.ok) {
      log.error("spawn supervisor: L1 pid persist failed — stopping the fresh child", {
        spawnId: rec.spawnId,
        code: saved2.code,
      });
      // The record exists (① built it), so the 202 contract holds — the failure rides the SSE.
      enterStopping(rec, "spawn_error");
      return { ok: true, spawnId: rec.spawnId };
    }

    // stdio listeners — stdout drained from the fork instant on (arch §4.4)
    if (deps.stderrDir !== undefined) {
      rec.sink = createStderrSink({ dir: deps.stderrDir, spawnId: rec.spawnId, now, log });
      rec.stderrLog = `${rec.spawnId}.stderr.log`;
    }
    rec.stdio = createRpcStdio({
      write: (line) => writeStdin(rec, line),
      onUiCancelled: (e) => onUiCancelled(rec, e),
      onProtocolError: (detail) => onProtocolError(rec, detail),
      holdAllowed: () => holdAllowed(rec),
      now,
    });
    child.stdout?.on("data", (chunk: Buffer) => rec.stdio?.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => rec.sink?.push(chunk));
    child.once("spawn", () => {
      rec.spawnEventSettled = true;
      rec.spawnEventTimer = clearHandle(rec.spawnEventTimer);
    });
    // 'error' + 'exit' are already wired above the saved2 gate; never double-listen.

    // ⑤ spawn-event deadline
    rec.spawnEventTimer = arm(SPAWN_EVENT_MS, () => onSpawnEventTimeout(rec));

    // ⑥⑦ shared register deadline
    rec.registerDeadlineAt = t0 + cfg.registerTimeoutS * 1000;
    armRegisterTimer(rec);

    auditState(rec);
    schedulePush();
    return { ok: true, spawnId: rec.spawnId };
  }

  // ----------------------------------------------------------------- init / recovery

  function revive(stored: StoredRecord): Supervised {
    const rec: Supervised = {
      ...stored,
      linked: false,
      control: undefined,
      sessionId: undefined,
      hintDetail: undefined,
      uiCancelled: [],
      stderrTail: () => (rec.sink !== undefined ? rec.sink.tail() : undefined),
      child: undefined,
      stdio: undefined,
      sink: undefined,
      spawnEventSettled: true,
      everLive: stored.state === "live" || stored.state === "stopping",
      breakerExempt: true, // recovered records never re-trip the breaker
      registerDeadlineAt: undefined,
      lifetimeDeadlineAt: undefined,
      spawnEventTimer: undefined,
      registerTimer: undefined,
      lifetimeTimer: undefined,
      stopTimer: undefined,
      lastOpenCount: 0,
      stop: undefined,
      removePending: stored.removeIntent === true,
    };
    return rec;
  }

  function finalizeRecovered(rec: Supervised, identity?: "ok" | SpawnIdentityRejectReason): void {
    rec.state = "exited";
    rec.endReason = "orphan";
    rec.exit = { code: null, signal: null, unconfirmed: true };
    rec.stop = { reason: "orphan", terminalState: "exited", stage: 3 };
    rec.updatedAt = now();
    const entry: SpawnAuditRecord = {
      audit: "spawn",
      phase: "state",
      spawnId: rec.spawnId,
      state: "exited",
      endReason: "orphan",
    };
    if (rec.pid !== undefined) entry.pid = rec.pid;
    if (identity !== undefined) entry.identity = identity;
    deps.audit(entry);
  }

  /** arch §7.7's orphan escalation (review re-run 2, item #2): the SIGNAL phase never rides
   *  init's synchronous stretch — it is scheduled off the startup call stack with an unref'd
   *  `setImmediate`, so N orphan records never serialize procfs reads + kills into boot. Inside
   *  the deferred task the L5 contract is unchanged (review re-run 1, item #3): a SYNC procfs
   *  verify immediately followed by the signal — no await between them, no TOCTOU window —
   *  then a re-verified SIGKILL +3s later on an unref'd timer. The bookkeeping that DECIDES
   *  whether a record gets a signal job (bootId compare, environ scan) stays in init's own
   *  bounded read phase; only the signals move. */
  function recoverEscalate(id: SpawnedIdentity): void {
    const task = setImmediate(() => {
      if (!verifyIdentityById(id, true).ok) return;
      if (!groupKill(id.pid, "SIGTERM")) return;
      const t = setTimeout(() => {
        if (!verifyIdentityById(id, true).ok) return; // re-verify in the signal's sync segment
        groupKill(id.pid, "SIGKILL");
      }, RECOVER_KILL_AFTER_MS);
      t.unref?.();
    });
    task.unref?.();
  }

  function readBtimeSec(): number | undefined {
    try {
      const statText = readProc("/proc/stat");
      const line = statText.split("\n").find((l) => l.startsWith("btime "));
      if (line === undefined) return undefined;
      const n = Number(line.slice("btime ".length).trim());
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * arch §7.7's launching-record scan: the `environ` of every same-uid `/proc` process (≤4096,
   * ≤1s) looking for `PI_WEBHUB_SPAWN_ID=<spawnId>` with `comm==="pi"`, `pgrp===pid`, and a starttime no
   * earlier than `createdAt - 1s` (btime-converted). A hit gets the orphan escalation; a miss
   * is `failed{spawn_error}` with no signal.
   */
  function scanEnvironForSpawnId(spawnId: string, createdAt: number): SpawnedIdentity | undefined {
    const deadlineAt = now() + RECOVER_SCAN_BUDGET_MS;
    const btimeSec = readBtimeSec();
    if (btimeSec === undefined) return undefined;
    let names: string[];
    try {
      names = readdirFn("/proc");
    } catch {
      return undefined;
    }
    let scanned = 0;
    for (const name of names) {
      if (!/^[0-9]+$/.test(name)) continue;
      if (++scanned > RECOVER_SCAN_MAX_PROCS || now() > deadlineAt) return undefined;
      const pid = Number(name);
      let environ: string;
      try {
        environ = readProc(`/proc/${pid}/environ`);
      } catch {
        continue; // other-uid procs are unreadable — the "same uid only" filter, naturally
      }
      if (!environ.includes(`PI_WEBHUB_SPAWN_ID=${spawnId}\0`)) continue;
      let comm: string;
      try {
        comm = readProc(`/proc/${pid}/comm`).trim();
      } catch {
        continue;
      }
      if (comm !== "pi") continue;
      const stat = readStatSync(pid, procDeps);
      if (stat === undefined) continue;
      const pgrp = parsePgrp(stat);
      if (pgrp !== pid) continue;
      const startTicks = parseStartTicks(stat);
      if (startTicks === undefined) continue;
      const startMs = btimeSec * 1000 + (startTicks * 1000) / PROC_CLOCK_HZ;
      if (startMs < createdAt - 1000) continue;
      let status: string;
      try {
        status = readProc(`/proc/${pid}/status`);
      } catch {
        continue;
      }
      const uid = parseUidLine(status);
      if (uid === undefined || uid.real !== getuidFn() || uid.effective !== getuidFn()) continue;
      return { pid, procStartTicks: startTicks, bootId: hubBootId, uid: uid.real };
    }
    return undefined;
  }

  async function init(deadline: ReqDeadline): Promise<void> {
    if (initialized) return;
    initialized = true;
    if (!deps.platform.ok) {
      // §7.1 fail closed: no reaper, no spawns.json write, no fork — caps still carry spawn.v1.
      platformFail = true;
      return;
    }

    const loaded = store.load(deadline);
    const writerBoot = loaded.writer?.bootId;
    const bootChanged = writerBoot !== undefined && writerBoot !== "" && hubBootId !== "" && writerBoot !== hubBootId;

    let mutated = false;
    for (const stored of loaded.records) {
      const rec = revive(stored);
      records.set(rec.spawnId, rec);
      if (isTerminalSpawnState(stored.state)) continue;
      mutated = true;
      if (bootChanged) {
        rec.noProcess = "boot-changed"; // web-hub-delete-session plan v2 §2.1 (C1)
        finalizeRecovered(rec, "boot-mismatch"); // machine rebooted — no signal is meaningful
        continue;
      }
      const identity = trackIdentityOf(rec);
      if (identity !== undefined) {
        finalizeRecovered(rec);
        recoverEscalate({
          pid: identity.pid,
          procStartTicks: identity.startTicks,
          bootId: identity.bootId,
          uid: identity.uid,
        });
        continue;
      }
      if (stored.state === "launching") {
        const hit = scanEnvironForSpawnId(stored.spawnId, stored.createdAt);
        if (hit !== undefined) {
          rec.pid = hit.pid;
          rec.procStartTicks = hit.procStartTicks;
          rec.bootId = hit.bootId;
          rec.uid = hit.uid;
          finalizeRecovered(rec);
          recoverEscalate(hit);
        } else {
          rec.state = "failed";
          rec.endReason = "spawn_error";
          rec.stop = { reason: "spawn_error", terminalState: "failed", stage: 3 };
          rec.updatedAt = now();
        }
        continue;
      }
      // non-terminal without a full identity (e.g. ④'s unreadable /proc) — fail closed, no signal
      finalizeRecovered(rec);
    }

    // web-hub-delete-session plan v2 §2.6 (r1 #6): every record recovered with a persisted
    // remove intent gets ONE more verdict before it resumes normal life. By this point every
    // record above is terminal (either it already was, or the recovery branches above just
    // finalized it) — an already-`confirmed` one (e.g. a genuine exit recorded before the crash,
    // or `noProcess` evidence) deletes immediately; everything else waits
    // `RECOVER_KILL_AFTER_MS + EXIT_GUARD_MS` for `recoverEscalate`'s TERM→KILL ladder (armed
    // above) to actually land before judging "still alive" (giving up clears the intent, same
    // outcome as the live guard-timeout path — the card reappears via the next `agent_up`).
    const pendingRemoveConfirm: string[] = [];
    for (const rec of records.values()) {
      if (!rec.removePending) continue;
      if (computeDeath(rec) === "confirmed") {
        deleteRecord(rec);
        continue;
      }
      pendingRemoveConfirm.push(rec.spawnId);
    }
    if (pendingRemoveConfirm.length > 0) {
      removeConfirmTimer = arm(RECOVER_KILL_AFTER_MS + EXIT_GUARD_MS, () => {
        removeConfirmTimer = undefined;
        for (const spawnId of pendingRemoveConfirm) {
          const rec = records.get(spawnId);
          if (rec === undefined || !rec.removePending) continue;
          if (computeDeath(rec) === "confirmed") {
            deleteRecord(rec);
          } else {
            rec.removePending = false;
            persistDebounced();
            schedulePush();
            deps.audit({ audit: "spawn", phase: "remove", spawnId: rec.spawnId, code: "E_EXIT_UNCONFIRMED" });
          }
        }
      });
    }

    launcherCheck = await checkLauncherAsync(deps.launcher, deadline, deps.launcherFs);
    if (!launcherCheck.ok) {
      log.warn("spawn supervisor: launcher check failed", {
        reason: launcherCheck.reason,
        ...(launcherCheck.detail !== undefined ? { detail: launcherCheck.detail } : {}),
      });
    }

    const reaperOk = await reaper.start(deadline);
    if (!reaperOk) {
      reaperDown = true; // §6.5: refuse new spawns; existing (recovered) sessions keep running
      log.error("spawn supervisor: reaper failed to start — new spawns refused");
    }

    if (mutated) {
      persistDebounced();
      schedulePush();
    }
  }

  // ----------------------------------------------------------------- shutdown (§7.6)

  function onceExit(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
  }

  function sleepBounded(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  function shutdown(deadline: ReqDeadline): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    closedFlag = true;
    unsubscribeBus();
    removeConfirmTimer = clearHandle(removeConfirmTimer);
    shutdownPromise = (async () => {
      const waitBudget = deriveBudget(deadline.remaining(), 3000, 6500);
      const pending = [...records.values()].filter((r) => !isTerminalSpawnState(r.state));
      const exitWaits: Array<Promise<void>> = [];
      for (const rec of pending) {
        clearRecordTimers(rec);
        if (rec.stop === undefined) {
          rec.state = "stopping";
          rec.endReason = "hub";
          rec.stop = { reason: "hub", terminalState: "exited", stage: 0 };
          rec.updatedAt = now();
        }
        writeStdinEnd(rec); // EOF is the orderly lever; the reaper's EOF escalation backs us up
        if (rec.child !== undefined) exitWaits.push(onceExit(rec.child));
      }
      if (pending.length > 0) {
        persistDebounced();
        schedulePush();
      }
      if (exitWaits.length > 0 && waitBudget > 0) {
        await Promise.race([Promise.all(exitWaits), sleepBounded(waitBudget)]);
      }
      // survivors: identity-verified SIGTERM only (KILL stays the reaper's job after our EOF)
      for (const rec of records.values()) {
        if (isTerminalSpawnState(rec.state)) continue;
        const verified = verifyIdentitySync(rec, true);
        if (verified.ok) groupKill(verified.pid, "SIGTERM");
      }
      store.flushAndClose(deadline);
      const sinkBudget = deriveBudget(deadline.remaining(), 300, 6000);
      const sinkDeadline = createReqDeadline(now, Math.max(1, sinkBudget));
      const closes: Array<Promise<void>> = [];
      for (const rec of records.values()) {
        const sink = rec.sink;
        if (sink !== undefined) closes.push(sink.close(sinkDeadline));
      }
      if (closes.length > 0) await Promise.all(closes);
      reaper.close();
    })();
    return shutdownPromise;
  }

  // ----------------------------------------------------------------- surface

  function policy(
    principal: string,
    listener: "loopback" | "lan",
    scheme: "http" | "https",
    viaTrustedProxy: boolean,
  ): SpawnPolicyWire {
    const base = {
      confirm: listener === "lan" ? ("always" as const) : ("unknown-dir" as const),
      scope:
        listener === "loopback"
          ? ("roots" as const)
          : cfg.lan === "roots" && !(scheme === "http" && !viaTrustedProxy)
            ? ("roots" as const)
            : ("known" as const),
      max: cfg.maxProcesses,
      maxPerPrincipal: cfg.maxPerPrincipal,
      active: countNonTerminal(),
      activeMine: countNonTerminalWhere((r) => spawnPrincipal(r.owner) === principal),
      registerTimeoutS: cfg.registerTimeoutS,
      maxLifetimeMinutes: cfg.maxLifetimeMinutes,
    };
    const t = now();
    pruneFailures(t);
    if (platformFail) {
      const detail = deps.platform.ok ? undefined : deps.platform.detail;
      return { allowed: false, reason: "platform", ...(detail !== undefined ? { detail } : {}), ...base };
    }
    if (launcherChanged) return { allowed: false, reason: "launcher", detail: "changed", ...base };
    if (deps.launcher === undefined) return { allowed: false, reason: "launcher", detail: "missing", ...base };
    if (launcherCheck !== undefined && !launcherCheck.ok) {
      return { allowed: false, reason: "launcher", detail: launcherCheck.reason, ...base };
    }
    if (!store.healthy) return { allowed: false, reason: "persist", ...base };
    if (!reaper.available || reaperDown) return { allowed: false, reason: "reaper", ...base };
    if (breakerUntil > t) {
      return { allowed: false, reason: "breaker", retryAfterS: Math.ceil((breakerUntil - t) / 1000), ...base };
    }
    if (breakerUntil > 0 && halfOpenProbe) return { allowed: false, reason: "cooldown", retryAfterS: 1, ...base };
    if (failTimestamps.length > 0) {
      const last = failTimestamps[failTimestamps.length - 1] ?? t;
      const cooldown = SPAWN_BACKOFF_MS[Math.min(failTimestamps.length - 1, SPAWN_BACKOFF_MS.length - 1)] ?? 0;
      if (cooldown > 0 && t - last < cooldown) {
        return { allowed: false, reason: "cooldown", retryAfterS: Math.ceil((cooldown - (t - last)) / 1000), ...base };
      }
    }
    if (closedFlag) return { allowed: false, reason: "launcher", detail: "closed", ...base };
    return { allowed: true, ...base };
  }

  return {
    init,
    policy,
    start,
    stop(spawnId: string, force: boolean): { ok: true; state: SpawnState } | { ok: false; code: "E_NOT_FOUND" } {
      const rec = records.get(spawnId);
      if (rec === undefined) return { ok: false, code: "E_NOT_FOUND" };
      // `launching` only ever exists inside start()'s synchronous stretch — unreachable here;
      // mapped anyway so the wire state type stays honest.
      const wire = (): SpawnState => (rec.state === "launching" ? "starting" : rec.state);
      if (isTerminalSpawnState(rec.state)) return { ok: true, state: wire() };
      if (rec.state === "stopping") return { ok: true, state: "stopping" };
      enterStopping(rec, "user");
      if (force) escalateStep(rec, 1); // force: skip the stdin grace, the signal path starts now
      return { ok: true, state: wire() };
    },
    records(): readonly InternalRecord[] {
      return [...records.values()];
    },
    isManaged(agentKey: string): boolean {
      return findByAgentKey(agentKey) !== undefined;
    },
    noteVersion(agentKey: string, pluginVersion: string): void {
      const rec = findByAgentKey(agentKey);
      if (rec === undefined) return;
      if (deps.pluginVersion !== undefined && compareDotVersions(pluginVersion, deps.pluginVersion) > 0) {
        rec.hint = "newer-plugin";
        rec.updatedAt = now();
        persistDebounced();
        schedulePush();
      }
    },
    liveCount(): number {
      return countNonTerminal();
    },
    busyCount(): number {
      return countNonTerminalWhere((r) => {
        if (r.agentKey === undefined || r.state !== "live") return false;
        return registry.get(r.agentKey)?.status?.busy === true;
      });
    },
    noteSpawnChanged(spawnId: string): void {
      // SP8's onChange landing: the record's firstPrompt view moved — one merged push (which
      // itself persists). The forwarder keeps the authoritative state (and its own audit
      // lines); the stored slice is advisory for SP9's accept path only.
      if (!records.has(spawnId)) return;
      schedulePush();
    },
    lookupByAgentKey(agentKey: string): { spawnId: string } | undefined {
      let best: Supervised | undefined;
      for (const rec of records.values()) {
        if (rec.agentKey !== agentKey) continue;
        if (best === undefined || rec.updatedAt > best.updatedAt) best = rec;
      }
      return best === undefined ? undefined : { spawnId: best.spawnId };
    },
    remove(spawnId: string, deadline: ReqDeadline): RemoveResult {
      const rec = records.get(spawnId);
      if (rec === undefined) return { ok: false, code: "E_NOT_FOUND" };
      if (!isTerminalSpawnState(rec.state)) {
        if (rec.removePending) return { ok: true, outcome: "pending", state: "stopping" };
        if (deadline.remaining() < INTENT_MIN_REMAINING_MS) return { ok: false, code: "E_DEADLINE" };
        rec.removePending = true;
        const saved = store.saveNow(storedSnapshot());
        if (!saved.ok) {
          // web-hub-delete-session plan v2 §2.2/§2.6 degrade D-6: the intent lives in memory only
          // until the next successful write — the three safety invariants are unaffected either
          // way (the record is never deleted without a CONFIRMED death), deletion just proceeds.
          log.warn("spawn supervisor: remove-intent persist failed, continuing in-memory only", {
            spawnId: rec.spawnId,
            code: saved.code,
          });
        }
        if (rec.state !== "stopping") enterStopping(rec, "user");
        schedulePush();
        return { ok: true, outcome: "pending", state: "stopping" };
      }
      if (computeDeath(rec) === "confirmed") {
        deleteRecord(rec);
        return { ok: true, outcome: "removed" };
      }
      return { ok: false, code: "E_AGENT_ONLINE", reason: "exit-unconfirmed" };
    },
    deathOf(spawnId: string): Death | undefined {
      const rec = records.get(spawnId);
      return rec === undefined ? undefined : computeDeath(rec);
    },
    shutdown,
  };
}
