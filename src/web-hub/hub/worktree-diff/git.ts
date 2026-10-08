/**
 * worktree-diff plan §1.7/§1.8/§2.3 (D3): the pinned-git execution core shared by every
 * worktree-diff route phase.
 *
 * What lives here and nowhere else:
 * - `PinSet` — the three directory handles (worktree fd 3 / gitdir fd 4 / commondir fd 5) plus
 *   the membership-verified `dev:ino` identity, with the two ownership rules of §2.3/§1.10:
 *   `release()` is the request ⑬'s exactly-once bounded close (three parallel `boundedClose`,
 *   each its own ≤1 s deadline, never the request's signal), and `withLoan()` keeps the pins
 *   open past `release()` while a single-flight execution (changeset / C4) is still running on
 *   them — the loan's finally is then the one that closes.
 * - `runAdmissionGit` — C1a/C1 (the ONLY unpinned commands: repo locate + membership, run in
 *   `session.cwd` during the admission phase, never reading workspace content).
 * - `createPinnedGit` — every other command (C0/Cc/C2/Ca/C3/C4): pre-spawn `fstat` re-verify of
 *   all three pins (ONE previewFsStep; a mismatch is an implementation-defect tripwire ⇒ 500,
 *   I14) then the run with `envPolicy:"minimal"`, the fixed PATH, the pin fds and the request
 *   signal. Budgets are ALWAYS `min(capMs, deadline.remaining())` — §1.9's single-step rule.
 * - `readProcFdFile` — the bounded open+read+close of one file THROUGH a pinned fd
 *   (`/proc/self/fd/N/...`): the `.git` pointer (§2.3, ≤4 KiB) and `$GIT_COMMON_DIR/info/
 *   attributes` (§2.6.2 L2, ≤64 KiB). Plain `O_RDONLY` (PREVIEW_TASK_OPEN_FLAGS) — the procfs
 *   magic symlink would ELOOP under `O_NOFOLLOW`; the fd number is our own handle's.
 * - `attrSigOf` / `indexStatOf` — the two changeset-cache-key inputs (§1.10).
 *
 * Discipline (source-scan pinned): no `node:fs*`/`node:child_process` imports; the ONLY direct
 * `run(` call sites are `runAdmissionGit` (2×) and the pinned wrapper (1×), each carrying
 * `envPolicy:"minimal"`, `signal` and — for the pinned one — `pins`; every argv handed in comes
 * from `wtDiffArgs.*` / `neutralizeArgs` (src/git/diff.ts, D1 frozen).
 */

import { createHash } from "node:crypto";

import { WTDIFF_GIT_PATH } from "../../../git/diff.js";
import type { GitRunResult, GitRunner } from "../../../git/run.js";
import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import type { PreviewFs, PreviewHandle } from "../preview/admit.js";
import {
  boundedClose,
  isPreviewIoError,
  PREVIEW_TASK_OPEN_FLAGS,
  previewFsStep,
  type PreviewIoTracker,
} from "../preview/fs.js";
import { WTDIFF_STEP_MS } from "../../protocol/worktree-diff.js";

// ---------------------------------------------------------------------------
// PinSet (§2.3 所有权 / §1.10 loan)
// ---------------------------------------------------------------------------

export interface PinId {
  dev: number;
  ino: number;
}

export interface PinIds {
  wt: PinId;
  git: PinId;
  common: PinId;
}

export interface PinTriple {
  wt: PreviewHandle;
  git: PreviewHandle;
  common: PreviewHandle;
}

/**
 * §2.3: on membership success the three pins' ownership transfers to the request handler, whose
 * ⑬ finally is the SINGLE closer (`release()`, idempotent). A single-flight execution that runs
 * git on these pins takes a `withLoan()` — the pins then stay open until the LAST loan settles
 * even if `release()` already ran (the loan's finally closes them instead). All closes are
 * `boundedClose` (each its own WTDIFF_CLOSE_MS=1 s deadline, no signal — a close must always be
 * attempted), run in parallel so the whole set costs ≤1 s + ε.
 */
