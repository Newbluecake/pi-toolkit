/** Secure-only host gate. Explicit deps are for synthetic workspaces, never env-controlled. */
import type { GlobalSetupContext } from "vitest/node";
import {
  renderCleanLine,
  renderExternalSkip,
  renderPreflightFailure,
  runLockPath,
  runPreflight,
  type PreflightDeps,
} from "../secure/preflight.js";

export async function setupSecurePreflight({ provide }: GlobalSetupContext, deps?: PreflightDeps): Promise<() => void> {
  const { verdict, release } = await runPreflight(process.env, deps);
  // Global-setup failures need not receive Vitest teardown: release before throwing/provide failure.
  let handedOff = false;
  try {
    provide("secureEnv", verdict);
    if (verdict.state === "dirty") throw new Error(renderPreflightFailure(verdict));
    if (verdict.state === "clean") console.log(renderCleanLine(verdict, runLockPath()));
    if (verdict.state === "external-mounts") console.warn(renderExternalSkip(verdict));
    handedOff = true;
    return () => release?.();
  } finally {
    if (!handedOff) release?.();
  }
}

export default async function securePreflightGlobalSetup(ctx: GlobalSetupContext): Promise<() => void> {
  return setupSecurePreflight(ctx);
}
