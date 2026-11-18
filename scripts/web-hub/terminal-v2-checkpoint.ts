/** Offline maintenance API, not a production initializer. The only executable
 * adapter is the fixed controlled-scope entry below, never an existing-site JSON/
 * boolean/module-path assertion. Site maintenance still needs separate authorization. */
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
        "Executable private entry: terminal-v2-maintenance.ts fresh|cycle --private-parent <owned0700>. No existing-site adoption/deployment.",
    };
  return {
    exitCode: 78,
    message:
      "E_TRUSTED_ADAPTER_REQUIRED: no maintenance performed. Use the separately authorized P6 maintenance entry; --help for API boundary.",
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result =
    args[0] === "fresh" || args[0] === "cycle"
      ? await (await import("./terminal-v2-maintenance.js")).controlledMaintenanceCli(args)
      : checkpointCli(args);
  if (result.exitCode === 0 && (args[0] === "fresh" || args[0] === "cycle")) console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
}
