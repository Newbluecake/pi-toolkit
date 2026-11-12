/** Test-only secure preflight. No env bypass; explicit deps are the only synthetic seam. */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { acquireGocryptfsTestLock } from "./gocryptfs-test-lock.js";
import { DEFAULT_REAL_GOCRYPTFS, type RealGocryptfsResolution } from "./real-tool-path.js";

// ---------------------------------------------------------------------------
// Verdict types (must stay JSON-serializable: they cross the provide/inject RPC boundary)
// ---------------------------------------------------------------------------

export type PreflightState = "incapable" | "clean" | "external-mounts" | "dirty";

export interface SecureEnvVerdict {
  readonly state: PreflightState;
  /** D8 level 1: linux + gocryptfs + fusermount3 on PATH (any real block may run). */
  readonly fuse: boolean;
  /** D8 level 2: the real blocks with `--private`/unshare may run (level 1 ⊂ level 2). */
  readonly private: boolean;
  /** Dirty only. "<code>: <detail>" — codes: run-lock-unsafe, concurrent-run,
   *  symlinked-tmpdir, preflight-error. */
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
  readonly externalMountPoints: readonly string[];
}

declare module "vitest" {
  export interface ProvidedContext {
    secureEnv: SecureEnvVerdict;
  }
}

export interface SecureCapability {
  readonly fuse: boolean;
  readonly private: boolean;
}

