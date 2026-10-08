import { spawn } from "node:child_process";

export interface GitRunOptions {
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /**
   * Env policy (worktree-diff plan §2.7). Default (and "inherit") keeps today's
   * behavior byte-for-byte. "minimal" passes ONLY the allowlisted keys to the
   * child; PATH is NOT defaulted here — the caller supplies the fixed constant
   * (WTDIFF_GIT_PATH) via `pathOverride` so this module never imports diff.js.
   */
  envPolicy?: "inherit" | "minimal";
  /** Only honored with envPolicy:"minimal": the fixed PATH for the child env. */
  pathOverride?: string;
  /**
   * Three pinned directory fds mapped to child fds 3/4/5 (worktree, gitdir,
   * commondir). Pinned mode forces cwd:"/" and GIT_COMMON_DIR=/proc/self/fd/5
   * (overriding any inherited/host value) and REQUIRES the argv to start with
   * PINNED_PREFIX — otherwise no process is spawned and spawnError is returned.
   */
  pins?: { wt: number; git: number; common: number };
}

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stdoutCapped: boolean;
  stderr: string;
  killed?: "timeout" | "abort" | "overflow";
  spawnError?: string;
}

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRunResult>;

/**
 * The pinned argv prefix (worktree-diff plan §1.8): every pinned-mode call must
 * start with exactly these four arguments. Mirrored as WT_PINNED_PREFIX in
 * ./diff.js (this module must not import it); tests pin both copies equal.
 */
export const PINNED_PREFIX: readonly string[] = [
  "-C",
  "/proc/self/fd/3",
  "--git-dir=/proc/self/fd/4",
  "--work-tree=/proc/self/fd/3",
];

function hasPinnedPrefix(args: readonly string[]): boolean {
  return args.length >= PINNED_PREFIX.length && PINNED_PREFIX.every((expected, index) => args[index] === expected);
}

function buildMinimalEnv(pathOverride: string | undefined, pinned: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (pathOverride !== undefined) env.PATH = pathOverride;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.XDG_CONFIG_HOME !== undefined) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  env.LC_ALL = "C";
  env.LANG = "C";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  if (pinned) env.GIT_COMMON_DIR = "/proc/self/fd/5";
  return env;
}

interface SpawnedProcess {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnImpl = (file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => SpawnedProcess;

function killGroup(child: SpawnedProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may already have exited, or the platform may not support it.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already be gone.
  }
}

function appendBounded(chunks: Buffer[], size: { value: number }, data: Buffer, cap: number): boolean {
  if (size.value >= cap) return true;
  const remaining = cap - size.value;
  const kept = data.subarray(0, remaining);
  if (kept.length > 0) chunks.push(kept);
  size.value += kept.length;
  return data.length > kept.length;
}

export function createGitRunner(deps: { gitBinary?: string; spawnImpl?: typeof spawn } = {}): GitRunner {
  const binary = deps.gitBinary ?? "git";
  const spawnProcess: SpawnImpl = (deps.spawnImpl ?? spawn) as unknown as SpawnImpl;

  return (args, opts) => {
    if (opts.pins !== undefined && !hasPinnedPrefix(args)) {
      // Pinned mode contract violation: refuse to spawn at all.
      return Promise.resolve({
        code: null,
        stdout: "",
        stdoutCapped: false,
        stderr: "",
        spawnError: "pinned git run requires the argv to start with PINNED_PREFIX",
      });
    }
    return new Promise<GitRunResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutSize = { value: 0 };
      const stderrSize = { value: 0 };
      const stderrCap = opts.maxStderrBytes ?? 8 * 1024;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      let killed: GitRunResult["killed"];

      const finish = (result: GitRunResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (abortListener !== undefined) opts.signal?.removeEventListener("abort", abortListener);
        resolve(result);
      };

      let child: SpawnedProcess;
      try {
        const pins = opts.pins;
        const pinned = pins !== undefined;
        const env: NodeJS.ProcessEnv =
          opts.envPolicy === "minimal"
            ? buildMinimalEnv(opts.pathOverride, pinned)
            : {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
                LC_ALL: "C",
                ...(pinned ? { GIT_COMMON_DIR: "/proc/self/fd/5" } : {}),
              };
        child = spawnProcess(
          binary,
          ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
          {
            cwd: pinned ? "/" : opts.cwd,
            env,
            shell: false,
            detached: true,
            stdio: pinned ? ["ignore", "pipe", "pipe", pins.wt, pins.git, pins.common] : ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        finish({
          code: null,
          stdout: "",
          stdoutCapped: false,
          stderr: "",
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const settleKilled = (reason: NonNullable<GitRunResult["killed"]>): void => {
        if (settled) return;
        killed = reason;
        killGroup(child);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        finish({
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stdoutCapped: reason === "overflow",
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          killed,
        });
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (appendBounded(stdoutChunks, stdoutSize, data, opts.maxStdoutBytes)) settleKilled("overflow");
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        appendBounded(stderrChunks, stderrSize, data, stderrCap);
      });
      child.once("error", (error: unknown) => {
        if (!settled) {
          finish({
            code: null,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stdoutCapped: false,
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            spawnError: error instanceof Error ? error.message : String(error),
          });
        }
      });
      child.once("close", (...args: unknown[]) => {
        if (settled) return;
        const code = typeof args[0] === "number" ? args[0] : null;
        finish({
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stdoutCapped: false,
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });

      timer = setTimeout(() => settleKilled("timeout"), Math.max(0, opts.timeoutMs));
      timer.unref();
      if (opts.signal !== undefined) {
        abortListener = () => settleKilled("abort");
        if (opts.signal.aborted) abortListener();
        else opts.signal.addEventListener("abort", abortListener, { once: true });
      }
    });
  };
}
