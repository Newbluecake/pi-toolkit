/**
 * hub-side UI root resolution (vue-plan.md v2.1 §2.1 — todo #26 P5a, new module,
 * NOT wired in yet: P5b composes this into `static.ts`'s `createUiServer`).
 *
 * Resolves which on-disk root — the package-bundled `dist/web-hub-ui/`
 * (`packageUiDistDir()`) or the external, version-pinned
 * `~/.pi/agent/web-hub-ui/<hubVersion>/` (`webHubUiDir(home)`) — is safe and
 * version-compatible to serve the Vue UI from, verifying every trust boundary
 * (symlink / owner / mode / manifest hash) *before* any byte is cached for
 * serving. Nothing here does any HTTP serving itself (that is `static.ts`,
 * P5b's job) — this module only decides "is this root trustworthy" and, once
 * it is, hands back the verified bytes in memory so a later server never has
 * to touch disk again for that root (TOCTOU §2.1: "校验时缓存字节，服务只出内存").
 *
 * **Frozen-surface note** (reported per this package's dispatch instructions,
 * not applied here): vue-plan.md §2.1's "诊断" bullet describes `UiStatus` as
 * exported from `src/web-hub/protocol/ui-manifest.ts` (so both this module and
 * the pi-side `/webhub status` formatter share one definition). `ui-manifest.ts`
 * is on the §5.2 frozen-face list (only the main session may edit it after P0),
 * and P5a's own independent-file list does not include it — so `UiStatus` /
 * `UiCandidateResult` / `UiRejectReason` are defined here instead. Proposed
 * diff for the main session, to apply whenever `ui-manifest.ts` next needs a
 * P5b-adjacent edit: move the four type/interface exports below (`UiRejectReason`,
 * `UiCandidateResult`, `UiStatus`, and — if useful there too — `UiCandidateKind`)
 * verbatim into `ui-manifest.ts`, then have this file `import type { ... } from
 * "../protocol/ui-manifest.js"` instead of declaring them locally. No behavior
 * changes either way; this module is not imported by any production code yet,
 * so the move is a pure relocation with zero call-site impact.
 */
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  checkTrustedEntry,
  PrivateDirError,
  packageUiDistDir,
  TRUSTED_FILE_OPEN_FLAGS,
  webHubUiDir,
  type PrivateDirReason,
} from "../protocol/paths.js";
import { UI_MAX_FILES, UI_MAX_TOTAL_BYTES, parseUiBuildInfo, type UiBuildInfo } from "../protocol/ui-manifest.js";
import { withDeadline } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type UiCandidateKind = "package" | "external";

/** A root this process is willing to try (safe, path-injection-checked `dir`). */
export interface UiCandidateSpec {
  readonly kind: UiCandidateKind;
  readonly dir: string;
}

/**
 * Reason vocabulary for a rejected candidate (§2.1's per-check table, folded
 * into one union since callers only ever need "which single reason won").
 * Reuses the *string values* of `paths.ts`'s `PrivateDirReason` where the
 * check is delegated to `checkTrustedEntry` (`symlink` / `not-directory` /
 * `owner-mismatch` / `mode` / `io`) plus this module's own manifest-specific
 * reasons.
 */
export type UiRejectReason =
  | PrivateDirReason
  | "missing"
  | "build-info"
  | "version-mismatch"
  | "proto-mismatch"
  | "version-unsafe"
  | "not-file"
  | "size"
  | "hash"
  | "escape"
  | "too-large"
  | "timeout";

export interface UiCandidateResult {
  readonly kind: UiCandidateKind;
  readonly dir: string;
  readonly reason?: UiRejectReason;
  readonly detail?: string;
}

/** Either a real candidate to try, or one already rejected before touching disk (`version-unsafe`). */
export type UiCandidatePlan =
  { readonly ok: true; readonly spec: UiCandidateSpec } | { readonly ok: false; readonly result: UiCandidateResult };

