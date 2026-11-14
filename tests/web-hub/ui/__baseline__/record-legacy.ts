// @vitest-environment happy-dom
/** ONE-SHOT recorder: copy this as record-legacy.test.ts plus legacyScenario.ts into the
 * baseline worktree at 60b2e838, then run that test there with U1_BASELINE_OUTPUT pointing to
 * the new __baseline__/legacy-60b2e838.json. Never imported/run by the normal suite.
 * Refuses other revisions and refuses to overwrite an existing fixture. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { captureLegacyScenarios } from "./legacyScenario.js";
it("record the declared legacy baseline once", async () => {
  const revision = execFileSync("git", ["-c", "log.showSignature=false", "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
  expect(revision.startsWith("60b2e838")).toBe(true);
  const output = process.env["U1_BASELINE_OUTPUT"];
  if (!output) throw new Error("U1_BASELINE_OUTPUT required");
  const data = await captureLegacyScenarios();
  writeFileSync(output, JSON.stringify({ ...data, recordedFrom: revision }, null, 2) + "\n", { flag: "wx" });
});
