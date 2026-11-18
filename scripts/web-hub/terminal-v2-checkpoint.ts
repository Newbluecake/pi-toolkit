/** Offline maintenance API, not a production initializer. Actual maintenance and
 * shell shutdown require separate authorization. P6 must wire a trusted adapter;
 * this CLI deliberately refuses JSON/boolean/module-path drain assertions. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMaintenance } from "./terminal-v2-maintenance/engine.js";
import type { MaintenanceOptions, MaintenanceTestHooks } from "./terminal-v2-maintenance/audit.js";
export function checkpointTerminalV2(
  mode: "fresh" | "checkpoint",
  options: MaintenanceOptions,
  hooks?: MaintenanceTestHooks,
) {
  return runMaintenance(mode, options, hooks);
}
export function checkpointCli(args: readonly string[]): { exitCode: number; message: string } {
  if (args.length === 1 && args[0] === "--help")
    return {
      exitCode: 0,
      message:
        "terminal-v2-checkpoint: tool-only checkpointTerminalV2(mode, {stateDir,evidenceDir,audit}). " +
        "Requires an audited in-process deployment/singleton/drain adapter. No default state path, force/reset, module loader or JSON drain input. " +
        "P6/P7 real adapter and O→N→O validation required before maintenance use.",
    };
  return {
    exitCode: 78,
    message:
      "E_TRUSTED_ADAPTER_REQUIRED: no maintenance performed. Use the separately authorized P6 maintenance entry; --help for API boundary.",
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkpointCli(process.argv.slice(2));
  console.error(result.message);
  process.exitCode = result.exitCode;
}
