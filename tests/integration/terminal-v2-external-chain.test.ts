/** Synthetic CLI/helper/real Vitest JSON chain. No site SDK, PTY, shell or rc. */
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRetainedFixtureCli } from "./helpers/terminal-retained-cli.js";
import {
  EXTERNAL_MARKER,
  EXTERNAL_SELECTION,
  canonicalExternal,
  extractExternal,
  unarmedExternal,
  validExternal,
} from "../../scripts/ci/external-probe-schema.mjs";
import { runExternalExisting } from "../../scripts/ci/external-existing.mjs";
import { runExisting } from "../../scripts/ci/retained-existing.mjs";
const repo = resolve("."),
  secret = "FAKE_SECRET_T51_CHAIN";
afterEach(() => vi.restoreAllMocks());
function fixture(failed = false) {
  const root = mkdtempSync(join(tmpdir(), "chain-")),
    dist = join(root, "dist"),
    cli = join(root, "cli.mjs");
  mkdirSync(dist, { mode: 0o700 });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0", type: "module" }),
  );
  writeFileSync(join(dist, "cli.js"), "");
  writeFileSync(
    join(dist, "index.js"),
    `
  if(process.env.PI_TOOLKIT_T51_EXTERNAL_ONCE||process.env.PI_TOOLKIT_T51_EXTERNAL_DIAG)throw Error('control leaked');
  process.stderr.write(${JSON.stringify(secret)});
  export const SettingsManager={create(){return {}}};
  export class DefaultResourceLoader {
    async reload(){${failed ? "throw Error('private');" : "this.done=true;"}}
    getExtensions(){return {errors:[],extensions:this.done?[{path:process.argv[2]}]:[]};}
  }`,
  );
  buildSync({
    stdin: {
      contents: `
    import {verifySelectedPackageLoad} from ${JSON.stringify(join(repo, "scripts/web-hub/terminal-v2-retained/load-probe.ts"))};
    const lease={revalidate(){},profile:{piCli:${JSON.stringify(join(dist, "cli.js"))},home:${JSON.stringify(root)},agentDir:${JSON.stringify(root)},newPackageRoot:${JSON.stringify(root)},oldPackageRoot:${JSON.stringify(root)}}};
    process.stderr.write(${JSON.stringify(secret)}+'\\n');
    try {
      const value=await verifySelectedPackageLoad(lease,process.argv[2]==='old-off'?'old-off':'new',Date.now()+3000);
      if(process.argv[2]==='twice')await verifySelectedPackageLoad(lease,'new',Date.now()+3000);
      console.log(JSON.stringify({ok:true}));
    }catch {console.log(JSON.stringify({error:'E_RETAINED_LOAD_PROBE_FAILED'}));process.exitCode=1;}
  `,
      resolveDir: root,
    },
    outfile: cli,
    platform: "node",
    target: "node22",
    format: "esm",
    bundle: true,
    logLevel: "silent",
  });
  return { root, cli, env: { ...process.env, HOME: root, PI_TOOLKIT_T51_EXTERNAL_DIAG: EXTERNAL_SELECTION } };
}
function armed(product = "observed-pass") {
  return { ...unarmedExternal(), selection: "existing-zero-first", product };
}
it("closed schema rejects extra/missing keys, bounds, arbitrary values and duplicate/conflicting markers", () => {
  const good = armed(),
    line = EXTERNAL_MARKER + canonicalExternal(good);
  expect(validExternal(good)).toBe(true);
  expect(extractExternal([line, line])).toEqual(good);
  for (const bad of [
    { ...good, private: secret },
    { ...good, asOfMs: 30001 },
    { ...good, reason: secret },
    { ...good, exit: { ...good.exit, ms: 1 } },
    { ...good, exit: { state: "seen", ms: 1, code: "zero", signal: "none" } },
  ]) {
    expect(validExternal(bad)).toBe(false);
    expect(() => canonicalExternal(bad)).toThrow();
  }
  expect(() => extractExternal([line + "\n" + line])).toThrow("duplicate");
  expect(() => extractExternal([line, EXTERNAL_MARKER + canonicalExternal(armed("observed-fail"))])).toThrow(
    "conflicting",
  );
  expect(() => extractExternal([line + secret])).toThrow();
  expect(() => extractExternal([secret])).toThrow("missing");
});
it("actual synthetic CLI/helper off has no marker; on consumes once across two verifies and strips all controls from SDK", () => {
  const f = fixture(),
    log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(runRetainedFixtureCli(f.cli, ["twice"], { cwd: f.root, env: f.env })).toEqual({ ok: true });
  expect(log).not.toHaveBeenCalled();
  expect(runRetainedFixtureCli(f.cli, ["twice"], { cwd: f.root, env: f.env, observeExternal: true })).toEqual({
    ok: true,
  });
  expect(log).toHaveBeenCalledTimes(1);
  expect(extractExternal([log.mock.calls.flat().join("\n")])).toMatchObject({
    selection: "existing-zero-first",
    product: "observed-pass",
  });
  expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
});
it("CLI failure forwards one safe marker, not raw private material; old-off/missing evidence is unarmed", () => {
  const f = fixture(true);
  let message = "";
  try {
    runRetainedFixtureCli(f.cli, ["publish-new"], { cwd: f.root, env: f.env, observeExternal: true });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("E_RETAINED_LOAD_PROBE_FAILED");
  expect(message).not.toContain(secret);
  expect(extractExternal([message])).toMatchObject({ product: "observed-fail", reason: "child-failed" });
  const s = fixture(),
    log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  runRetainedFixtureCli(s.cli, ["old-off"], { cwd: s.root, env: s.env, observeExternal: true });
  expect(extractExternal([log.mock.calls.flat().join("\n")])).toEqual(unarmedExternal());
});
it("missing permit/unknown argument never lists or runs the underlying lane and returns only closed not-run", () => {
  const spawn = vi.fn(),
    list = vi.fn(),
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(runExternalExisting({}, { spawnSync: spawn, listFiles: list })).toBe(1);
  expect(
    runExternalExisting({ PI_TOOLKIT_T51_EXTERNAL_DIAG: EXTERNAL_SELECTION }, { spawnSync: spawn, listFiles: list }, [
      "--unknown",
    ]),
  ).toBe(1);
  expect(spawn).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([[canonicalExternal(unarmedExternal())], [canonicalExternal(unarmedExternal())]]);
});
it.each([false, true])(
  "real synthetic Vitest default+JSON chain failure=%s: closed single safe log, pass remains inconclusive",
  (failed) => {
    const f = fixture(failed),
      directory = join(f.root, "tests/integration");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const testFile = join(directory, "terminal-v2-retained-existing.test.ts"),
      config = join(f.root, "vitest.config.mjs");
    const name =
      "ordinary O (0 resources; two uses distinct SDK sessions) retains debt through N/restart/new CLI/off rollback";
    writeFileSync(
      config,
      `export default {root:${JSON.stringify(f.root)},test:{include:[${JSON.stringify(testFile)}],maxWorkers:1,minWorkers:1,testTimeout:15000}};`,
    );
    writeFileSync(
      testFile,
      `
    import {it,expect} from ${JSON.stringify(join(repo, "node_modules/vitest/dist/index.js"))};
    import {runRetainedFixtureCli} from ${JSON.stringify(join(repo, "tests/integration/helpers/terminal-retained-cli.ts"))};
    it(${JSON.stringify(name)},()=>{const result=runRetainedFixtureCli(${JSON.stringify(f.cli)},['publish-new'],{cwd:${JSON.stringify(f.root)},env:${JSON.stringify(f.env)},observeExternal:true});expect(result).toEqual({ok:true});});
  `,
    );
    let captured: any;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const status = runExternalExisting(f.env, {
      listFiles: () => ["tests/integration/terminal-v2-retained-existing.test.ts"],
      spawnSync: (_node: string, args: string[], options: any) => {
        expect(args).toContain("--reporter=default");
        expect(args).toContain("--reporter=json");
        expect(options.env.PI_TOOLKIT_T51_EXTERNAL_DIAG).toBe(EXTERNAL_SELECTION);
        expect(options.env.PI_TOOLKIT_T51_EXTERNAL_ONCE).toBeUndefined();
        captured = spawnSync(
          process.execPath,
          [
            join(repo, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            config,
            "--maxWorkers=1",
            "--no-cache",
            "--reporter=default",
            "--reporter=json",
            args.find((x) => x.startsWith("--outputFile.json="))!,
          ],
          { ...options, cwd: repo, timeout: 25000 },
        );
        return captured;
      },
    });
    expect(captured.status).toBe(failed ? 1 : 0);
    expect(status).toBe(0); // Evidence gate, NOT a product pass or root cause gate.
    expect(log).toHaveBeenCalledTimes(1);
    const safe = log.mock.calls.flat().join("\n");
    expect(safe).not.toContain(secret);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(safe)).toMatchObject({
      selection: "existing-zero-first",
      product: failed ? "observed-fail" : "observed-pass",
    });
    expect(Object.keys(JSON.parse(safe)).sort()).toEqual(
      ["selection", "product", "asOfMs", "exit", "close", "lastStage", "reason", "truncated"].sort(),
    );
  },
  30000,
);
it("actual list-only external registration is exactly existing0, normal registration remains all three", () => {
  const env = { ...process.env };
  delete env.PI_TOOLKIT_T51_EXTERNAL_DIAG;
  delete env.PI_TOOLKIT_T51_EXTERNAL_ONCE;
  for (const on of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "list",
        "tests/integration/terminal-v2-retained-existing.test.ts",
        "--project",
        "tier2",
        "--json",
        "--maxWorkers=1",
        "--no-cache",
      ],
      {
        cwd: repo,
        env: { ...env, ...(on ? { PI_TOOLKIT_T51_EXTERNAL_DIAG: EXTERNAL_SELECTION } : {}) },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const list = JSON.parse(result.stdout);
    expect(list).toHaveLength(on ? 1 : 3);
    expect(list.map((x: any) => x.name.match(/O \((\d) resources/)[1])).toEqual(on ? ["0"] : ["0", "1", "2"]);
  }
}, 45000);
it("malformed/missing synthetic report fails evidence closed without printing raw secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "missing-")),
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const run = vi.fn(() => ({
    status: 1,
    signal: null,
    stdout: secret,
    stderr: EXTERNAL_MARKER + '{"secret":"' + secret + '"}',
  }));
  expect(
    runExternalExisting(
      { ...process.env, HOME: root, PI_TOOLKIT_T51_EXTERNAL_DIAG: EXTERNAL_SELECTION },
      { listFiles: () => ["tests/integration/terminal-v2-retained-existing.test.ts"], spawnSync: run },
    ),
  ).toBe(1);
  expect(run).toHaveBeenCalledOnce();
  expect(log.mock.calls).toEqual([[canonicalExternal(unarmedExternal())]]);
});
it("required3 controller strips both diagnostic controls and retains its original reporter/required count", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const run = vi.fn((_node: string, args: string[], options: any) => {
    expect(options.env.PI_TOOLKIT_T51_EXTERNAL_DIAG).toBeUndefined();
    expect(options.env.PI_TOOLKIT_T51_EXTERNAL_ONCE).toBeUndefined();
    expect(args).toContain("--reporter=json");
    expect(args).not.toContain("--reporter=default");
    return { status: 1, signal: null, stdout: secret, stderr: secret };
  });
  expect(
    runExisting(
      {
        ...process.env,
        PI_TOOLKIT_T51_EXTERNAL_DIAG: EXTERNAL_SELECTION,
        PI_TOOLKIT_T51_EXTERNAL_ONCE: EXTERNAL_SELECTION,
      },
      { spawnSync: run },
    ),
  ).toBe(1);
  expect(run).toHaveBeenCalledOnce();
  const summary = JSON.parse(log.mock.calls.flat().join("\n"));
  expect(summary.required).toBe(3);
  expect(summary.result).toBe("failed");
  expect(JSON.stringify(summary)).not.toContain(secret);
}, 20000);
