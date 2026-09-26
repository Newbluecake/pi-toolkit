/**
 * `/proc` identity verification for `/webhub restart`'s fallback signal path
 * (plan §8.2; LE). This is a **safety** check (avoid signalling a PID that got
 * reused by an unrelated process while the hub was hung), not a security
 * boundary — same-uid processes are already fully trusted (plan §1.1).
 *
 * Only ever consulted on the "hub hung, no ctl.v1 response" fallback path
 * (`restart.ts`): the happy path (`hub_ctl shutdown` acked over the socket)
 * never reads `/proc` at all (plan §11 LE row: "ctl 路径不读 /proc").
 *
 * Verification is layered, cheapest/most-decisive first:
 *   1. platform must be Linux (no reliable `/proc` elsewhere);
 *   2. the *stored* identity shape itself must look like a hub process
 *      (argv has exactly 3 entries, ending in `jiti-cli.mjs` and
 *      `/src/web-hub/hub/main.ts`) — defends against a corrupted/foreign
 *      `hub.json`;
 *   3. `/proc/<pid>/stat` field 22 (starttime) must equal the stored
 *      `procStartTicks` — the PID-reuse defense;
 *   4. `/proc/<pid>/cmdline` (NUL-separated) must equal the stored `argv`
 *      item-by-item — defends against a same-PID process whose argv drifted
 *      (e.g. exec'd into something else) between hub.json write and now;
 *   5. the target process's real *and* effective uid (from
 *      `/proc/<pid>/status`'s `Uid:` line) must equal ours.
 * Any failure to read `/proc/<pid>/*` (process gone, no `/proc`, permission)
 * is `"no-proc"` — never treated as "verified".
 */
import { readFile } from "node:fs/promises";

export interface ExpectedIdentity {
  pid: number;
  procStartTicks: number;
  argv: string[];
}

export type IdentityRejectReason =
  "non-linux" | "argv-shape" | "no-proc" | "starttime-mismatch" | "cmdline-mismatch" | "uid-mismatch";

export type IdentityVerdict = { ok: true } | { ok: false; reason: IdentityRejectReason };

export interface ProcIdentityDeps {
  /** Default: `node:fs/promises` `readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
  /** Default: `process.getuid()`. */
  getuid?: () => number;
  /** Default: `process.platform`. */
  platform?: string;
}

function defaults(deps: ProcIdentityDeps | undefined): {
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

/** Stored-argv sanity check (plan §8.2: "3 项、以 jiti-cli.mjs 和 /src/web-hub/hub/main.ts 结尾"). */
export function looksLikeHubArgv(argv: readonly string[]): boolean {
  if (argv.length !== 3) return false;
  const jiti = argv[1];
  const main = argv[2];
  return (
    jiti !== undefined &&
    main !== undefined &&
    jiti.endsWith("jiti-cli.mjs") &&
    main.endsWith("/src/web-hub/hub/main.ts")
  );
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
  const d = defaults(deps);
  if (d.platform !== "linux") return undefined;
  try {
    return parseStartTicks(await d.readFile(`/proc/${pid}/stat`));
  } catch {
    return undefined;
  }
}

export async function verifyProcIdentity(
  expected: ExpectedIdentity,
  deps?: ProcIdentityDeps,
): Promise<IdentityVerdict> {
  const d = defaults(deps);
  if (d.platform !== "linux") return { ok: false, reason: "non-linux" };
  if (!looksLikeHubArgv(expected.argv)) return { ok: false, reason: "argv-shape" };

  let stat: string;
  let cmdline: string;
  let status: string;
  try {
    [stat, cmdline, status] = await Promise.all([
      d.readFile(`/proc/${expected.pid}/stat`),
      d.readFile(`/proc/${expected.pid}/cmdline`),
      d.readFile(`/proc/${expected.pid}/status`),
    ]);
  } catch {
    return { ok: false, reason: "no-proc" };
  }

  const starttime = parseStartTicks(stat);
  if (starttime === undefined || starttime !== expected.procStartTicks)
    return { ok: false, reason: "starttime-mismatch" };

  const argv = parseCmdline(cmdline);
  if (argv.length !== expected.argv.length || argv.some((a, i) => a !== expected.argv[i])) {
    return { ok: false, reason: "cmdline-mismatch" };
  }

  const uid = parseUidLine(status);
  const ourUid = d.getuid();
  if (uid === undefined || uid.real !== ourUid || uid.effective !== ourUid)
    return { ok: false, reason: "uid-mismatch" };

  return { ok: true };
}
