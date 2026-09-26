import { mkdir } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { forgetWorktreeOrigin, recordWorktreeOrigin } from "../core/worktree-origin.js";
import type {
  SessionSpec,
  SpawnRequest,
  SubagentExtensionPoints,
  RunOutcome,
  WorktreeDisposal,
} from "../core/types.js";
import { DEFAULT_WORKTREE_SETTINGS, type WorktreeSettings } from "./worktree-settings.js";
import { canonicalLinkPath } from "./worktree-link-paths.js";
import { processStartedAt, trackedWorktrees, type WorktreeOwnerToken } from "./worktree-orphans.js";

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type WorktreeExec = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;
export type WorktreeDiagnostic = (event: {
  runId: string;
  phase: "create" | "cleanup";
  message: string;
  error?: unknown;
}) => void;

export interface WorktreeExtensionOptions {
  exec: WorktreeExec;
  settings?: Partial<WorktreeSettings>;
  worktreeRoot?: string;
  onDiagnostic?: WorktreeDiagnostic;
}

/** workflow-worktree plan §3: on-disk marker written to `<root>/.owners/<safeRunId>.json`
 *  BEFORE `worktree add` runs (D12/§3 condition 3) so a crash/kill between the
 *  two never leaves an unmarked directory. Best-effort (fs errors are swallowed). */
interface OwnerMarkerFile {
  v: 1;
  state: "creating" | "active" | "abandoned";
  owner: WorktreeOwnerToken;
  runId: string;
  repo: string;
  path: string;
  createdAt: number;
}

interface WorktreeRecord {
  path: string;
  repo: string;
  branch: string;
  runId: string;
  state: "creating" | "active";
  /** D12: set by abandonSessionSpec while still "creating" — H2 compensates once `worktree add` returns. */
  abandonRequested: boolean;
  /** D9: repo-relative link paths actually symlinked into this worktree (subset of settings.linkPaths). */
  links: string[];
  /** D12: idempotency guard — abandon and H2's own failure path share exactly one compensation run. */
  compensatePromise?: Promise<void>;
}

const READONLY_LINK_NOTE = (paths: readonly string[]): string =>
  `Worktree isolation note: ${paths.join(", ")} are symlinks into the main checkout — shared, READ-ONLY ` +
  `dependencies. Do not run install/update/prune commands (npm/pnpm/yarn install|ci|add|update, pip install, …) ` +
  `and do not write, delete or modify anything under them; they are never committed.`;

