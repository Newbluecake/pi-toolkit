/**
 * Secure-project preflight — #27 P2 (docs/dev/test-speed/plan.md r3 §1 D8–D11).
 *
 * The `secure` vitest project (the 16 real-mount files) hangs its globalSetup/setupFiles on
 * this module via tests/setup/secure-preflight.{global,setup}.ts. The verdict contract (D9):
 *
 *   incapable — no FUSE stack (CI, non-linux): no lock, no checks, worker no-op (byte-identical
 *               with the pre-#27 behaviour; the real blocks keep self-skipping as before);
 *   disabled  — PI_TOOLKIT_SECURE_PREFLIGHT=0: startup preflight only is off (the in-run D14
 *               check is NOT switchable); no lock, no checks, worker no-op;
 *   clean     — fuse present and every check passed: the run lock is held until teardown;
 *   dirty     — any reason below: workers fail every secure file at the file-level beforeAll
 *               with a `[secure-preflight]` error carrying the fix commands.
 *
 * Every normal exit of the global setup provides the verdict FIRST (D9; r1 review #1); an
 * internal exception becomes a `preflight-error` dirty verdict — fail closed, never "no verdict".
 *
 * Checks run when ANY real block of the project may execute, i.e. at the D8 `fuse` level
 * (linux + gocryptfs + fusermount3 on PATH — deliberately wider than `private`, because
 * launcher-fuse / helper-v0-api / launcher-off-golden do not need unshare). At fuse level the
 * `gocryptfs-mounted` finding is only a NOTE; it is a dirty REASON only at the `private` level
 * (run --private refuses EVERY gocryptfs mount in the namespace, including the user's own
 * vaults — D10; the fix hint names `pi-secure lock` / `pi-secure status` / `fusermount3 -u`).
 *
 * The run lock (D11) lives at the literal /tmp — per machine, per uid — never derived from
 * TMPDIR or the scratch root: /tmp is validated (root-owned, sticky) and the lock file must be
 * a regular file owned by the current uid without group/other write, else `run-lock-unsafe`.
 * The per-suite GOCRYPTFS_TEST_LOCK (in tmpdir()) is untouched. Transition risk: rounds started
 * with pre-P2 code hold no run lock, so old × new concurrency is unprotected (README material).
 *
 * This file is test infrastructure only — never imported from src/**. It reads two env vars,
 * both test-side: PI_TOOLKIT_SECURE_PREFLIGHT (0 = disable the startup preflight) and
 * PI_TOOLKIT_SECURE_PREFLIGHT_FAKE (a JSON verdict injected by tests; never read elsewhere).
 * No new timers are created here (I5); the lock holder is a child process with pdeathsig.
 */
