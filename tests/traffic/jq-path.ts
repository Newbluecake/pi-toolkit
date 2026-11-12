import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

// Test-only override; leave the distinct historical defaults untouched when absent.
export function selectTestJqPath(override: string | undefined): string | undefined {
  if (override === undefined) return undefined;
  if (!override || !isAbsolute(override))
    throw new Error("PI_TOOLKIT_TEST_JQ_PATH must be an absolute executable file");
  try {
    accessSync(override, constants.X_OK);
    if (!statSync(override).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`PI_TOOLKIT_TEST_JQ_PATH is not an executable file: ${override}`);
  }
  return override;
}
