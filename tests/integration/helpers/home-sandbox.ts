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
