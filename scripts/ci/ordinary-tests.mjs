/** Real workspace selection, not Vitest 2's root-only CLI --exclude. Ownership
 * stays in tests/tiers.ts. The ordinary lane subtracts ONLY stock + retained-existing in the workspace. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const EXISTING_FILE = "tests/integration/terminal-v2-retained-existing.test.ts";
export const STOCK_FILE = "tests/integration/terminal-v2-retained-stock-restart.test.ts";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const ordinaryExcludes = (env = process.env) =>
  env.PI_TOOLKIT_TEST_LANE === "ordinary" ? [STOCK_FILE, EXISTING_FILE] : [];
export const tier2LaneInclude = (baseline, env = process.env) =>
  env.PI_TOOLKIT_TEST_LANE === "retained-existing" ? [EXISTING_FILE] : baseline;
export function existingEnvironment(source = process.env) {
  return { ...ordinaryEnvironment(source), PI_TOOLKIT_TEST_LANE: "retained-existing" };
}
export function ordinaryEnvironment(source = process.env) {
  // Do NOT create/import stock HOME/cache/TMPDIR here. Preserve the caller's
  // legitimate ordinary paths, including CI's original /tmp, byte for byte.
  const stockRoot = source.PI_TOOLKIT_TEST_PRIVATE_ROOT;
  if (stockRoot && source.PI_TOOLKIT_STOCK_CONSUMERS) {
    for (const [key, suffix] of [
      ["HOME", "h"],
      ["TMPDIR", "t"],
      ["TMP", "t"],
      ["TEMP", "t"],
      ["XDG_CACHE_HOME", "c"],
    ])
      assert.notEqual(
        source[key],
        `${stockRoot}/${suffix}`,
        "ordinary lane cannot inherit a dedicated stock environment",
      );
  }
  const env = { ...source, PI_TOOLKIT_TEST_LANE: "ordinary" };
  for (const key of Object.keys(env))
    if (key.startsWith("PI_TOOLKIT_STOCK_") || key === "PI_TOOLKIT_TEST_PRIVATE_ROOT") delete env[key];
  return env;
}
export function listFiles(project, env, extra = []) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "list", "--filesOnly", "--project", project, ...extra],
    { cwd: repo, env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );
  assert(!result.error && result.status === 0 && !result.signal, "vitest list failed");
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert(
    lines.every((line) => line.startsWith(`[${project}] tests/`)),
    "unexpected list output",
  );
  return lines.map((line) => line.slice(project.length + 3)).sort();
}
export function assertSelection(baseline, ordinary, existing) {
  for (const project of ["tier1", "tier2", "secure"]) {
    assert(baseline[project]?.length > 0 && ordinary[project]?.length > 0, "empty project selection");
    assert.equal(new Set(baseline[project]).size, baseline[project].length, "duplicate baseline");
    const expected = baseline[project].filter((path) => path !== STOCK_FILE && path !== EXISTING_FILE);
    assert.deepEqual(
      ordinary[project],
      expected,
      `${project}: ordinary must subtract only stock and retained-existing`,
    );
  }
  assert(baseline.tier2.includes(STOCK_FILE), "stock must remain owned by tier2");
  assert(baseline.tier2.includes(EXISTING_FILE), "retained-existing must remain owned by tier2");
  assert.deepEqual(existing, [EXISTING_FILE], "required serial lane must select exactly retained-existing");
  assert.deepEqual(
    [...ordinary.tier2, ...existing, STOCK_FILE].sort(),
    baseline.tier2,
    "ordinary + required lanes must cover tier2 without loss/duplicates",
  );
  assert(
    !ordinary.tier1.includes(STOCK_FILE) &&
      !ordinary.tier2.includes(STOCK_FILE) &&
      !ordinary.secure.includes(STOCK_FILE),
  );
}
export function checkSelection(source = process.env) {
  const env = { ...source };
  delete env.PI_TOOLKIT_TEST_LANE;
  const baseline = {},
    ordinary = {};
  for (const project of ["tier1", "tier2", "secure"]) {
    baseline[project] = listFiles(project, env);
    ordinary[project] = listFiles(project, ordinaryEnvironment(env));
  }
  const existing = listFiles("tier2", existingEnvironment(env));
  assertSelection(baseline, ordinary, existing);
  console.log(
    JSON.stringify({
      kind: "ordinary-selection-verified",
      projects: Object.fromEntries(
        Object.keys(baseline).map((p) => [p, { baseline: baseline[p].length, ordinary: ordinary[p].length }]),
      ),
      excluded: [STOCK_FILE, EXISTING_FILE],
      requiredExisting: existing,
    }),
  );
  return { baseline, ordinary, existing };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "check") checkSelection();
  else if (mode === "run") {
    const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], {
      cwd: repo,
      env: ordinaryEnvironment(),
      stdio: "inherit",
    });
    process.exitCode = result.error || result.signal || result.status !== 0 ? 1 : 0;
  } else throw new Error("usage: ordinary-tests.mjs check|run [vitest args]");
}
