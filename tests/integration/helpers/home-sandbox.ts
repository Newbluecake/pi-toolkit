import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Redirect `process.env.HOME` to an empty temp dir for the duration of a test
 * so quota credential refresh (reads `~/.pi/agent/auth.json`) stays hermetic:
 * with no auth.json present the credentials resolve to undefined and no real
 * HTTP request or state write happens.
 */
export function sandboxHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "pi-toolkit-home-"));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  return {
    home,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Remove BOTH settings-file names (+ the lock) in `dir`. After #54 a bare `rmSync(pi-subagent.json)` only drops
 * the compat symlink and leaves a stale `pi-toolkit.json` behind, so a test that "starts from no settings"
 * must go through this (or `resetSettingsFiles`).
 */
export function resetSettingsFilesIn(dir: string): void {
  for (const name of ["pi-toolkit.json", "pi-subagent.json", ".pi-subagent.json.lock"])
    rmSync(join(dir, name), { force: true });
}

/** `resetSettingsFilesIn(<home>/.pi/agent)`. */
export function resetSettingsFiles(home: string): void {
  resetSettingsFilesIn(join(home, ".pi", "agent"));
}