export class PinSet {
  private closed = false;
  private closeRequested = false;
  private loans = 0;

  constructor(
    readonly pins: PinTriple,
    readonly ids: PinIds,
    private readonly deps: { now(): number; tracker: PreviewIoTracker; log: HubLog },
  ) {}

  /** §1.7 ⑬: the request's exactly-once release. Resolves when all three bounded closes settled. */
  release(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.loans > 0) {
      this.closeRequested = true;
      return Promise.resolve();
    }
    return this.doClose();
  }

  /** §1.10: run `fn` while holding the pins; `fn`'s git runs may outlive the initiating request. */
  async withLoan<T>(fn: () => Promise<T>): Promise<T> {
    this.loans += 1;
    try {
      return await fn();
    } finally {
      this.loans -= 1;
      if (this.loans === 0 && this.closeRequested && !this.closed) {
        this.closeRequested = false;
        void this.doClose();
      }
    }
  }

  private doClose(): Promise<void> {
    this.closed = true;
    const { now, tracker, log } = this.deps;
    return Promise.all([
      boundedClose(() => this.pins.wt.close(), { now, tracker, log }),
      boundedClose(() => this.pins.git.close(), { now, tracker, log }),
      boundedClose(() => this.pins.common.close(), { now, tracker, log }),
    ]).then(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// run outcome classification (§1.5 rows for git)
// ---------------------------------------------------------------------------

/** The command id every `log.warn("wtdiff git failed")` line carries (§2.9 — never a path). */
export type WtGitCmd = "C1a" | "C1" | "C0" | "Cc" | "C2" | "Ca" | "C3" | "C4";

export type PinnedGitOutcome =
  | { ok: true; code: number; stdout: string; capped: boolean; stderrBytes: number }
  | { ok: false; kind: "abort" }
  | { ok: false; kind: "deadline" }
  | { ok: false; kind: "busy" }
  | { ok: false; kind: "git-unavailable"; error: string }
  /** Pre-spawn fstat dev/ino mismatch against the membership record (implementation defect). */
  | { ok: false; kind: "pin-mismatch" };

/** §2.9: the one git-failure warn line — cmd, exit and stderr BYTES only, never stderr text. */
export function warnGitFailed(log: HubLog, cmd: WtGitCmd, fields: { exit?: number; error?: string }): void {
  log.warn("wtdiff git failed", {
    event: "wtdiff.git_failed",
    cmd,
    ...(fields.exit === undefined ? {} : { exit: fields.exit }),
    ...(fields.error === undefined ? {} : { error: fields.error }),
  });
}

function classify(signal: AbortSignal | undefined, res: GitRunResult, log: HubLog, cmd: WtGitCmd): PinnedGitOutcome {
  if (signal?.aborted || res.killed === "abort") return { ok: false, kind: "abort" };
  if (res.killed === "timeout") return { ok: false, kind: "deadline" };
  if (res.spawnError !== undefined) {
    warnGitFailed(log, cmd, { error: res.spawnError });
    return { ok: false, kind: "git-unavailable", error: res.spawnError };
  }
  return {
    ok: true,
    code: res.code ?? -1,
    stdout: res.stdout,
    capped: res.killed === "overflow",
    stderrBytes: Buffer.byteLength(res.stderr, "utf8"),
  };
}

/** D21: `--attr-source` / `check-attr --source` unknown to the installed git ⇒ exit 129.
 * Covers BOTH spellings the frozen argv produce: C2/C3/C4 carry `--attr-source=<tree>`
 * (attrSourceArgs) and Ca carries `--source=<oid>` (wtDiffArgs.checkAttr) — pinned by test. */
export function isGitTooOldExit(argv: readonly string[], code: number): boolean {
  return code === 129 && argv.some((a) => a.startsWith("--attr-source") || a.startsWith("--source="));
}

// ---------------------------------------------------------------------------
// admission-phase runs (C1a / C1 — the ONLY unpinned commands)
// ---------------------------------------------------------------------------

export interface AdmissionRunOpts {
  cwd: string;
  deadline: ReqDeadline;
  signal: AbortSignal | undefined;
  /** single-step cap (§1.9: `min(capMs, A.remaining())` is what actually reaches run.ts) */
  capMs: number;
  maxStdoutBytes: number;
}

export async function runAdmissionGit(
  deps: { run: GitRunner; log: HubLog },
  cmd: "C1a" | "C1",
  argv: readonly string[],
  opts: AdmissionRunOpts,
): Promise<PinnedGitOutcome> {
  if (opts.signal?.aborted) return { ok: false, kind: "abort" };
  const remaining = opts.deadline.remaining();
  if (remaining <= 0) return { ok: false, kind: "deadline" };
  const res = await deps.run(argv, {
    cwd: opts.cwd,
    timeoutMs: Math.min(opts.capMs, remaining),
    maxStdoutBytes: opts.maxStdoutBytes,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    envPolicy: "minimal",
    pathOverride: WTDIFF_GIT_PATH,
  });
  return classify(opts.signal, res, deps.log, cmd);
}

// ---------------------------------------------------------------------------
// pinned runs (C0 / Cc / C2 / Ca / C3 / C4)
// ---------------------------------------------------------------------------

export interface PinnedGitDeps {
  run: GitRunner;
  pinSet: PinSet;
  fs: PreviewFs;
  tracker: PreviewIoTracker;
  log: HubLog;
  now(): number;
}

export interface PinnedRunOpts {
  deadline: ReqDeadline;
  signal: AbortSignal | undefined;
  capMs: number;
  maxStdoutBytes: number;
}

export interface PinnedGit {
  /** §1.7 git 阶段: fstat re-verify (one step) then the pinned spawn. Never spawns on mismatch. */
  run(cmd: WtGitCmd, argv: readonly string[], opts: PinnedRunOpts): Promise<PinnedGitOutcome>;
}

export function createPinnedGit(deps: PinnedGitDeps): PinnedGit {
  const { pinSet } = deps;
  return {
    async run(cmd, argv, opts) {
      if (opts.signal?.aborted) return { ok: false, kind: "abort" };
      const remaining = opts.deadline.remaining();
      if (remaining <= 0) return { ok: false, kind: "deadline" };
      // §1.7/I14: one tracked step fstat-ing all three pins before EVERY pinned spawn.
      let verified: boolean;
      try {
        const stats = await previewFsStep(
          () => Promise.all([pinSet.pins.wt.stat(), pinSet.pins.git.stat(), pinSet.pins.common.stat()]),
          opts.deadline,
          opts.signal,
          { now: deps.now, tracker: deps.tracker, stepCapMs: WTDIFF_STEP_MS },
        );
        verified =
          stats[0]!.dev === pinSet.ids.wt.dev &&
          stats[0]!.ino === pinSet.ids.wt.ino &&
          stats[1]!.dev === pinSet.ids.git.dev &&
          stats[1]!.ino === pinSet.ids.git.ino &&
          stats[2]!.dev === pinSet.ids.common.dev &&
          stats[2]!.ino === pinSet.ids.common.ino;
      } catch (err) {
        if (isPreviewIoError(err)) {
          if (err.ioFail === "abort") return { ok: false, kind: "abort" };
          if (err.ioFail === "busy") return { ok: false, kind: "busy" };
          return { ok: false, kind: "deadline" };
        }
        throw err;
      }
      if (!verified) {
        deps.log.error("wtdiff pin identity mismatch before spawn", { event: "wtdiff.pin_mismatch", cmd });
        return { ok: false, kind: "pin-mismatch" };
      }
      const res = await deps.run(argv, {
        timeoutMs: Math.min(opts.capMs, opts.deadline.remaining()),
        maxStdoutBytes: opts.maxStdoutBytes,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        envPolicy: "minimal",
        pathOverride: WTDIFF_GIT_PATH,
        pins: { wt: pinSet.pins.wt.fd, git: pinSet.pins.git.fd, common: pinSet.pins.common.fd },
      });
      return classify(opts.signal, res, deps.log, cmd);
    },
  };
}

// ---------------------------------------------------------------------------
// bounded read of one file THROUGH a pinned fd (§2.3 `.git` pointer / §2.6.2 info/attributes)
// ---------------------------------------------------------------------------

export type ProcFdRead =
  | { ok: true; bytes: Buffer; complete: boolean }
  | { ok: false; kind: "enoent" }
  | { ok: false; kind: "io" }
  | { ok: false; kind: "deadline" | "abort" | "busy" };

/**
 * Open+read+close `/proc/self/fd/<fd>/<rest>` bounded at `maxBytes` (`complete:false` when the
 * file is larger). The WHOLE sequence is one previewFsStep (a raced-out call's underlying chain
 * still closes its own handle — the inner fn never abandons mid-way), and the open uses plain
 * `O_RDONLY` because the procfs magic symlink ELOOPs under `O_NOFOLLOW` (fs.ts's
 * PREVIEW_TASK_OPEN_FLAGS reasoning).
 */
export async function readProcFdFile(
  fs: PreviewFs,
  deps: { tracker: PreviewIoTracker; now(): number },
  path: string,
  maxBytes: number,
  deadline: ReqDeadline,
  signal: AbortSignal | undefined,
): Promise<ProcFdRead> {
  try {
    return await previewFsStep(
      async (): Promise<ProcFdRead> => {
        let fh: PreviewHandle | undefined;
        try {
          fh = await fs.open(path, PREVIEW_TASK_OPEN_FLAGS);
          const chunks: Buffer[] = [];
          let total = 0;
          let complete = false; // true iff EOF was seen within maxBytes
          while (total < maxBytes) {
            const want = Math.min(64 * 1024, maxBytes - total);
            const buf = Buffer.alloc(want);
            const { bytesRead } = await fh.read(buf, 0, want, total);
            if (bytesRead === 0) {
              complete = true;
              break;
            }
            chunks.push(buf.subarray(0, bytesRead));
            total += bytesRead;
          }
          return { ok: true, bytes: Buffer.concat(chunks), complete };
        } finally {
          if (fh !== undefined) await fh.close().catch(() => undefined);
        }
      },
      deadline,
      signal,
      { now: deps.now, tracker: deps.tracker, stepCapMs: WTDIFF_STEP_MS },
    );
  } catch (err) {
    if (isPreviewIoError(err)) {
      if (err.ioFail === "abort") return { ok: false, kind: "abort" };
      if (err.ioFail === "busy") return { ok: false, kind: "busy" };
      return { ok: false, kind: "deadline" };
    }
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT") return { ok: false, kind: "enoent" };
    return { ok: false, kind: "io" };
  }
}

// ---------------------------------------------------------------------------
// changeset-key inputs (§1.10)
// ---------------------------------------------------------------------------

/** §1.10: `sha256(info/attributes bytes) + driver name set` — any change invalidates the cache. */
export function attrSigOf(infoBytes: Buffer, driverNames: readonly string[]): string {
  return `${createHash("sha256").update(infoBytes).digest("hex")}:${driverNames.join(",")}`;
}

/** §1.10: `<gitdir>/index` identity through the git pin — `ctimeMs:size:ino` (the frozen
 * `PreviewStat` surface exposes `ctimeMs`; a write updates ctime at least as eagerly as mtime,
 * so this is at LEAST as change-sensitive as the plan's `mtimeMs:size:ino` — freshness only,
 * never a security property). NOTE: ctimeMs is NOT an mtimeMs equivalent in general (chmod /
 * chown bump ctime alone) — it is used here ONLY as the cache-freshness key input, where
 * extra invalidations are harmless (a cache miss, never a wrong hit). ANY failure ⇒ `""`
 * (the key degrades to pure TTL). */
export async function indexStatOf(
  fs: PreviewFs,
  deps: { tracker: PreviewIoTracker; now(): number },
  gitFd: number,
  deadline: ReqDeadline,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    const st = await previewFsStep(() => fs.stat(`/proc/self/fd/${gitFd}/index`), deadline, signal, {
      now: deps.now,
      tracker: deps.tracker,
      stepCapMs: WTDIFF_STEP_MS,
    });
    return `${st.ctimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "";
  }
}
