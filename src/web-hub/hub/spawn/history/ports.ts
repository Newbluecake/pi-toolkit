/**
 * web-hub session-history plan §3.5 (P0 — frozen surface, TYPES ONLY): the hub-side
 * `HistoryService` port. P-scan implements it (`./service.ts`), P-route's routes and the
 * supervisor's restore re-fork consume it — every one of them develops against THIS file,
 * so names/shapes must match the plan exactly. Modifying it means going back to P0 and
 * re-freezing.
 *
 * Zero-`as` module (`hub/spawn/**` source-scan contract — trivially, types only). Boundary
 * rule (§4.5): imports only `src/web-hub/{protocol,hub}` paths, never pi.
 *
 * Overrides applied over the §3.5 body, per the plan's final amendments: `dispose()` is part
 * of the frozen interface (v3.2 V2 / v3.3 W3 + X3.4), `diag()` additionally reports the fd
 * ledger (v3.3 W1), and there is NO history-origin/provenance surface anywhere — no
 * `historyOrigin` field, no provenance file, `captureSessionPathPin` takes no sessionsRoot
 * parameter (v3.4 X1).
 */
import type {
  ForkReason,
  HistoryKind,
  HistoryLiveWire,
  HistoryPage,
  ProofGap,
  SessionRefWire,
} from "../../../protocol/session-history.js";
import type { HubLog } from "../../ports.js";
import type { ReqDeadline } from "../../req-deadline.js";
import type { SpawnRegistryPort } from "../ports.js";

/**
 * v3.3 W1: the history service's fd-ledger caps. `HISTORY_GEN_MAX` is also §6.1's budget-table
 * row (generation LRU bound) — the plan parks the history constants in the budget table owned
 * by P-scan's `budget.ts`, which does not exist yet and is outside P0's file domain, so the
 * P0-frozen home of all three is here and P-scan imports them.
 *
 * - `HISTORY_FD_MAX`: total fds the history service may hold at once, across all kinds.
 * - `HISTORY_PIN_MAX`: concurrently held `SessionPin`s (each owns 3 fds).
 * - `HISTORY_GEN_MAX`: concurrently live scan generations (each ≤ 2 resident fds ⇒ ≤ 8).
 */
export const HISTORY_FD_MAX = 32;
export const HISTORY_PIN_MAX = 4;
export const HISTORY_GEN_MAX = 4;

export interface HistoryListQuery {
  q?: string;
  kind: "main" | "all";
  cursor?: { genId: string; pos: number };
  limit: number;
}
export type HistoryPageResult = { ok: true; page: HistoryPage } | { ok: false; reason: "cursor-expired" };

/** dev/ino of one lstat/fstat level. */
export interface InodeRef {
  readonly dev: number;
  readonly ino: number;
}
/** The three levels pi will re-walk by PATH on `--session <abs>`: realpath(sessionsRoot), its `<dir>`, the file. */
export interface SessionPathPin {
  readonly abs: string; // the literal path handed to pi — byte-equal to what pi must report back as sessionFile
  readonly root: InodeRef;
  readonly dir: InodeRef;
  readonly file: InodeRef; // nlink was 1 at pin time (otherwise session-invalid)
}

/** The fd-pinned session (§4.5.6). Owns three open fds until release(); release() is idempotent. */
export interface SessionPin extends SessionPathPin {
  readonly id: string;
  readonly cwd: string; // header cwd (=== request body cwd)
  readonly kind: HistoryKind;
  readonly size: number;
  release(): void;
}
export type ResolveResult =
  | { ok: true; pin: SessionPin }
  | { ok: false; status: 400; code: "E_BAD_REQUEST"; reason: "session-ref" }
  | { ok: false; status: 400; code: "E_DIR"; reason: "session-missing" | "session-mismatch" | "session-invalid" }
  | { ok: false; status: 504; code: "E_DEADLINE" };

/** One scanned /proc entry as captured by the async scan (§4.5.5). */
export interface ProcSeen {
  readonly startTicks: number;
  readonly uid: number;
  readonly comm: string;
  readonly cls: "pi" | "node-other" | "other"; // pi = candidate (comm "pi", or node* whose cmdline says pi cli)
}
/** The async scan's full pid picture, consumed by the SYNC re-stat (`reprove`). Plain data, not opaque. */
export interface ProcScanToken {
  readonly at: number; // deps.now() when the scan finished
  readonly complete: boolean; // false ⇒ prove already returned gap proc-partial; reprove must not be called
  readonly pids: ReadonlyMap<number, ProcSeen>; // EVERY numeric /proc entry seen, any uid
}

/** Result of the occupancy check (§4.5.5). free ⇔ in-place resume allowed. */
export type OccupancyProof =
  | { free: true; scan: ProcScanToken }
  | { free: false; reason: ForkReason; gap?: ProofGap; live?: HistoryLiveWire; scan?: ProcScanToken };

export type SnapshotResult =
  | { ok: true; snapshot: ForkSnapshot }
  | { ok: false; status: 400; reason: "session-too-large" }
  | { ok: false; status: 504 };
