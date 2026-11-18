/**
 * Darwin sysload host — the macOS sampler primitives behind the C0 `SamplerHost` seam
 * (sysload darwin-plan §2.3/§2.4/§3.1-S0). It lives in web-hub/protocol so BOTH the pi-side
 * wiring and the read-only hub can reach it without expanding either import closure
 * (same precedent as sched-identity.ts; boundary-pinned in tests/web-hub/boundary.test.ts).
 * It never imports `sysload/**` — not even type-only: the C0 shapes are consumed
 * structurally (DarwinHost mirrors `SamplerHost` field for field).
 *
 * Subprocess discipline (darwin-plan §2.4, I1/I4/I5):
 * - `runBounded` is ASYNC `execFile` (spawnSync would block the event loop): absolute
 *   binaries, fixed env (no inheritance), `killSignal: SIGKILL`, bounded `maxBuffer`,
 *   `child.unref()` + stdio unref + kill-timer unref. The ONLY spawnSync is the one-shot hub
 *   startup probe `probeDarwinHost` (constant positive timeout 1000 ms).
 * - Entry hard gate BEFORE any spawn: a non-finite / non-positive / >2000 ms timeoutMs
 *   rejects with RangeError — Node's `timeout: 0` means "never time out", so an invalid
 *   value must never reach a child. Host methods add a second, independent gate: invalid
 *   timeoutMs ⇒ resolve `undefined` with the (injectable) run never called (C0).
 *   DEVATION from darwin-plan §4.4-1 (reported to the dispatcher): the validated timeoutMs
 *   is applied by OUR OWN unref'd SIGKILL timer and is deliberately NOT forwarded as
 *   execFile's `timeout` option — Node implements that option with an internally REF'D
 *   timer, which holds the event loop (and `pi -p`) alive until the deadline (verified on
 *   Node v26: passing `timeout: 5000` keeps an otherwise-idle process alive 5.08 s; without
 *   it the same script exits in 0.05 s). Plan §4.4-1 (`options.timeout===150`) and §4.4-5
 *   (<1 s natural exit) are mutually incompatible on real Node; keeping the timeout ours
 *   preserves the STRONGER guarantee (the unref test still catches any ref'd child/stdio
 *   handle) while the timeout:0 trap stays closed by the entry gate — no timeout value
 *   ever reaches the child at all.
 * - spawn→close semantics: the clock starts when spawn returns; on expiry the child is
 *   SIGKILLed and the promise settles on the child's CLOSE (exit + stdio drained): status 0
 *   ⇒ resolve(stdout), timeout-kill ⇒ reject ETIMEDOUT, non-zero exit / signal / ENOENT /
 *   maxBuffer ⇒ reject the original error. Nothing is assumed about anything after close.
 * - No module-scope mutable state (I4); every dependency is injectable for tests.
 */
import { execFile as execFileDefault, spawnSync as spawnSyncDefault } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import {
  DARWIN_LOCAL_FILESYSTEMS,
  parseDarwinMount,
  parseDarwinSysctl,
  parseMemorystatusLevel,
  parsePsTop,
} from "./sysload-darwin-parse.js";

/** Structural mirrors of the C0 shapes (sampler.ts declares the authoritative copy; zero runtime import). */
export interface DarwinHostMount {
  mountId: number;
  parentId: number;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: readonly string[];
  optionalFields: readonly string[];
  fstype: string;
  source: string;
  superOptions: readonly string[];
}

export interface DarwinHostReading {
  loadavg?: readonly [number, number, number];
  memAvailPct?: number;
  cores?: number;
}

export interface DarwinHostProcess {
  pid: number;
  comm: string;
  cpuPct: number;
  rssBytes: number;
}

export interface DarwinHost {
  readonly kind: "darwin";
  readonly localFilesystems: ReadonlySet<string>;
  readHost(opts: { timeoutMs: number }): Promise<DarwinHostReading | undefined>;
  readMounts(opts: { timeoutMs: number }): Promise<string | undefined>;
  parseMounts(text: string): readonly DarwinHostMount[];
  deviceOf(path: string): Promise<number | undefined>;
  listProcesses(opts: {
    timeoutMs: number;
    maxPids: number;
  }): Promise<{ procs: readonly DarwinHostProcess[]; truncated: boolean } | undefined>;
}

export interface RunDeps {
  execFile?: typeof execFileDefault;
}

export interface DarwinHostDeps {
  run?: typeof runBounded;
  stat?: (path: string) => Promise<{ dev: number | bigint }>;
}

export interface ProbeDeps {
  spawnSync?: typeof spawnSyncDefault;
}

