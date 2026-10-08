/**
 * worktree-diff plan §2.3 (D3): worktree membership + the three-fd pin.
 *
 * `membership()` is the ONLY admission path from a session cwd + a UI-supplied `wt` path to a
 * pinned repository identity. It follows the plan pseudocode line by line:
 * - C1a / C1 run UNPINNED in `session.cwd` (admission phase, §1.8's only unpinned commands —
 *   they never read workspace content) to establish the repo's commondir and the COMPLETE
 *   bounded porcelain row set (§2.3 #9: the literal match runs on the full output; realpath is
 *   only a fan-out of ≤64, concurrency 4).
 * - the worktree handle is opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` (WTDIFF_DIR_OPEN_FLAGS) and
 *   the target must be a non-bare, non-prunable row with a matching `dev:ino`.
 * - `.git` is read THROUGH the pinned worktree fd (`/proc/self/fd/<wt.fd>/.git`), never by path:
 *   main worktree ⇒ directory whose `dev:ino` EQUALS the commondir's; linked worktree ⇒ a
 *   ≤4 KiB `gitdir: <path>` pointer whose realpath is then pinned as the gitdir and must BE
 *   `<common>/worktrees/<name>` (`dev:ino` identity, plan §2.3 second review #5).
 * - commondir comes from C1a's output, realpath'd and pinned `O_DIRECTORY|O_NOFOLLOW`.
 *
 * Ownership (§2.3): every handle opened here goes into `owned`; ANY failure path closes them
 * all in parallel (`boundedClose`, each its own ≤1 s) and returns NO pins — on success the
 * `PinSet` carries them and the caller's ⑬ finally is the single closer (with `withLoan`
 * extension for the §1.10 single-flights).
 *
 * Discipline (source-scan pinned): no `node:fs*`; the ONLY fs entry is the injected `PreviewFs`
 * surface; every step goes through `previewFsStep` (≤ WTDIFF_STEP_MS, the routes instance's
 * tracker — the §2.4 circuit breaker applies to membership too).
 */

import { basename } from "node:path";

import { wtDiffArgs } from "../../../git/diff.js";
import type { GitRunner } from "../../../git/run.js";
import { parseWorktreePorcelain, type PorcelainWorktree } from "../../../git/worktrees.js";
import type { ReqDeadline } from "../req-deadline.js";
import type { PreviewFs } from "../preview/admit.js";
import { denyListHit, isVirtualFsPath, type PreviewDenyContext } from "../preview/admit.js";
import { boundedClose, isPreviewIoError, previewFsStep, type PreviewIoTracker } from "../preview/fs.js";
import type { HubLog } from "../ports.js";
import {
  WTDIFF_STEP_MS,
  WTDIFF_WT_LIST_MAX_BYTES,
  WTDIFF_WT_REALPATH_FANOUT_MAX,
} from "../../protocol/worktree-diff.js";
import { PinSet, readProcFdFile, runAdmissionGit } from "./git.js";

/** §2.3: `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` — the pin-open flag set. These are the Linux
 * kernel-ABI octal values (0 / 0o200000 / 0o400000); membership.test.ts pins them equal to
 * `node:fs`'s `fs.constants` so a platform drift is a red test, not a silent hole. `O_CLOEXEC`
 * is libuv's own addition on every open. */
export const WTDIFF_DIR_OPEN_FLAGS = 0 | 0o200000 | 0o400000;

const PROC_FD_CWD = /^\/proc\/(?:self|\d+)\/fd\//;
const GITDIR_PTR_RE = /^gitdir: (.+)\n?$/;
const DOTGIT_MAX_BYTES = 4 * 1024;

export type MembershipFailure =
  | { kind: "denied"; reason: "not-repo" | "not-worktree" | "denylist" | "virtual-fs" }
  | { kind: "git-unavailable" }
  | { kind: "deadline" }
  | { kind: "busy" }
  | { kind: "abort" };

export type MembershipResult = { ok: true; W: string; pinSet: PinSet } | ({ ok: false } & MembershipFailure);

export interface MembershipDeps {
  run: GitRunner;
  fs: PreviewFs;
  tracker: PreviewIoTracker;
  denyCtx: PreviewDenyContext;
  log: HubLog;
  now(): number;
}

export interface MembershipArgs {
  cwd: string;
  wtReq: string;
  deadline: ReqDeadline;
  signal: AbortSignal | undefined;
}

