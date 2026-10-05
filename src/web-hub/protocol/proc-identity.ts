/**
 * `/proc` identity helpers (web-hub-spawn arch v2 §7.4 — the SINGLE identity definition).
 *
 * Everything process-identity-shaped lives here so the hub supervisor (SP7), orphan recovery
 * and the reaper's inline script (SP6 — a byte-for-byte copy of `verifySpawnedIdentity`'s
 * algorithm, kept honest by a fixture-comparison test) all judge "is this the process we
 * spawned" identically.
 *
 * The v2 ruling (review #2): identity is `bootId + starttime + uid` — for group kills
 * additionally `pgrp == pid`. `cmdline`/`comm` are DIAGNOSTIC ONLY (a real pi rewrites its
 * cmdline to `pi` via `process.title`, so any argv-based check would never hold); conformance
 * pins that against a real `pi --mode rpc`.
 *
 * The pre-existing restart fallback verification (`agent/proc-identity.ts`'s
 * `verifyProcIdentity`) re-exports its parsers from here and additionally checks the stored
 * argv — that is a hub-hung safety check, not spawn identity, and stays where it is.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface ProcIdentityDeps {
  /** Default: `node:fs/promises` `readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
  /** Default: `process.getuid()`. */
  getuid?: () => number;
  /** Default: `process.platform`. */
  platform?: string;
}

/** Sync `/proc` reads for the supervisor's synchronous segments (arch §7.5 steps ④/⑩). */
export interface ProcSyncDeps {
  /** Default: `node:fs` `readFileSync(path, "utf8")`. */
  readFileSync?: (path: string) => string;
  /** Default: `process.platform`. */
  platform?: string;
}

/**
 * Resolve a `ProcIdentityDeps` into its defaults. Exported for `agent/proc-identity.ts`'s
 * `verifyProcIdentity` (the one remaining consumer of the async parsers outside this module),
 * so both files share a single "what the defaults are" definition.
 */
export function resolveProcIdentityDeps(deps: ProcIdentityDeps | undefined): {
  readFile: (p: string) => Promise<string>;
  getuid: () => number;
  platform: string;
} {
  return {
    readFile: deps?.readFile ?? ((p: string) => readFile(p, "utf8")),
    getuid: deps?.getuid ?? (() => process.getuid?.() ?? 0),
    platform: deps?.platform ?? process.platform,
  };
}

/** Field 22 (1-indexed) of `/proc/<pid>/stat`; comm may contain `)` so split after the LAST one. */
export function parseStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields after `pid (comm)`: state(0) ppid(1) ... starttime is index 19 (field 22 overall).
  const raw = rest[19];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Field 5 (pgrp) of `/proc/<pid>/stat` — the group-kill precondition (`pgrp === pid`). */
