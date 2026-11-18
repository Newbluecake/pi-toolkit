/** Independent rollback inspection/evidence tool. Never starts O, kills N,
 * lowers a version floor, deletes witnesses or claims O understands a v2 marker. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMaintenance } from "./terminal-v2-maintenance/engine.js";
import type { MaintenanceOptions, MaintenanceTestHooks } from "./terminal-v2-maintenance/audit.js";
export function rollbackTerminalV2(options: MaintenanceOptions, hooks?: MaintenanceTestHooks) {
  return runMaintenance("rollback", options, hooks);
}
export function rollbackCli(args: readonly string[]): { exitCode: number; message: string } {
  if (args.length === 1 && args[0] === "--help")
    return {
      exitCode: 0,
      message:
        "terminal-v2-rollback: tool-only rollbackTerminalV2({stateDir,evidenceDir,audit}). " +
        "Requires N real drain, zero allocations/backend/futures, unchanged clean O bytes and a trusted singleton/deployment adapter. " +
        "Emits rollback eligibility evidence only; does NOT launch O or lower its version floor. Old O does not understand v2 markers. " +
        "Executable private rehearsal: --controlled-cycle --private-parent <owned0700> constructs actual O/N states; never adopts an existing site.",
    };
  return {
    exitCode: 78,
    message:
      "E_TRUSTED_ADAPTER_REQUIRED: no rollback performed. A JSON/boolean drain claim is not physical proof. Use the separately authorized P6 maintenance entry.",
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result =
    args[0] === "--controlled-cycle"
      ? await (await import("./terminal-v2-maintenance.js")).controlledMaintenanceCli(["cycle", ...args.slice(1)])
      : rollbackCli(args);
  if (result.exitCode === 0 && args[0] === "--controlled-cycle") console.log(result.message);
  else console.error(result.message);
  process.exitCode = result.exitCode;
}
