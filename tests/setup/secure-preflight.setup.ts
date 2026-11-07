/**
 * Vitest setupFile for the `secure` project — the worker half of the #27 P2 secure preflight
 * (D9; appended to the base [sandbox-home] array in vitest.workspace.ts). Runs in every worker
 * BEFORE the test module is imported, so its file-level beforeAll is registered first and runs
 * before the test file's own hooks.
 *
 * Behaviour per the D9 table:
 *   dirty     — throw at the file-level beforeAll with the full `[secure-preflight]` error
 *               (reasons + fix commands, the same text the global setup printed). Test bodies
 *               and describe-level beforeAlls never run; the file's own afterAll hooks still
 *               run; module-level code of the test file has already run either way.
 *   incapable / disabled / clean — no-op, byte-identical with the pre-#27 worker behaviour
 *               (the real blocks keep self-skipping exactly as before).
 *
 * `inject("secureEnv") === undefined` means the wiring is broken (the global setup did not run
 * for this project) — throw immediately, fail closed (D9, r1 review #1).
 *
 * Test-only; never imported from src/**.
 */
import { beforeAll, inject } from "vitest";
import { renderPreflightFailure, type SecureEnvVerdict } from "../secure/preflight.js";

const verdict: SecureEnvVerdict | undefined = inject("secureEnv");
if (verdict === undefined) {
  throw new Error(
    "[secure-preflight] wiring error: `secureEnv` was not provided to this worker — " +
      "tests/setup/secure-preflight.global.ts did not run for the secure project. " +
      "vitest.workspace.ts must append it to the project's globalSetup (after the base global-tz). " +
      "Fail-closed by design (plan r3 D9).",
  );
}
if (verdict.state === "dirty") {
  beforeAll(() => {
    throw new Error(renderPreflightFailure(verdict));
  });
}
