/**
 * web-hub session-history plan §4.5 (`service.ts`): `createHistoryService` — the P-scan
 * composition root implementing the frozen `HistoryService` port (`ports.ts`). Wires
 * budget/fd-ledger/gen-store/header-index/cwd-cache/occupancy/pin/snapshot into one object,
 * tracks every live `SessionPin` so `dispose()` can force-release them, and exposes `diag()`
 * for the P-int assembly tests (PD22 / v3.3 W1).
 */
import { dirname } from "node:path";
import type {
  HistoryListQuery,
  HistoryPageResult,
  HistoryService,
  HistoryServiceDeps,
  OccupancyProof,
  ProcScanToken,
  ResolveResult,
  SessionPin,
  SnapshotResult,
} from "./ports.js";
import type { ReqDeadline } from "../../req-deadline.js";
import {
  createHistoryIoGate,
  HISTORY_DISPOSE_MS,
  HISTORY_FD_MAX,
  PROC_SCAN_CACHE_MS,
  type HistoryIoGate,
} from "./budget.js";
import { createFdLedger, type FdLedger } from "./fd-ledger.js";
import { createGenStore, type GenStore } from "./generation.js";
import { createHeaderIndex, pageHistory, type HeaderIndex } from "./index.js";
import { createCwdCache, defaultCwdFs, type CwdCache, type CwdFs } from "./cwd.js";
import { defaultHistoryFs, defaultHistorySyncFs, type HistoryFs, type HistorySyncFs } from "./fs.js";
import { defaultProcFs, defaultProcSyncFs, scanAsync, type ProcFs, type ProcSyncFs } from "./proc.js";
import { createOccupancyChecker } from "./occupancy.js";
import { createPinAdmission, pinSession, verifyForSpawn, type PinAdmission } from "./pin.js";
import { createForkSrcDirState, snapshotFork } from "./snapshot.js";

export interface HistorySeams {
  fs?: Partial<HistoryFs>;
  procFs?: Partial<ProcFs>;
  /** Verifier P2 (P-int flake round): the SYNC re-prove's /proc view — same seam discipline as
   *  `procFs` (programmatic only, merged over the real readers). Without it the sync re-stat
   *  always walks the whole real /proc, and on a saturated machine either its own 50 ms
   *  budget trips (`proc-partial`) or a foreign same-uid pi/node pid born mid-scan reads as
   *  `new-process` — both environmental 409s no retry can reliably absorb. */
  procSyncFs?: Partial<ProcSyncFs>;
  gate?: HistoryIoGate;
}

function mergeFs(seam: Partial<HistoryFs> | undefined): HistoryFs {
  return { ...defaultHistoryFs(), ...seam };
}
function mergeProcFs(seam: Partial<ProcFs> | undefined): ProcFs {
  return { ...defaultProcFs(), ...seam };
}

