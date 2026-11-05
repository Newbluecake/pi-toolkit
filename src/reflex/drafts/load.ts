/**
 * jev-reflex · #25 B0 runtime draft loader — SKELETON (BA §4.6). The full bounded, no-follow,
 * fail-closed implementation lands in B4; B0 freezes the seams so wire/command/tests can be built
 * against them: the `DraftFs` injectable surface, the open-flags constant (mirrors
 * `SESSION_READ_FLAGS` — a test asserts numeric equality), and the `loadDrafts` signature with an
 * ALWAYS-EMPTY result (no fs access whatsoever until B4 wires it).
 *
 * `src/reflex/drafts/**` is inside the pi-free value closure (R-I10 extension, #25): no pi imports.
 */

import { constants as FS_CONSTANTS } from "node:fs";
import type { Clock } from "../../core/clock.js";
import type { DraftLoadResult } from "../core/types.js";

/** Open discipline for draft files: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` — the same
 *  combination as `session-nav/session-head.ts` `SESSION_READ_FLAGS` (mirrored on purpose: the
 *  boundary gate forbids importing it; `tests/reflex/core` asserts the two constants are equal). */
export const DRAFT_READ_FLAGS: number =
  FS_CONSTANTS.O_RDONLY |
  (FS_CONSTANTS.O_NOFOLLOW ?? 0) |
  (FS_CONSTANTS.O_NONBLOCK ?? 0) |
  (FS_CONSTANTS.O_NOCTTY ?? 0);

/** The structural slice of `node:fs/promises` the loader uses — injectable for tests (BA §4.6). */
export interface DraftStatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  gid: number;
  mode: number;
  size: number;
  dev: number;
  ino: number;
}

export interface DraftFileHandleLike {
  /** Same-fd stat: the descriptor was opened O_NOFOLLOW, so this stat cannot chase a swapped symlink. */
  stat(): Promise<DraftStatLike>;
  /** Bounded read (≤ DRAFT_MAX_FILE_BYTES + 1). */
  read(buffer: Buffer, position: number | null, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface DraftDirLike {
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<{ name: string }>;
}

export interface DraftFs {
  lstat(path: string): Promise<DraftStatLike>;
  opendir(path: string): Promise<DraftDirLike>;
  open(path: string, flags: number): Promise<DraftFileHandleLike>;
}

/**
 * Load the drafts directory (BA §4.6 rules 1–5). B0 skeleton: deterministically EMPTY — drafts are
 * default-off and the loader is not wired yet; this function performs NO I/O and never rejects.
 * B4 replaces the body with the bounded scan (trusted dir → opendir ≤ DIR_SCAN_CAP → name
 * whitelist → no-follow fd read ≤ cap+1 → dev/ino recheck → clampSpanMs(DRAFT_LOAD_BUDGET_MS)).
 */
export async function loadDrafts(
  _dir: string,
  _builtinIds: ReadonlySet<string>,
  _clock: Clock,
  _signal: AbortSignal,
  _fs?: DraftFs,
): Promise<DraftLoadResult> {
  return { loaded: [], rejected: [] };
}
