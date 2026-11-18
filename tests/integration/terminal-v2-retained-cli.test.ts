/** Actual bundled CLI, flock and original singleton over explicit OLD DISK FIXTURES.
 * Fixed O source archive is unmodified. This file is NOT ordinary-O live history. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { oldLauncherBytes } from "../../scripts/web-hub/terminal-v2-retained/entries.js";
import type { InstallationProfile } from "../../scripts/web-hub/terminal-v2-retained/installation.js";
import { legacyLayout, put, setup, tree } from "../terminal-v2-maintenance/helpers.js";
const repo = resolve("."),
  cli = join(repo, "dist/maintenance/cli.mjs");
function fixture() {
  const h = setup(),
    home = join(h.base, "h"),
    agentDir = join(home, ".pi/agent"),
    state = join(agentDir, "web-hub"),
    old = join(h.base, "old"),
    bin = join(h.base, "bin");
  for (const dir of [home, join(home, ".pi"), agentDir, state, old, bin]) mkdirSync(dir, { mode: 0o700 });
  const source = execFileSync(
    "/usr/bin/git",
    [
      "archive",
      "7239dd115ac66039e2c4f80308ea5d08520aa6af",
      "src",
      "package.json",
      "index.ts",
      "index.js",
      "bundle-bridge.cjs",
    ],
    { cwd: repo, timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("/usr/bin/tar", ["-xf", "-", "-C", old], { input: source, timeout: 30000 });
  legacyLayout(state);
  const paths = resolveHubPaths({ home, uid: process.getuid!() });
  if (paths.socketDir !== state) throw new Error("fixture path too long for owned original socket");
  const profile: InstallationProfile = {
    v: 1,
    kind: "terminal-retained-O7239",
    home,
    agentDir,
    stateDir: state,
    socketPath: paths.socketPath,
    piCli: realpathSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")),
    oldPackageRoot: old,
    newPackageRoot: repo,
    launchers: [join(bin, "pi")],
    autostartFiles: [],
  };
  put(join(h.evidenceDir, "profile.json"), profile);
  put(join(agentDir, "settings.json"), { packages: [old] });
  put(join(agentDir, "pi-toolkit.json"), { webHub: { enabled: true, autoStart: false, terminal: { enabled: true } } });
  writeFileSync(profile.launchers[0]!, oldLauncherBytes(profile), { mode: 0o700 });
  chmodSync(profile.launchers[0]!, 0o700);
  const evidence = join(h.base, "migration");
  mkdirSync(evidence, { mode: 0o700 });
  const run = (command: string, rest: string[] = []) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, command, "--installation", h.evidenceDir, "--state", state, ...rest], {
        cwd: h.base,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "" },
        timeout: 30000,
        encoding: "utf8",
      }),
    );
  const publish = (command: "publish-new" | "publish-old-off", operationId: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [cli, command, "--installation", h.evidenceDir, "--expect-operation", operationId],
        {
          cwd: h.base,
          env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "" },
          timeout: 30000,
          encoding: "utf8",
        },
      ),
    );
  return { ...h, home, state, profile, evidence, run, publish };
}
it("independent Node CLI preflights/initializes/resumes the EXISTING selected S, never assumes fresh or claims publication", () => {
  const h = fixture(),
    original = tree(join(h.state, "terminal-v1"));
  expect(h.run("retained-preflight")).toMatchObject({
    phase: "preflight-complete",
    initialization: "not-performed",
    publication: "not-performed",
  });
  const result = h.run("retained-initialize", ["--evidence", h.evidence]);
  expect(result).toMatchObject({
    phase: "initialization-complete",
    legacyObligations: 0,
    normalAllocations: 0,
    publication: "not-asserted",
  });
  const before = readFileSync(join(h.state, "terminal-v2/ledger.json"));
  expect(h.run("resume", ["--operation", result.operationId])).toMatchObject({
    outcome: "already-complete",
    operationId: result.operationId,
  });
  expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(before);
  expect(tree(join(h.state, "terminal-v1"))).toEqual(original);
  expect(readFileSync(h.profile.launchers[0]!, "utf8")).toContain(" launch --installation ");
});
