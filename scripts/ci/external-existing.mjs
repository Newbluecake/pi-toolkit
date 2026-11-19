/** OPTIONAL H4 evidence entry, not a substitute for required3. No raw uploads.
 * observed-pass is always inconclusive: this cannot establish root cause. */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXISTING_FILE, existingEnvironment, listFiles } from "./ordinary-tests.mjs";
import {
  EXTERNAL_PUBLIC,
  EXTERNAL_PERMIT,
  EXTERNAL_SELECTION,
  canonicalExternal,
  extractExternal,
  unarmedExternal,
} from "./external-probe-schema.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const name =
  "ordinary O (0 resources; two uses distinct SDK sessions) retains debt through N/restart/new CLI/off rollback";
export function externalFromResult(result, report) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw Error("runner incomplete");
  if (!report || report.testResults?.length !== 1) throw Error("wrong report");
  const suite = report.testResults[0];
  if (
    !suite.name.endsWith(`/${EXISTING_FILE}`) ||
    suite.assertionResults?.length !== 1 ||
    suite.assertionResults[0].fullName.trim() !== name ||
    !["passed", "failed"].includes(suite.assertionResults[0].status)
  )
    throw Error("wrong selection");
  const streams = [result.stdout ?? "", result.stderr ?? "", ...(suite.assertionResults[0].failureMessages ?? [])];
  const snapshot = extractExternal(streams);
  if (snapshot.selection !== "existing-zero-first") throw Error("not armed");
  return snapshot;
}
export function runExternalExisting(source = process.env, ports = {}, args = ["--diagnose-external-once"]) {
  let snapshot = unarmedExternal(),
    exitCode = 1;
  if (args.length === 1 && args[0] === "--diagnose-external-once" && source[EXTERNAL_PUBLIC] === EXTERNAL_SELECTION) {
    try {
      const env = existingEnvironment(source);
      delete env[EXTERNAL_PERMIT];
      env[EXTERNAL_PUBLIC] = EXTERNAL_SELECTION;
      const selected = (ports.listFiles ?? listFiles)("tier2", env);
      if (JSON.stringify(selected) !== JSON.stringify([EXISTING_FILE])) throw Error("wrong selection");
      // Owned private directory, never a stock environment or artifact upload root.
      const parent = join(env.HOME, ".pi-t51-external");
      mkdirSync(parent, { mode: 0o700, recursive: true });
      const parentStat = lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0)
        throw Error("unsafe evidence directory");
      const root = mkdtempSync(join(parent, "run-")),
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
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${reportPath}`,
        ],
        { cwd: repo, env, encoding: "utf8", timeout: 290000, maxBuffer: 16 * 1024 * 1024 },
      );
      // No raw bytes printed, including runner exceptions, report failures or paths.
      const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw Error("oversize raw log");
      writeFileSync(join(root, "private.log"), raw, { mode: 0o600 });
      if (statSync(reportPath).size > 16 * 1024 * 1024) throw Error("oversize report");
      snapshot = externalFromResult(result, JSON.parse(readFileSync(reportPath, "utf8")));
      writeFileSync(join(root, "safe.json"), canonicalExternal(snapshot) + "\n", { mode: 0o600 });
      exitCode = 0; // Evidence only, even when the original product failed. NOT root cause closure.
    } catch {
      snapshot = unarmedExternal();
    }
  }
  console.log(canonicalExternal(snapshot));
  return exitCode;
}
