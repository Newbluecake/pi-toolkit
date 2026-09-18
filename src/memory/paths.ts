// Pure, pi-independent path/slug layer for the memory module.
//
// Claude Code keys memory by cwd (e.g. ~/local-dev/core -> memory at
// ~/.claude/projects/-Users-rector-local-dev-core/memory/). pi-toolkit mirrors
// that model: ~/.pi/agent/memory/<cwd-slug>/*.md — slug 算法与原插件逐字一致
// （方案 §5.7），存量 memory 零迁移生效。
//
// Kept free of any pi/typebox imports so it can be unit-tested standalone.

import { homedir } from "node:os";
import { join } from "node:path";

export class MemoryError extends Error {}

export interface MemoryPaths {
  readonly memoryRoot: string;
  readonly ccProjectsRoot: string;
}

/**
 * Resolve the effective roots. The ARMORY_MEMORY_ROOT / CC_PROJECTS_ROOT env
 * overrides are kept for compatibility with the original plugin's test hooks.
 * Read at call time (no memoization) so `vi.stubEnv` keeps working.
 */
export function defaultPaths(): MemoryPaths {
  return {
    memoryRoot: process.env.ARMORY_MEMORY_ROOT || join(homedir(), ".pi", "agent", "memory"),
    ccProjectsRoot: process.env.CC_PROJECTS_ROOT || join(homedir(), ".claude", "projects"),
  };
}

/** Encode a filesystem path the Claude-Code way: '/' -> '-', trailing slashes
 *  stripped, no extra prepend. e.g. /Users/x/core -> -Users-x-core (the
 *  leading '/' is the single leading dash). 算法逐字对齐原插件（方案 §5.7）。 */
export function toSlug(cwd: string): string {
  const clean = cwd.replace(/\/+$/, ""); // strip trailing slash
  return clean.replace(/\//g, "-");
}

/** Best-effort decode of a slug back to a path (display only — lossy when real
 *  directory names contain '-'; see 方案 §5.7). */
export function fromSlug(slug: string): string {
  return slug.replace(/^-+/, "/").replace(/-/g, "/");
}

/** The memory dir for a given cwd (does NOT create it). */
export function memoryDirFor(cwd: string, paths?: MemoryPaths): string {
  return join((paths ?? defaultPaths()).memoryRoot, toSlug(cwd));
}
