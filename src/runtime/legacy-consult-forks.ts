import { closeSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { secureStatePaths } from "../secure/domain.js";
import type { Millis } from "../core/types.js";

/**
 * Legacy consult fork directory: location + sweep, migrated verbatim from
 * the removed consult fork-store (#40, docs/dev/consult-removal/plan.md §2).
 * The consult tool is gone, but older versions left `consult-sessions` fork
 * copies on disk; the per-session-start sweep drains them within 24 h, and
 * the schedule wiring still treats files under this dir as child sessions.
 * Lives in `runtime/` (not `core/`) because `getAgentDir` is a pi function.
 *
 * Synchronous fs + silent degradation: neither function throws.
 */

/**
 * Sweep window for orphaned fork copies (internal constant, deliberately NOT a
 * setting — knob-creep guard). Multi-process safety premise ①: the dir lives
 * under ~/.pi/agent/cache and is shared across pi processes, but every live
 * consult run was bounded by its 150 s totalMs hard cap, so a fork file still
 * in use is at least ~576× younger than this TTL.
 */
export const LEGACY_FORK_TTL_MS: Millis = 24 * 60 * 60 * 1000;

/**
 * Header parsing is capped at the first 8 KB of the file: a real pi session
 * always starts with its (small) `type:"session"` header line, so anything
 * longer is not a header we want to reason about.
 */
const HEADER_SCAN_LIMIT_BYTES = 8 * 1024;

/**
 * `~/.pi/agent/cache/consult-sessions` via pi's own accessor (never derived by
 * walking up from a session dir). A secure process uses the in-vault
 * `<state>/cache/consult-sessions` instead (data-encryption §2.5).
 */
export function legacyConsultForkDir(): string {
  return secureStatePaths()?.consult ?? join(getAgentDir(), "cache", "consult-sessions");
}

export interface LegacyForkSweepResult {
  /** Valid-header files removed because their mtime exceeded the TTL. */
  removedExpired: number;
  /** Files removed because their head has no valid session header, regardless of mtime (deletion-aftermath fragments). */
  removedFragments: number;
  /** Valid-header files inside the TTL window. */
  kept: number;
  /** Entries we could not stat/unlink (raced away, permissions); never thrown. */
  errors: number;
}

function tryParseEntryLine(line: Buffer): unknown {
  const text = line.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // malformed line — skipped, same tolerance as pi's loadEntriesFromFile
  }
}

function isSessionHeader(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { type?: unknown; id?: unknown };
  return e.type === "session" && typeof e.id === "string" && e.id.length > 0;
}

/** Whether the head of `file` holds a valid session header (same acceptance rule as the original `scanSessionHead(file).ok`). */
function hasValidSessionHead(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const window = Buffer.alloc(Math.min(size, HEADER_SCAN_LIMIT_BYTES));
    let filled = 0;
    while (filled < window.length) {
      const n = readSync(fd, window, filled, window.length - filled, filled);
      if (n === 0) break;
      filled += n;
    }
    let lineStart = 0;
    for (;;) {
      const nl = window.indexOf(10, lineStart); // "\n"
      if (nl === -1) break;
      const entry = tryParseEntryLine(window.subarray(lineStart, nl));
      if (entry !== undefined) return isSessionHeader(entry);
      lineStart = nl + 1;
    }
    // No complete parseable line inside the window.
    if (size > HEADER_SCAN_LIMIT_BYTES) return false;
    const entry = tryParseEntryLine(window.subarray(lineStart)); // the final line, without a trailing newline
    return entry !== undefined && isSessionHeader(entry);
  } catch {
    return false; // missing file, permission, … — same as the original `ok: false`
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing more we can do */
      }
    }
  }
}

/**
 * Fork-directory GC. Runs once per `buildSessionStack` (session start /
 * reload) — no timer.
 *
 * Multi-process safety (both premises are load-bearing, do not break them):
 * ① TTL: the dir is shared across pi processes, but any live consult run died
 *    within its 150 s totalMs hard cap, so a fork file still in use is orders
 *    of magnitude younger than the 24 h TTL;
 * ② fragment rule ("no valid header ⇒ delete regardless of mtime"): a fork
 *    file being created always started life with a complete header line (the
 *    very first write), so a headerless file can only be deletion aftermath
 *    (a `_persist` appendFileSync landing after an unlink), never a fork in
 *    progress.
 * Shortening the TTL to minutes, or judging fragments by tail completeness,
 * breaks one of these premises.
 */
export function sweepLegacyConsultForks(
  dir: string = legacyConsultForkDir(),
  ttlMs: number = LEGACY_FORK_TTL_MS,
  now: number = Date.now(),
): LegacyForkSweepResult {
  const result: LegacyForkSweepResult = { removedExpired: 0, removedFragments: 0, kept: 0, errors: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result; // missing/unreadable dir — nothing to sweep, not an error
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue; // never touch subdirectories
      if (now - st.mtimeMs > ttlMs) {
        unlinkSync(file);
        result.removedExpired++;
        continue;
      }
      if (!hasValidSessionHead(file)) {
        unlinkSync(file);
        result.removedFragments++;
        continue;
      }
      result.kept++;
    } catch {
      result.errors++;
    }
  }
  return result;
}