import {
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
import { realSkipReason, which } from "./private-real-harness.js";

// ---------------------------------------------------------------------------
// Verdict types (must stay JSON-serializable: they cross the provide/inject RPC boundary)
// ---------------------------------------------------------------------------

export type PreflightState = "incapable" | "disabled" | "clean" | "dirty";

export interface SecureEnvVerdict {
  readonly state: PreflightState;
  /** D8 level 1: linux + gocryptfs + fusermount3 on PATH (any real block may run). */
  readonly fuse: boolean;
  /** D8 level 2: the real blocks with `--private`/unshare may run (level 1 ⊂ level 2). */
  readonly private: boolean;
  /** Dirty only. "<code>: <detail>" — codes: run-lock-unsafe, concurrent-run, gocryptfs-mounted,
   *  symlinked-tmpdir, preflight-error. */
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
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

/** The real D8 probe (spawns only `sh -c 'command -v …'` style checks; no side effects). */
export function detectSecureCapability(): SecureCapability {
  if (process.platform !== "linux") return { fuse: false, private: false };
  if (!which("gocryptfs") || !which("fusermount3")) return { fuse: false, private: false };
  return { fuse: true, private: realSkipReason() === "" };
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
  readonly disabled: boolean;
  readonly capability: SecureCapability;
  readonly mountinfo: string;
  readonly tmp: { readonly tmpdir: string; readonly realTmpdir: string };
  readonly runLock: RunLockOutcome;
  readonly unreadableCount: number;
}

export function secureEnvVerdict(input: PreflightInput): SecureEnvVerdict {
  const fuse = input.capability.fuse;
  const priv = input.capability.private;
  if (input.disabled) {
    return {
      state: "disabled",
      fuse,
      private: priv,
      reasons: [],
      notes: ["PI_TOOLKIT_SECURE_PREFLIGHT=0 — startup preflight off; in-run checks (plan D14) stay active"],
    };
  }
  if (!fuse) return { state: "incapable", fuse: false, private: false, reasons: [], notes: [] };

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
  if (mounts.length > 0) {
    if (priv) {
      reasons.push(`gocryptfs-mounted: ${mounts.join(", ")}`);
    } else {
      notes.push(
        `gocryptfs mounts present (${mounts.join(", ")}) — note only: private capability is absent, ` +
          "so the run --private blocks self-skip anyway",
      );
    }
  }
  if (input.tmp.realTmpdir !== input.tmp.tmpdir) {
    reasons.push(`symlinked-tmpdir: TMPDIR root ${input.tmp.tmpdir} resolves to ${input.tmp.realTmpdir}`);
  }
  if (input.unreadableCount > 0) {
    notes.push(
      `unreadable same-uid processes: ${input.unreadableCount} (counted only, D12 — the launcher's ` +
        "unreadable-idle gate still applies in-run)",
    );
  }
  return { state: reasons.length > 0 ? "dirty" : "clean", fuse, private: priv, reasons, notes };
}

/** The `preflight-error` dirty verdict used whenever the probe itself fails (fail closed). */
export function preflightErrorVerdict(message: string): SecureEnvVerdict {
  return { state: "dirty", fuse: false, private: false, reasons: [`preflight-error: ${message}`], notes: [] };
}

// ---------------------------------------------------------------------------
// Rendering (identical text for the global-setup print and the worker's thrown error)
// ---------------------------------------------------------------------------

function fixHintFor(reason: string): string {
  if (reason.startsWith("concurrent-run")) {
    return "another secure test round holds the per-machine run lock — wait for it to finish, then rerun.";
  }
  if (reason.startsWith("gocryptfs-mounted")) {
    return (
      "before a release or a secure run, unmount every gocryptfs mount listed above: " +
      "`pi-secure lock <name>` (run `pi-secure status` first if you do not know the name), or " +
      "`fusermount3 -u <mountpoint>`. Your own vaults count too — run --private refuses EVERY " +
      "gocryptfs mount in the current mount namespace; the preflight never unmounts anything itself."
    );
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
  if (v.notes.length > 0) lines.push(`  notes: ${v.notes.join(" | ")}`);
  lines.push("  This is an environment failure, not a test flake — fix the environment, then rerun.");
  return lines.join("\n");
}

/** The single summary line the global setup prints on a clean verdict (D9). */
export function renderCleanLine(v: SecureEnvVerdict, lockPath: string): string {
  const notes = v.notes.length > 0 ? ` — ${v.notes.join(" | ")}` : "";
  return `[secure-preflight] clean (fuse=${v.fuse}, private=${v.private}); run lock held: ${lockPath}${notes}`;
}

// ---------------------------------------------------------------------------
// Fake injection (tests only; PI_TOOLKIT_SECURE_PREFLIGHT_FAKE is never read outside tests/)
// ---------------------------------------------------------------------------

export function parseFakeVerdict(raw: string): SecureEnvVerdict {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: not an object");
  }
  const o = parsed as Record<string, unknown>;
  const states: readonly PreflightState[] = ["incapable", "disabled", "clean", "dirty"];
  if (typeof o.state !== "string" || !states.includes(o.state as PreflightState)) {
    throw new Error("PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: bad state");
  }
  if (typeof o.fuse !== "boolean" || typeof o.private !== "boolean") {
    throw new Error("PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: fuse/private must be booleans");
  }
  for (const key of ["reasons", "notes"] as const) {
    const arr = o[key];
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
      throw new Error(`PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: ${key} must be a string array`);
    }
  }
  return {
    state: o.state as PreflightState,
    fuse: o.fuse,
    private: o.private,
    reasons: [...(o.reasons as string[])],
    notes: [...(o.notes as string[])],
  };
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
export function countUnreadableSameUidProcesses(): number {
  const myUid = process.getuid?.() ?? 0;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== myUid) continue;
      readlinkSync(`/proc/${name}/ns/mnt`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") n++; // ENOENT = raced exit, not unreadable
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

/**
 * The full preflight pipeline. NEVER throws: any failure (including a malformed
 * PI_TOOLKIT_SECURE_PREFLIGHT_FAKE) becomes a `preflight-error` dirty verdict — fail closed
 * (D9). Order: test fake → disabled switch → capability → (fuse only) run lock, mounts, TMPDIR,
 * unreadable census. Disabled and incapable never touch the run lock.
 */
export async function runPreflight(
  env: NodeJS.ProcessEnv,
  deps: Pick<
    PreflightDeps,
    "capability" | "probeRunLock" | "readMountinfo" | "tmpPair" | "countUnreadable"
  > = realPreflightDeps,
): Promise<PreflightResult> {
  let release: (() => void) | undefined;
  try {
    const fake = env.PI_TOOLKIT_SECURE_PREFLIGHT_FAKE;
    if (fake !== undefined && fake !== "") {
      return { verdict: parseFakeVerdict(fake), release }; // test injection wins; never probes
    }
    const disabled = env.PI_TOOLKIT_SECURE_PREFLIGHT === "0";
    const capability = deps.capability();
    if (disabled || !capability.fuse) {
      // no lock, no checks (D9) — the skipped inputs are placeholders the verdict ignores
      const verdict = secureEnvVerdict({
        disabled,
        capability,
        mountinfo: "",
        tmp: { tmpdir: "", realTmpdir: "" },
        runLock: { status: "skipped" },
        unreadableCount: 0,
      });
      return { verdict, release };
    }
    const lock = await deps.probeRunLock();
    release = lock.release;
    const verdict = secureEnvVerdict({
      disabled,
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
