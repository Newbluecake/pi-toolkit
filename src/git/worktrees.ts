import { promises as fs } from "node:fs";

import type { GitRunner } from "./run.js";

export interface PorcelainWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached?: true;
  bare?: true;
  locked?: true;
  prunable?: true;
}

export interface RepoProbe {
  dirty: number;
  dirtyCapped: boolean;
  untrackedSkipped: boolean;
  upstream: boolean;
  ahead: number;
  behind: number;
}

export interface ScannedWorktree extends PorcelainWorktree {
  main: boolean;
  current: boolean;
  agentRunId?: string;
  probe?: RepoProbe;
  unprobed?: "cap" | "timeout" | "error";
}

export type ScanResult =
  | { kind: "ok"; toplevel: string; worktrees: ScannedWorktree[]; listCapped: boolean }
  | { kind: "not-repo"; reason: "rev-parse" | "proc-fd-cwd" }
  | { kind: "error"; reason: "timeout" | "abort" | "spawn" | "list" };

const PROC_FD_CWD = /^\/proc\/(?:self|\d+)\/fd\//;

function records(stdout: string, capped: boolean): string[][] {
  const lines = stdout.split("\n");
  if (capped && lines.at(-1) !== "") lines.pop();
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (current.length > 0) result.push(current);
      current = [];
    } else current.push(line);
  }
  if (current.length > 0 && !capped) result.push(current);
  return result;
}

export function parseWorktreePorcelain(stdout: string, capped: boolean): PorcelainWorktree[] {
  const parsed: PorcelainWorktree[] = [];
  for (const record of records(stdout, capped)) {
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let detached = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    let malformed = false;
    for (const line of record) {
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "worktree") path = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
      else if (key === "detached") detached = true;
      else if (key === "bare") bare = true;
      else if (key === "locked") locked = true;
      else if (key === "prunable") prunable = true;
      else malformed = true;
    }
    // A capped stream may end in a partial record. Malformed newline paths are
    // likewise ignored unless git supplied enough structure to identify a row.
    if (malformed || path === undefined || (!bare && head === undefined && !prunable)) continue;
    parsed.push({
      path,
      ...(head !== undefined ? { head } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(detached ? { detached: true as const } : {}),
      ...(bare ? { bare: true as const } : {}),
      ...(locked ? { locked: true as const } : {}),
      ...(prunable ? { prunable: true as const } : {}),
    });
  }
  return parsed;
}

export function parseStatusV2(stdout: string, capped: boolean): Omit<RepoProbe, "untrackedSkipped"> {
  const lines = stdout.split("\n");
  if (capped && lines.at(-1) !== "") lines.pop();
  let dirty = 0;
  let upstream = false;
  let ahead = 0;
  let behind = 0;
  for (const line of lines) {
    if (line.startsWith("# branch.upstream ")) upstream = true;
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) dirty++;
  }
  return { dirty: capped && dirty === 0 ? 1 : dirty, dirtyCapped: capped, upstream, ahead, behind };
}

export function rankWorktrees<T extends ScannedWorktree>(list: T[]): T[] {
  const priority = (row: ScannedWorktree): number => {
    if (row.current) return 0;
    if (row.main) return 1;
    if (row.prunable) return 4;
    if (row.agentRunId !== undefined) return 3;
    return 2;
  };
  return [...list].sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));
}