export function createMembership(deps: MembershipDeps): (args: MembershipArgs) => Promise<MembershipResult> {
  const step = <T>(lazy: () => Promise<T>, deadline: ReqDeadline, signal: AbortSignal | undefined): Promise<T> =>
    previewFsStep(lazy, deadline, signal, { now: deps.now, tracker: deps.tracker, stepCapMs: WTDIFF_STEP_MS });

  /** §2.3 fan-out: realpath ≤64 rows at concurrency 4; errno failures drop the row, tracked
   * failures (deadline/abort/busy) propagate — they are global conditions, not row-local ones. */
  async function realpathFanout(
    rows: readonly PorcelainWorktree[],
    W: string,
    args: MembershipArgs,
  ): Promise<PorcelainWorktree[]> {
    const out: PorcelainWorktree[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length && args.signal?.aborted !== true) {
        const row = rows[cursor++];
        if (row === undefined) return;
        try {
          const rp = await step(() => deps.fs.realpath(row.path), args.deadline, args.signal);
          if (rp === W) out.push(row);
        } catch (err) {
          if (isPreviewIoError(err)) throw err;
          // errno ⇒ that row simply cannot match (vanished / unreadable) — dropped
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, () => worker()));
    return out;
  }

  return async function membership(args: MembershipArgs): Promise<MembershipResult> {
    if (PROC_FD_CWD.test(args.cwd)) return { ok: false, kind: "denied", reason: "not-repo" };

    // §2.3 C1a — repo locate (trust root: "判定时刻 session.cwd 所属仓库的 commondir")
    const common0r = await runAdmissionGit({ run: deps.run, log: deps.log }, "C1a", wtDiffArgs.commonDir(args.cwd), {
      cwd: args.cwd,
      deadline: args.deadline,
      signal: args.signal,
      capMs: WTDIFF_STEP_MS,
      maxStdoutBytes: 8 * 1024,
    });
    if (!common0r.ok) {
      if (common0r.kind === "git-unavailable") return { ok: false, kind: "git-unavailable" };
      if (common0r.kind === "deadline") return { ok: false, kind: "deadline" };
      if (common0r.kind === "busy") return { ok: false, kind: "busy" };
      if (common0r.kind === "abort") return { ok: false, kind: "abort" };
      return { ok: false, kind: "denied", reason: "not-repo" };
    }
    if (common0r.code !== 0 || common0r.stdout.trim() === "") return { ok: false, kind: "denied", reason: "not-repo" };
    const common0 = common0r.stdout.trim();

    // §2.3 C1 — membership rows over the COMPLETE bounded porcelain output
    const listr = await runAdmissionGit({ run: deps.run, log: deps.log }, "C1", wtDiffArgs.worktreeList(args.cwd), {
      cwd: args.cwd,
      deadline: args.deadline,
      signal: args.signal,
      capMs: WTDIFF_STEP_MS,
      maxStdoutBytes: WTDIFF_WT_LIST_MAX_BYTES,
    });
    if (!listr.ok) {
      if (listr.kind === "git-unavailable") return { ok: false, kind: "git-unavailable" };
      if (listr.kind === "deadline") return { ok: false, kind: "deadline" };
      if (listr.kind === "busy") return { ok: false, kind: "busy" };
      if (listr.kind === "abort") return { ok: false, kind: "abort" };
      return { ok: false, kind: "denied", reason: "not-repo" };
    }
    if (listr.code !== 0) return { ok: false, kind: "denied", reason: "not-repo" };
    const rows = parseWorktreePorcelain(listr.stdout, listr.capped).filter((r) => !r.bare && !r.prunable);

    // §2.3 — realpath(wtReq); any fs errno ⇒ not-worktree (fail-closed)
    let W: string;
    try {
      W = await step(() => deps.fs.realpath(args.wtReq), args.deadline, args.signal);
    } catch (err) {
      if (isPreviewIoError(err)) {
        if (err.ioFail === "abort") return { ok: false, kind: "abort" };
        if (err.ioFail === "busy") return { ok: false, kind: "busy" };
        return { ok: false, kind: "deadline" };
      }
      return { ok: false, kind: "denied", reason: "not-worktree" };
    }
    if (denyListHit(W, deps.denyCtx) || denyListHit(args.wtReq, deps.denyCtx)) {
      return { ok: false, kind: "denied", reason: "denylist" };
    }
    if (isVirtualFsPath(W)) return { ok: false, kind: "denied", reason: "virtual-fs" };

    const owned: Array<() => Promise<void>> = [];
    const openDirHandle = (path: string) =>
      step(() => deps.fs.open(path, WTDIFF_DIR_OPEN_FLAGS), args.deadline, args.signal);
    let pinSet: PinSet | undefined;
    try {
      const wt = await step(() => deps.fs.open(W, WTDIFF_DIR_OPEN_FLAGS), args.deadline, args.signal);
      owned.push(() => wt.close());
      const wtSt = await step(() => wt.stat(), args.deadline, args.signal);

      // —— 目标匹配（#9）: literal match on the FULL output; realpath only as fan-out ——
      let cand = rows.filter((r) => r.path === args.wtReq || r.path === W);
      if (cand.length === 0) {
        if (rows.length > WTDIFF_WT_REALPATH_FANOUT_MAX) return { ok: false, kind: "denied", reason: "not-worktree" };
        cand = await realpathFanout(rows, W, args);
      }
      let main = false;
      let matched = false;
      for (const row of cand) {
        let st;
        try {
          st = await step(() => deps.fs.stat(row.path), args.deadline, args.signal);
        } catch (err) {
          if (isPreviewIoError(err)) throw err;
          continue;
        }
        if (st.dev === wtSt.dev && st.ino === wtSt.ino) {
          matched = true;
          main = rows.indexOf(row) === 0; // porcelain's first row is always the main worktree
          break;
        }
      }
      if (!matched) return { ok: false, kind: "denied", reason: "not-worktree" };

      // —— commondir: the session repo's identity root ——
      const C = await step(() => deps.fs.realpath(common0), args.deadline, args.signal);
      const common = await step(() => deps.fs.open(C, WTDIFF_DIR_OPEN_FLAGS), args.deadline, args.signal);
      owned.push(() => common.close());
      const cSt = await step(() => common.stat(), args.deadline, args.signal);

      // —— gitdir: read .git THROUGH the pinned worktree fd, never by path ——
      const dotgitPath = `/proc/self/fd/${wt.fd}/.git`;
      const dotgit = await step(() => deps.fs.lstat(dotgitPath), args.deadline, args.signal);
      let git: Awaited<ReturnType<typeof openDirHandle>>;
      let gSt;
      if (main) {
        if (!dotgit.isDirectory()) return { ok: false, kind: "denied", reason: "not-worktree" };
        git = await openDirHandle(dotgitPath);
        owned.push(() => git.close());
        gSt = await step(() => git.stat(), args.deadline, args.signal);
        if (gSt.dev !== cSt.dev || gSt.ino !== cSt.ino) {
          // 主 worktree: gitdir ≡ commondir
          return { ok: false, kind: "denied", reason: "not-worktree" };
        }
      } else {
        if (!dotgit.isFile()) return { ok: false, kind: "denied", reason: "not-worktree" };
        const text = await readProcFdFile(deps.fs, deps, dotgitPath, DOTGIT_MAX_BYTES, args.deadline, args.signal);
        if (!text.ok) {
          if (text.kind === "deadline") return { ok: false, kind: "deadline" };
          if (text.kind === "abort") return { ok: false, kind: "abort" };
          if (text.kind === "busy") return { ok: false, kind: "busy" };
          return { ok: false, kind: "denied", reason: "not-worktree" };
        }
        if (!text.complete) return { ok: false, kind: "denied", reason: "not-worktree" }; // >4 KiB ⇒ not-worktree
        const m = GITDIR_PTR_RE.exec(text.bytes.toString("utf8"));
        if (m === null) return { ok: false, kind: "denied", reason: "not-worktree" };
        const G = await step(() => deps.fs.realpath(m[1]!), args.deadline, args.signal);
        git = await openDirHandle(G);
        owned.push(() => git.close());
        gSt = await step(() => git.stat(), args.deadline, args.signal);
        const name = basename(G);
        const s = await step(
          () => deps.fs.stat(`/proc/self/fd/${common.fd}/worktrees/${name}`),
          args.deadline,
          args.signal,
        );
        if (s.dev !== gSt.dev || s.ino !== gSt.ino) {
          // gitdir 不在本 commondir 名下（指向另一仓库的条目）
          return { ok: false, kind: "denied", reason: "not-worktree" };
        }
      }

      pinSet = new PinSet(
        { wt, git, common },
        {
          wt: { dev: wtSt.dev, ino: wtSt.ino },
          git: { dev: gSt.dev, ino: gSt.ino },
          common: { dev: cSt.dev, ino: cSt.ino },
        },
        { now: deps.now, tracker: deps.tracker, log: deps.log },
      );
      return { ok: true, W, pinSet };
    } catch (err) {
      if (isPreviewIoError(err)) {
        if (err.ioFail === "abort") return { ok: false, kind: "abort" };
        if (err.ioFail === "busy") return { ok: false, kind: "busy" };
        return { ok: false, kind: "deadline" };
      }
      // any other fs errno mid-pin ⇒ fail-closed not-worktree
      return { ok: false, kind: "denied", reason: "not-worktree" };
    } finally {
      if (pinSet === undefined) {
        await Promise.all(
          owned.map((close) => boundedClose(close, { now: deps.now, tracker: deps.tracker, log: deps.log })),
        );
      }
    }
  };
}
