// §6 `/mem doctor` command dispatch — STUB (todo #22 P0-b's frozen-surface
// commit; real implementation lands in package P3, §14.1). Signature is
// frozen: `command.ts` calls this unconditionally for `/mem doctor`, so P3
// can fill the body in without touching the call site.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryPaths } from "./paths.js";

export interface DoctorCommandDeps {
  paths?: MemoryPaths;
}

/**
 * Not implemented yet. Throws so `command.ts`'s existing try/catch reports
 * it as a normal (non-fatal) `ctx.ui.notify(…, "warning")` command error —
 * `/mem doctor` is reachable under the default settings today, it just
 * doesn't do anything until P3 ships `doctor.ts`'s `runDoctor`.
 */
export async function handleMemDoctorCommand(
  _args: string,
  _ctx: ExtensionCommandContext,
  _deps: DoctorCommandDeps,
): Promise<void> {
  throw new Error("/mem doctor: not implemented yet (todo #22 P3)");
}
