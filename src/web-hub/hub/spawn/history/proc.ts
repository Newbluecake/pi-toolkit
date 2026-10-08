/**
 * web-hub session-history plan §4.5.5 (`proc.ts`): the `/proc` scan primitives — `scanAsync`
 * (bounded, classifies same-uid `pi`/`node*` candidates via `cmdline`, §14.1's C3) and
 * `rescanSync` (fully synchronous full re-stat against a previous token's pid picture — the
 * "evidence #1" PID-reuse closing move: no diffing, no `cmdline` reads, just compare starttime/
 * uid/comm per pid, old and new).
 *
 * `ProcFs`/`ProcSyncFs` are injectable (fake procFs test doubles drive two programmable pid
 * tables) — this is the ONLY module that talks to `/proc`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseCmdline, parseStartTicks } from "../../../protocol/proc-identity.js";
import type { ProcScanToken, ProcSeen } from "./ports.js";
import { PROC_CALL_MS, PROC_SCAN_BUDGET_MS, PROC_SCAN_PID_MAX, PROC_SYNC_MS } from "./budget.js";

export interface ProcFs {
  readdirProc(): Promise<string[]>;
  statUid(pid: number): Promise<number>;
  readStat(pid: number): Promise<string>;
  readCmdline(pid: number): Promise<string>;
}

export interface ProcSyncFs {
  readdirProcSync(): string[];
  statUidSync(pid: number): number;
  readStatSync(pid: number): string;
}

export function defaultProcFs(): ProcFs {
  return {
    readdirProc: () => readdir("/proc"),
    statUid: async (pid) => (await stat(`/proc/${String(pid)}`)).uid,
    readStat: (pid) => readFile(`/proc/${String(pid)}/stat`, "utf8"),
    readCmdline: (pid) => readFile(`/proc/${String(pid)}/cmdline`, "utf8"),
  };
}

export function defaultProcSyncFs(): ProcSyncFs {
  return {
    readdirProcSync: () => readdirSync("/proc"),
    statUidSync: (pid) => statSync(`/proc/${String(pid)}`).uid,
    readStatSync: (pid) => readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
  };
}

function isGoneErr(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = err.code;
  return code === "ENOENT" || code === "ESRCH" || code === "ENOTDIR";
}

/** Finding 5 fix: bound a single per-pid async call to `PROC_CALL_MS`, independent of the
 * overall scan budget — a timeout surfaces as a plain rejection (handled identically to a real
 * fs error by every caller below: a non-"gone" failure already fails that pid/scan closed). */
function raceProcCall<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("proc-call-timeout")), PROC_CALL_MS);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** Field 1 (comm) of `/proc/<pid>/stat`: between the FIRST `(` and the LAST `)` — comm itself
 * may contain `)`. */
function parseComm(stat: string): string | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  return stat.slice(open + 1, close);
}

