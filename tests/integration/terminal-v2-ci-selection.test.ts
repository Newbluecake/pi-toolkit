/** Actual Vitest 2 workspace behavior, not configuration substring evidence.
 * list --filesOnly does not execute suites/globalSetup (incl. secure). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  assertSelection,
  checkSelection,
  listFiles,
  ordinaryEnvironment,
  STOCK_FILE,
  EXISTING_FILE,
} from "../../scripts/ci/ordinary-tests.mjs";
import { privateEnvironment } from "../../scripts/ci/terminal-stock.mjs";
import { failureSummary, probeDiagnostics, SAFE_LIMIT, writeSafeSummary } from "../../scripts/ci/safe-diagnostics.mjs";
it("real ordinary plus required existing/stock lanes equals baseline for all 3 projects; real old CLI exclude is rejected", () => {
  const { baseline, ordinary, existing } = checkSelection();
  expect(ordinary.tier2).not.toContain(STOCK_FILE);
  expect(ordinary.tier2).not.toContain(EXISTING_FILE);
  expect(existing).toEqual([EXISTING_FILE]);
  expect(ordinary.tier1).toEqual(baseline.tier1);
  expect(ordinary.secure).toEqual(baseline.secure);
  const env = { ...process.env };
  delete env.PI_TOOLKIT_TEST_LANE;
  const old = listFiles("tier2", env, ["--exclude", STOCK_FILE]);
  expect(old).toContain(STOCK_FILE); // The precise observed e393 failure mechanism.
  expect(() => assertSelection(baseline, { ...ordinary, tier2: old }, existing)).toThrow();
  expect(() => assertSelection(baseline, { ...ordinary, tier1: ordinary.tier1.slice(1) }, existing)).toThrow();
  expect(() => assertSelection(baseline, { ...ordinary, secure: [] }, existing)).toThrow();
  expect(() => assertSelection(baseline, ordinary, [])).toThrow();
  expect(() => assertSelection(baseline, ordinary, [EXISTING_FILE, STOCK_FILE])).toThrow();
  expect(() => assertSelection(baseline, ordinary, [EXISTING_FILE, EXISTING_FILE])).toThrow();
}, 20000);
it("ordinary paths are inherited, stock env is allocated separately and cannot leak back", () => {
  const inherited = {
    HOME: "/ordinary/home",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    XDG_CACHE_HOME: "/ordinary/cache",
    npm_config_cache: "/ordinary/npm",
    PATH: process.env.PATH,
  };
  const before = { ...inherited },
    ordinary = ordinaryEnvironment(inherited);
  const root = mkdtempSync(join(tmpdir(), "se-"));
  const dedicated = privateEnvironment(root);
  expect(ordinary.HOME).toBe(inherited.HOME);
  expect(ordinary.TMPDIR).toBe("/tmp");
  expect(ordinary.XDG_CACHE_HOME).toBe(inherited.XDG_CACHE_HOME);
  expect(ordinary.npm_config_cache).toBe(inherited.npm_config_cache);
  expect(ordinary.PI_TOOLKIT_STOCK_CONSUMERS).toBeUndefined();
  expect(ordinary.PI_TOOLKIT_TEST_PRIVATE_ROOT).toBeUndefined();
  expect(dedicated.HOME).toBe(join(root, "h"));
  expect(dedicated.TMPDIR).toBe(join(root, "t"));
  expect(dedicated.PI_TOOLKIT_TEST_LANE).toBeUndefined();
  expect(inherited).toEqual(before);
  expect(() => ordinaryEnvironment(dedicated)).toThrow("cannot inherit a dedicated stock environment");
});
it("failure summary is bounded and contains only closed diagnostics, not credentials/expected/actual/env/checkpoint", () => {
  const secret = "FAKE_COOKIE_CREDENTIAL_DO_NOT_PUBLISH";
  const text = `${secret} cookie=${secret} token=${secret} HOME=/private/${secret} expected=${secret}\nAssertionError ERR_ASSERTION E_RETAINED_LOAD_PROBE_DEADLINE\nterminal-retained-stock-setup.ts:194:5\nT51_LOAD_PROBE stage=loader-reload elapsedMs=22001 childMs=410 reason=deadline\n`;
  const summary = failureSummary("npm-restart", "vitest", text.repeat(1000), { status: 1, signal: null });
  expect(summary.codes).toContain("E_RETAINED_LOAD_PROBE_DEADLINE");
  expect(summary.categories.assertion).toBe(true);
  expect(summary.locations).toEqual(["terminal-retained-stock-setup.ts:194:5"]);
  expect(summary.probe[0]).toEqual({ stage: "loader-reload", elapsedMs: 22001, childMs: 410, reason: "deadline" });
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(probeDiagnostics(`T51_LOAD_PROBE stage=${secret} elapsedMs=22000 childMs=1 reason=deadline`)).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "sd-"));
  const bytes = writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "npm-restart", summary);
  expect(Buffer.byteLength(bytes)).toBeLessThan(SAFE_LIMIT);
  expect(readdirSync(join(root, "safe"))).toEqual(["npm-restart.safe.json"]);
  expect(readFileSync(join(root, "safe/npm-restart.safe.json"), "utf8")).not.toContain(secret);
  expect(statSync(join(root, "safe/npm-restart.safe.json")).size).toBeLessThan(SAFE_LIMIT);
  expect(() => writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "../checkpoint", summary)).toThrow();
  expect(() =>
    writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "npm-restart", { ...summary, raw: secret }),
  ).toThrow("schema");
  expect(() =>
    writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "npm-restart", { ...summary, codes: [secret] }),
  ).toThrow("schema");
  expect(() =>
    writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "npm-restart", { text: "x".repeat(SAFE_LIMIT) }),
  ).toThrow("size cap");
});

it("actual failed Vitest JSON/stdout yields visible fixed cause without publishing private test name/error material", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-"));
  const secret = "FAKE_TOKEN_COOKIE_NEVER_UPLOAD";
  writeFileSync(
    join(root, "vitest.config.mjs"),
    `export default {test:{include:['failure.test.js'],maxWorkers:1,minWorkers:1,cache:false}}`,
  );
  writeFileSync(
    join(root, "failure.test.js"),
    `import {it} from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))};
    it(${JSON.stringify(secret)},()=>{throw Error('E_RETAINED_LOAD_PROBE_DEADLINE T51_LOAD_PROBE stage=loader-reload elapsedMs=22000 childMs=900 reason=deadline '+${JSON.stringify(secret)})});`,
  );
  const report = join(root, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "--root",
      root,
      "--config",
      join(root, "vitest.config.mjs"),
      "--maxWorkers=1",
      "--no-cache",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 15000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const raw = readFileSync(report, "utf8");
  expect(JSON.parse(raw).numFailedTests).toBe(1);
  expect(raw).toContain(secret); // Real report is PRIVATE, never an upload target.
  const summary = failureSummary("zip-restart", "vitest", `${result.stdout}\n${result.stderr}\n${raw}`, result);
  expect(summary.codes).toContain("E_RETAINED_LOAD_PROBE_DEADLINE");
  expect(summary.probe[0]).toMatchObject({ stage: "loader-reload", reason: "deadline" });
  const safe = writeSafeSummary({ PI_TOOLKIT_TEST_PRIVATE_ROOT: root }, "zip-restart", summary);
  expect(safe).not.toContain(secret);
  expect(safe).not.toContain(root);
}, 20000);

it("complete local controller keeps build/ordinary env separate and propagates red while attempting all four required cells", async () => {
  const { runCompleteSuite } = await import("../../scripts/ci/test-with-stock.mjs");
  // Orchestration-only ports; real file selection and failure serialization are
  // independently exercised above. No fake stock result is counted as acceptance.
  for (const ordinaryStatus of [0, 1]) {
    const root = mkdtempSync(join(tmpdir(), "wrap-"));
    const source = {
      HOME: "/ordinary/home",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: "/ordinary/cache",
      PI_TOOLKIT_TEST_PRIVATE_ROOT: root,
    };
    const seen: string[] = [];
    const assertOrdinary = (env: any) => {
      expect(env.HOME).toBe(source.HOME);
      expect(env.TMPDIR).toBe("/tmp");
      expect(env.XDG_CACHE_HOME).toBe(source.XDG_CACHE_HOME);
      expect(env.PI_TOOLKIT_TEST_PRIVATE_ROOT).toBeUndefined();
      expect(env.PI_TOOLKIT_STOCK_CONSUMERS).toBeUndefined();
      expect(env.PI_TOOLKIT_TEST_LANE).toBe("ordinary");
    };
    const status = runCompleteSuite(["--tier2", "--no-cache", "--maxWorkers=2"], source, {
      checkSelection(env: any) {
        assertOrdinary(env);
        seen.push("selection");
      },
      command(_cmd: string, args: string[], env: any) {
        assertOrdinary(env);
        seen.push(args[1]!);
      },
      spawnSync(_cmd: string, args: string[], options: any) {
        assertOrdinary(options.env);
        expect(args).not.toContain("--exclude");
        expect(args).toContain("secure");
        seen.push("ordinary");
        return { status: ordinaryStatus };
      },
      provision(env: any) {
        expect(env.HOME).toBe(join(root, "h"));
        expect(env.TMPDIR).toBe(join(root, "t"));
        expect(env.PI_TOOLKIT_TEST_LANE).toBeUndefined();
        seen.push("provision");
      },
      existing(env: any) {
        expect(env.HOME).toBe(source.HOME);
        expect(env.TMPDIR).toBe("/tmp");
        seen.push("existing");
        return 0;
      },
      cell(env: any, format: string, phase: string) {
        expect(env.TMPDIR).toBe(join(root, "t"));
        seen.push(`${format}-${phase}`);
        if (format === "npm" && phase === "restart") throw new Error("synthetic required-cell failure");
      },
    });
    expect(status).toBe(1); // Neither ordinary green nor a later cell can mask red.
    expect(seen).toEqual([
      "selection",
      "build",
      "build:web",
      "check:web",
      "ordinary",
      "existing",
      "provision",
      "npm-restart",
      "npm-rollback",
      "zip-restart",
      "zip-rollback",
    ]);
    expect(source.HOME).toBe("/ordinary/home");
    expect(source.TMPDIR).toBe("/tmp");
  }
});

it("required existing lane rejects skipped/missing cells and its failure cannot be canceled by green ordinary/stock", async () => {
  const { verifyExistingReport, runExisting } = await import("../../scripts/ci/retained-existing.mjs");
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const secret = "FAKE_LANE_TOKEN_NEVER_PRINT";
    const failed = runExisting(process.env, {
      spawnSync(_file: unknown, args: string[], options: any) {
        expect(args).toContain("--maxWorkers=1");
        expect(options.env.PI_TOOLKIT_TEST_LANE).toBe("retained-existing");
        return { status: 1, stdout: `${secret} E_RETAINED_LOAD_PROBE_DEADLINE`, stderr: secret };
      },
    });
    expect(failed).toBe(1);
    const summary = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(summary.result).toBe("failed");
    expect(summary.codes).toEqual(["E_RETAINED_LOAD_PROBE_DEADLINE"]);
    expect(JSON.stringify(summary)).not.toContain(secret);
  } finally {
    output.mockRestore();
  }
  const report = {
    success: true,
    numPassedTests: 3,
    numFailedTests: 0,
    testResults: [
      {
        name: `${process.cwd()}/${EXISTING_FILE}`,
        assertionResults: [0, 1, 2].map((n) => ({
          status: "passed",
          fullName: `ordinary O (${n} resources; two uses distinct SDK sessions) retains debt through N/restart/new CLI/off rollback`,
        })),
      },
    ],
  };
  expect(verifyExistingReport(report)).toBeUndefined();
  for (const mutate of [
    (r: any) => {
      r.numPassedTests = 0;
    },
    (r: any) => {
      r.testResults[0].assertionResults[1].status = "skipped";
    },
    (r: any) => {
      r.testResults[0].assertionResults.pop();
    },
    (r: any) => {
      r.success = false;
    },
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    expect(() => verifyExistingReport(bad)).toThrow();
  }
  const { runCompleteSuite } = await import("../../scripts/ci/test-with-stock.mjs");
  const root = mkdtempSync(join(tmpdir(), "serial-fail-"));
  const order: string[] = [];
  const status = runCompleteSuite(
    ["--tier2"],
    { HOME: "/ordinary", TMPDIR: "/tmp", PI_TOOLKIT_TEST_PRIVATE_ROOT: root },
    {
      checkSelection() {},
      command() {},
      spawnSync() {
        order.push("ordinary");
        return { status: 0 };
      },
      existing() {
        order.push("existing");
        return 1;
      },
      provision() {
        order.push("provision");
      },
      cell(_env: unknown, format: string, phase: string) {
        order.push(`${format}-${phase}`);
      },
    },
  );
  expect(status).toBe(1);
  expect(order).toEqual([
    "ordinary",
    "existing",
    "provision",
    "npm-restart",
    "npm-rollback",
    "zip-restart",
    "zip-rollback",
  ]);
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const lane = workflow.slice(
    workflow.indexOf("- name: Retained existing"),
    workflow.indexOf("- name: Allocate dedicated stock root"),
  );
  expect(lane).toContain("steps.tier1.outcome == 'failure'");
  expect(lane).toContain("run: node scripts/ci/retained-existing.mjs");
  expect(lane).not.toContain("continue-on-error");
});