export interface ForkSnapshot {
  readonly path: string; // <forkSrcDir>/snap-<rand>.jsonl, 0600, complete lines only
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  discard(): void; // unlink (sync, best effort) — used when the request fails before start()
}

export interface HistoryService {
  page(q: HistoryListQuery, deadline: ReqDeadline): Promise<HistoryPageResult>;
  resolve(ref: SessionRefWire, cwd: string, deadline: ReqDeadline): Promise<ResolveResult>;
  /** Async, bounded: kind + C1/C2 + FRESH full /proc scan. Never rejects (deadline ⇒ free:false, gap proc-partial). */
  prove(pin: SessionPin, deadline: ReqDeadline): Promise<OccupancyProof>;
  /** Post-second-authorize SYNC stretch: C1/C2 + FULL /proc re-stat compared against `scan` (§4.5.5). No await. */
  reprove(pin: SessionPin, scan: ProcScanToken): OccupancyProof;
  /** SYNC: three-level lstat chain + nlink===1 + realpathSync(abs)===abs against the pinned fds (resume only). */
  verifyForSpawn(pin: SessionPin): { ok: true } | { ok: false; reason: "session-changed" };
  /** Async, bounded: copy complete lines from the PINNED fd into forkSrcDir (fork only). */
  snapshot(pin: SessionPin, deadline: ReqDeadline): Promise<SnapshotResult>;
  /** SYNC: snapshot still the file we wrote (lstat dev/ino/size, regular, 0600). */
  verifySnapshot(s: ForkSnapshot): boolean;
  /** Read-only diagnostics for assembly tests (PD22); `fds` additionally reports the v3.3 W1 ledger. */
  diag(): {
    procFsSource: "default" | "seam";
    fsSource: "default" | "seam";
    /** v3.3 W1: live fd-ledger counters by kind — `gen` (resident generation fds), `pin`
     * (SessionPin fds), `temp` (paging/snapshot fds) — against `max` = HISTORY_FD_MAX. */
    fds: { gen: number; pin: number; temp: number; max: number };
  };
  /**
   * v3.2 V2 / v3.3 W3 + X3.4: shut the service down. Idempotent (every call awaits the same
   * underlying promise). Semantics: set `disposed` (afterwards `page`/`resolve`/`prove`/
   * `snapshot` return a bounded 503 `busy`, `reprove`/`verify*` return failure conclusions),
   * mark every gen `retired`, wait ≤2s (unref'd timers) for active leases, then force-close
   * remaining fds (all ledger kinds + the IO gate's late fds). Wired by hub assembly on the
   * runtime `close()` path (after spawn supervisor stop, before `fe.close()`) AND on the
   * startup-rollback cleanup stack — both paths may call it.
   */
  dispose(): Promise<void>;
}

/**
 * SYNC helper for supervisor `restoreForkSync()` (restore re-fork, history on) — the SAME checks the first resume's
 * pinSession+verifyForSpawn impose, by PATH: lstat the three levels pi will re-walk on `--session <abs>`
 * (`dirname(dirname(abs))`, `dirname(abs)`, `abs`) — none a symlink, the dir level is a directory, file regular,
 * nlink === 1, uid match; `realpathSync(abs) === abs`. NO sessionsRoot ownership requirement (v3.4 X1: EVERY
 * `--session <file>` restore gets the same capture — custom-sessionDir managed sessions included; there is no
 * history-origin/provenance distinction). Failure ⇒ the restore is REFUSED (PD24), never `--session`.
 * Lives in history/pin.ts; supervisor imports it.
 */
export type CaptureSessionPathPin = (
  abs: string,
  uid: number,
) => { ok: true; pin: SessionPathPin } | { ok: false; detail: string };
/**
 * SYNC post-live check (§4.5.6): `reported === pin.abs` byte-equal, three-level lstat chain dev/ino equal,
 * no symlink, regular, nlink === 1, `realpathSync(pin.abs) === pin.abs`. Any failure ⇒ "session-swapped".
 */
export type VerifySessionPathPin = (
  pin: SessionPathPin,
  reported: string | undefined,
) => { ok: true } | { ok: false; detail: string };

export interface ManagedSessionView {
  spawnId: string;
  state: "launching" | "starting" | "live" | "stopping" | "exited" | "failed";
  agentKey?: string;
  pid?: number;
  procStartTicks?: number;
  sessionId?: string;
  sessionFile?: string;
  sessionTarget?: { id: string; file?: string };
}
export type DeathVerdict = "confirmed" | "alive" | "unknown";
export interface HistoryServiceDeps {
  agentDir: string; // process.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`
  forkSrcDir: string;
  registry: Pick<SpawnRegistryPort, "list">;
  managed(): readonly ManagedSessionView[]; // read LIVE per call
  deathOf(spawnId: string): DeathVerdict | undefined;
  uid: number;
  hubPid: number;
  now(): number;
  log: HubLog;
}
// createHistoryService(deps, seams?) lives in ./service.ts (P-scan); HistorySeams is P-scan-owned, not frozen:
//   { fs?: Partial<HistoryFs>; procFs?: Partial<ProcFs>; gate?: HistoryIoGate }
