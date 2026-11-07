/**
 * Vitest globalSetup for the `secure` project — the host half of the #27 P2 secure preflight
 * (docs/dev/test-speed/plan.md r3 §1 D9; appended to the base [global-tz] array in
 * vitest.workspace.ts). It probes the environment ONCE before any worker starts and provides
 * the verdict to every worker via `provide("secureEnv", …)`; the worker half lives in
 * tests/setup/secure-preflight.setup.ts.
 *
 * Contract (D9): EVERY normal exit provides the verdict first — incapable (no FUSE: CI) and
 * disabled (PI_TOOLKIT_SECURE_PREFLIGHT=0) take no lock and print nothing; clean prints one
 * summary line and holds the per-machine run lock (/tmp/pi-toolkit-secure-tests-<uid>.lock,
 * D11) until teardown; dirty prints every reason with its fix command (D10) and keeps the lock
 * until teardown too. runPreflight never throws — an internal failure surfaces as a
 * `preflight-error` dirty verdict so workers always get a conclusion (fail closed, r1 #1).
 *
 * Test-only; never imported from src/**. The FAKE env var is read here (tests/ only) so
 * tests/integration/secure-preflight-setup.test.ts can inject verdicts without touching the
 * real /tmp lock or any mount.
 */
import type { GlobalSetupContext } from "vitest/node";
import { renderCleanLine, renderPreflightFailure, runLockPath, runPreflight } from "../secure/preflight.js";

export default async function securePreflightGlobalSetup({ provide }: GlobalSetupContext): Promise<() => void> {
  const { verdict, release } = await runPreflight(process.env);
  provide("secureEnv", verdict); // before any return — every normal exit provides (D9)
  if (verdict.state === "clean") console.log(renderCleanLine(verdict, runLockPath()));
  if (verdict.state === "dirty") console.error(renderPreflightFailure(verdict));
  return () => {
    release?.();
  };
}