export async function scanWorktrees(
  run: GitRunner,
  cwd: string,
  opts: {
    signal: AbortSignal;
    realpath?: (p: string) => Promise<string>;
    degraded?: ReadonlySet<string>;
    maxProbes?: number;
    concurrency?: number;
    cmdTimeoutMs?: number;
  },
): Promise<ScanResult> {
  if (PROC_FD_CWD.test(cwd)) return { kind: "not-repo", reason: "proc-fd-cwd" };
  const timeoutMs = opts.cmdTimeoutMs ?? 3000;
  const rev = await run(["-C", cwd, "rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs,
    maxStdoutBytes: 4 * 1024,
    signal: opts.signal,
  });
  if (opts.signal.aborted || rev.killed === "abort") return { kind: "error", reason: "abort" };
  if (rev.spawnError !== undefined) return { kind: "error", reason: "spawn" };
  if (rev.killed === "timeout") return { kind: "error", reason: "timeout" };
  if (rev.code !== 0) return { kind: "not-repo", reason: "rev-parse" };
  const toplevel = rev.stdout.trim();
  if (toplevel.length === 0) return { kind: "not-repo", reason: "rev-parse" };

  const list = await run(["-C", cwd, "worktree", "list", "--porcelain"], {
    cwd,
    timeoutMs,
    maxStdoutBytes: 256 * 1024,
    signal: opts.signal,
  });
  if (opts.signal.aborted || list.killed === "abort") return { kind: "error", reason: "abort" };
  if (list.spawnError !== undefined) return { kind: "error", reason: "spawn" };
  if (list.killed === "timeout") return { kind: "error", reason: "timeout" };
  if (list.code !== 0) return { kind: "error", reason: "list" };

  const parsed = parseWorktreePorcelain(list.stdout, list.stdoutCapped);
  const realpath = opts.realpath ?? ((p: string) => fs.realpath(p));
  const topKey = await realpath(toplevel).catch(() => toplevel);
  const rows: ScannedWorktree[] = await Promise.all(
    parsed.map(async (row, index) => {
      const rowKey = row.prunable ? row.path : await realpath(row.path).catch(() => row.path);
      const branchMatch = row.branch?.match(/^pi-agent-(.+)$/);
      return {
        ...row,
        main: index === 0,
        current: rowKey === topKey,
        ...(branchMatch?.[1] !== undefined ? { agentRunId: branchMatch[1] } : {}),
      };
    }),
  );
  const ranked = rankWorktrees(rows);
  const maxProbes = opts.maxProbes ?? 8;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const candidates = ranked.filter((row) => !row.bare && !row.prunable);
  const probeTargets = new Set(candidates.slice(0, maxProbes));
  const pending = candidates.filter((row) => probeTargets.has(row));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length && !opts.signal.aborted) {
      const row = pending[cursor++];
      if (row === undefined) return;
      const useDegraded = opts.degraded?.has(await realpath(row.path).catch(() => row.path)) ?? false;
      const status = await run(
        // `--untracked-files` takes an OPTIONAL argument, so git only binds it in the `=` form; the
        // space-separated form turns the mode into a pathspec and the probe sees no changes at all.
        // `all` (not `normal`): `normal` collapses an untracked directory into ONE `? dir/` record,
        // so `*N` disagreed with the per-file diff list (src/git/diff.ts, also `all`) — 2026-10-09
        // field report. Cost stays bounded by the 64 KiB stdout cap (`dirtyCapped`), the timeout and
        // the degraded (`no`) fallback; ignored trees are never descended either way.
        ["-C", row.path, "status", "--porcelain=v2", "--branch", `--untracked-files=${useDegraded ? "no" : "all"}`],
        { cwd: row.path, timeoutMs, maxStdoutBytes: 64 * 1024, signal: opts.signal },
      );
      if (status.killed === "abort" || opts.signal.aborted) return;
      const index = rows.indexOf(row);
      if (status.killed === "timeout") rows[index] = { ...row, unprobed: "timeout" };
      else if (status.killed !== "overflow" && (status.spawnError !== undefined || status.code !== 0))
        rows[index] = { ...row, unprobed: "error" };
      else {
        const probe = parseStatusV2(status.stdout, status.stdoutCapped);
        rows[index] = { ...row, probe: { ...probe, untrackedSkipped: useDegraded } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  if (opts.signal.aborted) return { kind: "error", reason: "abort" };
  const probed = new Set(pending);
  for (const row of rows) {
    if (!row.bare && !row.prunable && !probed.has(row) && row.probe === undefined && row.unprobed === undefined) {
      row.unprobed = "cap";
    }
  }
  return { kind: "ok", toplevel, worktrees: rankWorktrees(rows), listCapped: list.stdoutCapped };
}
