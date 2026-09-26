/**
 * workflow-worktree plan §3 (P4 design surface, P1 implements the pure
 * pieces per §5's package split): owner tokens, the process-local tracked
 * set, and the pure orphan scanner. No pi imports, no git, no writes/unlinks
 * — the scanner is read-only by design (non-goal: automatic GC).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Same default root the worktree extension uses (worktree.ts); shared here
 *  so P4's status/scan wiring never has to guess it independently. */
export function worktreeRoot(override?: string): string {
  return resolve(override ?? join(tmpdir(), "pi-subagent-worktrees"));
}

export interface WorktreeOwnerToken {
  readonly pid: number;
  readonly procStartedAt: number;
  readonly instanceId: string;
}

const PROCESS_STARTED_AT_KEY = Symbol.for("pi-subagent:process-started-at");
const TRACKED_KEY = Symbol.for("pi-subagent:worktree-tracked");

/** This process's own start time (ms since epoch), computed once and cached
 *  on globalThis (survives /reload within the same process). */
export function processStartedAt(): number {
  const g = globalThis as Record<symbol, unknown>;
  let value = g[PROCESS_STARTED_AT_KEY] as number | undefined;
  if (value === undefined) {
    value = Math.round(Date.now() - process.uptime() * 1000);
    g[PROCESS_STARTED_AT_KEY] = value;
  }
  return value;
}

/**
 * Process-global tracked set: worktree path -> owning extension instanceId.
 * Written by the worktree extension while a run's marker is `creating` or
 * `active`; removed in beforeReap's finally or after D12 compensation. A
 * `/reload` builds a new extension instance (new instanceId) but the map
 * itself is shared (same Symbol.for holder) so an old instance's still-
 * running H3/compensation stays visible to the scanner.
 */
export function trackedWorktrees(): Map<string, string> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[TRACKED_KEY] as Map<string, string> | undefined;
  if (!map) {
    map = new Map();
    g[TRACKED_KEY] = map;
  }
  return map;
}

/**
 * Linux-only: this pid's start time (ms since epoch), read from
 * `/proc/<pid>/stat` (field 22 aka starttime, in clock ticks since boot —
 * conventionally 100 ticks/s) plus `/proc/stat`'s `btime` (boot time,
 * seconds since epoch). Returns undefined on any other platform or when the
 * files cannot be read/parsed (dead pid, permissions, non-Linux) — callers
 * treat "undefined" as "cannot tell", never as "dead".
 *
 * The comm field (2nd field, in parentheses) may itself contain spaces and
 * `)` characters, so starttime is located from the END of the line: split at
 * the LAST `)` and take the 20th field after it (fields are 1-indexed
 * starting right after that `)`; starttime is field (22 - 2) = 20 counting
 * from there since fields 1-2 are pid and comm).
 */
export function procStartOf(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return undefined;
    const rest = stat
      .slice(lastParen + 1)
      .trim()
      .split(/\s+/);
    // rest[0] is field 3 (state); starttime is field 22, i.e. rest[22-3] = rest[19].
    const startTicksStr = rest[19];
    if (startTicksStr === undefined) return undefined;
    const startTicks = Number(startTicksStr);
    if (!Number.isFinite(startTicks)) return undefined;
    const statFile = readFileSync("/proc/stat", "utf8");
    const btimeLine = statFile.split("\n").find((l) => l.startsWith("btime "));
    if (!btimeLine) return undefined;
    const btime = Number(btimeLine.slice("btime ".length).trim());
    if (!Number.isFinite(btime)) return undefined;
    // clock ticks per second — Linux userspace almost universally uses 100.
    const CLK_TCK = 100;
    return Math.round(btime * 1000 + (startTicks / CLK_TCK) * 1000);
  } catch {
    return undefined;
  }
}

