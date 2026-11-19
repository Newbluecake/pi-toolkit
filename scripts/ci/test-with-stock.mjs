/** Complete local entry: ordinary environment first, dedicated stock env ONLY
 * at provision/cell. Ports below are test-only orchestration seams, not CLI/env
 * bypasses; default execution always invokes the real selection/build/four cells. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cell, command, privateEnvironment, provision } from "./terminal-stock.mjs";
import { runExisting } from "./retained-existing.mjs";
import { checkSelection, ordinaryEnvironment } from "./ordinary-tests.mjs";
export function runCompleteSuite(args, source = process.env, ports = {}) {
  assert(
    args.every((arg) => arg === "--tier2" || arg === "--no-cache" || /^--maxWorkers=[12]$/.test(arg)),
    "full-suite entry accepts only --tier2/--no-cache/--maxWorkers=1|2; use vitest directly for directed tests",
  );
  const check = ports.checkSelection ?? checkSelection;
  const execute = ports.command ?? command;
  const spawn = ports.spawnSync ?? spawnSync;
  const prepare = ports.provision ?? provision;
  const runCell = ports.cell ?? cell;
  const runSerial = ports.existing ?? runExisting;
  const ordinaryEnv = ordinaryEnvironment(source);
  check(ordinaryEnv);
  for (const script of ["build", "build:web", "check:web"])
    execute("npm", ["run", script], { ...ordinaryEnv, NODE_ENV: "production" }, { stdio: "inherit" });
  const ordinary = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...(args.includes("--tier2") ? ["--project", "tier2", "--project", "secure"] : []),
      "--no-cache",
      args.find((arg) => arg.startsWith("--maxWorkers=")) ?? "--maxWorkers=2",
    ],
    { env: ordinaryEnv, stdio: "inherit" },
  );
  let failed = Boolean(ordinary.error || ordinary.status !== 0 || ordinary.signal);
  // An ordinary failure must not prevent the independent required evidence lane.
  if (runSerial(source) !== 0) failed = true;
  const env = privateEnvironment(source.PI_TOOLKIT_TEST_PRIVATE_ROOT ?? mkdtempSync("/tmp/t51-"));
  console.log(`Dedicated stock evidence root: ${env.PI_TOOLKIT_TEST_PRIVATE_ROOT}`);
  prepare(env);
  for (const format of ["npm", "zip"])
    for (const phase of ["restart", "rollback"]) {
      try {
        runCell(env, format, phase);
      } catch {
        failed = true;
      } // cell emits ONLY its schema-filtered failure summary.
    }
  return failed ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runCompleteSuite(process.argv.slice(2));
