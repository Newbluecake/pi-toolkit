/** Test-only diagnostic envelope. The actual maintenance CLI keeps its original
 * 30s deadline; allow 15s for its structured failure/lease cleanup to reach us. */
import { probeDiagnostics, formatProbeDiagnostics } from "../../../scripts/ci/safe-diagnostics.mjs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
export const RETAINED_FIXTURE_CLI_MS = 45000;
export function runRetainedFixtureCli(
  cli: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; observeExternal?: boolean },
): any {
  let schema: any;
  if (options.observeExternal) {
    try {
      schema = createRequire(import.meta.url)("../../../scripts/ci/external-probe-schema.mjs");
    } catch {
      /* missing evidence */
    }
  }
  const env = { ...options.env };
  delete env.PI_TOOLKIT_T51_EXTERNAL_DIAG;
  delete env.PI_TOOLKIT_T51_EXTERNAL_ONCE;
  if (options.observeExternal) env.PI_TOOLKIT_T51_EXTERNAL_ONCE = "existing-zero-first-v1";
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env,
    timeout: RETAINED_FIXTURE_CLI_MS,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  let evidence = "";
  if (options.observeExternal && schema) {
    try {
      evidence = schema.EXTERNAL_MARKER + schema.canonicalExternal(schema.extractExternal([result.stderr ?? ""]));
    } catch {
      evidence = schema.EXTERNAL_MARKER + schema.canonicalExternal(schema.unarmedExternal());
    }
  }
  let value: any;
  try {
    value = JSON.parse(result.stdout ?? "");
  } catch {
    // Do not dump raw stderr/stdout (may include private fixture material).
  }
  if (result.error || result.status !== 0 || result.signal) {
    const internal =
      typeof value?.error === "string" && /^E_[A-Z0-9_]+$/.test(value.error) ? value.error : "unavailable";
    const probe = probeDiagnostics(result.stderr ?? "");
    throw new Error(
      `retained fixture CLI ${args[0]}: status=${result.status} signal=${result.signal} outer=${(result.error as NodeJS.ErrnoException | undefined)?.code ?? "none"} internal=${internal} ${formatProbeDiagnostics(probe)}${evidence ? "\n" + evidence : ""}`,
    );
  }
  if (value === undefined)
    throw new Error("retained fixture CLI: invalid JSON success" + (evidence ? "\n" + evidence : ""));
  if (evidence) {
    try {
      console.error(evidence);
    } catch {
      /* missing evidence */
    }
  }
  return value;
}