export function parsePgrp(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields after `pid (comm)`: state(0) ppid(1) pgrp(2) — field 5 overall.
  const raw = rest[2];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** `/proc/<pid>/cmdline`: NUL-separated, trailing NUL produces one empty tail entry — dropped. */
export function parseCmdline(raw: string): string[] {
  const parts = raw.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `Uid:\t<real>\t<effective>\t<saved>\t<fs>` line of `/proc/<pid>/status`. */
export function parseUidLine(status: string): { real: number; effective: number } | undefined {
  const line = status.split("\n").find((l) => l.startsWith("Uid:"));
  if (line === undefined) return undefined;
  const nums = line.slice(4).trim().split(/\s+/).map(Number);
  const real = nums[0];
  const effective = nums[1];
  if (real === undefined || effective === undefined || !Number.isFinite(real) || !Number.isFinite(effective)) {
    return undefined;
  }
  return { real, effective };
}

/** Just the starttime re-check used right before signalling (race window between check and kill). */
export async function readStartTicksNow(pid: number, deps?: ProcIdentityDeps): Promise<number | undefined> {
  const d = resolveProcIdentityDeps(deps);
  if (d.platform !== "linux") return undefined;
  try {
    return parseStartTicks(await d.readFile(`/proc/${pid}/stat`));
  } catch {
    return undefined;
  }
}

/** `/proc/sys/kernel/random/boot_id` (trimmed); undefined on non-Linux or read failure. */
export async function readBootId(deps?: ProcIdentityDeps): Promise<string | undefined> {
  const d = resolveProcIdentityDeps(deps);
  if (d.platform !== "linux") return undefined;
  try {
    const raw = await d.readFile("/proc/sys/kernel/random/boot_id");
    const v = raw.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `btime` line of `/proc/stat`, in seconds since epoch; undefined on non-Linux/missing/invalid. */
export async function readBtime(deps?: ProcIdentityDeps): Promise<number | undefined> {
  const d = resolveProcIdentityDeps(deps);
  if (d.platform !== "linux") return undefined;
  try {
    const stat = await d.readFile("/proc/stat");
    const line = stat.split("\n").find((l) => l.startsWith("btime "));
    if (line === undefined) return undefined;
    const n = Number(line.slice("btime ".length).trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Synchronous `/proc/<pid>/stat` read (arch §7.5 ④ identity capture and ⑩ pre-signal re-check). */
export function readStatSync(pid: number, deps?: ProcSyncDeps): string | undefined {
  const read = deps?.readFileSync ?? ((p: string) => readFileSync(p, "utf8"));
  const platform = deps?.platform ?? process.platform;
  if (platform !== "linux") return undefined;
  try {
    return read(`/proc/${pid}/stat`);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// spawn identity verification (arch §7.4 reason table, verbatim order)
// ---------------------------------------------------------------------------

/** The identity captured at fork time (arch §7.7: `launching` records lack these four fields). */
export interface SpawnedIdentity {
  pid: number;
  procStartTicks: number;
  bootId: string;
  uid: number;
}

export type SpawnIdentityRejectReason =
  "non-linux" | "boot-mismatch" | "no-proc" | "starttime-mismatch" | "uid-mismatch" | "pgrp-mismatch";

export type SpawnIdentityVerdict = { ok: true } | { ok: false; reason: SpawnIdentityRejectReason };

/**
 * The one identity judgment every signal-sending path shares (L5: re-verify synchronously in the
 * same critical section before EVERY signal). Check order mirrors arch §7.4's table:
 * platform → boot id → process existence → starttime → uid → (group kills only) pgrp.
 * Any unreadable `/proc` file fails CLOSED (never "verified").
 */
export async function verifySpawnedIdentity(
  expected: SpawnedIdentity,
  opts: { group: boolean },
  deps?: ProcIdentityDeps,
): Promise<SpawnIdentityVerdict> {
  const d = resolveProcIdentityDeps(deps);
  if (d.platform !== "linux") return { ok: false, reason: "non-linux" };

  const bootId = await readBootId(d);
  if (bootId !== expected.bootId) return { ok: false, reason: "boot-mismatch" };

  let stat: string;
  let status: string;
  try {
    [stat, status] = await Promise.all([
      d.readFile(`/proc/${expected.pid}/stat`),
      d.readFile(`/proc/${expected.pid}/status`),
    ]);
  } catch {
    return { ok: false, reason: "no-proc" };
  }

  const starttime = parseStartTicks(stat);
  if (starttime === undefined || starttime !== expected.procStartTicks)
    return { ok: false, reason: "starttime-mismatch" };

  const uid = parseUidLine(status);
  if (uid === undefined || uid.real !== expected.uid || uid.effective !== expected.uid)
    return { ok: false, reason: "uid-mismatch" };

  if (opts.group) {
    const pgrp = parsePgrp(stat);
    if (pgrp === undefined || pgrp !== expected.pid) return { ok: false, reason: "pgrp-mismatch" };
  }

  return { ok: true };
}
