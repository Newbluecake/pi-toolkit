/** Required L2 stock acceptance gate; no installs, checkout fallback or observer.
 * Build once beforehand; provision normal npm/release ZIP from those SAME bytes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STOCK_FILE } from "./ordinary-tests.mjs";
export { STOCK_FILE };
import { failureSummary, privateReportText, writeSafeSummary } from "./safe-diagnostics.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
export function privateEnvironment(root) {
  assert(root && isAbsolute(root), "explicit private root required");
  const stat = lstatSync(root);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    "private root must be owned 0700",
  );
  assert.equal(realpathSync(root), root, "private root must be physical");
  for (const name of ["h", "c", "t"]) {
    const path = join(root, name);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const st = lstatSync(path);
    assert(
      st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o077) === 0,
      "private env path is unsafe",
    );
  }
  const env = {
    ...process.env,
    PI_TOOLKIT_TEST_PRIVATE_ROOT: root,
    PI_TOOLKIT_STOCK_CONSUMERS: join(root, "consumers"),
    HOME: join(root, "h"),
    XDG_CACHE_HOME: join(root, "c"),
    npm_config_cache: join(root, "c/npm"),
    TMPDIR: join(root, "t"),
    TMP: join(root, "t"),
    TEMP: join(root, "t"),
    JITI_FS_CACHE: "false",
    NODE_OPTIONS: "",
    PI_TOOLKIT_TEST_WORKERS: "1",
  };
  for (const key of [
    "PI_TOOLKIT_TEST_LANE",
    "NODE_PATH",
    "XDG_RUNTIME_DIR",
    "PI_CODING_AGENT_DIR",
    "NODE_V8_COVERAGE",
    "PI_TOOLKIT_STOCK_OBSERVE",
    "PI_TOOLKIT_STOCK_PHASE",
    "PI_TOOLKIT_STOCK_BINDING",
  ])
    delete env[key];
  return env;
}
export function command(executable, args, env, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 290000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 || result.error || result.signal) {
    // Test logs live in the private directory; never print checkpoint/auth bytes.
    throw new Error(
      `gate command ${executable} ${args.slice(0, 2).join(" ")} failed: status=${result.status} signal=${result.signal} outer=${result.error?.code ?? "none"}`,
    );
  }
  return result.stdout;
}
function files(root, prefix = "") {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = join(prefix, name),
        stat = lstatSync(join(root, path));
      assert(!stat.isSymbolicLink(), `symlink forbidden: ${path}`);
      assert(name !== "node_modules", "consumer node_modules forbidden");
      if (stat.isDirectory()) return files(root, path);
      assert(stat.isFile(), `non-file: ${path}`);
      return [path];
    });
}
function snapshot(root) {
  return Object.fromEntries(files(root).map((path) => [path, sha(readFileSync(join(root, path)))]));
}
function validateBuild(env) {
  const manifest = json(join(repo, "dist/maintenance/manifest.json"));
  const head = command("git", ["rev-parse", "HEAD"], env).trim();
  assert.equal(manifest.sourceHead, head, "build:maintenance must belong to current HEAD");
  assert.equal(manifest.builderSha256, sha(readFileSync(join(repo, "scripts/build-maintenance.mjs"))));
  for (const [path, hash] of Object.entries(manifest.inputSha256)) {
    if (path === "<define:__T51_NEW_SOURCE_FILES__>") continue;
    assert.equal(sha(readFileSync(join(repo, path))), hash, `stale maintenance input: ${path}`);
  }
  const sourcePaths = [
    "package.json",
    "index.ts",
    "index.js",
    "bundle-bridge.cjs",
    ...files(join(repo, "src")).map((p) => `src/${p}`),
  ];
  const sources = Object.fromEntries(sourcePaths.sort().map((p) => [p, sha(readFileSync(join(repo, p)))]));
  assert.equal(
    sha(Buffer.from(JSON.stringify(sources) + "\n")),
    manifest.sourceProfileSha256,
    "stale selected source profile",
  );
  for (const [path, hash] of Object.entries(manifest.files))
    assert.equal(sha(readFileSync(join(repo, "dist/maintenance", path))), hash);
  for (const path of ["dist/index.js", "dist/bundle/index.js", "dist/web-hub-ui/build-info.json"])
    assert(existsSync(join(repo, path)), `missing ${path}; build first`);
  return head;
}
function provisionConsumers(env) {
  const head = validateBuild(env),
    root = env.PI_TOOLKIT_STOCK_CONSUMERS;
  assert(!existsSync(root), "fresh consumers directory required (never reuse old checkpoints)");
  mkdirSync(root, { mode: 0o700 });
  const archives = join(root, "archives");
  mkdirSync(archives, { mode: 0o700 });
  // Equivalent normal publish payload, lifecycle intentionally disabled ONLY because
  // build/build:web/check:web have already run. No consumer dependency install.
  const packed = JSON.parse(
    command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", archives], env),
  );
  assert.equal(packed.length, 1);
  const tgz = join(archives, packed[0].filename);
  const version = json(join(repo, "package.json")).version;
  command("bash", ["scripts/release/package.sh", version, archives, "--built"], env);
  const zip = join(archives, `pi-toolkit-${version}.zip`);
  const npmRoot = join(root, "npm"),
    zipStage = join(root, "unzip");
  mkdirSync(npmRoot, { mode: 0o700 });
  mkdirSync(zipStage, { mode: 0o700 });
  command("tar", ["-xzf", tgz, "--strip-components=1", "-C", npmRoot], env);
  command("unzip", ["-q", zip, "-d", zipStage], env);
  // Rename, never patch the consumer contents.
  renameSync(join(zipStage, "pi-toolkit"), join(root, "zip"));
  const consumers = {};
  for (const format of ["npm", "zip"]) {
    const payload = snapshot(join(root, format));
    for (const [path, hash] of Object.entries(payload))
      assert.equal(sha(readFileSync(join(repo, path))), hash, `consumer differs from checkout: ${format}/${path}`);
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(snapshot(npmRoot)).sort(), "npm/ZIP payload sets differ");
    consumers[format] = payload;
  }
  const binding = {
    v: 1,
    sourceHead: head,
    archives: { npm: sha(readFileSync(tgz)), zip: sha(readFileSync(zip)) },
    consumers,
  };
  put(join(root, "binding.json"), binding);
  console.log(`stock provisioned current HEAD ${head}; no node_modules/observer/checkout fallback`);
  return binding;
}
export function verifyStockReport(report, format, phase) {
  assert.equal(report.success, true, "Vitest must succeed");
  assert.equal(report.numPassedTests, 1, "exactly one cell must run");
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.testResults.length, 1, "exactly stock file selected");
  const suite = report.testResults[0];
  assert(suite.name.endsWith(`/${STOCK_FILE}`));
  const passed = suite.assertionResults.filter((test) => test.status === "passed");
  assert.equal(passed.length, 1);
  assert.equal(passed[0].fullName.trim(), `stock ${format} L2: sealed consumer ${phase} phase preserves retained debt`);
  assert.equal(suite.assertionResults.length, 2, "both parameter declarations remain present");
  assert.equal(
    suite.assertionResults.filter((test) => test.status === "skipped").length,
    1,
    "only other format is unselected",
  );
}
function verifyBinding(env) {
  const root = env.PI_TOOLKIT_STOCK_CONSUMERS,
    binding = json(join(root, "binding.json"));
  assert.equal(binding.sourceHead, validateBuild(env));
  for (const format of ["npm", "zip"]) {
    assert.deepEqual(snapshot(join(root, format)), binding.consumers[format], "consumer changed after provisioning");
    for (const [path, hash] of Object.entries(binding.consumers[format]))
      assert.equal(sha(readFileSync(join(repo, path))), hash, `checkout changed since provision: ${path}`);
  }
  const version = json(join(repo, "package.json")).version;
  assert.equal(sha(readFileSync(join(root, "archives", `pi-toolkit-${version}.tgz`))), binding.archives.npm);
  assert.equal(sha(readFileSync(join(root, "archives", `pi-toolkit-${version}.zip`))), binding.archives.zip);
  return sha(readFileSync(join(root, "binding.json")));
}
export function provision(env) {
  try {
    const binding = provisionConsumers(env);
    writeSafeSummary(env, "provision", { v: 1, cell: "provision", result: "passed" });
    return binding;
  } catch (error) {
    const summary = failureSummary("provision", "provision", String(error));
    console.error(writeSafeSummary(env, "provision", summary));
    throw new Error("stock provision failed (bounded safe diagnostics emitted)");
  }
}
export function cell(env, format, phase) {
  assert(["npm", "zip"].includes(format) && ["restart", "rollback"].includes(phase), "unknown stock cell");
  const name = `${format}-${phase}`;
  let step = "binding",
    raw = "",
    exit = {};
  const root = env.PI_TOOLKIT_STOCK_CONSUMERS;
  const reportPath = join(root, `${name}.json`);
  try {
    const binding = verifyBinding(env);
    step = "checkpoint";
    const checkpoint = join(root, `${format}-stock-checkpoint.json`);
    let before;
    if (phase === "restart") assert(!existsSync(checkpoint), "restart requires a fresh checkpoint");
    else {
      before = sha(readFileSync(checkpoint));
      assert.equal(json(checkpoint).consumer, join(root, format));
      assert.equal(json(checkpoint).consumerBinding, binding);
    }
    const log = join(root, `${format}-${phase}.log`);
    step = "vitest";
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--project",
        "tier2",
        "--maxWorkers=1",
        "--no-cache",
        STOCK_FILE,
        "-t",
        `stock ${format} L2: sealed consumer ${phase} phase preserves retained debt`,
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: repo,
        env: { ...env, PI_TOOLKIT_STOCK_PHASE: phase, PI_TOOLKIT_STOCK_BINDING: binding },
        encoding: "utf8",
        timeout: 290000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    exit = result;
    writeFileSync(log, raw, { mode: 0o600 });
    put(join(root, `${format}-${phase}-exit.json`), {
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      error: result.error?.code ?? null,
    });
    assert(!result.error && result.status === 0 && !result.signal, `${format}/${phase} failed; private log: ${log}`);
    step = "report";
    verifyStockReport(json(reportPath), format, phase);
    step = "evidence";
    const saved = json(checkpoint);
    assert.equal(saved.phase, "stock-N2-complete");
    assert.equal(saved.consumer, join(root, format));
    assert.equal(saved.consumerBinding, binding);
    assert(Number.isSafeInteger(saved.runnerPid));
    if (phase === "rollback") {
      assert.equal(sha(readFileSync(checkpoint)), before, "rollback must reopen SAME checkpoint");
      const evidence = json(join(saved.base, "stock-restart-result.json"));
      assert.equal(evidence.consumer, saved.consumer);
      assert.equal(evidence.independentVitestPhases, true);
      assert.deepEqual(
        evidence.lifecycle.map((p) => p.label),
        ["N1", "N2", "N-return"],
      );
      assert.deepEqual(evidence.beforeLegacy, evidence.afterLegacy);
    }
    verifyBinding(env);
    writeSafeSummary(env, name, { v: 1, cell: name, result: "passed", passed: 1 });
    console.log(`PASS stock ${format}/${phase}: exactly 1 executed cell, same bound consumer`);
  } catch (error) {
    const summary = failureSummary(name, step, `${raw}\n${privateReportText(reportPath)}\n${String(error)}`, exit);
    console.error(writeSafeSummary(env, name, summary));
    throw new Error(`stock ${name} failed (bounded safe diagnostics emitted)`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, format, phase] = process.argv.slice(2);
  if (mode === "init") {
    const env = privateEnvironment(mkdtempSync("/tmp/t51-"));
    // Export only the opaque private root. HOME/cache/tmp are scoped INSIDE
    // provision/cell; never contaminate subsequent ordinary/build processes.
    console.log(`PI_TOOLKIT_TEST_PRIVATE_ROOT=${env.PI_TOOLKIT_TEST_PRIVATE_ROOT}`);
    console.log(`PI_TOOLKIT_CI_DIAGNOSTICS=${join(env.PI_TOOLKIT_TEST_PRIVATE_ROOT, "safe")}`);
  } else {
    const env = privateEnvironment(process.env.PI_TOOLKIT_TEST_PRIVATE_ROOT);
    try {
      if (mode === "provision") provision(env);
      else if (mode === "cell") cell(env, format, phase);
      else throw new Error("unknown stock command");
    } catch {
      process.exitCode = 1;
    }
  }
}
