/**
 * Process liveness probe shared by hub and agent (acceptance defect #8).
 *
 * `process.kill(pid, 0)` succeeds for a zombie (`<defunct>`: exited, not yet
 * reaped by its parent), so a SIGKILLed pi whose parent is slow to `waitpid`
 * looked alive and the registry fell back to the stale+reap slow path. On
 * Linux the state field of `/proc/<pid>/stat` tells: `Z` (zombie) / `X`
 * (dead) ⇒ not alive. When `/proc` is unreadable (non-Linux, hidepid, the
 * process vanished meanwhile) the `kill(pid, 0)` verdict stands.
 */
import { readFileSync } from "node:fs";

export interface PidAliveDeps {
  /** Default: `process.kill(pid, 0)`. Throws ESRCH (dead) / EPERM (alive, other user). */
  kill?: (pid: number, signal: 0) => void;
  /** Default: `readFileSync("/proc/<pid>/stat", "utf8")`; throwing ⇒ no /proc verdict. */
  readProcStat?: (pid: number) => string;
}

/**
 * State letter from a `/proc/<pid>/stat` line (`pid (comm) S ...`). `comm` may
 * itself contain spaces and parentheses, so the state is the first field after
 * the LAST `)`.
 */
export function procStatState(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const state = stat.slice(close + 1).trimStart()[0];
  return state === undefined || state === "" ? undefined : state;
}

export function pidAlive(pid: number, deps?: PidAliveDeps): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kill = deps?.kill ?? ((p: number, s: 0) => void process.kill(p, s));
  try {
    kill(pid, 0);
  } catch (err) {
    if (errCode(err) !== "EPERM") return false; // ESRCH ⇒ dead
  }
  const read = deps?.readProcStat ?? ((p: number) => readFileSync(`/proc/${p}/stat`, "utf8"));
  let stat: string;
  try {
    stat = read(pid);
  } catch {
    return true; // no /proc (non-Linux / hidepid / raced exit): trust kill(pid, 0)
  }
  const state = procStatState(stat);
  return state !== "Z" && state !== "X" && state !== "x";
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}
