import { dedupeLinkPaths } from "./worktree-link-paths.js";

export interface WorktreeSettings {
  /** Worktree isolation is opt-in. */
  enabled: boolean;
  /** Per-command bound for git operations. */
  gitTimeoutMs: number;
  /**
   * workflow-worktree plan D9: repo-relative paths (canonicalLinkPath rules)
   * symlinked read-only from the main checkout into every fresh worktree —
   * e.g. `node_modules`. Default `[]`: git command sequence and prompt stay
   * byte-identical to pre-D9 behavior.
   */
  linkPaths: readonly string[];
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  enabled: false,
  gitTimeoutMs: 30_000,
  linkPaths: [],
};

export function mergeWorktreeSettings(value: unknown): WorktreeSettings {
  if (value === null || typeof value !== "object") return { ...DEFAULT_WORKTREE_SETTINGS };
  const input = value as Record<string, unknown>;
  return {
    enabled: input.enabled === true,
    gitTimeoutMs:
      typeof input.gitTimeoutMs === "number" && Number.isFinite(input.gitTimeoutMs)
        ? Math.max(1, input.gitTimeoutMs)
        : DEFAULT_WORKTREE_SETTINGS.gitTimeoutMs,
    linkPaths: dedupeLinkPaths(input.linkPaths),
  };
}
