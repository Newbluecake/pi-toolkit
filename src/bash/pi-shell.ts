import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * bash shell-resolution revision (2026-10-17): pi-facing reader for the two pi
 * settings the bash override must honour exactly like pi's built-in bash tool:
 *
 *  - `shellPath` — pi resolves it itself in `SettingsManager.getShellPath()`
 *    (leading `~` expanded via `normalizePath`, project settings over global,
 *    `dist/core/settings-manager.js`), and its `getShellConfig` runs it first
 *    in the resolution chain. Our `resolveShell` slots it between the explicit
 *    `bashJobs.shellPath` and pi's default chain.
 *  - `shellCommandPrefix` — pi's `createShellToolDefinition` prepends it to
 *    every command as `${prefix}\n${command}` (`dist/core/tools/bash.js`), for
 *    the built-in bash tool AND user `!`/`!!` commands alike; the override
 *    passes it into the inner `createBashToolDefinition` so pi's own code does
 *    the identical prepending for foreground and background jobs.
 *
 * Read once per session stack build (main session, `src/stack.ts`) / per child
 * wire (`src/bash/child.ts`) — non-live, like every other bash setting. Any
 * read failure degrades to "nothing set" (the resolution chain then falls to
 * pi's default chain), never a thrown session build.
 */
export interface PiShellSettings {
  /** pi settings `shellPath`, `~`-expanded, project over global; absent when unset. */
  readonly shellPath?: string;
  /** pi settings `shellCommandPrefix`; absent when unset. */
  readonly shellCommandPrefix?: string;
}

/** Structural slice of `SettingsManager` the resolution needs (test seam). */
export interface PiShellSettingsSource {
  getShellPath(): string | undefined;
  getShellCommandPrefix(): string | undefined;
}

/** Extract + sanitize (never throw) the two fields from a settings source. */
export function shellSettingsFrom(source: PiShellSettingsSource | undefined): PiShellSettings {
  if (source === undefined) return {};
  let shellPath: string | undefined;
  let shellCommandPrefix: string | undefined;
  try {
    const raw = source.getShellPath();
    if (typeof raw === "string" && raw.length > 0) shellPath = raw;
  } catch {
    /* degrade to unset */
  }
  try {
    const raw = source.getShellCommandPrefix();
    if (typeof raw === "string" && raw.length > 0) shellCommandPrefix = raw;
  } catch {
    /* degrade to unset */
  }
  return {
    ...(shellPath !== undefined ? { shellPath } : {}),
    ...(shellCommandPrefix !== undefined ? { shellCommandPrefix } : {}),
  };
}

/**
 * Read pi's `shellPath` / `shellCommandPrefix` from the real settings files
 * (`SettingsManager.create` — the same discovery `src/runtime/session-driver.ts`
 * uses; global `~/.pi/agent/settings.json` merged with the project's
 * `.pi/settings.json`, pi's own precedence). Never throws.
 */
export function readPiShellSettings(cwd: string, agentDir?: string): PiShellSettings {
  try {
    return shellSettingsFrom(SettingsManager.create(cwd, agentDir ?? getAgentDir()));
  } catch {
    return {};
  }
}