/** Missing/inaccessible FUSE is expected; unexpected filesystem errors are not unavailability. */
export function probeFuseDevice(
  deps = {
    isCharacterDevice: () => statSync("/dev/fuse").isCharacterDevice(),
    access: () => accessSync("/dev/fuse", constants.R_OK | constants.W_OK),
  },
): boolean {
  try {
    if (!deps.isCharacterDevice()) return false;
    deps.access();
    return true;
  } catch (error) {
    if (["ENOENT", "ENODEV", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Bounded real adapter. Expected unavailable capabilities are not probe failures. */
export interface CapabilityProbeDeps {
  platform: string;
  gocryptfs: RealGocryptfsResolution;
  fuseUsable(): boolean;
  spawn(cmd: string, args: string[]): { status: number | null; signal: string | null; error?: Error; stderr?: string };
}
const capabilityProbeDeps: CapabilityProbeDeps = {
  platform: process.platform,
  gocryptfs: DEFAULT_REAL_GOCRYPTFS,
  fuseUsable: probeFuseDevice,
  spawn: (cmd, args) =>
    spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    }),
};
export function detectSecureCapability(deps: CapabilityProbeDeps = capabilityProbeDeps): SecureCapability {
  if (deps.platform !== "linux") return { fuse: false, private: false };
  const probe = (cmd: string, args: string[]): { status: number; stderr: string } => {
    const r = deps.spawn(cmd, args);
    if (r.error || r.signal || r.status === null)
      throw new Error(`capability probe ${cmd}: ${r.error?.message ?? r.signal ?? "no exit status"}`);
    return { status: r.status, stderr: r.stderr ?? "" };
  };
  const has = (cmd: string): boolean => {
    const r = probe("sh", ["-c", `command -v ${cmd}`]);
    if (r.status === 0) return true;
    if (r.status === 1 && !r.stderr.trim()) return false;
    throw new Error(`capability lookup ${cmd}: exit ${r.status}: ${r.stderr}`);
  };
  if (!deps.gocryptfs.binding && deps.gocryptfs.reason !== "missing gocryptfs")
    throw new Error(`capability binding: ${deps.gocryptfs.reason}`);
  if (!deps.gocryptfs.binding || !has("fusermount3")) return { fuse: false, private: false };
  const missingPrivate = ["flock", "script", "unshare", "umount"].map(has).some((found) => !found);
  const fuse = deps.fuseUsable();
  if (missingPrivate || !fuse) return { fuse: true, private: false };
  const ns = probe("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "true"]);
  if (ns.status === 0) return { fuse: true, private: true };
  if (
    ns.status === 1 &&
    /^unshare: (?:unshare failed: )?(?:Operation not permitted|Permission denied|Operation not supported|Function not implemented)\s*$/.test(
      ns.stderr,
    )
  )
    return { fuse: true, private: false };
  throw new Error(`capability namespace probe: exit ${ns.status}: ${ns.stderr}`);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** D11: literal /tmp — per machine, per uid; never TMPDIR- or scratch-root-derived. */
export function runLockPath(uid: number = process.getuid?.() ?? 0): string {
  return `/tmp/pi-toolkit-secure-tests-${uid}.lock`;
}

const MOUNT_UNESCAPES: Record<string, string> = { "040": " ", "011": "\t", "012": "\n", "134": "\\" };

function unescapeMountPoint(point: string): string {
  return point.replace(/\\(040|011|012|134)/g, (m) => MOUNT_UNESCAPES[m.slice(1)] ?? m);
}

/** Mount points of every fuse.gocryptfs mount in a /proc/self/mountinfo text (D10). */
export function gocryptfsMountPoints(mountinfo: string): string[] {
  const points: string[] = [];
  for (const line of mountinfo.split("\n")) {
    const sep = line.lastIndexOf(" - ");
    if (sep < 0) continue;
    const point = line.slice(0, sep).split(" ")[4];
    if (point === undefined) continue;
    const fstype = line.slice(sep + 3).split(" ")[0];
    if (fstype === "fuse.gocryptfs") points.push(unescapeMountPoint(point));
  }
  return points;
}

export interface TmpRootFacts {
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  readonly uid: number;
  readonly sticky: boolean;
}

/** D11 /tmp validation. null = safe; else the `run-lock-unsafe` detail. */
export function tmpRootUnsafe(f: TmpRootFacts): string | null {
  if (f.isSymlink) return "/tmp itself is a symlink, but the run lock targets the literal /tmp";
  if (!f.isDirectory) return "/tmp is not a directory";
  if (f.uid !== 0) return `/tmp is owned by uid ${f.uid}, not root`;
  if (!f.sticky) return "/tmp lacks the sticky bit";
  return null;
}

export interface LockFileFacts {
  readonly isSymlink: boolean;
  readonly isRegular: boolean;
  readonly uid: number;
  readonly mode: number;
}

/** D11 lock-file validation. null = safe; else the `run-lock-unsafe` detail. */
export function runLockFileUnsafe(f: LockFileFacts, myUid: number): string | null {
  if (f.isSymlink) return "the lock file is a symlink — refusing to follow it";
  if (!f.isRegular) return "the lock file is not a regular file";
  if (f.uid !== myUid) return `the lock file is owned by uid ${f.uid}, expected ${myUid}`;
  if ((f.mode & 0o022) !== 0) return `lock mode 0${f.mode.toString(8)} is group/other-writable`;
  return null;
}

// ---------------------------------------------------------------------------
// The pure verdict (D9/D10) — every input injectable
// ---------------------------------------------------------------------------

export type RunLockOutcome =
  | { readonly status: "skipped" }
  | { readonly status: "acquired" }
  | { readonly status: "busy"; readonly holder: string }
  | { readonly status: "unsafe"; readonly why: string };

export interface PreflightInput {
  readonly capability: SecureCapability;
  readonly mountinfo: string;
  readonly tmp: { readonly tmpdir: string; readonly realTmpdir: string };
  readonly runLock: RunLockOutcome;
  readonly unreadableCount: number;
}

export function secureEnvVerdict(input: PreflightInput): SecureEnvVerdict {
  const fuse = input.capability.fuse;
  const priv = input.capability.private;
  if (!fuse)
    return { state: "incapable", fuse: false, private: false, reasons: [], notes: [], externalMountPoints: [] };

  const reasons: string[] = [];
  const notes: string[] = [];
  if (input.runLock.status === "unsafe") {
    reasons.push(`run-lock-unsafe: ${input.runLock.why}`);
  } else if (input.runLock.status === "busy") {
    reasons.push(
      `concurrent-run: ${runLockPath()} is held by another secure test round (${input.runLock.holder}); ` +
        "wait for that round to finish, then rerun",
    );
  }
  const mounts = gocryptfsMountPoints(input.mountinfo);
  if (input.tmp.realTmpdir !== input.tmp.tmpdir) {
    reasons.push(`symlinked-tmpdir: TMPDIR root ${input.tmp.tmpdir} resolves to ${input.tmp.realTmpdir}`);
  }
  if (input.unreadableCount > 0) {
    notes.push(
      `unreadable same-uid processes: ${input.unreadableCount} (counted only, D12 — the launcher's ` +
        "unreadable-idle gate still applies in-run)",
    );
  }
  return {
    state: reasons.length > 0 ? "dirty" : mounts.length > 0 ? "external-mounts" : "clean",
    fuse,
    private: priv,
    reasons,
    notes,
    externalMountPoints: mounts,
  };
}

/** The `preflight-error` dirty verdict used whenever the probe itself fails (fail closed). */
export function preflightErrorVerdict(message: string): SecureEnvVerdict {
  return {
    state: "dirty",
    fuse: false,
    private: false,
    reasons: [`preflight-error: ${message}`],
    notes: [],
    externalMountPoints: [],
  };
}

// ---------------------------------------------------------------------------
// Rendering (identical text for the global-setup print and the worker's thrown error)
// ---------------------------------------------------------------------------

function fixHintFor(reason: string): string {
  if (reason.startsWith("concurrent-run")) {
    return "another secure test round holds the per-machine run lock — wait for it to finish, then rerun.";
  }
  if (reason.startsWith("symlinked-tmpdir")) {
    return "set TMPDIR to a physical path or unset it (the underlying launcher-root defect is #28).";
  }
  if (reason.startsWith("run-lock-unsafe")) {
    return "inspect and repair the offending /tmp or lock-file condition described above, then rerun.";
  }
  if (reason.startsWith("preflight-error")) {
    return "the preflight probe itself failed — this is a bug or a broken environment, not a flake; fix it before rerunning.";
  }
  return "resolve the condition described above, then rerun.";
}

export function renderPreflightFailure(v: SecureEnvVerdict): string {
  const lines = [
    `[secure-preflight] the secure project will not run: the environment is dirty ` +
      `(${v.reasons.length} reason${v.reasons.length === 1 ? "" : "s"}).`,
  ];
  for (const r of v.reasons) {
    lines.push(`  - ${r}`);
    lines.push(`    fix: ${fixHintFor(r)}`);
  }
  if (v.externalMountPoints.length)
    lines.push(`  external mounts (not the only error): ${JSON.stringify(v.externalMountPoints)}`);
  if (v.notes.length > 0) lines.push(`  notes: ${v.notes.join(" | ")}`);
  lines.push("  This is an environment failure, not a test flake — fix the environment, then rerun.");
  return lines.join("\n");
}

/** The single summary line the global setup prints on a clean verdict (D9). */
export function renderCleanLine(v: SecureEnvVerdict, lockPath: string): string {
  const notes = v.notes.length > 0 ? ` — ${v.notes.join(" | ")}` : "";
  return `[secure-preflight] clean (fuse=${v.fuse}, private=${v.private}); run lock held: ${lockPath}${notes}`;
}

/** Validate the entire wire contract; never infer skip eligibility from prose. */
export function validateSecureEnv(value: unknown): SecureEnvVerdict {
  const bad = (why: string): never => {
    throw new Error(`[secure-preflight] wiring error: ${why}`);
  };
  if (value === undefined) return bad("`secureEnv` was not provided to this worker");
  if (!value || typeof value !== "object") return bad("invalid secureEnv schema");
  const o = value as Record<string, unknown>;
  if (
    typeof o.state !== "string" ||
    !["incapable", "clean", "external-mounts", "dirty"].includes(o.state) ||
    typeof o.fuse !== "boolean" ||
    typeof o.private !== "boolean"
  )
    return bad("invalid secureEnv schema");
  for (const key of ["reasons", "notes", "externalMountPoints"])
    if (
      !Array.isArray(o[key]) ||
      (o[key] as unknown[]).some((x) => typeof x !== "string" || (key === "externalMountPoints" && !x))
    )
      return bad(`invalid secureEnv ${key}`);
  const v = o as unknown as SecureEnvVerdict;
  if (v.private && !v.fuse) return bad("private requires fuse");
  if (v.state === "dirty" ? !v.reasons.length : v.reasons.length > 0) return bad("inconsistent reasons");
  if (
    v.state === "external-mounts"
      ? !v.fuse || !v.externalMountPoints.length
      : v.state !== "dirty" && v.externalMountPoints.length > 0
  )
    return bad("inconsistent externalMountPoints");
  if (v.state === "incapable" ? v.fuse : v.state !== "dirty" && !v.fuse) return bad("inconsistent capability");
  return v;
}

export function renderExternalSkip(v: SecureEnvVerdict): string {
  return (
    `[secure-preflight] SKIP secure project: external gocryptfs mount(s): ${JSON.stringify(v.externalMountPoints)}; ` +
    "secure mount coverage NOT RUN; no mount was changed."
  );
}

// ---------------------------------------------------------------------------
// Real probing (impure; every seam injectable for the unit tests)
// ---------------------------------------------------------------------------

export interface PreflightDeps {
  capability(): SecureCapability;
  probeRunLock(): Promise<{ outcome: RunLockOutcome; release: (() => void) | undefined }>;
  readMountinfo(): string;
  tmpPair(): { tmpdir: string; realTmpdir: string };
  countUnreadable(): number;
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort one-line holder description for the busy case (D10/D13). Reads the D13 sidecar
 * `<lock>.holder.json` (written by the lock helper once #27 P3 lands; before that — and on any
 * missing/corrupt sidecar, dead pid or starttime mismatch — "holder unknown"). Kept local on
 * purpose: P2 must not depend on P3's in-flight exports; P4 may dedupe. One sync ≤4 KiB read,
 * never throws, no timers.
 */
function describeRunLockHolder(lockPath: string): string {
  try {
    const raw = readFileSync(`${lockPath}.holder.json`, "utf8").slice(0, 4096);
    const m = JSON.parse(raw) as { pid?: unknown; starttime?: unknown; vitestPid?: unknown; file?: unknown };
    if (typeof m.pid !== "number" || typeof m.starttime !== "string") return "holder unknown";
    const stat = readFileSync(`/proc/${m.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[19] !== m.starttime) return "holder unknown"; // gone or pid reuse
    return `holder pid ${m.pid} (vitest pid ${String(m.vitestPid)}, file ${String(m.file)})`;
  } catch {
    return "holder unknown";
  }
}

/** Validate /tmp and the lock file (D11), creating the lock file 0600 when absent. */
export function prepareRunLock(lockPath: string = runLockPath()): { ok: true } | { ok: false; why: string } {
  try {
    const t = lstatSync("/tmp");
    const tmpWhy = tmpRootUnsafe({
      isSymlink: t.isSymbolicLink(),
      isDirectory: t.isDirectory(),
      uid: t.uid,
      sticky: (t.mode & 0o1000) !== 0,
    });
    if (tmpWhy !== null) return { ok: false, why: tmpWhy };
  } catch (e) {
    return { ok: false, why: `cannot stat /tmp: ${errString(e)}` };
  }
  const myUid = process.getuid?.() ?? 0;
  try {
    const st = lstatSync(lockPath); // lstat on purpose: a symlinked lock file must fail, not be followed
    const why = runLockFileUnsafe(
      { isSymlink: st.isSymbolicLink(), isRegular: st.isFile(), uid: st.uid, mode: st.mode },
      myUid,
    );
    if (why !== null) return { ok: false, why: `${why} (${lockPath})` };
    return { ok: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, why: `cannot stat ${lockPath}: ${errString(e)}` };
    }
  }
  try {
    closeSync(openSync(lockPath, "wx", 0o600)); // create with exactly 0600 (umask can only narrow it)
    return { ok: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { ok: true }; // created concurrently
    return { ok: false, why: `cannot create ${lockPath} with mode 0600: ${errString(e)}` };
  }
}

/**
 * D8's unreadable-process census (D12): same-uid /proc entries whose ns link cannot be read
 * (EACCES/EPERM — non-dumpable), mirroring the launcher's unreadable-idle gate. Counted and
 * noted only — never a dirty reason, and no product switch is added for it.
 */
export interface CensusDeps {
  uid: number;
  names(): string[];
  owner(path: string): number;
  readlink(path: string): string;
}
export function countUnreadableSameUidProcesses(
  deps: CensusDeps = {
    uid: process.getuid?.() ?? 0,
    names: () => readdirSync("/proc"),
    owner: (path) => statSync(path).uid,
    readlink: readlinkSync,
  },
): number {
  // Enumeration failure is never a successful empty census.
  const names = deps.names();
  let n = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (deps.owner(`/proc/${name}`) !== deps.uid) continue;
      deps.readlink(`/proc/${name}/ns/mnt`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") n++;
      else if (code !== "ENOENT" && code !== "ESRCH") throw e;
    }
  }
  return n;
}

async function probeRunLockReal(): Promise<{ outcome: RunLockOutcome; release: (() => void) | undefined }> {
  const lockPath = runLockPath();
  const prep = prepareRunLock(lockPath);
  if (!prep.ok) return { outcome: { status: "unsafe", why: prep.why }, release: undefined };
  try {
    const release = await acquireGocryptfsTestLock(1_000, lockPath);
    return { outcome: { status: "acquired" }, release };
  } catch (e) {
    return { outcome: { status: "busy", holder: describeRunLockHolder(lockPath) }, release: undefined };
  }
}

export const realPreflightDeps: PreflightDeps = {
  capability: detectSecureCapability,
  probeRunLock: probeRunLockReal,
  readMountinfo: () => readFileSync("/proc/self/mountinfo", "utf8"),
  tmpPair: () => {
    const t = tmpdir();
    return { tmpdir: t, realTmpdir: realpathSync(t) };
  },
  countUnreadable: countUnreadableSameUidProcesses,
};

export interface PreflightResult {
  readonly verdict: SecureEnvVerdict;
  readonly release: (() => void) | undefined;
}

/** Full pipeline; env is deliberately ignored (legacy FAKE/disabled inputs are not authority). */
export async function runPreflight(
  _env: NodeJS.ProcessEnv,
  deps: PreflightDeps = realPreflightDeps,
): Promise<PreflightResult> {
  let release: (() => void) | undefined;
  try {
    const capability = deps.capability();
    if (!capability.fuse) {
      return {
        verdict: secureEnvVerdict({
          capability,
          mountinfo: "",
          tmp: { tmpdir: "", realTmpdir: "" },
          runLock: { status: "skipped" },
          unreadableCount: 0,
        }),
        release,
      };
    }
    const lock = await deps.probeRunLock();
    release = lock.release;
    const verdict = secureEnvVerdict({
      capability,
      mountinfo: deps.readMountinfo(),
      tmp: deps.tmpPair(),
      runLock: lock.outcome,
      unreadableCount: deps.countUnreadable(),
    });
    return { verdict, release };
  } catch (e) {
    return { verdict: preflightErrorVerdict(errString(e)), release };
  }
}
