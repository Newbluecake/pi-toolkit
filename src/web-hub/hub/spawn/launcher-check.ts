/**
 * web-hub-spawn plan §SP7 (arch v2 §4.2/#12): the launcher version chain.
 *
 * The launcher is the ONLY thing the hub ever execs to start a managed `pi --mode rpc` child,
 * and it comes from exactly one place: the current hub's `HubConfig.launcher` (the
 * `[process.execPath, argv1]` of the pi process that started this hub). `hello.launcher` — an
 * agent's self-report — is never used for exec (D15).
 *
 * Two checks, two timings:
 *
 *  - `checkLauncherAsync` runs ONCE inside supervisor `init()` (≤1s, deadline-bounded): both
 *    entries absolute paths, realpath + stat as regular files, `launcher[1]` a `.js/.mjs/.cjs`
 *    entry, and the enclosing `@earendil-works/pi-coding-agent` package's `version` inside
 *    `SUPPORTED_PI_RANGE`. It records a `{realpath, dev, ino, size, mtimeMs}` fingerprint for
 *    BOTH entries. Failure ⇒ `policy.reason:"launcher"` with detail ∈ {missing, not-file,
 *    unverifiable, incompatible} — the whole feature fail-closes for the hub's lifetime.
 *  - `recheckLauncherSync` runs before EVERY fork (in `start()`'s synchronous stretch): plain
 *    `statSync` of both fingerprinted realpaths, all four stat fields must match exactly.
 *    Any mismatch ⇒ `503 E_LAUNCHER{reason:"changed"}` and the policy degrades to
 *    `launcher/changed` until `/webhub restart` — the package.json is deliberately NOT
 *    re-probed (no request-path disk reads beyond two stats).
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`):
 * unknown JSON narrows through `isRecord` + `Reflect.get`, never a cast.
 */
import { readFileSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { SUPPORTED_PI_RANGE } from "../../protocol/spawn.js";
import { raceDeadline, type ReqDeadline } from "../req-deadline.js";

/** arch §4.2: the stat tuple a fingerprint captures — equality of all four is the re-check. */
export interface LauncherFingerprint {
  realpath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** arch §4.2's init failure reasons (the `E_LAUNCHER` `detail` values). */
export type LauncherCheckReason = "missing" | "not-file" | "unverifiable" | "incompatible";

export type LauncherCheckResult =
  | { ok: true; fp: readonly [LauncherFingerprint, LauncherFingerprint]; version: string }
  | { ok: false; reason: LauncherCheckReason; detail?: string };

/**
 * The fs surface both checks read — injectable per-method like every other `hub/spawn` seam.
 * Defaults are the real node fs; `stat`/`statSync` are structural (a `Stats` satisfies them).
 */
export interface LauncherFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ dev: number; ino: number; size: number; mtimeMs: number; isFile(): boolean }>;
  readFileSync(path: string, opts: { encoding: "utf8" }): string;
  statSync(path: string): { dev: number; ino: number; size: number; mtimeMs: number; isFile(): boolean };
}

const REAL_LAUNCHER_FS: LauncherFs = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path),
  readFileSync: (path, opts) => readFileSync(path, opts),
  statSync: (path) => statSync(path),
};

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** arch §4.2: walk up at most this many parent dirs from the entry script to find the package. */
const PKG_WALK_LEVELS = 5;
/** arch §4.2: the WHOLE init check is bounded by this total budget (review re-run #4 — not a
 *  per-step one: realpath×2 + stat×2 + the package scan all draw from the same 1s pool). */
export const LAUNCHER_CHECK_TOTAL_MS = 1_000;
/** Per-step async cap inside the init check (`min(this, total budget left)`). */
const STEP_BUDGET_MS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return "E_IO";
}

/**
 * Dot-numeric compare (pi versions are plain `MAJOR.MINOR.PATCH`); missing parts count as 0.
 * Returns <0 / 0 / >0 like `String.prototype.localeCompare`'s sign convention.
 */
export function compareDotVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number(pa[i] ?? "0");
    const y = Number(pb[i] ?? "0");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // Non-numeric suffixes (e.g. "1.0.0-rc1"): fall back to lexicographic on the raw strings.
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (x !== y) return x - y;
  }
  return 0;
}

/** `min <= v < maxExclusive` (SUPPORTED_PI_RANGE semantics; pinned to the peer range by SP1 test). */
export function versionInRange(v: string, min: string, maxExclusive: string): boolean {
  return compareDotVersions(v, min) >= 0 && compareDotVersions(v, maxExclusive) < 0;
}

/**
 * Find the enclosing pi package's version by walking up from `entryRealpath` (arch §4.2):
 * ≤5 levels, first `package.json` with `name === "@earendil-works/pi-coding-agent"` wins.
 * `undefined` ⇒ unverifiable. Sync reads (small files), but budget-checked BEFORE each level —
 * sync IO is not cancellable, so the check is the only deadline behavior it promises
 * (arch §7.6's rule for sync segments).
 */
