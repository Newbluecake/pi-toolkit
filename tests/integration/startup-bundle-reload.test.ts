/** #48: never vi.resetModules — a live pi 1.5 process must cross the real jiti/native boundary. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");

/** Dedicated process group: even a probe timeout/crash kills every private descendant, never a live hub. */
async function probe(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "JITI_RESPECT_TMPDIR_ENV",
      "PI_TOOLKIT_TEST_BASELINE_DIR",
      "PI_TOOLKIT_TEST_LEGACY_IMPORT",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.NODE_OPTIONS = "";
    const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(killGroup, 100_000);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      killGroup();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      killGroup();
      resolve({ code, stdout, stderr });
    });
  });
}

describe("native bundle import through the actual loaders", () => {
  it("query: jiti importer loses query but shipped native bridge preserves it", async () => {
    const result = await probe(["tests/startup-bundle/query-probe.mjs"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("PASS query:");
  });

  for (const mode of ["fixed", "upgrade"]) {
    it(
      `${mode}: rebuild replaces real code and identity; same build deliberately reuses module`,
      { timeout: 110_000 },
      async () => {
        const result = await probe(["--import", tsx, "tests/startup-bundle/reload-probe.mts", mode]);
        console.log(result.stdout);
        expect(result.code, result.stderr + result.stdout).toBe(0);
        expect(result.stdout).toContain(`PASS ${mode}:`);
        expect(result.stdout).toContain("SAME_BUILD_REUSED");
      },
    );
  }
});