/** Field 3 (state), the first token after `(comm)`. */
function parseState(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return rest[0];
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

/** E4's candidate rule: `comm === "pi"`, or `comm` starts with `node` AND `cmdline`'s argv[1]
 * is `pi` by basename or ends with `/pi-coding-agent/dist/cli.js`. */
function isPiArgv1(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  return basenameOf(argv1) === "pi" || argv1.endsWith("/pi-coding-agent/dist/cli.js");
}

export interface ProcScanDeps {
  procFs: ProcFs;
  uid: number;
  hubPid: number;
  now(): number;
  /** default `PROC_SCAN_BUDGET_MS`; tests only. */
  budgetMs?: number;
}

/** §4.5.5 step 4: bounded async scan of EVERY `/proc/<pid>`, any uid. Never rejects —
 * `complete:false` on any budget/cap/unreadable-same-uid-entry condition. */
export async function scanAsync(deps: ProcScanDeps): Promise<ProcScanToken> {
  const start = deps.now();
  const budget = deps.budgetMs ?? PROC_SCAN_BUDGET_MS;
  const pids = new Map<number, ProcSeen>();
  if (budget <= 0) return { at: deps.now(), complete: false, pids };
  let names: string[];
  try {
    // Verifier round 3 (defect 3a): the readdir itself was a bare await — bound it with the
    // same per-call race as every per-pid call; a hang fails closed (scan partial ⇒ the
    // proof is never free).
    names = await raceProcCall(deps.procFs.readdirProc());
  } catch {
    return { at: deps.now(), complete: false, pids };
  }
  const numericPids: number[] = [];
  for (const n of names) {
    if (/^[0-9]+$/.test(n)) numericPids.push(Number(n));
  }
  if (numericPids.length > PROC_SCAN_PID_MAX) {
    return { at: deps.now(), complete: false, pids };
  }
  for (const pid of numericPids) {
    if (deps.now() - start > budget) return { at: deps.now(), complete: false, pids };
    let uidVal: number;
    try {
      uidVal = await raceProcCall(deps.procFs.statUid(pid));
    } catch (err) {
      if (isGoneErr(err)) continue;
      return { at: deps.now(), complete: false, pids }; // can't establish ownership — fail closed
    }
    let statStr: string;
    try {
      statStr = await raceProcCall(deps.procFs.readStat(pid));
    } catch (err) {
      if (isGoneErr(err)) continue;
      if (uidVal === deps.uid) return { at: deps.now(), complete: false, pids };
      pids.set(pid, { startTicks: -1, uid: uidVal, comm: "", cls: "other" });
      continue;
    }
    const comm = parseComm(statStr);
    const state = parseState(statStr);
    const startTicks = parseStartTicks(statStr) ?? -1;
    let cls: ProcSeen["cls"] = "other";
    const candidateEligible = pid !== deps.hubPid && uidVal === deps.uid && state !== "Z" && state !== "X";
    if (candidateEligible && comm === "pi") {
      cls = "pi";
    } else if (candidateEligible && comm !== undefined && comm.startsWith("node")) {
      let argv1: string | undefined;
      let cmdlineReadOk = true;
      try {
        argv1 = parseCmdline(await raceProcCall(deps.procFs.readCmdline(pid)))[1];
      } catch {
        argv1 = undefined;
        cmdlineReadOk = false;
      }
      // Finding 7a fix: a readCmdline() ERROR (timeout included) must fail CLOSED —
      // `occupancy.ts`'s prove() loop skips anything with `cls !== "pi"` entirely, so an
      // unreadable same-uid node* process must never be silently waved through as
      // "node-other" ("definitely not pi"). `ProcSeen.cls` is frozen to exactly
      // "pi"|"node-other"|"other" (ports.ts) — "pi" is the only available fail-closed encoding
      // without touching that frozen file. A SUCCESSFUL read whose argv1 genuinely doesn't
      // look like pi is still confidently "node-other" (unchanged).
      cls = cmdlineReadOk ? (isPiArgv1(argv1) ? "pi" : "node-other") : "pi";
    }
    pids.set(pid, { startTicks, uid: uidVal, comm: comm ?? "", cls });
  }
  return { at: deps.now(), complete: true, pids };
}

export interface ProcRescanDeps {
  procFs: ProcSyncFs;
  uid: number;
  hubPid: number;
  now(): number;
  /** default `PROC_SYNC_MS`; tests only. */
  budgetMs?: number;
}

export type ProcRescanVerdict = { ok: true } | { gap: "proc-partial" } | { gap: "new-process"; pid: number };

/** §4.5.5 step 2 (`reprove`'s sync half): full re-stat, zero `cmdline` reads (D-state processes
 * hold the mmap lock `cmdline` needs). `token.complete` MUST be true — the caller
 * (`occupancy.ts::reprove`) never calls this otherwise. */
export function rescanSync(token: ProcScanToken, deps: ProcRescanDeps): ProcRescanVerdict {
  const start = deps.now();
  const budget = deps.budgetMs ?? PROC_SYNC_MS;
  let names: string[];
  try {
    names = deps.procFs.readdirProcSync();
  } catch {
    return { gap: "proc-partial" };
  }
  const numericPids: number[] = [];
  for (const n of names) {
    if (/^[0-9]+$/.test(n)) numericPids.push(Number(n));
  }
  if (numericPids.length > PROC_SCAN_PID_MAX) return { gap: "proc-partial" };
  for (const pid of numericPids) {
    if (deps.now() - start > budget) return { gap: "proc-partial" };
    let uidVal: number;
    try {
      uidVal = deps.procFs.statUidSync(pid);
    } catch (err) {
      if (isGoneErr(err)) continue;
      if (token.pids.get(pid)?.uid === deps.uid) return { gap: "proc-partial" };
      continue;
    }
    let statStr: string;
    try {
      statStr = deps.procFs.readStatSync(pid);
    } catch (err) {
      if (isGoneErr(err)) continue;
      if (uidVal === deps.uid) return { gap: "proc-partial" };
      continue;
    }
    const comm = parseComm(statStr);
    const state = parseState(statStr);
    const startTicks = parseStartTicks(statStr) ?? -1;
    const candidateNow = pid !== deps.hubPid && uidVal === deps.uid && state !== "Z" && state !== "X";
    const looksLikeCandidate = candidateNow && (comm === "pi" || (comm !== undefined && comm.startsWith("node")));
    const prev = token.pids.get(pid);
    if (prev === undefined) {
      if (looksLikeCandidate) return { gap: "new-process", pid };
      continue;
    }
    const reused = prev.startTicks !== startTicks || prev.uid !== uidVal || prev.comm !== (comm ?? "");
    if (reused && looksLikeCandidate) return { gap: "new-process", pid };
  }
  return { ok: true };
}
