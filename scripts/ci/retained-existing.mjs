/** Required isolated real-SDK file. Same production/test deadlines and assertions;
 * workers1 is load isolation, NOT proof of the unique remote reload root cause. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXISTING_FILE, existingEnvironment, listFiles } from "./ordinary-tests.mjs";
import { probeDiagnostics } from "./safe-diagnostics.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function verifyExistingReport(report) {
  assert.equal(report.success, true);
  assert.equal(report.numPassedTests, 3, "all three parameter cells required");
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.testResults.length, 1);
  const suite = report.testResults[0];
  assert(suite.name.endsWith(`/${EXISTING_FILE}`));
  assert.equal(suite.assertionResults.length, 3);
  for (const count of [0, 1, 2]) {
    const name = `ordinary O (${count} resources; two uses distinct SDK sessions) retains debt through N/restart/new CLI/off rollback`;
    assert.equal(
      suite.assertionResults.filter((test) => test.fullName.trim() === name && test.status === "passed").length,
      1,
      "missing/skipped/wrong existing cell",
    );
  }
}
export function runExisting(source = process.env, ports = {}) {
  const env = existingEnvironment(source);
  assert.deepEqual(listFiles("tier2", env), [EXISTING_FILE]);
  // Evidence directory only; never inject its nested path as HOME/TMPDIR.
  const root = mkdtempSync("/tmp/t51-existing-"),
    reportPath = join(root, "result.json");
  const result = (ports.spawnSync ?? spawnSync)(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--project",
      "tier2",
      "--maxWorkers=1",
      "--no-cache",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: repo, env, encoding: "utf8", timeout: 290000, maxBuffer: 16 * 1024 * 1024 },
  );
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(join(root, "private.log"), raw, { mode: 0o600 });
  let report,
    passed = false;
  try {
    assert(!result.error && result.status === 0 && !result.signal, "serial runner failed");
    report = JSON.parse(readFileSync(reportPath, "utf8"));
    verifyExistingReport(report);
    passed = true;
  } catch {
    // Read the real report for CLOSED diagnostic extraction only, never print it.
    try {
      const bytes = readFileSync(reportPath);
      if (bytes.length <= 16 * 1024 * 1024) report = JSON.parse(bytes.toString());
    } catch {
      /* unavailable */
    }
  }
  const messages = `${raw}\n${JSON.stringify(report ?? {})}`;
  const summary = {
    v: 1,
    lane: "retained-existing",
    measure: "load-isolation",
    rootCauseProven: false,
    result: passed ? "passed" : "failed",
    required: 3,
    passed: passed ? 3 : null,
    status: Number.isInteger(result.status) ? result.status : null,
    signal: ["SIGKILL", "SIGTERM", "SIGABRT"].includes(result.signal) ? result.signal : null,
    outerTimeout: result.error?.code === "ETIMEDOUT",
    ...(passed
      ? {}
      : {
          codes: [
            ...new Set(
              messages.match(/\bE_RETAINED_(?:LOAD_PROBE_(?:DEADLINE|FAILED|RECEIPT)|SOURCE_PROFILE_MISMATCH)\b/g) ??
                [],
            ),
          ],
          probe: probeDiagnostics(messages),
        }),
  };
  writeFileSync(join(root, "safe.json"), JSON.stringify(summary) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary));
  return passed ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runExisting();
