/** Keep the frozen HTTP/audit suite in the ordinary tests/web-hub gate, not opt-in only.
 * The observer runs each original test in its own normal Vitest file scope (importing their
 * modules into one test file would incorrectly merge their beforeEach/afterEach hooks).
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("F5 pre-extraction HTTP/audit golden", () => {
  it("replays all existing headless route suites unchanged against the immutable baseline", () => {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "tests/web-hub/hub/spawn/golden.config.ts",
        "tests/web-hub",
      ],
      {
        encoding: "utf8",
        timeout: 150_000,
        env: { ...process.env, F5_CAPTURE_GOLDEN: "0" },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/162 passed/);
  }, 160_000);
});
