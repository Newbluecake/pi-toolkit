/** Complete local npm test/test:tier2 entry. Partition ownership is unchanged;
 * only the explicitly provisioned stock file moves to its mandatory four cells. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { cell, command, privateEnvironment, provision, STOCK_FILE } from "./terminal-stock.mjs";
const args = process.argv.slice(2),
  tier2 = args.includes("--tier2");
assert(
  args.every((arg) => arg === "--tier2" || arg === "--no-cache" || /^--maxWorkers=[12]$/.test(arg)),
  "full-suite entry accepts only --tier2/--no-cache/--maxWorkers=1|2; use vitest directly for directed tests",
);
const env = privateEnvironment(process.env.PI_TOOLKIT_TEST_PRIVATE_ROOT ?? mkdtempSync("/tmp/t51-"));
console.log(`Complete suite private evidence root: ${env.PI_TOOLKIT_TEST_PRIVATE_ROOT}`);
// These are the same builds CI performs, ONCE; pack/release reuse their outputs.
for (const script of ["build", "build:web", "check:web"])
  command("npm", ["run", script], { ...env, NODE_ENV: "production" }, { stdio: "inherit" });
const ordinary = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    ...(tier2 ? ["--project", "tier2", "--project", "secure"] : []),
    "--exclude",
    STOCK_FILE,
    "--no-cache",
    args.find((arg) => arg.startsWith("--maxWorkers=")) ?? "--maxWorkers=2",
  ],
  { env, stdio: "inherit" },
);
// Run required dedicated coverage even when the ordinary suite is red. Never
// convert either failure to success; all cells are attempted in independent OS processes.
let failed = Boolean(ordinary.error || ordinary.status !== 0 || ordinary.signal);
provision(env);
for (const format of ["npm", "zip"])
  for (const phase of ["restart", "rollback"]) {
    try {
      cell(env, format, phase);
    } catch (error) {
      console.error(error.message);
      failed = true;
    }
  }
process.exitCode = failed ? 1 : 0;
