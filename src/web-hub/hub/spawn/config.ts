/**
 * Hub-side spawn config re-validation + platform probe (web-hub-spawn plan v2.1 §SP2 /
 * arch v2 §6.2 + §7.1).
 *
 * Both defenses exist because the hub never reads pi's settings file — its config arrives as
 * `PI_WEBHUB_CONFIG` env JSON (`agent/index.ts` `buildHubConfig`):
 *
 *   - `parseHubSpawnConfig`: field-strict re-validation of `HubConfig.spawn`, same contract as
 *     `hub/lan-config.ts`'s `parseHubLanConfig` (§1.4.3: settings already validated once; this is
 *     the hub's own independent second check). Unlike the settings layer (tolerant: clamps /
 *     drops per field), ANY invalid field rejects the whole block — `hub/main.ts` then drops the
 *     `spawn` key and warns, i.e. a corrupted config turns the feature off rather than silently
 *     running a different policy.
 *   - `probePlatform`: arch §7.1's three procfs probes (Linux-only, fail closed). SP10 calls it
 *     at startup; a `{ok:false}` result keeps `spawn.v1` in caps (so the UI can explain why) but
 *     makes the whole spawn surface refuse: no reaper, no spawns.json, no fork.
 *
 * Zero-`as` module (`hub/spawn/**` contract, SP7 source-scan): object narrowing goes through
 * `isRecord`, never a cast.
 */
import { closeSync, constants, openSync, readFileSync, statSync } from "node:fs";
import { parsePgrp, parseStartTicks } from "../../protocol/proc-identity.js";
import type { HubSpawnConfig } from "../../protocol/spawn.js";

/** `as`-free object narrowing (SP7's `hub/spawn/**` source scan bans casts). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Short, throw-free error rendering for probe `detail` strings. */
function errDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strict integer field check (NO clamping here — that is the settings layer's tolerance, not the hub's). */
function spawnIntField(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; detail: string } {
  const raw = obj[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return { ok: false, detail: `${key}=${String(raw)}: must be an integer in ${min}..${max}` };
  }
  return { ok: true, value: raw };
}

/**
 * Defensive re-validation of `HubConfig.spawn` (shape mirrors `lan-config.ts:20`). Ranges are
 * arch §6.2's, the same table the settings layer clamps into — so a block that passed
 * `parseWebHubSpawnBlock` always passes here; only a corrupted env var can fail.
 */
export function parseHubSpawnConfig(raw: unknown): { ok: true; spawn: HubSpawnConfig } | { ok: false; detail: string } {
  if (!isRecord(raw)) return { ok: false, detail: "spawn: not an object" };

  const rootsRaw = raw["roots"];
  if (!Array.isArray(rootsRaw) || !rootsRaw.every((entry) => typeof entry === "string")) {
    return { ok: false, detail: "roots: must be a string array" };
  }
  if (rootsRaw.length > 16) return { ok: false, detail: `roots: ${String(rootsRaw.length)} entries (max 16)` };
  const roots: string[] = [];
  for (const [i, entryAny] of rootsRaw.entries()) {
    const entry: string = entryAny;
    if (!entry.startsWith("/") && !entry.startsWith("~")) {
      return { ok: false, detail: `roots[${String(i)}]: must start with / or ~` };
    }
    if (entry.includes("\0")) return { ok: false, detail: `roots[${String(i)}]: contains NUL` };
    if (Buffer.byteLength(entry) > 4096) {
      return { ok: false, detail: `roots[${String(i)}]: longer than 4096 bytes` };
    }
    roots.push(entry);
  }

  const maxProcesses = spawnIntField(raw, "maxProcesses", 1, 16);
  if (!maxProcesses.ok) return maxProcesses;
  const maxPerPrincipal = spawnIntField(raw, "maxPerPrincipal", 1, 16);
  if (!maxPerPrincipal.ok) return maxPerPrincipal;
  const ratePerMinute = spawnIntField(raw, "ratePerMinute", 1, 30);
  if (!ratePerMinute.ok) return ratePerMinute;
  const maxLifetimeMinutes = spawnIntField(raw, "maxLifetimeMinutes", 10, 10_080);
  if (!maxLifetimeMinutes.ok) return maxLifetimeMinutes;
  const registerTimeoutS = spawnIntField(raw, "registerTimeoutS", 10, 120);
  if (!registerTimeoutS.ok) return registerTimeoutS;

  const lan = raw["lan"];
  if (lan !== "off" && lan !== "known" && lan !== "roots") {
    return { ok: false, detail: `lan=${String(lan)}: must be off|known|roots` };
  }

  return {
    ok: true,
    spawn: {
      roots,
      maxProcesses: maxProcesses.value,
      maxPerPrincipal: maxPerPrincipal.value,
      ratePerMinute: ratePerMinute.value,
      maxLifetimeMinutes: maxLifetimeMinutes.value,
      registerTimeoutS: registerTimeoutS.value,
      lan,
    },
  };
}

