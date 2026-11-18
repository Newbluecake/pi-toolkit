/**
 * Darwin schedule identity probe (darwin-plan §3.P1-a / darwin-arch §4).
 *
 * macOS has no /proc: the process start clock comes from `/bin/ps -o lstart=` (second precision,
 * strictly parsed to UTC epoch-ms) and the boot identity from `sysctl kern.bootsessionuuid`.
 * This file lives in `web-hub/protocol` so BOTH the agent wiring (`src/schedule/agent/wire.ts`)
 * and the read-only hub can reach it without expanding either import closure: it imports only
 * `node:child_process` and `node:os`, never schedule/core — recovery.ts consumes it through the
 * structural `IdentityDeps`/`LivenessProbe` shapes (boundary-pinned in tests/web-hub/boundary.test.ts).
 *
 * No module-scope mutable state (I4); every dependency is injectable via `DarwinIdentityHost`.
 * No caches: every call is a fresh bounded subprocess (budget in darwin-plan §3.P1-b —
 * readSelf = 2 spawns; a judged holder = 0 or 1).
 *
 * Accepted residuals (darwin-arch §4.2/§9.5): `ps lstart` is second-precision — a pid reused
 * within the same second of the same boot judges `alive` (delays recovery, never kills a live
 * run). Cross-platform `start` values (Linux ticks vs Darwin epoch-ms) are told apart by
 * `startDomainOf` in recovery.ts; a cross-domain holder is `unprovable`, never dead. Missing
 * ps/sysctl ⇒ identity unavailable ⇒ schedule stays fail-closed, mirroring "no /proc" on Linux.
 */
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface DarwinIdentityHost {
  /**
   * Runs a bounded child command and returns its stdout; throws on non-zero exit / timeout /
   * ENOENT (carrying `status` / `code`). Default = node's execFileSync with stderr discarded.
   */
  execFileSync(
    file: string,
    args: readonly string[],
    opts: { env: Record<string, string>; timeout: number; maxBuffer: number },
  ): string;
  /** `process.kill(pid, 0)` — throws ESRCH for a gone pid, EPERM for a foreign live one. */
  kill(pid: number, sig: 0): void;
  hostname(): string;
  pid: number;
}

/** Structural stand-in for recovery.ts `ProcessIdentity` — same shape, no import (boundary-pinned). */
export interface DarwinSelfIdentity {
  pid: number;
  start: number;
  host: string;
  boot: string;
}

export interface DarwinIdentity {
  /** Self identity, or `undefined` when ps/sysctl is unusable (then nothing can execute). */
  readSelf(): DarwinSelfIdentity | undefined;
  probe: {
    /** epoch-ms start of `pid`; `undefined` when the pid is gone, `"error"` when unreadable. */
    startOf(pid: number): number | undefined | "error";
    /** `false` only on proven ESRCH. */
    pidMayExist(pid: number): boolean;
    /** Darwin `start` values are epoch-ms (≥1e11): cross-domain holders judge `unprovable`. */
    readonly startDomain: "epoch-ms";
  };
}

const PS_BIN = "/bin/ps";
const SYSCTL_BIN = "/usr/sbin/sysctl";
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BUFFER = 4_096;
/** Fixed environment: `ps lstart` prints C-locale English names in UTC regardless of the caller's LANG/TZ. */
const PROBE_ENV: Record<string, string> = { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" };

const PS_LSTART_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s*$/;
const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BOOT_UUID_RE = /^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;

/**
 * Strictly parse one line of `LC_ALL=C TZ=UTC0 /bin/ps -o lstart= -p <pid>` into UTC epoch
 * **milliseconds** (whole seconds, `…000`). Any deviation — unknown weekday/month, day or
 * time overflow, weekday not matching the date, localized output, trailing garbage — yields
 * `undefined` (the caller maps that to `"error"`, never to a guess).
 */
export function parsePsLstart(text: string): number | undefined {
  const m = PS_LSTART_RE.exec(text);
  if (m === null) return undefined;
  const year = Number(m[7]);
  const month = MONTHS.indexOf(m[2]!);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const d = new Date(ms);
  // Read-back verification: Date.UTC silently rolls over invalid dates; nothing leaves unverified.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second ||
    d.getUTCDay() !== WEEKDAYS.indexOf(m[1]!)
  )
    return undefined;
  return Number.isSafeInteger(ms) && ms >= 0 && ms % 1_000 === 0 ? ms : undefined;
}

/**
 * Parse `sysctl -n kern.bootsessionuuid` output: trimmed, must be a UUID. Case is preserved
 * (stored holders compare same-source same-form); anything else ⇒ `undefined` — the boot id
 * is never guessed.
 */
export function parseBootSessionUuid(text: string): string | undefined {
  const v = text.trim();
  return BOOT_UUID_RE.test(v) ? v : undefined;
}

function isEmptyOutput(out: unknown): boolean {
  if (out === undefined || out === null) return true;
  if (typeof out === "string") return out.trim() === "";
  if (typeof out === "object" && "byteLength" in (out as object)) return (out as Uint8Array).byteLength === 0;
  return false;
}

function defaultHost(): DarwinIdentityHost {
  return {
    execFileSync: (file, args, opts) =>
      execFileSync(file, args, {
        ...opts,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) as string,
    kill: (pid, sig) => process.kill(pid, sig),
    hostname: () => hostname(),
    pid: process.pid,
  };
}

/**
 * Darwin identity source: `ps` for the start clock, `sysctl` for the boot id. `host` is fully
 * injectable for tests (the default wraps the real `node:child_process`/`node:os` calls).
 */
export function createDarwinIdentity(host?: Partial<DarwinIdentityHost>): DarwinIdentity {
  const h: DarwinIdentityHost = { ...defaultHost(), ...host };

  function startOf(pid: number): number | undefined | "error" {
    if (!Number.isSafeInteger(pid) || pid <= 0) return "error";
    try {
      h.kill(pid, 0);
    } catch (err) {
      // Proven gone; anything else (EPERM, …) keeps probing — liveness is never guessed dead.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    let out: string;
    try {
      out = h.execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(pid)], {
        env: PROBE_ENV,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
      });
    } catch (err) {
      const e = err as { status?: unknown; stdout?: unknown };
      // `ps` exits 1 with empty output for a nonexistent pid; any other failure is an error.
      if (e.status === 1 && isEmptyOutput(e.stdout)) return undefined;
      return "error";
    }
    const start = parsePsLstart(out);
    return start === undefined ? "error" : start;
  }

  function pidMayExist(pid: number): boolean {
    try {
      h.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  function readSelf(): DarwinSelfIdentity | undefined {
    const start = startOf(h.pid);
    if (typeof start !== "number") return undefined;
    let boot: string;
    try {
      boot =
        parseBootSessionUuid(
          h.execFileSync(SYSCTL_BIN, ["-n", "kern.bootsessionuuid"], {
            env: PROBE_ENV,
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: PROBE_MAX_BUFFER,
          }),
        ) ?? "";
    } catch {
      return undefined;
    }
    if (boot === "") return undefined;
    return { pid: h.pid, start, host: h.hostname(), boot };
  }

  return {
    readSelf,
    probe: { startOf, pidMayExist, startDomain: "epoch-ms" },
  };
}