/** `process.kill(pid, 0)` wrapped so a dead pid resolves to `false` instead of throwing ESRCH. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface OwnerMarker {
  v: 1;
  state: "creating" | "active" | "abandoned";
  owner: WorktreeOwnerToken;
  runId: string;
  repo?: string;
  path: string;
  createdAt: number;
}

export type WorktreeOrphanReason = "abandoned" | "owner-gone" | "owner-dead" | "creating-abandoned" | "no-owner";

export interface WorktreeOrphanEntry {
  path: string;
  repo?: string;
  reason: WorktreeOrphanReason;
  notAWorktree?: boolean;
}

export interface WorktreeOrphanScanResult {
  root: string;
  count: number;
  capped: boolean;
  entries: WorktreeOrphanEntry[];
}

export interface ScanWorktreeOrphansOptions {
  root: string;
  isPidAlive: (pid: number) => boolean;
  procStartOf: (pid: number) => number | undefined;
  tracked: ReadonlyMap<string, string>;
  self: { pid: number; procStartedAt: number };
  now: () => number;
  cap?: number;
  /** 120s no-marker grace window (default 120_000). Test seam only. */
  graceMs?: number;
}

const NO_MARKER_GRACE_MS = 120_000;

function readMarker(root: string, dirName: string): OwnerMarker | undefined {
  try {
    const raw = readFileSync(join(root, ".owners", `${dirName}.json`), "utf8");
    const parsed = JSON.parse(raw) as OwnerMarker;
    if (parsed && parsed.v === 1 && parsed.owner && typeof parsed.path === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function classifyOwner(
  marker: OwnerMarker,
  path: string,
  opts: Pick<ScanWorktreeOrphansOptions, "isPidAlive" | "procStartOf" | "tracked" | "self">,
): "alive" | "owner-gone" | "owner-dead" {
  const { owner } = marker;
  if (owner.pid === opts.self.pid) {
    if (Math.abs(owner.procStartedAt - opts.self.procStartedAt) > 2_000) return "owner-dead"; // pid reused by a DIFFERENT process
    return opts.tracked.get(path) !== undefined ? "alive" : "owner-gone"; // same process, but this instance never tracked it (post-/reload)
  }
  if (!opts.isPidAlive(owner.pid)) return "owner-dead";
  const liveStart = opts.procStartOf(owner.pid);
  if (liveStart === undefined) return "alive"; // cannot tell (non-Linux) — assumed alive, accepted risk
  return Math.abs(liveStart - owner.procStartedAt) <= 2_000 ? "alive" : "owner-dead";
}

/**
 * Pure scan of `root` for worktree directories left behind by a dead/gone
 * owner. Synchronous fs only, no exec, no writes/unlinks, bounded by `cap`
 * (default 500) directory entries.
 */
export function scanWorktreeOrphans(opts: ScanWorktreeOrphansOptions): WorktreeOrphanScanResult {
  const cap = opts.cap ?? 500;
  const grace = opts.graceMs ?? NO_MARKER_GRACE_MS;
  let names: string[];
  try {
    names = readdirSync(opts.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".owners")
      .map((d) => d.name);
  } catch {
    return { root: opts.root, count: 0, capped: false, entries: [] };
  }
  const capped = names.length > cap;
  const slice = names.slice(0, cap);
  const entries: WorktreeOrphanEntry[] = [];
  const now = opts.now();
  for (const name of slice) {
    const path = join(opts.root, name);
    let repo: string | undefined;
    let notAWorktree = false;
    try {
      const gitFile = readFileSync(join(path, ".git"), "utf8");
      const m = /^gitdir:\s*(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m.exec(gitFile);
      if (m) repo = m[1];
      else notAWorktree = true;
    } catch {
      notAWorktree = true;
    }
    const marker = readMarker(opts.root, name);
    if (!marker) {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue; // vanished mid-scan
      }
      if (now - mtime <= grace) continue; // grace window — likely a race with the creator
      entries.push({ path, ...(repo ? { repo } : {}), reason: "no-owner", ...(notAWorktree ? { notAWorktree } : {}) });
      continue;
    }
    if (marker.state === "abandoned") {
      entries.push({
        path,
        ...((repo ?? marker.repo) ? { repo: repo ?? marker.repo } : {}),
        reason: "abandoned",
        ...(notAWorktree ? { notAWorktree } : {}),
      });
      continue;
    }
    const classification = classifyOwner(marker, path, opts);
    if (classification === "alive") continue;
    const reason: WorktreeOrphanReason = marker.state === "creating" ? "creating-abandoned" : classification;
    entries.push({
      path,
      ...((repo ?? marker.repo) ? { repo: repo ?? marker.repo } : {}),
      reason,
      ...(notAWorktree ? { notAWorktree } : {}),
    });
  }
  return { root: opts.root, count: entries.length, capped, entries };
}