export function findPiPackageVersion(
  entryRealpath: string,
  fs: LauncherFs,
  remainingMs: () => number = () => Number.POSITIVE_INFINITY,
): string | undefined {
  let dir = dirname(entryRealpath);
  for (let level = 0; level < PKG_WALK_LEVELS; level++) {
    if (remainingMs() <= 0) return undefined; // total init budget exhausted — unverifiable
    let raw: string;
    try {
      raw = fs.readFileSync(join(dir, "package.json"), { encoding: "utf8" });
    } catch {
      dir = dirname(dir);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      dir = dirname(dir);
      continue;
    }
    if (isRecord(parsed) && parsed["name"] === PI_PACKAGE_NAME && typeof parsed["version"] === "string") {
      return parsed["version"];
    }
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * The init-time check (arch §4.2 row 1). EVERY step draws from ONE shared 1s absolute budget
 * (further capped by the caller's `deadline` and the per-step cap): `totalLeft()` is the
 * min of both, so realpath×2 + stat×2 + the package walk cannot serialize past 1s in total
 * (review re-run #4). A budget failure classifies as `unverifiable` — the launcher may be
 * fine, this hub simply ran out of startup budget; policy fail-closes the same way and
 * `/webhub restart` re-runs the whole check.
 */
export async function checkLauncherAsync(
  launcher: readonly [string, string] | undefined,
  deadline: ReqDeadline,
  fs: LauncherFs = REAL_LAUNCHER_FS,
): Promise<LauncherCheckResult> {
  if (launcher === undefined) return { ok: false, reason: "missing", detail: "launcher absent from HubConfig" };
  if (!isAbsolute(launcher[0]) || !isAbsolute(launcher[1])) {
    return { ok: false, reason: "missing", detail: "launcher entries must be absolute paths" };
  }

  const startedAt = Date.now();
  const totalLeft = (): number =>
    Math.max(0, Math.min(LAUNCHER_CHECK_TOTAL_MS - (Date.now() - startedAt), deadline.remaining()));
  const stepMs = (): number => Math.max(0, Math.min(STEP_BUDGET_MS, totalLeft()));

  let realpaths: readonly [string, string];
  let stats: readonly [LauncherFingerprint, LauncherFingerprint];
  try {
    const rp0 = await raceDeadline(fs.realpath(launcher[0]), stepMs());
    const rp1 = await raceDeadline(fs.realpath(launcher[1]), stepMs());
    realpaths = [rp0, rp1];
    const st0 = await raceDeadline(fs.stat(rp0), stepMs());
    const st1 = await raceDeadline(fs.stat(rp1), stepMs());
    if (!st0.isFile() || !st1.isFile()) {
      return { ok: false, reason: "not-file", detail: "launcher entry is not a regular file" };
    }
    stats = [
      { realpath: rp0, dev: st0.dev, ino: st0.ino, size: st0.size, mtimeMs: st0.mtimeMs },
      { realpath: rp1, dev: st1.dev, ino: st1.ino, size: st1.size, mtimeMs: st1.mtimeMs },
    ];
  } catch (err) {
    const code = errCode(err);
    if (code === "E_DEADLINE") return { ok: false, reason: "unverifiable", detail: "deadline exhausted" };
    if (code === "ENOENT") return { ok: false, reason: "missing", detail: `launcher path gone (${code})` };
    return { ok: false, reason: "unverifiable", detail: `realpath/stat failed (${code})` };
  }

  const entry = realpaths[1];
  if (!(entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".cjs"))) {
    return { ok: false, reason: "unverifiable", detail: `entry ${entry} is not a .js/.mjs/.cjs script` };
  }

  const version = findPiPackageVersion(entry, fs, totalLeft);
  if (version === undefined) {
    return { ok: false, reason: "unverifiable", detail: `no ${PI_PACKAGE_NAME} package.json within 5 levels` };
  }
  if (!versionInRange(version, SUPPORTED_PI_RANGE.min, SUPPORTED_PI_RANGE.maxExclusive)) {
    return {
      ok: false,
      reason: "incompatible",
      detail: `pi ${version} outside ${SUPPORTED_PI_RANGE.min}..<${SUPPORTED_PI_RANGE.maxExclusive}`,
    };
  }

  return { ok: true, fp: stats, version };
}

/**
 * The per-spawn synchronous re-check (arch §4.2 row 2): `statSync` BOTH fingerprinted realpaths
 * and require dev/ino/size/mtimeMs to match the init-time capture exactly. Any throw or any
 * drift ⇒ `false` ⇒ the caller refuses the fork with `E_LAUNCHER{reason:"changed"}`. Two stats
 * are the whole request-path cost — the package.json is never re-read here.
 */
export function recheckLauncherSync(
  fp: readonly [LauncherFingerprint, LauncherFingerprint],
  fs: LauncherFs = REAL_LAUNCHER_FS,
): boolean {
  for (const want of fp) {
    let st: { dev: number; ino: number; size: number; mtimeMs: number };
    try {
      st = fs.statSync(want.realpath);
    } catch {
      return false;
    }
    if (st.dev !== want.dev || st.ino !== want.ino || st.size !== want.size || st.mtimeMs !== want.mtimeMs) {
      return false;
    }
  }
  return true;
}