// ---------------------------------------------------------------------------
// platform probe (arch §7.1: Linux + procfs only, fail closed)
// ---------------------------------------------------------------------------

/** Sync fs seams so tests can inject each probe's failure; defaults are `node:fs`. */
export interface PlatformProbeDeps {
  /** Default: `process.platform`. */
  platform?: string;
  /** Default: `node:fs` `readFileSync(path, "utf8")` — probes ① (`/proc/self/stat`) and ② (boot_id). */
  readFileSync?: (path: string) => string;
  /** Default: `node:fs` `openSync` — probe ③'s `O_DIRECTORY` open. */
  openSync?: (path: string, flags: number) => number;
  /** Default: `node:fs` `statSync` — probe ③'s fd-path stat. */
  statSync?: (path: string) => { isDirectory(): boolean };
  /** Default: `node:fs` `closeSync`. */
  closeSync?: (fd: number) => void;
}

export type PlatformProbeResult = { ok: true } | { ok: false; detail: string };

/**
 * arch §7.1's three procfs probes — each a bounded synchronous syscall (total budget ≤100ms is
 * structural: procfs reads never block on device I/O, and there is nothing else here):
 *
 *   ① `/proc/self/stat` parses into both starttime (field 22) and pgrp (field 5) — SP7's
 *      identity capture and group-kill precondition;
 *   ② `/proc/sys/kernel/random/boot_id` is readable and non-empty (identity component, §7.4);
 *   ③ `/proc/self/fd` can be `open`ed `O_DIRECTORY` and its `/proc/self/fd/<fd>` path stats as a
 *      directory — the exact mechanism SP3's `cwdArg = /proc/self/fd/N` relies on.
 *
 * Non-Linux platforms fail the whole probe (`platform=…` detail). Any `{ok:false}` result means
 * fail closed (§7.1): caps still carry `spawn.v1`, but `GET /api/headless` reports
 * `reason:"platform"` and nothing ever forks. Unreadable files fail closed, never "probably ok".
 */
export function probePlatform(deps: PlatformProbeDeps = {}): PlatformProbeResult {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return { ok: false, detail: `platform=${platform}: non-linux (spawn is Linux-only)` };

  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, "utf8"));

  let stat: string;
  try {
    stat = read("/proc/self/stat");
  } catch (err) {
    return { ok: false, detail: `/proc/self/stat: unreadable (${errDetail(err)})` };
  }
  if (parseStartTicks(stat) === undefined || parsePgrp(stat) === undefined) {
    return { ok: false, detail: "/proc/self/stat: no starttime/pgrp (fields 22/5)" };
  }

  let bootId: string;
  try {
    bootId = read("/proc/sys/kernel/random/boot_id").trim();
  } catch (err) {
    return { ok: false, detail: `/proc/sys/kernel/random/boot_id: unreadable (${errDetail(err)})` };
  }
  if (bootId === "") return { ok: false, detail: "boot_id: empty" };

  const openDir = deps.openSync ?? ((path: string, flags: number) => openSync(path, flags));
  const statPath = deps.statSync ?? ((path: string) => statSync(path));
  const closeFd = deps.closeSync ?? ((fd: number) => closeSync(fd));

  let fd: number;
  try {
    fd = openDir("/proc/self/fd", constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (err) {
    return { ok: false, detail: `/proc/self/fd: open-failed (${errDetail(err)})` };
  }
  try {
    const fdStat = statPath(`/proc/self/fd/${String(fd)}`);
    if (!fdStat.isDirectory()) return { ok: false, detail: "/proc/self/fd/<fd>: not a directory" };
  } catch (err) {
    return { ok: false, detail: `/proc/self/fd/<fd>: stat-failed (${errDetail(err)})` };
  } finally {
    try {
      closeFd(fd);
    } catch {
      /* fd already gone — the verdict above stands */
    }
  }

  return { ok: true };
}