export function createHistoryService(deps: HistoryServiceDeps, seams?: HistorySeams): HistoryService {
  const fsSource: "default" | "seam" = seams?.fs === undefined ? "default" : "seam";
  const procFsSource: "default" | "seam" = seams?.procFs === undefined ? "default" : "seam";
  const fs = mergeFs(seams?.fs);
  const procFs = mergeProcFs(seams?.procFs);
  const procSyncFs: ProcSyncFs = { ...defaultProcSyncFs(), ...seams?.procSyncFs };
  const syncFs: HistorySyncFs = defaultHistorySyncFs();
  const cwdFs: CwdFs = defaultCwdFs();
  const gate: HistoryIoGate = seams?.gate ?? createHistoryIoGate();
  const ledger: FdLedger = createFdLedger(HISTORY_FD_MAX);
  const genStore: GenStore = createGenStore({
    agentDir: deps.agentDir,
    uid: deps.uid,
    fs,
    gate,
    ledger,
    now: deps.now,
  });
  const headerIndex: HeaderIndex = createHeaderIndex();
  const cwdCache: CwdCache = createCwdCache();
  const occupancy = createOccupancyChecker(deps, procFs, procSyncFs);
  const forkSrcDirState = createForkSrcDirState();
  const pinAdmission: PinAdmission = createPinAdmission();
  const home = dirname(dirname(deps.agentDir));

  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const livePins = new Set<SessionPin>();

  let lastScan: { at: number; complete: boolean } | undefined;
  let scanInFlight = false;
  function liveness(): "partial" | "no-proc" | undefined {
    if (process.platform !== "linux") return "no-proc";
    if (lastScan !== undefined && deps.now() - lastScan.at < PROC_SCAN_CACHE_MS) {
      return lastScan.complete ? undefined : "partial";
    }
    // Finding 5 fix: the refresh stays fire-and-forget (page() must never block on a fresh
    // /proc scan just for this hint) but is now bounded/tracked instead of a bare
    // `.then().catch()`: `scanInFlight` prevents unbounded concurrent scans from piling up on
    // repeated calls before the previous one settles (`scanAsync` itself is already bounded by
    // `PROC_SCAN_BUDGET_MS` + the per-call `PROC_CALL_MS` races), and the `disposed` guard
    // means a scan that outlives `dispose()` never writes `lastScan` afterward.
    if (!scanInFlight && !disposed) {
      scanInFlight = true;
      scanAsync({ procFs, uid: deps.uid, hubPid: deps.hubPid, now: deps.now })
        .then((token) => {
          if (!disposed) lastScan = { at: deps.now(), complete: token.complete };
        })
        .catch(() => undefined)
        .finally(() => {
          scanInFlight = false;
        });
    }
    return lastScan === undefined ? undefined : lastScan.complete ? undefined : "partial";
  }

  function wrapPinRelease(pin: SessionPin): SessionPin {
    // Mutate IN PLACE — never clone: `pin.ts`'s `pinFds` WeakMap is keyed by this exact object
    // identity, and `verifyForSpawn`/`snapshot` must still be able to look the real fds up
    // through whatever reference the caller hands back.
    const originalRelease = pin.release;
    let released = false;
    pin.release = (): void => {
      if (released) return;
      released = true;
      livePins.delete(pin);
      originalRelease();
    };
    return pin;
  }

  return {
    async page(q: HistoryListQuery, deadline: ReqDeadline): Promise<HistoryPageResult> {
      if (disposed) {
        return {
          ok: true,
          page: {
            items: [],
            partial: { reason: "zombie" },
            stats: { files: 0, indexed: 0, enum: { complete: false, dirsDone: 0, dirsTotal: 0, dirsSkipped: 0 } },
          },
        };
      }
      return pageHistory(q, deadline, {
        genStore,
        fs,
        gate,
        ledger,
        uid: deps.uid,
        now: deps.now,
        home,
        cwdCache,
        cwdFsDeps: { fs: cwdFs, gate, now: deps.now },
        registry: deps.registry,
        managed: deps.managed,
        headerIndex,
        liveness,
      });
    },

    async resolve(ref, cwd: string, deadline: ReqDeadline): Promise<ResolveResult> {
      if (disposed) return { ok: false, status: 504, code: "E_DEADLINE" };
      const result = await pinSession(ref, cwd, deadline, {
        agentDir: deps.agentDir,
        uid: deps.uid,
        fs,
        gate,
        ledger,
        admission: pinAdmission,
        now: deps.now,
      });
      if (result.ok) {
        const wrapped = wrapPinRelease(result.pin);
        livePins.add(wrapped);
        return { ok: true, pin: wrapped };
      }
      return result;
    },

    async prove(pin: SessionPin, deadline: ReqDeadline): Promise<OccupancyProof> {
      if (disposed) return { free: false, reason: "unverified", gap: "proc-partial" };
      return occupancy.prove(pin, deadline);
    },

    reprove(pin: SessionPin, scan: ProcScanToken): OccupancyProof {
      if (disposed) return { free: false, reason: "unverified", gap: "proc-partial" };
      return occupancy.reprove(pin, scan);
    },

    verifyForSpawn(pin: SessionPin): { ok: true } | { ok: false; reason: "session-changed" } {
      if (disposed) return { ok: false, reason: "session-changed" };
      return verifyForSpawn(pin, syncFs);
    },

    async snapshot(pin: SessionPin, deadline: ReqDeadline): Promise<SnapshotResult> {
      if (disposed) return { ok: false, status: 504 };
      return snapshotFork(
        pin,
        deadline,
        { forkSrcDir: deps.forkSrcDir, fs, gate, ledger, now: deps.now },
        forkSrcDirState,
      );
    },

    verifySnapshot(s): boolean {
      try {
        const st = syncFs.lstatSync(s.path);
        return (
          !st.isSymbolicLink() && st.isFile() && st.dev === s.dev && st.ino === s.ino && (st.mode & 0o777) === 0o600
        );
      } catch {
        return false;
      }
    },

    diag() {
      const counts = ledger.counts();
      return {
        procFsSource,
        fsSource,
        fds: { gen: counts.gen, pin: counts.pin, temp: counts.temp, max: counts.max },
      };
    },

    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        // Finding 6 fix: ONE shared hard deadline across every kind of outstanding lease
        // (pin/gen/late-fd) instead of the old crude "wait for pins, then unconditionally
        // close gens" two-step (which never waited for ACTIVE gen leases at all, and could
        // sum past HISTORY_DISPOSE_MS). `genStore.retireAll()` stops it from handing out the
        // gen to any NEW acquire() while we wait.
        const start = deps.now();
        const hardDeadline = start + HISTORY_DISPOSE_MS;
        genStore.retireAll();
        while (deps.now() < hardDeadline && (livePins.size > 0 || genStore.hasActiveLeases() || gate.lateFdCount > 0)) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 20);
            t.unref();
          });
        }
        // Whatever is STILL outstanding at the hard deadline is force-released/force-closed
        // without awaiting settlement (release() is sync/idempotent; genStore.dispose() uses
        // `boundedClose` fire-and-forget internally).
        for (const pin of Array.from(livePins)) pin.release();
        // Verifier round 3 (defect 3c): do NOT await genStore.dispose() past the hard deadline
        // — even with closeGenFds now firing every gen's closes in parallel, each underlying
        // close can still hang up to HISTORY_CLOSE_MS past the deadline and awaiting them here
        // could push dispose() past its own HISTORY_DISPOSE_MS bound. The CAS/late-close
        // machinery makes the force-close safe to leave running on its own: the `gen.closed`
        // flip is at-most-once, every close is individually bounded, and the ledger releases
        // as each settles. dispose() itself resolves by hardDeadline + a small epsilon.
        void genStore.dispose();
      })();
      return disposePromise;
    },
  };
}
