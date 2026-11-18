/** Authorized controlled-scope maintenance executable, NOT a site deployment command.
 * Every operation creates a NEW private scope. It cannot adopt a directory, load an
 * operator adapter or take JSON/boolean physical claims. Files/evidence are retained.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlledDeployment } from "./terminal-v2-maintenance/deployment.js";
export const MAINTENANCE_USAGE =
  "terminal-v2-maintenance fresh|cycle --private-parent <existing-owned-0700-dir>\n" +
  "Creates one new controlled scope, measures actual source/build and holds filesystem deployment + original singleton fences. No install, existing-site adoption, force/reset, module/JSON drain input, deployment or downgrade.";
export async function controlledMaintenanceCli(
  args: readonly string[],
): Promise<{ exitCode: number; message: string }> {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, message: MAINTENANCE_USAGE };
  if (args.length !== 3 || !["fresh", "cycle"].includes(args[0] ?? "") || args[1] !== "--private-parent" || !args[2])
    return { exitCode: 64, message: MAINTENANCE_USAGE };
  let deployment: ControlledDeployment | undefined;
  let result: { exitCode: number; message: string };
  try {
    deployment = await ControlledDeployment.create(args[2]);
    result = {
      exitCode: 0,
      message: JSON.stringify(args[0] === "fresh" ? await deployment.fresh() : await deployment.cycle()),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "E_CONTROLLED_MAINTENANCE";
    const scope = deployment?.scope.directory.path ?? (error as { controlledScope?: string })?.controlledScope;
    result = {
      exitCode: 1,
      message: JSON.stringify({ error: code, effect: "unknown", scope, evidenceRetained: true }),
    };
  } finally {
    try {
      await deployment?.close();
    } catch {
      result = {
        exitCode: 1,
        message: JSON.stringify({
          error: "E_OWNED_CLEANUP_UNKNOWN",
          effect: "unknown",
          scope: deployment?.scope.directory.path,
          evidenceRetained: true,
        }),
      };
    }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await controlledMaintenanceCli(process.argv.slice(2));
  console.log(result.message);
  process.exitCode = result.exitCode;
}
