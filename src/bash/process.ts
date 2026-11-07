import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import type { Millis } from "../core/types.js";
import type { JobRecord } from "./types.js";

/**
 * bash auto-background §3.3 — **the plugin's only `node:child_process`
 * boundary**.
 *
 * Everything process-shaped lives behind `ProcessPort` so `BashJobManager`
 * (S4) can be unit-tested against a fake: spawning a detached process-group
 * leader, the TERM → grace → KILL termination ladder, liveness probing and the
 * pid-reuse guard used when adopting jobs after a pi restart.
 *
 * Layering rules for this file:
 * - no pi imports (the spawn semantics of pi's `createLocalShellOperations`,
 *   `dist/core/tools/bash.js:38-114`, are replicated, not imported — pi's
 *   `getShellConfig` / `killProcessTree` / `waitForChildProcess` are not
 *   reachable through the package `exports` map);
 * - no settings import — `shellPath` / `graceMs` are injected by the caller,
 *   which owns the defaults;
 * - no mutable module-level state (the extension re-activates in-process on
 *   `/reload`);
 * - every timer is `unref()`ed (a ref'd timer wedges `pi -p`).
 *
 * Safety doctrine (§3.3, §11): when identity cannot be established we report
 * "unsafe" and the caller marks the job `orphaned` — **we would rather leak a
 * process than signal an unrelated one**.
 */

export type DrainStop = "ended" | "idle" | "capped" | "error";

export interface JobExit {
  /** `null` when the child was terminated by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** A post-spawn `error` event, surfaced instead of rejecting. */
  readonly error?: Error;
}

export interface DrainedResult {
  /** The same frozen object resolved by `processExitPromise`. */
  readonly exit: JobExit;
  readonly stop: DrainStop;
}

/** Result of a spawn. `stdout`/`stderr` are live pipes; attach listeners immediately. */
export interface SpawnedJob {
  readonly pid: number;
  /** POSIX `detached` makes the child its own group leader, so this equals `pid`. */
  readonly pgid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Exit/close first event settles; never rejects. */
  readonly processExitPromise: Promise<JobExit>;
  /** Bounded pipe drain settles after end/idle/cap/error; never rejects. */
  readonly drainedPromise: Promise<DrainedResult>;
  /** `/proc/<pid>/stat` field 22 — Linux best-effort pid-reuse guard. */
  readonly procStartTime?: string;
  /**
   * Issue #73 (plan A+): `true` when the **child tree writes the log file
   * itself** (file-fd stdio) and `stdout` is a tail reader over that same
   * file. The manager must then never write log *data* a second time — only
   * its own footer / truncation notices (O_APPEND keeps them ordered).
   * `false` for the classic pipe tee.
   */
  readonly logWrittenByChild: boolean;
  /** Absolute path of the wrapper's exit-code file (`<jobId>.exit`), file-fd mode only. */
  readonly exitFilePath?: string;
}

/**
 * Issue #73: per-job stdio topology. Present ⇒ the job's log is a plain file
 * the child tree writes itself, the exit code is persisted by the wrapper, and
 * `pid` is the outer `/bin/sh` (the group leader). Absent ⇒ the classic pipe
 * tee (`createProcessPort` v1 semantics, kept for `tests/bash/process.test.ts`
 * and any caller that wants plain pipes).
 */
export interface JobStdioOptions {
  /** Absolute log path; opened `a`, mode 0o600, becomes the child's stdout+stderr. */
  logPath: string;
  /** Absolute exit-code path the wrapper writes (`tmp` + rename). */
  exitPath: string;
  /** Hard cap on log bytes the wrapper enforces with `head -c`; `<= 0` means no cap. */
  maxLogBytes: number;
}

export type KillOutcome =
  /** The process group was already empty (ESRCH on `kill(-pgid, 0)`) — `killJobTree` is idempotent. */
  | "already-dead"
  /** The whole group (leader AND members) emptied within the grace window after SIGTERM. */
  | "terminated"
  /** Some group member (even with the leader already dead) outlived the grace window and the group was SIGKILLed. */
  | "killed"
  /** Identity/group checks failed; nothing was signalled (§3.3 safety floor). */
  | "refused";

export interface KillJobTreeOptions {
  /** SIGTERM → SIGKILL escalation window. Defaults to the port's `graceMs`. */
  graceMs?: Millis;
  /** When given, a readable-but-different `/proc` starttime refuses the kill. */
  expectedProcStartTime?: string;
}

/** "alive" = ours and running, "dead" = certainly gone, "unsafe" = unverifiable. */
export type PidOwnership = "alive" | "dead" | "unsafe";