/**
 * `hub.json`-serializable diagnostic (§2.1's "诊断" bullet). Deliberately
 * carries no file bytes — see `VerifiedUiRoot` for the in-memory serving
 * payload, which a caller keeps separately (`resolveUiRoot`'s `root` field).
 */
export type UiStatus =
  | {
      readonly state: "ok";
      readonly source: UiCandidateKind;
      readonly version: string;
      readonly commit: string;
      readonly builtAt: string;
      readonly candidates: readonly UiCandidateResult[];
    }
  | { readonly state: "unbuilt"; readonly candidates: readonly UiCandidateResult[] };

export interface UiRootExpect {
  /** Must equal `UiBuildInfo.version` (hub's `config.pluginVersion`). */
  readonly version: string;
  /** Must equal `UiBuildInfo.proto.major`. */
  readonly protoMajor: number;
}

/** A single manifest-listed file's verified, already-hashed bytes. */
export interface VerifiedUiFile {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** The in-memory, already-verified payload for a root that passed every check (no `kind` yet — `verifyUiRoot` itself takes a bare `dir`, so the caller that knows which candidate this was, `resolveUiRoot`, attaches `kind`). */
export interface VerifiedUiRootCore {
  readonly dir: string;
  readonly realDir: string;
  readonly info: UiBuildInfo;
  /** Keyed by manifest-relative path (`"index.html"`, `"assets/index-<hash>.js"`, ...). */
  readonly files: ReadonlyMap<string, VerifiedUiFile>;
  /** Root-relative paths present on disk but not listed in the manifest (§2.1 #6 — logged, never fatal). */
  readonly extraFiles: readonly string[];
}

export interface VerifiedUiRoot extends VerifiedUiRootCore {
  readonly kind: UiCandidateKind;
}

export type VerifyUiRootOutcome =
  | { readonly ok: true; readonly root: VerifiedUiRootCore }
  | { readonly ok: false; readonly reason: UiRejectReason; readonly detail?: string };

// ---------------------------------------------------------------------------
// FsDeps
// ---------------------------------------------------------------------------

type FileHandle = Awaited<ReturnType<typeof open>>;

export type UiRootFsDeps = {
  lstat: typeof lstat;
  realpath: typeof realpath;
  open: typeof open;
  readdir: typeof readdir;
  getuid(): number;
};

function defaultUiRootDeps(): UiRootFsDeps {
  return { lstat, realpath, open, readdir, getuid: () => process.getuid?.() ?? 0 };
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function within(root: string, target: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return target === root || target.startsWith(base);
}

function fail(reason: UiRejectReason, detail?: string): VerifyUiRootOutcome {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

// ---------------------------------------------------------------------------
// hub version safety (external candidate path injection guard, §2.1)
// ---------------------------------------------------------------------------

const HUB_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;

/** `version` must be semver-shaped and contain no `".."` before it may be used to build a filesystem path. */
export function isSafeHubVersion(version: string): boolean {
  return HUB_VERSION_RE.test(version) && !version.includes("..");
}

const UNSAFE_VERSION_DETAIL_MAX = 80;

function describeUnsafeVersion(version: string): string {
  const truncated =
    version.length > UNSAFE_VERSION_DETAIL_MAX ? `${version.slice(0, UNSAFE_VERSION_DETAIL_MAX)}…` : version;
  return `unsafe hubVersion (not semver-shaped, or contains ".."): ${JSON.stringify(truncated)}`;
}

/**
 * Builds the two fixed-order candidate plans (§2.1: package, then external).
 * The external candidate is pre-rejected as `version-unsafe` (never touching
 * disk) when `hubVersion` isn't semver-shaped or contains `".."` — path
 * injection guard. `packageDir` is overridable for tests; production callers
 * omit it and get `packageUiDistDir()`.
 */
export function buildUiCandidates(opts: {
  readonly home: string;
  readonly hubVersion: string;
  readonly packageDir?: string;
}): UiCandidatePlan[] {
  const packageDir = opts.packageDir ?? packageUiDistDir();
  const plans: UiCandidatePlan[] = [{ ok: true, spec: { kind: "package", dir: packageDir } }];
  const externalBase = webHubUiDir(opts.home);
  if (isSafeHubVersion(opts.hubVersion)) {
    plans.push({ ok: true, spec: { kind: "external", dir: `${externalBase}/${opts.hubVersion}/` } });
  } else {
    plans.push({
      ok: false,
      result: {
        kind: "external",
        dir: externalBase,
        reason: "version-unsafe",
        detail: describeUnsafeVersion(opts.hubVersion),
      },
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// verifyUiRoot — single candidate directory, §2.1 checks #1–#6
// ---------------------------------------------------------------------------

const BUILD_INFO_NAME = "build-info.json";
const MAX_BUILD_INFO_BYTES = 64 * 1024;

function mapTrustError(err: unknown): VerifyUiRootOutcome {
  if (err instanceof PrivateDirError) return fail(err.reason as UiRejectReason, err.message);
  return fail("io", errMsg(err));
}

/**
 * Verify a single candidate root directory (§2.1 checks #1–#6) and, only on
 * full success, read + hash every manifest file into memory. Never throws —
 * every failure mode (including an fs error) resolves to `{ ok: false, ... }`.
 */
export async function verifyUiRoot(
  dir: string,
  expect: UiRootExpect,
  deps?: Partial<UiRootFsDeps>,
): Promise<VerifyUiRootOutcome> {
  const fs = { ...defaultUiRootDeps(), ...deps };

  // #1 — root lstat: exists, is a directory, is not itself a symlink.
  let rootSt: Awaited<ReturnType<typeof lstat>>;
  try {
    rootSt = await fs.lstat(dir);
  } catch (err) {
    return fail(errCode(err) === "ENOENT" ? "missing" : "io", errMsg(err));
  }
  if (rootSt.isSymbolicLink()) return fail("symlink", `${dir} is a symlink`);
  if (!rootSt.isDirectory()) return fail("not-directory", `${dir} is not a directory`);

  let realRoot: string;
  try {
    realRoot = await fs.realpath(dir);
  } catch (err) {
    return fail("io", errMsg(err));
  }

  // #2 — trust: root itself, its parent, and every direct subdirectory.
  try {
    await checkTrustedEntry(dir, "dir", fs);
    await checkTrustedEntry(dirname(dir), "dir", fs);
  } catch (err) {
    return mapTrustError(err);
  }

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return fail("io", errMsg(err));
  }
  const subdirs: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await fs.lstat(full);
    } catch (err) {
      return fail("io", errMsg(err));
    }
    if (st.isSymbolicLink()) return fail("symlink", `${full} is a symlink`);
    if (st.isDirectory()) subdirs.push(name);
  }
  for (const name of subdirs) {
    try {
      await checkTrustedEntry(join(dir, name), "dir", fs);
    } catch (err) {
      return mapTrustError(err);
    }
  }

  // #3 — build-info.json: O_NOFOLLOW-opened, bounded size, trusted owner/mode, parses.
  const buildInfoPath = join(dir, BUILD_INFO_NAME);
  const infoOutcome = await readTrustedFile(buildInfoPath, MAX_BUILD_INFO_BYTES, fs);
  if (!infoOutcome.ok)
    return fail(infoOutcome.reason === "not-file" ? "build-info" : infoOutcome.reason, infoOutcome.detail);
  let json: unknown;
  try {
    json = JSON.parse(infoOutcome.bytes.toString("utf8"));
  } catch (err) {
    return fail("build-info", `${BUILD_INFO_NAME}: invalid JSON: ${errMsg(err)}`);
  }
  const parsed = parseUiBuildInfo(json);
  if (!parsed.ok) {
    // `parseUiBuildInfo`'s own budget errors are surfaced under this module's dedicated
    // `"too-large"` reason (rather than the generic `"build-info"`) so callers can tell
    // "malformed manifest" apart from "manifest is well-formed but exceeds the byte/file budget".
    const reason: UiRejectReason =
      parsed.error === "too-large" || parsed.error === "too-many-files" ? "too-large" : "build-info";
    return fail(reason, `${BUILD_INFO_NAME}: ${parsed.error}`);
  }
  const info = parsed.info;

  // #4 — version / protocol match.
  if (info.version !== expect.version) return fail("version-mismatch", `${info.version} !== ${expect.version}`);
  if (info.proto.major !== expect.protoMajor)
    return fail("proto-mismatch", `${info.proto.major} !== ${expect.protoMajor}`);

  // #5 — every manifest file: no symlink at any path segment, O_NOFOLLOW read,
  // exact size + sha256 match, realpath containment, cumulative byte budget.
  if (info.files.length > UI_MAX_FILES) return fail("too-large", `${info.files.length} files exceeds ${UI_MAX_FILES}`);
  const files = new Map<string, VerifiedUiFile>();
  let totalBytes = 0;
  for (const entry of info.files) {
    const segmentsOutcome = await checkNoSymlinkSegments(dir, entry.path, fs);
    if (!segmentsOutcome.ok) return fail(segmentsOutcome.reason, segmentsOutcome.detail);
    const filePath = join(dir, entry.path);
    const fileOutcome = await readTrustedFile(filePath, UI_MAX_TOTAL_BYTES, fs);
    if (!fileOutcome.ok) return fail(fileOutcome.reason, fileOutcome.detail);
    if (fileOutcome.bytes.length !== entry.bytes) {
      return fail("size", `${entry.path}: on-disk ${fileOutcome.bytes.length} bytes !== manifest ${entry.bytes}`);
    }
    const sha256 = createHash("sha256").update(fileOutcome.bytes).digest("hex");
    if (sha256 !== entry.sha256) return fail("hash", `${entry.path}: sha256 mismatch`);
    totalBytes += fileOutcome.bytes.length;
    if (totalBytes > UI_MAX_TOTAL_BYTES)
      return fail("too-large", `cumulative ${totalBytes} bytes exceeds ${UI_MAX_TOTAL_BYTES}`);
    let realFile: string;
    try {
      realFile = await fs.realpath(filePath);
    } catch (err) {
      return fail("io", errMsg(err));
    }
    if (!within(realRoot, realFile)) return fail("escape", `${entry.path}: realpath escapes ${realRoot}`);
    files.set(entry.path, { bytes: fileOutcome.bytes, sha256 });
  }

  // #6 — files present on disk but not in the manifest: recorded, never fatal.
  const extraFiles = await listExtraFiles(dir, files, fs);

  return { ok: true, root: { dir, realDir: realRoot, info, files, extraFiles } };
}

type ReadTrustedFileOutcome =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: UiRejectReason; readonly detail?: string };

/**
 * Reads a single already-segment-checked file (`checkNoSymlinkSegments` ran
 * first for a manifest entry; `build-info.json` has no parent segments below
 * the already-trusted root), verifying owner/mode on *every* call — review
 * fix (P1 #1): a manifest file used to skip this check entirely
 * (`skipTrust`), reasoning that `checkNoSymlinkSegments` already ruled out a
 * symlink; that only defeats a symlink swap, not a legitimately-placed
 * group/world-writable or wrong-owner file sitting directly in a trusted
 * directory. Costs nothing extra: the owner/mode fields come from the same
 * `fstat` this function already needs for the size bound.
 *
 * Hang-safety (review fix, P1 #2): a symlink swap is closed by `O_NOFOLLOW`
 * at the `open()` syscall itself, but a *FIFO* (or other special file)
 * swapped in between an earlier `lstat` (`checkNoSymlinkSegments`, or none at
 * all for `build-info.json`) and this `open()` is not a symlink and would
 * make a plain blocking `open(O_RDONLY)` hang forever waiting for a writer
 * that never comes — `withDeadline` only races a timer against the *promise*,
 * it can't cancel an in-flight blocking syscall. This function therefore (a)
 * `lstat`s `path` itself first and rejects anything that isn't a regular
 * file before ever calling `open`, and (b) opens with
 * `TRUSTED_FILE_OPEN_FLAGS` (`O_NOFOLLOW | O_NONBLOCK` where the platform has
 * `O_NONBLOCK`), which makes the `open()` call itself non-blocking regardless
 * of file type, and then `fstat`s the *open handle* and cross-checks
 * `isFile()` plus `dev`/`ino` against the pre-open `lstat` — rejecting a
 * lstat→open swap (TOCTOU: the checked path was atomically replaced with a
 * FIFO between the two calls) that `O_NOFOLLOW` alone would not catch, since
 * the swapped-in target need not itself be a symlink.
 */
async function readTrustedFile(path: string, maxBytes: number, fs: UiRootFsDeps): Promise<ReadTrustedFileOutcome> {
  let preSt: Awaited<ReturnType<typeof lstat>>;
  try {
    preSt = await fs.lstat(path);
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return { ok: false, reason: "not-file", detail: `${path} does not exist` };
    return { ok: false, reason: "io", detail: errMsg(err) };
  }
  if (preSt.isSymbolicLink()) return { ok: false, reason: "symlink", detail: `${path} is a symlink` };
  if (!preSt.isFile()) return { ok: false, reason: "not-file", detail: `${path} is not a regular file` };

  let handle: FileHandle;
  try {
    handle = await fs.open(path, TRUSTED_FILE_OPEN_FLAGS);
  } catch (err) {
    const code = errCode(err);
    if (code === "ELOOP") return { ok: false, reason: "symlink", detail: `${path} is a symlink` };
    if (code === "ENOENT") return { ok: false, reason: "not-file", detail: `${path} does not exist` };
    return { ok: false, reason: "io", detail: errMsg(err) };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== preSt.dev || st.ino !== preSt.ino) {
      return {
        ok: false,
        reason: "not-file",
        detail: `${path}: changed between lstat and open (no longer the same regular file)`,
      };
    }
    if (st.size > maxBytes)
      return { ok: false, reason: "too-large", detail: `${path}: ${st.size} bytes exceeds ${maxBytes}` };
    const uid = fs.getuid();
    if (st.uid !== uid && st.uid !== 0) {
      return { ok: false, reason: "owner-mismatch", detail: `${path} owned by uid ${st.uid}, expected ${uid} or 0` };
    }
    if ((st.mode & 0o022) !== 0) {
      return {
        ok: false,
        reason: "mode",
        detail: `${path} mode ${(st.mode & 0o777).toString(8)} is group/other-writable`,
      };
    }
    const bytes = await handle.readFile();
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, reason: "io", detail: errMsg(err) };
  } finally {
    await handle.close().catch(() => {});
  }
}

type SegmentCheckOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: UiRejectReason; readonly detail?: string };

