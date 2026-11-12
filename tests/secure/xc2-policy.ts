/** XC2-only version policy. Uses the product's existing parser/minimum, never executes a tool. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain-JS helper API
const H: any = await import(pathToFileURL(join(import.meta.dirname, "../../src/secure/bin/helper.mjs")).href);

declare module "@vitest/runner" {
  interface TaskMeta {
    xc2ModeSkip?: string;
  }
}

export function xc2VersionPolicy(result: { status: number | null; out: string }): {
  version: string;
  exact0440: boolean;
  skipReason: string;
} {
  if (result.status !== 0)
    throw new Error(`[XC2] gocryptfs version probe failed (exit ${result.status}): ${result.out}`);
  const v: number[] | undefined = H.parseGocryptfsVersion(result.out);
  if (!v || !v.every(Number.isSafeInteger)) throw new Error(`[XC2] unrecognized gocryptfs version: ${result.out}`);
  if (!H.versionAtLeast(v, H.GOCRYPTFS_MIN))
    throw new Error(`[XC2] unsupported gocryptfs ${v.join(".")}; minimum ${H.GOCRYPTFS_MIN.join(".")}`);
  const version = v.join(".");
  const exact0440 = v[0] === 1 && v[1] === 8;
  return {
    version,
    exact0440,
    skipReason: exact0440
      ? ""
      : `[XC2] SKIP diriv 0440 baseline: actual gocryptfs ${version}; exact mode assertion is scoped to 1.8.x`,
  };
}
