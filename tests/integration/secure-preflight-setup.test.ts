/** Real Vitest workspace wiring with synthetic facts only. Never selects repository secure fixtures. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "secure-preflight-wiring-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const hook = (name: string) => JSON.stringify(join(REPO, "tests/setup", `secure-preflight.${name}.ts`));
const external = "40 25 0:40 / /synthetic/external\\040vault rw - fuse.gocryptfs cipher rw\n";
interface Report {
  numPassedTests: number;
  numPendingTests: number;
  numPendingTestSuites: number;
  testResults: {
    status: string;
    message: string;
    assertionResults: { status: string; meta: Record<string, unknown> }[];
  }[];
}
interface Options {
  state?: "clean" | "external" | "dirty" | "incapable";
  raw?: unknown;
  missing?: boolean;
  selfSkip?: boolean;
  collectionError?: boolean;
  workerHook?: boolean;
}
function runCase(name: string, opts: Options = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  const marks = join(dir, "marks");
  mkdirSync(marks);
  const home = join(dir, "home");
  mkdirSync(home);
  const release = join(dir, "release");
  const state = opts.state ?? "clean";
  const raw = opts.raw === undefined ? "" : `ctx.provide("secureEnv", ${JSON.stringify(opts.raw)});`;
  const source =
    opts.missing || raw
      ? `export default function(ctx) { ${raw} }`
      : `
    import { appendFileSync } from "node:fs";
    import { setupSecurePreflight } from ${hook("global")};
    export default ctx => setupSecurePreflight(ctx, {
      capability: () => ({fuse: ${state !== "incapable"}, private: true && ${state !== "incapable"}}),
      probeRunLock: async () => ({outcome: {status: "acquired"}, release: () => appendFileSync(${JSON.stringify(release)}, "released\\n")}),
      readMountinfo: () => ${JSON.stringify(state === "clean" || state === "incapable" ? "" : external)},
      tmpPair: () => ({tmpdir: "/tmp", realTmpdir: ${JSON.stringify(state === "dirty" ? "/symlink-target" : "/tmp")}}),
      countUnreadable: () => 0,
    });`;
  writeFileSync(join(dir, "global.ts"), source);
  writeFileSync(
    join(dir, "vitest.config.mts"),
    `export default { cacheDir: ${JSON.stringify(join(dir, "cache"))}, test: {
    include: ["*.test.ts"], maxWorkers: 1, minWorkers: 1, fileParallelism: false,
    runner: ${hook("runner")}, globalSetup: ["./global.ts"],
    setupFiles: ${opts.workerHook === false ? "[]" : `[${hook("setup")}]`},
  } };`,
  );
  for (const file of ["a", "b"]) {
    writeFileSync(
      join(dir, `${file}.test.ts`),
      `
      import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
      import { writeFileSync } from "node:fs";
      const mark = n => writeFileSync(${JSON.stringify(join(marks, file + "-"))} + n, "");
      beforeAll(() => mark("fileAll")); afterAll(() => mark("cleanup"));
      beforeEach(() => mark("beforeEach")); afterEach(() => mark("afterEach"));
      describe${opts.selfSkip ? ".skip" : ""}("outer", () => {
        beforeAll(() => mark("nestedAll"));
        describe("inner", () => { it("body", () => { mark("body"); expect(2 + 2).toBe(4); }); });
      });
      ${opts.collectionError ? 'throw new Error("synthetic collection fault");' : ""}
    `,
    );
  }
  const reportFile = join(dir, "report.json");
  const r = spawnSync(
    process.execPath,
    [
      join(REPO, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      join(dir, "vitest.config.mts"),
      "--no-cache",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportFile}`,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        HOME: home,
        XDG_CACHE_HOME: join(dir, "cache"),
        npm_config_cache: join(dir, "npm-cache"),
        PI_TOOLKIT_TEST_WORKERS: "1",
        // These old controls MUST NOT override explicitly supplied dirty/external facts.
        PI_TOOLKIT_SECURE_PREFLIGHT: "0",
        PI_TOOLKIT_SECURE_PREFLIGHT_FAKE: '{"state":"clean"}',
      },
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  expect(r.error, String(r.error)).toBeUndefined();
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return {
    status: r.status,
    out,
    marks: readdirSync(marks),
    releases: existsSync(release) ? readFileSync(release, "utf8") : "",
    report: existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, "utf8")) as Report) : undefined,
  };
}

describe("secure-only runner / host gate actual Vitest reporting", () => {
  it.each(["clean", "incapable"] as const)(
    "%s runs bodies and fixtures, not an always-skip runner",
    (state) => {
      const r = runCase(state, { state });
      expect(r.status, r.out).toBe(0);
      expect(r.report?.numPassedTests).toBe(2);
      expect(r.report?.numPendingTests).toBe(0);
      expect(r.marks.sort()).toEqual(
        ["a", "b"]
          .flatMap((f) =>
            ["afterEach", "beforeEach", "body", "cleanup", "fileAll", "nestedAll"].map((m) => `${f}-${m}`),
          )
          .sort(),
      );
      expect(r.releases).toBe(state === "clean" ? "released\n" : "");
    },
    120_000,
  );

  it.each([false, true])(
    "external-only explicitly skips all files (selfSkip=%s), reason reaches default AND JSON reporter",
    (selfSkip) => {
      const r = runCase(`external-${selfSkip}`, { state: "external", selfSkip });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("2 skipped");
      expect(r.out).toContain("/synthetic/external vault");
      expect(r.out).toContain("coverage NOT RUN");
      expect(r.marks).toEqual([]);
      expect(r.releases).toBe("released\n");
      expect(r.report?.numPassedTests).toBe(0);
      expect(r.report?.numPendingTests).toBe(2);
      // Vitest 2 JSON's suite aggregate counts only run/todo as pending, not skip.
      // Do not falsify task states to compensate: assert actual per-test skip + metadata below.
      expect(r.out).toMatch(/Test Files\s+2 skipped/);
      const assertions = r.report!.testResults.flatMap((f) => f.assertionResults);
      expect(assertions).toHaveLength(2);
      for (const a of assertions) {
        expect(["pending", "skipped"]).toContain(a.status);
        expect(a.meta.securePreflightSkip).toContain("/synthetic/external vault");
        expect(a.meta.securePreflightSkip).toContain("coverage NOT RUN");
      }
    },
    120_000,
  );

  it.each([false, true])(
    "dirty external+other error fails even all self-skipped=%s; releases lock without fixtures/cleanup",
    (selfSkip) => {
      const r = runCase(`dirty-${selfSkip}`, { state: "dirty", selfSkip });
      expect(r.status, r.out).not.toBe(0);
      expect(r.status).not.toBeNull();
      expect(r.out).toContain("symlinked-tmpdir");
      expect(r.out).toContain("/synthetic/external vault");
      expect(r.marks).toEqual([]);
      expect(r.releases).toBe("released\n");
    },
    120_000,
  );

  it.each([
    { name: "missing", missing: true, reason: "was not provided" },
    { name: "schema", raw: { state: "garbage" }, reason: "schema" },
    {
      name: "mixed-schema",
      raw: {
        state: "external-mounts",
        fuse: true,
        private: true,
        externalMountPoints: ["/fake"],
        reasons: ["other error"],
        notes: [],
      },
      reason: "inconsistent reasons",
    },
    {
      name: "raw-dirty",
      raw: {
        state: "dirty",
        fuse: true,
        private: true,
        externalMountPoints: ["/fake"],
        reasons: ["preflight-error: synthetic I/O"],
        notes: [],
      },
      reason: "synthetic I/O",
    },
  ])(
    "$name fails via runner even every describe self-skips, no setup hook needed",
    ({ name, reason, ...opts }) => {
      const r = runCase(name, { ...opts, selfSkip: true, workerHook: false });
      expect(r.status, r.out).not.toBe(0);
      expect(r.status).not.toBeNull();
      expect(r.out).toContain(reason);
      expect(r.marks).toEqual([]);
      expect(r.report?.testResults.some((f) => f.status === "failed" && f.message.includes(reason))).toBe(true);
    },
    120_000,
  );

  it("missing inject is also caught by the real setup file", () => {
    const r = runCase("missing-setup", { missing: true, selfSkip: true });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("was not provided");
    expect(r.marks).toEqual([]);
  }, 120_000);
  it("external-only cannot erase collection failure or execute cleanup", () => {
    const r = runCase("collection", { state: "external", collectionError: true });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("synthetic collection fault");
    expect(r.marks).toEqual([]);
    expect(r.releases).toBe("released\n");
  }, 120_000);
});