/** No path segment of `relPath` (walked from `root`) may be a symlink. */
async function checkNoSymlinkSegments(root: string, relPath: string, fs: UiRootFsDeps): Promise<SegmentCheckOutcome> {
  const segments = relPath.split("/");
  let cur = root;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      return { ok: false, reason: "not-file", detail: `${cur}: ${errMsg(err)}` };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: "symlink", detail: `${cur} is a symlink` };
  }
  return { ok: true };
}

/** §2.1 #6: root-relative paths present on disk but absent from the manifest — debug-only, never fatal. */
async function listExtraFiles(
  dir: string,
  verified: ReadonlyMap<string, VerifiedUiFile>,
  fs: UiRootFsDeps,
): Promise<string[]> {
  const extra: string[] = [];
  try {
    const topEntries = await fs.readdir(dir);
    for (const name of topEntries) {
      if (name === BUILD_INFO_NAME) continue;
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await fs.lstat(join(dir, name));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // already rejected candidates never reach here; be conservative anyway
      if (st.isFile()) {
        if (!verified.has(name)) extra.push(name);
        continue;
      }
      if (st.isDirectory()) {
        const nested = await fs.readdir(join(dir, name)).catch(() => []);
        for (const child of nested) {
          const rel = `${name}/${child}`;
          if (!verified.has(rel)) extra.push(rel);
        }
      }
    }
  } catch {
    // best-effort — never fails the candidate for this.
  }
  return extra;
}