const SYSCTL_BIN = "/usr/sbin/sysctl";
const MOUNT_BIN = "/sbin/mount";
const PS_BIN = "/bin/ps";
/** Fixed C-locale env — deliberately NOT inherited, so output shape cannot drift with the caller's LANG/TZ. */
const RUN_ENV: Readonly<Record<string, string>> = { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const SYSCTL_MAX_BYTES = 4_096;
const MOUNT_MAX_BYTES = 1024 * 1024;
const PS_MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_MAX_BUFFER = 4_096;

/** Hard ceiling for any single bounded subprocess (the caller's budget cap is tighter: ≤800 ms). */
export const RUN_BOUNDED_MAX_MS = 2_000;

/**
 * Runs one bounded child command and resolves its stdout. Rejects with RangeError BEFORE
 * any spawn when `timeoutMs` is non-finite / ≤0 / >RUN_BOUNDED_MAX_MS. On timeout the child
 * is SIGKILLed and the promise rejects with an ETIMEDOUT-tagged error once it closes.
 */
export function runBounded(
  file: string,
  args: readonly string[],
  o: { timeoutMs: number; maxBytes: number },
  deps?: RunDeps,
): Promise<string> {
  // Entry hard gate — strictly before any spawn (the `timeout: 0` trap: Node reads 0 as "never").
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > RUN_BOUNDED_MAX_MS) {
    return Promise.reject(new RangeError(`timeoutMs must be a finite positive number <= ${RUN_BOUNDED_MAX_MS}`));
  }
  const exec = deps?.execFile ?? execFileDefault;
  const timeoutMs = o.timeoutMs;
  return new Promise<string>((resolve, reject) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const options = {
      env: RUN_ENV,
      // No `timeout` here — see the header: Node's own timeout timer is ref'd (I5 violation);
      // the validated deadline is enforced by our unref'd SIGKILL timer below.
      killSignal: "SIGKILL" as const,
      maxBuffer: o.maxBytes,
      windowsHide: true,
      encoding: "utf8" as const,
    };
    const child = exec(file, [...args], options, (error, stdout) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (error === null) {
        resolve(stdout);
        return;
      }
      if (timedOut || (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        const timeoutError = new Error(
          `runBounded: ${file} exceeded its ${timeoutMs}ms budget and was SIGKILLed`,
        ) as NodeJS.ErrnoException;
        timeoutError.code = "ETIMEDOUT";
        reject(timeoutError);
        return;
      }
      reject(error);
    });
    // I5: nothing the child owns may keep the event loop (and `pi -p`) alive. The stdio
    // handles are Sockets at runtime; @types models them as plain Readable, so unref through
    // a structural cast (no extra import — the boundary pin counts every specifier).
    child.unref();
    (child.stdout as { unref(): void } | null)?.unref();
    (child.stderr as { unref(): void } | null)?.unref();
    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone — the close settle below still owns the promise */
      }
    }, timeoutMs);
    killTimer.unref();
  });
}

/** Host-side second gate (independent of runBounded's): an invalid budget never starts anything. */
const hostTimeoutOk = (timeoutMs: number): boolean =>
  Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= RUN_BOUNDED_MAX_MS;

/**
 * The darwin SamplerHost: one sysctl for loadavg/mem/cores, mount(8) for the mount table,
 * `fs.stat().dev` for mount identity (no subprocess), `ps -A` for top. Every method with a
 * failure mode resolves `undefined` — this object never throws and never rejects.
 */
export function createDarwinHost(deps?: DarwinHostDeps): DarwinHost {
  const run = deps?.run ?? runBounded;
  const stat = deps?.stat ?? ((path: string) => fsPromises.stat(path).then((s) => ({ dev: s.dev })));
  return {
    kind: "darwin",
    localFilesystems: DARWIN_LOCAL_FILESYSTEMS,
    readHost: async (opts) => {
      if (!hostTimeoutOk(opts.timeoutMs)) return undefined;
      try {
        const text = await run(SYSCTL_BIN, ["-n", "vm.loadavg", "kern.memorystatus_level", "hw.ncpu"], {
          timeoutMs: opts.timeoutMs,
          maxBytes: SYSCTL_MAX_BYTES,
        });
        return parseDarwinSysctl(text);
      } catch {
        return undefined;
      }
    },
    readMounts: async (opts) => {
      if (!hostTimeoutOk(opts.timeoutMs)) return undefined;
      try {
        return await run(MOUNT_BIN, [], { timeoutMs: opts.timeoutMs, maxBytes: MOUNT_MAX_BYTES });
      } catch {
        return undefined;
      }
    },
    parseMounts: (text) => parseDarwinMount(text),
    deviceOf: async (path) => {
      try {
        const info = await stat(path);
        const dev = typeof info.dev === "bigint" ? Number(info.dev) : info.dev;
        return Number.isSafeInteger(dev) && dev >= 0 ? dev : undefined;
      } catch {
        return undefined;
      }
    },
    listProcesses: async (opts) => {
      if (!hostTimeoutOk(opts.timeoutMs)) return undefined;
      if (!Number.isInteger(opts.maxPids) || opts.maxPids <= 0) return undefined;
      try {
        const text = await run(PS_BIN, ["-A", "-o", "pid=,pcpu=,rss=,comm="], {
          timeoutMs: opts.timeoutMs,
          maxBytes: PS_MAX_BYTES,
        });
        return parsePsTop(text, opts.maxPids);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Resolves the sampler host for the running platform: `darwin` ⇒ a fresh DarwinHost, anything
 * else ⇒ `undefined` (the sampler then stays on its byte-identical Linux default path).
 */
export function resolveSysloadHost(platform?: NodeJS.Platform): DarwinHost | undefined {
  return (platform ?? process.platform) === "darwin" ? createDarwinHost() : undefined;
}

/**
 * One-shot hub startup probe (darwin-plan §2.6): `sysctl -n kern.memorystatus_level` must
 * yield a 0..100 integer. The ONLY synchronous spawn in the whole sysload darwin path — a
 * deliberate exception (constant 1000 ms budget, runs once per hub lifetime, never per tick).
 * Any failure (missing sysctl, timeout, sandbox refusal, garbage) ⇒ `false` ⇒ no `load.v1`
 * cap, exactly like Linux when `/proc` is unavailable.
 */
export function probeDarwinHost(deps?: ProbeDeps): boolean {
  const sync = deps?.spawnSync ?? spawnSyncDefault;
  try {
    const result = sync(SYSCTL_BIN, ["-n", "kern.memorystatus_level"], {
      env: RUN_ENV,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      encoding: "utf8" as const,
    });
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return false;
    return parseMemorystatusLevel(result.stdout) !== undefined;
  } catch {
    return false;
  }
}