/**
 * The identity fields a `JobRecord` carries for the reuse guard — a
 * `JobRecord` is structurally assignable, so callers pass records directly.
 */
export type PidIdentity = Pick<JobRecord, "pid" | "procStartTime" | "spawnedAt">;

export interface ProcessPort {
  /**
   * Spawn `command` through the resolved shell as a detached process-group
   * leader. Resolves on the `spawn` event (so `pid` is real), rejects with the
   * spawn error (ENOENT, missing `cwd`, …) — the caller maps that to
   * `staged → failed`.
   *
   * `stdio` (issue #73) switches the job's I/O topology: with it the log is a
   * file the child tree writes itself and `pid` is the outer `/bin/sh`
   * wrapper; without it the child streams into pipes exactly as before.
   */
  spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv, stdio?: JobStdioOptions): Promise<SpawnedJob>;
  /** TERM → grace → KILL on the whole process group. Idempotent. */
  killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome>;
  /** `kill(pid, 0)` liveness probe; EPERM counts as alive. */
  probePid(pid: number): boolean;
  /** Linux-only best-effort `/proc/<pid>/stat` field 22. */
  readProcStartTime(pid: number): string | undefined;
  /** Pid-reuse guard used by `recover()` (§3.6). */
  checkPidOwnership(identity: PidIdentity): PidOwnership;
}

export interface ProcessPortOptions {
  /** Explicit shell (`settings.bashJobs.shellPath`). Wins over pi's `shellPath`. */
  shellPath?: string;
  /**
   * pi's own `shellPath` setting (`~`-expanded, project over global — read
   * through pi's `SettingsManager` by the pi-facing callers). Consulted after
   * the explicit one. 2026-10-17 revision: `$SHELL` is no longer consulted —
   * pi's built-in bash tool never reads it either, and `$SHELL=/bin/zsh` made
   * model-written bash syntax run under zsh.
   */
  piShellPath?: string;
  /** Default SIGTERM → SIGKILL window. */
  graceMs?: Millis;
  /** Liveness poll cadence inside the grace window. */
  killPollMs?: Millis;
  /** Hard cap on post-exit pipe draining; defaults to 30 seconds. */
  drainTimeoutMs?: Millis;
  /** Diagnostic sink; defaults to `console.warn` with the project prefix. */
  warn?: (message: string) => void;
}
export interface ShellConfig {
  readonly shell: string;
  readonly args: readonly string[];
}

/** §3.3 + 2026-10-17 revision: only these basenames are honoured for the
 * EXPLICIT settings paths (`bashJobs.shellPath`, pi's own `shellPath`); all
 * take `-c`. `$SHELL` is no longer consulted. */
export const ALLOWED_SHELL_BASENAMES: ReadonlySet<string> = new Set(["bash", "zsh", "sh"]);

export const DEFAULT_KILL_GRACE_MS = 2_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_POLL_MS = 50;
/**
 * Exit and drain are decoupled: drain semantics mirror pi#5303, but are bounded.
 */
const EXIT_STDIO_GRACE_MS = 100;

/** Injectable probes for `defaultShellConfig`, so the ladder is unit-testable. */
export interface DefaultShellDeps {
  exists?: (path: string) => boolean;
  which?: (executable: string) => string | undefined;
}

/** `allowedShell`: non-empty AND basename ∈ `ALLOWED_SHELL_BASENAMES`. */
function allowedShell(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate.trim().length === 0) return undefined;
  return ALLOWED_SHELL_BASENAMES.has(basename(candidate)) ? candidate : undefined;
}

/**
 * pi's own default chain, mirrored from `getShellConfig`'s Unix branch
 * (`dist/utils/shell.js`): `/bin/bash` (existsSync) → `bash` on PATH
 * (`which bash`) → `sh`. Re-resolved per spawn, exactly like pi's
 * `createLocalShellOperations` re-runs `getShellConfig` on every exec. The
 * win32 branch (Git Bash probing) is unreachable — the whole bash feature is
 * POSIX-only (`bashJobsEnabled`).
 */
