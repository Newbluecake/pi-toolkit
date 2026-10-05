/**
 * `/proc` identity verification for `/webhub restart`'s fallback signal path
 * (plan §8.2; LE). This is a **safety** check (avoid signalling a PID that got
 * reused by an unrelated process while the hub was hung), not a security
 * boundary — same-uid processes are already fully trusted (plan §1.1).
 *
 * web-hub-spawn SP1 split: the pure `/proc` parsers (`parseStartTicks`,
 * `parseCmdline`, `parseUidLine`, `readStartTicksNow`) moved to
 * `protocol/proc-identity.ts` so the spawn subsystem shares one identity
 * definition; this file keeps the restart-specific pieces (`looksLikeHubArgv`,
 * `verifyProcIdentity` — the hub-hung fallback ALSO checks the stored argv,
 * which spawn identity deliberately does not) and re-exports the parsers so
 * existing importers (`admin-cmds.ts`, `agent/index.ts`, tests) are unchanged.
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
export {
  parseCmdline,
  parsePgrp,
  parseStartTicks,
  parseUidLine,
  readBootId,
  readBtime,
  readStartTicksNow,
  readStatSync,
  verifySpawnedIdentity,
} from "../protocol/proc-identity.js";
export type {
  ProcIdentityDeps,
  ProcSyncDeps,
  SpawnedIdentity,
  SpawnIdentityRejectReason,
  SpawnIdentityVerdict,
} from "../protocol/proc-identity.js";

import {
  parseCmdline,
  parseStartTicks,
  parseUidLine,
  resolveProcIdentityDeps,
  type ProcIdentityDeps,
} from "../protocol/proc-identity.js";

export interface ExpectedIdentity {
  pid: number;
  procStartTicks: number;
  argv: string[];
}

export type IdentityRejectReason =
  "non-linux" | "argv-shape" | "no-proc" | "starttime-mismatch" | "cmdline-mismatch" | "uid-mismatch";

export type IdentityVerdict = { ok: true } | { ok: false; reason: IdentityRejectReason };

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

export async function verifyProcIdentity(
  expected: ExpectedIdentity,
  deps?: ProcIdentityDeps,
): Promise<IdentityVerdict> {
  const d = resolveProcIdentityDeps(deps);
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
