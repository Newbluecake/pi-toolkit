/** Test-only diagnostic envelope. The actual maintenance CLI keeps its original
 * 30s deadline; allow 15s for its structured failure/lease cleanup to reach us. */
import { spawnSync } from "node:child_process";
export const RETAINED_FIXTURE_CLI_MS = 45000;
export function runRetainedFixtureCli(
  cli: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): any {
  const result = spawnSync(process.execPath, [cli, ...args], {
    ...options,
    timeout: RETAINED_FIXTURE_CLI_MS,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  let value: any;
  try {
    value = JSON.parse(result.stdout ?? "");
  } catch {
    // Do not dump raw stderr/stdout (may include private fixture material).
  }
  if (result.error || result.status !== 0 || result.signal) {
    const internal =
      typeof value?.error === "string" && /^E_[A-Z0-9_]+$/.test(value.error) ? value.error : "unavailable";
    throw new Error(
      `retained fixture CLI ${args[0]}: status=${result.status} signal=${result.signal} outer=${result.error?.code ?? "none"} internal=${internal}`,
    );
  }
  if (value === undefined) throw new Error("retained fixture CLI: invalid JSON success");
  return value;
}