function commandError(command: string, result: ExecResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${command} failed: ${detail}`);
}
function safeRunId(runId: string): string {
  const value = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return value || "run";
}
function isClean(result: ExecResult): boolean {
  return result.code === 0 && result.stdout.trim() === "";
}

/**
 * Git worktree isolation extension. It deliberately throws from H2 when an
 * explicitly requested worktree cannot be provided; the adapter translates
 * that failure to failed(config), rather than falling back to the checkout.
 */
export function createWorktreeExtension(options: WorktreeExtensionOptions): SubagentExtensionPoints {
  const settings = { ...DEFAULT_WORKTREE_SETTINGS, ...options.settings };
  const records = new Map<string, WorktreeRecord>();
  const root = resolve(options.worktreeRoot ?? join(tmpdir(), "pi-subagent-worktrees"));
  const ownersDir = join(root, ".owners");
  // §3 (v2.1 condition 3): one owner token per extension instance (created on
  // every activate()/wireWorktree call, including /reload). instanceId is
  // deliberately NOT the session-stack id — a stack rebuild (new/resume/fork)
  // must not change the ownership of in-flight worktrees.
  const self: WorktreeOwnerToken = { pid: process.pid, procStartedAt: processStartedAt(), instanceId: randomUUID() };
  const tracked = trackedWorktrees();
  const git = (args: readonly string[], cwd: string, timeout: number, signal?: AbortSignal) =>
    options.exec("git", args, { cwd, timeout, ...(signal ? { signal } : {}) });

  function markerPath(runId: string): string {
    return join(ownersDir, `${safeRunId(runId)}.json`);
  }
  function writeMarker(rec: WorktreeRecord, state: OwnerMarkerFile["state"]): void {
    try {
      const marker: OwnerMarkerFile = {
        v: 1,
        state,
        owner: self,
        runId: rec.runId,
        repo: rec.repo,
        path: rec.path,
        createdAt: Date.now(),
      };
      writeFileSync(markerPath(rec.runId), JSON.stringify(marker), { mode: 0o600 });
    } catch {
      /* best-effort: the marker is a display/scan aid, never load-bearing for correctness */
    }
  }
  function deleteMarker(runId: string): void {
    try {
      unlinkSync(markerPath(runId));
    } catch {
      /* absent/already-deleted is fine */
    }
  }

  /**
   * D12: bounded, serial compensation for a worktree whose owning run never
   * entered the runner (startup timeout, a later H2 extension throwing, or a
   * synchronous throw between H2 succeeding and the runner starting) — or
   * whose own `worktree add` failed/was aborted. Never awaited by any
   * caller upstream of this module; idempotent via `rec.compensatePromise`.
   */
  function compensate(rec: WorktreeRecord): Promise<void> {
    if (rec.compensatePromise) return rec.compensatePromise;
    const promise = (async () => {
      let pathExists = existsSync(rec.path);
      if (pathExists) {
        try {
          const remove = await git(["worktree", "remove", "--force", rec.path], rec.repo, settings.gitTimeoutMs);
          if (remove.code !== 0) throw commandError("git worktree remove", remove);
        } catch {
          try {
            await git(["worktree", "prune"], rec.repo, settings.gitTimeoutMs);
          } catch {
            /* best-effort */
          }
        }
        pathExists = existsSync(rec.path);
      }
      if (!pathExists) {
        deleteMarker(rec.runId);
        forgetWorktreeOrigin(rec.path);
        tracked.delete(rec.path);
        records.delete(rec.runId);
      } else {
        writeMarker(rec, "abandoned");
        tracked.delete(rec.path);
        options.onDiagnostic?.({
          runId: rec.runId,
          phase: "cleanup",
          message: `worktree abandoned at ${rec.path}; see /agent status`,
        });
        records.delete(rec.runId);
      }
    })();
    rec.compensatePromise = promise;
    return promise;
  }

  /**
   * D9: symlink each configured, canonically-valid link path from the repo
   * into the fresh worktree, read-only-by-convention (no lock — §2 D9
   * accepted risk). Returns the subset actually linked (skips anything that
   * fails a safety check); callers fold this into `promptNotes` and H3's
   * pathspec exclusions.
   */
  async function setupLinkPaths(
    repo: string,
    worktreePath: string,
    linkPaths: readonly string[],
    signal: AbortSignal | undefined,
    runId: string,
  ): Promise<string[]> {
    const created: string[] = [];
    for (const raw of linkPaths) {
      const canon = canonicalLinkPath(raw);
      if (!canon.ok) continue; // defense in depth — settings already filtered these
      const p = canon.path;
      try {
        const segments = p.split("/");
        let prefix = repo;
        let rejected = false;
        for (const seg of segments) {
          prefix = join(prefix, seg);
          let st;
          try {
            st = lstatSync(prefix);
          } catch {
            rejected = true;
            break;
          }
          if (st.isSymbolicLink()) {
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
        const target = join(repo, p);
        let targetStat;
        try {
          targetStat = statSync(target);
        } catch {
          continue;
        }
        if (!targetStat.isDirectory()) continue;
        try {
          const real = realpathSync(target);
          const expected = join(realpathSync(repo), p);
          if (real !== expected) continue;
        } catch {
          continue;
        }
        const ignoreResult = await git(["check-ignore", "-q", "--", p], repo, settings.gitTimeoutMs, signal);
        if (ignoreResult.code !== 0) continue; // only link paths git already ignores & doesn't track
        const linkPath = join(worktreePath, p);
        if (existsSync(linkPath)) continue;
        const parentDir = dirname(linkPath);
        if (!existsSync(parentDir)) continue;
        symlinkSync(target, linkPath);
        created.push(p);
      } catch (error) {
        options.onDiagnostic?.({ runId, phase: "create", message: `linkPaths: failed to link "${p}"`, error });
      }
    }
    return created;
  }

  return {
    async resolveSessionSpec(
      spec: SessionSpec,
      request: SpawnRequest,
      ctx?: { signal: AbortSignal },
    ): Promise<SessionSpec> {
      if (request.isolation !== "worktree") return spec;
      if (!settings.enabled) throw new Error("worktree isolation is requested but disabled");
      const cwd = resolve(spec.cwd ?? request.cwd ?? process.cwd());
      const repoResult = await git(["rev-parse", "--show-toplevel"], cwd, settings.gitTimeoutMs);
      if (repoResult.code !== 0) throw commandError("git rev-parse --show-toplevel", repoResult);
      const repo = repoResult.stdout.trim();
      if (!repo) throw new Error("git rev-parse --show-toplevel returned an empty repository path");
      const runId = requestRunId(request);
      const path = join(root, safeRunId(runId));
      const branch = `pi-agent-${safeRunId(runId)}`;
      await mkdir(root, { recursive: true });
      await mkdir(ownersDir, { recursive: true });
      const record: WorktreeRecord = {
        path,
        repo,
        branch,
        runId,
        state: "creating",
        abandonRequested: false,
        links: [],
      };
      records.set(runId, record);
      tracked.set(path, self.instanceId);
      writeMarker(record, "creating"); // §3 condition 3: predates `worktree add`
      let add: ExecResult;
      try {
        add = await git(["worktree", "add", "--detach", path], repo, settings.gitTimeoutMs, ctx?.signal);
      } catch (error) {
        await compensate(record);
        throw error;
      }
      if (add.code !== 0) {
        options.onDiagnostic?.({
          runId,
          phase: "create",
          message: "worktree creation failed",
          error: commandError("git worktree add", add),
        });
        await compensate(record);
        throw commandError("git worktree add", add);
      }
      if (ctx?.signal?.aborted || record.abandonRequested) {
        await compensate(record);
        throw new Error("resolveSessionSpec aborted");
      }
      record.state = "active";
      writeMarker(record, "active"); // origin is only registered AFTER this point
      recordWorktreeOrigin(path, cwd);
      const links = settings.linkPaths.length
        ? await setupLinkPaths(repo, path, settings.linkPaths, ctx?.signal, runId)
        : [];
      record.links = links;
      return {
        ...spec,
        cwd: path,
        ...(links.length ? { promptNotes: [...(spec.promptNotes ?? []), READONLY_LINK_NOTE(links)] } : {}),
      };
    },

    /** D12 (v2.1 condition 1): compensate a worktree whose owning run never entered the runner. */
    async abandonSessionSpec(
      runId: string,
      ctx: { reason: "startup_timeout" | "h2_failed" | "pre_runner_exit" },
    ): Promise<void> {
      const record = records.get(runId);
      if (!record) return;
      if (record.state === "creating") {
        // H2's own resolveSessionSpec call is still in flight (the `worktree
        // add` command hasn't returned yet); it will notice this flag once
        // it does and compensate itself, avoiding a double-delete race.
        record.abandonRequested = true;
        return;
      }
      void ctx; // reason is diagnostic-only for this extension; no branch needed today.
      await compensate(record);
    },

    async beforeReap(
      outcome: RunOutcome,
      ctx: {
        cwd: string;
        deadlineMs: number;
        setWorktreeDisposition?(disposition: WorktreeDisposal): void;
      },
    ): Promise<void> {
      const record = records.get(outcome.runId);
      if (!record) return;
      // X1: report the disposal outcome back into diag.worktree (agent-tree
      // `⎇` marker) so the terminal row converges from `⎇ wt` to its final
      // state. Best-effort: absent callback (tests/legacy wiring) is fine.
      // Note a failed `worktree remove` after a SUCCESSFUL commit chain still
      // reports "committed" — the work is safe on the branch and the leftover
      // directory is surfaced through onDiagnostic instead.
      const report = (disposition: WorktreeDisposal) => ctx.setWorktreeDisposition?.(disposition);
      // Safety gate: the worktree is only removed when it was clean or its
      // changes were successfully committed to the pi-agent branch. Any
      // failure in the commit chain preserves the worktree on disk so
      // uncommitted work is never destroyed by the force-remove below.
      let safeToRemove = false;
      // D9: pathspecs that exclude the read-only link symlinks from status/
      // commit so they are NEVER tracked, added, or committed. Absent when
      // this run built no links (the exact byte-identical pre-D9 call shape).
      const excludePathspecs = record.links.map((p) => `:(exclude,literal)${p}`);
      const statusArgs = excludePathspecs.length
        ? ["status", "--porcelain", "--", ".", ...excludePathspecs]
        : ["status", "--porcelain"];
      const addArgs = excludePathspecs.length ? ["add", "-A", "--", ".", ...excludePathspecs] : ["add", "-A"];
      try {
        const status = await git(statusArgs, record.path, ctx.deadlineMs);
        if (status.code !== 0) throw commandError("git status --porcelain", status);
        if (isClean(status)) {
          safeToRemove = true;
          report({ state: "clean" });
        } else {
          const checkout = await git(["switch", "-c", record.branch], record.path, ctx.deadlineMs);
          if (checkout.code !== 0) throw commandError("git switch -c", checkout);
          const add = await git(addArgs, record.path, ctx.deadlineMs);
          if (add.code !== 0) throw commandError("git add -A", add);
          const commit = await git(["commit", "-m", `pi-agent ${outcome.runId}`], record.path, ctx.deadlineMs);
          if (commit.code !== 0) throw commandError("git commit", commit);
          safeToRemove = true;
          report({ state: "committed", branch: record.branch });
        }
      } catch (error) {
        report({ state: "kept", path: record.path });
        options.onDiagnostic?.({
          runId: outcome.runId,
          phase: "cleanup",
          message: `worktree changes could not be committed; worktree preserved at ${record.path} to avoid losing uncommitted work`,
          error,
        });
      }
      try {
        if (safeToRemove) {
          const remove = await git(["worktree", "remove", "--force", record.path], record.repo, ctx.deadlineMs);
          if (remove.code !== 0) throw commandError("git worktree remove", remove);
        }
      } catch (error) {
        options.onDiagnostic?.({ runId: outcome.runId, phase: "cleanup", message: "worktree cleanup failed", error });
      } finally {
        // §3: the owner marker is removed unconditionally, even for a "kept"
        // worktree — the next orphan scan reports it as `no-owner` instead of
        // (wrongly) still-owned-by-this-run.
        deleteMarker(outcome.runId);
        tracked.delete(record.path);
        records.delete(outcome.runId);
        forgetWorktreeOrigin(record.path);
      }
    },
  };
}

function requestRunId(request: SpawnRequest): string {
  return request.runId ?? request.label ?? `${request.type}-run`;
}

export const createWorktreeExtensionPoints = createWorktreeExtension;

/** Pi host adapter: builds the extension from pi's exec (index.ts stays wiring-only, D7). */
export function createPiWorktreeExtension(
  pi: {
    exec(
      cmd: string,
      args: string[],
      opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
    ): Promise<ExecResult>;
  },
  settings: WorktreeSettings,
): SubagentExtensionPoints {
  return createWorktreeExtension({
    settings,
    exec: (cmd, args, opts) =>
      pi.exec(cmd, [...args], {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.timeout ? { timeout: opts.timeout } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}), // D12 (v2.1 condition 1): forward the abort signal
      }),
    // Diagnostics must stay visible in production: a preserved worktree means
    // uncommitted agent work is sitting on disk and the user must recover it.
    onDiagnostic: (event) => {
      const detail =
        event.error instanceof Error ? ` (${event.error.message})` : event.error ? ` (${String(event.error)})` : "";
      console.warn(`[pi-subagent] worktree ${event.phase} [${event.runId}]: ${event.message}${detail}`);
    },
  });
}
