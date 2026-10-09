/**
 * web-hub session-history plan §4.8 (P-int) + verifier P2 (flake round) — the deterministic
 * /proc seams for the HH/RH integration and conformance suites.
 *
 * Why seams at all (PD22's own rationale): a dev machine runs REAL same-uid `comm=pi`
 * processes (the user's live pi sessions), and the occupancy check treats every unaccounted
 * pi candidate as "session might be open" ⇒ forced fork. Worse, P-scan's SYNC re-prove walks
 * the whole real /proc through an unseamable-by-default reader — on a saturated CI farm
 * (hundreds of parallel node/pi processes) either its own 50 ms budget trips (`proc-partial`)
 * or a foreign pid born mid-scan reads as `new-process`; both surface as environmental 409s
 * on POSTs that should be 202 (the exact HH2/HH9/HH10b flake). Both /proc views are therefore
 * seam-scoped to the pids a test explicitly names (`allowPi` ∪ `commOverride` keys):
 *
 *  - the ASYNC prove scan sees the named pids with real stats, with any per-pid comm
 *    OVERRIDE applied (HH9b: prove must see pid P as harmless `bash`);
 *  - the SYNC re-prove scan sees the SAME named-pid set, but with REAL, un-overridden stats —
 *    so HH9b's real reuse detection (token says `bash`, sync re-stat says `node`) still fires,
 *    while foreign pids can never appear in either world.
 *
 * Mutate the live `allowPi` Set as tests spawn/kill processes — both halves read it per call.
 * `main.ts` sets none of this; no env/config can reach it (PD22 — pinned by
 * tests/web-hub/hub/hub-history-assembly.test.ts).
 */
import { readFileSync, statSync } from "node:fs";
import { readFile, stat as fspStat } from "node:fs/promises";
import type { ProcFs, ProcSyncFs } from "../../../src/web-hub/hub/spawn/history/proc.js";

export interface HistoryProcSeamOptions {
  /** pids visible to BOTH /proc views (test-spawned fake pi children, --title-only samples,
   *  RH4's foreign sample, HH9b's comm-fabricated process). */
  allowPi?: Set<number>;
  /** Per-pid comm override applied to the ASYNC prove scan's stat reads ONLY (HH9b: prove
   *  must see pid P as something harmless while the sync re-stat sees its real comm). */
  commOverride?: Map<number, string>;
}

/** `/proc/<pid>/stat`'s comm field: between the first "(" and the LAST ")". */
export function commOfStat(statLine: string): string {
  const open = statLine.indexOf("(");
  const close = statLine.lastIndexOf(")");
  return open >= 0 && close > open ? statLine.slice(open + 1, close) : "";
}

function withComm(statLine: string, comm: string): string {
  const open = statLine.indexOf("(");
  const close = statLine.lastIndexOf(")");
  if (open < 0 || close <= open) return statLine;
  return `${statLine.slice(0, open)}(${comm})${statLine.slice(close)}`;
}

export interface HistoryProcSeams {
  procFs: Partial<ProcFs>;
  procSyncFs: Partial<ProcSyncFs>;
}
/** The seam pair — pass as `spawnSeams.historyProcFs` / `spawnSeams.historyProcSyncFs`. */
export function createHistoryProcSeam(opts: HistoryProcSeamOptions = {}): HistoryProcSeams {
  const allowPi = opts.allowPi ?? new Set<number>();
  const commOverride = opts.commOverride ?? new Map<number, string>();
  const named = (): Set<number> => new Set<number>([...allowPi, ...commOverride.keys()]);
  const realStat = (pid: number): { uid: number; stat: string } | undefined => {
    try {
      return { uid: statSync(`/proc/${pid}`).uid, stat: readFileSync(`/proc/${pid}/stat`, "utf8") };
    } catch {
      return undefined; // gone — both scans skip vanished pids
    }
  };
  return {
    procFs: {
      async readdirProc(): Promise<string[]> {
        const out: string[] = [];
        for (const pid of named()) {
          if (pid === process.pid) continue; // the in-process hub — excluded by the service anyway
          if (realStat(pid) !== undefined) out.push(String(pid));
        }
        return out;
      },
      statUid: async (pid) => {
        const cached = realStat(pid);
        if (cached !== undefined) return cached.uid;
        return (await fspStat(`/proc/${pid}`)).uid;
      },
      readStat: async (pid) => {
        const cached = realStat(pid);
        if (cached === undefined) return readFile(`/proc/${pid}/stat`, "utf8");
        const fake = commOverride.get(pid);
        return fake === undefined ? cached.stat : withComm(cached.stat, fake);
      },
      readCmdline: (pid) => readFile(`/proc/${pid}/cmdline`, "utf8"),
    },
    procSyncFs: {
      readdirProcSync(): string[] {
        const out: string[] = [];
        for (const pid of named()) {
          if (pid === process.pid) continue;
          if (realStat(pid) !== undefined) out.push(String(pid));
        }
        return out;
      },
      statUidSync: (pid) => {
        const cached = realStat(pid);
        if (cached !== undefined) return cached.uid;
        return statSync(`/proc/${pid}`).uid; // let the real ENOENT propagate (pid => gone)
      },
      readStatSync: (pid) => {
        const cached = realStat(pid);
        if (cached !== undefined) return cached.stat; // REAL comm — overrides never apply here
        return readFileSync(`/proc/${pid}/stat`, "utf8");
      },
    },
  };
}