// ---------------------------------------------------------------------------
// resolveUiRoot — try candidates in fixed order, first success wins
// ---------------------------------------------------------------------------

export const UI_ROOT_RESOLVE_TIMEOUT_MS = 3000;

export interface ResolveUiRootResult {
  readonly status: UiStatus;
  readonly root?: VerifiedUiRoot;
}

function isDeadlineError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("E_DEADLINE");
}

/**
 * Tries `plans` in order (§2.1: "先到先得"); the whole walk is bounded by one
 * `withDeadline` (default 3s, §2.1's "整个解析 single-flight，外包 withDeadline(3s)"),
 * so a hang on candidate N doesn't block forever even though the underlying
 * per-candidate work isn't itself cancellable — a timeout attributes the
 * `"timeout"` reason to whichever candidate was in flight when the deadline
 * fired, alongside every already-rejected candidate before it.
 */
export async function resolveUiRoot(
  plans: readonly UiCandidatePlan[],
  expect: UiRootExpect,
  deps?: Partial<UiRootFsDeps>,
  opts?: { readonly timeoutMs?: number },
): Promise<ResolveUiRootResult> {
  const timeoutMs = opts?.timeoutMs ?? UI_ROOT_RESOLVE_TIMEOUT_MS;
  const results: UiCandidateResult[] = [];
  let inFlight: UiCandidateSpec | undefined;

  const work = (async (): Promise<ResolveUiRootResult> => {
    for (const plan of plans) {
      if (!plan.ok) {
        results.push(plan.result);
        continue;
      }
      inFlight = plan.spec;
      const outcome = await verifyUiRoot(plan.spec.dir, expect, deps);
      inFlight = undefined;
      if (outcome.ok) {
        const root: VerifiedUiRoot = { ...outcome.root, kind: plan.spec.kind };
        return {
          status: {
            state: "ok",
            source: plan.spec.kind,
            version: root.info.version,
            commit: root.info.commit,
            builtAt: root.info.builtAt,
            candidates: [...results],
          },
          root,
        };
      }
      results.push({
        kind: plan.spec.kind,
        dir: plan.spec.dir,
        reason: outcome.reason,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
    }
    return { status: { state: "unbuilt", candidates: [...results] } };
  })();

  try {
    return await withDeadline(work, timeoutMs);
  } catch (err) {
    if (!isDeadlineError(err)) throw err;
    const timedOut =
      inFlight === undefined
        ? results
        : [...results, { kind: inFlight.kind, dir: inFlight.dir, reason: "timeout" as const }];
    return { status: { state: "unbuilt", candidates: timedOut } };
  }
}

// ---------------------------------------------------------------------------
// createUiRootService — stateful wrapper: single-flight resolve + request-
// triggered "换代" (redeploy) detection (§2.1)
// ---------------------------------------------------------------------------

interface UiRootFingerprint {
  readonly missing: boolean;
  readonly dev?: number;
  readonly ino?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
}

async function fingerprintOf(dir: string, fs: UiRootFsDeps): Promise<UiRootFingerprint> {
  try {
    const st = await fs.lstat(join(dir, BUILD_INFO_NAME));
    return { missing: false, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  } catch {
    return { missing: true };
  }
}

function fingerprintEquals(a: UiRootFingerprint, b: UiRootFingerprint): boolean {
  if (a.missing || b.missing) return a.missing === b.missing;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export const UI_ROOT_PROBE_THROTTLE_MS = 1000;

export interface UiRootService {
  /** Force a full re-resolve (single-flight — concurrent callers share one in-flight resolve). */
  resolve(): Promise<ResolveUiRootResult>;
  /** Last known status, or `undefined` before the first `resolve()`. */
  status(): UiStatus | undefined;
  /** Last known verified root (for serving), or `undefined` when unbuilt / not yet resolved. */
  current(): VerifiedUiRoot | undefined;
  /**
   * Called once per incoming request. Only `"/"` and `"/index.html"` ever
   * probe for a redeploy (§2.1: "资源请求不触发"); a probe itself only runs
   * when `probeThrottleMs` (default 1s) has elapsed since the last one, and
   * only re-resolves when a candidate's `build-info.json` fingerprint
   * actually changed since the last resolve.
   */
  maybeRefresh(urlPath: string): Promise<ResolveUiRootResult>;
}

/**
 * Wraps `resolveUiRoot` with the persistent state `static.ts` (P5b) will need
 * to serve from a cache and only re-verify on an actual redeploy. Not wired
 * into any server yet — this package (P5a) only builds the primitive.
 */
export function createUiRootService(
  plans: readonly UiCandidatePlan[],
  expect: UiRootExpect,
  deps?: Partial<UiRootFsDeps>,
  opts?: { readonly probeThrottleMs?: number; readonly timeoutMs?: number; readonly now?: () => number },
): UiRootService {
  const fs = { ...defaultUiRootDeps(), ...deps };
  const probeThrottleMs = opts?.probeThrottleMs ?? UI_ROOT_PROBE_THROTTLE_MS;
  const timeoutMs = opts?.timeoutMs ?? UI_ROOT_RESOLVE_TIMEOUT_MS;
  const now = opts?.now ?? (() => Date.now());

  let lastResult: ResolveUiRootResult | undefined;
  let lastProbeAt = -Infinity;
  let fingerprints = new Map<string, UiRootFingerprint>();
  let pending: Promise<ResolveUiRootResult> | undefined;

  async function snapshotFingerprints(): Promise<Map<string, UiRootFingerprint>> {
    const next = new Map<string, UiRootFingerprint>();
    for (const plan of plans) {
      if (plan.ok) next.set(plan.spec.dir, await fingerprintOf(plan.spec.dir, fs));
    }
    return next;
  }

  function resolve(): Promise<ResolveUiRootResult> {
    if (pending !== undefined) return pending;
    const run = (async (): Promise<ResolveUiRootResult> => {
      const result = await resolveUiRoot(plans, expect, fs, { timeoutMs });
      lastResult = result;
      fingerprints = await snapshotFingerprints();
      lastProbeAt = now(); // a resolve establishes a fresh probe baseline, same as an explicit maybeRefresh probe would
      return result;
    })();
    pending = run.finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function probeChanged(): Promise<boolean> {
    const fresh = await snapshotFingerprints();
    if (fresh.size !== fingerprints.size) return true;
    for (const [dir, fp] of fresh) {
      const prev = fingerprints.get(dir);
      if (prev === undefined || !fingerprintEquals(prev, fp)) return true;
    }
    return false;
  }

  return {
    resolve,
    status: () => lastResult?.status,
    current: () => lastResult?.root,
    async maybeRefresh(urlPath: string): Promise<ResolveUiRootResult> {
      if (lastResult === undefined) return resolve();
      if (urlPath !== "/" && urlPath !== "/index.html") return lastResult;
      const t = now();
      if (t - lastProbeAt < probeThrottleMs) return lastResult;
      lastProbeAt = t;
      const changed = await probeChanged();
      if (!changed) return lastResult;
      return resolve();
    },
  };
}