export function defaultShellConfig(deps: DefaultShellDeps = {}): ShellConfig {
  const exists = deps.exists ?? ((path: string) => existsSync(path));
  const which = deps.which ?? whichExecutable;
  if (exists("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const bashOnPath = which("bash");
  if (bashOnPath !== undefined) return { shell: bashOnPath, args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

/** pi's `findExecutableOnPath`, Unix branch, replicated (bounded `which`). */
function whichExecutable(executable: string): string | undefined {
  try {
    const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5_000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {
    /* ignore — mirrors pi */
  }
  return undefined;
}

/**
 * Resolve the shell (2026-10-17 revision, mirrors pi's built-in bash tool):
 * explicit `bashJobs.shellPath` → pi's own `shellPath` setting → pi's default
 * chain (`defaultShellConfig`). Both explicit settings paths go through the
 * basename allow-list, so exotic shells (fish, nushell) fall through to the
 * next step instead of being used with `-c` (the tool is named `bash`; bash
 * semantics are the contract — an explicit zsh path is still allowed).
 * `$SHELL` is deliberately NOT consulted (user report: `$SHELL=/bin/zsh` ran
 * model-written bash syntax under zsh — `no matches found`, array/
 * word-splitting differences — while pi's own bash tool defaults to bash).
 *
 * Divergence from pi's `getShellConfig`, kept deliberately: pi checks
 * `existsSync` on a custom `shellPath` and THROWS when missing; we fail
 * softer — a missing-but-allow-listed path surfaces as the spawn's own
 * ENOENT error (`staged → failed`), never a broken session. The explicit
 * ladder above the default chain is pure, so it stays directly testable.
 */
export function resolveShell(shellPath?: string, piShellPath?: string): ShellConfig {
  const explicit = allowedShell(shellPath);
  if (explicit !== undefined) return { shell: explicit, args: ["-c"] };
  const fromPi = allowedShell(piShellPath);
  if (fromPi !== undefined) return { shell: fromPi, args: ["-c"] };
  return defaultShellConfig();
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Fields of `/proc/<pid>/stat` from field 3 on (the `comm` field may contain spaces). */
function readProcStatFields(pid: number): string[] | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return fields.length > 0 ? fields : undefined;
}

/** `stat` field 22 (starttime) → index 19 once fields 1-2 (`pid (comm)`) are dropped. */
const STAT_INDEX_STARTTIME = 19;
/** `stat` field 5 (pgrp). */
const STAT_INDEX_PGRP = 2;

export function readProcStartTime(pid: number): string | undefined {
  const value = readProcStatFields(pid)?.[STAT_INDEX_STARTTIME];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readProcGroup(pid: number): number | undefined {
  const value = readProcStatFields(pid)?.[STAT_INDEX_PGRP];
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function probePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user — alive, not ours.
    return errnoOf(error) === "EPERM";
  }
}

/** Clock skew slack for the boot-time fallback; never shrink identity checks to the wire. */
const BOOT_TIME_SLACK_MS = 60_000;

function bootTimeMs(): Millis {
  return Date.now() - uptime() * 1000;
}

/**
 * §3.3 pid-reuse guard. Linux: the recorded `/proc` starttime must match.
 * Elsewhere (or when `/proc` is unreadable) the only certain negative is a
 * reboot since the spawn; anything else is `"unsafe"` → caller marks the job
 * `orphaned` and never kills.
 */
export function checkPidOwnership(identity: PidIdentity): PidOwnership {
  const { pid } = identity;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return "dead";
  if (!probePid(pid)) return "dead";
  const current = readProcStartTime(pid);
  if (identity.procStartTime !== undefined && current !== undefined) {
    // A different starttime means the pid was recycled: our process is gone
    // for certain, and reporting "dead" is safe because dead never kills.
    return current === identity.procStartTime ? "alive" : "dead";
  }
  if (identity.spawnedAt !== undefined && identity.spawnedAt + BOOT_TIME_SLACK_MS < bootTimeMs()) {
    return "dead";
  }
  return "unsafe";
}

function sleepUnref(ms: Millis): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Is the process group still non-empty? `kill(-pgid, 0)`: ESRCH ⇒ empty;
 * EPERM ⇒ non-empty (exists but not signalable — unreachable here since jobs
 * are spawned by our own uid; the follow-up SIGKILL would hit EPERM as well and
 * the outcome still reports "killed"). win32 has no groups: degrade to probePid.
 * Linux guarantees a pgid cannot be reused while any member lives, so a
 * non-empty group is provably ours once the starttime/pgrp guards passed.
 */
function groupAlive(pgid: number): boolean {
  if (!isPosix()) return probePid(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

/** `false` on ESRCH (already dead); `true` otherwise (EPERM counts as alive). */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative pid = whole process group, so `sleep 60 & wait` descendants die
    // with the shell. Non-POSIX has no groups: fall back to the pid itself.
    process.kill(isPosix() ? -pid : pid, signal);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

/**
 * Exit/drain watcher. The first exit or close event freezes the result and
 * settles processExitPromise; pipe draining continues independently.
 *
 * Issue #73: the streams are injectable. With file-fd stdio there are no pipes
 * — `stdout` is a tail reader over the log file and `stderr` is an inert empty
 * stream — so `child.stdout`/`child.stderr` are `null` and the `close` event
 * must NOT be read as "both streams ended" (it fires with `exit`, before the
 * tail has finished reading). `opts.streams` + `opts.closeEndsStreams: false`
 * express exactly that; the default reproduces the pipe behaviour byte for
 * byte.
 */
export function watchChild(
  child: ChildProcess,
  drainTimeoutMs: Millis,
  opts: { streams?: { stdout: Readable | null; stderr: Readable | null }; closeEndsStreams?: boolean } = {},
): {
  processExitPromise: Promise<JobExit>;
  drainedPromise: Promise<DrainedResult>;
} {
  const stdout = opts.streams ? opts.streams.stdout : child.stdout;
  const stderr = opts.streams ? opts.streams.stderr : child.stderr;
  const closeEndsStreams = opts.closeEndsStreams ?? true;
  let resultCaptured = false;
  let exited = false;
  let stdoutEnded = stdout === null;
  let stderrEnded = stderr === null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: (exit: JobExit) => void;
  let resolveDrained!: (result: DrainedResult) => void;
  const processExitPromise = new Promise<JobExit>((resolve) => {
    resolveExit = resolve;
  });
  const drainedPromise = new Promise<DrainedResult>((resolve) => {
    resolveDrained = resolve;
  });

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (capTimer) clearTimeout(capTimer);
    idleTimer = undefined;
    capTimer = undefined;
  };
  const cleanup = (): void => {
    clearTimers();
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    stdout?.removeListener("end", onStdoutEnd);
    stderr?.removeListener("end", onStderrEnd);
    stdout?.removeListener("data", onData);
    stderr?.removeListener("data", onData);
  };
  const finishDrain = (stop: DrainStop): void => {
    cleanup();
    stdout?.destroy();
    stderr?.destroy();
    resolveDrained({ exit: exitResult, stop });
  };
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishDrain("idle"), EXIT_STDIO_GRACE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  };
  let exitResult: JobExit = Object.freeze({ exitCode: null, signal: null });
  const maybeEnd = (): void => {
    if (exited && stdoutEnded && stderrEnded) finishDrain("ended");
  };
  const captureExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (resultCaptured) return;
    resultCaptured = true;
    exited = true;
    exitResult = Object.freeze({ exitCode: code, signal });
    resolveExit(exitResult);
    maybeEnd();
    if (!stdoutEnded || !stderrEnded) {
      // Issue #73: a file tail must never be cut 100ms after exit. The bytes
      // are already on disk; the reader only has to walk them, so ending is
      // its own business (first EOF after exit, or the cap).
      // The absolute `drainTimeoutMs` bound below still guarantees no wedge.
      if (closeEndsStreams) armIdleTimer();
      // The cap arms exactly once and is never re-armed: it is the absolute
      // bound that keeps a perpetually chatty detached descendant from
      // wedging the event loop (the idle timer alone would defer forever).
      capTimer = setTimeout(() => finishDrain("capped"), Math.max(0, drainTimeoutMs));
      (capTimer as { unref?: () => void }).unref?.();
    }
  };
  const onStdoutEnd = (): void => {
    stdoutEnded = true;
    maybeEnd();
  };
  const onStderrEnd = (): void => {
    stderrEnded = true;
    maybeEnd();
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => captureExit(code, signal);
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closeEndsStreams) {
      stdoutEnded = true;
      stderrEnded = true;
    }
    captureExit(code, signal);
    maybeEnd();
  };
  /**
   * Post-exit output re-arms the *idle* cutoff only (pi#5303: a descendant
   * still flushing its tail must not be truncated mid-write), and never
   * touches the absolute cap. Without this re-arm the idle timer fires 100ms
   * after exit unconditionally and the cap is dead code for any
   * `drainTimeoutMs` >= EXIT_STDIO_GRACE_MS.
   */
  const onData = (): void => {
    // File-fd mode: the tail's own quiet window is the only ending rule (see
    // `createLogTail`); re-arming the 100ms pipe cutoff here would truncate it
    // the moment a byte arrives after exit.
    if (resultCaptured && closeEndsStreams) armIdleTimer();
  };
  const onError = (error: Error): void => {
    if (resultCaptured) return;
    resultCaptured = true;
    exited = true;
    exitResult = Object.freeze({ exitCode: null, signal: null, error });
    resolveExit(exitResult);
    finishDrain("error");
  };

  stdout?.once("end", onStdoutEnd);
  stderr?.once("end", onStderrEnd);
  stdout?.on("data", onData);
  stderr?.on("data", onData);
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);
  return { processExitPromise, drainedPromise };
}

/**
 * Issue #73 (plan A+, `/tmp/i73/report.md` §6.1): the outer `/bin/sh` job
 * wrapper. `$0` is `_`, `$1` the user command, `$2` the exit file, `$3` the
 * block cap, `$4` the resolved shell and `$5` the exit file's directory —
 * **the command is passed as a positional parameter, never interpolated**, so
 * nothing the model writes can escape into wrapper syntax.
 *
 *  1. run the command in `$4 -c` and remember `$?`;
 *  2. write that code to `$2.tmp` then `mv` it onto `$2` — atomic, so a
 *     concurrent reader never sees a half-written number. `mkdir -p "$5"`
 *     runs immediately before the write because the directory can be swept
 *     while the job runs (a fork/handoff moves the log and GCs the old
 *     session directory), and a missing one would silently cost the code;
 *  3. merge stderr into stdout and funnel it through `dd bs=512 count=$3` +
 *     `cat >/dev/null`: the cap is enforced **inside the job tree**, and once
 *     the cap is hit the pipe keeps being drained, so the command never gets
 *     SIGPIPE and keeps running (§3.3 "写满后进程继续跑" semantics). `dd`
 *     (not `head -c`) because GNU `head` buffers a whole 8KiB block before
 *     writing, which would make a running job's log unreadable until it had
 *     produced that much — `dd` writes every block it copies;
 *  4. `exit` with the code read back from the file, so the `exit` event's code
 *     and the persisted file always agree while pi is alive.
 *
 * Everything here only touches the job's own files and its own pipe: nothing
 * outlives the job if pi exits, which is the whole point (the v1 pipe tee died
 * with SIGPIPE the moment pi's read end closed).
 */
export const JOB_WRAPPER =
  '{ "$4" -c "$1"; c=$?; mkdir -p "$5" 2>/dev/null; ' +
  'printf "%s\\n" "$c" > "$2.tmp" && mv "$2.tmp" "$2"; } 2>&1 ' +
  '| { dd bs=512 count="$3" 2>/dev/null; cat >/dev/null; }; IFS= read -r c < "$2"; exit "${c:-1}"';

/**
 * Degraded wrapper for hosts without `dd`/`cat` (R5): same exit-code
 * contract, **no byte cap** — the log fd is used directly. Reached only when
 * the capability probe below fails; the manager still sees
 * `logWrittenByChild: true` and applies its own (weaker) bookkeeping.
 */
export const JOB_WRAPPER_UNCAPPED =
  '{ "$4" -c "$1"; c=$?; mkdir -p "$5" 2>/dev/null; ' +
  'printf "%s\\n" "$c" > "$2.tmp" && mv "$2.tmp" "$2"; } 2>&1; IFS= read -r c < "$2"; exit "${c:-1}"';

/**
 * Read the wrapper's exit-code file (`<jobId>.exit`). `undefined` means "no
 * authoritative code": file missing (job killed/SIGKILLed before the wrapper
 * could write it, or still running), unreadable, empty, or not an integer.
 * Never throws — this is a recovery-path read and must stay total.
 */
export function readJobExitFile(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const first = text.split("\n", 1)[0]?.trim();
  if (first === undefined || !/^-?\d+$/.test(first)) return undefined;
  const parsed = Number.parseInt(first, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : undefined;
}

/**
 * Block size of the wrapper's `dd` cap. Two consequences, both deliberate:
 * `dd` writes each block as it arrives (a `head -c` would buffer 8KiB and make
 * a live job's log unreadable until it filled one), and the log may overshoot
 * `maxLogBytes` by at most one block — the truncation witness (a body of
 * exactly `maxLogBytes` bytes can only be told apart from a capped one when
 * `maxLogBytes` is not a multiple of this).
 */
export const LOG_CAP_BLOCK_BYTES = 512;
/** The wrapper copies one block more than the cap needs, so a capped log is detectable. */
export const LOG_CAP_OVERSHOOT_BYTES = 1;

/** Tail-reader tunables (issue #73). Exported for tests, not for callers. */
export const LOG_TAIL_POLL_MS = 50;
export const LOG_TAIL_IDLE_POLL_MS = 250;
export const LOG_TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Issue #73: a `Readable` that tails the job's log file from byte 0.
 *
 * Why a file tail instead of a pipe: with file-fd stdio the child tree writes
 * the log itself, so pi has nothing to read from — and nothing to lose when pi
 * exits. The tail only restores the *streaming* half of the old contract
 * (`onData` relay, the tool layer's foreground output).
 *
 * Ending rules (all timers `unref()`ed, one per job):
 * - `maxBytes` reached → stop reading (the cap is the wrapper's `dd`; the
 *   manager turns this into the truncation notice + `truncated` flag);
 * - process exited and a read hit EOF → `push(null)`, **immediately**. No
 *   quiet window is needed: the outer `sh` only exits after its `dd | cat`
 *   pipeline has, and that pipeline only ends once every writer of the job's
 *   merged output closed — so at `exit` the file is already final. (Without the
 *   capping pipeline — the no-`dd` degraded wrapper — a stray descendant could
 *   still write; that is best effort, R7.) The `exit` event also *wakes* the
 *   poll, so a short command does not wait out an idle-poll interval;
 * - `destroy()` → timer cleared, fd closed, no further reads.
 *
 * Cost: one `readSync` + one `setTimeout` per job per poll. Idle (running but
 * silent) polls at `LOG_TAIL_IDLE_POLL_MS`, and every successful read keeps the
 * fast cadence, so a chatty job stays at the old ~50ms streaming latency while
 * a quiet one costs 4 wake-ups a second.
 */
export function createLogTail(
  path: string,
  processExited: () => boolean,
  options: {
    maxBytes?: number;
    pollMs?: Millis;
    idlePollMs?: Millis;
    chunkBytes?: number;
    /** Emits `exit` when the process is gone: wakes the poll instead of waiting out the idle interval. */
    wakeOn?: { once(event: "exit", listener: () => void): unknown };
  } = {},
): Readable {
  const pollMs = options.pollMs ?? LOG_TAIL_POLL_MS;
  const idlePollMs = options.idlePollMs ?? LOG_TAIL_IDLE_POLL_MS;
  const chunkBytes = Math.max(1, Math.trunc(options.chunkBytes ?? LOG_TAIL_CHUNK_BYTES));
  const maxBytes = options.maxBytes !== undefined && options.maxBytes > 0 ? Math.trunc(options.maxBytes) : Infinity;

  let fd: number | undefined;
  let offset = 0;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      fd = undefined;
    }
  };

  /**
   * Single-flight latch. `_read()` fires as soon as the consumer attaches a
   * `data` listener, which can land while the timer-armed poll is already
   * scheduled or running; without the latch both read the same offset and
   * every chunk is emitted twice (found live in the #73 integration run).
   */
  let pumping = false;

  const stream = new Readable({
    read() {
      if (destroyed) return;
      // `_read` is called again whenever the consumer drains the buffer.
      if (timer === undefined && !pumping) pump();
    },
    destroy(error, callback) {
      destroyed = true;
      stop();
      callback(error ?? null);
    },
  });

  /** One poll: read what is there, decide whether/when to poll again. */
  const pump = (): void => {
    timer = undefined;
    if (destroyed || pumping) return;
    pumping = true;
    try {
      pumpOnce();
    } finally {
      pumping = false;
    }
  };

  const pumpOnce = (): void => {
    if (destroyed) return;
    if (fd === undefined) {
      try {
        fd = openSync(path, "r");
      } catch {
        // The log file is created before spawn, so a missing file means the job
        // is gone or the directory vanished: nothing to stream once it exited.
        if (processExited()) {
          stream.push(null);
          return;
        }
        arm(idlePollMs);
        return;
      }
    }
    const room = maxBytes === Infinity ? chunkBytes : Math.max(0, Math.min(chunkBytes, maxBytes - offset));
    if (room <= 0) {
      stream.push(null);
      return;
    }
    const buffer = Buffer.allocUnsafe(room);
    let bytesRead = 0;
    try {
      bytesRead = fd === undefined ? 0 : readSync(fd, buffer, 0, room, offset);
    } catch {
      if (processExited()) {
        stream.push(null);
        return;
      }
      arm(idlePollMs);
      return;
    }
    if (bytesRead > 0) {
      offset += bytesRead;
      stream.push(buffer.subarray(0, bytesRead));
      // More may be waiting (a chunk was a full read) or the writer is chatty:
      // stay on the fast cadence; at exit, keep reading until EOF.
      arm(processExited() ? 0 : pollMs);
      return;
    }
    if (processExited()) {
      stream.push(null);
      return;
    }
    arm(idlePollMs);
  };

  const arm = (ms: Millis): void => {
    if (destroyed || timer !== undefined) return;
    timer = setTimeout(pump, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  };

  options.wakeOn?.once("exit", () => {
    if (destroyed) return;
    // Cancel the pending idle wait and poll right away.
    if (timer !== undefined && !pumping) {
      clearTimeout(timer);
      timer = undefined;
    }
    arm(0);
  });
  arm(0);
  return stream;
}

/**
 * Empty stream that ends by itself: the `stderr` slot in file-fd mode.
 *
 * `setImmediate(() => push(null))` instead of `_read() { push(null) }`:
 * `_read` only runs once a consumer reads, and `watchChild`'s "both streams
 * ended" test (`maybeEnd`) can be reached long before that — with a lazy push
 * the drain never settled at all (found live in the #73 integration run).
 * `Readable.from([])` is not a substitute either: it also waits for its first
 * read. An explicit deferred `push(null)` ends the stream for good.
 */
function emptyStream(): Readable {
  const stream = new Readable({ read() {} });
  // `null` on the next turn, whether or not anybody reads: `watchChild` treats
  // "stderr ended" as half of its settle condition and never reads stderr in
  // this mode, so a `push(null)` from `_read` would never happen.
  setImmediate(() => {
    if (!stream.destroyed) stream.push(null);
  });
  return stream;
}

/**
 * R5 capability probe for the capping wrapper: `dd` and `cat` must exist.
 * Cached per port instance (one `sh` spawn per activation, not per job) and
 * degraded to the uncapped wrapper with a warning rather than refusing to
 * work — a missing `head` must not cost the user their background job.
 */
function hasCapTools(warn: (message: string) => void, cache: { value: boolean | undefined }): boolean {
  if (cache.value !== undefined) return cache.value;
  let ok = false;
  try {
    const result = spawnSync("/bin/sh", ["-c", "command -v dd >/dev/null 2>&1 && command -v cat >/dev/null 2>&1"], {
      timeout: 5_000,
    });
    ok = result.status === 0;
  } catch {
    ok = false;
  }
  cache.value = ok;
  if (!ok) {
    warn(
      "bash auto-background: `dd`/`cat` not found — background job logs are no longer capped " +
        "(the command still runs; only the byte limit is lost)",
    );
  }
  return ok;
}

export function createProcessPort(options: ProcessPortOptions = {}): ProcessPort {
  const graceDefault = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = options.killPollMs ?? DEFAULT_KILL_POLL_MS;
  const warn = options.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  /** Per-port latch for the `head`/`cat` probe (never module scope). */
  const capTools = { value: undefined as boolean | undefined };

  async function spawnJob(
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
    stdio?: JobStdioOptions,
  ): Promise<SpawnedJob> {
    // 2026-10-17 revision: resolved per call from the injected settings
    // (explicit `bashJobs.shellPath` → pi's `shellPath` → pi's default
    // chain); `$SHELL` is no longer consulted.
    const { shell, args } = resolveShell(options.shellPath, options.piShellPath);
    const drainTimeoutMs =
      Number.isFinite(options.drainTimeoutMs) && (options.drainTimeoutMs ?? 0) >= 0
        ? Math.trunc(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
        : DEFAULT_DRAIN_TIMEOUT_MS;

    // Issue #73 (plan A+): file-fd mode. The job's stdio *is* the log file, so
    // a pi exit cannot close it, and the wrapper persists the exit code in the
    // job's own directory. `pid` becomes the outer `/bin/sh` (still the group
    // leader, so `killJobTree` semantics are unchanged).
    if (stdio !== undefined) {
      const cap = Number.isFinite(stdio.maxLogBytes) && stdio.maxLogBytes > 0 ? Math.trunc(stdio.maxLogBytes) : 0;
      const wrapper = cap > 0 && hasCapTools(warn, capTools) ? JOB_WRAPPER : JOB_WRAPPER_UNCAPPED;
      // `dd` copies whole blocks: asking for ceil((cap+1)/bs) blocks lets the
      // file grow just past `cap` (the overshoot witness) while never writing
      // more than one block worth of extra bytes.
      const capBlocks = cap > 0 ? Math.ceil((cap + LOG_CAP_OVERSHOOT_BYTES) / LOG_CAP_BLOCK_BYTES) : 0;
      const capArg = String(capBlocks);
      /** Largest file the wrapper may leave behind. */
      const capFileBytes = capBlocks * LOG_CAP_BLOCK_BYTES;
      // `openSync` before spawn: the fd is inherited (dup'd) by the child, so a
      // missing directory/permission error becomes a spawn-level rejection the
      // manager already maps to `staged → failed`. O_APPEND keeps the child's
      // writes and the manager's footer on one shared offset.
      const logFd = openSync(stdio.logPath, "a", 0o600);
      let child: ChildProcess;
      try {
        child = spawn(
          "/bin/sh",
          ["-c", wrapper, "_", command, stdio.exitPath, capArg, shell, dirname(stdio.exitPath)],
          {
            cwd,
            detached: isPosix(),
            env: env ?? process.env,
            stdio: ["ignore", logFd, logFd],
            windowsHide: true,
          },
        );
      } catch (error) {
        try {
          closeSync(logFd);
        } catch {
          /* ignore */
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
      // The child holds its own duplicate; ours must not leak per spawn.
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }

      let exited = false;
      const exitPromise = child.exitCode !== null || child.signalCode !== null;
      if (exitPromise) exited = true;
      child.once("exit", () => {
        exited = true;
      });
      // One byte past the cap: the wrapper caps the file at `cap`, so a file
      // that holds `cap + 1` bytes proves truncation happened, while a command
      // that produced exactly `cap` bytes reads as "not truncated". Without the
      // overshoot the two are indistinguishable (issue #73 §6.1 item 3).
      const stdout = createLogTail(stdio.logPath, () => exited, {
        wakeOn: child,
        ...(cap > 0 ? { maxBytes: capFileBytes } : {}),
      });
      const stderr = emptyStream();
      const watched = watchChild(child, drainTimeoutMs, { streams: { stdout, stderr }, closeEndsStreams: false });
      void watched.processExitPromise.catch(() => {});
      void watched.drainedPromise.catch(() => {});

      try {
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => {
            child.removeListener("error", onError);
            resolve();
          };
          const onError = (error: Error): void => {
            child.removeListener("spawn", onSpawn);
            reject(error);
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
        });
      } catch (error) {
        stdout.destroy();
        stderr.destroy();
        throw error instanceof Error ? error : new Error(String(error));
      }

      const pid = child.pid;
      if (pid === undefined) {
        stdout.destroy();
        stderr.destroy();
        throw new Error(`failed to spawn /bin/sh wrapper for ${shell}: no pid`);
      }
      const procStartTime = readProcStartTime(pid);
      return {
        pid,
        pgid: readProcGroup(pid) ?? pid,
        stdout,
        stderr,
        processExitPromise: watched.processExitPromise,
        drainedPromise: watched.drainedPromise,
        logWrittenByChild: true,
        exitFilePath: stdio.exitPath,
        ...(procStartTime !== undefined ? { procStartTime } : {}),
      };
    }

    const child = spawn(shell, [...args, command], {
      cwd,
      // POSIX: detached makes the child a process-group leader (pgid === pid),
      // which is what lets `killJobTree` reach its descendants. win32 has no
      // groups (and is out of scope for v1, R6) — mirror pi and stay attached.
      detached: isPosix(),
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Bind the exit watcher before awaiting `spawn` so an immediate exit is
    // never missed, and keep an inert catch on it: the promise may be handed
    // to an owner that only consumes it much later.
    const { processExitPromise, drainedPromise } = watchChild(child, drainTimeoutMs);
    void processExitPromise.catch(() => {});
    void drainedPromise.catch(() => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.removeListener("error", onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.removeListener("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw error instanceof Error ? error : new Error(String(error));
    }

    const pid = child.pid;
    if (pid === undefined || child.stdout === null || child.stderr === null) {
      // Defensive: `spawn` fired, so both hold in practice.
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw new Error(`failed to spawn ${shell}: no pid or stdio pipes`);
    }

    const procStartTime = readProcStartTime(pid);
    return {
      pid,
      pgid: readProcGroup(pid) ?? pid,
      stdout: child.stdout,
      stderr: child.stderr,
      processExitPromise,
      drainedPromise,
      logWrittenByChild: false,
      ...(procStartTime !== undefined ? { procStartTime } : {}),
    };
  }

  async function killJobTree(pid: number, killOptions: KillJobTreeOptions = {}): Promise<KillOutcome> {
    // pid <= 1 would signal "everything we may signal" / init — never.
    if (!Number.isInteger(pid) || pid <= 1) return "refused";

    if (killOptions.expectedProcStartTime !== undefined) {
      const current = readProcStartTime(pid);
      if (current !== undefined && current !== killOptions.expectedProcStartTime) return "refused";
    }
    // Only ever signal a group we own: a non-leader pid means the group id we
    // would target belongs to somebody else (§3.3 / §11 "误杀无关进程").
    const pgrp = readProcGroup(pid);
    if (pgrp !== undefined && pgrp !== pid) return "refused";

    if (!signalGroup(pid, "SIGTERM")) return "already-dead";

    const graceMs = Math.max(0, killOptions.graceMs ?? graceDefault);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await sleepUnref(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      if (!groupAlive(pid)) return "terminated";
    }
    if (!groupAlive(pid)) return "terminated";

    signalGroup(pid, "SIGKILL");
    return "killed";
  }

  return { spawnJob, killJobTree, probePid, readProcStartTime, checkPidOwnership };
}
